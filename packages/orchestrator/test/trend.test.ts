// 준수 추이 (M3-15 #60 수용 기준 1, JDG-04 · JDG-06 · SCR-05, ADR-146).
// `verification.trend`가 병합된 실행(점)마다 통과율(통과 / 판정 가능)과 '변이 검증됨' 비율(변이 검증됨 / 변이 기록 있는 규칙)을
// 판정 기준 순서(시간순)로 돌려주고, 값은 저장된 판정 · 변이 · 단계 기록과 규칙의 생성 · 삭제 · 폐기 시각에서만 만드는지 본다.
// 마지막 점은 검증 요약 카드(`verification.summary`의 `compliance` · `mutation`)와 같다. 규칙 목록의 변이 상태 칸도 여기서 본다.
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소. 데이터는 저장소에 바로 넣는다(테스트 전용).
import {
  type Author,
  createUlidGenerator,
  type JudgmentResult,
  type MutationOutcome,
  mutationStatusOf,
  type Rule,
  type Run,
  type RunType,
  type Step,
  type StepKind,
  type Ulid,
  VERIFICATION_TREND_LIMIT,
  VerificationTrendResult,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PipeServer } from '../src/ipc/server.js';
import { retireAgentRule } from '../src/norms/agent-rule.js';
import { isEffectiveRule, isEffectiveRuleBefore } from '../src/norms/effective.js';
import { createRun } from '../src/runs/run-service.js';
import { verificationTrend } from '../src/verification/trend.js';
import type { TestClient } from './helpers/client.js';
import { cleanup } from './helpers/process.js';
import { iso, startProjectHarness, T0, type ProjectHarness } from './helpers/project-harness.js';

const human = { kind: 'human' } as const satisfies Author;
const newId = createUlidGenerator();
const HOUR = 3_600_000;

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
  h.read((store) =>
    store.settings.update(
      {
        run: { maxBudgetUsd: 5, maxTurns: 200 },
        roles: {
          'rule-writer': { model: 'test-model', maxBudgetUsd: 1, maxTurns: 20 },
          'test-writer': { model: 'test-model', maxBudgetUsd: 2, maxTurns: 100 },
          implementer: { model: 'impl-model', maxBudgetUsd: 3, maxTurns: 150 },
          mutator: { model: 'mutator-model', maxBudgetUsd: 1, maxTurns: 50 },
        },
      },
      { by: human, at: iso(T0) },
    ),
  );
});

const trend = () => h.client.call('verification.trend', { projectId: h.project.id });
const summary = () => h.client.call('verification.summary', { projectId: h.project.id });

const sha = (n: number): string => n.toString(16).padStart(40, '0');

/** 규칙을 저장소에 바로 넣는다 (생성 시각을 정해 지난 시점의 효력을 본다). */
const insertRule = (store: ProjectStore, title: string, createdAt = T0): Rule => {
  const requirement = store.requirements.create({
    id: newId(),
    text: `${title} 요구사항`,
    author: human,
    normState: 'approved',
    createdAt: iso(createdAt),
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
    normState: 'approved',
    createdAt: iso(createdAt),
  });
};

const stepOf = (steps: readonly Step[], kind: StepKind): Step => {
  const step = steps.find((s) => s.kind === kind);
  if (step === undefined) throw new Error(`단계 없음: ${kind}`);
  return step;
};

interface Seeded {
  run: Run;
  steps: Step[];
  head: string;
}

interface RunSeed {
  ruleIds: Ulid[];
  at: number;
  /** 병합 커밋 (생략하면 병합 단계에서 실패로 끝난 실행) */
  mergeCommit?: string;
  type?: RunType;
  /** 병합 단계 통과 시도가 저장한 병합 순서 값 (ADR-096) */
  mergeOrder?: number;
}

/**
 * 실행을 만들고 병합 단계까지 저장소에 바로 남긴다 (엔진이 남기는 저장 형태). 병합 단계 통과 시각 = `at + 30분`. 병합 커밋을
 * 주지 않으면 병합 단계가 실패하고 실행은 `failed`(병합 커밋 없음)다.
 */
