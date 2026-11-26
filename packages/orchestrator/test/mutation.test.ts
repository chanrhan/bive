// 변이 주입 역할 · 변이 상태 · 고위험 우선 (M3-07 #52 수용 기준 1 · 2, JDG-04 · RUN-04 · NRM-09 · COST-01, ADR-033 · ADR-139).
// - 변이 주입 세션(ScriptedAdapter + 실제 고정 도구 · 경로 가드)이 `propose_mutant`로 대상 블록 파일 안 한 군데 변이를 내고, 단계
//   실행기가 판정 커밋의 격리 체크아웃에 적용해 대상 규칙 인수 테스트를 판정한다(판정 · 설치만 주입). 실패 = 변이 검증됨, 통과 = 변이
//   생존, 판정 불가 = 변이 미검증
// - 대상 순서(위험도 high → medium → low → 없음, 같으면 표시 ID 순)와 예산 소진 뒤 남은 규칙 미검증 · 실행의 끝(예산 초과, 병합 없음)
// 앞 단계(테스트 작성 · Red 확인 · 구현 · 검사)는 시험용 실행기다: 기준 커밋에 미리 둔 인수 테스트를 그대로 쓰고 Red 확인은 그 해시만
// 남긴다. 변이 주입 실행기는 아직 기본 실행기 목록에 없다(③은 뒤 작업, ADR-139): 여기서 주입한다.
import fs from 'node:fs';
import path from 'node:path';
import { type Risk, type Rule, RUN_REQUIRED_ROLES, type SettingsPatch } from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitRunner } from '../src/git/git-exec.js';
import { createGitRunner } from '../src/git/git-exec.js';
import { JudgeCheckoutError } from '../src/judge/checkout.js';
import { mutantPathProblem } from '../src/mutation/mutant.js';
import { MUTATOR_SYSTEM_PROMPT } from '../src/mutation/prompts.js';
import { validateSettingsForRun } from '../src/settings/settings-service.js';
import { compareMutationOrder, selectMutationTargets } from '../src/steps/mutation.js';
import { roleToolNames } from '../src/tools/definitions.js';
import { COMPLETE_SETTINGS, human, newId, userGit, withProject } from './helpers/engine-harness.js';
import { reinforceSurvivedMutants } from '../src/runs/auto-start.js';
import { createRun } from '../src/runs/run-service.js';
import type { JudgeCall, JudgeDecision } from './helpers/pipeline-harness.js';
import {
  AUTH,
  DECLARATION,
  HEALTH,
  LIB,
  allPass,
  cleanupMutationHarness,
  mainTip,
  mutationsOf,
  runToEnd,
  setup,
  statusOf,
  stepExit,
  toolCallsOf,
  runsOf,
  settleAll,
} from './helpers/mutation-harness.js';

afterEach(cleanupMutationHarness, 60_000);

const VALID_MUTANT = { path: HEALTH, search: 'ok: true', replace: 'ok: false' };

