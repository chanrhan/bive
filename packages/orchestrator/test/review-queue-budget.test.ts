// 검토 대기열의 예산 초과 액션: 이어받는 실행 · 한도 상향 재개 (M3-56 #319, TODO-02 · COST-01 · NFR-01, ADR-147, ADR-149).
// 실제 SQLite · 픽스처 git 복사본 · 실제 엔진(단계 실행기는 시험용) · 실제 실행 처리기 · 파이프.
// - 원 실행은 '예산 초과' 그대로이고, 같은 유형 · 대상 규칙 · 기준 커밋의 이어받는 새 실행이 생겨 연결이 새 표에 남는다
// - 새 한도는 새 실행의 예산 값이 되고(내리기 · 모양 다름 · 닿은 값을 쓴 양보다 크게 올리지 않음은 -32001), 사용량은 사슬 전체를 이어 센다
// - 사람의 run.create와 같은 문(사람만 · 설정 · 실행 1개의 대기 · 하루 한도는 세션을 열 때)을 지나고, 실행 생성 · 연결 · 처리는 트랜잭션 1개
// - 이어받는 실행이 다시 예산 초과면 그 실행의 새 항목, 보강 실행을 이은 실행도 보강 실행으로 판별된다
import fs from 'node:fs';

import {
  type Author,
  type BudgetSnapshot,
  DomainErrorReason,
  ErrorCode,
  RUN_STATUS_TRANSITIONS,
  type SettingsPatch,
} from '@bive/shared';
import { PROJECT_MIGRATIONS, type ProjectStore } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentAdapter, SessionBudget } from '../src/agent/adapter.js';
import { selectAgent } from '../src/agent/select.js';
import { PipelineEngine } from '../src/engine/pipeline-engine.js';
import { runEnding } from '../src/engine/run-ending.js';
import { checkRunStartBasis } from '../src/engine/start-basis.js';
import type { StepExecutor, StepExecutors } from '../src/engine/types.js';
import { createWorktreeManager, GitWorktreeError } from '../src/git/worktree-manager.js';
import { createRunHandlers } from '../src/ipc/run-handlers.js';
import { RpcError } from '../src/ipc/server.js';
import type { PipeServer } from '../src/ipc/server.js';
import { reinforceSurvivedMutants } from '../src/runs/auto-start.js';
import { createRun, evaluateApprovalStep } from '../src/runs/run-service.js';
import { isReinforcementRun } from '../src/steps/run-type.js';
import type { TestClient } from './helpers/client.js';
import {
  COMPLETE_SETTINGS,
  copyFixture,
  human,
  newId,
  seedProject,
  testExecutors,
  userGit,
  withProject,
} from './helpers/engine-harness.js';
import { cleanup, makeBiveHome } from './helpers/process.js';
import { startProjectHarness } from './helpers/project-harness.js';

const temps: string[] = [];
const engines: PipelineEngine[] = [];
const servers: PipeServer[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}, 60_000);

const agent = { kind: 'agent', role: 'implementer' } as const satisfies Author;
const clock = { now: Date.now, newId };
const at = (): string => new Date().toISOString();
const MUTANT = { path: 'src/app/api/health/route.ts', search: 'time', replace: 'tick' };

/** 단계 하나를 예산 초과로 끝내는 실행기. */
const budgetHalt: StepExecutor = () =>
  Promise.resolve({ status: 'halt', runStatus: 'budget_exceeded', reason: 'error_max_budget_usd' });
/** 단계 하나를 실패로 끝내는 실행기. */
const failHalt: StepExecutor = () =>
  Promise.resolve({ status: 'halt', runStatus: 'failed', reason: 'step_unmet' });

/** COMPLETE_SETTINGS의 유형 A 예산 값 (원 실행의 예산 값). */
const ORIGIN_BUDGET: BudgetSnapshot = {
  run: { maxBudgetUsd: 5, maxTurns: 200 },
  roles: {
    'test-writer': { maxBudgetUsd: 2, maxTurns: 100 },
    implementer: { maxBudgetUsd: 2, maxTurns: 100 },
    mutator: { maxBudgetUsd: 1, maxTurns: 50 },
  },
};
/** 원 실행의 테스트 작성 역할 한도(2 USD)가 닿았을 때 올린 새 한도. */
const RAISED: BudgetSnapshot = {
  run: { maxBudgetUsd: 6, maxTurns: 200 },
  roles: { ...ORIGIN_BUDGET.roles, 'test-writer': { maxBudgetUsd: 3, maxTurns: 100 } },
};

interface Harness {
  readonly biveHome: string;
  readonly repo: string;
  readonly projectId: string;
  readonly ruleId: string;
  readonly read: <T>(fn: (store: ProjectStore) => T) => T;
}

