// 검증 화면 요약 RPC (M1-18 수용 기준 1, JDG-03 · COST-02 · SCR-05 · ADR-072).
// `verification.summary`가 판정 기준 커밋, 준수(통과 수 · 판정 가능 수), 분모 목록, 실행당 비용(없으면 null)과
// 규칙별 최신 판정 · 실행 링크(비용 합계 · 턴), 최근 실행의 파이프라인을 돌려주는지 본다.
// 준수 · 목록의 판정은 판정 기준 커밋에서 낸 판정(기준 실행의 병합 재검사, 없으면 검사 단계)뿐이다 (screens.md SCR-05 머리줄).
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소. 데이터는 저장소에 바로 넣는다(테스트 전용).
import {
  type Author,
  createUlidGenerator,
  ErrorCode,
  type JudgmentResult,
  type NormChangeEntry,
  type Rule,
  type RuleJudgment,
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

import { INTERRUPTED_EXIT_DETAIL } from '../src/engine/pipeline-engine.js';
import type { PipeServer } from '../src/ipc/server.js';
import { retireAgentRule, supersedeAgentRule } from '../src/norms/agent-rule.js';
import { createRun } from '../src/runs/run-service.js';
import {
  agentRetiredRuleCount,
  basisOf,
  type BasisOptions,
  costPerRun,
  humanConfirmedCompliance,
  type MergeRecord,
  parentlessRuleDefects,
  pipelineOf,
} from '../src/verification/summary.js';
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
    mutator: { model: 'mutator-model', maxBudgetUsd: 1, maxTurns: 50 },
  },
};

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);
const SHA_E = 'e'.repeat(40);
const SHA_F = 'f'.repeat(40);

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
  /** 마지막 통과 구현 · 검사 커밋 */
  headCommit?: string;
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
        : {
            currentStep: null,
            endedAt: end,
            headCommit: seed.headCommit ?? null,
            mergeCommit: seed.mergeCommit ?? null,
          }),
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

interface MergedSeed {
  ruleIds: Ulid[];
  at: number;
  headCommit: string;
  mergeCommit: string;
  /** 병합 단계 통과 시도의 `exitDetail.mergeOrder` (`null`이면 읽기 실패, 생략하면 칸 없음 = 저장 전 기록) */
  mergeOrder?: number | null;
  /** 통과 시도의 `exitDetail.mergeCommit` (기본 `mergeCommit`) */
  exitMergeCommit?: string;
  /** 병합 단계 통과 시각 (기본 `at + 1초`) */
  mergeEnd?: number;
  /** 주면 통과 전에 이 순서 값을 담은 실패 시도가 하나 있다 (재개 전 시도) */
  failedMergeOrder?: number;
  /** `merged`(화면 갱신 통과) 또는 화면 갱신 도중 재기동 중단(`screen_update#1: failed` + `#2: pending`) */
  end?: 'merged' | 'interrupted';
}

/** 병합 단계까지 통과한 실행을 저장소에 바로 만든다 (엔진이 남기는 저장 형태). */
const mergedRun = (store: ProjectStore, seed: MergedSeed): Run => {
  const run = seedRun(store, { ruleIds: seed.ruleIds, at: seed.at, status: 'running' });
  const steps = store.runs.steps(run.id);
  const plan = RUN_STEP_PLANS.A;
  const mergeStep = stepOf(steps, 'merge');
  const mergeEnd = seed.mergeEnd ?? seed.at + 1_000;
  const exitDetail = {
    mergeCommit: seed.exitMergeCommit ?? seed.mergeCommit,
    ...(seed.mergeOrder === undefined
      ? {}
      : seed.mergeOrder === null
        ? { mergeOrder: null, mergeOrderError: 'timeout' }
        : { mergeOrder: seed.mergeOrder }),
  };
  const failed = seed.failedMergeOrder;
  store.runs.transition(run.id, {
    run: { currentStep: 'merge', headCommit: seed.headCommit },
    steps: [
      ...plan.slice(1, plan.indexOf('merge')).map((kind) => ({
        id: stepOf(steps, kind).id,
        status: 'passed' as const,
        startedAt: iso(seed.at),
        endedAt: iso(seed.at + 500),
      })),
      failed === undefined
        ? {
            id: mergeStep.id,
            status: 'passed' as const,
            startedAt: iso(seed.at + 500),
            endedAt: iso(mergeEnd),
            exitDetail,
          }
        : {
            id: mergeStep.id,
            status: 'failed' as const,
            startedAt: iso(seed.at + 500),
            endedAt: iso(seed.at + 600),
            exitDetail: { mergeCommit: seed.mergeCommit, mergeOrder: failed, interrupted: true },
          },
    ],
    ...(failed === undefined
      ? {}
      : {
          addSteps: [
            {
              id: newId(),
              kind: 'merge' as const,
              attempt: 2,
              status: 'passed' as const,
              role: mergeStep.role,
              startedAt: iso(mergeEnd - 100),
              endedAt: iso(mergeEnd),
              exitDetail,
            },
          ],
        }),
  });
  const screen = stepOf(steps, 'screen_update');
  store.runs.transition(run.id, {
    run: { currentStep: 'screen_update', mergeCommit: seed.mergeCommit },
    steps: [{ id: screen.id, status: 'running', startedAt: iso(mergeEnd) }],
  });
  if (seed.end === 'interrupted') {
    // 재기동 복구(`recoverInterruptedRuns`)와 같은 저장: 지금 시도를 failed로 끝내고 새 pending 시도
    return store.runs.regress(run.id, {
      toKind: 'screen_update',
      at: iso(mergeEnd + 500),
      newId,
      expectedStatus: 'running',
      exitDetail: INTERRUPTED_EXIT_DETAIL,
      startStatus: 'pending',
      run: { status: 'interrupted' },
    }).run;
  }
  return store.runs.transition(run.id, {
    run: { status: 'merged', currentStep: null, endedAt: iso(mergeEnd + 1_000) },
    steps: [{ id: screen.id, status: 'passed', endedAt: iso(mergeEnd + 1_000) }],
  }).run;
};

/** 판정 기록이 가리키는 실행 · 단계 시도 (실행 밖 판정이면 `null`). */
type JudgedIn = { runId: Ulid; stepId: Ulid } | null;

