// 검토 대기열 표 (M3-08 #53, TODO-02 · COST-01 · JDG-04, ADR-145). 실제 SQLite 임시 저장소. 표 `review_items` ·
// `review_reinforcements`(0028). 등록은 실행의 종료 상태를 저장하는 같은 문장의 트리거이고, 처리는 한 번만이다.
import {
  type Author,
  type RunStatus,
  RUN_STEP_PLANS,
  type RunType,
  STEP_ROLES,
} from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { join } from 'node:path';

import { openDatabase } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { PROJECT_MIGRATIONS } from '../src/migrations/project/index.js';
import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();
const T0 = '2026-11-26T00:00:00.000Z';
const T1 = '2026-11-26T01:00:00.000Z';
const T2 = '2026-11-26T02:00:00.000Z';
const T3 = '2026-11-26T03:00:00.000Z';
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

const seedRule = (store: ProjectStore) => {
  const requirement = store.requirements.create({
    id: newId(),
    text: '요구사항',
    author: human,
    normState: 'approved',
    createdAt: T0,
  });
  return store.rules.create({
    id: newId(),
    title: '헬스 체크 서버 시각',
    statement: 'WHEN GET /api/health THE SYSTEM SHALL time을 담는다',
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
  ruleId: string,
  type: RunType,
  startedBy: Parameters<ProjectStore['runs']['create']>[0]['startedBy'] = human,
) =>
  store.runs.create({
    id: newId(),
    type,
    targetRuleIds: [ruleId],
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

/** 승인 대기 → 진행 중 → `status` (종료 저장 1회). */
const endRun = (store: ProjectStore, runId: string, status: RunStatus, at = T2) => {
  store.runs.transition(runId, { run: { status: 'running', startedAt: T0 } });
  return store.runs.transition(runId, {
    expectedStatus: 'running',
    run:
      status === 'merged'
        ? { status, mergeCommit: COMMIT, currentStep: null, endedAt: at }
        : { status, failureReason: 'test_end', endedAt: at },
  });
};

/** 병합된 유형 A 실행의 '변이 생존' 기록과 그 규칙의 자동 보강 실행(유형 C, 연결 있음). */
const seedReinforcement = (store: ProjectStore) => {
  const rule = seedRule(store);
  const origin = createRun(store, rule.id, 'A');
  const step = origin.steps.find((item) => item.kind === 'mutation');
  if (step === undefined) throw new Error('변이 주입 단계 없음');
  endRun(store, origin.run.id, 'merged', T1);
  const survived = store.mutations.record({
    id: newId(),
    ruleId: rule.id,
    runId: origin.run.id,
    stepId: step.id,
    sessionId: newId(),
    commit: COMMIT,
    status: 'survived',
    outcome: 'survived',
    mutant: MUTANT,
    recordedAt: T1,
  });
  const seq = store.mutations.nextReinforcementSeq();
  const reinforcing = createRun(store, rule.id, 'C', {
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
  return { rule, origin, step, survived, reinforcing };
};

const quarantineJudgment = (
  store: ProjectStore,
  ruleId: string,
  reason: string,
  status: 'quarantined' | 'pass' = 'quarantined',
) =>
  store.judgments.record([
    {
      id: newId(),
      ruleId,
      runId: null,
      stepId: null,
      commit: COMMIT,
      judgedAt: T3,
      status,
      runner: 'vitest',
      exitCode: null,
      reporterPath: null,
      cases: [],
      quarantineReason: status === 'quarantined' ? reason : null,
    },
  ])[0]!;

describe('review_items: 자동 등록 (실행 종료 저장과 같은 문장)', () => {
  it('예산 초과로 끝난 실행은 유형과 무관하게 항목 1건(등록 시각 = 실행 종료 시각)이고, 다른 종료 상태 · 보강 아닌 실행의 실패는 항목이 없다', () => {
    withStore((store) => {
      const rule = seedRule(store);
      const typeA = createRun(store, rule.id, 'A');
      const typeC = createRun(store, rule.id, 'C');
      const failed = createRun(store, rule.id, 'A');
      const failedC = createRun(store, rule.id, 'C');
      const merged = createRun(store, rule.id, 'A');
      endRun(store, typeA.run.id, 'budget_exceeded', T1);
      endRun(store, typeC.run.id, 'budget_exceeded', T2);
      endRun(store, failed.run.id, 'failed');
      endRun(store, failedC.run.id, 'failed');
      endRun(store, merged.run.id, 'merged');
      expect(store.reviewQueue.list()).toEqual([
        {
          seq: 1,
          kind: 'budget_exceeded',
          runId: typeA.run.id,
          mutationResultId: null,
          createdAt: T1,
          resolution: null,
        },
        {
          seq: 2,
          kind: 'budget_exceeded',
          runId: typeC.run.id,
          mutationResultId: null,
          createdAt: T2,
          resolution: null,
        },
      ]);
    });
  });

  it('보강 실행이 실패로 끝나고 원인 규칙이 아직 변이 생존이면 변이 생존 항목(원인 기록 ID), 그 사이 검출 기록이 생겼으면 항목 없음', () => {
    withStore((store) => {
      const first = seedReinforcement(store);
      endRun(store, first.reinforcing.run.id, 'failed');
      expect(store.reviewQueue.list()).toMatchObject([
        {
          kind: 'mutant_survived',
          runId: first.reinforcing.run.id,
          mutationResultId: first.survived.id,
        },
      ]);
    });
    withStore((store) => {
      const second = seedReinforcement(store);
      store.mutations.record({
        id: newId(),
        ruleId: second.rule.id,
        runId: second.reinforcing.run.id,
        stepId: second.reinforcing.steps.find((step) => step.kind === 'mutation')!.id,
        sessionId: null,
        commit: COMMIT,
        status: 'verified',
        outcome: 'killed',
        mutant: MUTANT,
        recordedAt: T2,
      });
      endRun(store, second.reinforcing.run.id, 'failed', T3);
      expect(store.reviewQueue.list()).toEqual([]);
    });
  });

  it('보강 실행이 예산 초과로 끝나면 예산 초과 항목 하나뿐이다 (한 실행에 열린 항목 하나)', () => {
    withStore((store) => {
      const { reinforcing } = seedReinforcement(store);
      endRun(store, reinforcing.run.id, 'budget_exceeded');
      expect(store.reviewQueue.list().map((item) => [item.kind, item.runId])).toEqual([
        ['budget_exceeded', reinforcing.run.id],
      ]);
    });
  });

  it('같은 실행을 두 번 끝낼 수 없고(종료 상태 고정) 저장소를 다시 열어도 항목은 그대로 1건이다', () => {
    const projectId = newId();
    const open = () => openProjectStore(projectId, { home: home() });
    const store = open();
    const rule = seedRule(store);
    const run = createRun(store, rule.id, 'A');
    endRun(store, run.run.id, 'budget_exceeded');
    expect(() =>
      store.runs.transition(run.run.id, { run: { status: 'budget_exceeded' } }),
    ).toThrow();
    expect(() =>
      store.db.prepare("UPDATE runs SET status = 'budget_exceeded' WHERE id = ?").run(run.run.id),
    ).toThrow(/종료된 실행/);
    store.close();
    const reopened = open();
    try {
      expect(reopened.reviewQueue.list()).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it('직접 넣는 행도 열림이어야 하고 종류의 조건이 맞아야 한다', () => {
    withStore((store) => {
      const { reinforcing, survived, rule } = seedReinforcement(store);
      const insert = store.db.prepare(
        `INSERT INTO review_items (kind, run_id, mutation_result_id, created_at, resolved_at, action, resolved_by, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // 진행 중도 아닌 승인 대기 실행의 예산 초과 항목
      expect(() =>
        insert.run('budget_exceeded', reinforcing.run.id, null, T1, null, null, null, null),
      ).toThrow(/review_items/);
      // 끝나지 않은 보강 실행의 변이 생존 항목
      expect(() =>
        insert.run('mutant_survived', reinforcing.run.id, survived.id, T1, null, null, null, null),
      ).toThrow(/review_items/);
      // 예산 초과로 끝난 실행의 처리된 채로 넣는 항목
      const other = createRun(store, rule.id, 'A');
      endRun(store, other.run.id, 'budget_exceeded');
      expect(store.reviewQueue.list()).toHaveLength(1);
      expect(() =>
        insert.run(
          'budget_exceeded',
          other.run.id,
          null,
          T1,
          T2,
          'split_rule',
          '{"kind":"human"}',
          '{}',
        ),
      ).toThrow();
      // 열린 항목은 실행마다 하나 (부분 UNIQUE)
      expect(() =>
        insert.run('budget_exceeded', other.run.id, null, T1, null, null, null, null),
      ).toThrow(/UNIQUE/);
      expect(store.reviewQueue.list()).toHaveLength(1);
    });
  });
});

describe('review_items: 처리는 사람만 · 한 번만 · 결과가 있어야', () => {
  it('판정 격리: 같은 사유의 격리 판정 기록이 있어야 처리되고, 두 번째 처리 · 지우기 · 항목 칸 바꾸기는 거부된다', () => {
    withStore((store) => {
      const { reinforcing, rule } = seedReinforcement(store);
      endRun(store, reinforcing.run.id, 'failed');
      const [item] = store.reviewQueue.list();
      if (item === undefined) throw new Error('항목 없음');
      // 결과 없는 처리 (판정 기록이 없음 · 사유가 다름 · 격리가 아님)
      const missing = newId();
      expect(() =>
        store.reviewQueue.resolve(item.seq, {
          action: 'quarantine',
          by: human,
          at: T3,
          reason: '불안정한 검사',
          judgmentId: missing,
        }),
      ).toThrow(/격리 판정 기록/);
      const other = quarantineJudgment(store, rule.id, '다른 사유');
      expect(() =>
        store.reviewQueue.resolve(item.seq, {
          action: 'quarantine',
          by: human,
          at: T3,
          reason: '불안정한 검사',
          judgmentId: other.id,
        }),
      ).toThrow(/격리 판정 기록/);
      const passed = quarantineJudgment(store, rule.id, '', 'pass');
      expect(() =>
        store.reviewQueue.resolve(item.seq, {
          action: 'quarantine',
          by: human,
          at: T3,
          reason: '불안정한 검사',
          judgmentId: passed.id,
        }),
      ).toThrow(/격리 판정 기록/);
      // 같은 사유라도 다른 규칙의 격리 판정으로는 처리되지 않는다
      const otherRule = seedRule(store);
      const elsewhere = quarantineJudgment(store, otherRule.id, '불안정한 검사');
      expect(() =>
        store.reviewQueue.resolve(item.seq, {
          action: 'quarantine',
          by: human,
          at: T3,
          reason: '불안정한 검사',
          judgmentId: elsewhere.id,
        }),
      ).toThrow(/격리 판정 기록/);
      const judgment = quarantineJudgment(store, rule.id, '불안정한 검사');
      const resolved = store.reviewQueue.resolve(item.seq, {
        action: 'quarantine',
        by: human,
        at: T3,
        reason: '불안정한 검사',
        judgmentId: judgment.id,
      });
      expect(resolved.resolution).toEqual({
        action: 'quarantine',
        by: human,
        at: T3,
        reason: '불안정한 검사',
        judgmentId: judgment.id,
      });
      expect(store.reviewQueue.list({ state: 'resolved' })).toEqual([resolved]);
      expect(store.reviewQueue.list({ state: 'open' })).toEqual([]);
      expect(() =>
        store.reviewQueue.resolve(item.seq, {
          action: 'quarantine',
          by: human,
          at: T3,
          reason: '불안정한 검사',
          judgmentId: judgment.id,
        }),
      ).toThrow(/이미 처리된/);
      // 저장소를 거치지 않는 직접 변경도 막는다
      expect(() =>
        store.db.prepare("UPDATE review_items SET reason = '바꿈' WHERE seq = ?").run(item.seq),
      ).toThrow(/한 번만/);
      expect(() =>
        store.db
          .prepare(
            'UPDATE review_items SET resolved_at = NULL, action = NULL, resolved_by = NULL, reason = NULL, detail = NULL WHERE seq = ?',
          )
          .run(item.seq),
      ).toThrow(/한 번만/);
      expect(() =>
        store.db.prepare('DELETE FROM review_items WHERE seq = ?').run(item.seq),
      ).toThrow(/지울 수 없습니다/);
      expect(store.reviewQueue.get(item.seq)).toEqual(resolved);
    });
  });

  it('종류가 받지 않는 액션 · 사람 아닌 주체 · 사유 없는 격리는 DB가 거부한다 (스키마를 거치지 않는 쓰기)', () => {
    withStore((store) => {
      const rule = seedRule(store);
      const run = createRun(store, rule.id, 'A');
      endRun(store, run.run.id, 'budget_exceeded');
      const [item] = store.reviewQueue.list();
      const update = store.db.prepare(
        `UPDATE review_items SET resolved_at = ?, action = ?, resolved_by = ?, reason = ?, detail = ? WHERE seq = ?`,
      );
      // 예산 초과 항목에 판정 격리 · 테스트 보강
      expect(() =>
        update.run(T3, 'quarantine', '{"kind":"human"}', '사유', '{}', item!.seq),
      ).toThrow(/CHECK/);
      expect(() => update.run(T3, 'reinforce', '{"kind":"human"}', null, '{}', item!.seq)).toThrow(
        /CHECK/,
      );
      // 에이전트 주체
      expect(() =>
        update.run(
          T3,
          'split_rule',
          '{"kind":"agent","role":"rule-writer"}',
          null,
          '{}',
          item!.seq,
        ),
      ).toThrow(/CHECK/);
      expect(store.reviewQueue.get(item!.seq)?.resolution).toBeNull();
    });
  });

  it('테스트 보강: 그 항목의 보강 연결(사람이 시작한 그 규칙의 유형 C)이 있어야 처리되고, 연결은 항목마다 · 실행마다 하나이며 고칠 수 없다', () => {
    withStore((store) => {
      const { reinforcing, rule, survived } = seedReinforcement(store);
      endRun(store, reinforcing.run.id, 'failed');
      const [item] = store.reviewQueue.list();
      if (item === undefined) throw new Error('항목 없음');
      const humanRun = createRun(store, rule.id, 'C');
      expect(() =>
        store.reviewQueue.resolve(item.seq, {
          action: 'reinforce',
          by: human,
          at: T3,
          reason: null,
          runId: humanRun.run.id,
        }),
      ).toThrow(/보강 실행 연결/);
      // 연결의 조건: 유형 A 실행 · 오케스트레이터가 시작한 실행 · 다른 원인 기록은 받지 않는다
      const typeA = createRun(store, rule.id, 'A');
      const link = (runId: string, mutationResultId = survived.id) =>
        store.reviewQueue.linkReinforcement({
          reviewSeq: item.seq,
          runId,
          mutationResultId,
          createdAt: T3,
        });
      expect(() => link(typeA.run.id)).toThrow(/review_reinforcements/);
      expect(() => link(reinforcing.run.id)).toThrow(/review_reinforcements/);
      const orchestrated = createRun(store, rule.id, 'C', {
        kind: 'orchestrator',
        causeSeqs: [99],
        causeLog: 'mutation_reinforcements',
      });
      expect(() => link(orchestrated.run.id)).toThrow(/review_reinforcements/);
      link(humanRun.run.id);
      expect(store.mutations.reinforcementCauseOfRun(humanRun.run.id)).toBe(survived.id);
      expect(store.mutations.reinforcementCauseOfRun(reinforcing.run.id)).toBe(survived.id);
      expect(store.mutations.reinforcementCauseOfRun(typeA.run.id)).toBeNull();
      const second = createRun(store, rule.id, 'C');
      expect(() => link(second.run.id)).toThrow();
      const resolved = store.reviewQueue.resolve(item.seq, {
        action: 'reinforce',
        by: human,
        at: T3,
        reason: null,
        runId: humanRun.run.id,
      });
      expect(resolved.resolution).toMatchObject({ action: 'reinforce', runId: humanRun.run.id });
      expect(() =>
        store.db.prepare('DELETE FROM review_reinforcements WHERE run_id = ?').run(humanRun.run.id),
      ).toThrow(/지울 수 없습니다/);
      expect(() =>
        store.db
          .prepare('UPDATE review_reinforcements SET run_id = ? WHERE run_id = ?')
          .run(second.run.id, humanRun.run.id),
      ).toThrow(/바꿀 수 없습니다/);
      // 사람이 시작한 보강도 실패로 끝나고 원인이 아직 생존이면 새 변이 생존 항목이 생긴다 (처리된 항목과 별개)
      endRun(store, humanRun.run.id, 'failed', T3);
      expect(store.reviewQueue.list().map((entry) => [entry.kind, entry.runId])).toEqual([
        ['mutant_survived', reinforcing.run.id],
        ['mutant_survived', humanRun.run.id],
      ]);
    });
  });

  it('변경 표지는 항목이 생기거나 처리될 때마다 는다', () => {
    withStore((store) => {
      const { reinforcing, rule } = seedReinforcement(store);
      expect(store.reviewQueue.version()).toBe(0);
      endRun(store, reinforcing.run.id, 'failed');
      expect(store.reviewQueue.version()).toBe(1);
      const judgment = quarantineJudgment(store, rule.id, '사유');
      store.reviewQueue.resolve(1, {
        action: 'quarantine',
        by: human,
        at: T3,
        reason: '사유',
        judgmentId: judgment.id,
      });
      expect(store.reviewQueue.version()).toBe(2);
    });
  });

  it('한 실행은 보강 연결을 하나만 가진다: 사람 연결이 있는 실행에 자동 연결을 더할 수 없고, 보강 원인은 뷰 하나(연결 종류 포함)로 읽힌다', () => {
    withStore((store) => {
      const { reinforcing, rule, survived, origin, step } = seedReinforcement(store);
      endRun(store, reinforcing.run.id, 'failed');
      const [item] = store.reviewQueue.list();
      const humanRun = createRun(store, rule.id, 'C');
      store.reviewQueue.linkReinforcement({
        reviewSeq: item!.seq,
        runId: humanRun.run.id,
        mutationResultId: survived.id,
        createdAt: T3,
      });
      // 같은 유형 A 실행의 다른 생존 기록(자동 연결의 다른 조건은 모두 맞는다)
      const another = store.mutations.record({
        id: newId(),
        ruleId: rule.id,
        runId: origin.run.id,
        stepId: step.id,
        sessionId: newId(),
        commit: COMMIT,
        status: 'survived',
        outcome: 'survived',
        mutant: MUTANT,
        recordedAt: T2,
      });
      expect(() =>
        store.mutations.linkReinforcement({
          seq: store.mutations.nextReinforcementSeq(),
          runId: humanRun.run.id,
          mutationResultId: another.id,
          createdAt: T3,
        }),
      ).toThrow(/사람 보강 연결이 있는 실행/);
      expect(
        store.db
          .prepare(
            'SELECT run_id AS runId, mutation_result_id AS resultId, link_kind AS kind FROM run_reinforcement_causes ORDER BY kind',
          )
          .all(),
      ).toEqual([
        { runId: reinforcing.run.id, resultId: survived.id, kind: 'auto' },
        { runId: humanRun.run.id, resultId: survived.id, kind: 'review' },
      ]);
      // 사람 보강 실행이 끝나도 항목은 하나 (자동 연결이 더해지지 않아 종료 저장이 막히지 않는다)
      endRun(store, humanRun.run.id, 'failed', T3);
      expect(store.runs.get(humanRun.run.id)?.status).toBe('failed');
      expect(
        store.reviewQueue.list().filter((entry) => entry.runId === humanRun.run.id),
      ).toHaveLength(1);
    });
  });
});

describe('0028 적용: 이미 끝난 실행은 되채우지 않는다', () => {
  it('0027까지의 DB에 예산 초과 · 실패로 끝난 실행이 있어도 0028을 적용하면 항목이 없고, 적용 뒤의 종료부터 등록된다', () => {
    const db = openDatabase(join(home(), 'v27.db'));
    try {
      migrate(db, PROJECT_MIGRATIONS.slice(0, 27), { now: () => T0 });
      const insertRun = (seq: number, status: string): string => {
        const id = newId();
        db.prepare(
          `INSERT INTO runs (id, display_id, type, status, current_step, last_completed_step, regression_count,
           failure_reason, branch, worktree_path, base_branch, base_commit, head_commit, merge_commit, budget_snapshot,
           model_snapshot, cost_usd, turns, tool_manifest, started_by, created_at, started_at, ended_at)
           VALUES (?, ?, 'A', ?, NULL, NULL, 0, ?, NULL, NULL, 'main', NULL, NULL, NULL,
           '{"run":{"maxBudgetUsd":5,"maxTurns":200},"roles":{}}', '{}', NULL, NULL, '[]', '{"kind":"human"}', ?, ?, ?)`,
        ).run(
          id,
          `EXE-${String(seq).padStart(3, '0')}`,
          status,
          status === 'running' ? null : 'test_end',
          T0,
          T0,
          status === 'running' ? null : T1,
        );
        return id;
      };
      insertRun(1, 'budget_exceeded');
      insertRun(2, 'failed');
      const running = insertRun(3, 'running');
      migrate(db, PROJECT_MIGRATIONS, { now: () => T2 });
      const count = () =>
        db.prepare<[], { n: number }>('SELECT count(*) AS n FROM review_items').get()?.n;
      expect(count()).toBe(0);
      db.prepare(
        "UPDATE runs SET status = 'budget_exceeded', failure_reason = 'test_end', ended_at = ? WHERE id = ?",
      ).run(T2, running);
      expect(
        db.prepare('SELECT kind, run_id AS runId, created_at AS createdAt FROM review_items').all(),
      ).toEqual([{ kind: 'budget_exceeded', runId: running, createdAt: T2 }]);
    } finally {
      db.close();
    }
  });
});
