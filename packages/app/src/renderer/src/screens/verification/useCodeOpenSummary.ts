// 코드 열람 사유 분포 불러오기 (RPC `codeOpen.summary`, M2-02 · ADR-088). 검증 요약(useVerification)과 따로 부른다:
// 이 영역의 조회가 실패해도 검증 화면의 다른 영역은 그대로 보인다.
// - 화면에 들어올 때(마운트) 부른다. 열람 기록은 다른 화면의 코드 링크에서만 생기므로 검증 화면에 다시 들어오면 반영된다
// - 오케스트레이터에 다시 붙거나(끊긴 동안의 실패를 되살림) 실행 알림을 받으면 검증 요약과 함께 다시 부른다. 구독은
//   검증 요약의 것 하나를 같이 쓴다(useVerification의 `alsoRefresh`, ADR-076): 화면당 구독 1개
// - 프로젝트가 바뀌면 로딩부터 다시 하고, 늦게 온 이전 요청의 결과는 버린다
import type { CodeOpenSummaryResult } from '@bive/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

export type CodeOpenSummaryLoad =
  { state: 'loading' } | { state: 'ready'; summary: CodeOpenSummaryResult } | { state: 'error' };

const LOADING: CodeOpenSummaryLoad = { state: 'loading' };

export const useCodeOpenSummary = (
  projectId: string,
): { load: CodeOpenSummaryLoad; refresh: () => Promise<void> } => {
  const [loaded, setLoaded] = useState<{ projectId: string; load: CodeOpenSummaryLoad } | null>(
    null,
  );
  // 마지막 요청 번호. 응답이 왔을 때 번호가 다르면 더 새 요청이 있으므로 버린다
  const seq = useRef(0);

  const fetchSummary = useCallback((): Promise<void> => {
    seq.current += 1;
    const mine = seq.current;
    return window.bive.invoke('codeOpen.summary', { projectId }).then(
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
      seq.current += 1;
    };
  }, [fetchSummary]);

  const load = loaded !== null && loaded.projectId === projectId ? loaded.load : LOADING;
  return { load, refresh: fetchSummary };
};
