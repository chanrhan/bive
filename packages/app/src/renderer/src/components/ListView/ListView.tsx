// 공통 목록 (screens.md 1.4 목록 · 카드, ADR-029 · ADR-034 · ADR-048).
// 검색(`/` 키로 이동) · 기준별 필터 칩 · [문제만] 토글(기본 꺼짐) · 필터 사용 중 결과 줄("n개 중 m개 · 초기화") ·
// 문제 항목 우선 정렬 · 2줄 카드 · 빈 상태("<대상> 없음").
// 데이터와 필터 기준은 화면이 props로 넘긴다(파서 · 실행 결과만, NFR-03). 필터 상태는 목록 ID별로
// 앱 실행 동안 유지된다 (filterStore.ts).
import './ListView.css';

import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

import { EmptyState } from '../../layout/EmptyState.js';
import { Card2Line, type CardData, cardExceptions } from '../Card2Line/Card2Line.js';
import { FilterChips } from '../FilterChips/FilterChips.js';
import {
  clearCriterion,
  countOptions,
  EMPTY_FILTER,
  type FilterCriterion,
  filterEntries,
  isFilterActive,
  type ListEntry,
  parseTime,
  sortProblemsFirst,
  toggleValue,
} from './filter.js';
import { useListFilter } from './filterStore.js';

export interface ListViewProps<T> {
  /** 필터 상태를 나누는 목록 ID (예: 'rules'). 같은 ID의 목록은 필터 상태를 함께 쓴다 */
  listId: string;
  /** 목록 이름 (접근 가능한 이름, 예: '규칙 목록') */
  label: string;
  items: readonly T[];
  /** 항목 고유 키 */
  itemKey: (item: T) => string;
  /** 카드에 그릴 값. 문제 항목 = 2줄째 예외(예외 상태 + `exceptions`)가 1개 이상 (ADR-034), 정렬 시각 = `dateTime` */
  card: (item: T) => CardData;
  /** 검색 대상 문구 (기본: 제목 + ID) */
  searchText?: (item: T) => string;
  /** 필터 기준 (칩 순서). 없으면 칩 없음 */
  criteria?: readonly FilterCriterion<T>[];
  /** 항목이 0건일 때 문구 (ADR-029 "<대상> 없음") */
  emptyText: string;
  /** 선택된 항목 키 */
  selectedKey?: string | null;
  /** 있으면 카드를 눌러 고른다 */
  onSelect?: (item: T) => void;
}

const NO_CRITERIA: readonly never[] = [];

/** 입력 중인 곳에서는 `/`를 가로채지 않는다. */
const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement);

export const ListView = <T,>({
  listId,
  label,
  items,
  itemKey,
  card,
  searchText,
  criteria = NO_CRITERIA,
  emptyText,
  selectedKey = null,
  onSelect,
}: ListViewProps<T>): React.JSX.Element => {
  const [filter, setFilter] = useListFilter(listId);
  const searchRef = useRef<HTMLInputElement>(null);

  // `/` 키: 검색 입력으로 이동 (1.4)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const prepared = useMemo(
    () =>
      items.map((item, index) => {
        const data = card(item);
        const entry: ListEntry<T> = {
          item,
          key: itemKey(item),
          searchText: searchText?.(item) ?? `${data.title} ${data.id}`,
          problem: cardExceptions(data).length > 0,
          time: parseTime(data.dateTime),
          index,
        };
        return { entry, data };
      }),
    [items, card, itemKey, searchText],
  );
  const entries = useMemo(() => prepared.map((p) => p.entry), [prepared]);
  const cards = useMemo(() => new Map(prepared.map((p) => [p.entry.key, p.data])), [prepared]);

  const visible = useMemo(
    () => sortProblemsFirst(filterEntries(entries, criteria, filter)),
    [entries, criteria, filter],
  );
  const counts = useMemo(
    () => countOptions(entries, criteria, filter),
    [entries, criteria, filter],
  );
  const active = isFilterActive(filter);

  return (
    <section className="list-view" data-testid="list-view" data-list-id={listId} aria-label={label}>
      <div className="list-toolbar">
        <label className="list-search">
          <Search className="inline-icon" aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            data-testid="list-search"
            aria-label="검색"
            placeholder="검색"
            value={filter.query}
            onChange={(event) => {
              const query = event.target.value;
              setFilter((prev) => ({ ...prev, query }));
            }}
          />
        </label>
        <div className="list-filters">
          <FilterChips
            criteria={criteria}
            selected={filter.selected}
            counts={counts}
            onToggle={(id, value) => setFilter((prev) => toggleValue(prev, id, value))}
            onClear={(id) => setFilter((prev) => clearCriterion(prev, id))}
          />
          <button
            type="button"
            className="list-toggle"
            data-testid="problem-toggle"
            aria-pressed={filter.problemOnly}
            onClick={() => setFilter((prev) => ({ ...prev, problemOnly: !prev.problemOnly }))}
          >
            문제만
          </button>
        </div>
      </div>

      {active && items.length > 0 && (
        <p className="list-result" data-testid="list-result">
          <span data-testid="list-result-count">
            {items.length}개 중 {visible.length}개
          </span>
          <span aria-hidden="true"> · </span>
          <button
            type="button"
            className="list-reset"
            data-testid="list-reset"
            onClick={() => setFilter(EMPTY_FILTER)}
          >
            초기화
          </button>
        </p>
      )}

      {items.length === 0 ? (
        <EmptyState text={emptyText} />
      ) : (
        <ul className="list-items" data-testid="list-items" aria-label={label}>
          {visible.map((entry) => {
            const data = cards.get(entry.key);
            if (data === undefined) return null;
            return (
              <li key={entry.key} className="list-item">
                <Card2Line
                  {...data}
                  selected={selectedKey === entry.key}
                  {...(onSelect !== undefined && { onSelect: () => onSelect(entry.item) })}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
