// 요구사항 상세 표시 규칙 (이슈 #38, screens.md SCR-02 상세 · SCR-06, ADR-078).
import type { Rule, RuleWithJudgment } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  canSaveEdit,
  childRulesOf,
  REQUIREMENT_DETAIL_TEXT,
} from '../src/renderer/src/screens/norm-detail/requirementDetailView.js';

const REQ = '01JB0000000000000000000001';
const OTHER = '01JB0000000000000000000002';

const ruleOf = (id: string, patch: Partial<Rule> = {}): RuleWithJudgment => ({
  rule: {
    id,
    displayId: `RULE-${id.slice(-3)}`,
    title: '제목',
    statement: 'THE SYSTEM SHALL 동작한다',
    kind: 'business',
    checkKinds: ['test'],
    parentRequirementId: REQ,
    parentDetachedAt: null,
    builtin: false,
    risk: null,
    contractId: null,
    author: { kind: 'agent', role: 'rule-writer' },
    normState: 'approved',
    targetBlockIds: [],
    createdAt: '2026-10-15T01:00:00.000Z',
    updatedAt: '2026-10-15T01:00:00.000Z',
    deletedAt: null,
    ...patch,
  } as Rule,
  judgment: { status: 'unjudged', latest: null },
});

describe('childRulesOf: 자식 규칙', () => {
  it('부모가 이 요구사항인 규칙만, 받은 순서 그대로', () => {
    const rules = [
      ruleOf('01JC0000000000000000000003'),
      ruleOf('01JC0000000000000000000001', { parentRequirementId: OTHER }),
      ruleOf('01JC0000000000000000000002'),
    ];
    expect(childRulesOf(REQ, rules).map(({ rule }) => rule.id)).toEqual([
      '01JC0000000000000000000003',
      '01JC0000000000000000000002',
    ]);
  });

  it('부모가 해제된 규칙 · 삭제된 규칙은 자식이 아니다', () => {
    const rules = [
      ruleOf('01JC0000000000000000000001', {
        parentRequirementId: null,
        parentDetachedAt: '2026-10-16T00:00:00.000Z',
      }),
      ruleOf('01JC0000000000000000000002', { deletedAt: '2026-10-16T00:00:00.000Z' }),
    ];
    expect(childRulesOf(REQ, rules)).toEqual([]);
  });
});

describe('canSaveEdit: 직접 편집 저장 가능 여부', () => {
  const requirement = { text: '로그인 5회 실패 시 계정 10분 잠금' };

  it('바뀐 본문은 저장할 수 있다 (받은 문구 그대로, 앞뒤 공백 포함)', () => {
    expect(canSaveEdit(requirement, '로그인 5회 실패 시 계정 30분 잠금')).toBe(true);
    expect(canSaveEdit(requirement, `${requirement.text} `)).toBe(true);
  });

  it('바뀌지 않았거나 공백만 있는 본문은 저장하지 않는다', () => {
    expect(canSaveEdit(requirement, requirement.text)).toBe(false);
    expect(canSaveEdit(requirement, '')).toBe(false);
    expect(canSaveEdit(requirement, ' \n\t')).toBe(false);
  });
});

describe('문구 (screens.md 1.1 명사형)', () => {
  it('삭제는 두 번 눌러 확인: 삭제 → 삭제 확인', () => {
    expect(REQUIREMENT_DETAIL_TEXT.remove).toBe('삭제');
    expect(REQUIREMENT_DETAIL_TEXT.confirmRemove).toBe('삭제 확인');
  });
});
