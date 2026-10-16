// 목록 필터 순수 함수 (이슈 #16, screens.md 1.4 목록, ADR-034 · ADR-048).
import { describe, expect, it } from 'vitest';

import {
  clearCriterion,
  countOptions,
  EMPTY_FILTER,
  type FilterCriterion,
  filterEntries,
  type FilterState,
  isFilterActive,
  type ListEntry,
  matchesQuery,
  parseTime,
  sortProblemsFirst,
  toggleValue,
} from '../src/renderer/src/components/ListView/filter.js';

interface Row {
  id: string;
  title: string;
  status: string;
  tags: string[];
  problem: boolean;
  at?: string;
}

const ROWS: Row[] = [
  {
    id: 'A',
    title: '로그인 성공',
    status: 'pass',
    tags: ['auth'],
    problem: false,
    at: '2026-10-01T00:00:00Z',
  },
  {
    id: 'B',
    title: '로그인 실패 잠금',
    status: 'fail',
    tags: ['auth', 'security'],
    problem: true,
    at: '2026-10-02T00:00:00Z',
  },
  {
    id: 'C',
    title: '주문 생성',
    status: 'pass',
    tags: ['order'],
    problem: false,
    at: '2026-10-03T00:00:00Z',
  },
  {
    id: 'D',
    title: '주문 취소',
    status: 'quarantined',
    tags: ['order'],
    problem: true,
    at: '2026-10-04T00:00:00Z',
  },
  { id: 'E', title: '결제 승인', status: 'fail', tags: ['payment', 'security'], problem: true },
];

const CRITERIA: FilterCriterion<Row>[] = [
  {
    id: 'status',
    label: '상태',
    options: [
      { value: 'pass', label: '통과' },
      { value: 'fail', label: '실패' },
      { value: 'quarantined', label: '격리' },
      { value: 'needs_recheck', label: '재검증 필요' },
    ],
    values: (row) => [row.status],
  },
  {
    id: 'tag',
    label: '태그',
    options: [
      { value: 'auth', label: '인증' },
      { value: 'order', label: '주문' },
      { value: 'payment', label: '결제' },
      { value: 'security', label: '보안' },
    ],
    values: (row) => row.tags,
  },
];

const entries: ListEntry<Row>[] = ROWS.map((row, index) => ({
  item: row,
  key: row.id,
  searchText: `${row.title} ${row.id}`,
  problem: row.problem,
  time: parseTime(row.at),
  index,
}));

const ids = (list: ListEntry<Row>[]): string[] => list.map((e) => e.key);

const withSelected = (selected: FilterState['selected']): FilterState => ({
  ...EMPTY_FILTER,
  selected,
});

describe('검색', () => {
  it('공백으로 나눈 단어가 전부 들어 있어야 하고 대소문자를 무시한다', () => {
    expect(matchesQuery('로그인 실패 잠금 B', '실패 b')).toBe(true);
    expect(matchesQuery('로그인 실패 잠금 B', '실패 주문')).toBe(false);
    expect(matchesQuery('아무 문구', '   ')).toBe(true);
  });

  it('검색어로 항목을 거른다', () => {
    expect(ids(filterEntries(entries, CRITERIA, { ...EMPTY_FILTER, query: '주문' }))).toEqual([
      'C',
      'D',
    ]);
  });
});