const seedRun = (store: ProjectStore, seed: RunSeed): Seeded => {
  const created = createRun(
    store,
    { ruleIds: seed.ruleIds, author: human, ...(seed.type && { type: seed.type }) },
    { clientId: null },
    { now: () => seed.at, newId },
  );
  const runId = created.run.id;
  const head = sha(Math.floor(seed.at / 1000));
  const before = created.steps.filter(
    (step) => step.status === 'pending' && step.kind !== 'merge' && step.kind !== 'screen_update',
  );
  store.runs.transition(runId, {
    run: { status: 'running', currentStep: 'merge', startedAt: iso(seed.at), headCommit: head },
    steps: before.map((step) => ({
      id: step.id,
      status: 'passed' as const,
      startedAt: iso(seed.at),
      endedAt: iso(seed.at + 1_000),
    })),
  });
  const merge = stepOf(created.steps, 'merge');
  const mergeEnd = seed.at + 30 * 60_000;
  if (seed.mergeCommit === undefined) {
    const run = store.runs.transition(runId, {
      run: { status: 'failed', currentStep: null, endedAt: iso(mergeEnd), failureReason: 'x' },
      steps: [{ id: merge.id, status: 'failed', startedAt: iso(seed.at), endedAt: iso(mergeEnd) }],
    }).run;
    return { run, steps: store.runs.steps(runId), head };
  }
  store.runs.transition(runId, {
    steps: [
      {
        id: merge.id,
        status: 'passed',
        startedAt: iso(seed.at + 1_000),
        endedAt: iso(mergeEnd),
        exitDetail: {
          mergeCommit: seed.mergeCommit,
          ...(seed.mergeOrder !== undefined && { mergeOrder: seed.mergeOrder }),
        },
      },
    ],
  });
  const screen = stepOf(created.steps, 'screen_update');
  store.runs.transition(runId, {
    run: { currentStep: 'screen_update', mergeCommit: seed.mergeCommit },
    steps: [{ id: screen.id, status: 'running', startedAt: iso(mergeEnd) }],
  });
  const run = store.runs.transition(runId, {
    run: { status: 'merged', currentStep: null, endedAt: iso(mergeEnd + 1_000) },
    steps: [{ id: screen.id, status: 'passed', endedAt: iso(mergeEnd + 1_000) }],
  }).run;
  return { run, steps: store.runs.steps(runId), head };
};

/** 실행의 검사 단계가 그 실행의 머리 커밋에서 낸 판정. */
const judge = (
  store: ProjectStore,
  seeded: Seeded,
  rule: Rule,
  status: JudgmentResult['status'],
): void => {
  store.judgments.record([
    {
      id: newId(),
      ruleId: rule.id,
      runId: seeded.run.id,
      stepId: stepOf(seeded.steps, 'check').id,
      commit: seeded.head,
      judgedAt: iso(Date.parse(seeded.run.createdAt) + 500),
      status,
      runner: 'vitest',
      exitCode: status === 'pass' ? 0 : 1,
      reporterPath: null,
      cases: [],
      quarantineReason: status === 'quarantined' ? '불안정한 외부 호출' : null,
    },
  ]);
};

/** 실행의 변이 주입 단계가 남긴 변이 기록 (`reinjected`면 재주입 기록: 세션 없음). */
const mutate = (
  store: ProjectStore,
  seeded: Seeded,
  rule: Rule,
  outcome: MutationOutcome,
  { reinjected = false }: { reinjected?: boolean } = {},
) =>
  store.mutations.record({
    id: newId(),
    ruleId: rule.id,
    runId: seeded.run.id,
    stepId: stepOf(seeded.steps, 'mutation').id,
    sessionId: reinjected ? null : newId(),
    commit: seeded.head,
    status: mutationStatusOf(outcome),
    outcome,
    mutant: outcome === 'no_mutant' ? null : { path: 'src/a.ts', search: '>', replace: '>=' },
    recordedAt: iso(Date.parse(seeded.run.createdAt) + 800),
  });

