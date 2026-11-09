// 예산 집계 · 한도 · 비용 기록 (M1-17 수용 기준, COST-01 · COST-02 · NFR-07 · ADR-024 · ADR-066 · ADR-067).
// 집계 함수는 순수 함수로, 엔진 경로는 픽스처 git 복사본 · 실제 git · 실제 SQLite · ScriptedAdapter(실제 고정 도구 ·
// 세션 가드)로 단언한다. 단계 종료 조건은 시험용 실행기(engine-harness)를 쓴다.
import fs from 'node:fs';

import {
  type AgentRole,
  createUlidGenerator,
  METHODS,
  type ModelUsage,
  type Session,
  type SettingsPatch,
  type Step,
  type StepKind,
  remainingUsd,
  subtractUsd,
  sumSessionUsage,
  sumUsd,
  type UsageTotals,
} from '@bive/shared';
import type { RunDetail } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentAdapter,
  ModelUsageReport,
  SessionBudget,
  SessionEvent,
} from '../src/agent/adapter.js';
import { loadScenario } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import { PipelineEngine } from '../src/engine/pipeline-engine.js';
import { budgetOverrun, sessionLimits } from '../src/engine/session-budget.js';
import type { StepExecutor, StepExecutors } from '../src/engine/types.js';
import { createRunHandlers } from '../src/ipc/run-handlers.js';
import { createRun } from '../src/runs/run-service.js';
import {
  COMPLETE_SETTINGS,
  copyFixture,
  hasAcceptanceTest,
  human,
  newId,
  seedProject,
  type SeededProject,
  testExecutors,
  userGit,
  withProject,
} from './helpers/engine-harness.js';
import { cleanup, makeBiveHome } from './helpers/process.js';

const temps: string[] = [];
const engines: PipelineEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── 순수 함수 ──────────────────────────────────────────────

const ulid = createUlidGenerator();

const usage = (costUsd: number | null, inputTokens = 100): ModelUsage => ({
  inputTokens,
  outputTokens: 10,
  cacheReadInputTokens: 1,
  cacheCreationInputTokens: 2,
  costUsd,
});

/** 집계 입력용 끝난 세션 (값이 `null`이면 init 뒤 결과 없이 끝난 세션). */
const session = (
  role: AgentRole,
  totalCostUsd: number | null,
  numTurns: number | null,
  modelUsage: Record<string, ModelUsage> = {},
  extra: Partial<Session> = {},
): Session => ({
  id: ulid(),
  runId: null,
  stepId: null,
  requirementId: null,
  role,
  model: 'test-model',
  sdkSessionId: 'sdk-session',
  workDir: '/work/session',
  endReason: totalCostUsd === null ? 'error_during_execution' : 'success',
  error: null,
  totalCostUsd,
  numTurns,
  modelUsage,
  firstTurnCacheWrite: null,
  budget: null,
  tools: [],
  mcpServers: [],
  startedAt: '2026-10-16T09:00:00.000Z',
  endedAt: '2026-10-16T09:00:01.000Z',
  ...extra,
});

const SNAPSHOT = {
  run: { maxBudgetUsd: 0.3, maxTurns: 20 },
  roles: {
    'test-writer': { maxBudgetUsd: 0.1, maxTurns: 10 },
    implementer: { maxBudgetUsd: 0.25, maxTurns: 15 },
  },
};

describe('합산 규칙 (sumSessionUsage, 수용 기준 2)', () => {
  it('값이 없는 세션은 0으로 더하지 않고, 모두 없으면 합계도 null이다', () => {
    expect(sumSessionUsage([])).toEqual({
      costUsd: null,
      turns: null,
      modelUsage: null,
      sessionCount: 0,
      costUnknownCount: 0,
      turnsUnknownCount: 0,
    });
    const unknown = [session('implementer', null, null), session('implementer', null, null)];
    expect(sumSessionUsage(unknown)).toEqual({
      costUsd: null,
      turns: null,
      modelUsage: null,
      sessionCount: 2,
      costUnknownCount: 2,
      turnsUnknownCount: 2,
    });
    // 아는 값만 더한다 (모르는 세션 수는 따로 센다)
    expect(sumSessionUsage([...unknown, session('implementer', 0.05, 3)])).toMatchObject({
      costUsd: 0.05,
      turns: 3,
      sessionCount: 3,
      costUnknownCount: 2,
      turnsUnknownCount: 2,
    });
    // 아는 값 0은 0이다 (없음과 다르다)
    expect(sumSessionUsage([session('implementer', 0, 0)])).toMatchObject({
      costUsd: 0,
      turns: 0,
    });
    // 비용만 모르는 결과(턴은 보고)
    expect(sumSessionUsage([session('implementer', null, 4)])).toMatchObject({
      costUsd: null,
      turns: 4,
      costUnknownCount: 1,
      turnsUnknownCount: 0,
    });
  });

  it('USD는 나노 달러 정수로 더해 부동소수 오차가 없고, 모델별 사용량은 이름별로 더한다', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumUsd([0.1, 0.2])).toBe(0.3);
    expect(sumUsd([0.0421, 0.0421, 0.0587])).toBe(0.1429);
    expect(sumUsd([null, null])).toBeNull();
    expect(subtractUsd(0.3, 0.1)).toBe(0.2);

    const totals = sumSessionUsage([
      session('test-writer', 0.1, 2, { 'model-a': usage(0.1, 100) }),
      session('implementer', 0.2, 3, { 'model-a': usage(0.15, 200), 'model-b': usage(0.05, 50) }),
      session('implementer', null, null, { 'model-c': usage(null, 7) }),
    ]);
    expect(totals.costUsd).toBe(0.3);
    expect(totals.modelUsage).toEqual({
      'model-a': {
        inputTokens: 300,
        outputTokens: 20,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 4,
        costUsd: 0.25,
      },
      'model-b': usage(0.05, 50),
      // 모델 비용이 모두 없으면 그 모델의 비용 합계도 null
      'model-c': usage(null, 7),
    });
  });
});

