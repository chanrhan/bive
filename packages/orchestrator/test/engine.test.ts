// 파이프라인 엔진 (M1-14 수용 기준, RUN-01 · RUN-02 · RUN-08 · PRD 5.1 · ADR-011 · ADR-026 · ADR-027 · ADR-066).
// 픽스처 git 복사본 · 실제 git(워크트리 · 커밋 · 병합) · 실제 SQLite · ScriptedAdapter(실제 고정 도구 · 세션 가드).
// 단계 종료 조건은 시험용 실행기(파일 내용 대역)로 정하고 판정 러너는 돌리지 않는다(#28 · #29가 실제 실행기를 넣는다).
// 재기동 시험은 오케스트레이터 프로세스를 실제로 SIGKILL 하고 다시 띄운다.
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import {
  type AgentRole,
  ErrorCode,
  RUN_STATUS_TRANSITIONS,
  RUN_STEP_PLANS,
  type RunStatus,
  type SettingsPatch,
  type Step,
  type StepKind,
} from '@bive/shared';
import type { RunDetail } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentAdapter, SessionEvent } from '../src/agent/adapter.js';
import { loadScenario } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import { INTERRUPTED_EXIT_DETAIL, PipelineEngine } from '../src/engine/pipeline-engine.js';
import type { StepExecutors } from '../src/engine/types.js';
import { runPaths } from '../src/run-paths.js';
import { createRun } from '../src/runs/run-service.js';
import { connect, RpcCallError, type TestClient } from './helpers/client.js';
import {
  COMPLETE_SETTINGS,
  copyFixture,
  human,
  newId,
  ROUTE,
  scripted,
  seedProject,
  type SeededProject,
  TEST_SCENARIOS_DIR,
  testExecutors,
  userGit,
  withProject,
} from './helpers/engine-harness.js';
import {
  cleanup,
  makeBiveHome,
  sleep,
  spawnScript,
  type Spawned,
  waitFor,
} from './helpers/process.js';

const temps: string[] = [];
const engines: PipelineEngine[] = [];

/** 시험 전체에서 관찰한 실행 상태 전이 (마지막 시험이 상태 기계의 모든 전이를 거쳤는지 본다). */
const observed = new Set<string>();
const lastStatus = new Map<string, RunStatus>();
const observe = (detail: RunDetail): void => {
  const previous = lastStatus.get(detail.run.id) ?? 'waiting_approval';
  if (previous !== detail.run.status) observed.add(`${previous}→${detail.run.status}`);
  lastStatus.set(detail.run.id, detail.run.status);
};

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Harness extends SeededProject {
  biveHome: string;
  repo: string;
  runId: string;
  engine: PipelineEngine;
  adapter: AgentAdapter;
  executors: StepExecutors;
  /** 저장마다의 (상태, 현재 단계) */
  saves: string[];
  newEngine(): PipelineEngine;
}

interface SetupOptions {
  scenario?: string;
  scenariosDir?: string;
  executors?: StepExecutors;
  settings?: SettingsPatch;
  wrap?: (adapter: AgentAdapter) => AgentAdapter;
  normState?: 'approved' | 'provisional';
}

const setup = (options: SetupOptions = {}): Harness => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const seeded = seedProject(biveHome, repo, options.settings, options.normState);
  const scripted = new ScriptedAdapter({
    scenario: loadScenario(options.scenario ?? 'happy-path', options.scenariosDir),
    biveHome,
    pollIntervalMs: 20,
  });
  const adapter = options.wrap?.(scripted) ?? scripted;
  const executors = testExecutors(options.executors);
  const saves: string[] = [];
  const newEngine = (): PipelineEngine => {
    const engine = new PipelineEngine({
      biveHome,
      agent: adapter,
      executors,
      onEvent: (event) => {
        if (event.type !== 'run.saved') return;
        observe(event.detail);
        saves.push(`${event.detail.run.status}:${String(event.detail.run.currentStep)}`);
      },
    });
    engines.push(engine);
    return engine;
  };
  const runId = withProject(biveHome, seeded.project.id, (store) =>
    createRun(
      store,
      { ruleIds: [seeded.rule.id], author: human },
      { clientId: null },
      {
        now: Date.now,
        newId,
      },
    ),
  ).run.id;
  return {
    ...seeded,
    biveHome,
    repo,
    runId,
    engine: newEngine(),
    adapter,
    executors,
    saves,
    newEngine,
  };
};