const tallies = (result: VerificationTrendResult) =>
  result.points.map(({ runDisplayId, compliance, mutation }) => ({
    run: runDisplayId,
    compliance,
    mutation,
  }));

describe('verification.trend: 점과 순서 (수용 기준 1)', () => {
  it('병합된 실행이 없으면 점 0개 · 잘림 없음이고, 병합 실패 실행만 있어도 점이 아니다', async () => {
    expect(await trend()).toEqual({ points: [], truncated: false });
    h.read((store) => {
      const rule = insertRule(store, '실패만');
      const failed = seedRun(store, { ruleIds: [rule.id], at: T0 + HOUR });
      judge(store, failed, rule, 'pass');
      mutate(store, failed, rule, 'killed');
    });
    expect(await trend()).toEqual({ points: [], truncated: false });
  });

  it('병합된 실행마다 점 하나를 병합 순서(시간순)로, 실행 · 병합 커밋 · 병합 시각을 짝지어 돌려주고 병합되지 않은 실행은 뺀다', async () => {
    const seeded = h.read((store) => {
      const a = insertRule(store, '규칙 가');
      const b = insertRule(store, '규칙 나');
      const first = seedRun(store, { ruleIds: [a.id], at: T0 + HOUR, mergeCommit: sha(0xa1) });
      judge(store, first, a, 'pass');
      judge(store, first, b, 'fail');
      // 병합되지 않은 실행: 판정 · 변이 기록이 있어도 점이 아니고 다음 점의 값에도 들지 않는다
      const failed = seedRun(store, { ruleIds: [b.id], at: T0 + 2 * HOUR });
      judge(store, failed, a, 'pass');
      judge(store, failed, b, 'pass');
      mutate(store, failed, b, 'killed');
      const second = seedRun(store, { ruleIds: [b.id], at: T0 + 3 * HOUR, mergeCommit: sha(0xb2) });
      judge(store, second, a, 'pass');
      judge(store, second, b, 'pass');
      mutate(store, second, b, 'survived');
      return { first, second };
    });
    const result = await trend();
    expect(VerificationTrendResult.safeParse(result).success).toBe(true);
    expect(result.truncated).toBe(false);
    expect(
      result.points.map(({ runId, runDisplayId, branch, commit, mergedAt }) => ({
        runId,
        runDisplayId,
        branch,
        commit,
        mergedAt,
      })),
    ).toEqual([
      {
        runId: seeded.first.run.id,
        runDisplayId: seeded.first.run.displayId,
        branch: 'main',
        commit: sha(0xa1),
        mergedAt: iso(T0 + HOUR + 30 * 60_000),
      },
      {
        runId: seeded.second.run.id,
        runDisplayId: seeded.second.run.displayId,
        branch: 'main',
        commit: sha(0xb2),
        mergedAt: iso(T0 + 3 * HOUR + 30 * 60_000),
      },
    ]);
    expect(tallies(result)).toEqual([
      {
        run: 'EXE-001',
        compliance: { passed: 1, judgeable: 2 },
        mutation: { verified: 0, tested: 0 },
      },
      {
        run: 'EXE-003',
        compliance: { passed: 2, judgeable: 2 },
        mutation: { verified: 0, tested: 1 },
      },
    ]);
  });

  it('순서는 판정 기준을 고르는 순서다: 병합 순서 값이 있으면 생성 · 병합 시각보다 앞선다', async () => {
    h.read((store) => {
      const a = insertRule(store, '규칙 가');
      // 나중에 만든 실행의 병합 커밋이 기준 브랜치에서 더 앞(조상 수 적음)이면 그 실행이 앞 점이다 (ADR-096)
      seedRun(store, { ruleIds: [a.id], at: T0 + HOUR, mergeCommit: sha(1), mergeOrder: 9 });
      seedRun(store, { ruleIds: [a.id], at: T0 + 2 * HOUR, mergeCommit: sha(2), mergeOrder: 3 });
    });
    expect((await trend()).points.map((point) => point.runDisplayId)).toEqual([
      'EXE-002',
      'EXE-001',
    ]);
    expect((await summary()).basis?.runId).toBe((await trend()).points.at(-1)?.runId);
  });
});