describe('세션 한도 · 집계 초과 판정 (수용 기준 3)', () => {
  it('세션 한도는 min(역할 잔여, 실행 잔여)이다', () => {
    expect(sessionLimits(SNAPSHOT, 'test-writer', [])).toEqual({ maxBudgetUsd: 0.1, maxTurns: 10 });
    const sessions = [session('test-writer', 0.04, 3), session('implementer', 0.17, 9)];
    // test-writer: USD min(0.1 - 0.04, 0.3 - 0.21) = 0.06 (역할), 턴 min(10 - 3, 20 - 12) = 7 (역할)
    expect(sessionLimits(SNAPSHOT, 'test-writer', sessions)).toEqual({
      maxBudgetUsd: 0.06,
      maxTurns: 7,
    });
    // implementer: USD min(0.25 - 0.17, 0.3 - 0.21) = 0.08 (역할), 턴 min(15 - 9, 20 - 12) = 6 (역할)
    expect(sessionLimits(SNAPSHOT, 'implementer', sessions)).toEqual({
      maxBudgetUsd: 0.08,
      maxTurns: 6,
    });
    // 실행 잔여가 더 작은 경우
    const more = [...sessions, session('implementer', 0.05, 7)];
    // implementer: USD min(0.25 - 0.22, 0.3 - 0.26) = 0.03 (역할), 턴 min(15 - 16, ...) ≤ 0 → 소진
    expect(sessionLimits(SNAPSHOT, 'implementer', more)).toBeNull();
    // test-writer: USD min(0.06, 0.3 - 0.26 = 0.04) = 0.04 (실행), 턴 min(7, 20 - 19 = 1) = 1 (실행)
    expect(sessionLimits(SNAPSHOT, 'test-writer', more)).toEqual({
      maxBudgetUsd: 0.04,
      maxTurns: 1,
    });
    // 스냅샷에 없는 역할은 설정 미비
    expect(sessionLimits(SNAPSHOT, 'planner', [])).toBeUndefined();
  });

  it('값을 모르는 세션은 한도 계산에서 0이 아니다: 아는 세션의 최댓값(세션 한도로 자름), 없으면 세션 한도 전부', () => {
    const budget = { maxBudgetUsd: 0.05, maxTurns: 6 };
    const aborted = (role: AgentRole, extra: Partial<Session> = {}): Session =>
      session(role, null, null, {}, { endReason: 'aborted', budget, ...extra });
    // 아는 세션이 없으면 세션 한도 전부를 쓴 것
    expect(sessionLimits(SNAPSHOT, 'test-writer', [aborted('test-writer')])).toEqual({
      maxBudgetUsd: 0.05,
      maxTurns: 4,
    });
    // 아는 세션이 있으면 그 최댓값 (0.04, 3턴)
    const known = session('implementer', 0.04, 3);
    expect(sessionLimits(SNAPSHOT, 'test-writer', [known, aborted('test-writer')])).toEqual({
      maxBudgetUsd: 0.06,
      maxTurns: 7,
    });
    // 최댓값이 세션 한도보다 크면 세션 한도로 자른다 (0.17 → 0.05, 9턴 → 6턴)
    expect(
      sessionLimits(SNAPSHOT, 'test-writer', [
        session('implementer', 0.17, 9),
        aborted('test-writer'),
      ]),
    ).toEqual({ maxBudgetUsd: 0.05, maxTurns: 4 });
    // 중단 · 재개를 되풀이할 때마다 잔여가 줄어 결국 소진된다 (0으로 세지 않음, NFR-07)
    const history = [known];
    const remaining: (number | undefined)[] = [];
    for (let i = 0; i < 3; i += 1) {
      history.push(aborted('test-writer'));
      remaining.push(sessionLimits(SNAPSHOT, 'test-writer', history)?.maxBudgetUsd);
    }
    expect(remaining).toEqual([0.06, 0.02, undefined]);
    expect(sessionLimits(SNAPSHOT, 'test-writer', history)).toBeNull();
    // init 없이 끝난 세션은 모델 호출 전이므로 0
    expect(
      sessionLimits(SNAPSHOT, 'test-writer', [
        session('test-writer', null, null, {}, { sdkSessionId: null, budget }),
      ]),
    ).toEqual({ maxBudgetUsd: 0.1, maxTurns: 10 });
    // 한도 기록이 없는(이전) 세션은 역할 스냅샷 한도를 쓴 것
    expect(sessionLimits(SNAPSHOT, 'implementer', [session('test-writer', null, null)])).toEqual({
      maxBudgetUsd: 0.2,
      maxTurns: 10,
    });
  });

  it('집계 초과는 합계가 한도보다 클 때만이고, 역할 → 실행 · USD → 턴 순으로 첫 1건이다', () => {
    // 같으면 넘은 것이 아니다 (0.04 + 0.06 = 0.1)
    expect(
      budgetOverrun(SNAPSHOT, 'test-writer', [
        session('test-writer', 0.04, 5),
        session('test-writer', 0.06, 5),
      ]),
    ).toBeNull();
    expect(
      budgetOverrun(SNAPSHOT, 'test-writer', [
        session('test-writer', 0.04, 5),
        session('test-writer', 0.0600001, 5),
      ]),
    ).toEqual({
      scope: 'role',
      measure: 'usd',
      role: 'test-writer',
      limit: 0.1,
      spent: 0.1000001,
      known: 0.1000001,
      estimated: 0,
      unknownSessions: 0,
    });
    expect(budgetOverrun(SNAPSHOT, 'test-writer', [session('test-writer', 0.01, 11)])).toEqual({
      scope: 'role',
      measure: 'turns',
      role: 'test-writer',
      limit: 10,
      spent: 11,
      known: 11,
      estimated: 0,
      unknownSessions: 0,
    });
    // 역할 한도 안이지만 실행 합계가 넘음
    expect(
      budgetOverrun(SNAPSHOT, 'implementer', [
        session('test-writer', 0.09, 2),
        session('implementer', 0.22, 2),
      ]),
    ).toEqual({
      scope: 'run',
      measure: 'usd',
      role: 'implementer',
      limit: 0.3,
      spent: 0.31,
      known: 0.31,
      estimated: 0,
      unknownSessions: 0,
    });
    // 값을 모르는 세션은 추정값으로 센다 (아는 세션이 없고 한도 기록도 없으면 역할 한도 전부 = 같음, 넘지 않음)
    expect(budgetOverrun(SNAPSHOT, 'implementer', [session('implementer', null, null)])).toBeNull();
  });

  it('리뷰 재현: 아는 세션이 모두 0 USD · 0턴이어도 결과 없이 끝난 세션은 턴을 최소 1로 세어 결국 소진된다', () => {
    // 첫 API 요청 실패 같은 결과 (error_during_execution, 0 USD, 0턴)
    const failedFirst = session('test-writer', 0, 0, {}, { endReason: 'error_during_execution' });
    const history: Session[] = [failedFirst];
    const limits: (ReturnType<typeof sessionLimits> | undefined)[] = [];
    for (let i = 0; i < 50; i += 1) {
      history.push(
        session(
          'implementer',
          null,
          null,
          {},
          {
            endReason: 'aborted',
            budget: { maxBudgetUsd: 0.25, maxTurns: 15 },
          },
        ),
      );
      limits.push(sessionLimits(SNAPSHOT, 'implementer', history));
    }
    // 매번 턴 1씩 줄고(USD 추정은 0), 15번째에 소진된다
    expect(limits.slice(0, 3)).toEqual([
      { maxBudgetUsd: 0.25, maxTurns: 14 },
      { maxBudgetUsd: 0.25, maxTurns: 13 },
      { maxBudgetUsd: 0.25, maxTurns: 12 },
    ]);
    expect(limits[13]).toEqual({ maxBudgetUsd: 0.25, maxTurns: 1 });
    expect(limits[14]).toBeNull();
    expect(limits.slice(14).every((limit) => limit === null)).toBe(true);
  });

  it('남은 USD는 한도를 나노 달러 단위로 내려 계산한다 (반올림으로 커지지 않음)', () => {
    const tiny = {
      run: { maxBudgetUsd: 6e-10, maxTurns: 10 },
      roles: { 'test-writer': { maxBudgetUsd: 1, maxTurns: 10 } },
    };
    expect(sessionLimits(tiny, 'test-writer', [])).toBeNull();
    expect(remainingUsd(0.1, 0.04)).toBe(0.06);
    expect(remainingUsd(2, 0.0421)).toBe(1.9579);
    expect(remainingUsd(0.3, 0.1 + 0.2)).toBe(0);
  });

  it('집계 초과의 종료 결과는 보고된 합 · 추정분 · 값을 모르는 세션 수를 나눠 싣고, 추정분은 소급해 커질 수 있다', () => {
    const budget = { maxBudgetUsd: 0.24, maxTurns: 14 };
    // test-writer 0.01 · 1턴 성공 → implementer aborted (추정 0.01 · 1턴) → 재개 세션이 한도 안 0.2로 성공
    const history = [
      session('test-writer', 0.01, 1),
      session('implementer', null, null, {}, { endReason: 'aborted', budget }),
    ];
    expect(sessionLimits(SNAPSHOT, 'implementer', history)).toEqual({
      maxBudgetUsd: 0.24,
      maxTurns: 14,
    });
    history.push(session('implementer', 0.2, 3));
    // 아는 최댓값이 0.2로 커져 앞선 aborted 추정이 0.2가 된다: 역할 합 0.4 > 0.25 (ADR-067 한계)
    expect(budgetOverrun(SNAPSHOT, 'implementer', history)).toEqual({
      scope: 'role',
      measure: 'usd',
      role: 'implementer',
      limit: 0.25,
      spent: 0.4,
      known: 0.2,
      estimated: 0.2,
      unknownSessions: 1,
    });
  });
});

