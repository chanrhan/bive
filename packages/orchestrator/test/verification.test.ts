// 검증 화면 요약 RPC (M1-18 수용 기준 1, JDG-03 · COST-02 · SCR-05 · ADR-072).
// `verification.summary`가 판정 기준 커밋, 준수(통과 수 · 판정 가능 수), 분모 목록, 실행당 비용(없으면 null)과
// 규칙별 최신 판정 · 실행 링크(비용 합계 · 턴), 최근 실행의 파이프라인을 돌려주는지 본다.
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소. 데이터는 저장소에 바로 넣는다(테스트 전용).
import {
  type Author,
  createUlidGenerator,
  ErrorCode,
  type JudgmentResult,
  type Rule,
  RUN_STEP_PLANS,
  type Run,
  type RunStatus,
  type SettingsPatch,
  type Step,
  type StepKind,
  type Ulid,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PipeServer } from '../src/ipc/server.js';
import { createRun } from '../src/runs/run-service.js';
import { costPerRun, pipelineOf } from '../src/verification/summary.js';
import type { TestClient } from './helpers/client.js';
import { cleanup } from './helpers/process.js';
import { iso, startProjectHarness, T0, type ProjectHarness } from './helpers/project-harness.js';

const human = { kind: 'human' } as const satisfies Author;
const newId = createUlidGenerator();

const COMPLETE: SettingsPatch = {
  run: { maxBudgetUsd: 5, maxTurns: 200 },
  roles: {
    'rule-writer': { model: 'test-model', maxBudgetUsd: 1, maxTurns: 20 },
    'test-writer': { model: 'test-model', maxBudgetUsd: 2, maxTurns: 100 },
    implementer: { model: 'impl-model', maxBudgetUsd: 3, maxTurns: 150 },
  },
};

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const servers: PipeServer[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  await cleanup();
});

let h: ProjectHarness;
beforeEach(async () => {
  h = await startProjectHarness({ servers, clients });
  h.read((store) => store.settings.update(COMPLETE, { by: human, at: iso(T0) }));
});

const summary = () => h.client.call('verification.summary', { projectId: h.project.id });

/** 규칙을 저장소에 바로 넣는다 (잠정 승인처럼 RPC로 만들 수 없는 상태용). */
const insertRule = (store: ProjectStore, title: string, normState: Rule['normState']): Rule => {
  const requirement = store.requirements.create({
    id: newId(),
    text: `${title} 요구사항`,
    author: human,
    normState: 'approved',
    createdAt: iso(T0),
  });
  return store.rules.create({
    id: newId(),
    title,
    statement: `WHEN ${title} THE SYSTEM SHALL 요청을 거부한다`,
    kind: 'business',
    checkKinds: ['test'],
    parentRequirementId: requirement.id,
    builtin: false,
    targetBlockIds: [],
    risk: null,
    contractId: null,
    author: { kind: 'agent', role: 'rule-writer' },
    normState,
    createdAt: iso(T0),
  });
};

const stepOf = (steps: readonly Step[], kind: StepKind): Step => {
  const step = steps.find((s) => s.kind === kind);
  if (step === undefined) throw new Error(`단계 없음: ${kind}`);
  return step;
};

interface RunSeed {
  ruleIds: Ulid[];
  at: number;
  /** 테스트 작성 단계 세션의 비용 · 턴 (`null`이면 결과 없이 끝난 세션) */
  sessions?: { costUsd: number | null; turns: number | null }[];
  /** 끝 상태 (생략하면 승인 대기 그대로) */
  status?: Exclude<RunStatus, 'waiting_approval'>;
  mergeCommit?: string;
}

