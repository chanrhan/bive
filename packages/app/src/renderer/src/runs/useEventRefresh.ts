// 알림 · 재접속을 받으면 화면 값을 다시 조회한다 (M1-19 · M1-36, ADR-076).
// - `eventNames`의 알림 중 이 프로젝트(`projectId`)의 것만 받는다. 다른 프로젝트 알림으로는 조회하지 않는다
// - 오케스트레이터에 다시 붙으면(끊김 → 연결됨) 한 번 다시 조회한다. 끊긴 동안 온 알림은 잃기 때문이다
// - 알림 값으로 화면을 그리지 않고 조회 결과만 쓴다(NFR-03). 연속 요청은 refreshCoalescer 규칙으로 합친다
//   (동시 조회 1개 · 뒤따르는 조회 최대 1개)
// - 프로젝트가 없으면(null) 구독하지 않는다. 화면을 떠나면(언마운트) 구독을 끊는다
import { useEffect, useRef } from 'react';

import { CONNECTION_EVENT } from '../../../common/bridge.js';
import { createReconnectDetector } from '../connection/reconnect.js';
import { createRefreshCoalescer, isProjectEvent } from './refreshCoalescer.js';

/** 재접속(끊김 → 연결됨)마다 `listener`를 부른다. 해제 함수를 돌려준다. */
const onReconnect = (listener: () => void): (() => void) => {
  const detect = createReconnectDetector();
  return window.bive.on(CONNECTION_EVENT, (params) => {
    if (detect(params)) listener();
  });
};

export const useEventRefresh = (
  projectId: string | null,
  eventNames: readonly string[],
  refresh: () => Promise<unknown>,
): void => {
  // 구독을 다시 걸지 않고 최신 조회 함수를 부른다
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  // 이름 목록은 호출부의 상수라 내용으로 비교한다(배열이 다시 만들어져도 구독을 다시 걸지 않음)
  const names = eventNames.join('\n');

  useEffect(() => {
    if (projectId === null) return undefined;
    const coalescer = createRefreshCoalescer(() => refreshRef.current());
    const unsubscribes = [
      ...names.split('\n').map((name) =>
        window.bive.on(name, (params) => {
          if (isProjectEvent(params, projectId)) coalescer.request();
        }),
      ),
      onReconnect(() => coalescer.request()),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      coalescer.dispose();
    };
  }, [projectId, names]);
};
