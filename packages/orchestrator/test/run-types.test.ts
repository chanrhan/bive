// 실행 유형 C · D의 제품 단계 실행기 (M3-06 #51 수용 기준 2 · 3, RUN-07, ADR-020 · architecture.md C-18 · ADR-136).
// - 유형 C: Green 확인(새 테스트 전부 통과, 하나라도 실패 · 케이스 0개 · 수집 오류면 테스트 작성으로 회귀)과 소스 파일 쓰기 거부
//   (세션의 경로 가드 · 테스트 작성 커밋의 대조 · 병합 전 대조)
// - 유형 D: 시작 전 기준 검사(기준 커밋의 효력 있는 규칙 전부 통과, 아니면 구현 없이 끝냄)와 검사 단계의 기존 검사 전부 통과
// 픽스처 git 복사본 · 실제 SQLite · 실제 git · ScriptedAdapter(실제 고정 도구 · 경로 가드) · 제품 실행기. 판정 · 의존성 설치만 주입한다
// (test/helpers/pipeline-harness.ts). 구조 검사 · 계약 검사가 끼는 사례는 structure-check.test.ts · contract-runner.test.ts에 있다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { StepKind, TestCaseStatus } from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { loadScenario } from '../src/agent/scenario.js';
import type { NormJudgeLauncher, NormJudgeRequest, StepExecutor } from '../src/engine/types.js';
import { hashAcceptanceFiles } from '../src/judge/checkout.js';
import { readContractSource, registerHumanContract } from '../src/norms/contract.js';
import type { PipelineEngine } from '../src/engine/pipeline-engine.js';
import { GREEN_CONDITION, TEST_WRITER_SYSTEM_PROMPT } from '../src/test-writer/prompts.js';
import { human, newId, ROUTE, userGit, withProject } from './helpers/engine-harness.js';
import {
  attempts,
  exitOf,
  type JudgeCall,
  type JudgeDecision,
  judgmentsOf,
  type PipelineHarness,
  type PipelineSetupOptions,
  runToEnd,
  setupPipeline,
  stepOf,
  toolCallsOf,
} from './helpers/pipeline-harness.js';
import { cleanup } from './helpers/process.js';

const temps: string[] = [];
const engines: PipelineEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}, 60_000);

const setup = (options: Omit<PipelineSetupOptions, 'temps' | 'engines'>): PipelineHarness =>
  setupPipeline({ ...options, temps, engines });

/** 판정한 규칙의 케이스 2개를 모두 통과로. */
const allPass = (call: JudgeCall): Record<string, readonly TestCaseStatus[]> =>
  Object.fromEntries((call.input.ruleIds ?? []).map((id) => [id, ['passed', 'passed'] as const]));

/** 단계별 판정 계획 (`plan(종류, 그 종류의 몇 번째 판정)`이 `undefined`면 모두 통과). */
const byStep =
  (plan: (kind: StepKind, index: number, call: JudgeCall) => JudgeDecision | undefined) =>
  (): ((call: JudgeCall) => JudgeDecision) => {
    const counts = new Map<StepKind, number>();
    return (call) => {
      const index = counts.get(call.kind) ?? 0;
      counts.set(call.kind, index + 1);
      return plan(call.kind, index, call) ?? allPass(call);
    };
  };

const mergeCount = (h: PipelineHarness): number =>
  Number(userGit(h.repo, 'rev-list', '--merges', '--count', 'main'));
const mainTip = (h: PipelineHarness): string => userGit(h.repo, 'rev-parse', 'refs/heads/main');

/** 기존 인수 테스트 파일 (유형 D의 기준 검사 · 구현 · 검사가 판정하는 기존 검사). */
const existingAcceptance =
  (...ruleIds: string[]) =>
  (repo: string): void => {
    for (const id of ruleIds) {
      fs.mkdirSync(path.join(repo, 'bive-acceptance', id), { recursive: true });
      fs.writeFileSync(
        path.join(repo, 'bive-acceptance', id, 'health.acc.ts'),
        `import { it } from 'vitest';\nit('${id} 기존 동작', () => undefined);\n`,
      );
    }
  };

const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bive-run-types-'));
  temps.push(dir);
  return dir;
};

