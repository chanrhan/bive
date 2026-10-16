// `proposal.*` · `approvalLog.list` 처리기 (NRM-04, TODO-01, NFR-01, M1-09, ADR-050).
// - 이 처리기는 토큰 인증된 파이프 연결에서만 불린다. 인증 전 연결의 요청은 파이프 서버가 -32020으로 거부한다
// - 승인 · 거절은 사람 주체만 받는다(에이전트 주체 -32020). 제안 등록은 RPC가 없다(`ProposalService.submit`)
// - 승인된 규칙 · 계약을 직접 고치는 RPC는 없다 (NRM-04: 변경은 지시 → 제안 → 승인)
import { createUlidGenerator, ErrorCode, ProposalKind } from '@bive/shared';

import {
  approveProposal,
  type DecisionContext,
  type ProposalClock,
  rejectProposal,
} from '../proposals/proposal-service.js';
import { withProjectStore } from './project-store-access.js';
import { RpcError, type MethodHandlers, type RequestContext } from './server.js';

export interface ProposalHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 시계 (ms). 처리 시각 · 읽은 시각 · ULID에 쓴다 */
  now: () => number;
}

type ProposalMethods = Pick<
  MethodHandlers,
  | 'proposal.list'
  | 'proposal.count'
  | 'proposal.get'
  | 'proposal.markRead'
  | 'proposal.approve'
  | 'proposal.amend'
  | 'proposal.reject'
  | 'approvalLog.list'
>;

/** 승인 기록의 `clientId`: 요청이 들어온 파이프 연결 번호 (기동마다 1부터, 증거용). */
const decisionContext = (context: RequestContext): DecisionContext => ({
  clientId: `pipe-${String(context.connectionId)}`,
});

export const createProposalHandlers = ({ biveHome, now }: ProposalHandlerDeps): ProposalMethods => {
  const clock: ProposalClock = { now, newId: createUlidGenerator(now) };

  return {
    'proposal.list': ({ projectId, state, kind }) =>
      withProjectStore(biveHome, projectId, (store) => ({
        proposals: store.proposals.list({ state, kind }),
      })),
    'proposal.count': ({ projectId }) =>
      withProjectStore(biveHome, projectId, (store) => {
        const { total, byKind } = store.proposals.countPending();
        const pendingByKind = Object.fromEntries(
          ProposalKind.options.map((kind) => [kind, byKind[kind] ?? 0]),
        ) as Record<ProposalKind, number>;
        return { pending: total, pendingByKind };
      }),
    'proposal.get': ({ projectId, id }) =>
      withProjectStore(biveHome, projectId, (store) => {
        const proposal = store.proposals.get(id);
        if (proposal === null) {
          throw new RpcError(ErrorCode.NotFound, `제안을 찾을 수 없습니다: ${id}`);
        }
        return { proposal };
      }),
    'proposal.markRead': ({ projectId, id }) =>
      withProjectStore(biveHome, projectId, (store) => ({
        proposal: store.proposals.markRead(id, new Date(now()).toISOString()),
      })),
    'proposal.approve': ({ projectId, id, author, edited }, context) =>
      withProjectStore(biveHome, projectId, (store) =>
        approveProposal(store, { id, author, edited }, decisionContext(context), clock),
      ),
    'proposal.amend': ({ projectId, id, author, edited }, context) =>
      withProjectStore(biveHome, projectId, (store) =>
        approveProposal(store, { id, author, edited }, decisionContext(context), clock),
      ),
    'proposal.reject': ({ projectId, id, author, reason }, context) =>
      withProjectStore(biveHome, projectId, (store) =>
        rejectProposal(store, { id, author, reason }, decisionContext(context), clock),
      ),
    'approvalLog.list': ({ projectId, targetRef }) =>
      withProjectStore(biveHome, projectId, (store) => {
        const { valid, brokenAtSeq, reason } = store.approvalLog.verify();
        return {
          entries: store.approvalLog.list(targetRef),
          chain: { valid, brokenAtSeq, reason },
        };
      }),
  };
};
