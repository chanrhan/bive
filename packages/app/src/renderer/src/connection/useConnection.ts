// 사이드바 하단 오케스트레이터 연결 상태 (screens.md 1.2, ADR-045).
// 처음 한 번 `system.status`를 직접 부르고, 이후는 main이 1초마다 보내는 `system.connection` 알림을 따른다.
// 상태(연결됨 · 끊김)가 바뀔 때만 다시 그린다 (매초 알림마다 레이아웃 전체를 다시 그리지 않음).
import { useEffect, useState } from 'react';

import { CONNECTION_EVENT, type ConnectionEventParams } from '../../../common/bridge.js';

export type ConnectionView = 'checking' | 'connected' | 'disconnected';

const isConnectionEvent = (value: unknown): value is ConnectionEventParams => {
  if (typeof value !== 'object' || value === null) return false;
  const { state, status } = value as { state?: unknown; status?: unknown };
  if (state === 'disconnected') return true;
  return state === 'connected' && typeof status === 'object' && status !== null;
};

export const useConnection = (): ConnectionView => {
  // 같은 값이면 React가 다시 그리지 않는다
  const [view, setView] = useState<ConnectionView>('checking');

  useEffect(() => {
    let active = true;
    // 알림이 먼저 오면 그 값을 쓴다 (처음 조회 결과가 늦게 와도 덮지 않음)
    let heard = false;
    const off = window.bive.on(CONNECTION_EVENT, (params) => {
      if (!active || !isConnectionEvent(params)) return;
      heard = true;
      setView(params.state);
    });
    window.bive.invoke('system.status').then(
      () => {
        if (active && !heard) setView('connected');
      },
      () => {
        if (active && !heard) setView('disconnected');
      },
    );
    return () => {
      active = false;
      off();
    };
  }, []);

  return view;
};
