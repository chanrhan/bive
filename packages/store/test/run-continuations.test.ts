// 이어받는 실행의 연결 표 (M3-56 #319, TODO-02 · COST-01 · NFR-01, ADR-147 ② ⑦, ADR-149). 실제 SQLite 임시 저장소. 표
// `run_continuations`(0030): 예산 초과로 끝난 원 실행과 그것을 이어받는 새 실행 1쌍. 넣을 때의 조건 · 추가 전용 · 기준 커밋 ·
// 보강 원인 뷰의 사슬 · 한도 상향 재개 처리의 결과 확인은 DB 트리거가 본다.
import {
  type Author,
  RUN_STATUS_TRANSITIONS,
  type RunStatus,
  RUN_STEP_PLANS,
  type RunType,
  STEP_ROLES,
} from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();
const T0 = '2026-11-28T00:00:00.000Z';
const T1 = '2026-11-28T01:00:00.000Z';
const T2 = '2026-11-28T02:00:00.000Z';
const BASE = 'a'.repeat(40);
const OTHER_BASE = 'b'.repeat(40);
const COMMIT = 'c'.repeat(40);
const human = { kind: 'human' } as const satisfies Author;
const MUTANT = { path: 'src/app/api/health/route.ts', search: 'time', replace: 'tick' };