describe('칩 필터', () => {
  it('기준 안 여러 값은 OR', () => {
    const state = withSelected({ status: ['fail', 'quarantined'] });
    expect(ids(filterEntries(entries, CRITERIA, state))).toEqual(['B', 'D', 'E']);
  });

  it('기준끼리는 AND', () => {
    const state = withSelected({ status: ['fail', 'quarantined'], tag: ['security'] });
    expect(ids(filterEntries(entries, CRITERIA, state))).toEqual(['B', 'E']);
  });

  it('여러 값을 가진 항목은 그중 하나만 맞아도 된다', () => {
    expect(ids(filterEntries(entries, CRITERIA, withSelected({ tag: ['security'] })))).toEqual([
      'B',
      'E',
    ]);
  });

  it('빈 선택 · 모르는 기준 ID는 거르지 않는다', () => {
    const state = withSelected({ status: [], unknown: ['x'] });
    expect(ids(filterEntries(entries, CRITERIA, state))).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('[문제만]은 문제 항목만 남긴다', () => {
    const state = { ...EMPTY_FILTER, problemOnly: true };
    expect(ids(filterEntries(entries, CRITERIA, state))).toEqual(['B', 'D', 'E']);
  });
});

describe('칩 값별 개수', () => {
  it('필터가 없으면 전체 항목 기준이고 없는 값은 0', () => {
    const counts = countOptions(entries, CRITERIA, EMPTY_FILTER);
    expect(counts['status']).toEqual({ pass: 2, fail: 2, quarantined: 1, needs_recheck: 0 });
    expect(counts['tag']).toEqual({ auth: 2, order: 2, payment: 1, security: 2 });
  });

  it('자기 기준은 빼고 다른 기준 · 검색 · [문제만]을 적용해 센다', () => {
    const state: FilterState = {
      query: '',
      selected: { status: ['fail'] },
      problemOnly: false,
    };
    const counts = countOptions(entries, CRITERIA, state);
    // 상태 칩: 자기 선택(fail)과 무관하게 전체 기준
    expect(counts['status']).toEqual({ pass: 2, fail: 2, quarantined: 1, needs_recheck: 0 });
    // 태그 칩: 상태 = 실패(B · E)인 항목 안에서
    expect(counts['tag']).toEqual({ auth: 1, order: 0, payment: 1, security: 2 });

    const problemOnly = countOptions(entries, CRITERIA, { ...EMPTY_FILTER, problemOnly: true });
    expect(problemOnly['status']).toEqual({ pass: 0, fail: 2, quarantined: 1, needs_recheck: 0 });

    const searched = countOptions(entries, CRITERIA, { ...EMPTY_FILTER, query: '로그인' });
    expect(searched['status']).toEqual({ pass: 1, fail: 1, quarantined: 0, needs_recheck: 0 });
  });

  it('한 항목의 같은 값은 한 번만 센다', () => {
    const dup: ListEntry<Row>[] = [
      { ...entries[0]!, item: { ...ROWS[0]!, tags: ['auth', 'auth'] } },
    ];
    expect(countOptions(dup, CRITERIA, EMPTY_FILTER)['tag']?.['auth']).toBe(1);
  });
});

describe('문제 우선 정렬', () => {
  it('문제 항목 먼저, 묶음 안에서는 시각 최신순, 시각 없음은 뒤', () => {
    expect(ids(sortProblemsFirst(entries))).toEqual(['D', 'B', 'E', 'C', 'A']);
  });

  it('시각이 같으면 원래 순서를 지킨다', () => {
    const same = entries.map((e) => ({ ...e, time: 0, problem: false }));
    expect(ids(sortProblemsFirst(same))).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('입력 배열을 바꾸지 않는다', () => {
    const copy = [...entries];
    sortProblemsFirst(entries);
    expect(entries).toEqual(copy);
  });
});

describe('필터 상태 변경', () => {
  it('값을 켜고 끄고, 기준을 해제한다', () => {
    let state = toggleValue(EMPTY_FILTER, 'status', 'fail');
    state = toggleValue(state, 'status', 'quarantined');
    expect(state.selected['status']).toEqual(['fail', 'quarantined']);
    state = toggleValue(state, 'status', 'fail');
    expect(state.selected['status']).toEqual(['quarantined']);
    state = clearCriterion(state, 'status');
    expect(state.selected).toEqual({});
    expect(clearCriterion(state, 'status')).toBe(state);
    // 빈 필터는 그대로 (얼린 객체)
    expect(EMPTY_FILTER.selected).toEqual({});
  });

  it('필터 사용 여부: 검색어 · 칩 값 · [문제만] 중 하나라도', () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTER, query: '  ' })).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTER, query: '주문' })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, problemOnly: true })).toBe(true);
    expect(isFilterActive(withSelected({ status: [] }))).toBe(false);
    expect(isFilterActive(withSelected({ status: ['fail'] }))).toBe(true);
  });

  it('시각 해석: 비었거나 잘못된 값은 null', () => {
    expect(parseTime(undefined)).toBeNull();
    expect(parseTime('')).toBeNull();
    expect(parseTime('어제')).toBeNull();
    expect(parseTime('2026-10-01T00:00:00Z')).toBe(Date.UTC(2026, 9, 1));
  });
});
