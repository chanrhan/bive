// 앱 레이아웃 (screens.md 1.2): 왼쪽 사이드바 · 중앙 영역 · 오른쪽 채팅(고정).
import { useMemo } from 'react';

import { useConnection } from '../connection/useConnection.js';
import { ChatPanel } from './ChatPanel.js';
import { MainArea } from './MainArea.js';
import { Sidebar } from './Sidebar.js';
import { readToken, useMediaQuery } from './useMediaQuery.js';

export const AppLayout = (): React.JSX.Element => {
  const connection = useConnection();
  // 기준 폭은 토큰 하나(--bp-chat-collapse)에서 읽는다. 미디어 쿼리 안에서는 CSS 변수를 못 쓴다
  const breakpoint = useMemo(() => readToken('--bp-chat-collapse', '1100px'), []);
  const collapsed = useMediaQuery(`(width < ${breakpoint})`);

  return (
    <div
      className="app-layout"
      data-testid="app-layout"
      data-chat={collapsed ? 'collapsed' : 'docked'}
    >
      {/* 프로젝트 · 할 일 건수는 M1(프로젝트 열기 · 할 일)에서 연결한다. 지금은 근거 값이 없다 */}
      <Sidebar projectName={null} todoCount={null} connection={connection} />
      <MainArea />
      <ChatPanel collapsed={collapsed} />
    </div>
  );
};