// ── 엔진 경로 ──────────────────────────────────────────────

interface CapturedBudget extends SessionBudget {
  role: AgentRole;
}

interface Harness extends SeededProject {
  biveHome: string;
  repo: string;
  runId: string;
  engine: PipelineEngine;
  /** 엔진이 세션마다 넘긴 한도 (어댑터가 받은 값) */
  budgets: CapturedBudget[];
}

interface SetupOptions {
  scenario?: string;
  settings?: SettingsPatch;
  executors?: StepExecutors;
  /** ScriptedAdapter를 감싼다 (한도 기록은 그 바깥에서 한다) */
  wrap?: (adapter: AgentAdapter) => AgentAdapter;
}

const setup = (options: SetupOptions = {}): Harness => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const seeded = seedProject(biveHome, repo, options.settings);
  const scripted = new ScriptedAdapter({
    scenario: loadScenario(options.scenario ?? 'happy-path'),
    biveHome,
    pollIntervalMs: 20,
  });
  const inner = options.wrap?.(scripted) ?? scripted;
  const budgets: CapturedBudget[] = [];
  const adapter: AgentAdapter = {
    kind: inner.kind,
    startSession: (spec) => {
      budgets.push({ role: spec.role, ...spec.budget });
      return inner.startSession(spec);
    },
  };
  const engine = new PipelineEngine({
    biveHome,
    agent: adapter,
    executors: testExecutors(options.executors),
  });
  engines.push(engine);
  const runId = withProject(biveHome, seeded.project.id, (store) =>
    createRun(
      store,
      { ruleIds: [seeded.rule.id], author: human },
      { clientId: null },
      { now: Date.now, newId },
    ),
  ).run.id;
  return { ...seeded, biveHome, repo, runId, engine, budgets };
};