const detailOf = (h: Harness): RunDetail =>
  withProject(h.biveHome, h.project.id, (store) => {
    const detail = store.runs.getDetail(h.runId);
    if (detail === null) throw new Error('실행 없음');
    return detail;
  });

const sessionsOf = (h: Harness, role?: AgentRole) =>
  withProject(h.biveHome, h.project.id, (store) =>
    store.sessions.listByRun(h.runId).filter((s) => role === undefined || s.role === role),
  );

const attempts = (detail: RunDetail, kind?: StepKind): string[] =>
  detail.steps
    .filter((step) => kind === undefined || step.kind === kind)
    .map((step) => `${step.kind}#${String(step.attempt)}:${step.status}`);

const stepOf = (detail: RunDetail, kind: StepKind, attempt = 1): Step => {
  const step = detail.steps.find((s) => s.kind === kind && s.attempt === attempt);
  if (step === undefined) throw new Error(`단계 없음: ${kind}#${String(attempt)}`);
  return step;
};

/** 승인 단계를 판정하고 구동이 끝날 때까지 기다린다. */
const runToEnd = async (h: Harness): Promise<RunDetail> => {
  expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
  await h.engine.settled();
  return detailOf(h);
};

const mainTip = (h: Harness): string => userGit(h.repo, 'rev-parse', 'refs/heads/main');
const isLocked = (h: Harness, worktree: string): boolean =>
  userGit(h.repo, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .some(
      (entry) =>
        entry.includes(`worktree ${fs.realpathSync(worktree)}`) && entry.includes('\nlocked'),
    );

describe('유형 A 단계 순서 · 전이 (수용 기준 1)', () => {
  it('승인 → 테스트 작성 → Red 확인 → 구현 → 검사 → 변이 주입(skipped) → 병합 → 화면 갱신 → merged', async () => {
    const h = setup();
    const initialMain = mainTip(h);
    const notified: string[] = [];
    const engine = new PipelineEngine({
      biveHome: h.biveHome,
      agent: h.adapter,
      executors: h.executors,
      onEvent: (event) => {
        if (event.type === 'notify') notified.push(event.topic);
        if (event.type !== 'run.saved') return;
        observe(event.detail);
        h.saves.push(`${event.detail.run.status}:${String(event.detail.run.currentStep)}`);
      },
    });
    engines.push(engine);
    h.engine = engine;

    const done = await runToEnd(h);

    // 단계는 RUN_STEP_PLANS.A 순서, 시도 1회씩, 변이 주입만 skipped
    expect(done.steps.map((s) => s.kind)).toEqual([...RUN_STEP_PLANS.A]);
    expect(attempts(done)).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'red_check#1:passed',
      'implementation#1:passed',
      'check#1:passed',
      'mutation#1:skipped',
      'merge#1:passed',
      'screen_update#1:passed',
    ]);
    // 단계 종료마다 1회 저장: (상태, 현재 단계)가 단계 순서대로 바뀐다 (워크트리 생성 정보 저장 1회 포함)
    expect(h.saves).toEqual([
      'running:test_writing',
      'running:test_writing',
      'running:red_check',
      'running:implementation',
      'running:check',
      'running:mutation',
      'running:merge',
      'running:screen_update',
      'merged:null',
    ]);
    expect(notified).toEqual(['screen_update']);

    const { run } = done;
    expect(run).toMatchObject({
      status: 'merged',
      currentStep: null,
      lastCompletedStep: 'screen_update',
      regressionCount: 0,
      failureReason: null,
      branch: 'bive/run-EXE-001',
      baseCommit: initialMain,
    });
    expect(run.endedAt).not.toBeNull();
    // 커밋은 테스트 작성 · 구현 종료 때 오케스트레이터가 만든다 (RUN-08)
    const testCommit = stepOf(done, 'test_writing').commit;
    const implCommit = stepOf(done, 'implementation').commit;
    expect(testCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(implCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(run.headCommit).toBe(implCommit);
    expect(userGit(h.repo, 'rev-parse', `${String(implCommit)}^`)).toBe(testCommit);
    expect(userGit(h.repo, 'log', '-1', '--format=%an <%ae>', String(implCommit))).toBe(
      'BIVE <bive@bive.invalid>',
    );
    for (const kind of ['approval', 'red_check', 'check', 'mutation', 'merge'] as const) {
      expect(stepOf(done, kind).commit).toBeNull();
    }
    // 병합: 기준 브랜치가 병합 커밋을 가리키고 실행 커밋이 들어 있다
    expect(run.mergeCommit).toBe(mainTip(h));
    expect(
      userGit(h.repo, 'rev-list', '--parents', '-n', '1', String(run.mergeCommit)).split(' '),
    ).toEqual([String(run.mergeCommit), initialMain, String(implCommit)]);
    expect(userGit(h.repo, 'show', `main:${ROUTE}`)).toContain('toISOString()');
    expect(stepOf(done, 'mutation').exitDetail).toEqual({ reason: 'not_in_scope', scope: 'P1' });

    // 세션 · 도구 호출 · 도구 목록 기록 (세션당 init 1회, 도구 호출은 거부 포함 전부)
    const sessions = sessionsOf(h);
    expect(sessions.map((s) => [s.role, s.endReason, s.totalCostUsd, s.numTurns])).toEqual([
      ['test-writer', 'success', 0.0421, 2],
      ['implementer', 'success', 0.0587, 3],
    ]);
    expect(sessions.map((s) => s.stepId)).toEqual([
      stepOf(done, 'test_writing').id,
      stepOf(done, 'implementation').id,
    ]);
    expect(run.toolManifest).toEqual([
      { role: 'test-writer', tools: expect.any(Array), mcpServerCount: 1 },
      { role: 'implementer', tools: expect.any(Array), mcpServerCount: 1 },
    ]);
    const calls = withProject(h.biveHome, h.project.id, (store) =>
      store.sessions.toolCalls(h.runId),
    );
    expect(calls.map((c) => [c.role, c.name, c.status])).toEqual([
      ['test-writer', 'write_file', 'ok'],
      ['implementer', 'read_file', 'ok'],
      ['implementer', 'write_file', 'ok'],
    ]);
  }, 60_000);

  it('승인 단계: 대상 규칙이 승인 상태가 아니면 다음으로 가지 않고 아무것도 저장하지 않는다', async () => {
    const h = setup({ normState: 'provisional' });
    const before = detailOf(h);
    expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(false);
    await h.engine.settled();
    expect(detailOf(h)).toEqual(before);
    expect(before.run).toMatchObject({ status: 'waiting_approval', currentStep: 'approval' });
    expect(h.saves).toEqual([]);
    expect(userGit(h.repo, 'branch', '--list', 'bive/run-*')).toBe('');
  });

  it('승인 기록 run_start가 없는 실행은 진행하지 않고 failed (run_without_log, NFR-01)', async () => {
    const h = setup();
    // 승인 기록을 남기지 않은 실행을 저장소에 바로 만든다 (파이프 밖 경로의 흉내)
    const forged = withProject(h.biveHome, h.project.id, (store) => {
      const plan = RUN_STEP_PLANS.A;
      return store.runs.create({
        id: newId(),
        type: 'A',
        targetRuleIds: [h.rule.id],
        currentStep: 'approval',
        baseBranch: 'main',
        budgetSnapshot: {
          run: { maxBudgetUsd: 5, maxTurns: 200 },
          roles: {
            'test-writer': { maxBudgetUsd: 2, maxTurns: 100 },
            implementer: { maxBudgetUsd: 2, maxTurns: 100 },
          },
        },
        modelSnapshot: { 'test-writer': 'test-model', implementer: 'test-model' },
        startedBy: human,
        createdAt: new Date().toISOString(),
        steps: plan.map((kind, index) => ({
          id: newId(),
          kind,
          attempt: 1,
          status: index === 0 ? ('running' as const) : ('pending' as const),
          role:
            kind === 'test_writing'
              ? 'test-writer'
              : kind === 'implementation'
                ? 'implementer'
                : null,
          startedAt: index === 0 ? new Date().toISOString() : null,
        })),
      });
    });
    h.runId = forged.run.id;
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'run_without_log',
      branch: null,
    });
    expect(stepOf(done, 'test_writing')).toMatchObject({
      status: 'failed',
      exitDetail: { reason: 'run_without_log' },
    });
    expect(sessionsOf(h)).toEqual([]);
  });
});

