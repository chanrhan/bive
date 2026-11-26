// 변이 주입 역할 · 변이 상태 · 고위험 우선 (M3-07 #52 수용 기준 1 · 2, JDG-04 · RUN-04 · NRM-09 · COST-01, ADR-033 · ADR-139).
// - 변이 주입 세션(ScriptedAdapter + 실제 고정 도구 · 경로 가드)이 `propose_mutant`로 대상 블록 파일 안 한 군데 변이를 내고, 단계
//   실행기가 판정 커밋의 격리 체크아웃에 적용해 대상 규칙 인수 테스트를 판정한다(판정 · 설치만 주입). 실패 = 변이 검증됨, 통과 = 변이
//   생존, 판정 불가 = 변이 미검증
// - 대상 순서(위험도 high → medium → low → 없음, 같으면 표시 ID 순)와 예산 소진 뒤 남은 규칙 미검증 · 실행의 끝(예산 초과, 병합 없음)
// 앞 단계(테스트 작성 · Red 확인 · 구현 · 검사)는 시험용 실행기다: 기준 커밋에 미리 둔 인수 테스트를 그대로 쓰고 Red 확인은 그 해시만
// 남긴다. 변이 주입 실행기는 아직 기본 실행기 목록에 없다(③은 뒤 작업, ADR-139): 여기서 주입한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  type BlockDeclaration,
  type Risk,
  type Rule,
  RUN_REQUIRED_ROLES,
  type SettingsPatch,
  type TestCaseStatus,
} from '@bive/shared';
import { registerProject } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import type { AgentAdapter, SessionSpec } from '../src/agent/adapter.js';
import { loadScenario } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import { PipelineEngine } from '../src/engine/pipeline-engine.js';
import type { StepExecutor } from '../src/engine/types.js';
import type { GitRunner } from '../src/git/git-exec.js';
import { createGitRunner } from '../src/git/git-exec.js';
import { hashAcceptanceFiles, JudgeCheckoutError } from '../src/judge/checkout.js';
import { mutantPathProblem } from '../src/mutation/mutant.js';
import { MUTATOR_SYSTEM_PROMPT } from '../src/mutation/prompts.js';
import { createRun } from '../src/runs/run-service.js';
import { validateSettingsForRun } from '../src/settings/settings-service.js';
import {
  compareMutationOrder,
  createMutationExecutor,
  type MutationStepOptions,
  selectMutationTargets,
} from '../src/steps/mutation.js';
import { roleToolNames } from '../src/tools/definitions.js';
import {
  COMPLETE_SETTINGS,
  copyFixture,
  human,
  mergeStep,
  newId,
  scripted,
  T0,
  userGit,
  withProject,
} from './helpers/engine-harness.js';
import {
  fakeInstall,
  injectedJudge,
  type JudgeCall,
  type JudgeDecision,
} from './helpers/pipeline-harness.js';
import { cleanup, makeBiveHome } from './helpers/process.js';

const temps: string[] = [];
const engines: PipelineEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}, 60_000);

const HEALTH = 'src/app/api/health/route.ts';
const AUTH = 'src/app/api/auth/session/route.ts';
const LIB = 'src/lib/db.ts';

/** 픽스처 블록 선언 예제와 같은 블록 (auth high · health medium · lib low). */
const DECLARATION: BlockDeclaration = {
  blocks: [
    {
      name: 'auth',
      kind: 'domain',
      include: ['src/app/api/auth/**'],
      public: [],
      dependsOn: ['lib'],
      risk: 'high',
    },
    {
      name: 'health',
      kind: 'domain',
      include: ['src/app/api/health/**'],
      public: [],
      dependsOn: ['lib'],
      risk: 'medium',
    },
    {
      name: 'lib',
      kind: 'shared',
      include: ['src/lib/**'],
      public: ['src/lib/db.ts'],
      dependsOn: [],
      risk: 'low',
    },
  ],
};

interface RuleSeed {
  readonly blocks: readonly string[];
  readonly risk: Risk | null;
  /** 기준 커밋에 인수 테스트 파일을 둔다 (기본 참) */
  readonly acceptance?: boolean;
}

const RESULT = (cost: number) => ({
  subtype: 'success' as const,
  total_cost_usd: cost,
  num_turns: 2,
  modelUsage: {
    'test-model': {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: cost,
    },
  },
});

type Turn = { tool: string; args: Record<string, unknown> } | { message: string };