const withStore = <T>(fn: (store: ProjectStore) => T): T => {
  const store = openProjectStore(newId(), { home: home() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

const seedRule = (store: ProjectStore, title = '헬스 체크 서버 시각') => {
  const requirement = store.requirements.create({
    id: newId(),
    text: `요구사항 ${title}`,
    author: human,
    normState: 'approved',
    createdAt: T0,
  });
  return store.rules.create({
    id: newId(),
    title,
    statement: `WHEN GET /api/health THE SYSTEM SHALL ${title}을 담는다`,
    kind: 'business',
    checkKinds: ['test'],
    parentRequirementId: requirement.id,
    builtin: false,
    targetBlockIds: ['health'],
    risk: 'medium',
    contractId: null,
    author: { kind: 'agent', role: 'rule-writer' },
    normState: 'approved',
    createdAt: T0,
  });
};

const createRun = (
  store: ProjectStore,
  ruleIds: readonly string[],
  type: RunType = 'A',
  startedBy: Parameters<ProjectStore['runs']['create']>[0]['startedBy'] = human,
) =>
  store.runs.create({
    id: newId(),
    type,
    targetRuleIds: [...ruleIds],
    currentStep: 'approval',
    baseBranch: 'main',
    budgetSnapshot: { run: { maxBudgetUsd: 5, maxTurns: 200 }, roles: {} },
    modelSnapshot: {},
    startedBy,
    createdAt: T0,
    steps: RUN_STEP_PLANS[type].map((kind) => ({
      id: newId(),
      kind,
      attempt: 1,
      status: 'pending' as const,
      role: STEP_ROLES[kind],
      startedAt: null,
    })),
  });

/** 승인 대기 → 진행 중(기준 커밋 `base`) → `status`. */
const endRun = (
  store: ProjectStore,
  runId: string,
  status: RunStatus,
  base: string | null = BASE,
) => {
  store.runs.transition(runId, {
    run: {
      status: 'running',
      startedAt: T0,
      ...(base === null
        ? {}
        : { baseCommit: base, branch: `bive/run-${runId.slice(0, 3)}`, worktreePath: '/w' }),
    },
  });
  return store.runs.transition(runId, {
    expectedStatus: 'running',
    run:
      status === 'merged'
        ? { status, mergeCommit: COMMIT, currentStep: null, endedAt: T1 }
        : { status, failureReason: 'test_end', endedAt: T1 },
  });
};

const link = (store: ProjectStore, runId: string, originRunId: string) =>
  store.runContinuations.link({ runId, originRunId, createdAt: T2 });

describe('run_continuations: 넣을 때의 조건 (ADR-147 ②)', () => {
  it('예산 초과로 끝난 원 실행과 같은 유형 · 대상 규칙(순서까지)으로 사람이 막 시작한 실행을 잇는다. 원 실행 · 이어받는 실행 · 사슬을 읽는다', () => {
    withStore((store) => {
      const rule = seedRule(store);
      const second = seedRule(store, '둘째');
      const origin = createRun(store, [rule.id, second.id]);
      endRun(store, origin.run.id, 'budget_exceeded');
      const next = createRun(store, [rule.id, second.id]);
      expect(link(store, next.run.id, origin.run.id)).toEqual({
        runId: next.run.id,
        originRunId: origin.run.id,
        createdAt: T2,
      });
      expect(store.runContinuations.originOf(next.run.id)?.originRunId).toBe(origin.run.id);
      expect(store.runContinuations.continuationOf(origin.run.id)?.runId).toBe(next.run.id);
      expect(store.runContinuations.originOf(origin.run.id)).toBeNull();
      expect(store.runContinuations.ancestorsOf(origin.run.id)).toEqual([]);
      expect(store.runContinuations.ancestorsOf(next.run.id)).toEqual([origin.run.id]);
      // 이어받는 실행이 다시 예산 초과로 끝나면 그 실행을 다시 잇는다: 사슬 원 → 1차 → 2차 (뿌리부터)
      endRun(store, next.run.id, 'budget_exceeded');
      const third = createRun(store, [rule.id, second.id]);
      link(store, third.run.id, next.run.id);
      expect(store.runContinuations.ancestorsOf(third.run.id)).toEqual([
        origin.run.id,
        next.run.id,
      ]);
    });
  });

  it('원 실행이 예산 초과가 아님(실패 · 병합 · 진행 중 · 승인 대기) · 유형이 다름 · 대상 규칙이 다름(다른 규칙 · 순서 · 수) · 자동 시작 실행 · 막 만든 실행이 아님은 거부된다', () => {
    withStore((store) => {
      const rule = seedRule(store);
      const second = seedRule(store, '둘째');
      const failed = createRun(store, [rule.id]);
      endRun(store, failed.run.id, 'failed');
      const merged = createRun(store, [rule.id]);
      endRun(store, merged.run.id, 'merged');
      const waiting = createRun(store, [rule.id]);
      const fresh = () => createRun(store, [rule.id]).run.id;
      for (const origin of [failed, merged, waiting]) {
        expect(() => link(store, fresh(), origin.run.id)).toThrow(/run_continuations/);
      }
      const origin = createRun(store, [rule.id, second.id]);
      endRun(store, origin.run.id, 'budget_exceeded');
      const typeC = createRun(store, [rule.id, second.id], 'C');
      const otherRule = createRun(store, [rule.id]);
      const reversed = createRun(store, [second.id, rule.id]);
      const auto = createRun(store, [rule.id, second.id], 'A', {
        kind: 'orchestrator',
        causeSeqs: [1],
      });
      const started = createRun(store, [rule.id, second.id]);
      store.runs.transition(started.run.id, { run: { status: 'running', startedAt: T0 } });
      for (const run of [typeC, otherRule, reversed, auto, started]) {
        expect(() => link(store, run.run.id, origin.run.id)).toThrow(/run_continuations/);
      }
      // 자기 자신은 CHECK가 막는다
      expect(() => link(store, origin.run.id, origin.run.id)).toThrow();
      expect(store.runContinuations.continuationOf(origin.run.id)).toBeNull();
    });
  });

  it('원 실행 하나는 한 번만 이어진다(가지 없음, UNIQUE). 이어받는 실행도 원 실행이 하나다. 연결은 바꾸거나 지울 수 없다', () => {
    withStore((store) => {
      const rule = seedRule(store);
      const origin = createRun(store, [rule.id]);
      endRun(store, origin.run.id, 'budget_exceeded');
      const other = createRun(store, [rule.id]);
      endRun(store, other.run.id, 'budget_exceeded');
      const first = createRun(store, [rule.id]);
      link(store, first.run.id, origin.run.id);
      const second = createRun(store, [rule.id]);
      expect(() => link(store, second.run.id, origin.run.id)).toThrow(/UNIQUE/);
      expect(() => link(store, first.run.id, other.run.id)).toThrow(/UNIQUE/);
      expect(() =>
        store.db
          .prepare('UPDATE run_continuations SET origin_run_id = ? WHERE run_id = ?')
          .run(other.run.id, first.run.id),
      ).toThrow(/바꿀 수 없습니다/);
      expect(() =>
        store.db.prepare('DELETE FROM run_continuations WHERE run_id = ?').run(first.run.id),
      ).toThrow(/지울 수 없습니다/);
      expect(store.runContinuations.continuationOf(origin.run.id)?.runId).toBe(first.run.id);
    });
  });
});

describe('기준 커밋 · 보강 연결 · 종료 상태 (ADR-147 ① ②)', () => {
  it('이어받는 실행의 기준 커밋은 원 실행과 같아야 하고, 원 실행이 워크트리 전에 끝났으면 무엇이든 받는다', () => {
    withStore((store) => {
      const rule = seedRule(store);
      const origin = createRun(store, [rule.id]);
      endRun(store, origin.run.id, 'budget_exceeded', BASE);
      const next = createRun(store, [rule.id]);
      link(store, next.run.id, origin.run.id);
      store.runs.transition(next.run.id, { run: { status: 'running', startedAt: T1 } });
      expect(() => store.runs.transition(next.run.id, { run: { baseCommit: OTHER_BASE } })).toThrow(
        /기준 커밋은 원 실행과 같아야/,
      );
      expect(store.runs.get(next.run.id)?.baseCommit).toBeNull();
      store.runs.transition(next.run.id, { run: { baseCommit: BASE } });
      expect(store.runs.get(next.run.id)?.baseCommit).toBe(BASE);
      store.runs.transition(next.run.id, {
        run: { status: 'failed', failureReason: 'test_end', endedAt: T2 },
      });

      const early = createRun(store, [rule.id]);
      endRun(store, early.run.id, 'budget_exceeded', null);
      const after = createRun(store, [rule.id]);
      link(store, after.run.id, early.run.id);
      store.runs.transition(after.run.id, {
        run: { status: 'running', startedAt: T1, baseCommit: OTHER_BASE },
      });
      expect(store.runs.get(after.run.id)?.baseCommit).toBe(OTHER_BASE);
    });
  });

  it('이어받는 실행에는 변이 보강 연결(자동 · 사람)을 더할 수 없고, 보강 연결이 있는 실행은 이어받는 실행이 될 수 없다', () => {
    withStore((store) => {
      const rule = seedRule(store);
      const { survived, reinforcing } = seedReinforcement(store, rule.id);
      endRun(store, reinforcing.run.id, 'budget_exceeded');
      const next = createRun(store, [rule.id], 'C');
      link(store, next.run.id, reinforcing.run.id);
      // 아직 연결되지 않은 새 생존 기록으로도 (0027의 다른 조건은 맞는다) 이어받는 실행에는 더할 수 없다
      const unlinked = seedSurvival(store, rule.id);
      expect(() =>
        store.db
          .prepare(
            'INSERT INTO mutation_reinforcements (seq, run_id, mutation_result_id, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(99, next.run.id, unlinked.id, T2),
      ).toThrow(/이어받는 실행에는 변이 보강 연결을 더할 수 없습니다/);
      expect(() =>
        store.db
          .prepare(
            'INSERT INTO review_reinforcements (review_seq, run_id, mutation_result_id, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(1, next.run.id, survived.id, T2),
      ).toThrow(/이어받는 실행에는 변이 보강 연결을 더할 수 없습니다/);
      expect(store.mutations.reinforcementCauseOfRun(next.run.id)).toBe(survived.id);
      // 보강 연결이 있는 막 만든 유형 C 실행은 이을 수 없다
      const again = createRun(store, [rule.id], 'C');
      endRun(store, again.run.id, 'budget_exceeded');
      const linked = seedAutoLink(store, rule.id);
      expect(() => link(store, linked.run.id, again.run.id)).toThrow(/run_continuations/);
    });
  });

  it('잇는 것은 원 실행의 상태 · 단계를 바꾸지 않고(종료 상태 그대로), 전이 표의 예산 초과는 여전히 종료 상태다', () => {
    withStore((store) => {
      const rule = seedRule(store);
      const origin = createRun(store, [rule.id]);
      endRun(store, origin.run.id, 'budget_exceeded');
      const before = store.runs.getDetail(origin.run.id);
      link(store, createRun(store, [rule.id]).run.id, origin.run.id);
      expect(store.runs.getDetail(origin.run.id)).toEqual(before);
      expect(RUN_STATUS_TRANSITIONS.budget_exceeded).toEqual([]);
      expect(() =>
        store.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(origin.run.id),
      ).toThrow(/종료된 실행/);
    });
  });
});

/** 병합된 유형 A 실행의 '변이 생존' 기록 (연결 없음). */
const seedSurvival = (store: ProjectStore, ruleId: string) => {
  const survivedFrom = createRun(store, [ruleId], 'A');
  const step = survivedFrom.steps.find((item) => item.kind === 'mutation')!;
  endRun(store, survivedFrom.run.id, 'merged');
  return store.mutations.record({
    id: newId(),
    ruleId,
    runId: survivedFrom.run.id,
    stepId: step.id,
    sessionId: newId(),
    commit: COMMIT,
    status: 'survived',
    outcome: 'survived',
    mutant: MUTANT,
    recordedAt: T1,
  });
};

/** 병합된 유형 A 실행의 '변이 생존' 기록과 그 규칙의 자동 보강 실행(유형 C, 연결 있음). */
const seedReinforcement = (store: ProjectStore, ruleId: string) => {
  const survived = seedSurvival(store, ruleId);
  const seq = store.mutations.nextReinforcementSeq();
  const reinforcing = createRun(store, [ruleId], 'C', {
    kind: 'orchestrator',
    causeSeqs: [seq],
    causeLog: 'mutation_reinforcements',
  });
  store.mutations.linkReinforcement({
    seq,
    runId: reinforcing.run.id,
    mutationResultId: survived.id,
    createdAt: T1,
  });
  return { survived, reinforcing };
};

/** 같은 규칙의 새 '변이 생존' 기록과 그 자동 보강 실행 (보강 연결이 있는 막 만든 유형 C 실행). */
const seedAutoLink = (store: ProjectStore, ruleId: string) =>
  seedReinforcement(store, ruleId).reinforcing;

describe('뷰 run_reinforcement_causes: 이어받는 실행도 사슬을 따라 원인 변이 기록에 닿는다 (ADR-147 ⑦)', () => {
  it('자동 보강 실행 → 1차 → 2차가 모두 같은 원인 · 뿌리의 연결 종류(auto)이고, 보강 아닌 실행을 이은 실행은 원인이 없다', () => {
    withStore((store) => {
      const rule = seedRule(store);
      const { survived, reinforcing } = seedReinforcement(store, rule.id);
      endRun(store, reinforcing.run.id, 'budget_exceeded');
      const first = createRun(store, [rule.id], 'C');
      link(store, first.run.id, reinforcing.run.id);
      endRun(store, first.run.id, 'budget_exceeded');
      const second = createRun(store, [rule.id], 'C');
      link(store, second.run.id, first.run.id);
      for (const run of [reinforcing, first, second]) {
        expect(store.mutations.reinforcementCauseOfRun(run.run.id)).toBe(survived.id);
      }
      expect(
        store.db
          .prepare('SELECT run_id, mutation_result_id, link_kind FROM run_reinforcement_causes')
          .all(),
      ).toEqual(
        expect.arrayContaining([
          { run_id: first.run.id, mutation_result_id: survived.id, link_kind: 'auto' },
          { run_id: second.run.id, mutation_result_id: survived.id, link_kind: 'auto' },
        ]),
      );
      // 자동 보강의 연결 자체는 원 보강 실행 하나뿐이다 (이어받는 실행은 연결 표에 행이 없다)
      expect(store.mutations.reinforcementOfRun(first.run.id)).toBeNull();
      const plain = createRun(store, [rule.id], 'C');
      endRun(store, plain.run.id, 'budget_exceeded');
      const plainNext = createRun(store, [rule.id], 'C');
      link(store, plainNext.run.id, plain.run.id);
      expect(store.mutations.reinforcementCauseOfRun(plainNext.run.id)).toBeNull();
    });
  });

  it('사람 보강 연결에서 시작한 사슬(사람 보강 실행 → 이어받는 실행)도 원인 변이 기록에 닿고 연결 종류는 뿌리의 review다', () => {
    withStore((store) => {
      const rule = seedRule(store);
      const { survived, reinforcing } = seedReinforcement(store, rule.id);
      endRun(store, reinforcing.run.id, 'failed');
      const [item] = store.reviewQueue.list();
      if (item?.kind !== 'mutant_survived') throw new Error('변이 생존 항목 없음');
      const humanRun = createRun(store, [rule.id], 'C');
      store.reviewQueue.linkReinforcement({
        reviewSeq: item.seq,
        runId: humanRun.run.id,
        mutationResultId: survived.id,
        createdAt: T2,
      });
      endRun(store, humanRun.run.id, 'budget_exceeded');
      const next = createRun(store, [rule.id], 'C');
      link(store, next.run.id, humanRun.run.id);
      expect(store.mutations.reinforcementCauseOfRun(next.run.id)).toBe(survived.id);
      expect(
        store.db
          .prepare(
            'SELECT run_id, mutation_result_id, link_kind FROM run_reinforcement_causes WHERE run_id IN (?, ?) ORDER BY link_kind, run_id',
          )
          .all(humanRun.run.id, next.run.id),
      ).toEqual(
        [humanRun.run.id, next.run.id].sort().map((runId) => ({
          run_id: runId,
          mutation_result_id: survived.id,
          link_kind: 'review',
        })),
      );
    });
  });

  it('다시 만든 뷰를 읽는 0028의 자동 등록 트리거가 그대로 돈다: 보강을 이은 실행이 실패로 끝나면 변이 생존 항목, 예산 초과면 그 실행의 새 예산 초과 항목', () => {
    withStore((store) => {
      const rule = seedRule(store);
      const { survived, reinforcing } = seedReinforcement(store, rule.id);
      endRun(store, reinforcing.run.id, 'budget_exceeded');
      const first = createRun(store, [rule.id], 'C');
      link(store, first.run.id, reinforcing.run.id);
      endRun(store, first.run.id, 'budget_exceeded');
      const second = createRun(store, [rule.id], 'C');
      link(store, second.run.id, first.run.id);
      endRun(store, second.run.id, 'failed');
      expect(
        store.reviewQueue.list().map((item) => [item.kind, item.runId, item.mutationResultId]),
      ).toEqual([
        ['budget_exceeded', reinforcing.run.id, null],
        ['budget_exceeded', first.run.id, null],
        ['mutant_survived', second.run.id, survived.id],
      ]);
    });
  });
});

describe('review_items: 한도 상향 재개 처리는 이어받는 실행의 연결이 있어야 한다 (0030)', () => {
  it('그 항목의 실행을 잇는 연결이 없으면(없음 · 다른 실행의 연결) 처리를 거부하고, 있으면 한 번 처리된다', () => {
    withStore((store) => {
      const rule = seedRule(store);
      const origin = createRun(store, [rule.id]);
      endRun(store, origin.run.id, 'budget_exceeded');
      const other = createRun(store, [rule.id]);
      endRun(store, other.run.id, 'budget_exceeded');
      const [item] = store.reviewQueue.list();
      if (item?.runId !== origin.run.id) throw new Error('항목 없음');
      const next = createRun(store, [rule.id]);
      const resolve = (runId: string) =>
        store.reviewQueue.resolve(item.seq, {
          action: 'raise_limit_resume',
          by: human,
          at: T2,
          reason: null,
          runId,
        });
      expect(() => resolve(next.run.id)).toThrow(/이어받는 실행의 연결/);
      const elsewhere = createRun(store, [rule.id]);
      link(store, elsewhere.run.id, other.run.id);
      expect(() => resolve(elsewhere.run.id)).toThrow(/이어받는 실행의 연결/);
      link(store, next.run.id, origin.run.id);
      // 연결이 있어도 처리 결과의 실행이 그 이어받는 실행이 아니면(다른 실행 ID) 거부한다
      expect(() => resolve(other.run.id)).toThrow(/이어받는 실행의 연결/);
      expect(store.reviewQueue.get(item.seq)?.resolution).toBeNull();
      expect(resolve(next.run.id).resolution).toEqual({
        action: 'raise_limit_resume',
        by: human,
        at: T2,
        reason: null,
        runId: next.run.id,
      });
      expect(() => resolve(next.run.id)).toThrow();
    });
  });
});

// ── 쓰기 허용 범위 (M3-58 #321, TODO-02 · NFR-01 · NFR-02, ADR-147 ⑥, ADR-155, 0032) ──────────

const SCOPE = { allow: ['src/app/api/health/**'], exclude: ['src/app/api/health/route.ts'] };
const attach = (store: ProjectStore, runId: string, scope = SCOPE) =>
  store.runWriteScopes.record({ runId, scope, createdAt: T2 });
/** 예산 초과로 끝난 원 실행과 그것을 이은 막 만든 실행. */
const continued = (store: ProjectStore) => {
  const rule = seedRule(store);
  const origin = createRun(store, [rule.id]);
  endRun(store, origin.run.id, 'budget_exceeded');
  const next = createRun(store, [rule.id]);
  link(store, next.run.id, origin.run.id);
  return { rule, origin, next };
};
const rawInsert = (store: ProjectStore, runId: string, allow: string, exclude: string) =>
  store.db
    .prepare(
      'INSERT INTO run_write_scopes (run_id, allow_patterns, exclude_patterns, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(runId, allow, exclude, T2);

describe('run_write_scopes: 넣을 때의 조건 · 추가 전용 (0032, ADR-155)', () => {
  it('막 만든 이어받는 실행에만 붙고 읽힌다. 이어받는 실행이 아님 · 막 만든 실행이 아님 · 빈 허용 · 빈 제외 · 글자 아닌 원소는 거부된다', () => {
    withStore((store) => {
      const { rule, origin, next } = continued(store);
      expect(store.runWriteScopes.ofRun(next.run.id)).toBeNull();
      // 이어받는 실행이 아님 (원 실행 · 연결 없는 막 만든 실행)
      expect(() => attach(store, origin.run.id)).toThrow(/막 만든 이어받는 실행/);
      const plain = createRun(store, [rule.id]);
      expect(() => attach(store, plain.run.id)).toThrow(/막 만든 이어받는 실행/);
      // 날 SQL로도: 빈 배열 · 배열 아님 · 글자 아닌 원소
      expect(() => rawInsert(store, next.run.id, '[]', '["a/b"]')).toThrow();
      expect(() => rawInsert(store, next.run.id, '["a/**"]', '[]')).toThrow();
      expect(() => rawInsert(store, next.run.id, '"a/**"', '["a/b"]')).toThrow();
      expect(() => rawInsert(store, next.run.id, '["a/**"]', '[1]')).toThrow(
        /막 만든 이어받는 실행/,
      );
      expect(() => rawInsert(store, next.run.id, '[null]', '["a/b"]')).toThrow(
        /막 만든 이어받는 실행/,
      );
      expect(store.runWriteScopes.ofRun(next.run.id)).toBeNull();
      expect(attach(store, next.run.id)).toEqual({
        runId: next.run.id,
        scope: SCOPE,
        createdAt: T2,
      });
      expect(store.runWriteScopes.ofRun(next.run.id)).toEqual(SCOPE);
      // 실행마다 하나
      expect(() => attach(store, next.run.id)).toThrow();
      // 진행을 시작한 이어받는 실행에는 붙일 수 없다 (막 만든 실행만)
      const { next: started } = continued(store);
      endRun(store, started.run.id, 'failed');
      expect(() => attach(store, started.run.id)).toThrow(/막 만든 이어받는 실행/);
    });
  });

  it('실행에 붙은 값은 바뀌지 않는다: 수정 · 삭제(날 SQL)는 거부된다', () => {
    withStore((store) => {
      const { next } = continued(store);
      attach(store, next.run.id);
      expect(() =>
        store.db
          .prepare('UPDATE run_write_scopes SET exclude_patterns = ? WHERE run_id = ?')
          .run('["other/**"]', next.run.id),
      ).toThrow(/바꿀 수 없습니다/);
      expect(() =>
        store.db.prepare('DELETE FROM run_write_scopes WHERE run_id = ?').run(next.run.id),
      ).toThrow(/지울 수 없습니다/);
      expect(store.runWriteScopes.ofRun(next.run.id)).toEqual(SCOPE);
    });
  });

  it('원 실행에 범위가 있으면 이어받는 실행은 같은 허용 목록과 원 실행의 제외를 모두 담은 제외 목록만 받는다 (넓어지는 길 없음)', () => {
    withStore((store) => {
      const { rule, next: first } = continued(store);
      attach(store, first.run.id);
      endRun(store, first.run.id, 'budget_exceeded');
      const second = createRun(store, [rule.id]);
      link(store, second.run.id, first.run.id);
      // 허용 목록이 다름 (넓힘)
      expect(() =>
        attach(store, second.run.id, { allow: ['src/**'], exclude: SCOPE.exclude }),
      ).toThrow(/넓힐 수 없습니다/);
      // 원 실행의 제외 하나를 뺌
      expect(() =>
        attach(store, second.run.id, { allow: SCOPE.allow, exclude: ['src/app/api/health/x.ts'] }),
      ).toThrow(/넓힐 수 없습니다/);
      // 같은 값 · 제외를 더한 값은 받는다
      const widerExclude = { allow: SCOPE.allow, exclude: [...SCOPE.exclude, 'src/app/api/x.ts'] };
      expect(attach(store, second.run.id, widerExclude).scope).toEqual(widerExclude);
    });
  });
});

describe('review_items: 허용 목록 축소 재개 · 한도 상향 재개 처리와 쓰기 허용 범위의 짝 (0032, ADR-155)', () => {
  const resolveAs = (
    store: ProjectStore,
    seq: number,
    action: 'raise_limit_resume' | 'narrow_allowlist_resume',
    runId: string,
  ) => store.reviewQueue.resolve(seq, { action, by: human, at: T2, reason: null, runId });

  it('허용 목록 축소 재개 처리는 그 항목의 실행을 이은 실행에 범위가 붙어 있어야 한다 (값 없이 처리 거부)', () => {
    withStore((store) => {
      const { origin, next } = continued(store);
      const item = store.reviewQueue.list().find((entry) => entry.runId === origin.run.id)!;
      expect(() => resolveAs(store, item.seq, 'narrow_allowlist_resume', next.run.id)).toThrow(
        /허용 목록 축소 재개 처리/,
      );
      attach(store, next.run.id);
      expect(resolveAs(store, item.seq, 'narrow_allowlist_resume', next.run.id).resolution).toEqual(
        {
          action: 'narrow_allowlist_resume',
          by: human,
          at: T2,
          reason: null,
          runId: next.run.id,
        },
      );
    });
  });

  it('범위 없는 원 실행의 한도 상향 재개는 범위가 붙은 실행으로 처리할 수 없다 (값이 있는데 raise_limit_resume)', () => {
    withStore((store) => {
      const { origin, next } = continued(store);
      attach(store, next.run.id);
      const item = store.reviewQueue.list().find((entry) => entry.runId === origin.run.id)!;
      expect(() => resolveAs(store, item.seq, 'raise_limit_resume', next.run.id)).toThrow(
        /쓰기 허용 범위를 그대로/,
      );
      expect(store.reviewQueue.get(item.seq)?.resolution).toBeNull();
    });
  });

  it('범위가 붙은 원 실행의 한도 상향 재개는 같은 범위를 이은 실행으로만 처리된다 (범위 없음 · 제외를 더함은 거부)', () => {
    withStore((store) => {
      const { rule, next: first } = continued(store);
      attach(store, first.run.id);
      endRun(store, first.run.id, 'budget_exceeded');
      const item = store.reviewQueue.list().find((entry) => entry.runId === first.run.id)!;
      const bare = createRun(store, [rule.id]);
      link(store, bare.run.id, first.run.id);
      // 범위 없이 이으면 한도 상향 재개로 처리할 수 없다 (조용히 풀리지 않는다)
      expect(() => resolveAs(store, item.seq, 'raise_limit_resume', bare.run.id)).toThrow(
        /쓰기 허용 범위를 그대로/,
      );
      // 같은 범위를 붙이면 처리된다
      attach(store, bare.run.id);
      expect(resolveAs(store, item.seq, 'raise_limit_resume', bare.run.id).resolution?.action).toBe(
        'raise_limit_resume',
      );
    });
    withStore((store) => {
      const { rule, next: first } = continued(store);
      attach(store, first.run.id);
      endRun(store, first.run.id, 'budget_exceeded');
      const item = store.reviewQueue.list().find((entry) => entry.runId === first.run.id)!;
      const second = createRun(store, [rule.id]);
      link(store, second.run.id, first.run.id);
      attach(store, second.run.id, { allow: SCOPE.allow, exclude: [...SCOPE.exclude, 'a.ts'] });
      expect(() => resolveAs(store, item.seq, 'raise_limit_resume', second.run.id)).toThrow(
        /쓰기 허용 범위를 그대로/,
      );
      // 제외를 더한 범위는 허용 목록 축소 재개(다시 좁히기)로 처리한다
      expect(
        resolveAs(store, item.seq, 'narrow_allowlist_resume', second.run.id).resolution?.action,
      ).toBe('narrow_allowlist_resume');
    });
  });
});