/** happy-path의 테스트 작성 세션이 먼저 프로젝트 소스를 쓰려다(경로 가드가 거부) 인수 테스트를 쓰는 시나리오. */
const sourceWritingScenario = (): { scenario: string; scenariosDir: string } => {
  const scenario = structuredClone(loadScenario('happy-path'));
  scenario.name = 'c-source-write';
  const session = scenario.roles['test-writer']?.sessions[0];
  if (session === undefined) throw new Error('테스트 작성 세션 없음');
  session.turns = [
    { tool: 'write_file', args: { path: ROUTE, content: 'export const hacked = true;\n' } },
    { tool: 'write_file', args: { path: '../../../escape.ts', content: 'x\n' } },
    ...session.turns,
  ];
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'c-source-write.yaml'), stringify(scenario));
  return { scenario: 'c-source-write', scenariosDir: dir };
};

/** 실행이 바꾼 경로 (기준 커밋 → 병합 커밋, 사람 쪽 git). */
const mergedPaths = (h: PipelineHarness, base: string, merge: string): string[] =>
  userGit(h.repo, 'diff', '--name-only', base, merge).split('\n').filter(Boolean).sort();

describe('유형 C: Green 확인 (새 테스트 전부 통과, 수용 기준 2)', () => {
  it('새 테스트가 전부 통과하면 Green 확인을 지나 검사 · 병합으로 가고, 병합된 변경은 인수 테스트 파일뿐이다', async () => {
    const h = setup({ runType: 'C', decide: allPass });
    const base = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ type: 'C', status: 'merged' });
    expect(attempts(done)).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'green_check#1:passed',
      'implementation#1:skipped',
      'check#1:passed',
      'mutation#1:skipped',
      'merge#1:passed',
      'screen_update#1:passed',
    ]);
    const testCommit = String(stepOf(done, 'test_writing').commit);
    // 판정: Green 확인(대상 규칙의 새 테스트만, 테스트 작성 커밋) → 검사(효력 있는 규칙 전부, 같은 커밋)
    expect(h.judgeCalls.map((call) => [call.kind, call.head, call.input.ruleIds])).toEqual([
      ['green_check', testCommit, ['RULE-001']],
      ['check', testCommit, ['RULE-001']],
    ]);
    const green = exitOf(done, 'green_check');
    expect(green).toMatchObject({ commit: testCommit, cases: 2, ruleIds: ['RULE-001'] });
    expect(Object.keys(green.acceptanceHashes as object)).toContain(
      'bive-acceptance/RULE-001/health-time.acc.ts',
    );
    // Green 확인은 판정 기록을 남기지 않는다 (검사 단계의 기록만)
    expect(judgmentsOf(h).map((judgment) => judgment.stepId)).toEqual([stepOf(done, 'check').id]);
    expect(h.sessions.map((spec) => spec.role)).toEqual(['test-writer']);
    // 작성 조건은 Green이다 (Red 문장이 아니다)
    expect(h.sessions[0]?.systemPrompt).toContain(GREEN_CONDITION);
    expect(h.sessions[0]?.systemPrompt).not.toBe(TEST_WRITER_SYSTEM_PROMPT);
    const changed = mergedPaths(h, base, String(done.run.mergeCommit));
    expect(changed).toContain('bive-acceptance/RULE-001/health-time.acc.ts');
    expect(changed.every((file) => file.startsWith('bive-acceptance/'))).toBe(true);
    expect(userGit(h.repo, 'show', `main:${ROUTE}`)).not.toContain('toISOString()');
  }, 60_000);

  it('새 테스트가 하나라도 통과하지 않으면 테스트 작성이 끝나지 않는다: 테스트 작성으로 돌아가 새 세션이 사유를 받고(시도 2), 통과하면 진행한다', async () => {
    const h = setup({
      runType: 'C',
      decide: byStep((kind, index) =>
        kind === 'green_check' && index === 0 ? { 'RULE-001': ['passed', 'failed'] } : undefined,
      )(),
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'merged', regressionCount: 0 });
    expect([...attempts(done, 'test_writing', 'green_check')]).toEqual([
      'test_writing#1:passed',
      'test_writing#2:passed',
      'green_check#1:failed',
      'green_check#2:passed',
    ]);
    expect(exitOf(done, 'green_check', 1)).toMatchObject({
      reason: 'not_green',
      failingCases: [expect.objectContaining({ status: 'failed' })],
    });
    const second = h.sessions.filter((spec) => spec.role === 'test-writer')[1];
    expect(second?.prompt).toContain(
      'Green 확인: 지금 코드에서 통과하지 않은 케이스가 있다 (모든 케이스가 통과해야 한다)',
    );
    // 케이스 이름은 판정한 커밋의 인수 테스트 파일과 대조한 것만 싣는다 (Red 확인과 같은 기준)
    expect(second?.prompt).toContain('알 수 없는 케이스 1건');
    expect(second?.prompt).not.toContain('RULE-001 > 케이스 2');
  }, 60_000);

  it('계속 통과하지 않으면 재시도 2회 뒤 failed (test_retry_limit), 검사 · 병합 없음', async () => {
    const h = setup({
      runType: 'C',
      decide: () => ({ 'RULE-001': ['failed', 'passed'] }),
    });
    const before = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'failed', failureReason: 'test_retry_limit' });
    expect(attempts(done, 'green_check')).toEqual([
      'green_check#1:failed',
      'green_check#2:failed',
      'green_check#3:failed',
    ]);
    expect(h.judgeCalls.map((call) => call.kind)).toEqual([
      'green_check',
      'green_check',
      'green_check',
    ]);
    expect(mainTip(h)).toBe(before);
  }, 60_000);

  it.each([
    ['케이스 0개', {} as JudgeDecision],
    ['수집 오류', 'collect_error' as JudgeDecision],
  ])(
    '%s는 통과가 아니다: Green 확인 미충족(green_collect_error)으로 테스트 작성에 돌아간다',
    async (_name, decision) => {
      const h = setup({ runType: 'C', decide: () => decision });
      const done = await runToEnd(h);
      expect(done.run).toMatchObject({ status: 'failed', failureReason: 'test_retry_limit' });
      expect(exitOf(done, 'green_check', 1)).toMatchObject({ reason: 'green_collect_error' });
      const second = h.sessions.filter((spec) => spec.role === 'test-writer')[1];
      expect(second?.prompt).toContain('Green 확인: 테스트 파일을 불러오거나 수집하지 못했다');
      if (typeof decision !== 'string') {
        expect(exitOf(done, 'green_check', 1)).toMatchObject({
          problems: [{ file: 'bive-acceptance/RULE-001', message: '케이스 0개' }],
        });
        expect(second?.prompt).toContain('bive-acceptance/RULE-001 케이스 0개');
      }
    },
    60_000,
  );

  it('판정 러너 오류는 테스트를 다시 써도 고칠 수 없어 failed (judge_runner_error)', async () => {
    const h = setup({ runType: 'C', decide: () => 'runner_error' });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'failed', failureReason: 'judge_runner_error' });
    expect(attempts(done, 'test_writing')).toEqual(['test_writing#1:passed']);
  }, 60_000);
});

