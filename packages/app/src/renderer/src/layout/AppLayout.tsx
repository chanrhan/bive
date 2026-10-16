// 앱 레이아웃 (screens.md 1.2): 왼쪽 사이드바 · 중앙 영역 · 오른쪽 채팅(고정).
import { useMemo } from 'react';

import { useConnection } from '../connection/useConnection.js';
import { useProject } from '../project/ProjectContext.js';
import { todoBadgeTotal, todoBreakdown } from '../proposals/labels.js';
import { ProposalCountProvider, useProposalCount } from '../proposals/ProposalCountContext.js';
import { ChatPanel } from './ChatPanel.js';
import { MainArea } from './MainArea.js';
import { Sidebar } from './Sidebar.js';
import { readToken, useMediaQuery } from './useMediaQuery.js';

export const AppLayout = (): React.JSX.Element => (
  <ProposalCountProvider>
    <LayoutBody />
  </ProposalCountProvider>
);

const LayoutBody = (): React.JSX.Element => {
  const connection = useConnection();
  const { project } = useProject();
  const { count } = useProposalCount();
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
        todoCount={todoBadgeTotal(count)}
        todoBreakdown={todoBreakdown(count)}
        connection={connection}
      />
      <MainArea />
      <ChatPanel collapsed={collapsed} />
    </div>
  );
};
