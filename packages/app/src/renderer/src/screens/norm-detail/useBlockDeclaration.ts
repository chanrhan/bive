// 지금 블록 선언의 이름 (RPC `blocks.get`, NFR-03: 선언에 있는지는 이 응답으로만 판단한다, ADR-126).
// - 상세가 열릴 때 한 번 읽고, 이 프로젝트의 블록 선언 알림(`event.blocks.changed`: 사람이 새 판을 저장함) · 재접속 때 다시
//   읽는다(열린 상세가 새 선언으로 "선언 외"를 판단한다, M3-42 #283 · ADR-135). 다시 읽는 동안은 지금 선언을 그대로 쓴다
// - `known`을 주면 읽지도 구독하지도 않고 그 값을 쓴다(요구사항 상세가 이미 읽은 선언을 펼친 자식 규칙에 넘긴다. 다시 읽기는
//   요구사항 상세가 한다)
// - 늦게 온 이전 요청의 응답은 요청 순번으로 버린다(새 선언을 옛 선언이 덮지 않는다, M3-35)
import { useCallback, useEffect, useRef, useState } from 'react';

import { BLOCK_EVENT_NAMES } from '../../runs/refreshCoalescer.js';
import { useEventRefresh } from '../../runs/useEventRefresh.js';
import { type BlockDeclarationLoad, declaredBlockNames } from '../rules/blockView.js';

const LOADING: BlockDeclarationLoad = { state: 'loading' };

export const useBlockDeclaration = (
  projectId: string,
  known?: BlockDeclarationLoad,
): BlockDeclarationLoad => {
  const skip = known !== undefined;
  const [loaded, setLoaded] = useState<{ projectId: string; load: BlockDeclarationLoad } | null>(
    null,
  );
  // 마지막 요청 번호. 응답이 왔을 때 번호가 다르면 더 새 요청이 있으므로 버린다
  const seq = useRef(0);

  const fetchDeclaration = useCallback((): Promise<void> => {
    seq.current += 1;
    const mine = seq.current;
    const settle = (load: BlockDeclarationLoad): void => {
      if (seq.current === mine) setLoaded({ projectId, load });
    };
    return window.bive.invoke('blocks.get', { projectId }).then(
      (result) => settle({ state: 'ready', names: declaredBlockNames(result) }),
      () => settle({ state: 'error' }),
    );
  }, [projectId]);

  useEffect(() => {
    if (skip) return undefined;
    void fetchDeclaration();
    return () => {
      // 프로젝트가 바뀌거나 사라진 뒤 도착한 응답은 버린다
      seq.current += 1;
    };
  }, [fetchDeclaration, skip]);

  useEventRefresh(skip ? null : projectId, BLOCK_EVENT_NAMES, fetchDeclaration);

  if (known !== undefined) return known;
  return loaded !== null && loaded.projectId === projectId ? loaded.load : LOADING;
};