/** 실행을 만들고 세션 · 상태를 저장소에 바로 남긴다 (엔진 없이 저장 형태만 만든다). */
const seedRun = (store: ProjectStore, seed: RunSeed): Run => {
  const created = createRun(
    store,
    { ruleIds: seed.ruleIds, author: human },
    { clientId: null },
    { now: () => seed.at, newId },
  );
  const runId = created.run.id;
  if (seed.status === undefined) return created.run;
  const testWriting = stepOf(created.steps, 'test_writing');
  store.runs.transition(runId, {
    run: { status: 'running', currentStep: 'test_writing', startedAt: iso(seed.at) },
    steps: [
      { id: stepOf(created.steps, 'approval').id, status: 'passed', endedAt: iso(seed.at) },
      { id: testWriting.id, status: 'running', startedAt: iso(seed.at) },
    ],
  });
  for (const session of seed.sessions ?? []) {
    const id = newId();
    store.sessions.start({
      id,
      runId,
      stepId: testWriting.id,
      role: 'test-writer',
      model: 'test-model',
      workDir: '/work/session',
      startedAt: iso(seed.at),
    });
    store.sessions.end(id, {
      endReason: session.costUsd === null ? 'aborted' : 'success',
      totalCostUsd: session.costUsd,
      numTurns: session.turns,
      endedAt: iso(seed.at + 1_000),
    });
  }
  if (seed.status === 'running') return store.runs.get(runId) as Run;
  const end = iso(seed.at + 2_000);
  return store.runs.transition(runId, {
    run: {
      status: seed.status,
      ...(seed.status === 'interrupted'
        ? {}
        : { currentStep: null, endedAt: end, mergeCommit: seed.mergeCommit ?? null }),
    },
    steps: [
      {
        id: testWriting.id,
        status: seed.status === 'interrupted' ? 'failed' : 'passed',
        endedAt: end,
      },
    ],
  }).run;
};

/** 판정 기록이 가리키는 실행 · 단계 시도 (실행 밖 판정이면 `null`). */
type JudgedIn = { runId: Ulid; stepId: Ulid } | null;

const judgedIn = (store: ProjectStore, run: Run): JudgedIn => ({
  runId: run.id,
  stepId: stepOf(store.runs.steps(run.id), 'test_writing').id,
});

const judgment = (
  rule: Rule,
  status: JudgmentResult['status'],
  where: JudgedIn,
  at: number,
  commit = SHA_A,
): JudgmentResult => ({
  id: newId(),
  ruleId: rule.id,
  runId: where?.runId ?? null,
  stepId: where?.stepId ?? null,
  commit,
  judgedAt: iso(at),
  status,
  runner: 'vitest',
  exitCode: status === 'pass' ? 0 : 1,
  reporterPath: null,
  cases: [],
  quarantineReason: status === 'quarantined' ? '불안정한 외부 호출' : null,
});