const setup = (settings: SettingsPatch = COMPLETE_SETTINGS): Harness => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const seeded = seedProject(biveHome, repo, settings);
  return {
    biveHome,
    repo,
    projectId: seeded.project.id,
    ruleId: seeded.rule.id,
    read: (fn) => withProject(biveHome, seeded.project.id, fn),
  };
};

/** 세션 1개를 실행의 테스트 작성 단계에 남긴다 (값을 아는 끝난 세션). */
const recordSession = (
  store: ProjectStore,
  runId: string,
  cost: number,
  turns: number,
  role: 'test-writer' | 'implementer' = 'test-writer',
): void => {
  const step = store.runs
    .steps(runId)
    .find((item) => item.kind === (role === 'test-writer' ? 'test_writing' : 'implementation'));
  const id = newId();
  store.sessions.start({
    id,
    runId,
    stepId: step!.id,
    role,
    model: 'test-model',
    workDir: '/work/session',
    budget: { maxBudgetUsd: cost, maxTurns: turns },
    startedAt: at(),
  });
  store.sessions.end(id, {
    endReason: 'success',
    totalCostUsd: cost,
    numTurns: turns,
    endedAt: at(),
  });
};

/**
 * 사람이 시작한 유형 A 실행을 테스트 작성 세션(비용 `cost`, 턴 `turns`) 뒤 예산 초과로 끝낸다 (저장만, 워크트리 없이). `start`를 주면 그
 * 실행을 그것으로 만든다(이어받는 실행).
 */
const budgetEnded = (
  store: ProjectStore,
  ruleId: string,
  cost: number,
  turns: number,
  runId?: string,
): string => {
  const id =
    runId ??
    createRun(store, { ruleIds: [ruleId], author: human }, { clientId: null }, clock).run.id;
  evaluateApprovalStep(store, id, clock);
  recordSession(store, id, cost, turns);
  const run = store.runs.get(id)!;
  store.runs.transition(id, {
    expectedStatus: 'running',
    steps: store.runs
      .steps(id)
      .filter((step) => step.status === 'running')
      .map((step) => ({ id: step.id, status: 'failed' as const, endedAt: at() })),
    run: { ...runEnding(run, 'budget_exceeded', 'budget_aggregate_exceeded').run, endedAt: at() },
  });
  return id;
};

const openBudgetItem = (store: ProjectStore, runId: string) => {
  const item = store.reviewQueue
    .list({ kind: 'budget_exceeded', state: 'open' })
    .find((entry) => entry.runId === runId);
  if (item === undefined) throw new Error(`예산 초과 항목 없음: ${runId}`);
  return item;
};

type ResumeParams = Parameters<
  NonNullable<ReturnType<typeof createRunHandlers>['reviewQueue.resumeWithBudget']>
>;

/** 실제 실행 처리기의 `reviewQueue.resumeWithBudget` (엔진을 주면 생성 뒤 승인 단계를 판정한다). */
const resume = (
  h: Harness,
  params: Omit<ResumeParams[0], 'projectId'>,
  engine?: PipelineEngine,
) => {
  const handlers = createRunHandlers({
    biveHome: h.biveHome,
    now: Date.now,
    ...(engine === undefined ? {} : { engine }),
  });
  return handlers['reviewQueue.resumeWithBudget']!({ projectId: h.projectId, ...params }, {
    connectionId: 7,
  } as ResumeParams[1]);
};

const rejection = async (fn: () => unknown): Promise<RpcError> => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error('거부되지 않음');
};

/** 세션을 열 때 받은 한도를 모으는 시험 어댑터 (대본은 기본 대본). */
const recordingAgent = (biveHome: string, budgets: SessionBudget[]): AgentAdapter => {
  const inner = selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome }).adapter;
  return {
    kind: inner.kind,
    startSession: (spec) => {
      budgets.push(spec.budget);
      return inner.startSession(spec);
    },
  };
};

const newEngine = (h: Harness, executors: StepExecutors, budgets: SessionBudget[] = []) => {
  const engine = new PipelineEngine({
    biveHome: h.biveHome,
    agent: recordingAgent(h.biveHome, budgets),
    executors: testExecutors(executors),
  });
  engines.push(engine);
  return engine;
};

/** 테스트 작성 세션을 하나 열고(엔진의 세션 한도 계산) 실행을 예산 초과로 끝내는 실행기. */
const sessionThenBudgetHalt: StepExecutor = async (context) => {
  await context.runSession({
    workDir: context.git.worktreePath,
    systemPrompt: '시험',
    prompt: '시험',
    vars: { ruleId: 'RULE-001' },
  });
  return { status: 'halt', runStatus: 'budget_exceeded', reason: 'error_max_budget_usd' };
};

