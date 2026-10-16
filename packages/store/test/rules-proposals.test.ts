// 규칙 · 제안 리포지토리 (M1-09, NRM-02 · NRM-04 · ADR-050). 실제 SQLite 임시 저장소.
import type { Author, ProposalDecision } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { ConflictError, NotFoundError } from '../src/errors.js';
import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import type { ProposalCreateInput } from '../src/repositories/proposal-repository.js';
import type { RuleCreateInput } from '../src/repositories/rule-repository.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();

const T0 = '2026-10-16T00:00:00.000Z';
const T1 = '2026-10-16T01:00:00.000Z';
const T2 = '2026-10-16T02:00:00.000Z';
const human = { kind: 'human' } as const satisfies Author;
const ruleWriter = { kind: 'agent', role: 'rule-writer' } as const satisfies Author;

const withStore = <T>(fn: (store: ProjectStore) => T): T => {
  const store = openProjectStore(newId(), { home: home() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

const seedRequirement = (store: ProjectStore, text = '사용자는 이메일로 가입할 수 있다') =>
  store.requirements.create({
    id: newId(),
    text,
    author: human,
    normState: 'approved',
    createdAt: T0,
  });

const ruleInput = (
  parentRequirementId: string | null,
  overrides: Partial<RuleCreateInput> = {},
): RuleCreateInput => ({
  id: newId(),
  title: '중복 이메일 가입 거부',
  statement: 'WHEN 이미 가입된 이메일로 가입을 요청하면 THE SYSTEM SHALL 가입을 거부한다',
  kind: 'business',
  checkKinds: ['test'],
  parentRequirementId,
  builtin: false,
  targetBlockIds: [],
  risk: null,
  contractId: null,
  author: ruleWriter,
  normState: 'approved',
  createdAt: T1,
  ...overrides,
});

const proposalInput = (overrides: Partial<ProposalCreateInput> = {}): ProposalCreateInput => ({
  id: newId(),
  kind: 'requirement_new',
  targetRef: null,
  payload: { text: '관리자는 회원을 정지할 수 있다' },
  diff: { before: null, after: { text: '관리자는 회원을 정지할 수 있다' } },
  rationale: '운영 요구 누락',
  author: ruleWriter,
  source: 'chat',
  risk: null,
  adrId: null,
  runId: null,
  createdAt: T0,
  ...overrides,
});

describe('rules 테이블 · 리포지토리', () => {
  it('생성: 표시 ID RULE-001부터, 부모 해제 시각 없음, 목록 · 부모별 목록', () => {
    withStore((store) => {
      const req = seedRequirement(store);
      const input = ruleInput(req.id);
      const rule = store.rules.create(input);
      expect(rule).toEqual({
        ...input,
        displayId: 'RULE-001',
        parentDetachedAt: null,
        updatedAt: T1,
        deletedAt: null,
      });
      expect(store.rules.get(rule.id)).toEqual(rule);
      const second = store.rules.create(ruleInput(req.id, { checkKinds: ['test', 'pbt'] }));
      expect(second.displayId).toBe('RULE-002');
      expect(store.rules.list()).toEqual([rule, second]);
      expect(store.rules.listByParent(req.id)).toEqual([rule, second]);
      expect(store.rules.get(newId())).toBeNull();
    });
  });

  it('부모 검증: 없는 요구사항 → NotFound, 삭제된 요구사항 → Conflict, 내장 규칙만 부모 없음', () => {
    withStore((store) => {
      expect(() => store.rules.create(ruleInput(newId()))).toThrow(NotFoundError);
      const req = seedRequirement(store);
      store.requirements.softDelete(req.id, { by: human, at: T1 });
      expect(() => store.rules.create(ruleInput(req.id))).toThrow(ConflictError);
      expect(() => store.rules.create(ruleInput(null))).toThrow();
      // 실패한 생성은 순번을 소비하지 않는다
      const builtin = store.rules.create(
        ruleInput(null, { builtin: true, kind: 'architecture', checkKinds: ['structure'] }),
      );
      expect(builtin.displayId).toBe('RULE-001');
    });
  });

  it('부모 해제: 자식 규칙은 남고 parentRequirementId가 비며 해제 시각이 남는다', () => {
    withStore((store) => {
      const req = seedRequirement(store);
      const other = seedRequirement(store, '가입한 사용자는 로그인할 수 있다');
      const child = store.rules.create(ruleInput(req.id));
      const sibling = store.rules.create(ruleInput(other.id));

      expect(store.rules.detachFromParent(req.id, T2)).toBe(1);
      expect(store.rules.get(child.id)).toEqual({
        ...child,
        parentRequirementId: null,
        parentDetachedAt: T2,
        updatedAt: T2,
      });
      expect(store.rules.get(sibling.id)).toEqual(sibling);
      expect(store.rules.list()).toHaveLength(2);
      expect(store.rules.listByParent(req.id)).toEqual([]);
      expect(store.rules.detachFromParent(req.id, T2)).toBe(0);
    });
  });
});

describe('proposals 테이블 · 리포지토리', () => {
  it('생성: 항상 승인 대기(pending), 표시 ID PRP-001부터, 처리 기록 · 읽은 시각 없음', () => {
    withStore((store) => {
      const input = proposalInput();
      const proposal = store.proposals.create(input);
      expect(proposal).toEqual({
        ...input,
        displayId: 'PRP-001',
        readAt: null,
        state: 'pending',
        decision: null,
      });
      expect(store.proposals.get(proposal.id)).toEqual(proposal);
      expect(store.proposals.create(proposalInput()).displayId).toBe('PRP-002');
    });
  });

  it('작성자가 사람이면 거부한다 (제안 작성자는 항상 에이전트, NFR-03)', () => {
    withStore((store) => {
      expect(() =>
        store.proposals.create(proposalInput({ author: human as unknown as typeof ruleWriter })),
      ).toThrow();
      expect(store.proposals.list()).toEqual([]);
    });
  });

  it('목록 필터 · 대기 건수: 상태 · 종류별', () => {
    withStore((store) => {
      const req = seedRequirement(store);
      const a = store.proposals.create(proposalInput());
      const b = store.proposals.create(
        proposalInput({
          kind: 'rule_new',
          targetRef: { entity: 'Requirement', id: req.id },
          source: 'rule_generation',
        }),
      );
      const c = store.proposals.create(proposalInput());
      store.proposals.decide(c.id, {
        state: 'rejected',
        decision: { at: T1, by: human, rejectReason: '중복' },
      });

      expect(store.proposals.list().map((p) => p.id)).toEqual([a.id, b.id, c.id]);
      expect(store.proposals.list({ state: 'pending' }).map((p) => p.id)).toEqual([a.id, b.id]);
      expect(store.proposals.list({ state: 'rejected' }).map((p) => p.id)).toEqual([c.id]);
      expect(store.proposals.list({ state: 'pending', kind: 'rule_new' }).map((p) => p.id)).toEqual(
        [b.id],
      );
      expect(store.proposals.countPending()).toEqual({
        total: 2,
        byKind: { requirement_new: 1, rule_new: 1 },
      });
    });
  });

  it('처리: 한 번만, 거절은 사유 필수, 없는 제안 → NotFound', () => {
    withStore((store) => {
      const proposal = store.proposals.create(proposalInput());
      expect(() =>
        store.proposals.decide(proposal.id, {
          state: 'rejected',
          decision: { at: T1, by: human } as ProposalDecision,
        }),
      ).toThrow();
      expect(store.proposals.get(proposal.id)?.state).toBe('pending');

      const appliedRef = { entity: 'Requirement', id: newId() } as const;
      const approved = store.proposals.decide(proposal.id, {
        state: 'approved',
        decision: { at: T1, by: human, appliedRef },
      });
      expect(approved).toEqual({
        ...proposal,
        state: 'approved',
        decision: { at: T1, by: human, appliedRef },
      });
      expect(store.proposals.get(proposal.id)).toEqual(approved);
      expect(() =>
        store.proposals.decide(proposal.id, {
          state: 'rejected',
          decision: { at: T2, by: human, rejectReason: '늦은 거절' },
        }),
      ).toThrow(ConflictError);
      expect(() =>
        store.proposals.decide(newId(), {
          state: 'rejected',
          decision: { at: T2, by: human, rejectReason: '없음' },
        }),
      ).toThrow(NotFoundError);
    });
  });

  it('읽음: 처음 읽은 시각만 남는다', () => {
    withStore((store) => {
      const proposal = store.proposals.create(proposalInput());
      expect(store.proposals.markRead(proposal.id, T1).readAt).toBe(T1);
      expect(store.proposals.markRead(proposal.id, T2).readAt).toBe(T1);
      expect(() => store.proposals.markRead(newId(), T1)).toThrow(NotFoundError);
    });
  });

  it('DB 트리거: 제안 본문 수정 · 처리된 제안 재처리 · 삭제를 막는다', () => {
    withStore((store) => {
      const proposal = store.proposals.create(proposalInput());
      expect(() =>
        store.db
          .prepare('UPDATE proposals SET payload = ? WHERE id = ?')
          .run('{"text":"바꿔치기"}', proposal.id),
      ).toThrow(/바꿀 수 없습니다/);
      store.proposals.decide(proposal.id, {
        state: 'rejected',
        decision: { at: T1, by: human, rejectReason: '중복' },
      });
      expect(() =>
        store.db
          .prepare("UPDATE proposals SET state = 'approved', decision = ? WHERE id = ?")
          .run('{"at":"x"}', proposal.id),
      ).toThrow(/다시 처리할 수 없습니다/);
      expect(() => store.db.prepare('DELETE FROM proposals WHERE id = ?').run(proposal.id)).toThrow(
        /지울 수 없습니다/,
      );
      expect(store.proposals.get(proposal.id)?.state).toBe('rejected');
    });
  });
});