describe('종료 조건 미충족 · 회귀 (수용 기준 2)', () => {
  it('테스트 작성 미충족은 다음 단계로 가지 않고 새 시도 · 새 세션으로 다시 한다', async () => {
    let calls = 0;
    const h = setup({
      executors: {
        test_writing: async (context) => {
          calls += 1;
          await context.runSession({
            workDir: context.git.worktreePath,
            systemPrompt: '시험',
            prompt: '시험',
            vars: { ruleId: 'RULE-001' },
          });
          return calls === 1 ? { status: 'unmet', exitDetail: { files: 0 } } : { status: 'passed' };
        },
      },
    });
    const done = await runToEnd(h);
    expect(attempts(done, 'test_writing')).toEqual([
      'test_writing#1:failed',
      'test_writing#2:passed',
    ]);
    expect(stepOf(done, 'test_writing')).toMatchObject({ exitDetail: { files: 0 }, commit: null });
    expect(attempts(done, 'red_check')).toEqual(['red_check#1:passed']);
    expect(h.saves.slice(0, 3)).toEqual([
      'running:test_writing',
      'running:test_writing',
      'running:test_writing',
    ]);
    expect(done.run).toMatchObject({ status: 'merged', regressionCount: 0 });
    expect(sessionsOf(h, 'test-writer')).toHaveLength(2);
  }, 60_000);

  it('Red 확인 미충족은 테스트 작성으로 회귀하고, 재시도 2회를 넘으면 failed (test_retry_limit)', async () => {
    const h = setup({ executors: { red_check: scripted(['unmet']) } });
    const before = mainTip(h);
    const done = await runToEnd(h);
    expect(attempts(done, 'test_writing')).toEqual([
      'test_writing#1:passed',
      'test_writing#2:passed',
      'test_writing#3:passed',
    ]);
    expect(attempts(done, 'red_check')).toEqual([
      'red_check#1:failed',
      'red_check#2:failed',
      'red_check#3:failed',
    ]);
    expect(attempts(done, 'implementation')).toEqual(['implementation#1:pending']);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'test_retry_limit',
      currentStep: 'red_check',
      regressionCount: 0,
    });
    expect(sessionsOf(h, 'test-writer')).toHaveLength(3);
    expect(sessionsOf(h, 'implementer')).toHaveLength(0);
    expect(mainTip(h)).toBe(before);
    expect(isLocked(h, String(done.run.worktreePath))).toBe(true);
  }, 60_000);

  it('검사 실패는 구현으로 회귀하고 회귀 2회를 넘으면 failed, 브랜치 보존 · 병합 없음 (fail-check)', async () => {
    const h = setup({ scenario: 'fail-check' });
    const before = mainTip(h);
    const done = await runToEnd(h);
    expect(attempts(done, 'implementation')).toEqual([
      'implementation#1:passed',
      'implementation#2:passed',
      'implementation#3:passed',
    ]);
    expect(attempts(done, 'check')).toEqual(['check#1:failed', 'check#2:failed', 'check#3:failed']);
    expect(attempts(done, 'mutation')).toEqual(['mutation#1:pending']);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'regression_limit',
      regressionCount: 2,
      currentStep: 'check',
      mergeCommit: null,
    });
    expect(stepOf(done, 'check', 3).exitDetail).toMatchObject({ reason: 'regression_limit' });
    // 회귀 수는 저장마다 1씩: 0 → 1 → 2, 그 뒤 실패
    expect(h.saves.filter((s) => s === 'running:implementation')).toHaveLength(3);
    expect(sessionsOf(h, 'implementer')).toHaveLength(3);
    expect(mainTip(h)).toBe(before);
    expect(userGit(h.repo, 'branch', '--list', 'bive/run-EXE-001')).toContain('bive/run-EXE-001');
    expect(isLocked(h, String(done.run.worktreePath))).toBe(true);
  }, 60_000);

  it('규칙이 없는 단계의 미충족 · 실행기 없음 · 예외는 failed (step_unmet · step_executor_missing · step_error)', async () => {
    const unmet = setup({ executors: { merge: scripted(['unmet']) } });
    expect((await runToEnd(unmet)).run).toMatchObject({
      status: 'failed',
      failureReason: 'step_unmet',
      currentStep: 'merge',
    });

    const missing = setup({ executors: { red_check: undefined } });
    expect((await runToEnd(missing)).run).toMatchObject({
      status: 'failed',
      failureReason: 'step_executor_missing',
      currentStep: 'red_check',
    });

    const thrown = setup({ executors: { check: () => Promise.reject(new Error('검사 폭발')) } });
    const done = await runToEnd(thrown);
    expect(done.run).toMatchObject({ status: 'failed', failureReason: 'step_error' });
    expect(stepOf(done, 'check').exitDetail).toEqual({
      reason: 'step_error',
      detail: { message: '검사 폭발' },
    });
  }, 90_000);
});