describe('verification.trend: 점마다의 값 (수용 기준 1)', () => {
  it('변이 생존 뒤 보강 실행의 재주입이 검출하면 그 점부터 변이 검증됨이고, 앞 점은 생존 그대로다', async () => {
    h.read((store) => {
      const rule = insertRule(store, '뒤집힘');
      const base = seedRun(store, { ruleIds: [rule.id], at: T0 + HOUR, mergeCommit: sha(0xa) });
      judge(store, base, rule, 'pass');
      const survived = mutate(store, base, rule, 'survived');
      const reinforcing = seedRun(store, {
        ruleIds: [rule.id],
        at: T0 + 2 * HOUR,
        mergeCommit: sha(0xc),
        type: 'C',
      });
      store.mutations.linkReinforcement({
        seq: store.mutations.nextReinforcementSeq(),
        runId: reinforcing.run.id,
        mutationResultId: survived.id,
        createdAt: iso(T0 + 2 * HOUR),
      });
      judge(store, reinforcing, rule, 'pass');
      mutate(store, reinforcing, rule, 'killed', { reinjected: true });
    });
    expect(tallies(await trend())).toEqual([
      {
        run: 'EXE-001',
        compliance: { passed: 1, judgeable: 1 },
        mutation: { verified: 0, tested: 1 },
      },
      {
        run: 'EXE-002',
        compliance: { passed: 1, judgeable: 1 },
        mutation: { verified: 1, tested: 1 },
      },
    ]);
  });

  it('점의 값은 그 점이 기준이던 동안의 끝(다음 병합 바로 앞) 기준: 그 사이 폐기 · 삭제된 규칙은 빠지고 새 규칙은 미판정으로 든다', async () => {
    h.read((store) => {
      const kept = insertRule(store, '남는 규칙');
      const retired = insertRule(store, '폐기될 규칙');
      const deleted = insertRule(store, '지워질 규칙');
      const first = seedRun(store, { ruleIds: [kept.id], at: T0 + HOUR, mergeCommit: sha(1) });
      for (const rule of [kept, retired, deleted]) {
        judge(store, first, rule, 'pass');
        mutate(store, first, rule, 'killed');
      }
      // 첫 점과 둘째 점 사이: 폐기 · 삭제 · 새 규칙
      retireAgentRule(
        store,
        {
          ruleId: retired.id,
          grounds: `진술 "${retired.statement}"과 새 요구사항이 모순`,
          author: { kind: 'agent', role: 'rule-writer' },
          sessionId: newId(),
        },
        { now: () => T0 + 2 * HOUR },
      );
      store.db
        .prepare('UPDATE rules SET deleted_at = ? WHERE id = ?')
        .run(iso(T0 + 2 * HOUR), deleted.id);
      const added = insertRule(store, '새 규칙', T0 + 2 * HOUR);
      const second = seedRun(store, { ruleIds: [kept.id], at: T0 + 3 * HOUR, mergeCommit: sha(2) });
      judge(store, second, kept, 'pass');
      judge(store, second, added, 'fail');
      // 둘째 병합 뒤에 만든 규칙: 첫 점(끝 = 둘째 병합)에는 없고 마지막 점(지금)에는 미판정으로 든다
      insertRule(store, '늦은 규칙', T0 + 5 * HOUR);
    });
    const result = await trend();
    expect(tallies(result)).toEqual([
      // 첫 점이 기준이던 동안의 끝(둘째 병합 앞)에는 폐기 · 삭제가 이미 있었다: 그때 효력 있는 규칙은 남는 규칙과 새 규칙(미판정)
      {
        run: 'EXE-001',
        compliance: { passed: 1, judgeable: 2 },
        mutation: { verified: 1, tested: 1 },
      },
      {
        run: 'EXE-002',
        compliance: { passed: 1, judgeable: 3 },
        mutation: { verified: 1, tested: 1 },
      },
    ]);
  });

  it('형식이 깨져 시각을 읽을 수 없는 폐기 기록은 모든 점에서 폐기로 본다 (검증 요약과 같다)', async () => {
    const broken = h.read((store) => {
      const kept = insertRule(store, '남는 규칙');
      const retired = insertRule(store, '깨진 폐기');
      const first = seedRun(store, { ruleIds: [kept.id], at: T0 + HOUR, mergeCommit: sha(1) });
      judge(store, first, kept, 'pass');
      judge(store, first, retired, 'pass');
      retireAgentRule(
        store,
        {
          ruleId: retired.id,
          grounds: `진술 "${retired.statement}"과 새 요구사항이 모순`,
          author: { kind: 'agent', role: 'rule-writer' },
          sessionId: newId(),
        },
        { now: () => T0 + 5 * HOUR },
      );
      const second = seedRun(store, { ruleIds: [kept.id], at: T0 + 6 * HOUR, mergeCommit: sha(2) });
      judge(store, second, kept, 'pass');
      return retired;
    });
    // 폐기 시각이 읽히면 첫 점(끝 = 둘째 병합 T0+6.5h)보다 앞의 폐기라 첫 점에서 빠진다. 시각을 깨도 빠진다(늘 폐기)
    const [beforeBreak] = tallies(await trend());
    expect(beforeBreak?.compliance).toEqual({ passed: 1, judgeable: 1 });
    // 저장소 밖 변조 재현 (norm-supersede.test.ts와 같은 방식)
    h.read((store) => {
      store.db.exec('DROP TRIGGER rule_retirements_no_update');
      store.db
        .prepare("UPDATE rule_retirements SET retired_at = 'broken' WHERE rule_id = ?")
        .run(broken.id);
    });
    const result = await trend();
    expect(tallies(result).map(({ compliance }) => compliance)).toEqual([
      { passed: 1, judgeable: 1 },
      { passed: 1, judgeable: 1 },
    ]);
    expect(result.points.at(-1)?.compliance).toEqual((await summary()).compliance);
  });

  it('지난 시점의 효력(순수 함수): 그 순간 앞에 만들어졌고 삭제 · 폐기가 그 순간 이후여야 하고, 순간이 무한대면 지금의 효력과 같다', () => {
    const rule = h.read((store) => insertRule(store, '효력', T0));
    const at = T0 + HOUR;
    const none = new Map<string, number>();
    expect(isEffectiveRuleBefore(rule, none, at)).toBe(true);
    expect(isEffectiveRuleBefore(rule, none, T0)).toBe(false);
    expect(isEffectiveRuleBefore({ ...rule, deletedAt: iso(at - 1) }, none, at)).toBe(false);
    expect(isEffectiveRuleBefore({ ...rule, deletedAt: iso(at) }, none, at)).toBe(true);
    expect(isEffectiveRuleBefore({ ...rule, deletedAt: iso(at) }, none, Infinity)).toBe(false);
    expect(isEffectiveRuleBefore(rule, new Map([[rule.id, at - 1]]), at)).toBe(false);
    expect(isEffectiveRuleBefore(rule, new Map([[rule.id, at]]), at)).toBe(true);
    expect(isEffectiveRuleBefore(rule, new Map([[rule.id, at]]), Infinity)).toBe(false);
    expect(isEffectiveRuleBefore(rule, new Map([[rule.id, -Infinity]]), at)).toBe(false);
    expect(isEffectiveRuleBefore({ ...rule, normState: 'provisional' }, none, at)).toBe(false);
  });

  it('순간이 무한대면 지난 시점 효력은 지금의 효력(isEffectiveRule)과 같다: 효력 상태 · 생성 · 삭제 · 폐기 조합 전부', () => {
    const base = h.read((store) => insertRule(store, '조합', T0));
    const createdAts = [iso(T0), iso(Date.now() + 10 * HOUR)];
    const deletedAts = [null, iso(T0 + HOUR), iso(Date.now() + 10 * HOUR)];
    const retiredTimes = [undefined, T0 + HOUR, Date.now() + 10 * HOUR, -Infinity];
    let cases = 0;
    for (const normState of ['approved', 'provisional'] as const) {
      for (const createdAt of createdAts) {
        for (const deletedAt of deletedAts) {
          for (const retired of retiredTimes) {
            const rule: Rule = { ...base, normState, createdAt, deletedAt };
            const times = new Map<string, number>(
              retired === undefined ? [] : [[rule.id, retired]],
            );
            expect(
              isEffectiveRuleBefore(rule, times, Infinity),
              JSON.stringify({ normState, createdAt, deletedAt, retired }),
            ).toBe(isEffectiveRule(rule, new Set(times.keys())));
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBe(48);
  });

  it('앞 실행에서만 판정된 규칙은 뒤 점에서 미판정으로 분모에 든다 (앞 실행의 판정을 이어받지 않는다)', async () => {
    h.read((store) => {
      const early = insertRule(store, '앞에서만 판정');
      const both = insertRule(store, '둘 다 판정');
      const first = seedRun(store, { ruleIds: [both.id], at: T0 + HOUR, mergeCommit: sha(1) });
      judge(store, first, early, 'pass');
      judge(store, first, both, 'pass');
      const second = seedRun(store, { ruleIds: [both.id], at: T0 + 2 * HOUR, mergeCommit: sha(2) });
      judge(store, second, both, 'pass');
    });
    expect(tallies(await trend()).map(({ compliance }) => compliance)).toEqual([
      { passed: 2, judgeable: 2 },
      { passed: 1, judgeable: 2 },
    ]);
    expect((await summary()).compliance).toEqual({ passed: 1, judgeable: 2 });
  });

  it('미래 시각의 변이 기록은 추이와 검증 요약 카드 어디에도 세지 않는다 (판정 기록과 같은 기준)', async () => {
    h.read((store) => {
      const rule = insertRule(store, '미래 기록');
      const seeded = seedRun(store, { ruleIds: [rule.id], at: T0 + HOUR, mergeCommit: sha(1) });
      store.mutations.record({
        id: newId(),
        ruleId: rule.id,
        runId: seeded.run.id,
        stepId: stepOf(seeded.steps, 'mutation').id,
        sessionId: newId(),
        commit: seeded.head,
        status: 'verified',
        outcome: 'killed',
        mutant: { path: 'src/a.ts', search: '>', replace: '>=' },
        recordedAt: iso(Date.now() + 10 * HOUR),
      });
    });
    expect(tallies(await trend())[0]?.mutation).toEqual({ verified: 0, tested: 0 });
    expect((await summary()).mutation).toEqual({ verified: 0, tested: 0 });
  });

  it('폐기가 둘째 병합 뒤면 첫 점은 폐기 전 분모, 둘째(마지막) 점은 폐기 뒤 분모다', async () => {
    const retiredRule = h.read((store) => {
      const kept = insertRule(store, '남는 규칙');
      const retired = insertRule(store, '폐기될 규칙');
      const first = seedRun(store, { ruleIds: [kept.id], at: T0 + HOUR, mergeCommit: sha(1) });
      const second = seedRun(store, { ruleIds: [kept.id], at: T0 + 3 * HOUR, mergeCommit: sha(2) });
      for (const seeded of [first, second]) {
        judge(store, seeded, kept, 'pass');
        judge(store, seeded, retired, 'fail');
        mutate(store, seeded, retired, 'survived');
      }
      return retired;
    });
    const before = tallies(await trend());
    expect(before).toEqual([
      {
        run: 'EXE-001',
        compliance: { passed: 1, judgeable: 2 },
        mutation: { verified: 0, tested: 1 },
      },
      {
        run: 'EXE-002',
        compliance: { passed: 1, judgeable: 2 },
        mutation: { verified: 0, tested: 1 },
      },
    ]);
    h.read((store) =>
      retireAgentRule(
        store,
        {
          ruleId: retiredRule.id,
          grounds: `진술 "${retiredRule.statement}"과 새 요구사항이 모순`,
          author: { kind: 'agent', role: 'rule-writer' },
          sessionId: newId(),
        },
        { now: () => T0 + 5 * HOUR },
      ),
    );
    expect(tallies(await trend())).toEqual([
      {
        run: 'EXE-001',
        compliance: { passed: 1, judgeable: 2 },
        mutation: { verified: 0, tested: 1 },
      },
      {
        run: 'EXE-002',
        compliance: { passed: 1, judgeable: 1 },
        mutation: { verified: 0, tested: 0 },
      },
    ]);
  });

  it('격리 판정은 분모에서 빠지고, 판정되지 않은 규칙은 분모에 든다. 미검증 기록은 변이 분모에만 든다', async () => {
    h.read((store) => {
      const pass = insertRule(store, '통과');
      const quarantined = insertRule(store, '격리');
      insertRule(store, '미판정');
      const seeded = seedRun(store, { ruleIds: [pass.id], at: T0 + HOUR, mergeCommit: sha(1) });
      judge(store, seeded, pass, 'pass');
      judge(store, seeded, quarantined, 'quarantined');
      mutate(store, seeded, pass, 'killed');
      mutate(store, seeded, quarantined, 'runner_error');
    });
    expect(tallies(await trend())).toEqual([
      {
        run: 'EXE-001',
        compliance: { passed: 1, judgeable: 2 },
        mutation: { verified: 1, tested: 2 },
      },
    ]);
  });

  it('마지막 점의 두 값은 검증 요약의 준수 · 변이 검증됨 카드 값과 같다', async () => {
    h.read((store) => {
      const a = insertRule(store, '가');
      const b = insertRule(store, '나');
      const c = insertRule(store, '다');
      const first = seedRun(store, { ruleIds: [a.id], at: T0 + HOUR, mergeCommit: sha(1) });
      judge(store, first, a, 'fail');
      mutate(store, first, b, 'survived');
      const second = seedRun(store, { ruleIds: [a.id], at: T0 + 2 * HOUR, mergeCommit: sha(2) });
      judge(store, second, a, 'pass');
      judge(store, second, b, 'pass');
      judge(store, second, c, 'quarantined');
      mutate(store, second, a, 'killed');
      // 마지막 병합 뒤: 새 규칙(미판정, 분모에 듦) · 병합되지 않은 실행의 변이 기록(세지 않음)
      insertRule(store, '라', T0 + 3 * HOUR);
      const failed = seedRun(store, { ruleIds: [b.id], at: T0 + 4 * HOUR });
      mutate(store, failed, b, 'killed');
    });
    const [result, card] = [await trend(), await summary()];
    const last = result.points.at(-1);
    expect(last?.compliance).toEqual(card.compliance);
    expect(last?.mutation).toEqual(card.mutation);
    expect(card.compliance).toEqual({ passed: 2, judgeable: 3 });
    expect(card.mutation).toEqual({ verified: 1, tested: 2 });
    expect(last?.runId).toBe(card.basis?.runId);
  });
});

describe('verification.trend: 상한 · 조회 수 (수용 기준 1)', () => {
  it('점이 상한보다 많으면 최근 점 상한 개와 잘림 표시를 돌려주고, 잘린 앞 실행의 변이 기록도 센다', async () => {
    const total = VERIFICATION_TREND_LIMIT + 2;
    h.read((store) => {
      const rule = insertRule(store, '많은 실행');
      for (let i = 0; i < total; i += 1) {
        const seeded = seedRun(store, {
          ruleIds: [rule.id],
          at: T0 + i * HOUR,
          mergeCommit: sha(i + 1),
        });
        judge(store, seeded, rule, i % 2 === 0 ? 'pass' : 'fail');
        if (i === 0) mutate(store, seeded, rule, 'killed');
      }
    });
    const result = await trend();
    expect(VerificationTrendResult.safeParse(result).success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.points).toHaveLength(VERIFICATION_TREND_LIMIT);
    expect(result.points[0]?.commit).toBe(sha(3));
    expect(result.points.at(-1)?.commit).toBe(sha(total));
    expect(result.points[0]?.compliance).toEqual({ passed: 1, judgeable: 1 });
    expect(result.points[1]?.compliance).toEqual({ passed: 0, judgeable: 1 });
    expect(
      result.points.every(({ mutation }) => mutation.verified === 1 && mutation.tested === 1),
    ).toBe(true);
  });

  it('실행이 많아도 한 번의 추이가 실행마다 따로 읽지 않는다 (묶음 조회 각 1회)', () => {
    h.read((store) => {
      const rule = insertRule(store, '조회 수');
      for (let i = 0; i < VERIFICATION_TREND_LIMIT + 5; i += 1) {
        const seeded = seedRun(store, {
          ruleIds: [rule.id],
          at: T0 + i * HOUR,
          mergeCommit: sha(i + 1),
        });
        judge(store, seeded, rule, 'pass');
        mutate(store, seeded, rule, 'killed');
      }
      const perRun = [
        vi.spyOn(store.runs, 'steps'),
        vi.spyOn(store.runs, 'get'),
        vi.spyOn(store.runs, 'usage'),
        vi.spyOn(store.judgments, 'listByRun'),
        vi.spyOn(store.judgments, 'latestByRule'),
        vi.spyOn(store.mutations, 'listByRun'),
        vi.spyOn(store.mutations, 'latestByRule'),
        vi.spyOn(store.rules, 'get'),
      ];
      const bulk = [
        vi.spyOn(store.runs, 'list'),
        vi.spyOn(store.runs, 'stepsOfMergedRuns'),
        vi.spyOn(store.judgments, 'listByRuns'),
        vi.spyOn(store.mutations, 'list'),
        vi.spyOn(store.rules, 'list'),
      ];
      const result = verificationTrend(store);
      expect(result.points).toHaveLength(VERIFICATION_TREND_LIMIT);
      for (const spy of perRun) expect(spy).not.toHaveBeenCalled();
      for (const spy of bulk) expect(spy).toHaveBeenCalledTimes(1);
      // 판정 기록은 보일 점의 실행만 묻는다
      expect(bulk[2]?.mock.calls[0]?.[0]).toHaveLength(VERIFICATION_TREND_LIMIT);
    });
  });
});

describe('rule.list의 변이 상태 (수용 기준 3의 서버 값, ADR-139 · ADR-143 · ADR-146)', () => {
  it('규칙마다 가장 나중 변이 기록의 상태(병합 여부와 무관), 기록이 없으면 변이 미검증', async () => {
    const ids = h.read((store) => {
      const none = insertRule(store, '기록 없음');
      const flipped = insertRule(store, '뒤집힘');
      const survived = insertRule(store, '생존');
      const first = seedRun(store, { ruleIds: [flipped.id], at: T0 + HOUR, mergeCommit: sha(1) });
      mutate(store, first, flipped, 'survived');
      mutate(store, first, survived, 'killed');
      const failed = seedRun(store, { ruleIds: [flipped.id], at: T0 + 2 * HOUR });
      mutate(store, failed, flipped, 'killed');
      mutate(store, failed, survived, 'survived');
      return { none: none.id, flipped: flipped.id, survived: survived.id };
    });
    const { rules } = await h.client.call('rule.list', { projectId: h.project.id });
    expect(Object.fromEntries(rules.map((item) => [item.rule.id, item.mutation]))).toEqual({
      [ids.none]: 'unverified',
      [ids.flipped]: 'verified',
      [ids.survived]: 'survived',
    });
  });
});
