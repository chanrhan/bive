// 지금 블록 선언의 이름 (RPC `blocks.get`, NFR-03: 선언에 있는지는 이 응답으로만 판단한다, ADR-126).
// - 상세가 열릴 때 한 번 읽는다. 선언은 사람만 CLI로 바꾸고 바뀜 알림이 없어 열린 동안은 다시 읽지 않는다(다시 고르면 다시 읽음)
// - `known`을 주면 읽지 않고 그 값을 쓴다(요구사항 상세가 이미 읽은 선언을 펼친 자식 규칙에 넘긴다)
// - 늦게 온 이전 응답은 버린다
import { useEffect, useState } from 'react';

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

  useEffect(() => {
    if (skip) return;
    let live = true;
    window.bive.invoke('blocks.get', { projectId }).then(
      (result) => {
        if (live) {
          setLoaded({ projectId, load: { state: 'ready', names: declaredBlockNames(result) } });
        }
      },
      () => {
        if (live) setLoaded({ projectId, load: { state: 'error' } });
      },
    );
    return () => {
      live = false;
    };
  }, [projectId, skip]);

  if (known !== undefined) return known;
  return loaded !== null && loaded.projectId === projectId ? loaded.load : LOADING;
};
