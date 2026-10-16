// SCR-02 요구사항 (screens.md SCR-02 · 1.4, ADR-029 · ADR-035 · ADR-053).
// - 기본: 목록 + 상세 2단. 카드 1줄 요구사항 문장 · 생성 주체 아이콘, 2줄 ID · 예외 · 시각. [+ 새 요구사항] ·
//   검색 · 필터 칩 4종(상태 · 작성 · 승인 · 블록) · [문제만]. 상세 자리는 고른 항목이 없어 "선택 항목 없음"
// - 빈: "요구사항 없음"(ADR-029), [+ 새 요구사항]은 그대로
// - 로딩 · 에러: 화면 정의서에 정의 없음 → ADR-053 (로딩 = 목록 자리 비움, 에러 = "요구사항 불러오기 실패")
// 시각 문구는 e2e가 Asia/Seoul 시간대로 연다는 전제다 (scr-02.spec.ts).
import type { Requirement } from '@bive/shared';

import type { ElementCheck, ScreenChecklist } from './types.js';

/** 가짜 브리지가 보내는 현재 프로젝트. */
export const PROJECT = { id: '01JAAAAAAAAAAAAAAAAAAAAAAA', name: 'sample-next-app' } as const;

const base = {
  author: { kind: 'human' },
  normState: 'approved',
  unrulable: null,
  updatedBy: { kind: 'human' },
  deletedAt: null,
} as const satisfies Partial<Requirement>;

/** `requirement.list` 가짜 응답 (테스트 전용 데이터, NFR-03). 삭제된 REQ-004는 화면에 보이면 안 된다. */
export const REQUIREMENTS: Requirement[] = [
  {
    ...base,
    id: '01JB0000000000000000000001',
    displayId: 'REQ-001',
    text: '로그인 5회 실패 시 계정 10분 잠금',
    createdAt: '2026-10-15T01:00:00.000Z',
    updatedAt: '2026-10-15T01:00:00.000Z',
  },
  {
    ...base,
    id: '01JB0000000000000000000002',
    displayId: 'REQ-002',
    text: '주문 취소는 결제 후 24시간 이내만 허용',
    author: { kind: 'agent', role: 'planner' },
    normState: 'provisional',
    updatedBy: { kind: 'agent', role: 'planner' },
    createdAt: '2026-10-15T03:20:00.000Z',
    updatedAt: '2026-10-15T03:20:00.000Z',
  },
  {
    ...base,
    id: '01JB0000000000000000000003',
    displayId: 'REQ-003',
    text: '화면 전환은 사용자가 체감하기에 빠를 것',
    unrulable: { reason: '측정 기준 없음' },
    createdAt: '2026-10-14T05:05:00.000Z',
    updatedAt: '2026-10-14T05:05:00.000Z',
  },
  {
    ...base,
    id: '01JB0000000000000000000004',
    displayId: 'REQ-004',
    text: '삭제된 요구사항',
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    deletedAt: '2026-10-16T00:00:00.000Z',
  },
];

/** 화면에 보이는 순서: 문제 항목(잠정 · 규칙화 불가) 먼저 최신순, 그다음 정상 (ADR-034). */
export const VISIBLE_ORDER = ['REQ-002', 'REQ-003', 'REQ-001'] as const;

/** 필터 칩 4종 (SCR-02 필터). */
export const CHIPS = [
  { id: 'status', label: '상태' },
  { id: 'author', label: '작성' },
  { id: 'approval', label: '승인' },
  { id: 'block', label: '블록' },
] as const;

const frame: ElementCheck[] = [
  {
    label: '상세 자리',
    testId: 'requirement-detail',
    role: 'region',
    name: '상세',
    attributes: { 'data-selected-id': '' },
  },
  { label: '상세 빈 상태', text: '선택 항목 없음' },
  { label: '새 요구사항 입력 줄 (닫힘)', testId: 'new-requirement', absent: true },
];

const toolbar: ElementCheck[] = [
  { label: '목록', testId: 'list-view', role: 'region', name: '요구사항 목록' },
  {
    label: '새 요구사항 버튼',
    testId: 'new-requirement-button',
    role: 'button',
    name: '새 요구사항',
    attributes: { 'aria-expanded': 'false' },
  },
  { label: '검색', testId: 'list-search', role: 'searchbox', name: '검색' },
  ...CHIPS.map((chip): ElementCheck => ({
    label: `필터 칩 ${chip.label}`,
    testId: `filter-chip-${chip.id}`,
    text: chip.label,
  })),
  { label: '문제만 토글', testId: 'problem-toggle', role: 'button', name: '문제만' },
  { label: '결과 줄 (필터 없음)', testId: 'list-result', absent: true },
];

export const requirementsChecklist = {
  id: 'SCR-02',
  name: '요구사항',
  states: {
    기본: {
      title: 'BIVE',
      elements: [
        ...toolbar,
        { label: '카드 (삭제 항목 제외)', testId: 'card', count: 3 },
        {
          label: '카드 1줄 요구사항 문장',
          testId: 'card-title',
          text: '주문 취소는 결제 후 24시간 이내만 허용',
        },
        { label: '카드 2줄 ID', testId: 'card-id', text: 'REQ-002' },
        { label: '카드 2줄 예외', testId: 'card-exception', count: 2, text: '잠정' },
        { label: '카드 2줄 시각', text: '2026-10-15 12:20' },
        {
          label: '생성 주체 아이콘 (에이전트)',
          testId: 'author-mark',
          role: 'img',
          name: '에이전트',
          count: 1,
        },
        {
          label: '생성 주체 아이콘 (사람)',
          testId: 'author-mark',
          role: 'img',
          name: '사람',
          count: 2,
        },
        { label: '삭제된 요구사항 미표시', text: '삭제된 요구사항', absent: true },
        { label: '빈 상태 없음', text: '요구사항 없음', absent: true },
        ...frame,
      ],
    },
    빈: {
      title: 'BIVE',
      elements: [
        ...toolbar,
        { label: '빈 상태', testId: 'empty-state', text: '요구사항 없음' },
        { label: '카드 없음', testId: 'card', absent: true },
        ...frame,
      ],
    },
    로딩: {
      title: 'BIVE',
      elements: [
        {
          label: '목록 자리 (대기)',
          testId: 'requirements-loading',
          attributes: { 'aria-busy': 'true' },
        },
        { label: '목록 미표시', testId: 'list-view', absent: true },
        { label: '빈 상태 없음', text: '요구사항 없음', absent: true },
        { label: '불러오기 실패 없음', text: '요구사항 불러오기 실패', absent: true },
        ...frame,
      ],
    },
    에러: {
      title: 'BIVE',
      elements: [
        {
          label: '불러오기 실패',
          testId: 'requirements-load-error',
          role: 'alert',
          text: '요구사항 불러오기 실패',
        },
        { label: '목록 미표시', testId: 'list-view', absent: true },
        { label: '빈 상태 없음', text: '요구사항 없음', absent: true },
        ...frame,
      ],
    },
  },
} satisfies ScreenChecklist;
