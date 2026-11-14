// 실행 알림(`event.run.updated` · `event.step.updated`)을 받으면 화면 값을 다시 조회한다 (M1-19, ADR-076).
// 규칙(SCR-03) · 검증(SCR-05) 화면이 쓴다. 알림 값으로 화면을 그리지 않고 조회 결과만 쓴다(NFR-03).
// 이 프로젝트의 알림만 받고, 연속 알림은 refreshCoalescer 규칙으로 합친다.
import { useEffect, useRef } from 'react';

import { createRefreshCoalescer, isProjectEvent, RUN_EVENT_NAMES } from './refreshCoalescer.js';

export const useRunEventRefresh = (projectId: string, refresh: () => Promise<unknown>): void => {
  // 구독을 다시 걸지 않고 최신 조회 함수를 부른다
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const coalescer = createRefreshCoalescer(() => refreshRef.current());
    const unsubscribes = RUN_EVENT_NAMES.map((name) =>
      window.bive.on(name, (params) => {
        if (isProjectEvent(params, projectId)) coalescer.request();
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      coalescer.dispose();
    };
  }, [projectId]);
};