/** 실행 · 단계 · 세션 기록 (원 실행 불변 대조용). */
const recordOf = (store: ProjectStore, runId: string) => ({
  detail: store.runs.getDetail(runId),
  sessions: store.sessions.listByRun(runId),
  usage: store.runs.usage(runId),
});

describe('한도 상향 재개 = 이어받는 새 실행 (M3-56 수용 기준 1 · 3, ADR-147 ① ② ⑤ ⑦)', () => {
  it('원 실행은 예산 초과 그대로이고, 같은 유형 · 대상 규칙의 이어받는 실행(사람, 승인 기록 run_start)이 새 한도를 예산 값으로 갖고 원 실행과 이어지며 항목은 처리됨이다', async () => {
    const h = setup();
    const originId = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
    const { item, before } = h.read((store) => ({
      item: openBudgetItem(store, originId),
      before: recordOf(store, originId),
    }));
    const result = await resume(h, { seq: item.seq, budget: RAISED, author: human });
    expect(result.run).toMatchObject({
      type: 'A',
      status: 'waiting_approval',
      targetRuleIds: [h.ruleId],
      startedBy: { kind: 'human' },
      budgetSnapshot: RAISED,
      baseCommit: null,
    });
    expect(result.run.id).not.toBe(originId);
    expect(result.approvalLog).toMatchObject({
      action: 'run_start',
      actor: { kind: 'human' },
      targetRef: { entity: 'Run', id: result.run.id },
      clientId: 'pipe-7',
      detail: { ruleIds: [h.ruleId] },
    });
    expect(result.entry.item.resolution).toEqual({
      action: 'raise_limit_resume',
      by: human,
      at: result.run.createdAt,
      reason: null,
      runId: result.run.id,
    });
    h.read((store) => {
      expect(store.runContinuations.originOf(result.run.id)).toEqual({
        runId: result.run.id,
        originRunId: originId,
        createdAt: result.run.createdAt,
      });
      // 원 실행의 상태 · 단계 · 세션 · 비용 기록이 그대로다 (종료 상태를 되살리지 않는다)
      expect(recordOf(store, originId)).toEqual(before);
      expect(store.runs.get(originId)?.status).toBe('budget_exceeded');
      expect(checkRunStartBasis(store, result.run)).toEqual({
        mismatch: null,
        runStartEntries: 1,
        autoStartEntries: 0,
      });
      // 설정은 바뀌지 않는다
      expect(store.settings.get().roles['test-writer'].maxBudgetUsd).toBe(2);
    });
    // 같은 항목을 두 번 처리할 수 없다 (원 실행 하나에 이어받는 실행 하나)
    const again = await rejection(() =>
      resume(h, { seq: item.seq, budget: RAISED, author: human }),
    );
    expect([again.code, again.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'already_resolved' },
    ]);
  }, 60_000);

  it('종료 상태 전이 표와 0016의 종료 트리거는 그대로다', () => {
    expect(RUN_STATUS_TRANSITIONS).toEqual({
      waiting_approval: ['running', 'queued', 'failed'],
      queued: ['running', 'failed', 'budget_exceeded'],
      running: ['merged', 'failed', 'budget_exceeded', 'interrupted'],
      interrupted: ['running', 'failed', 'merged'],
      merged: [],
      failed: [],
      budget_exceeded: [],
    });
    const h = setup();
    const m0016 = PROJECT_MIGRATIONS.find((migration) => migration.version === 16)!;
    const live = h.read((store) =>
      store.db
        .prepare<[], { name: string; sql: string }>(
          "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('runs_terminal_final', 'steps_run_terminal_insert', 'steps_final') ORDER BY name",
        )
        .all(),
    );
    expect(live.map((row) => row.name)).toEqual([
      'runs_terminal_final',
      'steps_final',
      'steps_run_terminal_insert',
    ]);
    for (const row of live) expect(m0016.up).toContain(row.sql);
  });

  it('에이전트 주체(저장소를 열기 전 -32020) · 없는 항목 · 변이 생존 항목 · 설정 미비(-32010)는 거부되고 아무것도 남지 않는다', async () => {
    const h = setup({ ...COMPLETE_SETTINGS, dailyBudgetUsd: 10 });
    const { originId, mutantSeq } = h.read((store) => {
      const originId = budgetEnded(store, h.ruleId, 2, 30);
      return { originId, mutantSeq: failedReinforcementItem(store, h.ruleId) };
    });
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    const counts = () =>
      h.read((store) => ({
        runs: store.runs.list().length,
        runStarts: store.approvalLog.list().filter((entry) => entry.action === 'run_start').length,
        continuation: store.runContinuations.continuationOf(originId),
        resolution: store.reviewQueue.get(seq)?.resolution ?? null,
      }));
    const before = counts();
    // 에이전트는 저장소를 열기 전에 거부된다 (등록되지 않은 프로젝트여도 -32004가 아니라 -32020)
    const handlers = createRunHandlers({ biveHome: h.biveHome, now: Date.now });
    const byAgent = await rejection(() =>
      handlers['reviewQueue.resumeWithBudget']!(
        { projectId: newId(), seq, budget: RAISED, author: agent },
        { connectionId: 1 } as ResumeParams[1],
      ),
    );
    expect(byAgent.code).toBe(ErrorCode.Unauthorized);
    const missing = await rejection(() => resume(h, { seq: 99, budget: RAISED, author: human }));
    expect(missing.code).toBe(ErrorCode.NotFound);
    const wrongKind = await rejection(() =>
      resume(h, { seq: mutantSeq, budget: RAISED, author: human }),
    );
    expect([wrongKind.code, wrongKind.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'action_not_allowed' },
    ]);
    h.read((store) =>
      store.settings.update({ roles: { implementer: { model: null } } }, { by: human, at: at() }),
    );
    const incomplete = await rejection(() => resume(h, { seq, budget: RAISED, author: human }));
    expect(incomplete.code).toBe(ErrorCode.SettingsIncomplete);
    expect(counts()).toEqual(before);
    expect(before.resolution).toBeNull();
  }, 60_000);

  it('실행을 만든 뒤 연결 쓰기가 실패하면 실행 · 승인 기록 · 연결 · 처리 어느 것도 남지 않는다 (트랜잭션 1개)', async () => {
    const h = setup();
    const originId = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    const counts = () =>
      h.read((store) => ({
        runs: store.runs.list().length,
        runStarts: store.approvalLog.list().filter((entry) => entry.action === 'run_start').length,
        continuation: store.runContinuations.continuationOf(originId),
        resolution: store.reviewQueue.get(seq)?.resolution ?? null,
      }));
    const before = counts();
    // 시험에서만: 연결 넣기를 실패시킨다 (실행 생성 뒤의 실패)
    h.read((store) =>
      store.db.exec(`CREATE TRIGGER test_fail_continuation BEFORE INSERT ON run_continuations
        BEGIN SELECT RAISE(ABORT, '시험이 넣은 실패'); END;`),
    );
    await expect(async () => resume(h, { seq, budget: RAISED, author: human })).rejects.toThrow(
      /시험이 넣은 실패/,
    );
    expect(counts()).toEqual(before);
    // 처리 쓰기가 실패해도 같다 (연결 뒤의 실패)
    h.read((store) =>
      store.db.exec(`DROP TRIGGER test_fail_continuation;
        CREATE TRIGGER test_fail_resolve BEFORE UPDATE ON review_items
        BEGIN SELECT RAISE(ABORT, '시험이 넣은 처리 실패'); END;`),
    );
    await expect(async () => resume(h, { seq, budget: RAISED, author: human })).rejects.toThrow(
      /처리 실패/,
    );
    expect(counts()).toEqual(before);
  }, 60_000);

  it('유형 · 대상 규칙은 원 실행에서 정해진다: 유형 C 원 실행은 유형 C로 이어지고, 사람의 run.create 요청은 예산 값을 받지 않는다(-32602)', async () => {
    const repo = copyFixture(temps);
    const p = await startProjectHarness({ servers, clients }, { rootPath: repo });
    p.clock.now = Date.now();
    const raw = await p.client.requestRaw({
      jsonrpc: '2.0',
      id: 'budget',
      method: 'run.create',
      params: { projectId: p.project.id, ruleIds: [newId()], author: human, budget: RAISED },
    });
    expect(raw).toMatchObject({ error: { code: ErrorCode.InvalidParams } });
    // 유형 C 원 실행 (사람이 [실행]으로 만든 C · 보강 아님)
    const h = setup();
    const originId = h.read((store) => {
      const created = createRun(
        store,
        { ruleIds: [h.ruleId], author: human, type: 'C' },
        { clientId: null },
        clock,
      );
      return budgetEnded(store, h.ruleId, 0.5, 5, created.run.id);
    });
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    const originBudget = h.read((store) => store.runs.get(originId)!.budgetSnapshot);
    const result = await resume(h, { seq, budget: originBudget, author: human });
    expect(result.run).toMatchObject({ type: 'C', targetRuleIds: [h.ruleId] });
    expect(result.run.budgetSnapshot).toEqual(originBudget);
  }, 60_000);
});

