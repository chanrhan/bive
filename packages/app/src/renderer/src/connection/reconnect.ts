// 오케스트레이터 재접속 감지 (ADR-045 · ADR-076, M1-36).
// main이 1초마다 보내는 `system.connection` 알림에서 "끊김 → 연결됨" 전이만 골라 알린다. 끊긴 동안 온 알림은 잃으므로
// 열려 있는 화면 · 할 일 배지는 이 전이 때 한 번 다시 조회해 회복한다.
// - 구독마다 직전 상태를 따로 기억한다. 구독 뒤 처음 받은 값은 전이가 아니다(앱 시작 · 화면 진입의 처음 연결됨에서
//   다시 조회하지 않음: 처음 불러오기와 겹치지 않게)
// - 형식이 틀린 알림은 무시한다(사이드바 연결 상태 표시와 같은 판단)
// DOM에 의존하지 않는다(test/refresh-coalescer.test.ts). 구독은 runs/useEventRefresh.ts가 한다.
import type { ConnectionEventParams } from '../../../common/bridge.js';

export const isConnectionEvent = (value: unknown): value is ConnectionEventParams => {
  if (typeof value !== 'object' || value === null) return false;
  const { state, status } = value as { state?: unknown; status?: unknown };
  if (state === 'disconnected') return true;
  return state === 'connected' && typeof status === 'object' && status !== null;
};

/** 연결 상태 값을 차례로 받아 "끊김 → 연결됨" 전이인지 돌려준다. DOM에 의존하지 않는다. */
export const createReconnectDetector = (): ((value: unknown) => boolean) => {
  let last: ConnectionEventParams['state'] | null = null;
  return (value) => {
    if (!isConnectionEvent(value)) return false;
    const reconnected = last === 'disconnected' && value.state === 'connected';
    last = value.state;
    return reconnected;
  };
};
