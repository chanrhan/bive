// 사이드바 하단 오케스트레이터 연결 상태 (screens.md 1.2, ADR-045).
// 처음 한 번 `system.status`를 직접 부르고, 이후는 main이 1초마다 보내는 `system.connection` 알림을 따른다.
import type { SystemStatusResult } from '@bive/shared';
import { useEffect, useState } from 'react';

import { CONNECTION_EVENT, type ConnectionEventParams } from '../../../common/bridge.js';

export type ConnectionView = 'checking' | 'connected' | 'disconnected';

export interface ConnectionInfo {
  view: ConnectionView;
  /** 마지막으로 받은 상태 (연결됨일 때만) */
  status: SystemStatusResult | null;
}

const isConnectionEvent = (value: unknown): value is ConnectionEventParams => {
  if (typeof value !== 'object' || value === null) return false;
  const { state, status } = value as { state?: unknown; status?: unknown };
  if (state === 'disconnected') return true;
  return state === 'connected' && typeof status === 'object' && status !== null;
};

export const useConnection = (): ConnectionInfo => {
  const [info, setInfo] = useState<ConnectionInfo>({ view: 'checking', status: null });

  useEffect(() => {
    let active = true;
    // 알림이 먼저 오면 그 값을 쓴다 (처음 조회 결과가 늦게 와도 덮지 않음)
    let heard = false;
    const off = window.bive.on(CONNECTION_EVENT, (params) => {
      if (!active || !isConnectionEvent(params)) return;
      heard = true;
      setInfo(
        params.state === 'connected'
          ? { view: 'connected', status: params.status }
          : { view: 'disconnected', status: null },
      );
    });
    window.bive.invoke('system.status').then(
      (status) => {
        if (active && !heard) setInfo({ view: 'connected', status });
      },
      () => {
        if (active && !heard) setInfo({ view: 'disconnected', status: null });
      },
    );
    return () => {
      active = false;
      off();
    };
  }, []);

  return info;
};