/** 변이 보강 실행(자동 연결)이 실패로 끝나 생긴 변이 생존 항목의 순번. */
const failedReinforcementItem = (store: ProjectStore, ruleId: string): number => {
  const runId = autoReinforcement(store, ruleId);
  evaluateApprovalStep(store, runId, clock);
  const run = store.runs.get(runId)!;
  store.runs.transition(runId, {
    expectedStatus: 'running',
    run: { ...runEnding(run, 'failed', 'regression_limit').run, endedAt: at() },
  });
  const item = store.reviewQueue.list({ kind: 'mutant_survived', state: 'open' })[0];
  if (item === undefined) throw new Error('변이 생존 항목 없음');
  return item.seq;
};

/** 병합된 유형 A 실행의 '변이 생존' 기록과 그 자동 보강 실행(유형 C, 승인 대기). */
const autoReinforcement = (store: ProjectStore, ruleId: string): string => {
  const origin = createRun(store, { ruleIds: [ruleId], author: human }, { clientId: null }, clock);
  evaluateApprovalStep(store, origin.run.id, clock);
  store.runs.transition(origin.run.id, {
    expectedStatus: 'running',
    run: { status: 'merged', mergeCommit: 'a'.repeat(40), currentStep: null, endedAt: at() },
  });
  const survived = store.mutations.record({
    id: newId(),
    ruleId,
    runId: origin.run.id,
    stepId: origin.steps.find((step) => step.kind === 'mutation')!.id,
    sessionId: newId(),
    commit: 'b'.repeat(40),
    status: 'survived',
    outcome: 'survived',
    mutant: MUTANT,
    recordedAt: at(),
  });
  const outcome = reinforceSurvivedMutants(store, { runId: survived.runId }, clock);
  if (outcome.status !== 'started') throw new Error(`보강 실행 없음: ${outcome.status}`);
  return outcome.runs[0]!.detail.run.id;
};

