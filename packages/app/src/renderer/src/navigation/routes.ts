// 내비게이션 항목 (screens.md 1.2 화면 구조). 이름 · 순서는 1.2 그대로다.
// 경로 ID는 영어 식별자이고 화면에는 이름(label)만 보인다 (1.1: 화면 코드 표기 금지).
import {
  Activity,
  Boxes,
  Database,
  GitCommitHorizontal,
  ListChecks,
  type LucideIcon,
  NotebookPen,
  Package,
  Scale,
  ShieldCheck,
  Signature,
  Waypoints,
  Workflow,
} from 'lucide-react';

/** 사이드바 메뉴 경로. 주석은 대응 화면 (screens.md 1.3). */
export type MenuRouteId =
  | 'verification' // SCR-05 검증
  | 'requirements' // SCR-02 요구사항
  | 'rules' // SCR-03 규칙
  | 'contracts' // SCR-04 계약
  | 'traceability' // SCR-07 추적성 맵
  | 'architecture' // SCR-08 아키텍처 (L0 · L1 상세 캔버스 SCR-09 · 10 포함)
  | 'flow' // SCR-11 흐름도
  | 'erd' // SCR-12 ERD
  | 'dependencies' // SCR-13 의존성
  | 'changelog' // SCR-14 변경 로그
  | 'adr' // SCR-15 ADR
  | 'runs'; // SCR-16 실행 추적

/** 사이드바 메뉴 밖에서 들어가는 경로: 할 일(알림 아이콘, SCR-17~19) · 설정(톱니, SCR-21). */
export type ExtraRouteId = 'todo' | 'settings';

export type RouteId = MenuRouteId | ExtraRouteId;

export interface NavItem {
  id: MenuRouteId;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  id: 'plan' | 'design' | 'run';
  label: string;
  items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'plan',
    label: '기획',
    items: [
      { id: 'verification', label: '검증', icon: ShieldCheck },
      { id: 'requirements', label: '요구사항', icon: ListChecks },
      { id: 'rules', label: '규칙', icon: Scale },
      { id: 'contracts', label: '계약', icon: Signature },
      { id: 'traceability', label: '추적성 맵', icon: Waypoints },
    ],
  },
  {
    id: 'design',
    label: '설계',
    items: [
      { id: 'architecture', label: '아키텍처', icon: Boxes },
      { id: 'flow', label: '흐름도', icon: Workflow },
      { id: 'erd', label: 'ERD', icon: Database },
      { id: 'dependencies', label: '의존성', icon: Package },
      { id: 'changelog', label: '변경 로그', icon: GitCommitHorizontal },
      { id: 'adr', label: 'ADR', icon: NotebookPen },
    ],
  },
  {
    id: 'run',
    label: '실행',
    items: [{ id: 'runs', label: '실행 추적', icon: Activity }],
  },
];

const EXTRA_LABELS: Record<ExtraRouteId, string> = {
  todo: '할 일',
  settings: '설정',
};

/** 경로 → 화면 이름 (빈 상태 문구 · 접근 가능한 이름에 쓴다). */
export const ROUTE_LABELS: Readonly<Record<RouteId, string>> = {
  ...(Object.fromEntries(
    NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item.label])),
  ) as Record<MenuRouteId, string>),
  ...EXTRA_LABELS,
};
