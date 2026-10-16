// 승인 대기 목록 데이터: 현재 프로젝트의 `proposal.list` (전체 상태, 처리 상태는 목록 필터가 거른다).
// 조회 시점: 탭이 열릴 때 · refresh() (승인 · 거절 처리 뒤, #40). 폴링 · 이벤트 구독은 하지 않는다.
import type { Proposal } from '@bive/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

export type ProposalListState =
  { status: 'loading' } | { status: 'ready'; proposals: readonly Proposal[] } | { status: 'error' };

export interface ProposalListView {
  state: ProposalListState;
  /** 다시 조회한다. 끝나면 풀리고 거부하지 않는다 */
  refresh(): Promise<void>;
  /** 응답으로 받은 제안 1건으로 목록의 같은 ID 항목을 바꾼다 (읽음 표시 · 처리 결과) */
  replace(proposal: Proposal): void;
}

export const useProposalList = (projectId: string): ProposalListView => {
  const [state, setState] = useState<ProposalListState>({ status: 'loading' });
  const seq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    seq.current += 1;
    const mine = seq.current;
    try {
      const { proposals } = await window.bive.invoke('proposal.list', { projectId });
      if (seq.current === mine) setState({ status: 'ready', proposals });
    } catch {
      if (seq.current === mine) setState({ status: 'error' });
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    return () => {
      seq.current += 1;
    };
  }, [refresh]);

  const replace = useCallback((proposal: Proposal): void => {
    setState((prev) =>
      prev.status !== 'ready'
        ? prev
        : {
            status: 'ready',
            proposals: prev.proposals.map((p) => (p.id === proposal.id ? proposal : p)),
          },
    );
  }, []);

  return { state, refresh, replace };
};
