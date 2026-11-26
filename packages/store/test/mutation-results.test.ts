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