describe('변이 주입 세션 · propose_mutant · 판정 (수용 기준 1)', () => {
  it('세션이 낸 변이를 격리 체크아웃에 적용해 대상 규칙 인수 테스트가 실패하면 변이 검증됨을 저장하고, 변이는 어느 브랜치에도 남지 않는다', async () => {
    const h = setup({
      rules: [{ blocks: ['health'], risk: 'medium' }],
      sessions: { 'RULE-001': [{ tool: 'propose_mutant', args: VALID_MUTANT }] },
    });
    const base = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    expect(done.steps.find((step) => step.kind === 'mutation')?.status).toBe('passed');
    // 판정: 대상 규칙의 인수 테스트만, 실행의 마지막 완료 단계 커밋의 격리 체크아웃에서, 변이가 적용된 상태로
    const head = String(done.steps.find((step) => step.kind === 'implementation')?.commit);
    expect(h.judgeCalls).toHaveLength(1);
    expect(h.judgeCalls[0]).toMatchObject({ kind: 'mutation', head, installed: true });
    expect(h.judgeCalls[0]?.input.ruleIds).toEqual(['RULE-001']);
    // 체크아웃에서 바뀐 추적 파일은 변이 대상 파일 하나뿐이다
    expect(
      (h.judgeCalls[0]?.status ?? '').split('\n').filter((line) => !line.startsWith('!!')),
    ).toEqual([`M ${HEALTH}`]);
    expect(h.judgeCalls[0]?.input.worktreeDir).not.toBe(done.run.worktreePath);
    // 체크아웃은 판정 뒤 지운다
    expect(fs.existsSync(h.judgeCalls[0]?.input.worktreeDir ?? '')).toBe(false);
    // 저장: 규칙의 변이 기록 1건 (세션 · 커밋 · 변이 원문 · 판정 결과)
    const [record] = mutationsOf(h);
    expect(record).toMatchObject({
      ruleId: h.rules[0]?.id,
      runId: h.runId,
      commit: head,
      status: 'verified',
      outcome: 'killed',
      mutant: VALID_MUTANT,
    });
    expect(statusOf(h, h.rules[0] as Rule)).toBe('verified');
    expect(stepExit(done)).toMatchObject({
      commit: head,
      results: [{ ruleId: 'RULE-001', status: 'verified', outcome: 'killed', mutantPath: HEALTH }],
      excluded: [],
    });
    // 변이는 실행 브랜치 · 기준 브랜치 · 실행 워크트리 어디에도 없다
    const branch = String(done.run.branch);
    expect(userGit(h.repo, 'show', `${branch}:${HEALTH}`)).toContain('ok: true');
    expect(userGit(h.repo, 'show', `main:${HEALTH}`)).toContain('ok: true');
    expect(userGit(h.repo, 'log', '--all', '-S', 'ok: false', '--format=%H')).toBe('');
    expect(mainTip(h)).not.toBe(base);
    expect(fs.readFileSync(path.join(h.repo, HEALTH), 'utf8')).toContain('ok: true');
  }, 60_000);

  it('대상 인수 테스트가 모두 통과하면 변이 생존을 저장하고, 생존은 실행을 실패로 만들지 않는다', async () => {
    const h = setup({
      rules: [{ blocks: ['health'], risk: 'medium' }],
      sessions: { 'RULE-001': [{ tool: 'propose_mutant', args: VALID_MUTANT }] },
      decide: allPass,
    });
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    expect(mutationsOf(h).map((item) => [item.status, item.outcome])).toEqual([
      ['survived', 'survived'],
    ]);
    expect(statusOf(h, h.rules[0] as Rule)).toBe('survived');
  }, 60_000);

  it('세션: 역할은 변이 주입, 도구는 읽기 3종 + propose_mutant, 폴더에는 규칙 글과 대상 블록 소스 사본만 (인수 테스트 · 블록 밖 파일 없음), 예산은 역할 · 실행 잔여 안', async () => {
    const h = setup({
      rules: [{ blocks: ['health'], risk: 'medium' }],
      sessions: {
        'RULE-001': [
          { tool: 'read_file', args: { path: '.bive-task/RULE-001.md' } },
          { tool: 'read_file', args: { path: 'bive-acceptance/RULE-001/mutation.acc.ts' } },
          { tool: 'list_files', args: { path: 'bive-acceptance' } },
          { tool: 'write_file', args: { path: HEALTH, content: 'x' } },
          { tool: 'run_tests', args: {} },
          { tool: 'propose_mutant', args: VALID_MUTANT },
        ],
      },
    });
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    expect(h.sessions.map((spec) => spec.role)).toEqual(['mutator']);
    expect(h.sessions[0]?.systemPrompt).toBe(MUTATOR_SYSTEM_PROMPT);
    expect(roleToolNames('mutator')).toEqual([
      'read_file',
      'list_files',
      'search_files',
      'propose_mutant',
    ]);
    expect(h.sessionFiles[0]).toEqual(['.bive-task/RULE-001.md', HEALTH]);
    // 작업 지시에 인수 테스트 · 케이스 이름 · 다른 규범이 없다
    expect(h.sessions[0]?.prompt).not.toContain('bive-acceptance');
    expect(h.sessions[0]?.prompt).toContain('대상 규칙 RULE-001');
    expect(h.sessions[0]?.prompt).toContain('- health: src/app/api/health/**');
    const calls = toolCallsOf(h);
    expect(calls.map((call) => [call.name, call.status, call.reason ?? null])).toEqual([
      ['read_file', 'ok', null],
      ['read_file', 'denied', 'path_denied'],
      ['list_files', 'denied', 'path_denied'],
      ['write_file', 'denied', 'unknown_tool'],
      ['run_tests', 'denied', 'unknown_tool'],
      ['propose_mutant', 'ok', null],
    ]);
    // 변이 글은 도구 호출 기록에 싣지 않는다 (경로만)
    expect(calls.at(-1)?.argsSummary).toBe(HEALTH);
    const [session] = withProject(h.biveHome, h.projectId, (store) =>
      store.sessions.listByRun(h.runId),
    );
    expect(session).toMatchObject({ role: 'mutator', model: 'test-model' });
    // 한도 = min(역할 한도, 실행 잔여): 역할 1 USD · 50턴 (실행 5 USD · 200턴보다 작다)
    expect(session?.budget).toEqual({ maxBudgetUsd: 1, maxTurns: 50 });
    expect(done.run.budgetSnapshot.roles.mutator).toEqual({ maxBudgetUsd: 1, maxTurns: 50 });
    expect(done.run.modelSnapshot.mutator).toBe('test-model');
  }, 60_000);

  it('도구 인자 검증: 블록 밖 · 인수 테스트 · 설정 · 잠금 · 숨김 경로 · 없는 글 · 여러 군데 · 같은 글 · 상한은 거부하고 판정하지 않는다. 받아들인 뒤 둘째 변이는 닫힌 세션으로 거부', async () => {
    const h = setup({
      rules: [{ blocks: ['health'], risk: 'medium' }],
      sessions: {
        'RULE-001': [
          { tool: 'propose_mutant', args: { path: LIB, search: 'export', replace: 'x' } },
          {
            tool: 'propose_mutant',
            args: { path: 'bive-acceptance/RULE-001/mutation.acc.ts', search: 'it', replace: 'x' },
          },
          { tool: 'propose_mutant', args: { path: 'package.json', search: '{', replace: '[' } },
          { tool: 'propose_mutant', args: { path: '.bive.json', search: '{', replace: '[' } },
          {
            tool: 'propose_mutant',
            args: {
              path: 'src/app/api/health/../auth/session/route.ts',
              search: '401',
              replace: '200',
            },
          },
          { tool: 'propose_mutant', args: { path: HEALTH, search: 'ok: maybe', replace: 'x' } },
          { tool: 'propose_mutant', args: { path: HEALTH, search: 'e', replace: 'E' } },
          {
            tool: 'propose_mutant',
            args: { path: HEALTH, search: 'ok: true', replace: 'ok: true' },
          },
          {
            tool: 'propose_mutant',
            args: { path: HEALTH, search: 'x'.repeat(2001), replace: 'y' },
          },
          {
            tool: 'propose_mutant',
            args: { path: 'src/app/api/health/none.ts', search: 'a', replace: 'b' },
          },
          { tool: 'propose_mutant', args: VALID_MUTANT },
          { tool: 'propose_mutant', args: { path: HEALTH, search: 'getDb', replace: 'x' } },
          // 받아들인 뒤에는 읽기 도구도 닫힌 세션으로 거부한다 (실행기가 닫힘)
          { tool: 'read_file', args: { path: '.bive-task/RULE-001.md' } },
        ],
      },
    });
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    expect(toolCallsOf(h).map((call) => [call.status, call.reason ?? null])).toEqual([
      ['denied', 'path_denied'],
      ['denied', 'path_denied'],
      ['denied', 'path_denied'],
      ['denied', 'path_denied'],
      ['denied', 'path_denied'],
      ['denied', 'invalid_args'],
      ['denied', 'invalid_args'],
      ['denied', 'invalid_args'],
      ['denied', 'invalid_args'],
      ['error', 'not_found'],
      ['ok', null],
      ['denied', 'session_closed'],
      ['denied', 'session_closed'],
    ]);
    // 판정은 받아들인 변이 1개만
    expect(h.judgeCalls).toHaveLength(1);
    expect(mutationsOf(h)[0]?.mutant).toEqual(VALID_MUTANT);
  }, 60_000);

  it('금지 경로 판정: 설정 · 잠금 · 계약 원본 · Prisma · 의존성 · 대소문자를 바꾼 이름도 막는다', () => {
    expect(mutantPathProblem(HEALTH)).toBeNull();
    for (const bad of [
      'vitest.config.ts',
      'src/next.config.mjs',
      'tsconfig.json',
      'pnpm-lock.yaml',
      'PACKAGE.JSON',
      'Bive-Acceptance/RULE-001/a.acc.ts',
      'src/node_modules/x.js',
      'prisma/schema.prisma',
      'src/.env',
      '.GIT/config',
      '/etc/passwd',
      'src\\app.ts',
      'src//app.ts',
    ]) {
      expect(mutantPathProblem(bad), bad).not.toBeNull();
    }
    expect(mutantPathProblem('openapi.yaml', ['openapi.yaml'])).not.toBeNull();
    expect(mutantPathProblem('openapi.yaml')).toBeNull();
  });

  it.each([
    ['수집 오류', 'collect_error' as const, 'collect_error'],
    ['러너 오류(빌드 실패 · 시간 초과 포함)', 'runner_error' as const, 'runner_error'],
    ['케이스 0개', {} as JudgeDecision, 'no_cases'],
    ['대상 케이스가 통과 · 실패가 아님', { 'RULE-001': ['skipped'] } as JudgeDecision, 'no_cases'],
  ])(
    '판정 불가(%s)는 검증됨으로 세지 않는다: 변이 미검증, 실행은 그대로 진행',
    async (_name, decision, outcome) => {
      const h = setup({
        rules: [{ blocks: ['health'], risk: 'medium' }],
        sessions: { 'RULE-001': [{ tool: 'propose_mutant', args: VALID_MUTANT }] },
        decide: () => decision,
      });
      const done = await runToEnd(h);
      expect(done.run.status).toBe('merged');
      expect(mutationsOf(h).map((item) => [item.status, item.outcome])).toEqual([
        ['unverified', outcome],
      ]);
      expect(statusOf(h, h.rules[0] as Rule)).toBe('unverified');
    },
    60_000,
  );

  it('판정 불가(설치 실패 · 체크아웃 실패)도 변이 미검증이다', async () => {
    const failingInstall = setup({
      rules: [{ blocks: ['health'], risk: 'medium' }],
      sessions: { 'RULE-001': [{ tool: 'propose_mutant', args: VALID_MUTANT }] },
      judging: {
        installDependencies: () => Promise.reject(new JudgeCheckoutError('install', '설치 실패')),
      },
    });
    await runToEnd(failingInstall);
    expect(mutationsOf(failingInstall).map((item) => item.outcome)).toEqual(['install_error']);
    const real = createGitRunner();
    const noWorktree: GitRunner = (args, options) =>
      args.includes('worktree') && args.includes('add')
        ? Promise.reject(new Error('체크아웃 실패'))
        : real(args, options);
    const failingCheckout = setup({
      rules: [{ blocks: ['health'], risk: 'medium' }],
      sessions: { 'RULE-001': [{ tool: 'propose_mutant', args: VALID_MUTANT }] },
      judging: { git: noWorktree },
    });
    const done = await runToEnd(failingCheckout);
    expect(done.run.status).toBe('merged');
    expect(mutationsOf(failingCheckout).map((item) => [item.status, item.outcome])).toEqual([
      ['unverified', 'checkout_error'],
    ]);
  }, 60_000);

  it('변이를 내지 않고 끝난 세션: 판정(설치 · 빌드) 없이 그 규칙은 변이 미검증, 단계는 통과', async () => {
    const h = setup({ rules: [{ blocks: ['health'], risk: 'medium' }], sessions: {} });
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    expect(h.judgeCalls).toEqual([]);
    expect(mutationsOf(h).map((item) => [item.status, item.outcome, item.mutant])).toEqual([
      ['unverified', 'no_mutant', null],
    ]);
  }, 60_000);
});