describe('새 한도의 검증 (M3-56 수용 기준 2, ADR-147 ④)', () => {
  it('어느 값이든 원 실행의 같은 값보다 작으면 BUDGET_LOWERED, 역할 집합이 다르면 BUDGET_SHAPE_MISMATCH, 닿은 값을 쓴 양보다 크게 올리지 않으면 BUDGET_NOT_ABOVE_SPENT (모두 -32001, 아무것도 남지 않음)', async () => {
    const h = setup();
    // 테스트 작성 역할이 2 USD를 다 썼다 (역할 USD 한도에 닿음). 실행 전체 · 턴은 닿지 않았다
    const originId = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    const cases: [BudgetSnapshot, string, string[]][] = [
      [
        { ...RAISED, roles: { ...RAISED.roles, implementer: { maxBudgetUsd: 2, maxTurns: 99 } } },
        DomainErrorReason.BudgetLowered,
        ['roles.implementer.maxTurns'],
      ],
      [
        { ...RAISED, run: { maxBudgetUsd: 4.99, maxTurns: 200 } },
        DomainErrorReason.BudgetLowered,
        ['run.maxBudgetUsd'],
      ],
      [
        { run: RAISED.run, roles: { 'test-writer': RAISED.roles['test-writer']! } },
        DomainErrorReason.BudgetShapeMismatch,
        ['roles.implementer', 'roles.mutator'],
      ],
      [
        { ...RAISED, roles: { ...RAISED.roles, planner: { maxBudgetUsd: 1, maxTurns: 1 } } },
        DomainErrorReason.BudgetShapeMismatch,
        ['roles.planner'],
      ],
      // 닿은 값(테스트 작성 역할 USD)을 그대로 두면 받지 않는다. 닿지 않은 값(실행 전체 · 다른 역할 · 턴)은 같아도 된다
      [ORIGIN_BUDGET, DomainErrorReason.BudgetNotAboveSpent, ['roles.test-writer.maxBudgetUsd']],
    ];
    for (const [budget, reason, fields] of cases) {
      const error = await rejection(() => resume(h, { seq, budget, author: human }));
      expect([error.code, error.data], reason).toEqual([
        ErrorCode.ValidationFailed,
        { reason, fields },
      ]);
    }
    h.read((store) => {
      expect(store.runs.list()).toHaveLength(1);
      expect(store.reviewQueue.get(seq)?.resolution).toBeNull();
    });
    // 닿은 값만 올리고 나머지는 원 실행 그대로면 받는다
    const raisedOnly: BudgetSnapshot = {
      ...ORIGIN_BUDGET,
      roles: { ...ORIGIN_BUDGET.roles, 'test-writer': { maxBudgetUsd: 2.01, maxTurns: 100 } },
    };
    const result = await resume(h, { seq, budget: raisedOnly, author: human });
    expect(result.run.budgetSnapshot).toEqual(raisedOnly);
  }, 60_000);

  it('사용량은 원 실행부터 이어 센다: 이어받는 실행의 첫 세션 한도 = 새 한도 - 원 실행이 쓴 양 (역할 · 실행 전체, USD · 턴)', async () => {
    const h = setup();
    const originId = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    const budgets: SessionBudget[] = [];
    const engine = newEngine(h, { test_writing: sessionThenBudgetHalt }, budgets);
    const result = await resume(h, { seq, budget: RAISED, author: human }, engine);
    await engine.settled();
    // 역할: 3 - 2 = 1 USD, 100 - 30 = 70턴. 실행 전체: 6 - 2 = 4 USD, 200 - 30 = 170턴. 이어 세지 않으면 3 USD · 100턴이다
    expect(budgets).toEqual([{ maxBudgetUsd: 1, maxTurns: 70 }]);
    expect(h.read((store) => store.runs.get(result.run.id)?.status)).toBe('budget_exceeded');
  }, 60_000);

  it('사슬 2단(원 → 1차 → 2차): 1차가 다시 예산 초과면 그 실행의 새 항목에서 잇고, 검증 · 세션 한도 모두 사슬 전체의 사용량을 센다. 처리된 원 항목은 그대로다', async () => {
    const h = setup();
    const originId = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
    const firstSeq = h.read((store) => openBudgetItem(store, originId).seq);
    const first = await resume(h, { seq: firstSeq, budget: RAISED, author: human });
    // 1차가 테스트 작성 역할 1 USD · 20턴을 더 쓰고 다시 예산 초과 (사슬 합 3 USD = 1차의 역할 한도에 닿음)
    h.read((store) => budgetEnded(store, h.ruleId, 1, 20, first.run.id));
    const secondItem = h.read((store) => openBudgetItem(store, first.run.id));
    expect(h.read((store) => store.reviewQueue.get(firstSeq)?.resolution?.action)).toBe(
      'raise_limit_resume',
    );
    // 1차 혼자서는 1 USD라 3 USD에 닿지 않지만 사슬 합(3 USD)으로는 닿았다: 3을 그대로 두면 거부
    const stuck = await rejection(() =>
      resume(h, { seq: secondItem.seq, budget: RAISED, author: human }),
    );
    expect([stuck.code, stuck.data]).toEqual([
      ErrorCode.ValidationFailed,
      { reason: DomainErrorReason.BudgetNotAboveSpent, fields: ['roles.test-writer.maxBudgetUsd'] },
    ]);
    const budgets: SessionBudget[] = [];
    const engine = newEngine(h, { test_writing: sessionThenBudgetHalt }, budgets);
    const next: BudgetSnapshot = {
      run: { maxBudgetUsd: 10, maxTurns: 300 },
      roles: { ...RAISED.roles, 'test-writer': { maxBudgetUsd: 3.5, maxTurns: 120 } },
    };
    const second = await resume(h, { seq: secondItem.seq, budget: next, author: human }, engine);
    await engine.settled();
    // 역할: 3.5 - 3 = 0.5 USD, 120 - 50 = 70턴 (원 30 + 1차 20)
    expect(budgets).toEqual([{ maxBudgetUsd: 0.5, maxTurns: 70 }]);
    h.read((store) => {
      expect(store.runContinuations.ancestorsOf(second.run.id)).toEqual([originId, first.run.id]);
      // 2차가 다시 예산 초과로 끝나 그 실행의 새 항목이 열렸다 (자동 등록, 코드 추가 없음)
      expect(
        store.reviewQueue
          .list({ kind: 'budget_exceeded' })
          .map((item) => [item.runId, item.resolution?.action ?? null]),
      ).toEqual([
        [originId, 'raise_limit_resume'],
        [first.run.id, 'raise_limit_resume'],
        [second.run.id, null],
      ]);
    });
  }, 60_000);
});