/** 실행의 `kind` 단계 첫 시도에서 낸 판정 (구현 · 검사 · 병합 재검사). */
const judgedIn = (store: ProjectStore, run: Run, kind: StepKind = 'check'): JudgedIn => ({
  runId: run.id,
  stepId: stepOf(store.runs.steps(run.id), kind).id,
});

const judgment = (
  rule: Rule,
  status: JudgmentResult['status'],
  where: JudgedIn,
  at: number,
  commit: string,
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

const UNJUDGED = { status: 'unjudged', latest: null } as const;

describe('verification.summary', () => {
  it('규칙 · 실행이 없으면 판정 기준 · 실행당 비용 · 파이프라인 · 사람 확인 기준이 null이고 준수는 0 / 0, 에이전트 폐기 수 0', async () => {
    expect(await summary()).toEqual({
      basis: null,
      compliance: { passed: 0, judgeable: 0 },
      denominator: [],
      confirmedCompliance: null,
      confirmedDenominator: [],
      agentRetiredRules: 0,
      costPerRunUsd: null,
      rules: [],
      pipeline: null,
    });
  });

  it('판정 기준 커밋, 준수(통과 / 판정 가능), 분모 목록, 실행당 비용을 돌려주고 준수 · 목록은 기준 실행의 검사 판정만 쓴다', async () => {
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
        headCommit: SHA_C,
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
        headCommit: SHA_D,
      });
      const run3 = seedRun(store, {
        ruleIds: [passed.id],
        at: T0 + 30_000,
        sessions: [{ costUsd: 0.1, turns: 2 }],
        status: 'merged',
        headCommit: SHA_E,
        mergeCommit: SHA_B,
      });
      const run4 = seedRun(store, {
        ruleIds: [passed.id],
        at: T0 + 40_000,
        sessions: [{ costUsd: 3, turns: 50 }],
        status: 'running',
      });
      store.judgments.record([
        // EXE-001(이전 병합): 기준 커밋의 판정이 아니므로 보이지 않는다
        judgment(failed, 'pass', judgedIn(store, run1), T0 + 12_000, SHA_C),
        judgment(fresh, 'pass', judgedIn(store, run1), T0 + 12_000, SHA_C),
        // EXE-002(병합 안 됨): 검사 실패
        judgment(failed, 'fail', judgedIn(store, run2), T0 + 21_000, SHA_D),
        // EXE-003(기준): 구현 1차 시도 실패(되돌린 시도 커밋), 검사 = 통과 · 잠정 · 격리 규칙
        judgment(passed, 'fail', judgedIn(store, run3, 'implementation'), T0 + 31_000, SHA_D),
        judgment(passed, 'pass', judgedIn(store, run3), T0 + 32_000, SHA_E),
        judgment(provisional, 'pass', judgedIn(store, run3), T0 + 32_000, SHA_E),
        judgment(quarantined, 'quarantined', judgedIn(store, run3), T0 + 32_000, SHA_E),
        // EXE-004(진행 중): 구현 판정 실패
        judgment(passed, 'fail', judgedIn(store, run4, 'implementation'), T0 + 41_000, SHA_F),
        // 실행 밖 판정
        judgment(fresh, 'fail', null, T0 + 42_000, SHA_B),
      ]);
      return { passed, failed, fresh, provisional, quarantined, run3 };
    });

    const result = await summary();
    expect(result.basis).toEqual({ branch: 'main', commit: SHA_B, runId: seeded.run3.id });
    // 분모 = 승인 · 격리 아님(통과 · 실패 · 판정 전 규칙), 통과 = 기준 실행에서 통과한 통과 규칙뿐
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
      judgment: { status: 'pass', latest: { commit: SHA_E, runId: seeded.run3.id } },
      run: { id: seeded.run3.id, displayId: 'EXE-003', costUsd: 0.1, turns: 2 },
    });
    // 병합되지 않은 실행(EXE-002)의 실패 · 이전 병합(EXE-001)의 판정 · 실행 밖 판정은 준수 · 목록에 들지 않는다
    for (const rule of [seeded.failed, seeded.fresh]) {
      expect(row(rule)).toEqual({ rule, judgment: UNJUDGED, run: null });
    }
    expect(row(seeded.quarantined)).toMatchObject({
      judgment: { status: 'quarantined' },
      run: { displayId: 'EXE-003' },
    });

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

  it('폐기된 규칙은 지금의 준수 분모 · 규칙 목록에서 빠지고 판정 이력은 지워지지 않는다 (M7-09 #221, ADR-100 JDG-03 · D6, ADR-112)', async () => {
    const seeded = h.read((store) => {
      const kept = insertRule(store, '남는 규칙', 'approved');
      const retired = insertRule(store, '폐기 규칙', 'approved');
      const run = seedRun(store, {
        ruleIds: [kept.id, retired.id],
        at: T0 + 10_000,
        sessions: [{ costUsd: 0.1, turns: 1 }],
        status: 'merged',
        headCommit: SHA_C,
        mergeCommit: SHA_A,
      });
      store.judgments.record([
        judgment(kept, 'pass', judgedIn(store, run), T0 + 12_000, SHA_C),
        judgment(retired, 'fail', judgedIn(store, run), T0 + 12_000, SHA_C),
      ]);
      return { kept, retired };
    });
    const before = await summary();
    expect(before.compliance).toEqual({ passed: 1, judgeable: 2 });
    expect(before.denominator).toEqual([seeded.kept.id, seeded.retired.id]);

    h.read((store) =>
      retireAgentRule(
        store,
        {
          ruleId: seeded.retired.id,
          grounds: `진술 "${seeded.retired.statement}"과 새 요구사항이 모순`,
          author: { kind: 'agent', role: 'rule-writer' },
          sessionId: newId(),
        },
        { now: Date.now },
      ),
    );
    const after = await summary();
    // 분모 · 목록에서 빠져 준수 값이 바뀐다 (폐기 수 표시는 M7-15 · M7-16)
    expect(after.compliance).toEqual({ passed: 1, judgeable: 1 });
    expect(after.denominator).toEqual([seeded.kept.id]);
    expect(after.rules.map((row) => row.rule.id)).toEqual([seeded.kept.id]);
    expect(after.basis).toEqual(before.basis);
    // 판정 이력 · 규칙 행은 남는다
    h.read((store) => {
      expect(store.judgments.listByRule(seeded.retired.id).map((item) => item.status)).toEqual([
        'fail',
      ]);
      expect(store.rules.get(seeded.retired.id)?.deletedAt).toBeNull();
    });
    const history = await h.client.call('judgment.list', {
      projectId: h.project.id,
      ruleId: seeded.retired.id,
    });
    expect(history.judgments).toHaveLength(1);
  });

  it('진행 중 실행의 구현 판정은 준수 · 목록을 바꾸지 않는다', async () => {
    const rule = h.read((store) => {
      const created = insertRule(store, '규칙', 'approved');
      const merged = seedRun(store, {
        ruleIds: [created.id],
        at: T0 + 10_000,
        status: 'merged',
        headCommit: SHA_C,
        mergeCommit: SHA_A,
      });
      store.judgments.record([
        judgment(created, 'pass', judgedIn(store, merged), T0 + 11_000, SHA_C),
      ]);
      return created;
    });
    const before = await summary();
    expect(before.compliance).toEqual({ passed: 1, judgeable: 1 });

    h.read((store) => {
      const running = seedRun(store, { ruleIds: [rule.id], at: T0 + 20_000, status: 'running' });
      store.judgments.record([
        judgment(rule, 'fail', judgedIn(store, running, 'implementation'), T0 + 21_000, SHA_D),
      ]);
    });
    const after = await summary();
    expect(after.compliance).toEqual(before.compliance);
    expect(after.rules).toEqual(before.rules);
  });

  it('병합 재검사 판정이 있으면 그것(병합 커밋의 판정)만 쓰고, 재검사에 없는 규칙은 미판정이다', async () => {
    const seeded = h.read((store) => {
      const a = insertRule(store, '재검사 규칙', 'approved');
      const b = insertRule(store, '검사만 규칙', 'approved');
      const run = seedRun(store, {
        ruleIds: [a.id, b.id],
        at: T0 + 10_000,
        status: 'merged',
        headCommit: SHA_C,
        mergeCommit: SHA_A,
      });
      store.judgments.record([
        judgment(a, 'pass', judgedIn(store, run), T0 + 11_000, SHA_C),
        judgment(b, 'pass', judgedIn(store, run), T0 + 11_000, SHA_C),
        judgment(a, 'pass', judgedIn(store, run, 'merge'), T0 + 12_000, SHA_A),
      ]);
      return { a, b };
    });
    const result = await summary();
    expect(result.basis?.commit).toBe(SHA_A);
    expect(result.compliance).toEqual({ passed: 1, judgeable: 2 });
    const judgmentOf = (rule: Rule) => result.rules.find((r) => r.rule.id === rule.id)?.judgment;
    expect(judgmentOf(seeded.a)?.latest?.commit).toBe(SHA_A);
    expect(judgmentOf(seeded.b)).toEqual(UNJUDGED);
  });

  it('판정 기준이 없으면(병합된 실행 없음) 판정이 보이지 않는다', async () => {
    const rule = h.read((store) => {
      const created = insertRule(store, '규칙', 'approved');
      const run = seedRun(store, {
        ruleIds: [created.id],
        at: T0 + 10_000,
        status: 'failed',
        headCommit: SHA_C,
      });
      store.judgments.record([
        judgment(created, 'fail', judgedIn(store, run), T0 + 11_000, SHA_C),
        judgment(created, 'pass', null, T0 + 12_000, SHA_C),
      ]);
      return created;
    });
    const result = await summary();
    expect(result.basis).toBeNull();
    expect(result.compliance).toEqual({ passed: 0, judgeable: 1 });
    expect(result.rules).toEqual([{ rule, judgment: UNJUDGED, run: null }]);
  });

  it('실행 비용 값이 없으면 실행당 비용과 실행 링크의 비용 · 턴이 null이다', async () => {
    const rule = h.read((store) => {
      const created = insertRule(store, '규칙', 'approved');
      const run = seedRun(store, {
        ruleIds: [created.id],
        at: T0 + 10_000,
        status: 'merged',
        headCommit: SHA_C,
        mergeCommit: SHA_A,
      });
      store.judgments.record([judgment(created, 'pass', judgedIn(store, run), T0 + 11_000, SHA_C)]);
      return created;
    });
    const result = await summary();
    expect(result.costPerRunUsd).toBeNull();
    expect(result.compliance).toEqual({ passed: 1, judgeable: 1 });
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

  describe('판정 기준 후보 = 병합 커밋이 기록된 실행 (상태와 무관, #195 · ADR-096)', () => {
    it('앞서 병합된 실행 + 병합 뒤 화면 갱신 도중 재기동으로 중단된 실행(나중 병합): 기준은 중단된 실행의 병합 커밋이고, 판정은 그 실행의 병합 재검사 → 검사 판정 순이다', async () => {
      const seeded = h.read((store) => {
        const rule = insertRule(store, '규칙', 'approved');
        // EXE-001: 앞서 병합 완료 (순서 값 10, 검사 판정 fail)
        const first = mergedRun(store, {
          ruleIds: [rule.id],
          at: T0 + 10_000,
          headCommit: SHA_E,
          mergeCommit: SHA_A,
          mergeOrder: 10,
        });
        store.judgments.record([
          judgment(rule, 'fail', judgedIn(store, first), T0 + 11_000, SHA_E),
        ]);
        // EXE-002: 나중에 병합(순서 값 11)하고 화면 갱신 도중 재기동 → screen_update#1 failed + #2 pending
        const second = mergedRun(store, {
          ruleIds: [rule.id],
          at: T0 + 20_000,
          headCommit: SHA_C,
          mergeCommit: SHA_B,
          mergeOrder: 11,
          end: 'interrupted',
        });
        store.judgments.record([
          judgment(rule, 'pass', judgedIn(store, second), T0 + 21_000, SHA_C),
        ]);
        return { rule, first, second };
      });
      expect(seeded.second).toMatchObject({
        status: 'interrupted',
        currentStep: 'screen_update',
        mergeCommit: SHA_B,
        endedAt: null,
      });
      expect(
        h.read((store) =>
          store.runs
            .steps(seeded.second.id)
            .filter((step) => step.kind === 'screen_update')
            .map((step) => `${step.kind}#${String(step.attempt)}:${step.status}`),
        ),
      ).toEqual(['screen_update#1:failed', 'screen_update#2:pending']);

      let result = await summary();
      expect(result.basis).toEqual({ branch: 'main', commit: SHA_B, runId: seeded.second.id });
      // 병합 재검사 판정이 없으면 기준 실행(중단된 실행)의 검사 단계 판정
      expect(result.compliance).toEqual({ passed: 1, judgeable: 1 });
      expect(result.rules[0]).toMatchObject({
        judgment: { status: 'pass', latest: { runId: seeded.second.id, commit: SHA_C } },
        run: { displayId: 'EXE-002' },
      });
      // 파이프라인은 그 실행의 중단 상태 그대로 (재개 버튼 근거)
      expect(result.pipeline?.run).toMatchObject({
        displayId: 'EXE-002',
        status: 'interrupted',
        currentStep: 'screen_update',
      });
      expect(result.pipeline?.stages.at(-1)).toEqual({
        kind: 'screen_update',
        status: 'pending',
        attempt: 2,
      });

      // 중단된 실행에 병합 재검사 판정(병합 커밋)이 있으면 그것이 검사 판정보다 앞선다
      h.read((store) =>
        store.judgments.record([
          judgment(
            seeded.rule,
            'fail',
            judgedIn(store, seeded.second, 'merge'),
            T0 + 21_500,
            SHA_B,
          ),
        ]),
      );
      result = await summary();
      expect(result.basis?.runId).toBe(seeded.second.id);
      expect(result.compliance).toEqual({ passed: 0, judgeable: 1 });
      expect(result.rules[0]?.judgment).toMatchObject({
        status: 'fail',
        latest: { runId: seeded.second.id, commit: SHA_B },
      });
    });

    it.each([
      ['순서 값 있음', 7],
      ['순서 값 읽기 실패(null)', null],
      ['순서 값 저장 전 기록(칸 없음)', undefined],
    ] as const)(
      '병합된 다른 실행 없이 병합 커밋이 기록된 interrupted 실행 하나만 있어도 판정 기준이다 (%s)',
      async (_label, mergeOrder) => {
        const seeded = h.read((store) => {
          const rule = insertRule(store, '규칙', 'approved');
          const run = mergedRun(store, {
            ruleIds: [rule.id],
            at: T0 + 10_000,
            headCommit: SHA_C,
            mergeCommit: SHA_B,
            ...(mergeOrder === undefined ? {} : { mergeOrder }),
            end: 'interrupted',
          });
          store.judgments.record([
            judgment(rule, 'pass', judgedIn(store, run), T0 + 11_000, SHA_C),
          ]);
          return { run };
        });
        expect(seeded.run.status).toBe('interrupted');
        const result = await summary();
        expect(result.basis).toEqual({ branch: 'main', commit: SHA_B, runId: seeded.run.id });
        expect(result.compliance).toEqual({ passed: 1, judgeable: 1 });
      },
    );

    it('병합 전에 재기동으로 중단된 실행(병합 커밋 없음)은 후보가 아니다', async () => {
      h.read((store) => {
        const rule = insertRule(store, '규칙', 'approved');
        const run = seedRun(store, { ruleIds: [rule.id], at: T0 + 10_000, status: 'running' });
        store.runs.regress(run.id, {
          toKind: 'test_writing',
          at: iso(T0 + 11_000),
          newId,
          expectedStatus: 'running',
          exitDetail: INTERRUPTED_EXIT_DETAIL,
          startStatus: 'pending',
          run: { status: 'interrupted' },
        });
      });
      expect((await summary()).basis).toBeNull();
    });

    it('순서 값은 병합 단계의 통과 시도에서, 실행의 병합 커밋을 가리킬 때만 읽는다: 재개 복구로 늦게 통과한 X(순서 5)보다 Y(순서 6)', async () => {
      const seeded = h.read((store) => {
        const rule = insertRule(store, '규칙', 'approved');
        // X: 첫 시도는 실패(순서 값 100을 담은 기록이 있어도 쓰지 않는다), 재개 뒤 통과(T0 + 50초, 순서 5)
        const x = mergedRun(store, {
          ruleIds: [rule.id],
          at: T0 + 1_000,
          headCommit: SHA_C,
          mergeCommit: SHA_A,
          mergeOrder: 5,
          mergeEnd: T0 + 50_000,
          failedMergeOrder: 100,
        });
        // Y: 더 이른 시각(T0 + 20초)에 통과했지만 나중 병합(순서 6)
        const y = mergedRun(store, {
          ruleIds: [rule.id],
          at: T0 + 2_000,
          headCommit: SHA_D,
          mergeCommit: SHA_B,
          mergeOrder: 6,
          mergeEnd: T0 + 20_000,
        });
        // Z: 통과 시도의 값(9)이 실행의 병합 커밋이 아닌 다른 커밋의 것 → 순서 값 없음
        mergedRun(store, {
          ruleIds: [rule.id],
          at: T0 + 3_000,
          headCommit: SHA_F,
          mergeCommit: SHA_E,
          mergeOrder: 9,
          mergeEnd: T0 + 30_000,
          exitMergeCommit: SHA_F,
        });
        return { x, y };
      });
      expect(
        h.read((store) =>
          store.runs
            .steps(seeded.x.id)
            .filter((step) => step.kind === 'merge')
            .map((step) => `${step.kind}#${String(step.attempt)}:${step.status}`),
        ),
      ).toEqual(['merge#1:failed', 'merge#2:passed']);
      expect((await summary()).basis).toEqual({
        branch: 'main',
        commit: SHA_B,
        runId: seeded.y.id,
      });
    });

    it('기준 브랜치가 프로젝트의 지금 기준 브랜치인 후보가 다른 브랜치 후보보다 앞선다 (순서 값이 더 커도)', async () => {
      const seeded = h.read((store) => {
        const rule = insertRule(store, '규칙', 'approved');
        const onMain = mergedRun(store, {
          ruleIds: [rule.id],
          at: T0 + 1_000,
          headCommit: SHA_C,
          mergeCommit: SHA_A,
          mergeOrder: 10,
        });
        // 프로젝트 기준 브랜치가 develop일 때 만든 실행 (병합 순서 값이 더 크다)
        store.projects.update(h.project.id, { baseBranch: 'develop' });
        const onDevelop = mergedRun(store, {
          ruleIds: [rule.id],
          at: T0 + 2_000,
          headCommit: SHA_D,
          mergeCommit: SHA_B,
          mergeOrder: 50,
        });
        store.projects.update(h.project.id, { baseBranch: 'main' });
        return { onMain, onDevelop };
      });
      expect(seeded.onDevelop.baseBranch).toBe('develop');
      // 지금 기준 브랜치 main → 순서 값이 작아도 main 후보
      expect((await summary()).basis).toEqual({
        branch: 'main',
        commit: SHA_A,
        runId: seeded.onMain.id,
      });
      // 기준 브랜치가 develop이 되면 develop 후보
      h.read((store) => store.projects.update(h.project.id, { baseBranch: 'develop' }));
      expect((await summary()).basis).toEqual({
        branch: 'develop',
        commit: SHA_B,
        runId: seeded.onDevelop.id,
      });
    });
  });

  it('등록되지 않은 프로젝트는 -32004', async () => {
    await expect(
      h.client.call('verification.summary', { projectId: newId() }),
    ).rejects.toMatchObject({ code: ErrorCode.NotFound });
  });
});

