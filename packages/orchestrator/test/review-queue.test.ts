// 검토 대기열 모델 · 자동 등록 · 처리 액션 (M3-08 #53, TODO-02 · COST-01 · JDG-04, ADR-100 B④ · A17, ADR-145).
// 실제 SQLite · 픽스처 git 복사본 · 실제 엔진(단계 실행기는 시험용) · 실제 파이프 처리기.
// - 기준 1: 예산 초과로 끝난 실행은 항목으로 자동 등록되고, 변이 생존은 자동 보강 실행이 실패로 끝났을 때만 등록된다
// - 기준 2: 변이 생존 액션(테스트 보강 = 사람이 시작한 유형 C 보강 실행, 판정 격리 = 사유 필수 · 판정 상태 '격리', 이의 제기 = 없는 메서드)
import fs from 'node:fs';
import path from 'node:path';

import {
  type Author,
  DomainErrorReason,
  ErrorCode,
  type MutationResult,
  type SettingsPatch,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import { selectAgent } from '../src/agent/select.js';
import { PipelineEngine } from '../src/engine/pipeline-engine.js';
import { runEnding } from '../src/engine/run-ending.js';
import { checkRunStartBasis } from '../src/engine/start-basis.js';
import type { StepExecutor } from '../src/engine/types.js';
import { onReviewQueueChanged } from '../src/ipc/project-store-access.js';
import type { PipeServer } from '../src/ipc/server.js';
import { reinforceSurvivedMutants } from '../src/runs/auto-start.js';
import { createRun, evaluateApprovalStep } from '../src/runs/run-service.js';
import { isReinforcementRun } from '../src/steps/run-type.js';
import { isJudgeable } from '../src/verification/summary.js';
import { RpcCallError, type TestClient } from './helpers/client.js';
import {
  COMPLETE_SETTINGS,
  copyFixture,
  human,
  newId,
  seedProject,
  testExecutors,
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

const AUTO: SettingsPatch = { ...COMPLETE_SETTINGS, dailyBudgetUsd: 10 };
const agent = { kind: 'agent', role: 'implementer' } as const satisfies Author;
const MUTANT = { path: 'src/app/api/health/route.ts', search: 'time', replace: 'tick' };
const clock = { now: Date.now, newId };
const at = (): string => new Date().toISOString();

/** 단계 하나를 예산 초과로 끝내는 실행기 (엔진의 세션 한도 subtype과 같은 사유). */
const budgetHalt: StepExecutor = () =>
  Promise.resolve({ status: 'halt', runStatus: 'budget_exceeded', reason: 'error_max_budget_usd' });
/** 단계 하나를 실패로 끝내는 실행기. */
const failHalt: StepExecutor = () =>
  Promise.resolve({ status: 'halt', runStatus: 'failed', reason: 'step_unmet' });

interface Harness {
  readonly biveHome: string;
  readonly projectId: string;
  readonly ruleId: string;
  readonly read: <T>(fn: (store: ProjectStore) => T) => T;
}

const setup = (settings: SettingsPatch = AUTO): Harness => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const seeded = seedProject(biveHome, repo, settings);
  return {
    biveHome,
    projectId: seeded.project.id,
    ruleId: seeded.rule.id,
    read: (fn) => withProject(biveHome, seeded.project.id, fn),
  };
};

/** 병합으로 끝난 유형 A 실행과 그 실행의 '변이 생존' 기록 (저장만, 엔진 없이). */
const mergedSurvival = (store: ProjectStore, ruleId: string): MutationResult => {
  const origin = createRun(store, { ruleIds: [ruleId], author: human }, { clientId: null }, clock);
  evaluateApprovalStep(store, origin.run.id, clock);
  store.runs.transition(origin.run.id, {
    expectedStatus: 'running',
    run: { status: 'merged', mergeCommit: 'a'.repeat(40), currentStep: null, endedAt: at() },
  });
  return store.mutations.record({
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
};

/** 자동 보강 실행 1개 (유형 A의 생존 → 기존 자동 보강 길). */
const autoReinforcement = (h: Harness): { runId: string; survived: MutationResult } =>
  h.read((store) => {
    const survived = mergedSurvival(store, h.ruleId);
    const outcome = reinforceSurvivedMutants(store, { runId: survived.runId }, clock);
    if (outcome.status !== 'started') throw new Error(`보강 실행 없음: ${outcome.status}`);
    return { runId: outcome.runs[0]!.detail.run.id, survived };
  });

/** 엔진으로 실행 하나를 끝까지 (테스트 작성 단계 실행기만 바꿈). */
const drive = async (h: Harness, runId: string, testWriting: StepExecutor): Promise<void> => {
  const engine = new PipelineEngine({
    biveHome: h.biveHome,
    agent: selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome: h.biveHome }).adapter,
    executors: testExecutors({ test_writing: testWriting }),
  });
  engines.push(engine);
  engine.evaluateApproval(h.projectId, runId);
  await engine.settled();
};

const items = (h: Harness) => h.read((store) => store.reviewQueue.list());

describe('자동 등록: 예산 초과는 항목, 변이 생존은 자동 보강이 실패로 끝났을 때만 (M3-08 수용 기준 1, ADR-100 B④ · A17)', () => {
  it('사람이 시작한 유형 A 실행이 엔진에서 예산 초과로 끝나면 그 실행의 예산 초과 항목 1건이 생기고(알림 1번), 실패로 끝난 실행은 항목이 없다', async () => {
    const h = setup();
    const changes: string[] = [];
    const stop = onReviewQueueChanged(h.biveHome, (projectId) => changes.push(projectId));
    try {
      const first = h.read((store) =>
        createRun(store, { ruleIds: [h.ruleId], author: human }, { clientId: null }, clock),
      );
      await drive(h, first.run.id, budgetHalt);
      expect(h.read((store) => store.runs.get(first.run.id)?.status)).toBe('budget_exceeded');
      const second = h.read((store) =>
        createRun(store, { ruleIds: [h.ruleId], author: human }, { clientId: null }, clock),
      );
      await drive(h, second.run.id, failHalt);
      expect(h.read((store) => store.runs.get(second.run.id)?.status)).toBe('failed');
      const ended = h.read((store) => store.runs.get(first.run.id)!);
      expect(items(h)).toEqual([
        {
          seq: 1,
          kind: 'budget_exceeded',
          runId: first.run.id,
          mutationResultId: null,
          createdAt: ended.endedAt,
          resolution: null,
        },
      ]);
      expect(changes).toEqual([h.projectId]);
    } finally {
      stop();
    }
  }, 60_000);

  it('유형 A의 변이 생존 자체는 항목이 아니고, 그 생존의 자동 보강 실행이 실패로 끝나면 원인 변이 기록을 가진 변이 생존 항목이 생긴다. 재기동 복구 · 기동 판정을 다시 돌려도 늘지 않는다', async () => {
    const h = setup();
    const { runId, survived } = autoReinforcement(h);
    expect(items(h)).toEqual([]);
    await drive(h, runId, failHalt);
    expect(h.read((store) => store.runs.get(runId)?.status)).toBe('failed');
    expect(items(h)).toMatchObject([
      { seq: 1, kind: 'mutant_survived', runId, mutationResultId: survived.id, resolution: null },
    ]);
    const engine = new PipelineEngine({
      biveHome: h.biveHome,
      agent: selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome: h.biveHome }).adapter,
      executors: testExecutors(),
    });
    engines.push(engine);
    expect(engine.recoverInterruptedRuns()).toEqual([]);
    engine.startQueuedRuns();
    await engine.settled();
    expect(items(h)).toHaveLength(1);
  }, 60_000);

  it('자동 보강 실행이 예산 초과로 끝나면 예산 초과 항목 하나뿐이다 (실행 하나에 열린 항목 하나)', async () => {
    const h = setup();
    const { runId } = autoReinforcement(h);
    await drive(h, runId, budgetHalt);
    expect(items(h).map((item) => [item.kind, item.runId])).toEqual([['budget_exceeded', runId]]);
  }, 60_000);

  it('보강이 아닌 유형 C 실행의 실패, 하루 한도 비움으로 자동 보강이 생략된 생존은 항목이 아니다', async () => {
    const h = setup({ ...COMPLETE_SETTINGS, dailyBudgetUsd: null });
    const skipped = h.read((store) => {
      const survived = mergedSurvival(store, h.ruleId);
      return reinforceSurvivedMutants(store, { runId: survived.runId }, clock);
    });
    expect(skipped).toEqual({ status: 'skipped', reason: 'project_daily_budget_unset' });
    const plain = h.read((store) =>
      createRun(
        store,
        { ruleIds: [h.ruleId], author: human, type: 'C' },
        { clientId: null },
        clock,
      ),
    );
    await drive(h, plain.run.id, failHalt);
    expect(h.read((store) => store.runs.get(plain.run.id)?.status)).toBe('failed');
    expect(items(h)).toEqual([]);
  }, 60_000);
});

