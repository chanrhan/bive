// 앱 레이아웃 (screens.md 1.2): 왼쪽 사이드바 · 중앙 영역 · 오른쪽 채팅(고정).
import { useMemo } from 'react';

import { TooltipHost } from '../components/Tooltip/TooltipHost.js';
import { useConnection } from '../connection/useConnection.js';
import { useProject } from '../project/ProjectContext.js';
import { todoBadgeTotal, todoBreakdown } from '../screens/todo/confirmationView.js';
import { TodoListProvider, useTodoList } from '../todo/TodoListContext.js';
import { ChatPanel } from './ChatPanel.js';
import { MainArea } from './MainArea.js';
import { Sidebar } from './Sidebar.js';
import { readToken, useMediaQuery } from './useMediaQuery.js';

export const AppLayout = (): React.JSX.Element => (
  <TodoListProvider>
    <LayoutBody />
  </TodoListProvider>
);

const LayoutBody = (): React.JSX.Element => {
  const connection = useConnection();
  const { project } = useProject();
  // 할 일 배지 · 툴팁 = 확인할 것 + 검토 대기열의 열린 항목 (ADR-100 A7 · "할 일 공통", ADR-119 · ADR-157)
  const { load, review: reviewLoad } = useTodoList();
  const todo = load.status === 'ready' ? load.result : null;
  const review = reviewLoad.status === 'ready' ? reviewLoad.result : null;
  // 기준 폭은 토큰 하나(--bp-chat-collapse)에서 읽는다. 미디어 쿼리 안에서는 CSS 변수를 못 쓴다
  const breakpoint = useMemo(() => readToken('--bp-chat-collapse', '1100px'), []);
  const collapsed = useMediaQuery(`(width < ${breakpoint})`);

  return (
    <div
      className="app-layout"
      data-testid="app-layout"
      data-chat={collapsed ? 'collapsed' : 'docked'}
    >
      <Sidebar
        projectName={project?.name ?? null}
        todoCount={todoBadgeTotal(todo, review)}
        todoBreakdown={todoBreakdown(todo, review)}
        connection={connection}
      />
      <MainArea />
      <ChatPanel collapsed={collapsed} />
      {/* 공통 툴팁은 앱에 하나 (열린 것만 그린다, ADR-124) */}
      <TooltipHost />
    </div>
  );
};
