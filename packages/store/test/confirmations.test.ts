// 확인 상태 리포지토리 (M7-01 #213, NFR-01 · ADR-100 D2 · I1, ADR-101).
import type { Author, HumanAuthor } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();

const T0 = '2026-10-16T00:00:00.000Z';
const T1 = '2026-10-16T01:00:00.000Z';
const human = { kind: 'human' } as const;

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
    text: '사용자는 이메일로 가입할 수 있다',
    author: human,
    normState: 'approved',
    createdAt: T0,
  });
  const rule = store.rules.create({
    id: newId(),
    title: '중복 이메일 가입 거부',
    statement: 'WHEN 이미 가입된 이메일로 가입을 요청하면 THE SYSTEM SHALL 가입을 거부한다',
    kind: 'business',
    checkKinds: ['test'],
    parentRequirementId: requirement.id,
    builtin: false,
    targetBlockIds: [],
    risk: null,
    contractId: null,
    author: { kind: 'agent', role: 'rule-writer' },
    normState: 'approved',
    createdAt: T0,
  });
  return { requirement, rule };
};

describe('confirmations 리포지토리', () => {
  it('기본은 미확인이고, 사람의 확인은 규칙 · 요구사항 조회(get · list · 부모별 목록)에 실린다', () => {
    withStore((store) => {
      const { requirement, rule } = seed(store);
      const target = { entity: 'Rule', id: rule.id } as const;
      expect(store.confirmations.get(target)).toEqual({ state: 'unconfirmed' });
      expect(requirement.confirmation).toEqual({ state: 'unconfirmed' });

      const confirmed = store.confirmations.confirm(target, {
        by: human,
        at: T1,
        basis: { kind: 'approval_log', seq: 1 },
      });
      const expected = {
        state: 'confirmed',
        at: T1,
        by: human,
        basis: { kind: 'approval_log', seq: 1 },
      };
      expect(confirmed).toEqual(expected);
      expect(store.confirmations.get(target)).toEqual(expected);
      expect(store.rules.get(rule.id)?.confirmation).toEqual(expected);
      expect(store.rules.list().map((r) => r.confirmation)).toEqual([expected]);
      expect(store.rules.listByParent(requirement.id).map((r) => r.confirmation)).toEqual([
        expected,
      ]);
      // 다른 엔터티 · 다른 대상에는 번지지 않는다
      expect(store.requirements.get(requirement.id)?.confirmation).toEqual({
        state: 'unconfirmed',
      });
      expect(store.confirmations.get({ entity: 'Requirement', id: rule.id })).toEqual({
        state: 'unconfirmed',
      });

      // 다시 확인하면 새 근거로 바뀐다 (사람의 요구사항 재편집 등)
      store.confirmations.confirm(
        { entity: 'Requirement', id: requirement.id },
        { by: human, at: T0, basis: { kind: 'requirement_record', at: T0 } },
      );
      const again = store.confirmations.confirm(
        { entity: 'Requirement', id: requirement.id },
        { by: human, at: T1, basis: { kind: 'requirement_record', at: T1 } },
      );
      expect(store.requirements.list().map((r) => r.confirmation)).toEqual([again]);
    });
  });

  it('확인한 주체가 사람이 아니거나 대상이 없으면 저장하지 않는다', () => {
    withStore((store) => {
      const { rule } = seed(store);
      const target = { entity: 'Rule', id: rule.id } as const;
      const agent = { kind: 'agent', role: 'rule-writer' } as const satisfies Author;
      expect(() =>
        store.confirmations.confirm(target, {
          by: agent as unknown as HumanAuthor,
          at: T1,
          basis: { kind: 'approval_log', seq: 1 },
        }),
      ).toThrow();
      expect(() =>
        store.confirmations.confirm(
          { entity: 'Rule', id: newId() },
          { by: human, at: T1, basis: { kind: 'approval_log', seq: 1 } },
        ),
      ).toThrow(/없는 요구사항 · 규칙/);
      expect(() =>
        store.confirmations.confirm(
          { entity: 'Contract' as 'Rule', id: rule.id },
          { by: human, at: T1, basis: { kind: 'approval_log', seq: 1 } },
        ),
      ).toThrow();
      expect(store.confirmations.get(target)).toEqual({ state: 'unconfirmed' });
      expect(store.db.prepare('SELECT count(*) AS n FROM confirmations').get()).toEqual({ n: 0 });
    });
  });
});