const runToEnd = async (h: Harness): Promise<RunDetail> => {
  expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
  await h.engine.settled();
  return withProject(h.biveHome, h.project.id, (store) => {
    const detail = store.runs.getDetail(h.runId);
    if (detail === null) throw new Error('실행 없음');
    return detail;
  });
};

const sessionsOf = (h: Harness): Session[] =>
  withProject(h.biveHome, h.project.id, (store) => store.sessions.listByRun(h.runId));

const stepOf = (detail: RunDetail, kind: StepKind, attempt = 1): Step => {
  const step = detail.steps.find((s) => s.kind === kind && s.attempt === attempt);
  if (step === undefined) throw new Error(`단계 없음: ${kind}#${String(attempt)}`);
  return step;
};

/** `run.get` 처리기 결과 (프로토콜 결과 스키마로 검증한다). */
const runGet = async (h: Harness) => {
  const handler = createRunHandlers({ biveHome: h.biveHome, now: Date.now })['run.get'];
  if (handler === undefined) throw new Error('run.get 처리기 없음');
  const result = await handler({ projectId: h.project.id, id: 'EXE-001' }, { connectionId: 1 });
  return METHODS['run.get'].result.parse(result);
};

/** 첫 테스트 작성 시도는 미충족으로 돌려 같은 역할 세션을 2개 만든다 (단계 시도별 합계 확인용). */
const retryOnceTestWriting = (): StepExecutor => {
  let calls = 0;
  return async (context) => {
    const ruleId = context.read((store) => store.rules.get(context.run.targetRuleIds[0] ?? ''));
    const result = await context.runSession({
      workDir: context.git.worktreePath,
      systemPrompt: '예산 시험',
      prompt: '예산 시험',
      vars: { ruleId: ruleId?.displayId ?? '' },
    });
    calls += 1;
    if (calls === 1 || result.endReason !== 'success') return { status: 'unmet' };
    return hasAcceptanceTest(context.git.worktreePath) ? { status: 'passed' } : { status: 'unmet' };
  };
};