/** 파이프 처리기 + 실제 저장소. 변이 생존 항목 1건(자동 보강 실패)과 예산 초과 항목 1건을 만든다. */
const rpcHarness = async () => {
  const repo = copyFixture(temps);
  const p = await startProjectHarness({ servers, clients }, { rootPath: repo });
  // 처리 시각은 오케스트레이터 시계다: 앞서 남긴 판정 · 변이 기록(지금 시각)보다 뒤가 되게 지금으로 맞춘다
  p.clock.now = Date.now();
  const { ruleId, survivedId, reinforcingId, budgetRunId } = p.read((store) => {
    store.settings.update(AUTO, { by: human, at: at() });
    const requirement = store.requirements.create({
      id: newId(),
      text: '헬스 체크 응답에 서버 시각 포함',
      author: human,
      normState: 'approved',
      createdAt: at(),
    });
    const rule = store.rules.create({
      id: newId(),
      title: '헬스 체크 서버 시각',
      statement:
        'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 응답 JSON의 time 필드에 서버 시각을 담는다',
      kind: 'business',
      checkKinds: ['test'],
      parentRequirementId: requirement.id,
      builtin: false,
      targetBlockIds: ['health'],
      risk: 'medium',
      contractId: null,
      author: { kind: 'agent', role: 'rule-writer' },
      normState: 'approved',
      createdAt: at(),
    });
    const survived = mergedSurvival(store, rule.id);
    // A 실행이 병합될 때의 통과 판정 (격리 전 최신 판정)
    store.judgments.record([
      {
        id: newId(),
        ruleId: rule.id,
        runId: survived.runId,
        stepId: survived.stepId,
        commit: survived.commit,
        judgedAt: new Date(Date.now() - 60_000).toISOString(),
        status: 'pass',
        runner: 'vitest',
        exitCode: 0,
        reporterPath: null,
        cases: [],
        quarantineReason: null,
      },
    ]);
    const outcome = reinforceSurvivedMutants(store, { runId: survived.runId }, clock);
    if (outcome.status !== 'started') throw new Error('보강 실행 없음');
    const reinforcing = outcome.runs[0]!.detail.run;
    evaluateApprovalStep(store, reinforcing.id, clock);
    store.runs.transition(reinforcing.id, {
      expectedStatus: 'running',
      run: { ...runEnding(reinforcing, 'failed', 'regression_limit').run, endedAt: at() },
    });
    const budget = createRun(
      store,
      { ruleIds: [rule.id], author: human },
      { clientId: null },
      clock,
    );
    evaluateApprovalStep(store, budget.run.id, clock);
    store.runs.transition(budget.run.id, {
      expectedStatus: 'running',
      run: {
        ...runEnding(budget.run, 'budget_exceeded', 'error_max_budget_usd').run,
        endedAt: at(),
      },
    });
    return {
      ruleId: rule.id,
      survivedId: survived.id,
      reinforcingId: reinforcing.id,
      budgetRunId: budget.run.id,
    };
  });
  const [mutant, budget] = p.read((store) => store.reviewQueue.list());
  if (mutant?.kind !== 'mutant_survived' || budget?.kind !== 'budget_exceeded') {
    throw new Error('항목 준비 실패');
  }
  return { ...p, ruleId, survivedId, reinforcingId, budgetRunId, mutant, budget };
};

