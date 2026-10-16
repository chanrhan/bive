// 빈 셸: 연결 상태 텍스트 자리만 둔다. 레이아웃 · 토큰 · 사이드바 연결 상태(system.status)는 #13.
import { useEffect, useState } from 'react';

type ConnectionView = 'checking' | 'connected' | 'disconnected';

/** 화면 문구 (screens.md 1.1: 명사형). */
const CONNECTION_TEXT: Record<ConnectionView, string> = {
  checking: '오케스트레이터 연결 확인 중',
  connected: '오케스트레이터 연결됨',
  disconnected: '오케스트레이터 연결 끊김',
};

export const App = (): React.JSX.Element => {
  const [connection, setConnection] = useState<ConnectionView>('checking');

  useEffect(() => {
    let active = true;
    window.bive.invoke('ping').then(
      () => {
        if (active) setConnection('connected');
      },
      () => {
        if (active) setConnection('disconnected');
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <main>
      <p role="status" data-testid="connection-status" data-state={connection}>
        {CONNECTION_TEXT[connection]}
      </p>
    </main>
  );
};
