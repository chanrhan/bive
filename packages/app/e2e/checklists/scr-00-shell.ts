// SCR-00 앱 셸 = 레이아웃 (ADR-043, screens.md 1.2): 사이드바 · 중앙 영역 · 오른쪽 채팅 자리.
// 상태는 사이드바 하단 오케스트레이터 연결 상태로 나눈다: 기본(연결됨) · 로딩(확인 중) · 에러(연결 끊김).
// 열린 프로젝트가 없으면 중앙은 시작 화면(프로젝트 시작, M1-01)이고 프로젝트명 자리는 "프로젝트 없음",
// 할 일 건수는 근거 값이 없어 배지가 DOM에 없다 (NFR-03).
import type { ElementCheck, ScreenChecklist, StateChecklist } from './types.js';

/** 사이드바 메뉴 (1.2 그대로, 순서 포함). layout.spec.ts도 이 표를 쓴다. */
export const MENU_GROUPS = [
  { id: 'plan', label: '기획', items: ['검증', '요구사항', '규칙', '계약', '추적성 맵'] },
  {
    id: 'design',
    label: '설계',
    items: ['아키텍처', '흐름도', 'ERD', '의존성', '변경 로그', 'ADR'],
  },
  { id: 'run', label: '실행', items: ['실행 추적'] },
] as const;

export const CONNECTION_TEXT = {
  connected: '연결됨',
  checking: '연결 확인 중',
  disconnected: '연결 끊김',
} as const;

const layout = (connection: keyof typeof CONNECTION_TEXT): StateChecklist => {
  const elements: ElementCheck[] = [
    { label: '사이드바', testId: 'sidebar', role: 'complementary', name: '사이드바' },
    { label: '프로젝트명 자리', testId: 'sidebar-project', text: '프로젝트 없음' },
    { label: '할 일 알림 아이콘', testId: 'todo-button', role: 'button', name: '할 일' },
    { label: '할 일 배지 (건수 없음)', testId: 'todo-badge', absent: true },
    { label: '메뉴', role: 'navigation', name: '메뉴' },
    ...MENU_GROUPS.flatMap((group): ElementCheck[] => [
      {
        label: `메뉴 그룹 ${group.label}`,
        testId: `nav-group-${group.id}`,
        role: 'region',
        name: group.label,
      },
      ...group.items.map((item): ElementCheck => ({
        label: `메뉴 ${item}`,
        role: 'button',
        name: item,
      })),
    ]),
    {
      label: '연결 상태',
      testId: 'connection-status',
      role: 'status',
      text: CONNECTION_TEXT[connection],
      attributes: { 'data-state': connection },
    },
    { label: '설정 아이콘', testId: 'settings-button', role: 'button', name: '설정' },
    { label: '중앙 영역', testId: 'main-area', role: 'main' },
    {
      label: '중앙 시작 화면 (프로젝트 없음)',
      testId: 'main-area',
      attributes: { 'data-route': 'start' },
    },
    {
      label: '오른쪽 채팅 자리',
      testId: 'chat-panel',
      role: 'complementary',
      name: '에이전트 채팅',
      attributes: { 'data-mode': 'docked' },
    },
  ];
  return { title: 'BIVE', elements };
};

export const shellChecklist = {
  id: 'SCR-00',
  name: '앱 셸',
  states: {
    기본: layout('connected'),
    로딩: layout('checking'),
    에러: layout('disconnected'),
  },
} satisfies ScreenChecklist;