const rejection = async (promise: Promise<unknown>): Promise<RpcCallError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcCallError) return error;
    throw error;
  }
  throw new Error('거부되지 않음');
};

describe('조회: 목록 · 거르기 · 항목 하나 (SCR-18이 그릴 값)', () => {
  it('목록은 등록 순이고 종류 · 처리 상태로 거르며, 항목마다 실행 요약과 대상 규칙(변이 생존 = 원인 규칙)을 싣는다. 없는 항목은 -32004', async () => {
    const h = await rpcHarness();
    const listed = await h.client.call('reviewQueue.list', { projectId: h.project.id });
    expect(listed.entries.map((entry) => [entry.item.seq, entry.item.kind])).toEqual([
      [h.mutant.seq, 'mutant_survived'],
      [h.budget.seq, 'budget_exceeded'],
    ]);
    expect(listed.entries[0]).toMatchObject({
      run: { id: h.reinforcingId, type: 'C', status: 'failed', failureReason: 'regression_limit' },
      rules: [{ id: h.ruleId, displayId: 'RULE-001', title: '헬스 체크 서버 시각' }],
    });
    expect(listed.entries[1]).toMatchObject({
      run: { id: h.budgetRunId, type: 'A', status: 'budget_exceeded' },
      rules: [{ id: h.ruleId }],
    });
    const byKind = await h.client.call('reviewQueue.list', {
      projectId: h.project.id,
      kind: 'budget_exceeded',
    });
    expect(byKind.entries.map((entry) => entry.item.seq)).toEqual([h.budget.seq]);
    const resolved = await h.client.call('reviewQueue.list', {
      projectId: h.project.id,
      state: 'resolved',
    });
    expect(resolved.entries).toEqual([]);
    const one = await h.client.call('reviewQueue.get', {
      projectId: h.project.id,
      seq: h.mutant.seq,
    });
    expect(one.entry).toEqual(listed.entries[0]);
    const missing = await rejection(
      h.client.call('reviewQueue.get', { projectId: h.project.id, seq: 99 }),
    );
    expect(missing.code).toBe(ErrorCode.NotFound);
  }, 60_000);
});