/** 규칙마다(`when.ruleId`) 변이 주입 세션 대본. 대본이 없는 규칙은 변이를 내지 않는 세션이다. */
const writeScenario = (
  sessions: Record<string, Turn[]>,
  cost = 0.01,
  extra: {
    readonly subtypes?: Record<string, 'error_during_execution'>;
    readonly noMutator?: boolean;
  } = {},
): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bive-mutation-'));
  temps.push(dir);
  const scenario = structuredClone(loadScenario('happy-path'));
  scenario.name = 'mutation-test';
  // 변이 주입 대본이 없는 시나리오 (가짜 어댑터의 기본 세션: 변이 없이 정상 종료, M3-54)
  scenario.roles =
    extra.noMutator === true
      ? {}
      : {
          mutator: {
            sessions: [
              ...Object.entries(sessions).map(([ruleId, turns]) => ({
                when: { ruleId },
                turns,
                result: {
                  ...RESULT(cost),
                  subtype: (extra.subtypes?.[ruleId] ?? 'success') as
                    'success' | 'error_during_execution',
                },
              })),
              { turns: [{ message: '낼 변이가 없다.' }], result: RESULT(cost) },
            ],
          },
        };
  fs.writeFileSync(path.join(dir, 'mutation-test.yaml'), stringify(scenario));
  return dir;
};

/** 시험용 Red 확인: 워크트리(= 기준 커밋)의 인수 테스트 해시만 남긴다. */
const redFromWorktree: StepExecutor = (context) =>
  Promise.resolve({
    status: 'passed',
    exitDetail: { acceptanceHashes: hashAcceptanceFiles(context.git.worktreePath) },
  });

interface Harness {
  biveHome: string;
  repo: string;
  projectId: string;
  runId: string;
  rules: Rule[];
  engine: PipelineEngine;
  judgeCalls: JudgeCall[];
  sessions: SessionSpec[];
  /** 세션이 열릴 때 본 세션 폴더의 파일 (세션 폴더 기준 경로, 정렬) */
  sessionFiles: string[][];
  /** 세션이 열릴 때 본 세션 폴더의 파일 내용 */
  sessionTexts: Record<string, string>[];
}

interface SetupOptions {
  readonly rules: readonly RuleSeed[];
  readonly sessions: Record<string, Turn[]>;
  readonly decide?: (call: JudgeCall) => JudgeDecision;
  readonly settings?: SettingsPatch;
  readonly cost?: number;
  readonly judging?: Partial<MutationStepOptions>;
  /** 블록 선언 (기본 `DECLARATION`) */
  readonly declaration?: BlockDeclaration;
  /** 기준 커밋에 더 둘 파일 (경로 → 내용) */
  readonly extraFiles?: Record<string, string>;
  readonly subtypes?: Record<string, 'error_during_execution'>;
  readonly noMutator?: boolean;
}

const listTree = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
};