describe('세션 실행 틀: 가드 · 예산 · 시작 실패', () => {
  it('세션 가드 위반(추가 MCP 서버)은 실행 failed (guard_violation), 도구 목록은 기록된다', async () => {
    const h = setup({
      wrap: (inner) => ({
        kind: inner.kind,
        startSession: (spec) =>
          (async function* (): AsyncGenerator<SessionEvent> {
            for await (const event of inner.startSession(spec)) {
              yield event.type === 'init'
                ? { ...event, mcpServers: [...event.mcpServers, 'evil'] }
                : event;
            }
          })(),
      }),
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'guard_violation',
      currentStep: 'test_writing',
    });
    expect(done.run.toolManifest).toEqual([
      { role: 'test-writer', tools: expect.any(Array), mcpServerCount: 2 },
    ]);
    expect(sessionsOf(h).map((s) => s.endReason)).toEqual(['guard_violation']);
    expect(
      withProject(h.biveHome, h.project.id, (store) => store.sessions.toolCalls(h.runId)),
    ).toEqual([]);
  }, 60_000);

  it('CLI 시작 실패(init 없이 결과)는 가드 위반이 아니라 오류 결과 → 미충족 재시도', async () => {
    const h = setup({
      wrap: (inner) => ({
        kind: inner.kind,
        startSession: () =>
          (async function* (): AsyncGenerator<SessionEvent> {
            yield {
              type: 'result',
              subtype: 'error_during_execution',
              total_cost_usd: 0,
              num_turns: 0,
              modelUsage: {},
            };
          })(),
      }),
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'failed', failureReason: 'test_retry_limit' });
    expect(sessionsOf(h).map((s) => s.endReason)).toEqual([
      'error_during_execution',
      'error_during_execution',
      'error_during_execution',
    ]);
  }, 60_000);

  it('남은 예산이 0이면 세션을 열지 않고 budget_exceeded (budget_exhausted)', async () => {
    const h = setup({
      settings: { ...COMPLETE_SETTINGS, run: { maxBudgetUsd: 0.0421, maxTurns: 200 } },
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'budget_exceeded',
      failureReason: 'budget_exhausted',
      currentStep: 'implementation',
      mergeCommit: null,
    });
    expect(sessionsOf(h, 'implementer')).toEqual([]);
    expect(isLocked(h, String(done.run.worktreePath))).toBe(true);
  }, 60_000);

  it('세션 결과가 예산 한도 subtype이면 budget_exceeded, 세션 한도는 min(역할 잔여, 실행 잔여)', async () => {
    const h = setup({
      settings: { ...COMPLETE_SETTINGS, run: { maxBudgetUsd: 0.05, maxTurns: 200 } },
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'budget_exceeded',
      failureReason: 'error_max_budget_usd',
    });
    expect(sessionsOf(h).map((s) => [s.role, s.endReason])).toEqual([
      ['test-writer', 'success'],
      ['implementer', 'error_max_budget_usd'],
    ]);
  }, 60_000);
});

