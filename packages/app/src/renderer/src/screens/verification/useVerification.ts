// 검증 요약 불러오기 (RPC `verification.summary`, ADR-072). 규칙 화면(useRules.ts)과 같은 규칙이다.
// - 프로젝트가 바뀌면 다시 불러오고, 그동안은 로딩이다(이전 프로젝트 값을 보이지 않음)
// - `reload()`는 지금 값을 그대로 두고 다시 부른다([재개] 뒤 파이프라인 갱신)
// - 늦게 온 이전 요청의 결과는 버린다
import type { VerificationSummaryResult } from '@bive/shared';
import { useCallback, useEffect, useState } from 'react';

export type VerificationLoad =
  | { state: 'loading' }
  | { state: 'ready'; summary: VerificationSummaryResult }
  | { state: 'error' };

const LOADING: VerificationLoad = { state: 'loading' };

export const useVerification = (
  projectId: string,
): { load: VerificationLoad; reload: () => void } => {
  const [loaded, setLoaded] = useState<{ projectId: string; load: VerificationLoad } | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    window.bive.invoke('verification.summary', { projectId }).then(
      (summary) => {
        if (active) setLoaded({ projectId, load: { state: 'ready', summary } });
      },
      () => {
        if (active) setLoaded({ projectId, load: { state: 'error' } });
      },
    );
    return () => {
      active = false;
    };
  }, [projectId, generation]);

  const reload = useCallback(() => setGeneration((n) => n + 1), []);
  const load = loaded !== null && loaded.projectId === projectId ? loaded.load : LOADING;
  return { load, reload };
};
