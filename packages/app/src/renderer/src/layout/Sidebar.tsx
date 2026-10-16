// 사이드바 (screens.md 1.2): 상단 프로젝트명 · 할 일 알림 아이콘(배지) / 기획 · 설계 · 실행 메뉴 /
// 하단 오케스트레이터 연결 상태 · 설정 아이콘.
import { Bell, Circle, Settings } from 'lucide-react';

import type { ConnectionView } from '../connection/useConnection.js';
import { useNavigation } from '../navigation/NavigationContext.js';
import { NAV_GROUPS } from '../navigation/routes.js';

/** 연결 상태 문구 (1.2 · 1.1 명사형). */
export const CONNECTION_TEXT: Readonly<Record<ConnectionView, string>> = {
  checking: '연결 확인 중',
  connected: '연결됨',
  disconnected: '연결 끊김',
};

export interface SidebarProps {
  /** 열린 프로젝트 이름. 없으면 null ("프로젝트 없음") */
  projectName: string | null;
  /** 할 일 배지 건수. 모르거나 0이면 배지를 보이지 않는다 (NFR-03: 근거 없는 값 미표시) */
  todoCount: number | null;
  /** 알림 아이콘 툴팁의 종류별 건수 ("규칙 신규 2 · 요구사항 신규 1"). 비면 툴팁은 "할 일" */
  todoBreakdown?: string;
  connection: ConnectionView;
}

export const Sidebar = ({
  projectName,
  todoCount,
  todoBreakdown = '',
  connection,
}: SidebarProps): React.JSX.Element => {
  const { route, navigate } = useNavigation();
  const showBadge = todoCount !== null && todoCount > 0;
  return (
    <aside className="sidebar" data-testid="sidebar" aria-label="사이드바">
      <header className="sidebar-top">
        <span
          className="sidebar-project"
          data-testid="sidebar-project"
          data-state={projectName === null ? 'none' : 'open'}
          title={projectName ?? undefined}
        >
          {projectName ?? '프로젝트 없음'}
        </span>
        <button
          type="button"
          className="icon-button"
          data-testid="todo-button"
          aria-label="할 일"
          // 툴팁: 대기가 있으면 종류별 건수, 없으면 이름 (screens.md 6장 할 일)
          title={showBadge && todoBreakdown !== '' ? todoBreakdown : '할 일'}
          aria-pressed={route === 'todo'}
          onClick={() => navigate('todo')}
        >
          <Bell className="button-icon" aria-hidden="true" />
          {showBadge && (
            <span className="todo-badge" data-testid="todo-badge">
              {todoCount}
            </span>
          )}
        </button>
      </header>

      <nav className="sidebar-nav" aria-label="메뉴">
        {NAV_GROUPS.map((group) => (
          <section
            key={group.id}
            className="nav-group"
            data-testid={`nav-group-${group.id}`}
            aria-labelledby={`nav-group-${group.id}-label`}
          >
            <h2 className="nav-group-label" id={`nav-group-${group.id}-label`}>
              {group.label}
            </h2>
            <ul className="nav-list">
              {group.items.map(({ id, label, icon: Icon }) => (
                <li key={id}>
                  <button
                    type="button"
                    className="nav-item"
                    data-testid={`nav-${id}`}
                    aria-current={route === id ? 'page' : undefined}
                    onClick={() => navigate(id)}
                  >
                    <Icon className="inline-icon" aria-hidden="true" />
                    <span>{label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>

      <footer className="sidebar-bottom">
        <p
          className="connection-status"
          role="status"
          data-testid="connection-status"
          data-state={connection}
          title="오케스트레이터"
        >
          <Circle className="inline-icon connection-dot" aria-hidden="true" />
          <span>{CONNECTION_TEXT[connection]}</span>
        </p>
        <button
          type="button"
          className="icon-button"
          data-testid="settings-button"
          aria-label="설정"
          title="설정"
          aria-pressed={route === 'settings'}
          onClick={() => navigate('settings')}
        >
          <Settings className="button-icon" aria-hidden="true" />
        </button>
      </footer>
    </aside>
  );
};
