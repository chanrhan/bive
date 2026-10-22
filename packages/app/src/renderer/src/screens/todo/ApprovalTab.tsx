// [승인 대기] 탭 (SCR-17, TODO-01): 왼쪽 목록(ListView) + 오른쪽 상세 자리.
// - 목록 = 현재 프로젝트의 제안 중 승인 대기 탭 종류(기존 계약 변경 제외). 처리 상태 필터 기본값 '대기'
// - 카드를 고르면 안 읽은 제안만 `proposal.markRead`를 1회 부르고 응답으로 안 읽음 점을 지운다
// - 머리줄 "대기 n / 상한 40"(#58 M3-13)은 아직 미노출 (ADR-035)
import type { Proposal } from '@bive/shared';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  EMPTY_FILTER,
  getListFilter,
  ListView,
  setListFilter,
} from '../../components/ListView/index.js';
import { EmptyState } from '../../layout/EmptyState.js';
import { APPROVAL_CRITERIA, isApprovalProposal, proposalCard } from './proposalCard.js';
import { ProposalDetail } from './ProposalDetail.js';
import { useProposalList } from './useProposalList.js';

/** 목록 ID (필터 상태 저장소 키, ADR-048). */
export const APPROVAL_LIST_ID = 'todo-approval';

/** 빈 상태 (ADR-029: 대기 항목 없음). */
export const APPROVAL_EMPTY_TEXT = '대기 항목 없음';

const proposalKey = (proposal: Proposal): string => proposal.id;

export const ApprovalTab = ({ projectId }: { projectId: string }): React.JSX.Element => {
  const { state, replace } = useProposalList(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 읽음 요청을 보냈거나 끝난 제안 ID. 같은 제안을 다시 골라도 다시 부르지 않는다
  const readRequested = useRef(new Set<string>());

  // 처리 상태 필터 기본값 '대기': 이 목록의 필터가 비어 있을 때(처음 · 초기화 뒤 다시 들어옴)만 채운다
  useLayoutEffect(() => {
    if (getListFilter(APPROVAL_LIST_ID) === EMPTY_FILTER) {
      setListFilter(APPROVAL_LIST_ID, { ...EMPTY_FILTER, selected: { state: ['pending'] } });
    }
  }, []);

  const items = useMemo(
    () => (state.status === 'ready' ? state.proposals.filter(isApprovalProposal) : []),
    [state],
  );
  const selected = useMemo(
    () => items.find((proposal) => proposal.id === selectedId) ?? null,
    [items, selectedId],
  );

  const onSelect = useCallback(
    (proposal: Proposal): void => {
      setSelectedId(proposal.id);
      if (proposal.readAt !== null || readRequested.current.has(proposal.id)) return;
      readRequested.current.add(proposal.id);
      window.bive.invoke('proposal.markRead', { projectId, id: proposal.id }).then(
        ({ proposal: updated }) => replace(updated),
        () => {
          // 실패하면 점을 그대로 두고 다음 선택 때 다시 부른다
          readRequested.current.delete(proposal.id);
        },
      );
    },
    [projectId, replace],
  );

  return (
    <div className="todo-body" data-testid="todo-approval" data-state={state.status}>
      <div className="todo-list-pane">
        {state.status === 'ready' && (
          <ListView
            listId={APPROVAL_LIST_ID}
            label="승인 대기 목록"
            items={items}
            itemKey={proposalKey}
            card={proposalCard}
            criteria={APPROVAL_CRITERIA}
            emptyText={APPROVAL_EMPTY_TEXT}
            selectedKey={selectedId}
            onSelect={onSelect}
          />
        )}
        {state.status === 'error' && <EmptyState text="목록 불러오기 실패" />}
      </div>
      <ProposalDetail proposal={selected} />
    </div>
  );
};