/** 역할의 세션 이벤트를 바꾸는 래퍼 (`index`는 그 역할의 몇 번째 세션인지, 0부터). */
const rewrite =
  (
    role: AgentRole,
    fn: (events: AsyncIterable<SessionEvent>, index: number) => AsyncGenerator<SessionEvent>,
  ) =>
  (inner: AgentAdapter): AgentAdapter => {
    let index = 0;
    return {
      kind: inner.kind,
      startSession: (spec) => {
        if (spec.role !== role) return inner.startSession(spec);
        const current = index;
        index += 1;
        return fn(inner.startSession(spec), current);
      },
    };
  };

const report = (
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number,
  cacheCreationInputTokens: number,
  costUSD: number,
): ModelUsageReport => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens,
  cacheCreationInputTokens,
  costUSD,
});

const totals = (
  costUsd: number | null,
  turns: number | null,
  modelUsage: UsageTotals['modelUsage'],
  sessionCount: number,
  unknown = 0,
): UsageTotals => ({
  costUsd,
  turns,
  modelUsage,
  sessionCount,
  costUnknownCount: unknown,
  turnsUnknownCount: unknown,
});

describe('세션 결과 저장 · 단계 → 역할 → 실행 합산 (수용 기준 1)', () => {
  it('세션 결과의 마지막 total_cost_usd · modelUsage · num_turns를 저장하고 단계 시도 · 역할 · 실행 순으로 더한다', async () => {
    const h = setup({
      executors: { test_writing: retryOnceTestWriting() },
      wrap: (adapter) =>
        // 구현 세션은 모델 2개를 쓴 결과로 바꾼다 (합계 0.0587은 그대로)
        rewrite('implementer', async function* (events) {
          for await (const event of events) {
            yield event.type === 'result'
              ? {
                  ...event,
                  modelUsage: {
                    'model-a': report(2000, 800, 9800, 7400, 0.04),
                    'model-b': report(1120, 380, 0, 0, 0.0187),
                  },
                }
              : event;
          }
        })(
          // 첫 테스트 작성 세션은 최종 결과 앞에 중간 결과를 하나 더 낸다: 저장은 마지막 결과의 값이다(더하지 않음)
          rewrite('test-writer', async function* (events, index) {
            for await (const event of events) {
              if (event.type === 'result' && index === 0) {
                yield {
                  ...event,
                  total_cost_usd: 0.01,
                  num_turns: 1,
                  modelUsage: { 'model-a': report(500, 100, 0, 0, 0.01) },
                };
              }
              yield event;
            }
          })(adapter),
        ),
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'merged', failureReason: null });

    // 세션 결과 저장 (SDK 필드 → 저장 필드, modelUsage의 costUSD → costUsd)
    const testWriterUsage: ModelUsage = {
      inputTokens: 2310,
      outputTokens: 940,
      cacheReadInputTokens: 4100,
      cacheCreationInputTokens: 6050,
      costUsd: 0.0421,
    };
    const sessions = sessionsOf(h);
    expect(
      sessions.map((s) => [s.role, s.endReason, s.totalCostUsd, s.numTurns, s.modelUsage]),
    ).toEqual([
      ['test-writer', 'success', 0.0421, 2, { 'model-a': testWriterUsage }],
      ['test-writer', 'success', 0.0421, 2, { 'model-a': testWriterUsage }],
      [
        'implementer',
        'success',
        0.0587,
        3,
        {
          'model-a': { ...testWriterUsage, ...usageOf(2000, 800, 9800, 7400, 0.04) },
          'model-b': usageOf(1120, 380, 0, 0, 0.0187),
        },
      ],
    ]);
    const [tw1, tw2, impl] = sessions;
    expect(tw1?.stepId).toBe(stepOf(done, 'test_writing', 1).id);
    expect(tw2?.stepId).toBe(stepOf(done, 'test_writing', 2).id);
    expect(impl?.stepId).toBe(stepOf(done, 'implementation', 1).id);

    // 조회 시점 집계 (run.get의 usage)
    const got = await runGet(h);
    expect(got.run).toEqual(done.run);
    expect(got.steps).toEqual(done.steps);
    const twTotals = { 'model-a': usageOf(2310, 940, 4100, 6050, 0.0421) };
    expect(got.usage.steps).toEqual([
      {
        stepId: stepOf(done, 'test_writing', 1).id,
        kind: 'test_writing',
        attempt: 1,
        role: 'test-writer',
        ...totals(0.0421, 2, twTotals, 1),
      },
      {
        stepId: stepOf(done, 'test_writing', 2).id,
        kind: 'test_writing',
        attempt: 2,
        role: 'test-writer',
        ...totals(0.0421, 2, twTotals, 1),
      },
      {
        stepId: stepOf(done, 'implementation', 1).id,
        kind: 'implementation',
        attempt: 1,
        role: 'implementer',
        ...totals(
          0.0587,
          3,
          {
            'model-a': usageOf(2000, 800, 9800, 7400, 0.04),
            'model-b': usageOf(1120, 380, 0, 0, 0.0187),
          },
          1,
        ),
      },
    ]);
    expect(got.usage.roles).toEqual({
      'test-writer': totals(0.0842, 4, { 'model-a': usageOf(4620, 1880, 8200, 12100, 0.0842) }, 2),
      implementer: totals(
        0.0587,
        3,
        {
          'model-a': usageOf(2000, 800, 9800, 7400, 0.04),
          'model-b': usageOf(1120, 380, 0, 0, 0.0187),
        },
        1,
      ),
    });
    expect(got.usage.run).toEqual(
      totals(
        0.1429,
        7,
        {
          'model-a': usageOf(6620, 2680, 18000, 19500, 0.1242),
          'model-b': usageOf(1120, 380, 0, 0, 0.0187),
        },
        3,
      ),
    );
    // 단계 → 역할 → 실행: 아래 합계가 위 합계와 같다
    for (const role of ['test-writer', 'implementer'] as const) {
      const steps = got.usage.steps.filter((step) => step.role === role);
      expect(sumUsd(steps.map((step) => step.costUsd))).toBe(got.usage.roles[role]?.costUsd);
    }
    expect(sumUsd(Object.values(got.usage.roles).map((role) => role.costUsd))).toBe(
      got.usage.run.costUsd,
    );

    // 기록: 단계 시도는 끝나는 저장 때, 실행은 저장마다 세션 합계를 남긴다
    expect([done.run.costUsd, done.run.turns]).toEqual([0.1429, 7]);
    expect(
      done.steps.map((step) => [`${step.kind}#${String(step.attempt)}`, step.costUsd]),
    ).toEqual([
      ['approval#1', null],
      ['test_writing#1', 0.0421],
      ['test_writing#2', 0.0421],
      ['red_check#1', null],
      ['implementation#1', 0.0587],
      ['check#1', null],
      ['mutation#1', null],
      ['merge#1', null],
      ['screen_update#1', null],
    ]);
    expect(stepOf(done, 'implementation').turns).toBe(3);

    // 같은 역할의 다음 세션 한도는 역할 잔여를 쓴다: 2 - 0.0421, 100 - 2
    expect(h.budgets).toEqual([
      { role: 'test-writer', maxBudgetUsd: 2, maxTurns: 100 },
      { role: 'test-writer', maxBudgetUsd: 1.9579, maxTurns: 98 },
      { role: 'implementer', maxBudgetUsd: 2, maxTurns: 100 },
    ]);
  }, 90_000);
});

