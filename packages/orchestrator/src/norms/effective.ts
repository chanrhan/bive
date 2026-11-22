// 규범의 효력 판정 (ADR-100 용어 "효력" · D5 · D6 · A3, ADR-106 · ADR-107, M7-09 #221, ADR-112).
// 효력 판정은 이 모듈 한 곳에서만 한다. 검사 단계 · 병합 재검사의 판정 대상(`steps/check.ts` · `steps/merge.ts`), 승인 단계
// 자리의 효력 확인과 실행 대기 시작 때 재검사(`runs/run-service.ts`), 모든 역할 세션의 규범 입력(`norms/norm-input.ts`),
// 지금의 준수 분모(`verification/summary.ts`), 규칙 목록 조회(`ipc/rule-handlers.ts`)가 이 함수를 쓴다(`integrity.test.ts`의
// 구조 시험이 묶는다).
// - 효력 있는 요구사항 = 삭제되지 않고 규범 상태가 효력(`approved`)인 것
// - 효력 있는 규칙 = 삭제되지 않고 규범 상태가 효력이며 폐기되지 않은 것(폐기 기록 `rule_retirements`가 없음). 부모가 해제된
//   규칙 · 내장 규칙도 넣는다. 잠정(`provisional`) · 삭제 · 폐기된 규칙은 효력이 없다
// - 저장소를 읽기만 한다
import type { Requirement, Rule } from '@bive/shared';
import type { ProjectStore } from '@bive/store';

/** 폐기된 규칙 ID (폐기 기록을 읽는 곳은 이 모듈과 폐기 · 대체 모듈뿐이다). */
export const retiredRuleSet = (store: ProjectStore): ReadonlySet<string> =>
  store.ruleRetirements.retiredRuleIds();

/** 규칙이 효력을 갖는지 (`retired` = 폐기된 규칙 ID). */
export const isEffectiveRule = (rule: Rule, retired: ReadonlySet<string>): boolean =>
  rule.deletedAt === null && rule.normState === 'approved' && !retired.has(rule.id);

/** 효력 있는 요구사항 (표시 ID 순). */
export const effectiveRequirements = (store: ProjectStore): Requirement[] =>
  store.requirements
    .list()
    .filter(
      (requirement) => requirement.deletedAt === null && requirement.normState === 'approved',
    );

/** 효력 있는 규칙 (표시 ID 순). 검사 단계 · 병합 재검사의 판정 대상과 같다. */
export const effectiveRules = (store: ProjectStore): Rule[] => {
  const retired = retiredRuleSet(store);
  return store.rules.list().filter((rule) => isEffectiveRule(rule, retired));
};

/** 삭제되지 않았고 폐기되지 않은 규칙 (표시 ID 순, 잠정 포함). 규칙 목록 조회의 기본 결과다. */
export const unretiredRules = (store: ProjectStore): Rule[] => {
  const retired = retiredRuleSet(store);
  return store.rules.list().filter((rule) => !retired.has(rule.id));
};

/** 대상 규칙 중 효력이 없는 것 (없음 · 삭제됨 · 효력 아님 · 폐기됨), 주어진 순서. */
export const ineffectiveRuleIds = (store: ProjectStore, ruleIds: readonly string[]): string[] => {
  const retired = retiredRuleSet(store);
  return ruleIds.filter((ruleId) => {
    const rule = store.rules.get(ruleId);
    return rule === null || !isEffectiveRule(rule, retired);
  });
};

/** 대상 규칙 중 폐기된 것, 주어진 순서. */
export const retiredRuleIdsOf = (store: ProjectStore, ruleIds: readonly string[]): string[] => {
  const retired = retiredRuleSet(store);
  return ruleIds.filter((ruleId) => retired.has(ruleId));
};

/**
 * 실행의 대상 규칙이 실행 도중(단계 사이 · 병합 직전) 폐기되었을 때의 실패 사유 (ADR-100 A3 · A4, ADR-112). 승인 단계 자리 ·
 * 실행 대기 시작 때의 효력 확인은 폐기도 효력 없음으로 보아 `target_rule_unavailable`로 끝낸다(ADR-107).
 */
export const TARGET_RULE_RETIRED = 'target_rule_retired';

/** 대상 규칙 중 폐기된 것의 표시 ID (실패 기록용, 주어진 순서). 없으면 빈 목록. */
export const retiredTargetDisplayIds = (
  store: ProjectStore,
  ruleIds: readonly string[],
): string[] =>
  retiredRuleIdsOf(store, ruleIds).map((ruleId) => store.rules.get(ruleId)?.displayId ?? ruleId);