describe('대상 순서와 예산 (수용 기준 2)', () => {
  it('위험도 high → medium → low → 없음, 같으면 표시 ID 순 (자리수가 늘어도 수 순서)', () => {
    const rule = (displayId: string, risk: Risk | null) => ({ displayId, risk });
    const sorted = [
      rule('RULE-010', 'low'),
      rule('RULE-002', null),
      rule('RULE-1000', 'medium'),
      rule('RULE-999', 'medium'),
      rule('RULE-003', 'high'),
      rule('RULE-001', null),
      rule('RULE-004', 'high'),
    ].sort(compareMutationOrder);
    expect(sorted.map((item) => `${item.displayId}:${String(item.risk)}`)).toEqual([
      'RULE-003:high',
      'RULE-004:high',
      'RULE-999:medium',
      'RULE-1000:medium',
      'RULE-010:low',
      'RULE-001:null',
      'RULE-002:null',
    ]);
  });

  it('내장 규칙 · 블록 선언 없음 · 대상 블록 없음 · 인수 테스트 없음은 변이 대상이 아니다', () => {
    const base = { deletedAt: null, risk: 'high' as const };
    const rule = (displayId: string, extra: Partial<Rule>) =>
      ({ ...base, displayId, targetBlockIds: ['auth'], builtin: false, ...extra }) as Rule;
    const builtin = rule('RULE-001', { builtin: true, targetBlockIds: [], risk: null });
    const noBlocks = rule('RULE-002', { targetBlockIds: [] });
    const unknownBlock = rule('RULE-003', { targetBlockIds: ['payments'] });
    const noTests = rule('RULE-004', {});
    const ok = rule('RULE-005', {});
    const picked = selectMutationTargets(
      [builtin, noBlocks, unknownBlock, noTests, ok],
      DECLARATION.blocks,
      ['RULE-001', 'RULE-002', 'RULE-003', 'RULE-005'],
    );
    expect(picked.targets.map((item) => item.rule.displayId)).toEqual(['RULE-005']);
    expect(picked.excluded.map((item) => [item.rule.displayId, item.reason])).toEqual([
      ['RULE-001', 'builtin'],
      ['RULE-002', 'no_target_blocks'],
      ['RULE-003', 'no_target_blocks'],
      ['RULE-004', 'no_acceptance'],
    ]);
    expect(selectMutationTargets([ok], null, ['RULE-005']).excluded).toEqual([
      { rule: ok, reason: 'no_block_declaration' },
    ]);
  });

  it('실행의 대상 규칙을 위험도 순으로 하나씩 다루고, 대상이 아닌 규칙은 사유와 함께 빠진다', async () => {
    const h = setup({
      rules: [
        { blocks: ['health'], risk: 'medium' },
        { blocks: ['auth'], risk: 'high' },
        { blocks: ['lib'], risk: 'low' },
        { blocks: ['health'], risk: null },
        { blocks: ['health'], risk: 'medium' },
        { blocks: [], risk: 'high' },
        { blocks: ['health'], risk: 'high', acceptance: false },
      ],
      sessions: {},
    });
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    expect(h.sessions.map((spec) => spec.vars?.ruleId)).toEqual([
      'RULE-002',
      'RULE-001',
      'RULE-005',
      'RULE-003',
      'RULE-004',
    ]);
    // 세션 폴더의 사본은 그 규칙의 대상 블록 파일뿐이다
    expect(h.sessionFiles[0]).toEqual(['.bive-task/RULE-002.md', AUTH]);
    expect(h.sessionFiles[3]).toEqual(['.bive-task/RULE-003.md', LIB]);
    expect(stepExit(done).excluded).toEqual([
      { ruleId: 'RULE-006', reason: 'no_target_blocks' },
      { ruleId: 'RULE-007', reason: 'no_acceptance' },
    ]);
  }, 60_000);

  it('예산이 중간에 바닥나면 남은 규칙은 기록 없이 변이 미검증으로 남고, 실행은 예산 초과로 끝난다 (병합 없음)', async () => {
    const settings: SettingsPatch = {
      ...COMPLETE_SETTINGS,
      roles: {
        ...COMPLETE_SETTINGS.roles,
        mutator: { model: 'test-model', maxBudgetUsd: 0.05, maxTurns: 50 },
      },
    };
    const h = setup({
      rules: [
        { blocks: ['lib'], risk: 'low' },
        { blocks: ['auth'], risk: 'high' },
        { blocks: ['health'], risk: 'medium' },
      ],
      sessions: {
        'RULE-002': [
          {
            tool: 'propose_mutant',
            args: { path: AUTH, search: 'status: 401', replace: 'status: 200' },
          },
        ],
      },
      settings,
      cost: 0.05,
    });
    const base = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'budget_exceeded',
      failureReason: 'budget_exhausted',
    });
    // 위험도가 가장 높은 규칙만 다뤘다 (세션 1개 · 판정 1회)
    expect(h.sessions.map((spec) => spec.vars?.ruleId)).toEqual(['RULE-002']);
    expect(mutationsOf(h).map((item) => [item.ruleId, item.status])).toEqual([
      [h.rules[1]?.id, 'verified'],
    ]);
    expect(statusOf(h, h.rules[0] as Rule)).toBe('unverified');
    expect(statusOf(h, h.rules[2] as Rule)).toBe('unverified');
    // 변이 주입은 병합 앞이라 병합하지 않는다
    expect(mainTip(h)).toBe(base);
    expect(done.steps.find((step) => step.kind === 'merge')?.status).toBe('pending');
  }, 60_000);
});