/** 저장 필드 이름의 모델별 사용량. */
function usageOf(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number,
  cacheCreationInputTokens: number,
  costUsd: number | null,
): ModelUsage {
  return { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUsd };
}

/** init만 내고 결과 없이 어댑터 오류로 끝나는 세션 (모델 호출이 있었을 수 있으나 비용 · 턴을 모름). */
const failAfterInit = async function* (
  events: AsyncIterable<SessionEvent>,
): AsyncGenerator<SessionEvent> {
  for await (const event of events) {
    if (event.type === 'init') {
      yield event;
      throw new Error('어댑터 오류 (시험)');
    }
  }
};

/** init 전에 어댑터 오류로 끝나는 세션 (모델 호출 전, 예: 인증 미설정). */
const failBeforeInit = async function* (): AsyncGenerator<SessionEvent> {
  yield* [];
  throw new Error('어댑터 시작 실패 (시험)');
};

const passThrough = async function* (
  events: AsyncIterable<SessionEvent>,
): AsyncGenerator<SessionEvent> {
  yield* events;
};

describe('값이 없는 세션 (수용 기준 2 · 집계와 한도의 차이)', () => {
  it('결과 없이 끝난 세션은 null로 저장되고 합계에 0으로 더해지지 않으며, 다음 한도에서는 아는 최댓값만큼 뺀다', async () => {
    const h = setup({
      executors: {
        implementation: async (context) => {
          const result = await context.runSession({
            workDir: context.git.worktreePath,
            systemPrompt: '예산 시험',
            prompt: '예산 시험',
          });
          return result.endReason === 'success' ? { status: 'passed' } : { status: 'unmet' };
        },
      },
      wrap: rewrite('implementer', (events, index) =>
        index === 0 ? failAfterInit(events) : passThrough(events),
      ),
    });
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    const failed = sessionsOf(h).filter((s) => s.role === 'implementer')[0];
    expect(failed).toMatchObject({
      endReason: 'error_during_execution',
      totalCostUsd: null,
      numTurns: null,
      modelUsage: {},
      budget: { maxBudgetUsd: 2, maxTurns: 100 },
    });
    expect(failed?.sdkSessionId).not.toBeNull();
    const got = await runGet(h);
    expect(
      got.usage.steps.map((step) => [step.kind, step.attempt, step.costUsd, step.turns]),
    ).toEqual([
      ['test_writing', 1, 0.0421, 2],
      ['implementation', 1, null, null],
      ['implementation', 2, 0.0587, 3],
    ]);
    expect(got.usage.roles.implementer).toMatchObject({
      costUsd: 0.0587,
      turns: 3,
      sessionCount: 2,
      costUnknownCount: 1,
      turnsUnknownCount: 1,
    });
    expect(got.usage.run).toMatchObject({ costUsd: 0.1008, turns: 5, costUnknownCount: 1 });
    expect(stepOf(done, 'implementation', 1)).toMatchObject({
      status: 'failed',
      costUsd: null,
      turns: null,
    });
    expect([done.run.costUsd, done.run.turns]).toEqual([0.1008, 5]);
    // 한도 계산에서는 값을 모르는 세션을 아는 세션의 최댓값(0.0421, 2턴)으로 센다: 2 - 0.0421, 100 - 2
    expect(h.budgets).toEqual([
      { role: 'test-writer', maxBudgetUsd: 2, maxTurns: 100 },
      { role: 'implementer', maxBudgetUsd: 2, maxTurns: 100 },
      { role: 'implementer', maxBudgetUsd: 1.9579, maxTurns: 98 },
    ]);
  }, 90_000);

  it('모든 세션의 값이 없으면 단계 · 역할 · 실행 합계도 null이다 (init 전 실패는 한도에서 0)', async () => {
    const h = setup({ wrap: rewrite('test-writer', () => failBeforeInit()) });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'test_retry_limit',
      costUsd: null,
      turns: null,
    });
    expect(sessionsOf(h).map((s) => [s.sdkSessionId, s.totalCostUsd, s.numTurns])).toEqual([
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ]);
    const got = await runGet(h);
    expect(got.usage.run).toEqual(totals(null, null, null, 3, 3));
    expect(got.usage.roles).toEqual({
      'test-writer': totals(null, null, null, 3, 3),
      // 세션이 없는 역할도 null (0이 아님)
      implementer: totals(null, null, null, 0),
    });
    expect(got.usage.steps.map((step) => [step.kind, step.costUsd, step.turns])).toEqual([
      ['test_writing', null, null],
      ['test_writing', null, null],
      ['test_writing', null, null],
      ['implementation', null, null],
    ]);
    expect(done.steps.every((step) => step.costUsd === null && step.turns === null)).toBe(true);
    // 모델 호출 전에 끝난 세션은 한도에서 빼지 않는다
    expect(h.budgets.map((b) => b.maxBudgetUsd)).toEqual([2, 2, 2]);
  }, 90_000);

  it('아는 값이 없을 때 init 뒤 결과 없이 끝난 세션은 그 세션 한도를 다 쓴 것으로 보고, 다음 세션을 열지 않는다', async () => {
    const h = setup({
      wrap: rewrite('test-writer', (events, index) =>
        index === 0 ? failAfterInit(events) : passThrough(events),
      ),
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'budget_exceeded',
      failureReason: 'budget_exhausted',
      currentStep: 'test_writing',
      costUsd: null,
    });
    expect(sessionsOf(h)).toHaveLength(1);
    expect(h.budgets).toEqual([{ role: 'test-writer', maxBudgetUsd: 2, maxTurns: 100 }]);
  }, 90_000);
});