describe('사람 실행의 문 · 작업 가지 (M3-56 수용 기준 3, ADR-147 ② ⑤)', () => {
  it('오늘 지출이 하루 한도에 이르렀으면 이어받는 실행은 첫 세션을 열기 전에 예산 초과(project_daily_budget_exceeded)로 끝나고 그 실행의 새 항목이 생긴다', async () => {
    const h = setup({ ...COMPLETE_SETTINGS, dailyBudgetUsd: 1 });
    const originId = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    const budgets: SessionBudget[] = [];
    const engine = newEngine(h, { test_writing: sessionThenBudgetHalt }, budgets);
    const result = await resume(h, { seq, budget: RAISED, author: human }, engine);
    await engine.settled();
    expect(budgets).toEqual([]);
    h.read((store) => {
      expect(store.runs.get(result.run.id)).toMatchObject({
        status: 'budget_exceeded',
        failureReason: 'project_daily_budget_exceeded',
      });
      // 하루 한도는 바뀌지 않는다
      expect(store.settings.get().dailyBudgetUsd).toBe(1);
      expect(openBudgetItem(store, result.run.id).runId).toBe(result.run.id);
    });
  }, 60_000);

  it('다른 실행이 진행 중이면 이어받는 실행은 실행 대기다 (프로젝트당 실행 1개)', async () => {
    const h = setup();
    const originId = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    h.read((store) => {
      const other = createRun(
        store,
        { ruleIds: [h.ruleId], author: human },
        { clientId: null },
        clock,
      );
      evaluateApprovalStep(store, other.run.id, clock);
    });
    const engine = newEngine(h, {});
    const result = await resume(h, { seq, budget: RAISED, author: human }, engine);
    await engine.settled();
    expect(h.read((store) => store.runs.get(result.run.id)?.status)).toBe('queued');
  }, 60_000);

  it('작업 가지의 기준 커밋은 원 실행과 같다(그 사이 기준 브랜치가 움직여도). 원 실행의 브랜치 · 작업 폴더 · 기록은 바뀌지 않는다', async () => {
    const h = setup();
    const engine = newEngine(h, {
      implementation: (context) =>
        context.run.id === originId ? budgetHalt(context) : failHalt(context),
    });
    let originId = '';
    originId = h.read(
      (store) =>
        createRun(store, { ruleIds: [h.ruleId], author: human }, { clientId: null }, clock).run.id,
    );
    engine.evaluateApproval(h.projectId, originId);
    await engine.settled();
    const origin = h.read((store) => store.runs.get(originId)!);
    expect(origin).toMatchObject({ status: 'budget_exceeded', currentStep: 'implementation' });
    const originTip = userGit(h.repo, 'rev-parse', `refs/heads/${origin.branch!}`);
    const before = h.read((store) => recordOf(store, originId));
    // 기준 브랜치가 움직인다
    fs.writeFileSync(`${h.repo}/NOTES.md`, '다음 커밋\n');
    userGit(h.repo, 'add', 'NOTES.md');
    userGit(h.repo, 'commit', '-q', '-m', 'main 이동');
    const mainTip = userGit(h.repo, 'rev-parse', 'refs/heads/main');
    expect(mainTip).not.toBe(origin.baseCommit);
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    const result = await resume(h, { seq, budget: RAISED, author: human }, engine);
    await engine.settled();
    const next = h.read((store) => store.runs.get(result.run.id)!);
    expect(next.baseCommit).toBe(origin.baseCommit);
    expect(next.branch).not.toBe(origin.branch);
    // 이어받는 실행의 가지는 기준 커밋 위에 있다 (main의 새 커밋이 없다)
    expect(userGit(h.repo, 'merge-base', '--is-ancestor', origin.baseCommit!, next.branch!)).toBe(
      '',
    );
    expect(() => userGit(h.repo, 'merge-base', '--is-ancestor', mainTip, next.branch!)).toThrow();
    expect(userGit(h.repo, 'rev-parse', `refs/heads/${origin.branch!}`)).toBe(originTip);
    expect(h.read((store) => recordOf(store, originId))).toEqual(before);
  }, 60_000);

  it('작업 가지의 시작 커밋은 원 실행 브랜치에 있어야 하고 기준 커밋은 그 조상이어야 한다 (git 객체로 확인, start_commit_unavailable)', async () => {
    const h = setup();
    const biveHome = h.biveHome;
    const worktrees = createWorktreeManager({ biveHome });
    const base = userGit(h.repo, 'rev-parse', 'refs/heads/main');
    // 원 실행 브랜치 하나와 그 브랜치에 없는 커밋 (main의 다음 커밋)
    userGit(h.repo, 'branch', 'bive/run-EXE-001', base);
    fs.writeFileSync(`${h.repo}/NOTES.md`, '다음 커밋\n');
    userGit(h.repo, 'add', 'NOTES.md');
    userGit(h.repo, 'commit', '-q', '-m', 'main 이동');
    const elsewhere = userGit(h.repo, 'rev-parse', 'refs/heads/main');
    const input = (start: { baseCommit: string; commit: string; fromBranch: string }) => ({
      projectId: h.projectId,
      runDisplayId: 'EXE-002',
      repoPath: h.repo,
      baseBranch: 'main',
      start,
    });
    const code = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        if (error instanceof GitWorktreeError) return error.code;
        throw error;
      }
      return null;
    };
    expect(
      await code(
        worktrees.create(
          input({ baseCommit: base, commit: elsewhere, fromBranch: 'bive/run-EXE-001' }),
        ),
      ),
    ).toBe('start_commit_unavailable');
    expect(
      await code(
        worktrees.create(
          input({ baseCommit: elsewhere, commit: base, fromBranch: 'bive/run-EXE-001' }),
        ),
      ),
    ).toBe('start_commit_unavailable');
    expect(
      await code(worktrees.create(input({ baseCommit: base, commit: base, fromBranch: 'main' }))),
    ).toBe('invalid_input');
    expect(userGit(h.repo, 'branch', '--list', 'bive/run-EXE-002')).toBe('');
    const created = await worktrees.create(
      input({ baseCommit: base, commit: base, fromBranch: 'bive/run-EXE-001' }),
    );
    expect(created.baseCommit).toBe(base);
    expect(userGit(created.worktreePath, 'rev-parse', 'HEAD')).toBe(base);
  }, 60_000);
});