describe('basisOf: 후보 전체에 하나의 전순서 (#195 · ADR-096)', () => {
  /** 순서에 쓰는 칸만 채운 실행 (테스트 전용). */
  const run = (
    id: string,
    mergeCommit: string | null,
    options: { status?: RunStatus; baseBranch?: string; createdAt?: number } = {},
  ): Run =>
    ({
      id,
      status: options.status ?? 'merged',
      baseBranch: options.baseBranch ?? 'main',
      mergeCommit,
      createdAt: iso(T0 + (options.createdAt ?? 0)),
      endedAt: null,
    }) as Run;
  const records =
    (table: Record<string, MergeRecord>) =>
    (r: Run): MergeRecord | null =>
      table[r.id] ?? null;
  const rec = (at: number | null, order: number | null): MergeRecord => ({
    at: at === null ? null : iso(T0 + at),
    order,
  });
  const ID = (n: number) => `01JE00000000000000000000${String(n).padStart(2, '0')}`;

  /** 배열의 모든 순열. */
  const permutations = <T>(items: readonly T[]): T[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, i) =>
          permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
            item,
            ...rest,
          ]),
        );
  /** 모든 순열에서 같은 결과인지 확인하고 그 결과를 돌려준다. */
  const sameForAll = (runs: Run[], options: BasisOptions): string | null => {
    const results = new Set(
      permutations(runs).map((order) => basisOf(order, options)?.runId ?? null),
    );
    expect([...results]).toHaveLength(1);
    return [...results][0] ?? null;
  };

  it('순서 값이 있는 후보가 없는 후보(저장 전 기록 · 읽기 실패)보다 앞서고, 없는 후보끼리는 병합 단계 통과 시각', () => {
    const runs = [run(ID(1), SHA_A), run(ID(2), SHA_B), run(ID(3), SHA_C)];
    // 순서 값만 보면 1(1) < 2(2), 시각만 보면 2(t20) < 3(t30) < 1(t50). 쌍마다 기준을 바꾸면 순환한다
    const mixed = records({ [ID(1)]: rec(50, 1), [ID(2)]: rec(20, 2), [ID(3)]: rec(30, null) });
    expect(sameForAll(runs, { mergeOf: mixed, branch: 'main' })).toBe(ID(2));
    // 순서 값이 모두 없으면 통과 시각 → 1
    const legacy = records({
      [ID(1)]: rec(50, null),
      [ID(2)]: rec(20, null),
      [ID(3)]: rec(30, null),
    });
    expect(sameForAll(runs, { mergeOf: legacy, branch: 'main' })).toBe(ID(1));
    // 병합 단계 기록이 아예 없으면 생성 시각 → ID
    expect(sameForAll(runs, { branch: 'main' })).toBe(ID(3));
    const created = [
      run(ID(1), SHA_A, { createdAt: 9 }),
      run(ID(2), SHA_B, { createdAt: 1 }),
      run(ID(3), SHA_C, { createdAt: 1 }),
    ];
    expect(sameForAll(created, { branch: 'main' })).toBe(ID(1));
  });

  it('기준 브랜치: 프로젝트의 지금 기준 브랜치 후보가 먼저(순서 값 · 시각보다 앞), 그런 후보가 없거나 모르면 브랜치를 보지 않는다', () => {
    const runs = [
      run(ID(1), SHA_A, { baseBranch: 'main' }),
      run(ID(2), SHA_B, { baseBranch: 'develop' }),
      run(ID(3), SHA_C, { baseBranch: 'develop' }),
    ];
    const table = records({ [ID(1)]: rec(10, 3), [ID(2)]: rec(40, 90), [ID(3)]: rec(50, null) });
    expect(sameForAll(runs, { mergeOf: table, branch: 'main' })).toBe(ID(1));
    expect(sameForAll(runs, { mergeOf: table, branch: 'develop' })).toBe(ID(2));
    // 지금 기준 브랜치의 후보가 없으면 전체에서 같은 규칙
    expect(sameForAll(runs, { mergeOf: table, branch: 'release' })).toBe(ID(2));
    expect(sameForAll(runs, { mergeOf: table, branch: null })).toBe(ID(2));
    // 순서 값 없는 지금 브랜치 후보도 다른 브랜치의 순서 값 있는 후보보다 앞선다
    const onlyLegacyOnMain = records({ [ID(1)]: rec(10, null), [ID(2)]: rec(40, 90) });
    expect(sameForAll(runs.slice(0, 2), { mergeOf: onlyLegacyOnMain, branch: 'main' })).toBe(ID(1));
  });

  it('상태와 무관하게 병합 커밋이 기록된 실행만 후보다', () => {
    const table = records({ [ID(1)]: rec(10, 5), [ID(2)]: rec(20, 6), [ID(3)]: rec(30, 7) });
    const runs = [
      run(ID(1), SHA_A, { status: 'merged' }),
      run(ID(2), SHA_B, { status: 'interrupted' }),
      run(ID(3), null, { status: 'interrupted' }),
    ];
    expect(sameForAll(runs, { mergeOf: table, branch: 'main' })).toBe(ID(2));
    expect(basisOf([run(ID(2), SHA_B, { status: 'failed' })], { mergeOf: table })).toEqual({
      branch: 'main',
      commit: SHA_B,
      runId: ID(2),
    });
    expect(basisOf([run(ID(3), null, { status: 'interrupted' })], { mergeOf: table })).toBeNull();
  });

  it('생성기: 순서 값 있음 · 없음 · 다른 기준 브랜치 · 같은 시각이 섞인 후보 3 ~ 5개의 모든 순열에서 결과가 같다 (400건)', () => {
    // 결정적 의사 난수 (mulberry32)
    let seed = 195;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    let mixedCases = 0;
    for (let n = 0; n < 400; n += 1) {
      const size = 3 + Math.floor(random() * 3);
      const runs: Run[] = [];
      const table: Record<string, MergeRecord> = {};
      for (let i = 0; i < size; i += 1) {
        const id = ID(i + 1);
        runs.push(
          run(id, pick([SHA_A, SHA_B, SHA_C]), {
            status: pick(['merged', 'interrupted', 'failed'] as const),
            baseBranch: pick(['main', 'main', 'develop']),
            createdAt: pick([0, 1, 2]),
          }),
        );
        const kind = pick(['order', 'order', 'null', 'none'] as const);
        if (kind !== 'none') {
          table[id] = rec(pick([null, 10, 20, 30]), kind === 'order' ? pick([1, 2, 3, 4]) : null);
        }
      }
      const kinds = new Set(runs.map((r) => (table[r.id]?.order == null ? 'none' : 'order')));
      const branches = new Set(runs.map((r) => r.baseBranch));
      if (kinds.size === 2 && branches.size === 2) mixedCases += 1;
      const branch = pick(['main', 'develop', null]);
      const chosen = sameForAll(runs, { mergeOf: records(table), branch });
      // 고른 후보는 다른 어느 후보보다도 열쇠가 작지 않다 (열쇠를 직접 비교하는 대조)
      const keyOf = (r: Run) => {
        const m = table[r.id];
        const time = (v: string | null | undefined) => (v == null ? -Infinity : Date.parse(v));
        return [
          branch !== null && r.baseBranch === branch ? 1 : 0,
          m?.order == null ? 0 : 1,
          m?.order ?? 0,
          time(m?.at),
          time(r.createdAt),
        ];
      };
      const winner = runs.find((r) => r.id === chosen) as Run;
      for (const other of runs) {
        if (other.id === winner.id) continue;
        const a = keyOf(winner);
        const b = keyOf(other);
        const index = a.findIndex((v, i) => v !== b[i]);
        if (index >= 0) expect((a[index] as number) > (b[index] as number)).toBe(true);
        else expect(winner.id > other.id).toBe(true);
      }
    }
    // 생성기가 순서 값 있음 · 없음과 두 기준 브랜치가 함께 섞인 경우를 충분히 만들었다
    expect(mixedCases).toBeGreaterThan(50);
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

describe('판정 시각이 같은 판정의 동률 (ADR-072 "판정 시각 → ID", #173)', () => {
  it('기준 커밋의 같은 규칙 판정이 시각까지 같으면 ID가 뒤인 판정이 최신이다 (저장 순서와 무관)', async () => {
    const seeded = h.read((store) => {
      const forward = insertRule(store, '저장 순서 = ID 순서', 'approved');
      const backward = insertRule(store, '저장 순서 ≠ ID 순서', 'approved');
      const run = seedRun(store, {
        ruleIds: [forward.id, backward.id],
        at: T0 + 10_000,
        status: 'merged',
        headCommit: SHA_C,
        mergeCommit: SHA_A,
      });
      const at = T0 + 11_000;
      // ID는 만든 순서대로 커진다: 앞 = 먼저 만든 판정, 뒤 = 나중에 만든 판정
      const forwardEarlier = judgment(forward, 'fail', judgedIn(store, run), at, SHA_C);
      const forwardLater = judgment(forward, 'pass', judgedIn(store, run), at, SHA_C);
      const backwardEarlier = judgment(backward, 'fail', judgedIn(store, run), at, SHA_C);
      const backwardLater = judgment(backward, 'pass', judgedIn(store, run), at, SHA_C);
      expect(forwardEarlier.id < forwardLater.id).toBe(true);
      expect(backwardEarlier.id < backwardLater.id).toBe(true);
      // forward는 ID 순서대로, backward는 거꾸로 저장한다
      store.judgments.record([forwardEarlier, forwardLater, backwardLater, backwardEarlier]);
      return { forward, backward, forwardLater, backwardLater };
    });
    const result = await summary();
    expect(result.basis?.commit).toBe(SHA_A);
    const latestOf = (rule: Rule) =>
      result.rules.find((row) => row.rule.id === rule.id)?.judgment.latest;
    expect(latestOf(seeded.forward)?.id).toBe(seeded.forwardLater.id);
    expect(latestOf(seeded.backward)?.id).toBe(seeded.backwardLater.id);
    // 두 규칙 모두 뒤 ID의 통과 판정이므로 준수 2 / 2
    expect(result.compliance).toEqual({ passed: 2, judgeable: 2 });
  });
});

describe('준수 두 기준 · 에이전트 폐기 수 (M7-16 #228, ADR-100 D7 · B⑦ · JDG-03, ADR-117)', () => {
  const agent = { kind: 'agent', role: 'rule-writer' } as const;
  const confirmRule = (rule: Rule) =>
    h.client.call('confirmation.set', {
      projectId: h.project.id,
      target: { entity: 'Rule', id: rule.id },
      author: human,
    });
  const grounds = (rule: Rule) => `진술 "${rule.statement}"과 새 요구사항이 모순`;
  const retire = (rule: Rule) =>
    h.read((store) =>
      retireAgentRule(
        store,
        { ruleId: rule.id, grounds: grounds(rule), author: agent, sessionId: newId() },
        { now: Date.now },
      ),
    );
  const supersede = (rule: Rule) =>
    h.read((store) =>
      supersedeAgentRule(
        store,
        {
          payload: {
            title: `${rule.title} 대체`,
            statement: `WHEN ${rule.title} 대체 THE SYSTEM SHALL 요청을 받는다`,
            kind: 'business',
            checkKinds: ['test'],
            targetBlocks: ['health'],
            risk: 'medium',
            parentRequirementId: rule.parentRequirementId ?? '',
          },
          rationale: '새 요구사항을 옮김',
          author: agent,
          sessionId: newId(),
          contradiction: { verdict: 'none' },
          normInput: {
            requirements: { total: 1, included: 1, omitted: 0 },
            rules: { total: 1, included: 1, omitted: 0 },
            truncated: false,
          },
          ruleId: rule.id,
          grounds: grounds(rule),
        },
        { now: Date.now, newId },
      ),
    );

  /** 병합된 기준 실행 하나가 규칙마다 주어진 판정을 낸 상태 (검사 판정). 규칙은 주어진 순서. */
  const seedJudged = (titles: readonly (readonly [string, JudgmentResult['status']])[]) =>
    h.read((store) => {
      const rules = titles.map(([title]) => insertRule(store, title, 'approved'));
      const run = seedRun(store, {
        ruleIds: rules.map((rule) => rule.id),
        at: T0 + 10_000,
        status: 'merged',
        headCommit: SHA_C,
        mergeCommit: SHA_A,
      });
      store.judgments.record(
        rules.map((rule, index) =>
          judgment(rule, titles[index]?.[1] ?? 'pass', judgedIn(store, run), T0 + 12_000, SHA_C),
        ),
      );
      return rules;
    });

  it('전체 기준과 사람 확인 기준을 각각의 분모 목록과 함께 돌려주고, 폐기된 규칙은 확인됨이어도 두 분모에서 빠진다 (수용 기준 1)', async () => {
    const [okConfirmed, failConfirmed, quarantinedConfirmed, okUnconfirmed, retiredConfirmed] =
      seedJudged([
        ['확인됨 통과', 'pass'],
        ['확인됨 실패', 'fail'],
        ['확인됨 격리', 'quarantined'],
        ['미확인 통과', 'pass'],
        ['폐기 뒤 확인됨 통과', 'pass'],
      ]) as [Rule, Rule, Rule, Rule, Rule];
    for (const rule of [okConfirmed, failConfirmed, quarantinedConfirmed, retiredConfirmed]) {
      await confirmRule(rule);
    }
    const before = await summary();
    // 폐기 전: 확인됨 통과 · 확인됨 실패 · 폐기될 규칙이 사람 확인 기준 분모
    expect(before.confirmedCompliance).toEqual({ passed: 2, judgeable: 3, confirmed: 4 });
    expect(before.confirmedDenominator).toEqual([
      okConfirmed.id,
      failConfirmed.id,
      retiredConfirmed.id,
    ]);

    // 에이전트가 폐기하면 확인이 풀리고(ADR-113), 사람이 "폐기를 봤다"고 다시 확인하면 폐기된 규칙이 확인됨이 된다
    retire(retiredConfirmed);
    await confirmRule(retiredConfirmed);
    const got = await h.client.call('rule.get', {
      projectId: h.project.id,
      id: retiredConfirmed.id,
    });
    expect(got.rule.confirmation.state).toBe('confirmed');
    expect(got.retirement).toBeDefined();

    const result = await summary();
    // 전체 기준: 효력 있고 격리 아닌 규칙 (확인 상태와 무관)
    expect(result.compliance).toEqual({ passed: 2, judgeable: 3 });
    expect(result.denominator).toEqual([okConfirmed.id, failConfirmed.id, okUnconfirmed.id]);
    // 사람 확인 기준: 그중 확인됨인 것. 폐기 · 확인됨 규칙은 들지 않고, 확인됨 격리 규칙은 확인됨 수에만 든다
    expect(result.confirmedCompliance).toEqual({ passed: 1, judgeable: 2, confirmed: 3 });
    expect(result.confirmedDenominator).toEqual([okConfirmed.id, failConfirmed.id]);
    expect(result.agentRetiredRules).toBe(1);
    // 목록에도 폐기된 규칙은 없고, 남은 규칙의 확인 상태가 실린다
    expect(result.rules.map((row) => [row.rule.title, row.rule.confirmation.state])).toEqual([
      ['확인됨 통과', 'confirmed'],
      ['확인됨 실패', 'confirmed'],
      ['확인됨 격리', 'confirmed'],
      ['미확인 통과', 'unconfirmed'],
    ]);
  });

  it('효력 있는 확인됨 규칙이 없으면 사람 확인 기준은 null이다: 확인됨 규칙이 없을 때 · 확인됨이 폐기된 규칙뿐일 때 (수용 기준 2)', async () => {
    const [kept, retired] = seedJudged([
      ['남는 규칙', 'pass'],
      ['폐기 규칙', 'pass'],
    ]) as [Rule, Rule];
    const none = await summary();
    expect(none.compliance).toEqual({ passed: 2, judgeable: 2 });
    expect(none.confirmedCompliance).toBeNull();
    expect(none.confirmedDenominator).toEqual([]);

    retire(retired);
    await confirmRule(retired);
    const onlyRetired = await summary();
    expect(onlyRetired.compliance).toEqual({ passed: 1, judgeable: 1 });
    expect(onlyRetired.denominator).toEqual([kept.id]);
    expect(onlyRetired.confirmedCompliance).toBeNull();
    expect(onlyRetired.confirmedDenominator).toEqual([]);
  });

  it('확인됨 규칙은 있는데 판정 가능한 것이 없으면(모두 격리) null이 아니라 판정 가능 0 · 확인됨 수를 돌려준다', async () => {
    const [quarantined] = seedJudged([
      ['확인됨 격리', 'quarantined'],
      ['미확인 통과', 'pass'],
    ]) as [Rule, Rule];
    await confirmRule(quarantined);
    const result = await summary();
    expect(result.compliance).toEqual({ passed: 1, judgeable: 1 });
    expect(result.confirmedCompliance).toEqual({ passed: 0, judgeable: 0, confirmed: 1 });
    expect(result.confirmedDenominator).toEqual([]);
  });

  it('에이전트 폐기 수는 규범 변경 기록의 폐기 · 대체 대상 규칙 수이고, 대체로 생긴 새 규칙 · 신규 · 판단 기록은 세지 않는다 (수용 기준 4)', async () => {
    const [first, second] = seedJudged([
      ['폐기될 규칙', 'pass'],
      ['대체될 규칙', 'pass'],
    ]) as [Rule, Rule];
    expect((await summary()).agentRetiredRules).toBe(0);
    retire(first);
    expect((await summary()).agentRetiredRules).toBe(1);
    supersede(second);
    const result = await summary();
    expect(result.agentRetiredRules).toBe(2);
    // 대체로 생긴 새 규칙은 목록에 남고(효력 있음) 폐기 수에 들지 않는다
    expect(result.rules.map((row) => row.rule.title)).toEqual(['대체될 규칙 대체']);
    expect(h.read((store) => store.normChanges.list().map((entry) => entry.kind))).toEqual([
      'retired',
      'created',
      'judgment',
      'superseded',
    ]);
  });
});

describe('사람 확인 기준 · 에이전트 폐기 수 계산 (순수 함수, ADR-117)', () => {
  const ruleOf = (id: string, confirmed: boolean, normState: Rule['normState'] = 'approved') =>
    ({
      id,
      normState,
      deletedAt: null,
      confirmation: confirmed
        ? { state: 'confirmed', at: iso(T0), by: human, basis: { kind: 'approval_log', seq: 1 } }
        : { state: 'unconfirmed' },
    }) as unknown as Rule;
  const pass = { status: 'pass', latest: null } as unknown as RuleJudgment;

  it('확인됨 여부보다 효력을 먼저 본다: 폐기 · 잠정인 확인됨 규칙이 행에 섞여 와도 사람 확인 기준에 들지 않는다', () => {
    const rows = [
      { rule: ruleOf('R1', true), judgment: pass },
      { rule: ruleOf('R2', true), judgment: pass },
      { rule: ruleOf('R3', true, 'provisional'), judgment: pass },
      { rule: ruleOf('R4', false), judgment: pass },
    ];
    expect(humanConfirmedCompliance(rows, new Set(['R2']))).toEqual({
      compliance: { passed: 1, judgeable: 1, confirmed: 1 },
      denominator: ['R1'],
    });
    // 확인됨이 폐기 · 잠정 규칙뿐이면 null
    expect(humanConfirmedCompliance(rows.slice(1), new Set(['R2']))).toEqual({
      compliance: null,
      denominator: [],
    });
  });

  it('폐기 수: 에이전트 주체의 폐기 · 대체 기록만, 규칙마다 한 번', () => {
    const agentActor = { kind: 'agent', role: 'rule-writer' };
    const entry = (kind: string, id: string, actor: object = agentActor) =>
      ({ kind, actor, targetRef: { entity: 'Rule', id } }) as unknown as NormChangeEntry;
    expect(
      agentRetiredRuleCount([
        entry('created', 'R1'),
        entry('retired', 'R1'),
        entry('superseded', 'R2'),
        entry('superseded', 'R2'),
        entry('judgment', 'R3'),
        entry('unconfirmed', 'R1', { kind: 'orchestrator' }),
        entry('retired', 'R4', { kind: 'orchestrator' }),
      ]),
    ).toBe(2);
  });
});

describe('내장 구조 규칙의 준수 · 추적성 결함 (M3-03 #48 수용 기준 3, JDG-03 · NRM-06 · NRM-02, ADR-127)', () => {
  const SAMPLE = {
    blocks: [
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
  const structureJudgment = (
    rule: Rule,
    status: JudgmentResult['status'],
    where: JudgedIn,
    at: number,
    commit: string,
  ): JudgmentResult => ({
    ...judgment(rule, status, where, at, commit),
    runner: 'dependency-cruiser',
    exitCode: null,
  });

  it('블록 선언 저장 직후(판정 기록 없음) 내장 규칙은 다른 규칙의 판정 없음과 같이 판정 가능 항목에 들고, 판정 기준 실행의 구조 검사 판정이 있으면 통과 · 실패로 센다. 추적성 결함(부모 없는 규칙)에서는 빠진다', async () => {
    const plain = h.read((store) => insertRule(store, '일반 규칙', 'approved'));
    await h.client.call('blocks.set', {
      projectId: h.project.id,
      author: human,
      declaration: SAMPLE,
    });
    const builtin = h.read((store) => store.rules.list().filter((rule) => rule.builtin));
    expect(builtin.map((rule) => rule.title)).toEqual([
      '공개 API로만 접근',
      '선언한 방향으로만 의존',
    ]);
    const [publicApi, direction] = builtin as [Rule, Rule];

    // 판정 기록 없음: 일반 규칙과 같은 '판정 없음'으로 분모에 든다
    const fresh = await summary();
    expect(fresh.compliance).toEqual({ passed: 0, judgeable: 3 });
    expect(fresh.denominator).toEqual([plain.id, publicApi.id, direction.id]);
    for (const rule of [plain, ...builtin]) {
      expect(fresh.rules.find((row) => row.rule.id === rule.id)).toMatchObject({
        judgment: UNJUDGED,
        run: null,
      });
    }

    // 판정 기준 실행의 검사 단계: 일반 규칙 통과, 공개 API 규칙 통과, 방향 규칙 실패
    h.read((store) => {
      const run = mergedRun(store, {
        ruleIds: [plain.id],
        at: T0 + 10_000,
        headCommit: SHA_C,
        mergeCommit: SHA_A,
      });
      store.judgments.record([
        judgment(plain, 'pass', judgedIn(store, run), T0 + 11_000, SHA_C),
        structureJudgment(publicApi, 'pass', judgedIn(store, run), T0 + 11_000, SHA_C),
        structureJudgment(direction, 'fail', judgedIn(store, run), T0 + 11_000, SHA_C),
      ]);
    });
    const judged = await summary();
    expect(judged.compliance).toEqual({ passed: 2, judgeable: 3 });
    expect(judged.denominator).toEqual([plain.id, publicApi.id, direction.id]);
    expect(judged.rules.map((row) => [row.rule.displayId, row.judgment.status])).toEqual([
      [plain.displayId, 'pass'],
      [publicApi.displayId, 'pass'],
      [direction.displayId, 'fail'],
    ]);
    // 내장 규칙은 아직 미확인이라 사람 확인 기준에는 들지 않는다
    expect(judged.confirmedCompliance).toBeNull();

    // 추적성 결함(부모 없는 규칙): 부모가 해제된 일반 규칙만, 내장 구조 규칙은 빠진다
    h.read((store) => {
      store.rules.detachFromParent(String(plain.parentRequirementId), iso(T0 + 20_000));
      const rules = store.rules.list();
      expect(rules.filter((rule) => rule.parentRequirementId === null)).toHaveLength(3);
      expect(parentlessRuleDefects(rules, new Set()).map((rule) => rule.id)).toEqual([plain.id]);
      // 대조군: 내장 규칙을 내장이 아니라고 보면 결함에 든다 (빼는 조건이 builtin 하나다)
      expect(
        parentlessRuleDefects(
          rules.map((rule) => ({ ...rule, builtin: false })),
          new Set(),
        ).map((rule) => rule.id),
      ).toEqual([plain.id, publicApi.id, direction.id]);
      // 폐기된 규칙도 결함에서 빠진다
      expect(parentlessRuleDefects(rules, new Set([plain.id]))).toEqual([]);
    });
    // 부모가 해제돼도 일반 규칙은 효력이라 분모 그대로
    expect((await summary()).denominator).toEqual([plain.id, publicApi.id, direction.id]);
  });
});
