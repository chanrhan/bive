// 승인 대기 상세가 제안 밖에서 더 읽는 값 (SCR-17 상세, NFR-03: 값은 RPC 결과에서만).
// - 부모 요구사항: 규칙 제안의 대상(`targetRef`가 요구사항)이면 `requirement.get` 1회 → 표시 ID · 문장
// - 처리 기록: 처리된 제안이면 `approvalLog.list {targetRef: 제안}` 1회 → 그 제안의 승인 · 거절 기록 + 체인 검증 결과
// 제안(ID · 상태)이 바뀌면 다시 읽고, 늦게 온 이전 응답은 버린다. 실패하면 값을 보이지 않는다.
import type { ApprovalLogEntry, Proposal, Requirement } from '@bive/shared';
import { useEffect, useState } from 'react';

import { decisionEntry } from './proposalDetailView.js';

/** 규칙 제안의 부모 요구사항. 요구사항 대상이 아니거나 조회 전 · 실패면 null. */
export const useParentRequirement = (
  projectId: string,
  proposal: Proposal | null,
): Requirement | null => {
  const [loaded, setLoaded] = useState<Requirement | null>(null);
  const targetId =
    proposal !== null && proposal.targetRef?.entity === 'Requirement'
      ? proposal.targetRef.id
      : null;

  useEffect(() => {
    if (targetId === null) return undefined;
    let live = true;
    window.bive.invoke('requirement.get', { projectId, id: targetId }).then(
      ({ requirement }) => {
        if (live) setLoaded(requirement);
      },
      () => {
        // 실패하면 부모 줄을 보이지 않는다
      },
    );
    return () => {
      live = false;
    };
  }, [projectId, targetId]);

  return loaded !== null && loaded.id === targetId ? loaded : null;
};

export type DecisionRecordState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; entry: ApprovalLogEntry | null; chainValid: boolean };

/** 처리된 제안의 처리 기록 (승인 기록). 대기 제안이면 `none`. */
export const useDecisionRecord = (
  projectId: string,
  proposal: Proposal | null,
): DecisionRecordState => {
  const processed = proposal !== null && proposal.state !== 'pending' ? proposal.id : null;
  const [loaded, setLoaded] = useState<{ id: string; state: DecisionRecordState } | null>(null);

  useEffect(() => {
    if (processed === null) return undefined;
    let live = true;
    window.bive
      .invoke('approvalLog.list', {
        projectId,
        targetRef: { entity: 'Proposal', id: processed },
      })
      .then(
        ({ entries, chain }) => {
          if (!live) return;
          setLoaded({
            id: processed,
            state: {
              status: 'ready',
              entry: decisionEntry(entries, processed),
              chainValid: chain.valid,
            },
          });
        },
        () => {
          if (live) setLoaded({ id: processed, state: { status: 'error' } });
        },
      );
    return () => {
      live = false;
    };
  }, [projectId, processed]);

  if (processed === null) return { status: 'none' };
  return loaded !== null && loaded.id === processed ? loaded.state : { status: 'loading' };
};
