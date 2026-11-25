// 대상 블록 · 구현 위치의 표시 규칙 (NRM-09, screens.md SCR-02 상세 "구현 위치(자식 규칙의 대상 블록만)" · 필터 "블록", SCR-03
// 표시 "대상 블록 · 위험도" · 필터 "블록 · 위험도", M3-19 #64 · ADR-126). DOM · React에 의존하지 않는다 (test/block-view.test.ts).
// - 블록 이름은 규칙에 저장된 그대로(사람이 선언에 적은 식별자: 소문자 · 숫자 · `-`, shared `BlockName`) 보인다. 값은 rule.list ·
//   blocks.get 응답에서만 만든다(NFR-03)
// - 선언에 없는 이름: 지금 블록 선언(`blocks.get`의 가장 큰 판)이 있고 그 이름이 선언에 없으면 이름 뒤에 "선언 외". 선언이 아예
//   없는 프로젝트면 이름마다 붙이지 않고 "블록 선언 없음"을 한 번 보인다. 선언을 아직 모르거나(읽는 중) 읽지 못했으면 이름만
//   보인다(읽지 못했으면 "블록 선언 불러오기 실패" 한 번). 화면이 선언을 지어내지 않는다
// - 구현 위치 = 효력 있는 자식 규칙(삭제 · 폐기되지 않고 효력 상태)의 대상 블록 합집합. 순서는 선언 순서, 선언에 없는 이름은
//   그 뒤에 이름 순
// - 필터 칩의 블록 값 = 목록 항목이 가진 이름 전부(선언에 없는 이름 포함), 이름 순. 한 항목이 블록 여러 개면 블록마다 한 번씩
//   센다(목록 공용 계산). 요구사항의 블록 값 = 그 요구사항의 구현 위치
import type { BlocksResult, RuleWithJudgment } from '@bive/shared';

import type { FilterOption } from '../../components/ListView/filter.js';

export const BLOCK_TEXT = {
  blocks: '대상 블록',
  risk: '위험도',
  implementation: '구현 위치',
  none: '없음',
  undeclared: '선언 외',
  noDeclaration: '블록 선언 없음',
  declarationFailed: '블록 선언 불러오기 실패',
  implementationFailed: '구현 위치 불러오기 실패',
} as const;

/** 지금 블록 선언 읽기 상태. `names`가 `null`이면 선언이 없는 프로젝트다. */
export type BlockDeclarationLoad =
  { state: 'loading' } | { state: 'ready'; names: readonly string[] | null } | { state: 'error' };

/** `blocks.get` 결과 → 선언된 블록 이름(선언 순서). 선언이 없으면 `null`. */
export const declaredBlockNames = (result: BlocksResult): string[] | null =>
  result.current === null ? null : result.current.declaration.blocks.map((block) => block.name);

export interface BlockRow {
  name: string;
  /** 지금 선언이 있고 그 선언에 이 이름이 없다 */
  undeclared: boolean;
}

/** 이름 목록 아래에 한 번 보이는 알림. */
export type BlockNote = 'noDeclaration' | 'declarationFailed';

export interface BlockListView {
  rows: BlockRow[];
  note: BlockNote | null;
}

/** 이름 목록(받은 순서) → 줄 · 알림. 이름이 없으면 줄 · 알림 모두 없다(화면은 "없음"). */
export const blockListView = (
  names: readonly string[],
  declaration: BlockDeclarationLoad,
): BlockListView => {
  if (names.length === 0) return { rows: [], note: null };
  const declared =
    declaration.state === 'ready' && declaration.names !== null ? new Set(declaration.names) : null;
  const rows = names.map((name) => ({
    name,
    undeclared: declared !== null && !declared.has(name),
  }));
  const note: BlockNote | null =
    declaration.state === 'error'
      ? 'declarationFailed'
      : declaration.state === 'ready' && declaration.names === null
        ? 'noDeclaration'
        : null;
  return { rows, note };
};

export const BLOCK_NOTE_TEXT = {
  noDeclaration: BLOCK_TEXT.noDeclaration,
  declarationFailed: BLOCK_TEXT.declarationFailed,
} as const satisfies Record<BlockNote, string>;

/** 이름 순 비교 (언어 설정에 흔들리지 않게 글자 코드 순). */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 효력 있는 규칙인지: 삭제되지 않고 효력 상태이며 폐기되지 않음 (오케스트레이터 `isEffectiveRule`과 같은 정의, ADR-112). */
export const isEffectiveRuleItem = ({ rule, retirement }: RuleWithJudgment): boolean =>
  rule.deletedAt === null && rule.normState === 'approved' && retirement === undefined;

/**
 * 요구사항의 구현 위치: 효력 있는 자식 규칙의 대상 블록, 중복 없이. `childRules`는 이미 이 요구사항의 자식으로 거른 것이다.
 * 순서는 선언 순서(`declared`), 선언에 없는 이름은 뒤에 이름 순. 선언이 없거나 모르면(`null`) 이름 순.
 */
export const implementationBlocks = (
  childRules: readonly RuleWithJudgment[],
  declared: readonly string[] | null,
): string[] => {
  const names = new Set<string>();
  for (const item of childRules) {
    if (!isEffectiveRuleItem(item)) continue;
    for (const name of item.rule.targetBlockIds) names.add(name);
  }
  const order = new Map((declared ?? []).map((name, index) => [name, index] as const));
  return [...names].sort((a, b) => {
    const ia = order.get(a);
    const ib = order.get(b);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return byName(a, b);
  });
};

/** 요구사항 ID → 구현 위치(이름 순). 규칙 목록 전체에서 한 번에 만든다(요구사항 목록의 블록 칩). */
export const implementationBlocksByRequirement = (
  rules: readonly RuleWithJudgment[],
): ReadonlyMap<string, readonly string[]> => {
  const grouped = new Map<string, RuleWithJudgment[]>();
  for (const item of rules) {
    const parent = item.rule.parentRequirementId;
    if (parent === null) continue;
    const list = grouped.get(parent);
    if (list === undefined) grouped.set(parent, [item]);
    else list.push(item);
  }
  const out = new Map<string, readonly string[]>();
  for (const [parent, items] of grouped) {
    const names = implementationBlocks(items, null);
    if (names.length > 0) out.set(parent, names);
  }
  return out;
};

/** 블록 칩의 값: 이름 전부, 중복 없이 이름 순. 표시명 = 이름. */
export const blockOptions = (names: Iterable<string>): FilterOption[] =>
  [...new Set(names)].sort(byName).map((name) => ({ value: name, label: name }));