describe('설정: 변이 주입 역할 (수용 기준 4의 서버 쪽)', () => {
  it('변이 주입 역할의 모델 · 한도가 비면 validateForRun이 SETTINGS_INCOMPLETE이고 실행을 만들지 않는다', () => {
    expect(RUN_REQUIRED_ROLES).toContain('mutator');
    const filled = {
      run: { maxBudgetUsd: 5, maxTurns: 200 },
      roles: {
        'rule-writer': { model: 'm', maxBudgetUsd: 1, maxTurns: 1 },
        planner: { model: null, maxBudgetUsd: null, maxTurns: null },
        'test-writer': { model: 'm', maxBudgetUsd: 1, maxTurns: 1 },
        implementer: { model: 'm', maxBudgetUsd: 1, maxTurns: 1 },
        mutator: { model: null, maxBudgetUsd: null, maxTurns: null },
        chat: { model: null, maxBudgetUsd: null, maxTurns: null },
      },
    };
    expect(validateSettingsForRun(filled)).toMatchObject({
      ok: false,
      reason: 'SETTINGS_INCOMPLETE',
      missing: ['roles.mutator.model', 'roles.mutator.maxBudgetUsd', 'roles.mutator.maxTurns'],
    });
    expect(
      validateSettingsForRun({
        ...filled,
        roles: { ...filled.roles, mutator: { model: 'm', maxBudgetUsd: 1, maxTurns: 1 } },
      }),
    ).toEqual({ ok: true });
  });
});