describe('세션 한도 · 예산 초과 (수용 기준 3 · 4)', () => {
  const expectStopped = (h: Harness, done: RunDetail, initialMain: string): void => {
    // 세션 중단: 구현 세션은 1개뿐이고 다음 단계로 가지 않는다
    expect(sessionsOf(h).filter((s) => s.role === 'implementer')).toHaveLength(1);
    expect(stepOf(done, 'implementation')).toMatchObject({ status: 'failed' });
    expect(stepOf(done, 'check')).toMatchObject({ status: 'pending' });
    expect(done.steps.filter((step) => step.kind === 'implementation')).toHaveLength(1);
    // 브랜치 · 워크트리 보존, 병합 없음 (RUN-08, COST-01)
    expect(done.run).toMatchObject({ mergeCommit: null, currentStep: 'implementation' });
    expect(done.run.endedAt).not.toBeNull();
    expect(userGit(h.repo, 'rev-parse', 'refs/heads/main')).toBe(initialMain);
    expect(userGit(h.repo, 'branch', '--list', 'bive/run-EXE-001')).toContain('bive/run-EXE-001');
  };

  it('실행 잔여가 작으면 그 값이 세션 USD 한도이고, error_max_budget_usd면 실행이 budget_exceeded', async () => {
    const h = setup({
      settings: { ...COMPLETE_SETTINGS, run: { maxBudgetUsd: 0.08, maxTurns: 200 } },
    });
    const initialMain = userGit(h.repo, 'rev-parse', 'refs/heads/main');
    const done = await runToEnd(h);
    // test-writer: min(2, 0.08), implementer: min(2 - 0, 0.08 - 0.0421) = 0.0379
    expect(h.budgets).toEqual([
      { role: 'test-writer', maxBudgetUsd: 0.08, maxTurns: 100 },
      { role: 'implementer', maxBudgetUsd: 0.0379, maxTurns: 100 },
    ]);
    expect(done.run).toMatchObject({
      status: 'budget_exceeded',
      failureReason: 'error_max_budget_usd',
    });
    expect(stepOf(done, 'implementation').exitDetail).toMatchObject({
      reason: 'error_max_budget_usd',
    });
    expectStopped(h, done, initialMain);
    // 한도에서 멈춘 세션의 비용도 기록 · 합산된다
    expect(sessionsOf(h).map((s) => [s.endReason, s.totalCostUsd])).toEqual([
      ['success', 0.0421],
      ['error_max_budget_usd', 0.0587],
    ]);
    expect([done.run.costUsd, stepOf(done, 'implementation').costUsd]).toEqual([0.1008, 0.0587]);
  }, 90_000);

  it('역할 잔여가 작으면 그 값이 USD 한도이고, 턴은 실행 잔여가 작으면 그 값이다 (error_max_turns → budget_exceeded)', async () => {
    const h = setup({
      settings: {
        ...COMPLETE_SETTINGS,
        run: { maxBudgetUsd: 5, maxTurns: 4 },
        roles: {
          ...COMPLETE_SETTINGS.roles,
          implementer: { model: 'test-model', maxBudgetUsd: 0.06, maxTurns: 100 },
        },
      },
    });
    const initialMain = userGit(h.repo, 'rev-parse', 'refs/heads/main');
    const done = await runToEnd(h);
    // implementer: USD min(0.06, 5 - 0.0421) = 0.06 (역할), 턴 min(100, 4 - 2) = 2 (실행)
    expect(h.budgets).toEqual([
      { role: 'test-writer', maxBudgetUsd: 2, maxTurns: 4 },
      { role: 'implementer', maxBudgetUsd: 0.06, maxTurns: 2 },
    ]);
    expect(done.run).toMatchObject({ status: 'budget_exceeded', failureReason: 'error_max_turns' });
    expectStopped(h, done, initialMain);
  }, 90_000);

  it('budget-exceeded 시나리오: 구현 결과 subtype error_max_budget_usd → budget_exceeded, 브랜치 보존 · 병합 없음', async () => {
    const h = setup({ scenario: 'budget-exceeded' });
    const initialMain = userGit(h.repo, 'rev-parse', 'refs/heads/main');
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'budget_exceeded',
      failureReason: 'error_max_budget_usd',
    });
    expectStopped(h, done, initialMain);
    expect(sessionsOf(h).map((s) => [s.role, s.endReason, s.totalCostUsd, s.numTurns])).toEqual([
      ['test-writer', 'success', 0.0398, 2],
      ['implementer', 'error_max_budget_usd', 0.0731, 4],
    ]);
    const got = await runGet(h);
    expect(got.usage.run).toMatchObject({ costUsd: 0.1129, turns: 6 });
    expect(got.usage.roles.implementer).toMatchObject({ costUsd: 0.0731, turns: 4 });
  }, 90_000);

  it('결과가 성공이어도 세션 뒤 실행 합계가 한도를 넘으면(집계 초과) 세션을 끝으로 budget_exceeded', async () => {
    const h = setup({
      settings: { ...COMPLETE_SETTINGS, run: { maxBudgetUsd: 0.08, maxTurns: 200 } },
      // 어댑터가 한도를 지키지 않은 경우(한도를 넘겨 성공으로 끝남)를 재현한다
      wrap: (inner) => ({
        kind: inner.kind,
        startSession: (spec) =>
          inner.startSession({ ...spec, budget: { maxBudgetUsd: 100, maxTurns: 1000 } }),
      }),
    });
    const initialMain = userGit(h.repo, 'rev-parse', 'refs/heads/main');
    const done = await runToEnd(h);
    expect(h.budgets.map((b) => b.maxBudgetUsd)).toEqual([0.08, 0.0379]);
    const [, impl] = sessionsOf(h);
    expect(impl).toMatchObject({ role: 'implementer', endReason: 'success', totalCostUsd: 0.0587 });
    expect(done.run).toMatchObject({
      status: 'budget_exceeded',
      failureReason: 'budget_aggregate_exceeded',
      costUsd: 0.1008,
    });
    expect(stepOf(done, 'implementation').exitDetail).toEqual({
      reason: 'budget_aggregate_exceeded',
      detail: {
        sessionId: impl?.id,
        scope: 'run',
        measure: 'usd',
        role: 'implementer',
        limit: 0.08,
        spent: 0.1008,
        known: 0.1008,
        estimated: 0,
        unknownSessions: 0,
      },
    });
    expectStopped(h, done, initialMain);
  }, 90_000);
});