describe('중단 · 재개 (수용 기준 3 · 4, 엔진 인스턴스 교체)', () => {
  it('재기동 복구는 running만 interrupted로 바꾸고 자동 재개하지 않으며, run.resume은 hard reset + clean 뒤 새 세션으로 이어간다', async () => {
    const h = setup({ scenario: 'regress-pause', scenariosDir: TEST_SCENARIOS_DIR });
    const pause = path.join(h.biveHome, 'run', 'pause');
    expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
    await waitFor(
      () =>
        fs.existsSync(pause) &&
        detailOf(h).steps.some(
          (s) => s.kind === 'implementation' && s.attempt === 2 && s.status === 'running',
        ),
      30_000,
      '두 번째 구현 세션 대기',
    );
    const paused = detailOf(h);
    expect(paused.run.regressionCount).toBe(1);
    const lastCompleted = String(paused.run.headCommit);
    expect(lastCompleted).toBe(stepOf(paused, 'implementation').commit);

    // 진행 중 워크트리를 더럽힌다: 추적 파일 변경 · 미추적 파일 · 무시된 파일
    const worktree = String(paused.run.worktreePath);
    fs.appendFileSync(path.join(worktree, 'src/app/page.tsx'), '\n// 커밋되지 않은 변경\n');
    fs.writeFileSync(path.join(worktree, 'junk.txt'), '남은 파일\n');
    fs.mkdirSync(path.join(worktree, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'node_modules', 'keep.txt'), '무시된 파일\n');

    // 엔진을 상태 저장 없이 멈춘다 (비정상 종료와 같은 저장 상태: running)
    await h.engine.stop();
    expect(detailOf(h).run.status).toBe('running');
    // 정상 종료 중 시작된 판정 · 재개는 받지 않는다
    expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(false);

    const engine = h.newEngine();
    expect(engine.recoverInterruptedRuns()).toEqual([
      { projectId: h.project.id, runId: h.runId, displayId: 'EXE-001' },
    ]);
    const interrupted = detailOf(h);
    expect(interrupted.run).toMatchObject({
      status: 'interrupted',
      currentStep: 'implementation',
      lastCompletedStep: 'implementation',
      regressionCount: 1,
    });
    expect(attempts(interrupted, 'implementation')).toEqual([
      'implementation#1:passed',
      'implementation#2:failed',
      'implementation#3:pending',
    ]);
    expect(stepOf(interrupted, 'implementation', 2).exitDetail).toEqual(INTERRUPTED_EXIT_DETAIL);
    expect(sessionsOf(h, 'implementer').map((s) => s.endReason)).toEqual(['success', 'aborted']);
    // 두 번 불러도 바꿀 것이 없다
    expect(engine.recoverInterruptedRuns()).toEqual([]);

    // 자동 재개 없음
    await engine.settled();
    await sleep(300);
    expect(detailOf(h)).toEqual(interrupted);
    expect(sessionsOf(h, 'implementer')).toHaveLength(2);

    // 재개 거부: 에이전트 주체 · 없는 실행 · 등록 안 된 프로젝트
    await expect(
      engine.resume(h.project.id, h.runId, { kind: 'agent', role: 'implementer' }),
    ).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
    await expect(engine.resume(h.project.id, 'EXE-009', human)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
    await expect(engine.resume(newId(), h.runId, human)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });

    const resumed = await engine.resume(h.project.id, 'EXE-001', human);
    expect(resumed.run).toMatchObject({
      status: 'running',
      currentStep: 'implementation',
      regressionCount: 1,
    });
    expect(stepOf(resumed, 'implementation', 3).status).toBe('running');
    // 재개 직후 무시된 파일은 남고 미추적 파일은 지워졌다
    expect(fs.existsSync(path.join(worktree, 'node_modules', 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(worktree, 'junk.txt'))).toBe(false);

    await engine.settled();
    const done = detailOf(h);
    expect(done.run).toMatchObject({ status: 'merged', regressionCount: 1 });
    expect(attempts(done, 'implementation')).toEqual([
      'implementation#1:passed',
      'implementation#2:failed',
      'implementation#3:passed',
    ]);
    expect(attempts(done, 'check')).toEqual(['check#1:failed', 'check#2:passed']);
    // 새 구현 커밋은 마지막 완료 단계 커밋 위에 있고, 되돌린 변경 · 지운 파일이 들어가지 않았다
    const resumedCommit = String(stepOf(done, 'implementation', 3).commit);
    expect(userGit(h.repo, 'rev-parse', `${resumedCommit}^`)).toBe(lastCompleted);
    expect(userGit(h.repo, 'diff', '--name-only', lastCompleted, resumedCommit)).toBe(ROUTE);
    // 재개 뒤 세션은 새 세션(순번 2)이라 대기하지 않았다
    expect(sessionsOf(h, 'implementer').map((s) => s.endReason)).toEqual([
      'success',
      'aborted',
      'success',
    ]);

    // interrupted가 아닌 실행은 재개할 수 없다
    await expect(engine.resume(h.project.id, h.runId, human)).rejects.toMatchObject({
      code: ErrorCode.StateConflict,
    });
    fs.rmSync(pause, { force: true });
  }, 90_000);
});

describe('비정상 종료(SIGKILL) 뒤 재기동 · run.resume (수용 기준 3 · 4, 실제 프로세스)', () => {
  interface Running {
    proc: Spawned;
    client: TestClient;
  }

  const start = async (biveHome: string): Promise<Running> => {
    const proc = spawnScript('test/helpers/engine-orchestrator.ts', {
      BIVE_HOME: biveHome,
      BIVE_IDLE_SHUTDOWN_MS: '60000',
      BIVE_SCENARIO: 'regress-pause',
    });
    await waitFor(() => proc.stdout.includes('오케스트레이터 기동'), 30_000, '오케스트레이터 기동');
    const paths = runPaths(biveHome);
    const client = await connect(paths.pipe, readFileSync(paths.token, 'utf8'));
    return { proc, client };
  };

  const kill = async ({ proc, client }: Running): Promise<void> => {
    client.destroy();
    proc.child.kill('SIGKILL');
    await proc.exited;
  };

  it('running 실행이 interrupted가 되고 자동 재개하지 않으며, run.resume으로 이어가 merged (regressionCount 유지)', async () => {
    const biveHome = makeBiveHome();
    const repo = copyFixture(temps);
    const { project, rule } = seedProject(biveHome, repo);
    const pause = path.join(biveHome, 'run', 'pause');
    const read = (): RunDetail =>
      withProject(biveHome, project.id, (store) => {
        const detail = store.runs.getDetailByDisplayId('EXE-001');
        if (detail === null) throw new Error('실행 없음');
        return detail;
      });

    let current = await start(biveHome);
    expect(current.proc.stdout).toContain('중단으로 표시 0');
    await current.client.call('run.create', {
      projectId: project.id,
      ruleIds: [rule.id],
      author: human,
    });
    await waitFor(
      () =>
        fs.existsSync(pause) &&
        read().steps.some(
          (s) => s.kind === 'implementation' && s.attempt === 2 && s.status === 'running',
        ),
      60_000,
      '두 번째 구현 세션 대기',
    );
    const paused = read();
    expect(paused.run).toMatchObject({ status: 'running', regressionCount: 1 });
    const worktree = String(paused.run.worktreePath);
    fs.appendFileSync(path.join(worktree, 'src/app/page.tsx'), '\n// 커밋되지 않은 변경\n');
    fs.writeFileSync(path.join(worktree, 'junk.txt'), '남은 파일\n');
    await kill(current);
    // 죽은 뒤에도 저장 상태는 running (단계 중간은 저장하지 않음)
    expect(read().run.status).toBe('running');

    current = await start(biveHome);
    expect(current.proc.stdout).toContain('중단으로 표시 1');
    const interrupted = await current.client.call('run.get', {
      projectId: project.id,
      id: 'EXE-001',
    });
    expect(interrupted.run).toMatchObject({
      status: 'interrupted',
      currentStep: 'implementation',
      regressionCount: 1,
    });
    expect(attempts(interrupted, 'implementation')).toEqual([
      'implementation#1:passed',
      'implementation#2:failed',
      'implementation#3:pending',
    ]);
    // 자동 재개 없음: 시간이 지나도 그대로이고 새 세션이 없다
    await sleep(1_000);
    expect(await current.client.call('run.get', { projectId: project.id, id: 'EXE-001' })).toEqual(
      interrupted,
    );
    expect(
      withProject(biveHome, project.id, (store) =>
        store.sessions.countByRunRole(interrupted.run.id, 'implementer'),
      ),
    ).toBe(2);
    expect((await current.client.call('system.status')).runsInProgress).toBe(0);

    const refused = await current.client
      .call('run.resume', {
        projectId: project.id,
        id: 'EXE-001',
        author: { kind: 'agent', role: 'implementer' },
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RpcCallError);
    expect((refused as RpcCallError).code).toBe(ErrorCode.Unauthorized);

    const resumed = await current.client.call('run.resume', {
      projectId: project.id,
      id: 'EXE-001',
      author: human,
    });
    expect(resumed.run).toMatchObject({ status: 'running', regressionCount: 1 });
    expect(stepOf(resumed, 'implementation', 3).status).toBe('running');
    expect(fs.existsSync(path.join(worktree, 'junk.txt'))).toBe(false);

    await waitFor(() => read().run.status === 'merged', 60_000, '재개한 실행 병합');
    const done = await current.client.call('run.get', { projectId: project.id, id: 'EXE-001' });
    expect(done.run).toMatchObject({ status: 'merged', regressionCount: 1 });
    const resumedCommit = String(stepOf(done, 'implementation', 3).commit);
    expect(userGit(repo, 'rev-parse', `${resumedCommit}^`)).toBe(paused.run.headCommit);
    expect(userGit(repo, 'diff', '--name-only', String(paused.run.headCommit), resumedCommit)).toBe(
      ROUTE,
    );
    expect(userGit(repo, 'rev-parse', 'refs/heads/main')).toBe(done.run.mergeCommit);

    const again = await current.client
      .call('run.resume', { projectId: project.id, id: 'EXE-001', author: human })
      .catch((error: unknown) => error);
    expect((again as RpcCallError).code).toBe(ErrorCode.StateConflict);
    await kill(current);
  }, 180_000);
});

describe('상태 기계', () => {
  it('위 시험들이 RUN_STATUS_TRANSITIONS의 모든 전이를 거쳤다', () => {
    const all = Object.entries(RUN_STATUS_TRANSITIONS).flatMap(([from, tos]) =>
      (tos as readonly string[]).map((to) => `${from}→${to}`),
    );
    expect([...observed].sort()).toEqual(expect.arrayContaining(all.sort()));
    expect(all.every((edge) => observed.has(edge))).toBe(true);
  });
});