describe('변이 생존 액션 (M3-08 수용 기준 2, PRD TODO-02 · 미결 #7)', () => {
  it('테스트 보강: 사람이 시작한 유형 C 실행(승인 기록 run_start)을 만들어 원인 변이 기록과 잇고 항목을 처리됨으로 남긴다. 그 실행은 자동 보강과 같은 보강 실행이고 시작 근거 대조를 지난다', async () => {
    const h = await rpcHarness();
    const result = await h.client.call('reviewQueue.reinforce', {
      projectId: h.project.id,
      seq: h.mutant.seq,
      author: human,
    });
    expect(result.run).toMatchObject({
      type: 'C',
      status: 'waiting_approval',
      targetRuleIds: [h.ruleId],
      startedBy: { kind: 'human' },
    });
    expect(result.approvalLog).toMatchObject({
      action: 'run_start',
      actor: { kind: 'human' },
      targetRef: { entity: 'Run', id: result.run.id },
    });
    expect(result.entry.item.resolution).toEqual({
      action: 'reinforce',
      by: human,
      at: result.run.createdAt,
      reason: null,
      runId: result.run.id,
    });
    h.read((store) => {
      expect(store.mutations.reinforcementCauseOfRun(result.run.id)).toBe(h.survivedId);
      expect(isReinforcementRun({ run: result.run, read: (fn) => fn(store) })).toBe(true);
      expect(checkRunStartBasis(store, result.run)).toEqual({
        mismatch: null,
        runStartEntries: 1,
        autoStartEntries: 0,
      });
      // 자동 보강의 연결은 늘지 않는다 (같은 기록으로 자동 보강을 다시 만들지 않는 0027 제약 그대로)
      expect(store.mutations.reinforcementOfRun(result.run.id)).toBeNull();
    });
    // 처리 두 번 거부
    const again = await rejection(
      h.client.call('reviewQueue.reinforce', {
        projectId: h.project.id,
        seq: h.mutant.seq,
        author: human,
      }),
    );
    expect([again.code, again.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'already_resolved' },
    ]);
    expect(h.read((store) => store.runs.list().filter((run) => run.type === 'C'))).toHaveLength(2);
  }, 60_000);

  it('에이전트 주체 · 없는 항목 · 예산 초과 항목 · 설정 미비는 거부되고 아무것도 남지 않는다', async () => {
    const h = await rpcHarness();
    const before = h.read((store) => store.runs.list().length);
    const byAgent = await rejection(
      h.client.call('reviewQueue.reinforce', {
        projectId: h.project.id,
        seq: h.mutant.seq,
        author: agent,
      }),
    );
    expect(byAgent.code).toBe(ErrorCode.Unauthorized);
    const missing = await rejection(
      h.client.call('reviewQueue.reinforce', { projectId: h.project.id, seq: 99, author: human }),
    );
    expect(missing.code).toBe(ErrorCode.NotFound);
    const wrongKind = await rejection(
      h.client.call('reviewQueue.reinforce', {
        projectId: h.project.id,
        seq: h.budget.seq,
        author: human,
      }),
    );
    expect([wrongKind.code, wrongKind.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'action_not_allowed' },
    ]);
    // 설정 미비: 사람의 run.create와 같은 문(-32010)에서 멈추고 연결 · 처리도 남지 않는다 (트랜잭션 1개)
    h.read((store) =>
      store.settings.update({ roles: { mutator: { model: null } } }, { by: human, at: at() }),
    );
    const incomplete = await rejection(
      h.client.call('reviewQueue.reinforce', {
        projectId: h.project.id,
        seq: h.mutant.seq,
        author: human,
      }),
    );
    expect(incomplete.code).toBe(ErrorCode.SettingsIncomplete);
    h.read((store) => {
      expect(store.runs.list()).toHaveLength(before);
      expect(store.reviewQueue.get(h.mutant.seq)?.resolution).toBeNull();
      expect(store.reviewQueue.get(h.budget.seq)?.resolution).toBeNull();
    });
  }, 60_000);

  it('판정 격리: 빈 사유(공백만 포함) · 상한 초과는 -32001이고, 사유가 있으면 그 규칙의 판정 상태가 격리(사유)다. 에이전트 · 예산 초과 항목 · 두 번째 처리는 거부된다', async () => {
    const h = await rpcHarness();
    for (const [reason, code] of [
      ['', DomainErrorReason.QuarantineReasonRequired],
      ['  \n\t', DomainErrorReason.QuarantineReasonRequired],
      ['가'.repeat(4001), DomainErrorReason.QuarantineReasonInvalid],
    ] as const) {
      const error = await rejection(
        h.client.call('reviewQueue.quarantine', {
          projectId: h.project.id,
          seq: h.mutant.seq,
          reason,
          author: human,
        }),
      );
      expect([error.code, error.data]).toEqual([ErrorCode.ValidationFailed, { reason: code }]);
    }
    const byAgent = await rejection(
      h.client.call('reviewQueue.quarantine', {
        projectId: h.project.id,
        seq: h.mutant.seq,
        reason: '불안정한 검사',
        author: agent,
      }),
    );
    expect(byAgent.code).toBe(ErrorCode.Unauthorized);
    const wrongKind = await rejection(
      h.client.call('reviewQueue.quarantine', {
        projectId: h.project.id,
        seq: h.budget.seq,
        reason: '불안정한 검사',
        author: human,
      }),
    );
    expect(wrongKind.data).toEqual({ reason: 'action_not_allowed' });
    expect(
      h.read((store) => [
        store.reviewQueue.get(h.mutant.seq)?.resolution,
        store.judgments.listByRule(h.ruleId).map((judgment) => judgment.status),
      ]),
    ).toEqual([null, ['pass']]);
    const before = await h.client.call('rule.list', { projectId: h.project.id });
    expect(before.rules[0]?.judgment.status).toBe('pass');
    expect(isJudgeable(before.rules[0]!.rule, before.rules[0]!.judgment, new Set())).toBe(true);

    const result = await h.client.call('reviewQueue.quarantine', {
      projectId: h.project.id,
      seq: h.mutant.seq,
      reason: '불안정한 검사',
      author: human,
    });
    expect(result.judgment).toMatchObject({
      ruleId: h.ruleId,
      runId: null,
      stepId: null,
      status: 'quarantined',
      quarantineReason: '불안정한 검사',
      cases: [],
    });
    expect(result.entry.item.resolution).toMatchObject({
      action: 'quarantine',
      reason: '불안정한 검사',
      judgmentId: result.judgment.id,
    });
    const listed = await h.client.call('rule.list', { projectId: h.project.id });
    expect(listed.rules[0]?.judgment).toEqual({ status: 'quarantined', latest: result.judgment });
    // 격리는 통과로 세지 않는다: 통과였던 규칙이 준수 지표의 판정 가능 · 통과에서 빠진다 (판정에서 일시 제외, 기획서 3.4)
    expect(isJudgeable(listed.rules[0]!.rule, listed.rules[0]!.judgment, new Set())).toBe(false);
    const again = await rejection(
      h.client.call('reviewQueue.quarantine', {
        projectId: h.project.id,
        seq: h.mutant.seq,
        reason: '다시',
        author: human,
      }),
    );
    expect(again.data).toEqual({ reason: 'already_resolved' });
    // 그 뒤 그 규칙을 실제로 판정한 새 결과가 생기면 그 결과가 최신이다
    const later = h.read(
      (store) =>
        store.judgments.record([
          {
            ...result.judgment,
            id: newId(),
            judgedAt: new Date(Date.parse(result.judgment.judgedAt) + 1000).toISOString(),
            status: 'fail',
            exitCode: 1,
            quarantineReason: null,
          },
        ])[0]!,
    );
    const relisted = await h.client.call('rule.list', { projectId: h.project.id });
    expect(relisted.rules[0]?.judgment).toEqual({ status: 'fail', latest: later });
  }, 60_000);

  it('격리는 검사 단계 · 병합 재검사 · 자동 시작의 판단에 들어가지 않는다: 저장된 최신 판정을 읽는 곳에 단계 · 엔진 판단 · 실행 · 자동 시작 코드가 없다', () => {
    const src = path.resolve(import.meta.dirname, '../src');
    const readers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.name.endsWith('.ts') &&
          /\bjudgments\s*\.\s*(?:latestForRules|latestByRule|listByRule)\(/.test(
            fs.readFileSync(full, 'utf8'),
          )
        ) {
          readers.push(path.relative(src, full).split(path.sep).join('/'));
        }
      }
    };
    walk(src);
    expect(readers.length).toBeGreaterThan(0);
    for (const reader of readers) {
      expect(reader, reader).not.toMatch(/^(steps|engine|runs|judge|settings)\//);
    }
  });

  it('이의 제기는 메서드가 없다: 부르면 -32601이고 검토 대기열 이름 공간에 이의 메서드가 없다 (PRD 미결 #7)', async () => {
    const h = await rpcHarness();
    for (const method of ['reviewQueue.object', 'reviewQueue.objection', 'reviewQueue.dispute']) {
      const response = await h.client.requestRaw({
        jsonrpc: '2.0',
        id: method,
        method,
        params: { projectId: h.project.id, seq: h.mutant.seq, author: human },
      });
      expect(response).toMatchObject({ id: method, error: { code: ErrorCode.MethodNotFound } });
    }
    expect(h.read((store) => store.reviewQueue.get(h.mutant.seq)?.resolution)).toBeNull();
  }, 60_000);
});
