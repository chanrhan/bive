// 목록 필터 순수 함수 (screens.md 1.4 목록, ADR-034 · ADR-048).
// - 검색: 공백으로 나눈 단어가 전부 들어 있어야 한다(대소문자 무시)
// - 칩: 기준 안 여러 값 = OR, 기준끼리 = AND
// - [문제만]: 문제 항목(카드 2줄째 예외 1개 이상)만
// - 칩 값별 개수: 그 기준을 뺀 나머지 조건(검색 · 다른 기준 · [문제만])을 지키는 항목 중 그 값을 가진 수
// - 정렬: 문제 항목 먼저, 같은 묶음 안에서는 시각 최신순(시각 없음은 뒤), 같으면 원래 순서
// DOM · React에 의존하지 않는다 (test/list-filter.test.ts).

/** 칩 메뉴의 값 하나. `value`는 식별자, `label`은 화면 문구. */
export interface FilterOption {
  value: string;
  label: string;
}

/** 필터 기준 하나 (예: 상태 · 생성 주체). 값 목록 순서가 메뉴 순서다. */
export interface FilterCriterion<T> {
  id: string;
  label: string;
  options: readonly FilterOption[];
  /** 항목이 가진 이 기준의 값들 (여러 개일 수 있다). */
  values: (item: T) => readonly string[];
}

/** 목록 하나의 필터 상태. 앱 실행 동안 목록별로 유지한다 (filterStore.ts). */
export interface FilterState {
  query: string;
  /** 기준 ID → 고른 값들. 빈 배열 · 없는 키 = 그 기준 미사용 */
  selected: Readonly<Record<string, readonly string[]>>;
  problemOnly: boolean;
}

export const EMPTY_FILTER: FilterState = Object.freeze({
  query: '',
  selected: Object.freeze({}),
  problemOnly: false,
});

/** 필터 계산에 쓰는 항목 한 건 (화면 데이터에서 한 번 만든다). */
export interface ListEntry<T> {
  item: T;
  key: string;
  /** 검색 대상 문구 */
  searchText: string;
  /** 문제 항목 여부 = 카드 2줄째 예외가 1개 이상 (ADR-034) */
  problem: boolean;
  /** 정렬 시각(ms). 없으면 null */
  time: number | null;
  /** 원래 순서 (정렬 안정성) */
  index: number;
}

/** ISO 8601 시각 → ms. 비었거나 해석할 수 없으면 null. */
export const parseTime = (iso: string | undefined): number | null => {
  if (iso === undefined || iso === '') return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

const words = (query: string): string[] => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

/** 검색어의 단어가 전부 `text`에 들어 있으면 true. 빈 검색어는 전부 일치. */
export const matchesQuery = (text: string, query: string): boolean => {
  const haystack = text.toLowerCase();
  return words(query).every((word) => haystack.includes(word));
};

/** 고른 값이 있는 기준만 (모르는 기준 ID는 무시). */
const activeCriteria = <T>(
  criteria: readonly FilterCriterion<T>[],
  selected: FilterState['selected'],
): { criterion: FilterCriterion<T>; values: ReadonlySet<string> }[] =>
  criteria.flatMap((criterion) => {
    const values = selected[criterion.id] ?? [];
    return values.length === 0 ? [] : [{ criterion, values: new Set(values) }];
  });

/** 기준끼리 AND, 기준 안 OR. `exceptId` 기준은 건너뛴다(칩 개수 계산용). */
const matchesCriteria = <T>(
  item: T,
  active: ReturnType<typeof activeCriteria<T>>,
  exceptId?: string,
): boolean =>
  active.every(
    ({ criterion, values }) =>
      criterion.id === exceptId || criterion.values(item).some((value) => values.has(value)),
  );

/** 검색 · 칩 · [문제만]을 적용한다. 순서는 입력 그대로. */
export const filterEntries = <T>(
  entries: readonly ListEntry<T>[],
  criteria: readonly FilterCriterion<T>[],
  state: FilterState,
): ListEntry<T>[] => {
  const active = activeCriteria(criteria, state.selected);
  return entries.filter(
    (entry) =>
      (!state.problemOnly || entry.problem) &&
      matchesQuery(entry.searchText, state.query) &&
      matchesCriteria(entry.item, active),
  );
};

/** 기준 ID → 값 → 개수. 개수는 그 기준을 뺀 나머지 조건을 지키는 항목 중 그 값을 가진 수. */
export type OptionCounts = Record<string, Record<string, number>>;

export const countOptions = <T>(
  entries: readonly ListEntry<T>[],
  criteria: readonly FilterCriterion<T>[],
  state: FilterState,
): OptionCounts => {
  const active = activeCriteria(criteria, state.selected);
  const base = entries.filter(
    (entry) => (!state.problemOnly || entry.problem) && matchesQuery(entry.searchText, state.query),
  );
  const counts: OptionCounts = {};
  for (const criterion of criteria) {
    const byValue: Record<string, number> = Object.fromEntries(
      criterion.options.map((option) => [option.value, 0]),
    );
    for (const entry of base) {
      if (!matchesCriteria(entry.item, active, criterion.id)) continue;
      // 한 항목이 같은 값을 두 번 가져도 한 번만 센다
      for (const value of new Set(criterion.values(entry.item))) {
        if (value in byValue) byValue[value] = (byValue[value] ?? 0) + 1;
      }
    }
    counts[criterion.id] = byValue;
  }
  return counts;
};

/** 문제 항목 먼저, 같은 묶음 안에서는 시각 최신순(시각 없음은 뒤), 같으면 원래 순서. */
export const sortProblemsFirst = <T>(entries: readonly ListEntry<T>[]): ListEntry<T>[] =>
  [...entries].sort((a, b) => {
    if (a.problem !== b.problem) return a.problem ? -1 : 1;
    if (a.time !== b.time) {
      if (a.time === null) return 1;
      if (b.time === null) return -1;
      return b.time - a.time;
    }
    return a.index - b.index;
  });

/** 필터 사용 중이면 true (검색어 · 고른 칩 값 · [문제만] 중 하나라도). 결과 줄 표시 조건. */
export const isFilterActive = (state: FilterState): boolean =>
  state.query.trim() !== '' ||
  state.problemOnly ||
  Object.values(state.selected).some((values) => values.length > 0);

/** 기준 `criterionId`의 값 `value`를 켜거나 끈다. */
export const toggleValue = (
  state: FilterState,
  criterionId: string,
  value: string,
): FilterState => {
  const current = state.selected[criterionId] ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return { ...state, selected: { ...state.selected, [criterionId]: next } };
};

/** 기준 하나의 고른 값을 모두 지운다 (칩의 ×). */
export const clearCriterion = (state: FilterState, criterionId: string): FilterState => {
  if (!(criterionId in state.selected)) return state;
  const rest = Object.fromEntries(
    Object.entries(state.selected).filter(([id]) => id !== criterionId),
  );
  return { ...state, selected: rest };
};
