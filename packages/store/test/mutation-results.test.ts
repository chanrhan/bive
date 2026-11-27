// 변이 판정 기록 리포지토리 (M3-07 #52, JDG-04, ADR-139). 실제 SQLite 임시 저장소. 테이블 `mutation_results`(0026).
import { type Author, type MutationResult, RUN_STEP_PLANS, STEP_ROLES } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();
const T0 = '2026-11-26T00:00:00.000Z';
const T1 = '2026-11-26T01:00:00.000Z';
const T2 = '2026-11-26T02:00:00.000Z';
const COMMIT = 'c'.repeat(40);
const human = { kind: 'human' } as const satisfies Author;
const MUTANT = { path: 'src/app/api/auth/session/route.ts', search: '401', replace: '200' };

const withStore = <T>(fn: (store: ProjectStore) => T): T => {
  const store = openProjectStore(newId(), { home: home() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

const seed = (store: ProjectStore) => {
  const requirement = store.requirements.create({
    id: newId(),
    text: '요구사항',
    author: human,
    normState: 'approved',
    createdAt: T0,
  });
  const rule = store.rules.create({
    id: newId(),
    title: '세션 확인',
    statement: 'WHEN GET /api/auth/session THE SYSTEM SHALL 401을 돌려준다',
    kind: 'business',
    checkKinds: ['test'],
    parentRequirementId: requirement.id,
    builtin: false,
    targetBlockIds: ['auth'],
    risk: 'high',
    contractId: null,
    author: { kind: 'agent', role: 'rule-writer' },
    normState: 'approved',
    createdAt: T0,
  });
  const detail = store.runs.create({
    id: newId(),
    type: 'A',
    targetRuleIds: [rule.id],
    currentStep: 'approval',
    baseBranch: 'main',
    budgetSnapshot: { run: { maxBudgetUsd: 5, maxTurns: 200 }, roles: {} },
    modelSnapshot: {},
    startedBy: human,
    createdAt: T0,
    steps: RUN_STEP_PLANS.A.map((kind) => ({
      id: newId(),
      kind,
      attempt: 1,
      status: 'pending' as const,
      role: STEP_ROLES[kind],
      startedAt: null,
    })),
  });
  const step = detail.steps.find((item) => item.kind === 'mutation');
  if (step === undefined) throw new Error('변이 주입 단계 없음');
  // 변이 주입 단계의 역할은 변이 주입 역할이다 (M3-07)
  expect(step.role).toBe('mutator');
  return { rule, run: detail.run, step };
};

const result = (
  base: ReturnType<typeof seed>,
  overrides: Partial<MutationResult> = {},
): MutationResult => ({
  id: newId(),
  ruleId: base.rule.id,
  runId: base.run.id,
  stepId: base.step.id,
  sessionId: newId(),
  commit: COMMIT,
  status: 'survived',
  outcome: 'survived',
  mutant: MUTANT,
  recordedAt: T1,
  ...overrides,
});

describe('mutation_results', () => {
  it('기록이 없으면 변이 미검증이고, 규칙의 상태는 가장 최근 기록(기록 시각 → ID)의 상태다', () => {
    withStore((store) => {
      const base = seed(store);
      expect(store.mutations.latestByRule(base.rule.id)).toBeNull();
      expect(store.mutations.statusOf(base.rule.id)).toBe('unverified');
      const survived = store.mutations.record(result(base));
      expect(store.mutations.latestByRule(base.rule.id)).toEqual(survived);
      expect(store.mutations.statusOf(base.rule.id)).toBe('survived');
      const killed = store.mutations.record(
        result(base, { status: 'verified', outcome: 'killed', recordedAt: T2 }),
      );
      expect(store.mutations.statusOf(base.rule.id)).toBe('verified');
      // 기록 시각이 앞선 기록을 나중에 남겨도 최신은 시각 순이다
      store.mutations.record(
        result(base, { status: 'unverified', outcome: 'runner_error', recordedAt: T0 }),
      );
      expect(store.mutations.latestByRule(base.rule.id)?.id).toBe(killed.id);
      expect(store.mutations.listByRun(base.run.id).map((item) => item.outcome)).toEqual([
        'runner_error',
        'survived',
        'killed',
      ]);
      // 변이는 원문 그대로 왕복한다
      expect(store.mutations.listByRun(base.run.id)[1]?.mutant).toEqual(MUTANT);
    });
  });

  it('상태가 판정 결과와 맞지 않거나 변이 유무가 어긋나면 남기지 않는다 (스키마 · 표 CHECK 이중)', () => {
    withStore((store) => {
      const base = seed(store);
      expect(() => store.mutations.record(result(base, { status: 'verified' }))).toThrow();
      expect(() =>
        store.mutations.record(result(base, { outcome: 'install_error', status: 'verified' })),
      ).toThrow();
      expect(() => store.mutations.record(result(base, { mutant: null }))).toThrow();
      expect(store.mutations.listByRun(base.run.id)).toEqual([]);
      // 스키마를 건너뛴 직접 쓰기도 표 CHECK가 막는다
      const insert = store.db.prepare(
        `INSERT INTO mutation_results (id, rule_id, run_id, step_id, session_id, commit_sha, status, outcome, mutant, recorded_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      );
      const json = JSON.stringify(MUTANT);
      const row = (status: string, outcome: string, mutant: string | null) => () =>
        insert.run(
          newId(),
          base.rule.id,
          base.run.id,
          base.step.id,
          COMMIT,
          status,
          outcome,
          mutant,
          T1,
        );
      expect(row('verified', 'runner_error', json)).toThrow(/CHECK/);
      expect(row('verified', 'survived', json)).toThrow(/CHECK/);
      expect(row('survived', 'killed', json)).toThrow(/CHECK/);
      expect(row('unverified', 'no_mutant', json)).toThrow(/CHECK/);
      expect(row('unverified', 'runner_error', null)).toThrow(/CHECK/);
      expect(row('verified', 'killed', json)).not.toThrow();
    });
  });

  it('추가 전용: 같은 ID 덮어쓰기 · 수정 · 삭제를 막는다', () => {
    withStore((store) => {
      const base = seed(store);
      const saved = store.mutations.record(result(base));
      expect(() => store.mutations.record({ ...saved })).toThrow(/덮어쓰기 금지/);
      expect(() =>
        store.db
          .prepare("UPDATE mutation_results SET status = 'verified', outcome = 'killed'")
          .run(),
      ).toThrow(/바꿀 수 없습니다/);
      expect(() => store.db.prepare('DELETE FROM mutation_results').run()).toThrow(
        /지울 수 없습니다/,
      );
      expect(store.mutations.statusOf(base.rule.id)).toBe('survived');
    });
  });

  it('없는 규칙 · 실행 · 단계를 가리키면 외래 키로 거부한다', () => {
    withStore((store) => {
      const base = seed(store);
      expect(() => store.mutations.record(result(base, { ruleId: newId() }))).toThrow(
        /FOREIGN KEY/,
      );
      expect(() => store.mutations.record(result(base, { stepId: newId() }))).toThrow(
        /FOREIGN KEY/,
      );
    });
  });
});

/** 같은 저장소에 유형 C · A 실행 하나 (대상 = `ruleId`). */
const runOf = (store: ProjectStore, ruleId: string, type: 'A' | 'C') => {
  const plan = RUN_STEP_PLANS[type];
  const detail = store.runs.create({
    id: newId(),
    type,
    targetRuleIds: [ruleId],
    currentStep: 'approval',
    baseBranch: 'main',
    budgetSnapshot: { run: { maxBudgetUsd: 5, maxTurns: 200 }, roles: {} },
    modelSnapshot: {},
    startedBy: human,
    createdAt: T0,
    steps: plan.map((kind) => ({
      id: newId(),
      kind,
      attempt: 1,
      status: 'pending' as const,
      role: STEP_ROLES[kind],
      startedAt: null,
    })),
  });
  const step = detail.steps.find((item) => item.kind === 'mutation');
  if (step === undefined) throw new Error('변이 주입 단계 없음');
  return { run: detail.run, step };
};

describe('mutation_reinforcements (M3-54 #311, ADR-141 ③ · ADR-143)', () => {
  it('보강 실행(유형 C)과 원인 생존 기록을 잇고 순번 · 실행 · 기록으로 읽는다. 실행 · 기록마다 하나', () => {
    withStore((store) => {
      const base = seed(store);
      const survived = store.mutations.record(result(base));
      const reinforcing = runOf(store, base.rule.id, 'C');
      expect(store.mutations.nextReinforcementSeq()).toBe(1);
      const link = store.mutations.linkReinforcement({
        seq: 1,
        runId: reinforcing.run.id,
        mutationResultId: survived.id,
        createdAt: T2,
      });
      expect(store.mutations.reinforcementBySeq(1)).toEqual(link);
      expect(store.mutations.reinforcementOfRun(reinforcing.run.id)).toEqual(link);
      expect(store.mutations.reinforcementOfResult(survived.id)).toEqual(link);
      expect(store.mutations.reinforcementOfRun(base.run.id)).toBeNull();
      expect(store.mutations.nextReinforcementSeq()).toBe(2);
      expect(store.mutations.get(survived.id)).toEqual(survived);
      // 같은 변이 기록으로 또 잇지 못한다 (다른 보강 실행이어도: 실패 뒤 다시 만들지 않는다)
      const another = runOf(store, base.rule.id, 'C');
      expect(() =>
        store.mutations.linkReinforcement({
          seq: 2,
          runId: another.run.id,
          mutationResultId: survived.id,
          createdAt: T2,
        }),
      ).toThrow(/UNIQUE/);
      // 같은 실행에 둘째 원인도 없다
      const second = store.mutations.record(result(base, { recordedAt: T2 }));
      expect(() =>
        store.mutations.linkReinforcement({
          seq: 2,
          runId: reinforcing.run.id,
          mutationResultId: second.id,
          createdAt: T2,
        }),
      ).toThrow(/UNIQUE/);
    });
  });

  it('원인은 유형 A 실행의 생존 기록만, 잇는 실행은 그 규칙을 대상으로 한 유형 C만 (트리거, 직접 쓰기 포함)', () => {
    withStore((store) => {
      const base = seed(store);
      const reinforcing = runOf(store, base.rule.id, 'C');
      const link =
        (mutationResultId: string, runId = reinforcing.run.id, seq = 1) =>
        () =>
          store.mutations.linkReinforcement({ seq, runId, mutationResultId, createdAt: T2 });
      // 검증됨 · 미검증은 원인이 아니다
      const killed = store.mutations.record(
        result(base, { status: 'verified', outcome: 'killed' }),
      );
      expect(link(killed.id)).toThrow(/변이 생존 기록/);
      const unverified = store.mutations.record(
        result(base, { status: 'unverified', outcome: 'runner_error' }),
      );
      expect(link(unverified.id)).toThrow(/변이 생존 기록/);
      // 보강 실행(유형 C)의 재주입 생존 기록은 원인이 아니다 (고리 방지)
      const reinjected = store.mutations.record(
        result(base, { runId: reinforcing.run.id, stepId: reinforcing.step.id }),
      );
      expect(link(reinjected.id, runOf(store, base.rule.id, 'C').run.id)).toThrow(/변이 생존 기록/);
      // 보강 실행은 유형 C여야 하고 원인 규칙을 대상으로 해야 한다
      const survived = store.mutations.record(result(base));
      expect(link(survived.id, runOf(store, base.rule.id, 'A').run.id)).toThrow(/유형 C/);
      const otherRule = store.rules.create({
        ...store.rules.get(base.rule.id)!,
        id: newId(),
        title: '다른 규칙',
        createdAt: T0,
      } as never);
      expect(link(survived.id, runOf(store, otherRule.id, 'C').run.id)).toThrow(/유형 C/);
      // 직접 쓰기도 같은 트리거 · 외래 키를 지난다
      expect(() =>
        store.db
          .prepare(
            'INSERT INTO mutation_reinforcements (seq, run_id, mutation_result_id, created_at) VALUES (9, ?, ?, ?)',
          )
          .run(reinforcing.run.id, killed.id, T2),
      ).toThrow(/변이 생존 기록/);
      expect(link(survived.id)).not.toThrow();
      expect(() => store.db.prepare('UPDATE mutation_reinforcements SET seq = 5').run()).toThrow(
        /바꿀 수 없습니다/,
      );
      expect(() => store.db.prepare('DELETE FROM mutation_reinforcements').run()).toThrow(
        /지울 수 없습니다/,
      );
    });
  });
});

/** 실행을 병합 커밋까지 기록한다 (단계는 그대로, 실행의 병합 커밋 칸만. 저장소 상태 기계를 지난다). */
const markMerged = (store: ProjectStore, runId: string, commit: string) => {
  store.runs.transition(runId, { run: { status: 'running', startedAt: T0 } });
  store.runs.transition(runId, {
    run: { mergeCommit: commit, status: 'merged', currentStep: null, endedAt: T1 },
  });
};

describe('준수 추이의 묶음 읽기 (M3-15 #60, ADR-146)', () => {
  it('mutations.list: 비면 빈 목록, 여러 실행 · 규칙의 기록을 기록 시각 → ID 순으로 한 번에', () => {
    withStore((store) => {
      expect(store.mutations.list()).toEqual([]);
      const base = seed(store);
      const other = runOf(store, base.rule.id, 'A');
      const late = store.mutations.record(result(base, { recordedAt: T2 }));
      const early = store.mutations.record(
        result({ ...base, run: other.run, step: other.step }, { recordedAt: T0 }),
      );
      const middle = store.mutations.record(
        result(base, { status: 'verified', outcome: 'killed', recordedAt: T1 }),
      );
      expect(store.mutations.list().map((item) => item.id)).toEqual([early.id, middle.id, late.id]);
    });
  });

  it('mutations.latestForRules: 비면 빈 표, 규칙마다 가장 최근 기록(시각이 같으면 ID가 큰 것), 기록 없는 규칙 · 없는 ID는 없음', () => {
    withStore((store) => {
      expect(store.mutations.latestForRules().size).toBe(0);
      const base = seed(store);
      const second = seed(store);
      const first = store.mutations.record(result(base, { recordedAt: T2 }));
      const later = store.mutations.record(
        result(base, { status: 'verified', outcome: 'killed', recordedAt: T2 }),
      );
      store.mutations.record(result(base, { recordedAt: T0 }));
      // 같은 시각이면 ID가 큰(나중에 만든 ULID) 기록
      expect(later.id > first.id).toBe(true);
      const latest = store.mutations.latestForRules();
      expect([...latest.keys()]).toEqual([base.rule.id]);
      expect(latest.get(base.rule.id)?.id).toBe(later.id);
      expect(latest.get(second.rule.id)).toBeUndefined();
      expect(latest.get(newId())).toBeUndefined();
    });
  });

  it('judgments.listByRuns: 빈 입력 · 없는 실행 ID는 빈 목록, 고른 실행들의 기록만 판정 시각 → ID 순으로 한 번에', () => {
    withStore((store) => {
      expect(store.judgments.listByRuns([])).toEqual([]);
      const base = seed(store);
      const other = runOf(store, base.rule.id, 'A');
      const third = runOf(store, base.rule.id, 'A');
      const judge = (target: { run: { id: string }; step: { id: string } }, judgedAt: string) => ({
        id: newId(),
        ruleId: base.rule.id,
        runId: target.run.id,
        stepId: target.step.id,
        commit: COMMIT,
        judgedAt,
        status: 'pass' as const,
        runner: 'vitest' as const,
        exitCode: 0,
        reporterPath: null,
        cases: [],
        quarantineReason: null,
      });
      const [a] = store.judgments.record([judge(base, T2)]);
      const [b] = store.judgments.record([judge(other, T0)]);
      store.judgments.record([judge(third, T1)]);
      expect(store.judgments.listByRuns([newId()])).toEqual([]);
      expect(
        store.judgments.listByRuns([base.run.id, other.run.id]).map((item) => item.id),
      ).toEqual([b?.id, a?.id]);
    });
  });

  it('runs.stepsOfMergedRuns: 병합 커밋이 없으면 빈 표, 병합된 실행만 실행별 파이프라인 순서로 한 번에', () => {
    withStore((store) => {
      expect(store.runs.stepsOfMergedRuns().size).toBe(0);
      const base = seed(store);
      const other = runOf(store, base.rule.id, 'A');
      const unmerged = runOf(store, base.rule.id, 'A');
      expect(store.runs.stepsOfMergedRuns().size).toBe(0);
      markMerged(store, base.run.id, 'a'.repeat(40));
      markMerged(store, other.run.id, 'b'.repeat(40));
      const byRun = store.runs.stepsOfMergedRuns();
      expect([...byRun.keys()].sort()).toEqual([base.run.id, other.run.id].sort());
      expect(byRun.has(unmerged.run.id)).toBe(false);
      for (const runId of [base.run.id, other.run.id]) {
        expect(byRun.get(runId)).toEqual(store.runs.steps(runId));
        expect(byRun.get(runId)?.map((step) => step.kind)).toEqual(RUN_STEP_PLANS.A);
      }
    });
  });
});
