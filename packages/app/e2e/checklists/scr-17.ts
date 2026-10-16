// SCR-17 승인 대기 (screens.md 6장 할 일 · SCR-17, TODO-01, ADR-029 · ADR-035 · ADR-056).
// 사이드바 알림 아이콘 → 할 일. 머리 탭은 [승인 대기] 하나(검토 대기열 · 계약 변경 승인 탭은 DOM에 없음).
// 왼쪽 승인 대기 목록(검색 · 필터 칩 4종 · 2줄 카드), 오른쪽 상세 자리("선택 항목"). 상세 내용 · 처리 버튼은 #40.
// 상태: 기본(대기 제안 있음) · 빈("대기 항목 없음", ADR-029). 로딩 · 에러는 화면 정의서에 없다
// (에러 "상한 초과 시 머리줄 빨강"은 #58 M3-13).
import type { ElementCheck, ScreenChecklist, StateChecklist } from './types.js';

/** 할 일 머리 탭 (M1). todo-entry.spec.ts도 이 표를 쓴다. */
export const TODO_TAB_LABELS = ['승인 대기'] as const;

/** 다음 마일스톤 탭 (ADR-035: DOM에 없음). */
export const HIDDEN_TODO_TABS = ['검토 대기열', '계약 변경 승인'] as const;

/** 필터 칩 4종 (SCR-17 필터): 기준 ID · 이름. */
export const APPROVAL_FILTERS = [
  { id: 'state', label: '처리 상태' },
  { id: 'kind', label: '종류' },
  { id: 'risk', label: '위험도' },
  { id: 'author', label: '제안자' },
] as const;

export const APPROVAL_EMPTY_TEXT = '대기 항목 없음';

const common: ElementCheck[] = [
  {
    label: '할 일 알림 아이콘 (선택됨)',
    testId: 'todo-button',
    role: 'button',
    name: '할 일',
    attributes: { 'aria-pressed': 'true' },
  },
  { label: '할 일 화면', testId: 'todo-screen', role: 'region', name: '할 일' },
  { label: '탭 목록', role: 'tablist', name: '할 일 종류' },
  { label: '탭 수', role: 'tab', count: TODO_TAB_LABELS.length },
  {
    label: '승인 대기 탭 (선택됨)',
    role: 'tab',
    name: '승인 대기',
    attributes: { 'aria-selected': 'true' },
  },
  ...HIDDEN_TODO_TABS.map((name): ElementCheck => ({
    label: `${name} 탭 미노출`,
    role: 'tab',
    name,
    absent: true,
  })),
  { label: '대기 상한 머리줄 미노출 (#58)', text: /상한/, absent: true },
  { label: '상세 자리', testId: 'todo-detail', role: 'region', name: '선택 항목' },
];

const basic: StateChecklist = {
  title: 'BIVE',
  elements: [
    { label: '할 일 배지', testId: 'todo-badge', text: /^\d+$/ },
    ...common,
    { label: '승인 대기 목록', testId: 'list-view', role: 'region', name: '승인 대기 목록' },
    { label: '검색', testId: 'list-search', role: 'searchbox', name: '검색' },
    ...APPROVAL_FILTERS.map(({ id, label }): ElementCheck => ({
      label: `필터 칩 ${label}`,
      testId: `filter-chip-${id}`,
    })),
    {
      label: '처리 상태 기본값 대기',
      testId: 'filter-chip-state',
      attributes: { 'data-selected': 'true' },
    },
    { label: '카드', testId: 'card' },
    { label: '카드 1줄 종류 태그', testId: 'card-tag' },
    { label: '카드 1줄 제목', testId: 'card-title' },
    { label: '카드 2줄 표시 ID', testId: 'card-id', text: /^PRP-\d{3,}$/ },
    { label: '안 읽음 점', testId: 'card-unread', role: 'img', name: '안 읽음' },
    { label: '상세 빈 자리', testId: 'empty-state', text: '선택 항목 없음' },
  ],
};

const empty: StateChecklist = {
  title: 'BIVE',
  elements: [
    { label: '할 일 배지 (대기 0건)', testId: 'todo-badge', absent: true },
    ...common,
    { label: '빈 상태', testId: 'empty-state', text: APPROVAL_EMPTY_TEXT },
    { label: '카드 없음', testId: 'card', count: 0 },
  ],
};

export const approvalChecklist = {
  id: 'SCR-17',
  name: '승인 대기',
  states: { 기본: basic, 빈: empty },
} satisfies ScreenChecklist;