describe('유형 C: 소스 파일 쓰기 거부 (수용 기준 2, C-18)', () => {
  it('테스트 작성 세션이 소스 파일을 쓰려 하면 경로 가드가 거부하고(기록), 병합된 변경은 인수 테스트 파일뿐이다', async () => {
    const h = setup({ runType: 'C', decide: allPass, ...sourceWritingScenario() });
    const base = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    const writes = toolCallsOf(h).filter((call) => call.name === 'write_file');
    expect(writes.map((call) => call.status)).toEqual(['denied', 'denied', 'ok']);
    const changed = mergedPaths(h, base, String(done.run.mergeCommit));
    expect(changed).not.toContain(ROUTE);
    expect(changed.every((file) => file.startsWith('bive-acceptance/'))).toBe(true);
    expect(userGit(h.repo, 'show', `main:${ROUTE}`)).not.toContain('hacked');
  }, 60_000);

  it('가드를 지나친 변경(테스트 작성 커밋에 소스 파일)이 있으면 Green 확인이 판정하지 않고 failed (guard_violation), 병합 없음', async () => {
    const h = setup({
      runType: 'C',
      decide: allPass,
      executors: (defaults) => ({
        ...defaults,
        test_writing: async (context) => {
          const outcome = await defaults.test_writing(context);
          fs.writeFileSync(path.join(context.git.worktreePath, ROUTE), '// 소스 변경\n');
          return outcome;
        },
      }),
    });
    const before = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'guard_violation',
      currentStep: 'green_check',
      mergeCommit: null,
    });
    expect(stepOf(done, 'green_check').exitDetail).toMatchObject({
      reason: 'guard_violation',
      detail: { stage: 'test_only', changed: [ROUTE] },
    });
    expect(h.judgeCalls).toEqual([]);
    expect(mainTip(h)).toBe(before);
    expect(mergeCount(h)).toBe(0);
  }, 60_000);

  it('Green 확인을 거치지 않은 소스 변경도 병합 직전에 다시 보아 병합하지 않는다 (failed guard_violation, 닫힌 쪽)', async () => {
    // Green 확인을 대역으로 바꿔(소스 대조 없이 해시만 기록) 검사까지 통과시킨다: 병합 실행기의 대조만 남는다
    const bypass: StepExecutor = (context) =>
      Promise.resolve({
        status: 'passed',
        exitDetail: { acceptanceHashes: hashAcceptanceFiles(context.git.worktreePath) },
      });
    const h = setup({
      runType: 'C',
      decide: allPass,
      executors: (defaults) => ({
        ...defaults,
        green_check: bypass,
        test_writing: async (context) => {
          const outcome = await defaults.test_writing(context);
          fs.writeFileSync(path.join(context.git.worktreePath, ROUTE), '// 소스 변경\n');
          return outcome;
        },
      }),
    });
    const before = mainTip(h);
    const done = await runToEnd(h);
    expect(attempts(done, 'check')).toEqual(['check#1:passed']);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'guard_violation',
      currentStep: 'merge',
      mergeCommit: null,
    });
    expect(stepOf(done, 'merge').exitDetail).toMatchObject({
      detail: { stage: 'test_only', changed: [ROUTE] },
    });
    expect(mainTip(h)).toBe(before);
  }, 60_000);
});