const setup = (options: SetupOptions): Harness => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  options.rules.forEach((seed, index) => {
    if (seed.acceptance === false) return;
    const id = `RULE-${String(index + 1).padStart(3, '0')}`;
    const file = path.join(repo, 'bive-acceptance', id, 'mutation.acc.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `import { it } from 'vitest';\nit('${id} 동작', () => undefined);\n`);
  });
  for (const [rel, text] of Object.entries(options.extraFiles ?? {})) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  userGit(repo, 'add', '--all');
  userGit(repo, 'commit', '-q', '-m', 'fixture: 인수 테스트');
  const project = registerProject(
    {
      id: newId(),
      name: '샘플 앱',
      rootPath: repo,
      baseBranch: 'main',
      createdAt: new Date(T0).toISOString(),
    },
    { home: biveHome },
  );
  const at = new Date(T0).toISOString();
  const rules = withProject(biveHome, project.id, (store) => {
    store.settings.update(options.settings ?? COMPLETE_SETTINGS, { by: human, at });
    store.blockDeclarations.set(options.declaration ?? DECLARATION, { at, by: human });
    const requirement = store.requirements.create({
      id: newId(),
      text: '변이 시험 요구사항',
      author: human,
      normState: 'approved',
      createdAt: at,
    });
    return options.rules.map((seed, index) =>
      store.rules.create({
        id: newId(),
        title: `규칙 ${String(index + 1)}`,
        statement: `WHEN 클라이언트가 요청 ${String(index + 1)}을 보내면 THE SYSTEM SHALL 정해진 응답을 돌려준다`,
        kind: 'business',
        checkKinds: ['test'],
        parentRequirementId: requirement.id,
        builtin: false,
        targetBlockIds: [...seed.blocks],
        risk: seed.risk,
        contractId: null,
        author: { kind: 'agent', role: 'rule-writer' },
        normState: 'approved',
        createdAt: at,
      }),
    );
  });
  const scripted = new ScriptedAdapter({
    scenario: loadScenario(
      'mutation-test',
      writeScenario(options.sessions, options.cost, {
        ...(options.subtypes === undefined ? {} : { subtypes: options.subtypes }),
        ...(options.noMutator === undefined ? {} : { noMutator: options.noMutator }),
      }),
    ),
    biveHome,
    pollIntervalMs: 20,
  });
  const sessions: SessionSpec[] = [];
  const sessionFiles: string[][] = [];
  const sessionTexts: Record<string, string>[] = [];
  const adapter: AgentAdapter = {
    kind: scripted.kind,
    startSession: (spec) => {
      sessions.push(spec);
      const listed = listTree(spec.workDir);
      sessionFiles.push(listed);
      sessionTexts.push(
        Object.fromEntries(
          listed.map((rel) => [rel, fs.readFileSync(path.join(spec.workDir, rel), 'utf8')]),
        ),
      );
      return scripted.startSession(spec);
    },
  };
  const judgeCalls: JudgeCall[] = [];
  const engine = new PipelineEngine({
    biveHome,
    agent: adapter,
    executors: {
      test_writing: scripted_(),
      red_check: redFromWorktree,
      implementation: implementOutsideBlocks,
      check: scripted_(),
      mutation: createMutationExecutor({
        judge: injectedJudge(judgeCalls, options.decide ?? killedWhenMutated),
        installDependencies: fakeInstall,
        ...options.judging,
      }),
      merge: mergeStep,
    },
  });
  engines.push(engine);
  const runId = withProject(biveHome, project.id, (store) =>
    createRun(
      store,
      { ruleIds: rules.map((rule) => rule.id), author: human },
      { clientId: null },
      { now: Date.now, newId },
    ),
  ).run.id;
  return {
    biveHome,
    repo,
    projectId: project.id,
    runId,
    rules,
    engine,
    judgeCalls,
    sessions,
    sessionFiles,
    sessionTexts,
  };
};

const scripted_ = (): StepExecutor => scripted(['passed']);

/** 시험용 구현: 블록 밖 파일 하나를 더한다 (병합할 커밋이 생기게, 변이 대상 · 세션 사본과 무관). */
const implementOutsideBlocks: StepExecutor = (context) => {
  fs.mkdirSync(path.join(context.git.worktreePath, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(context.git.worktreePath, 'notes', 'impl.md'), '구현\n');
  return Promise.resolve({ status: 'passed' });
};

/** 기본 판정: 체크아웃의 파일이 바뀌었으면(변이가 적용됨) 판정한 규칙의 케이스 하나가 실패, 아니면 모두 통과. */
const killedWhenMutated = (call: JudgeCall): JudgeDecision =>
  Object.fromEntries(
    (call.input.ruleIds ?? []).map((id) => [
      id,
      call.status.includes('M src/')
        ? (['failed', 'passed'] as const)
        : (['passed', 'passed'] as const),
    ]),
  );

const allPass = (call: JudgeCall): JudgeDecision =>
  Object.fromEntries(
    (call.input.ruleIds ?? []).map((id) => [id, ['passed', 'passed'] as readonly TestCaseStatus[]]),
  );

const runToEnd = async (h: Harness) => {
  if (!h.engine.evaluateApproval(h.projectId, h.runId)) throw new Error('승인 단계 미충족');
  await h.engine.settled();
  return withProject(h.biveHome, h.projectId, (store) => {
    const detail = store.runs.getDetail(h.runId);
    if (detail === null) throw new Error('실행 없음');
    return detail;
  });
};

const mutationsOf = (h: Harness) =>
  withProject(h.biveHome, h.projectId, (store) => store.mutations.listByRun(h.runId));
const statusOf = (h: Harness, rule: Rule) =>
  withProject(h.biveHome, h.projectId, (store) => store.mutations.statusOf(rule.id));
const toolCallsOf = (h: Harness) =>
  withProject(h.biveHome, h.projectId, (store) => store.sessions.toolCalls(h.runId));
const mainTip = (h: Harness) => userGit(h.repo, 'rev-parse', 'refs/heads/main');
const stepExit = (detail: Awaited<ReturnType<typeof runToEnd>>) =>
  detail.steps.find((step) => step.kind === 'mutation')?.exitDetail as Record<string, unknown>;

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