describe('단계 켜기 · 세션 처리 · 세션 폴더 (M3-54 #311 수용 기준 1, ADR-143)', () => {
  it('세션이 정상 종료하지 않고 변이도 내지 않으면 변이 없음으로 삼키지 않고 단계 미충족: 실행은 step_unmet으로 끝나고 병합 · 기록 없음', async () => {
    const h = setup({
      rules: [{ blocks: ['health'], risk: 'medium' }],
      sessions: { 'RULE-001': [{ message: '오류' }] },
      subtypes: { 'RULE-001': 'error_during_execution' },
    });
    const base = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'failed', failureReason: 'step_unmet' });
    expect(stepExit(done)).toMatchObject({
      reason: 'step_unmet',
      detail: { reason: 'session_error', ruleId: 'RULE-001', endReason: 'error_during_execution' },
    });
    expect(mutationsOf(h)).toEqual([]);
    expect(h.judgeCalls).toEqual([]);
    expect(mainTip(h)).toBe(base);
  }, 60_000);

  it('변이 주입 대본이 없는 시나리오: 가짜 어댑터가 변이 없이 정상 종료하는 세션을 재생해 변이 미검증 · 단계 통과 · 판정 없음', async () => {
    const h = setup({
      rules: [{ blocks: ['health'], risk: 'medium' }],
      sessions: {},
      noMutator: true,
    });
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    expect(h.sessions.map((spec) => spec.role)).toEqual(['mutator']);
    expect(h.judgeCalls).toEqual([]);
    expect(mutationsOf(h).map((item) => [item.status, item.outcome])).toEqual([
      ['unverified', 'no_mutant'],
    ]);
  }, 60_000);

  it('변이를 받은 뒤에도 도구를 계속 부르는 세션은 거부 3번 뒤 끝나고, 받은 변이는 판정된다 (한도로 실행이 끝나지 않는다)', async () => {
    const h = setup({
      rules: [{ blocks: ['health'], risk: 'medium' }],
      sessions: {
        'RULE-001': [
          { tool: 'propose_mutant', args: VALID_MUTANT },
          ...Array.from({ length: 6 }, () => ({
            tool: 'read_file',
            args: { path: '.bive-task/RULE-001.md' },
          })),
        ],
      },
    });
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    expect(toolCallsOf(h).map((call) => call.reason ?? call.status)).toEqual([
      'ok',
      'session_closed',
      'session_closed',
      'session_closed',
    ]);
    const [session] = withProject(h.biveHome, h.projectId, (store) =>
      store.sessions.listByRun(h.runId),
    );
    expect(session?.endReason).toBe('aborted');
    expect(mutationsOf(h).map((item) => [item.status, item.outcome])).toEqual([
      ['verified', 'killed'],
    ]);
  }, 60_000);

  it('세션 폴더: 블록 include가 rules/**를 덮어도 규칙 글(.bive-task/)과 소스 사본이 겹치지 않고, include가 **여도 인수 테스트 사본은 없다', async () => {
    const h = setup({
      rules: [{ blocks: ['all'], risk: 'high' }],
      sessions: {},
      declaration: {
        blocks: [
          { name: 'all', kind: 'domain', include: ['**'], public: [], dependsOn: [], risk: 'high' },
        ],
      },
      extraFiles: { 'rules/RULE-001.md': '프로젝트의 문서 (BIVE 규칙 글이 아님)\n' },
    });
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    const files = h.sessionFiles[0] ?? [];
    expect(files).toContain('.bive-task/RULE-001.md');
    expect(files).toContain('rules/RULE-001.md');
    expect(files).toContain(HEALTH);
    expect(files.filter((file) => file.startsWith('bive-acceptance/'))).toEqual([]);
    // BIVE 폴더 밖의 숨김 경로 사본도 없다
    expect(
      files.filter(
        (file) =>
          file.split('/').some((part) => part.startsWith('.')) && !file.startsWith('.bive-task/'),
      ),
    ).toEqual([]);
    expect(h.sessionTexts[0]?.['.bive-task/RULE-001.md']).toContain(
      'WHEN 클라이언트가 요청 1을 보내면',
    );
    expect(h.sessionTexts[0]?.['rules/RULE-001.md']).toBe(
      '프로젝트의 문서 (BIVE 규칙 글이 아님)\n',
    );
  }, 60_000);
});

