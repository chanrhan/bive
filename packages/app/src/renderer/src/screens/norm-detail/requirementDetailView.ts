// 요구사항 상세의 표시 규칙 (screens.md SCR-02 상세 · SCR-06 · 1.4, ADR-078). DOM · React에 의존하지 않는다
// (test/requirement-detail-view.test.ts).
// - 값은 requirement.list 항목(본문 · 생성 주체) · rule.list(자식 규칙)에서만 만든다(NFR-03)
// - 자식 규칙 = 부모 요구사항 ID가 이 요구사항인 규범(삭제 제외), 받은 순서(표시 ID 순, ADR-060)
// - 직접 편집 저장은 본문이 공백만이거나 바뀌지 않았으면 하지 않는다(빈 본문은 서버도 거부, ADR-047)
import type { Requirement, RuleWithJudgment } from '@bive/shared';

export const REQUIREMENT_DETAIL_TEXT = {
  text: '본문',
  author: '생성 주체',
  rules: '자식 규칙',
  none: '없음',
  rulesFailed: '자식 규칙 불러오기 실패',
  edit: '편집',
  editLabel: '요구사항 본문 편집',
  save: '저장',
  cancel: '취소',
  remove: '삭제',
  confirmRemove: '삭제 확인',
  saveFailed: '요구사항 저장 실패',
  removeFailed: '요구사항 삭제 실패',
} as const;

/** 요구사항의 자식 규칙: 부모가 이 요구사항이고 삭제되지 않은 규칙. 순서는 받은 그대로. */
export const childRulesOf = (
  requirementId: string,
  rules: readonly RuleWithJudgment[],
): RuleWithJudgment[] =>
  rules.filter(({ rule }) => rule.parentRequirementId === requirementId && rule.deletedAt === null);

/** 편집한 본문을 저장할 수 있는가: 공백만이 아니고 지금 본문과 다를 때. */
export const canSaveEdit = (requirement: Pick<Requirement, 'text'>, draft: string): boolean =>
  draft.trim().length > 0 && draft !== requirement.text;
