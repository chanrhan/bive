// 규칙 분할 기록 (M3-57 #320, TODO-02 · NRM-02 · NRM-07 · NFR-01, ADR-147 ⑧, ADR-153). 실제 SQLite 임시 저장소. 표 `rule_splits`(0031):
// 분할로 폐기된 규칙 1개와 그것을 대체한 새 규칙들. 짝 폐기 기록 · 분할 상세와의 대조 · 부모 물려받음 · 추가 전용, 검토 대기열의
// 규칙 분할 처리 결과 확인은 DB 트리거가 본다.
import { type Author, RUN_STEP_PLANS, type Rule, STEP_ROLES } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();
const T0 = '2026-11-28T00:00:00.000Z';
const T1 = '2026-11-28T01:00:00.000Z';
const BASE = 'a'.repeat(40);
const human = { kind: 'human' } as const satisfies Author;
const agent = { kind: 'agent', role: 'rule-writer' } as const satisfies Author;

const withStore = <T>(fn: (store: ProjectStore) => T): T => {
  const store = openProjectStore(newId(), { home: home() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

const seedRequirement = (store: ProjectStore) =>
  store.requirements.create({
    id: newId(),
    text: '헬스 체크 응답',
    author: human,
    normState: 'approved',
    createdAt: T0,
  });

const seedRule = (store: ProjectStore, parentRequirementId: string, title: string): Rule =>
  store.rules.create({
    id: newId(),
    title,
    statement: `WHEN GET /api/health THE SYSTEM SHALL ${title}을 담는다`,
    kind: 'business',
    checkKinds: ['test'],
    parentRequirementId,
    builtin: false,
    targetBlockIds: ['health'],
    risk: 'medium',
    contractId: null,
    author: agent,
    normState: 'approved',
    createdAt: T0,
  });

const ref = (rule: Rule) => ({ id: rule.id, displayId: rule.displayId });

/** 대상 규칙의 분할 기록(`superseded` + 분할 상세)과 폐기 기록을 남긴다. 분할 행은 남기지 않는다. */
const retireBySplit = (
  store: ProjectStore,
  target: Rule,
  successors: readonly Rule[],
  supersededBy: Rule | undefined = successors[0],
) => {
  const sessionId = newId();
  const created = successors.map((rule) =>
    store.normChanges.append({
      at: T1,
      kind: 'created',
      actor: agent,
      targetRef: { entity: 'Rule', id: rule.id },
      sessionId,
      runId: null,
      reason: '나눈 부분',
      detail: { after: { displayId: rule.displayId } },
    }),
  );
  const change = store.normChanges.append({
    at: T1,
    kind: 'superseded',
    actor: agent,
    targetRef: { entity: 'Rule', id: target.id },
    sessionId,
    runId: null,
    reason: '나눈다',
    detail: {
      before: { displayId: target.displayId },
      retirement: {
        supersededBy: supersededBy === undefined ? null : ref(supersededBy),
        split: successors.map((rule, index) => ({
          rule: ref(rule),
          createdSeq: created[index]!.seq,
        })),
      },
    },
  });
  store.ruleRetirements.record({
    ruleId: target.id,
    retiredAt: T1,
    supersededBy: supersededBy?.id ?? null,
    normChangeSeq: change.seq,
  });
  return change;
};

const seedSplit = (store: ProjectStore) => {
  const requirement = seedRequirement(store);
  const target = seedRule(store, requirement.id, '서버 시각과 버전');
  const first = seedRule(store, requirement.id, '서버 시각');
  const second = seedRule(store, requirement.id, '버전');
  return { requirement, target, first, second };
};

/** 대상 규칙 둘인 실행을 예산 초과로 끝내 검토 대기열 항목을 만든다. */
const budgetItem = (store: ProjectStore, ruleIds: readonly string[]) => {
  const created = store.runs.create({
    id: newId(),
    type: 'A',
    targetRuleIds: [...ruleIds],
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
  store.runs.transition(created.run.id, {
    run: {
      status: 'running',
      startedAt: T0,
      baseCommit: BASE,
      branch: 'bive/run-x',
      worktreePath: '/w',
    },
  });
  store.runs.transition(created.run.id, {
    expectedStatus: 'running',
    run: { status: 'budget_exceeded', failureReason: 'error_max_budget_usd', endedAt: T1 },
  });
  const item = store.reviewQueue.list().find((entry) => entry.runId === created.run.id);
  if (item === undefined) throw new Error('예산 초과 항목 없음');
  return { run: created.run, item };
};

describe('rule_splits: 분할 기록 (0031, ADR-153)', () => {
  it('분할 상세와 같은 순서로 새 규칙들을 잇고, 폐기 기록의 superseded_by는 첫 새 규칙이며, 순서대로 읽는다', () => {
    withStore((store) => {
      const { target, first, second } = seedSplit(store);
      retireBySplit(store, target, [first, second]);
      store.ruleSplits.record({ ruleId: target.id, newRuleIds: [first.id, second.id] });
      expect(store.ruleSplits.newRulesOf(target.id)).toEqual([first.id, second.id]);
      expect(store.ruleSplits.newRulesOf(first.id)).toEqual([]);
      expect(store.ruleRetirements.get(target.id)?.supersededBy).toBe(first.id);
    });
  });

  it('분할 상세와 순서 · 규칙이 다르거나, 위치를 건너뛰거나, 폐기 기록이 없거나, 부모 요구사항이 다른 새 규칙은 DB가 거부한다', () => {
    withStore((store) => {
      const { requirement, target, first, second } = seedSplit(store);
      const insert = store.db.prepare(
        'INSERT INTO rule_splits (rule_id, position, new_rule_id) VALUES (?, ?, ?)',
      );
      // 폐기 기록 전
      expect(() => insert.run(target.id, 1, first.id)).toThrow(/rule_splits/);
      retireBySplit(store, target, [first, second]);
      // 순서가 바뀜 · 위치 건너뜀 · 상세에 없는 규칙
      expect(() => insert.run(target.id, 1, second.id)).toThrow(/rule_splits/);
      expect(() => insert.run(target.id, 2, second.id)).toThrow(/rule_splits/);
      const stranger = seedRule(store, requirement.id, '다른 규칙');
      expect(() => insert.run(target.id, 1, stranger.id)).toThrow(/rule_splits/);
      insert.run(target.id, 1, first.id);
      insert.run(target.id, 2, second.id);
      // 상세 밖의 셋째
      expect(() => insert.run(target.id, 3, stranger.id)).toThrow(/rule_splits/);
      expect(store.ruleSplits.newRulesOf(target.id)).toEqual([first.id, second.id]);

      // 부모 요구사항이 다른 새 규칙 (부모를 물려받지 않음)
      const otherRequirement = seedRequirement(store);
      const target2 = seedRule(store, requirement.id, '둘째 대상');
      const foreign = seedRule(store, otherRequirement.id, '남의 부모');
      const own = seedRule(store, requirement.id, '제 부모');
      retireBySplit(store, target2, [foreign, own]);
      expect(() =>
        store.ruleSplits.record({ ruleId: target2.id, newRuleIds: [foreign.id, own.id] }),
      ).toThrow(/rule_splits/);
      expect(store.ruleSplits.newRulesOf(target2.id)).toEqual([]);
    });
  });

  it('이미 폐기된 규칙은 새 규칙으로 이을 수 없다 (위치 2 이후도, 날 SQL)', () => {
    withStore((store) => {
      const { target, first, second } = seedSplit(store);
      // 둘째 새 규칙을 먼저 폐기만 한다 (짝 기록 `retired` + 폐기 행)
      const retired = store.normChanges.append({
        at: T1,
        kind: 'retired',
        actor: agent,
        targetRef: { entity: 'Rule', id: second.id },
        sessionId: newId(),
        runId: null,
        reason: '폐기',
        detail: { before: { displayId: second.displayId }, retirement: { supersededBy: null } },
      });
      store.ruleRetirements.record({
        ruleId: second.id,
        retiredAt: T1,
        supersededBy: null,
        normChangeSeq: retired.seq,
      });
      retireBySplit(store, target, [first, second]);
      const insert = store.db.prepare(
        'INSERT INTO rule_splits (rule_id, position, new_rule_id) VALUES (?, ?, ?)',
      );
      insert.run(target.id, 1, first.id);
      expect(() => insert.run(target.id, 2, second.id)).toThrow(/rule_splits/);
      expect(store.ruleSplits.newRulesOf(target.id)).toEqual([first.id]);
    });
  });

  it('분할 행은 고치거나 지울 수 없다', () => {
    withStore((store) => {
      const { target, first, second } = seedSplit(store);
      retireBySplit(store, target, [first, second]);
      store.ruleSplits.record({ ruleId: target.id, newRuleIds: [first.id, second.id] });
      expect(() =>
        store.db.prepare('UPDATE rule_splits SET position = 9 WHERE rule_id = ?').run(target.id),
      ).toThrow(/바꿀 수 없습니다/);
      expect(() =>
        store.db.prepare('DELETE FROM rule_splits WHERE rule_id = ?').run(target.id),
      ).toThrow(/지울 수 없습니다/);
      expect(store.ruleSplits.newRulesOf(target.id)).toEqual([first.id, second.id]);
    });
  });
});

describe('review_items: 규칙 분할 처리의 결과 확인 (0031, ADR-153)', () => {
  const resolveRaw = (store: ProjectStore, seq: number, ruleId: string) =>
    store.db
      .prepare(
        `UPDATE review_items SET resolved_at = ?, action = 'split_rule', resolved_by = '{"kind":"human"}',
         reason = NULL, detail = ? WHERE seq = ?`,
      )
      .run(T1, JSON.stringify({ ruleId }), seq);

  it('그 항목의 실행의 대상 규칙이 새 규칙 2개 이상으로 분할된 기록이 없으면 날 SQL의 처리도 거부되고, 있으면 처리된다', () => {
    withStore((store) => {
      const { requirement, target, first, second } = seedSplit(store);
      const remaining = seedRule(store, requirement.id, '나머지 대상');
      const { item } = budgetItem(store, [target.id, remaining.id]);
      // 분할 기록 없음
      expect(() => resolveRaw(store, item.seq, target.id)).toThrow(/규칙 분할 처리/);
      // 폐기 기록 · 분할 상세만 있고 분할 행이 없음
      retireBySplit(store, target, [first, second]);
      expect(() => resolveRaw(store, item.seq, target.id)).toThrow(/규칙 분할 처리/);
      // 분할 행이 하나뿐 (2개 미만)
      store.db
        .prepare('INSERT INTO rule_splits (rule_id, position, new_rule_id) VALUES (?, 1, ?)')
        .run(target.id, first.id);
      expect(() => resolveRaw(store, item.seq, target.id)).toThrow(/규칙 분할 처리/);
      store.db
        .prepare('INSERT INTO rule_splits (rule_id, position, new_rule_id) VALUES (?, 2, ?)')
        .run(target.id, second.id);
      // 그 실행의 대상이 아닌 규칙의 분할은 결과가 아니다
      const elsewhere = seedRule(store, requirement.id, '대상 밖');
      const elsewhereA = seedRule(store, requirement.id, '대상 밖 A');
      const elsewhereB = seedRule(store, requirement.id, '대상 밖 B');
      retireBySplit(store, elsewhere, [elsewhereA, elsewhereB]);
      store.ruleSplits.record({ ruleId: elsewhere.id, newRuleIds: [elsewhereA.id, elsewhereB.id] });
      expect(() => resolveRaw(store, item.seq, elsewhere.id)).toThrow(/규칙 분할 처리/);
      expect(store.reviewQueue.get(item.seq)?.resolution).toBeNull();

      const resolved = store.reviewQueue.resolve(item.seq, {
        action: 'split_rule',
        by: human,
        at: T1,
        reason: null,
        ruleId: target.id,
      });
      expect(resolved.resolution).toEqual({
        action: 'split_rule',
        by: human,
        at: T1,
        reason: null,
        ruleId: target.id,
      });
      // 처리는 한 번
      expect(() =>
        store.reviewQueue.resolve(item.seq, {
          action: 'split_rule',
          by: human,
          at: T1,
          reason: null,
          ruleId: target.id,
        }),
      ).toThrow();
    });
  });

  it('분할 상세가 새 규칙 3개인데 분할 행이 2개뿐이면 처리가 거부되고, 셋째 행까지 넣으면 처리된다', () => {
    withStore((store) => {
      const { requirement, target, first, second } = seedSplit(store);
      const third = seedRule(store, requirement.id, '호스트');
      const { item } = budgetItem(store, [target.id]);
      retireBySplit(store, target, [first, second, third]);
      const insert = store.db.prepare(
        'INSERT INTO rule_splits (rule_id, position, new_rule_id) VALUES (?, ?, ?)',
      );
      insert.run(target.id, 1, first.id);
      insert.run(target.id, 2, second.id);
      expect(() => resolveRaw(store, item.seq, target.id)).toThrow(/규칙 분할 처리/);
      expect(store.reviewQueue.get(item.seq)?.resolution).toBeNull();
      insert.run(target.id, 3, third.id);
      resolveRaw(store, item.seq, target.id);
      expect(store.reviewQueue.get(item.seq)?.resolution).toMatchObject({
        action: 'split_rule',
        ruleId: target.id,
      });
      expect(() =>
        store.reviewQueue.resolve(item.seq, {
          action: 'split_rule',
          by: human,
          at: T1,
          reason: null,
          ruleId: target.id,
        }),
      ).toThrow();
    });
  });
});
