// 규범의 효력 판정 (ADR-100 용어 "효력" · D5 · D6 · A3, ADR-106 · ADR-107, M7-09 #221, ADR-112).
// 효력 판정은 이 모듈 한 곳에서만 한다. 검사 단계 · 병합 재검사의 판정 대상(`steps/check.ts` · `steps/merge.ts`), 승인 단계
// 자리의 효력 확인과 실행 대기 시작 때 재검사(`runs/run-service.ts`), 모든 역할 세션의 규범 입력(`norms/norm-input.ts`),
// 지금의 준수 분모(`verification/summary.ts`), 규칙 목록 조회(`ipc/rule-handlers.ts`)가 이 함수를 쓴다(`integrity.test.ts`의
// 구조 시험이 묶는다).
// - 효력 있는 요구사항 = 삭제되지 않고 규범 상태가 효력(`approved`)인 것
// - 효력 있는 규칙 = 삭제되지 않고 규범 상태가 효력이며 폐기되지 않은 것(폐기 기록 `rule_retirements`가 없음). 부모가 해제된
//   규칙 · 내장 규칙도 넣는다. 잠정(`provisional`) · 삭제 · 폐기된 규칙은 효력이 없다
// - 효력 있는 계약 = 등록된 계약 전부(계약은 아직 고치거나 지우거나 폐기하지 않는다, M3-04 #49 · ADR-129). 변경 반영(M3-10)이
//   계약의 효력을 바꾸면 이 함수를 고친다
// - 규칙 화면의 폐기 표시(`rule.list`의 폐기 포함 · 항목의 `retirement`, M7-15 #227 · ADR-114)도 폐기 기록을 여기서 읽는다
// - 저장소를 읽기만 한다
import type { Contract, Requirement, Rule, RuleRetirementView } from '@bive/shared';
import type { ProjectStore } from '@bive/store';

/** 폐기된 규칙 ID (폐기 기록을 읽는 곳은 이 모듈과 폐기 · 대체 모듈뿐이다). */
export const retiredRuleSet = (store: ProjectStore): ReadonlySet<string> =>
  store.ruleRetirements.retiredRuleIds();

/** 규칙이 효력을 갖는지 (`retired` = 폐기된 규칙 ID). */
export const isEffectiveRule = (rule: Rule, retired: ReadonlySet<string>): boolean =>
  rule.deletedAt === null && rule.normState === 'approved' && !retired.has(rule.id);

/**
 * 폐기된 규칙 ID → 폐기 시각(밀리초). 형식이 깨져 시각을 읽을 수 없는 폐기 기록은 `-Infinity`(늘 폐기였던 것으로 본다: 효력을
 * 잃은 쪽으로 닫음). 지난 시점의 효력을 되짚는 준수 추이가 쓴다 (M3-15 #60, ADR-146).
 */
export const retirementTimesOf = (store: ProjectStore): ReadonlyMap<string, number> => {
  const times = new Map<string, number>();
  for (const ruleId of store.ruleRetirements.retiredRuleIds()) times.set(ruleId, -Infinity);
  for (const record of store.ruleRetirements.list()) {
    const at = Date.parse(record.retiredAt);
    if (!Number.isNaN(at)) times.set(record.ruleId, at);
  }
  return times;
};

/**
 * 규칙이 시각 `at`(밀리초, 그 시각은 들지 않음) 바로 앞에 효력을 가졌는지 (ADR-146): 그때 이미 만들어졌고, 삭제 · 폐기 시각이
 * `at` 이후이거나 없고, 규범 상태가 효력이다. 규범 상태는 지금 값이다(상태 변경 이력을 따로 남기지 않는다: 한계).
 * `at = Infinity`이면 지금의 {@link isEffectiveRule}과 같다(삭제 · 폐기된 규칙은 모두 빠진다).
 */
export const isEffectiveRuleBefore = (
  rule: Rule,
  retiredAt: ReadonlyMap<string, number>,
  at: number,
): boolean => {
  if (rule.normState !== 'approved') return false;
  const created = Date.parse(rule.createdAt);
  if (!Number.isNaN(created) && created >= at) return false;
  if (rule.deletedAt !== null) {
    const deleted = Date.parse(rule.deletedAt);
    if (Number.isNaN(deleted) || deleted < at) return false;
  }
  const retired = retiredAt.get(rule.id);
  return retired === undefined || retired >= at;
};

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

/** 효력 있는 계약 (표시 ID 순). */
export const effectiveContracts = (store: ProjectStore): Contract[] => store.contracts.list();

/** 삭제되지 않았고 폐기되지 않은 규칙 (표시 ID 순, 잠정 포함). 규칙 목록 조회의 기본 결과다. */
export const unretiredRules = (store: ProjectStore): Rule[] => {
  const retired = retiredRuleSet(store);
  return store.rules.list().filter((rule) => !retired.has(rule.id));
};

/**
 * 규칙 목록 조회의 대상 (표시 ID 순, 삭제 제외). 기본은 폐기되지 않은 규칙({@link unretiredRules}), `includeRetired`면 폐기된
 * 규칙도 넣는다(규칙 화면의 [폐기 포함], ADR-114).
 */
export const listedRules = (store: ProjectStore, includeRetired: boolean): Rule[] =>
  includeRetired ? store.rules.list() : unretiredRules(store);

/** 폐기 기록 행이 있으나 형식이 깨져 읽을 수 없을 때의 폐기 표시 (폐기로 본다: 효력을 잃은 쪽으로 닫음). */
const UNREADABLE_RETIREMENT: RuleRetirementView = Object.freeze({
  retiredAt: null,
  supersededBy: null,
  normChangeSeq: null,
});

/**
 * 규칙의 폐기 표시 (화면 응답용, ADR-114). 폐기되지 않았으면 `null`. 대체한 규칙은 ID와 표시 ID를 함께 싣는다(대체한 규칙
 * 행은 외래 키로 늘 있다. 없으면 대체 정보를 싣지 않는다). `retired` = {@link retiredRuleSet}.
 */
export const ruleRetirementView = (
  store: ProjectStore,
  ruleId: string,
  retired: ReadonlySet<string>,
): RuleRetirementView | null => {
  if (!retired.has(ruleId)) return null;
  const record = store.ruleRetirements.get(ruleId);
  if (record === null) return UNREADABLE_RETIREMENT;
  const replacement = record.supersededBy === null ? null : store.rules.get(record.supersededBy);
  return {
    retiredAt: record.retiredAt,
    supersededBy:
      replacement === null ? null : { id: replacement.id, displayId: replacement.displayId },
    normChangeSeq: record.normChangeSeq,
  };
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
