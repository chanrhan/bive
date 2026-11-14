// 검증 요약 불러오기 (RPC `verification.summary`, ADR-072). 규칙 화면(useRules.ts)과 같은 규칙이다.
// - 프로젝트가 바뀌면 다시 불러오고, 그동안은 로딩이다(이전 프로젝트 값을 보이지 않음)
// - `reload()`는 지금 값을 그대로 두고 다시 부른다([재개] 뒤 파이프라인 갱신)
// - 실행 알림을 받으면 `reload()`와 같이 다시 부른다 (M1-19, ADR-076, useRunEventRefresh)
// - 늦게 온 이전 요청의 결과는 버린다(마지막으로 보낸 요청의 결과만 쓴다)
import type { VerificationSummaryResult } from '@bive/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useRunEventRefresh } from '../../runs/useRunEventRefresh.js';

export type VerificationLoad =
  | { state: 'loading' }
  | { state: 'ready'; summary: VerificationSummaryResult }
  | { state: 'error' };

const LOADING: VerificationLoad = { state: 'loading' };

export const useVerification = (
  projectId: string,
): { load: VerificationLoad; reload: () => void } => {
  const [loaded, setLoaded] = useState<{ projectId: string; load: VerificationLoad } | null>(null);
  // 마지막 요청 번호. 응답이 왔을 때 번호가 다르면 더 새 요청이 있으므로 버린다
  const seq = useRef(0);

  const fetchSummary = useCallback((): Promise<void> => {
    seq.current += 1;
    const mine = seq.current;
    return window.bive.invoke('verification.summary', { projectId }).then(
      (summary) => {
        if (seq.current === mine) setLoaded({ projectId, load: { state: 'ready', summary } });
      },
      () => {
        if (seq.current === mine) setLoaded({ projectId, load: { state: 'error' } });
      },
    );
  }, [projectId]);

  useEffect(() => {
    void fetchSummary();
    return () => {
      // 프로젝트가 바뀌거나 사라진 뒤 도착한 응답은 버린다
      seq.current += 1;
    };
  }, [fetchSummary]);

  useRunEventRefresh(projectId, fetchSummary);

  const reload = useCallback(() => {
    void fetchSummary();
  }, [fetchSummary]);
  const load = loaded !== null && loaded.projectId === projectId ? loaded.load : LOADING;
  return { load, reload };
};