describe('verification.summary', () => {
  it('규칙 · 실행이 없으면 판정 기준 · 실행당 비용 · 파이프라인이 null이고 준수는 0 / 0', async () => {
    expect(await summary()).toEqual({
      basis: null,
      compliance: { passed: 0, judgeable: 0 },
      denominator: [],
      costPerRunUsd: null,
      rules: [],
      pipeline: null,
    });
  });

  it('판정 기준 커밋, 준수(통과 / 판정 가능), 분모 목록, 실행당 비용, 규칙별 최신 판정과 실행 링크를 돌려준다', async () => {
    const seeded = h.read((store) => {
      const passed = insertRule(store, '통과 규칙', 'approved');
      const failed = insertRule(store, '실패 규칙', 'approved');
      const fresh = insertRule(store, '판정 전 규칙', 'approved');
      const provisional = insertRule(store, '잠정 규칙', 'provisional');
      const quarantined = insertRule(store, '격리 규칙', 'approved');
      const all = [passed, failed, fresh, provisional, quarantined].map((rule) => rule.id);
      // EXE-001 병합(비용 0.1 + 0.2 · 턴 3 + 4), EXE-002 실패(값 모르는 세션 포함 → 평균에서 제외),
      // EXE-003 병합(0.1 · 2턴, 가장 최근 병합 → 판정 기준), EXE-004 진행 중(평균 제외)
      const run1 = seedRun(store, {
        ruleIds: all,
        at: T0 + 10_000,
        sessions: [
          { costUsd: 0.1, turns: 3 },
          { costUsd: 0.2, turns: 4 },
        ],
        status: 'merged',
        mergeCommit: SHA_A,
      });
      const run2 = seedRun(store, {
        ruleIds: [failed.id],
        at: T0 + 20_000,
        sessions: [
          { costUsd: 0.4, turns: 9 },
          { costUsd: null, turns: null },
        ],
        status: 'failed',
      });
      const run3 = seedRun(store, {
        ruleIds: [failed.id],
        at: T0 + 30_000,
        sessions: [{ costUsd: 0.1, turns: 2 }],
        status: 'merged',
        mergeCommit: SHA_B,
      });
      seedRun(store, {
        ruleIds: [fresh.id],
        at: T0 + 40_000,
        sessions: [{ costUsd: 3, turns: 50 }],
        status: 'running',
      });
      // 최신 판정: 통과 규칙 = 앞선 실패 뒤 통과(EXE-001), 실패 규칙 = EXE-001 통과 뒤 EXE-002 실패,
      // 잠정 규칙 = 통과(분모 밖), 격리 규칙 = 격리(분모 밖), 판정 전 규칙 = 기록 없음
      const in1 = judgedIn(store, run1);
      store.judgments.record([
        judgment(passed, 'fail', in1, T0 + 11_000),
        judgment(passed, 'pass', in1, T0 + 12_000),
        judgment(failed, 'pass', in1, T0 + 12_000),
        judgment(failed, 'fail', judgedIn(store, run2), T0 + 21_000, SHA_C),
        judgment(provisional, 'pass', in1, T0 + 12_000),
        judgment(quarantined, 'quarantined', null, T0 + 12_000),
      ]);
      return { passed, failed, fresh, provisional, quarantined, run1, run2, run3 };
    });

    const result = await summary();
    expect(result.basis).toEqual({ branch: 'main', commit: SHA_B, runId: seeded.run3.id });
    expect(result.compliance).toEqual({ passed: 1, judgeable: 3 });
    expect(result.denominator).toEqual([seeded.passed.id, seeded.failed.id, seeded.fresh.id]);
    // 끝난 실행 중 비용을 모두 아는 EXE-001(0.3) · EXE-003(0.1)의 평균
    expect(result.costPerRunUsd).toBe(0.2);

    const row = (rule: Rule) => result.rules.find((r) => r.rule.id === rule.id);
    expect(result.rules.map((r) => r.rule.id)).toEqual([
      seeded.passed.id,
      seeded.failed.id,
      seeded.fresh.id,
      seeded.provisional.id,
      seeded.quarantined.id,
    ]);
    expect(row(seeded.passed)).toMatchObject({
      judgment: { status: 'pass' },
      run: { id: seeded.run1.id, displayId: 'EXE-001', costUsd: 0.3, turns: 7 },
    });
    // 값 모르는 세션은 0으로 더하지 않는다: 아는 값만의 합 (ADR-067)
    expect(row(seeded.failed)).toMatchObject({
      judgment: { status: 'fail', latest: { commit: SHA_C } },
      run: { id: seeded.run2.id, displayId: 'EXE-002', costUsd: 0.4, turns: 9 },
    });
    expect(row(seeded.fresh)).toEqual({
      rule: seeded.fresh,
      judgment: { status: 'unjudged', latest: null },
      run: null,
    });
    // 실행 밖 판정은 실행 링크가 없다
    expect(row(seeded.quarantined)?.run).toBeNull();

    // 파이프라인 = 가장 최근에 만든 실행(EXE-004)의 단계 순서와 현재 단계
    expect(result.pipeline?.run).toMatchObject({
      displayId: 'EXE-004',
      status: 'running',
      currentStep: 'test_writing',
    });
    expect(result.pipeline?.stages.map((stage) => stage.kind)).toEqual([...RUN_STEP_PLANS.A]);
    expect(result.pipeline?.stages.slice(0, 3)).toEqual([
      { kind: 'approval', status: 'passed', attempt: 1 },
      { kind: 'test_writing', status: 'running', attempt: 1 },
      { kind: 'red_check', status: 'pending', attempt: 1 },
    ]);
  });

  it('실행 비용 값이 없으면 실행당 비용과 실행 링크의 비용 · 턴이 null이다', async () => {
    const rule = h.read((store) => {
      const created = insertRule(store, '규칙', 'approved');
      const run = seedRun(store, { ruleIds: [created.id], at: T0 + 10_000, status: 'failed' });
      store.judgments.record([judgment(created, 'fail', judgedIn(store, run), T0 + 11_000)]);
      return created;
    });
    const result = await summary();
    expect(result.costPerRunUsd).toBeNull();
    expect(result.basis).toBeNull();
    expect(result.compliance).toEqual({ passed: 0, judgeable: 1 });
    expect(result.rules[0]).toMatchObject({
      rule: { id: rule.id },
      run: { displayId: 'EXE-001', costUsd: null, turns: null },
    });
  });

  it('최근 실행이 중단이면 파이프라인에 중단 상태와 그 단계가 실린다 (재개 버튼 근거, ADR-011)', async () => {
    h.read((store) => {
      const rule = insertRule(store, '규칙', 'approved');
      seedRun(store, {
        ruleIds: [rule.id],
        at: T0 + 10_000,
        sessions: [{ costUsd: 0.05, turns: 1 }],
        status: 'interrupted',
      });
    });
    const { pipeline } = await summary();
    expect(pipeline?.run).toMatchObject({ status: 'interrupted', currentStep: 'test_writing' });
    expect(pipeline?.stages[1]).toEqual({ kind: 'test_writing', status: 'failed', attempt: 1 });
  });

  it('등록되지 않은 프로젝트는 -32004', async () => {
    await expect(
      h.client.call('verification.summary', { projectId: newId() }),
    ).rejects.toMatchObject({ code: ErrorCode.NotFound });
  });
});