/** 자동 시작이 가능한 설정 (하루 한도 채움). */
const AUTO_SETTINGS = { ...COMPLETE_SETTINGS, dailyBudgetUsd: 10 };

/** 재주입에서 보강 테스트(`reinforce-*.acc.ts`)가 있으면 변이를 잡는다(케이스 하나 실패), 첫 주입은 늘 생존. */
const killedByReinforcement = (call: JudgeCall): JudgeDecision =>
  Object.fromEntries(
    (call.input.ruleIds ?? []).map((id) => [
      id,
      call.acceptance.some((file) => file.includes('/reinforce-'))
        ? (['failed', 'passed'] as const)
        : (['passed', 'passed'] as const),
    ]),
  );

describe('변이 생존의 자동 테스트 보강 · 재주입 (M3-54 #311 수용 기준 1 · 3, ADR-100 B④ · ADR-141 · ADR-143)', () => {
  it('유형 A에서 변이가 살아남으면 사람 확인 없이 그 규칙의 유형 C 보강 실행이 생기고, 새 변이 세션 없이 같은 변이를 재주입해 검출되면 변이 검증됨 · 병합', async () => {
    const h = setup({
      rules: [{ blocks: ['health'], risk: 'medium' }],
      sessions: { 'RULE-001': [{ tool: 'propose_mutant', args: VALID_MUTANT }] },
      decide: killedByReinforcement,
      settings: AUTO_SETTINGS,
    });
    const base = mainTip(h);
    const first = await runToEnd(h);
    expect(first.run).toMatchObject({ type: 'A', status: 'merged' });
    await settleAll(h);
    const runs = runsOf(h);
    expect(
      runs.map((detail) => [detail.run.displayId, detail.run.type, detail.run.status]),
    ).toEqual([
      ['EXE-001', 'A', 'merged'],
      ['EXE-002', 'C', 'merged'],
    ]);
    const reinforcing = runs[1]!;
    const firstResult = withProject(h.biveHome, h.projectId, (store) =>
      store.mutations.listByRun(h.runId),
    )[0]!;
    expect(firstResult).toMatchObject({ status: 'survived', mutant: VALID_MUTANT });
    // 시작 근거: 오케스트레이터 주체, 원인 = 변이 보강 연결, 자동 시작 항목의 원인 = 그 생존 기록
    const link = withProject(h.biveHome, h.projectId, (store) =>
      store.mutations.reinforcementOfRun(reinforcing.run.id),
    );
    expect(link?.mutationResultId).toBe(firstResult.id);
    expect(reinforcing.run.startedBy).toEqual({
      kind: 'orchestrator',
      causeSeqs: [link?.seq],
      causeLog: 'mutation_reinforcements',
    });
    expect(reinforcing.run.targetRuleIds).toEqual([h.rules[0]?.id]);
    const autoStarts = withProject(h.biveHome, h.projectId, (store) =>
      store.normChanges.list().filter((entry) => entry.kind === 'auto_start'),
    );
    expect(autoStarts.map((entry) => [entry.targetRef.id, entry.detail])).toEqual([
      [reinforcing.run.id, { mutationResultIds: [firstResult.id], ruleIds: [h.rules[0]?.id] }],
    ]);
    // 보강 실행: 구현 생략, Green 확인, 검사, 변이 주입 = 재주입(생략 아님), 병합
    expect(
      reinforcing.steps.map((step) => `${step.kind}#${String(step.attempt)}:${step.status}`),
    ).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'green_check#1:passed',
      'implementation#1:skipped',
      'check#1:passed',
      'mutation#1:passed',
      'merge#1:passed',
      'screen_update#1:passed',
    ]);
    // 새 변이 세션은 첫 실행의 하나뿐이고, 재주입 판정은 같은 변이를 보강 커밋의 격리 체크아웃에 적용했다
    expect(h.sessions.map((spec) => spec.role)).toEqual(['mutator']);
    expect(h.judgeCalls).toHaveLength(2);
    const reinjection = h.judgeCalls[1]!;
    expect(reinjection.input.runId).toBe(reinforcing.run.id);
    expect(reinjection.head).toBe(reinforcing.run.headCommit);
    expect(reinjection.status.split('\n').filter((line) => !line.startsWith('!!'))).toEqual([
      `M ${HEALTH}`,
    ]);
    // 변이 기록: 첫 주입 생존 → 재주입 검출, 규칙의 상태는 변이 검증됨
    const results = withProject(h.biveHome, h.projectId, (store) =>
      store.mutations.listByRun(reinforcing.run.id),
    );
    expect(results.map((item) => [item.status, item.outcome, item.sessionId, item.mutant])).toEqual(
      [['verified', 'killed', null, VALID_MUTANT]],
    );
    expect(statusOf(h, h.rules[0] as Rule)).toBe('verified');
    // 변이는 어떤 ref · 작업 트리에도 없고, main에는 보강 테스트만 들어왔다
    expect(userGit(h.repo, 'log', '--all', '-S', 'ok: false', '--format=%H')).toBe('');
    expect(userGit(h.repo, 'show', `main:${HEALTH}`)).toContain('ok: true');
    expect(userGit(h.repo, 'diff', '--name-only', base, 'main').split('\n')).toContain(
      'bive-acceptance/RULE-001/reinforce-1.acc.ts',
    );
    // 고리 없음: 보강 실행의 재주입 결과로 새 실행이 생기지 않는다
    await settleAll(h);
    expect(runsOf(h)).toHaveLength(2);
  }, 90_000);

  it('재주입에서도 살아남으면 테스트 작성으로 회귀하고 상한 뒤 실패(regression_limit), 규칙은 변이 생존 그대로이며 같은 변이로 다시 만들지 않는다', async () => {
    const h = setup({
      rules: [{ blocks: ['health'], risk: 'medium' }],
      sessions: { 'RULE-001': [{ tool: 'propose_mutant', args: VALID_MUTANT }] },
      decide: allPass,
      settings: AUTO_SETTINGS,
    });
    await runToEnd(h);
    await settleAll(h);
    const runs = runsOf(h);
    expect(runs).toHaveLength(2);
    const reinforcing = runs[1]!;
    expect(reinforcing.run).toMatchObject({
      type: 'C',
      status: 'failed',
      failureReason: 'regression_limit',
      regressionCount: 2,
    });
    expect(
      reinforcing.steps
        .filter((step) => step.kind === 'mutation' || step.kind === 'test_writing')
        .map((step) => `${step.kind}#${String(step.attempt)}:${step.status}`),
    ).toEqual([
      'test_writing#1:passed',
      'test_writing#2:passed',
      'test_writing#3:passed',
      'mutation#1:failed',
      'mutation#2:failed',
      'mutation#3:failed',
    ]);
    expect(statusOf(h, h.rules[0] as Rule)).toBe('survived');
    expect(h.sessions.map((spec) => spec.role)).toEqual(['mutator']);
    // 실패로 끝난 뒤에도 같은 변이 기록으로 다시 만들지 않는다 (재주입 생존 기록도 원인이 아니다)
    const again = withProject(h.biveHome, h.projectId, (store) =>
      reinforceSurvivedMutants(store, { runId: h.runId }, { now: Date.now, newId }),
    );
    expect(again).toEqual({ status: 'none' });
    const reinjected = withProject(h.biveHome, h.projectId, (store) =>
      reinforceSurvivedMutants(store, { runId: reinforcing.run.id }, { now: Date.now, newId }),
    );
    expect(reinjected).toEqual({ status: 'not_applicable' });
    expect(runsOf(h)).toHaveLength(2);
  }, 90_000);

  it('재주입이 판정할 수 없으면(러너 오류) 검증됨으로 세지 않고 기록 없이 실행을 끝낸다 (규칙은 변이 생존 그대로)', async () => {
    let calls = 0;
    const h = setup({
      rules: [{ blocks: ['health'], risk: 'medium' }],
      sessions: { 'RULE-001': [{ tool: 'propose_mutant', args: VALID_MUTANT }] },
      decide: (call) => {
        calls += 1;
        return calls === 1 ? allPass(call) : 'runner_error';
      },
      settings: AUTO_SETTINGS,
    });
    await runToEnd(h);
    await settleAll(h);
    const reinforcing = runsOf(h)[1]!;
    expect(reinforcing.run).toMatchObject({
      status: 'failed',
      failureReason: 'judge_runner_error',
    });
    expect(reinforcing.steps.find((step) => step.kind === 'mutation')?.exitDetail).toMatchObject({
      detail: { stage: 'reinject', outcome: 'runner_error' },
    });
    expect(
      withProject(h.biveHome, h.projectId, (store) =>
        store.mutations.listByRun(reinforcing.run.id),
      ),
    ).toEqual([]);
    expect(statusOf(h, h.rules[0] as Rule)).toBe('survived');
    // 보강 실행이 끝났고(실패) 최신 기록은 여전히 첫 실행의 생존이어도, 같은 기록으로 다시 만들지 않는다 (연결이 이미 있다)
    expect(
      withProject(h.biveHome, h.projectId, (store) =>
        reinforceSurvivedMutants(store, { runId: h.runId }, { now: Date.now, newId }),
      ),
    ).toEqual({ status: 'none' });
    expect(runsOf(h)).toHaveLength(2);
  }, 90_000);

  it('검증됨 · 미검증 · 변이 없음은 보강 실행을 만들지 않고, 같은 변이 기록 · 같은 규칙에 끝나지 않은 보강 실행이 있으면 또 만들지 않는다', async () => {
    const h = setup({
      rules: [
        { blocks: ['health'], risk: 'medium' },
        { blocks: ['auth'], risk: 'high' },
        { blocks: ['lib'], risk: 'low' },
      ],
      sessions: {
        'RULE-001': [{ tool: 'propose_mutant', args: VALID_MUTANT }],
        'RULE-002': [
          {
            tool: 'propose_mutant',
            args: { path: AUTH, search: 'status: 401', replace: 'status: 200' },
          },
        ],
      },
      // RULE-001 검출 · RULE-002 생존 · RULE-003 변이 없음(미검증)
      decide: (call) =>
        Object.fromEntries(
          (call.input.ruleIds ?? []).map((id) => [
            id,
            id === 'RULE-001' ? (['failed'] as const) : (['passed'] as const),
          ]),
        ),
      settings: AUTO_SETTINGS,
      noAutoStart: true,
    });
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    const clock = { now: Date.now, newId };
    const made = withProject(h.biveHome, h.projectId, (store) =>
      reinforceSurvivedMutants(store, { runId: h.runId }, clock),
    );
    expect(made.status).toBe('started');
    const created = made.status === 'started' ? made.runs : [];
    expect(
      created.map(({ detail }) => [detail.run.type, detail.run.status, detail.run.targetRuleIds]),
    ).toEqual([['C', 'waiting_approval', [h.rules[1]?.id]]]);
    // 같은 변이 기록으로 두 번 만들지 않는다
    expect(
      withProject(h.biveHome, h.projectId, (store) =>
        reinforceSurvivedMutants(store, { runId: h.runId }, clock),
      ),
    ).toEqual({ status: 'none' });
    // 같은 규칙의 다른 실행이 새 생존 기록을 남겨도, 끝나지 않은 보강 실행이 있으면 만들지 않는다
    const second = withProject(h.biveHome, h.projectId, (store) =>
      createRun(store, { ruleIds: [h.rules[1]!.id], author: human }, { clientId: null }, clock),
    ).run.id;
    expect(h.engine.evaluateApproval(h.projectId, second)).toBe(true);
    await h.engine.settled();
    const secondResults = withProject(h.biveHome, h.projectId, (store) =>
      store.mutations.listByRun(second),
    );
    expect(secondResults.map((item) => item.status)).toEqual(['survived']);
    expect(
      withProject(h.biveHome, h.projectId, (store) =>
        reinforceSurvivedMutants(store, { runId: second }, clock),
      ),
    ).toEqual({ status: 'none' });
  }, 90_000);
});