describe('보강 사슬 (M3-56 수용 기준 4, ADR-147 ⑦ · ADR-145)', () => {
  it('예산 초과로 끝난 보강 실행을 이은 실행도 보강 실행으로 판별되고 같은 규칙의 자동 보강을 막으며, 실패로 끝나면 변이 생존 항목이 생긴다', async () => {
    const h = setup({ ...COMPLETE_SETTINGS, dailyBudgetUsd: 10 });
    const { reinforcingId, cause } = h.read((store) => {
      const reinforcingId = autoReinforcement(store, h.ruleId);
      const cause = store.mutations.reinforcementCauseOfRun(reinforcingId)!;
      const run = store.runs.get(reinforcingId)!;
      evaluateApprovalStep(store, reinforcingId, clock);
      store.runs.transition(reinforcingId, {
        expectedStatus: 'running',
        run: { ...runEnding(run, 'budget_exceeded', 'error_max_budget_usd').run, endedAt: at() },
      });
      return { reinforcingId, cause };
    });
    const { seq, budget } = h.read((store) => ({
      seq: openBudgetItem(store, reinforcingId).seq,
      budget: store.runs.get(reinforcingId)!.budgetSnapshot,
    }));
    const result = await resume(h, { seq, budget, author: human });
    expect(result.run).toMatchObject({ type: 'C', startedBy: { kind: 'human' } });
    h.read((store) => {
      expect(store.mutations.reinforcementCauseOfRun(result.run.id)).toBe(cause);
      expect(isReinforcementRun({ run: result.run, read: (fn) => fn(store) })).toBe(true);
      // 이어받는 실행은 보강 연결 표에 행이 없다 (사슬로만 닿는다)
      expect(store.mutations.reinforcementOfRun(result.run.id)).toBeNull();
      expect(store.reviewQueue.reinforcementOfRun(result.run.id)).toBeNull();
    });
    // 같은 규칙의 새 생존: 끝나지 않은 보강 실행(이어받는 실행)이 있어 자동 보강을 만들지 않는다
    const outcome = h.read((store) => {
      const origin = createRun(
        store,
        { ruleIds: [h.ruleId], author: human },
        { clientId: null },
        clock,
      );
      store.runs.transition(origin.run.id, {
        run: { status: 'running', startedAt: at() },
      });
      return origin.run.id;
    });
    h.read((store) => {
      store.runs.transition(outcome, {
        expectedStatus: 'running',
        run: { status: 'merged', mergeCommit: 'd'.repeat(40), currentStep: null, endedAt: at() },
      });
      store.mutations.record({
        id: newId(),
        ruleId: h.ruleId,
        runId: outcome,
        stepId: store.runs.steps(outcome).find((step) => step.kind === 'mutation')!.id,
        sessionId: newId(),
        commit: 'd'.repeat(40),
        status: 'survived',
        outcome: 'survived',
        mutant: MUTANT,
        recordedAt: at(),
      });
      expect(reinforceSurvivedMutants(store, { runId: outcome }, clock)).toEqual({
        status: 'none',
      });
    });
    // 이어받는 실행이 실패로 끝나면 원인이 아직 생존이라 변이 생존 항목이 생긴다 (M3-08의 등록 조건 그대로)
    const engine = newEngine(h, { test_writing: failHalt });
    engine.evaluateApproval(h.projectId, result.run.id);
    await engine.settled();
    h.read((store) => {
      expect(store.runs.get(result.run.id)?.status).toBe('failed');
      expect(
        store.reviewQueue
          .list({ state: 'open' })
          .map((item) => [item.kind, item.runId, item.mutationResultId]),
      ).toEqual([['mutant_survived', result.run.id, cause]]);
    });
  }, 60_000);
});