describe('순수 함수', () => {
  const totals = (costUsd: number | null, costUnknownCount = 0) => ({
    costUsd,
    turns: null,
    modelUsage: null,
    sessionCount: 1,
    costUnknownCount,
    turnsUnknownCount: 0,
  });

  it('실행당 비용은 비용을 모두 아는 실행만 평균하고(1e-9 USD 반올림), 없으면 null', () => {
    expect(costPerRun([])).toBeNull();
    expect(costPerRun([totals(null), totals(0.5, 1)])).toBeNull();
    expect(costPerRun([totals(0.1), totals(0.2), totals(9, 1)])).toBe(0.15);
    expect(costPerRun([totals(0.1), totals(0.1), totals(0.1)])).toBe(0.1);
    expect(costPerRun([totals(0)])).toBe(0);
  });

  it('파이프라인은 단계마다 마지막 시도 상태이고 시도가 없는 단계는 pending · 0', () => {
    const run = { type: 'A' } as Run;
    const step = (kind: StepKind, attempt: number, status: Step['status']): Step =>
      ({ kind, attempt, status }) as Step;
    const { stages } = pipelineOf(run, [
      step('implementation', 1, 'passed'),
      step('check', 1, 'failed'),
      step('implementation', 2, 'running'),
      step('check', 2, 'pending'),
    ]);
    expect(stages.find((s) => s.kind === 'implementation')).toEqual({
      kind: 'implementation',
      status: 'running',
      attempt: 2,
    });
    expect(stages.find((s) => s.kind === 'merge')).toEqual({
      kind: 'merge',
      status: 'pending',
      attempt: 0,
    });
  });
});