describe('유형 D: 시작 전 기준 검사와 검사 단계의 기존 검사 전부 통과 (수용 기준 3)', () => {
  /** 판단 세션 배선 대역: 부른 요청을 남기고 열지 않는다 */
  const launcher =
    (requests: NormJudgeRequest[]): (() => NormJudgeLauncher) =>
    () =>
    (request) => {
      requests.push(request);
      return Promise.resolve({ status: 'not_opened', reason: 'not_configured', detail: '시험' });
    };

  it('기준 커밋의 기존 검사가 전부 통과하면 구현 → 검사(기존 검사 전부) → 병합으로 간다', async () => {
    const h = setup({
      runType: 'D',
      secondRule: true,
      prepareRepo: existingAcceptance('RULE-001', 'RULE-002'),
      decide: allPass,
    });
    const base = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ type: 'D', status: 'merged', baseCommit: base });
    expect(attempts(done)).toEqual([
      'approval#1:passed',
      'test_writing#1:skipped',
      'red_check#1:skipped',
      'green_check#1:passed',
      'implementation#1:passed',
      'check#1:passed',
      'merge#1:passed',
      'screen_update#1:passed',
    ]);
    const implCommit = String(stepOf(done, 'implementation').commit);
    // 기준 검사는 기준 커밋에서 효력 있는 규칙 전부, 구현은 대상 규칙, 검사는 다시 전부
    expect(h.judgeCalls.map((call) => [call.kind, call.head, call.input.ruleIds])).toEqual([
      ['green_check', base, ['RULE-001', 'RULE-002']],
      ['implementation', implCommit, ['RULE-001']],
      ['check', implCommit, ['RULE-001', 'RULE-002']],
    ]);
    expect(exitOf(done, 'green_check')).toMatchObject({
      baseline: true,
      commit: base,
      judgments: [
        { ruleId: 'RULE-001', status: 'pass' },
        { ruleId: 'RULE-002', status: 'pass' },
      ],
    });
    // 기준 검사는 판정 기록을 남기지 않는다
    expect(judgmentsOf(h).some((judgment) => judgment.commit === base)).toBe(false);
    const prompt = h.sessions.find((spec) => spec.role === 'implementer')?.prompt ?? '';
    expect(prompt).toContain('리팩터링 · 되돌리기 실행이다.');
    expect(prompt).toContain('- bive-acceptance/RULE-001/health.acc.ts');
  }, 60_000);

  it('기준 커밋에서 기존 검사가 하나라도 실패하면 시작을 거부한다: 구현 세션 0 · 커밋 0 · 병합 0 (failed step_unmet)', async () => {
    const h = setup({
      runType: 'D',
      secondRule: true,
      prepareRepo: existingAcceptance('RULE-001', 'RULE-002'),
      decide: (call) => ({ ...allPass(call), 'RULE-002': ['passed', 'failed'] }),
    });
    const before = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'step_unmet',
      currentStep: 'green_check',
      headCommit: null,
      mergeCommit: null,
    });
    expect(stepOf(done, 'green_check').exitDetail).toMatchObject({
      reason: 'step_unmet',
      detail: {
        reason: 'not_green',
        judgments: [
          { ruleId: 'RULE-001', status: 'pass' },
          { ruleId: 'RULE-002', status: 'fail' },
        ],
      },
    });
    expect(attempts(done, 'implementation')).toEqual(['implementation#1:pending']);
    expect(h.sessions).toEqual([]);
    expect(h.judgeCalls.map((call) => call.kind)).toEqual(['green_check']);
    expect(judgmentsOf(h)).toEqual([]);
    expect(mainTip(h)).toBe(before);
    expect(userGit(h.repo, 'rev-parse', `refs/heads/${String(done.run.branch)}`)).toBe(before);
    expect(mergeCount(h)).toBe(0);
  }, 60_000);

  it.each([
    ['수집 오류', 'collect_error' as JudgeDecision, 'collect_error'],
    ['대상 규칙의 기존 검사 없음', 'no_target' as const, 'missing_targets'],
  ])(
    '기준 검사의 %s도 Green이 아니다 (시작 거부)',
    async (_name, decision, reason) => {
      const h = setup({
        runType: 'D',
        secondRule: true,
        prepareRepo: existingAcceptance(
          ...(decision === 'no_target' ? ['RULE-002'] : ['RULE-001']),
        ),
        decide: decision === 'no_target' ? allPass : () => decision,
      });
      const done = await runToEnd(h);
      expect(done.run).toMatchObject({ status: 'failed', failureReason: 'step_unmet' });
      expect(stepOf(done, 'green_check').exitDetail).toMatchObject({ detail: { reason } });
      expect(h.sessions).toEqual([]);
    },
    60_000,
  );

  it('판정 없음(실행기 없는 계약 종류)은 통과로 세지 않지만 막지도 않는다: 나머지가 통과하면 진행한다', async () => {
    const h = setup({
      runType: 'D',
      prepareRepo: existingAcceptance('RULE-001'),
      decide: allPass,
    });
    const source = await readContractSource(h.repo, 'main', 'prisma/schema.prisma');
    if (!source.ok) throw new Error(source.code);
    const { rule } = withProject(h.biveHome, h.project.id, (store) =>
      registerHumanContract(store, {
        file: 'prisma/schema.prisma',
        kind: 'db-schema',
        source,
        requirementId: null,
        at: new Date().toISOString(),
        newId,
        by: human,
        clientId: null,
      }),
    );
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    expect(exitOf(done, 'green_check')).toMatchObject({
      contracts: [{ ruleId: rule.displayId, outcome: 'unjudged', reason: 'no_runner' }],
      judgments: [{ ruleId: 'RULE-001', status: 'pass' }],
    });
  }, 60_000);

  it('검사 단계에서 대상이 아닌 기존 규칙이 깨지면(Green → Green 위반) 판단 세션 없이 구현으로 회귀하고 상한 뒤 failed (regression_limit)', async () => {
    const requests: NormJudgeRequest[] = [];
    const h = setup({
      runType: 'D',
      secondRule: true,
      prepareRepo: existingAcceptance('RULE-001', 'RULE-002'),
      decide: byStep((kind, _index, call) =>
        kind === 'check' ? { ...allPass(call), 'RULE-002': ['failed', 'passed'] } : undefined,
      )(),
      judgeNorms: launcher(requests),
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'regression_limit',
      regressionCount: 2,
    });
    expect(attempts(done, 'implementation', 'check')).toEqual([
      'implementation#1:passed',
      'implementation#2:passed',
      'implementation#3:passed',
      'check#1:failed',
      'check#2:failed',
      'check#3:failed',
    ]);
    expect(exitOf(done, 'check', 1)).toMatchObject({
      reason: 'check_failed',
      judgments: [
        { ruleId: 'RULE-001', status: 'pass' },
        { ruleId: 'RULE-002', status: 'fail' },
      ],
    });
    expect(exitOf(done, 'check', 1)).not.toHaveProperty('existingRuleJudgment');
    expect(requests).toEqual([]);
    expect(attempts(done, 'green_check')).toEqual(['green_check#1:passed']);
    expect(mergeCount(h)).toBe(0);
  }, 90_000);

  it('구현 커밋이 기존 인수 테스트를 바꾸면 기준 검사 때의 해시와 달라 failed (guard_violation)', async () => {
    const h = setup({
      runType: 'D',
      prepareRepo: existingAcceptance('RULE-001'),
      decide: allPass,
      executors: (defaults) => ({
        ...defaults,
        implementation: async (context) => {
          // 경로 가드를 지나친 변경을 흉내 낸다 (구현 세션은 bive-acceptance/를 쓸 수 없다)
          fs.appendFileSync(
            path.join(context.git.worktreePath, 'bive-acceptance', 'RULE-001', 'health.acc.ts'),
            "it('바꿈', () => undefined);\n",
          );
          return defaults.implementation(context);
        },
      }),
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'failed', failureReason: 'guard_violation' });
    expect(stepOf(done, 'implementation').exitDetail).toMatchObject({
      detail: {
        stage: 'acceptance_hash',
        message: 'Green 확인 뒤 인수 테스트가 바뀌었습니다',
        changed: ['bive-acceptance/RULE-001/health.acc.ts'],
      },
    });
    expect(mergeCount(h)).toBe(0);
  }, 60_000);
});
