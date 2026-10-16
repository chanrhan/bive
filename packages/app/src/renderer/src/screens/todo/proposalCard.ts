// 승인 대기 카드 · 필터 (screens.md SCR-17 카드 · 필터, ADR-056). DOM · React에 의존하지 않는다
// (test/todo-proposals.test.ts).
// - 1줄: 종류 태그 + 제목(제안 본문 요약: 규칙은 제목, 요구사항은 문장)
// - 2줄: 표시 ID · 예외(위험 높음 · 구현 중 제안 / 처리된 제안은 승인 · 거절) · 시각 · 안 읽음 점
import type { AgentRole, Proposal, ProposalKind, Risk } from '@bive/shared';

import type { CardData } from '../../components/Card2Line/card.js';
import type { FilterCriterion } from '../../components/ListView/filter.js';
import type { BadgeStatus, ExceptionMark } from '../../components/StatusBadge/status.js';
import {
  AGENT_ROLE_LABELS,
  PROPOSAL_KIND_LABELS,
  PROPOSAL_STATE_LABELS,
  RISK_LABELS,
} from '../../proposals/labels.js';

/** 승인 대기 탭에 보이는 종류. 기존 계약 변경은 계약 변경 승인 탭(M3) 몫이라 뺀다 (SCR-17 대상). */
export const APPROVAL_KINDS = [
  'requirement_new',
  'requirement_change',
  'rule_new',
  'rule_change',
  'contract_new',
  'design_change',
  'rule_title_change',
] as const satisfies readonly ProposalKind[];

export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

const APPROVAL_KIND_SET: ReadonlySet<string> = new Set(APPROVAL_KINDS);

export const isApprovalProposal = (proposal: Proposal): boolean =>
  APPROVAL_KIND_SET.has(proposal.kind);

/**
 * 1줄 종류 태그 (SCR-17: 신규 · 변경 · 요구사항 · 요구사항 변경 · 설계 · 제목).
 * 규칙 신규 · 계약 신규는 둘 다 '신규'다 (종류 필터는 전체 이름으로 구분, ADR-056).
 */
export const KIND_TAGS = {
  rule_new: '신규',
  contract_new: '신규',
  rule_change: '변경',
  requirement_new: '요구사항',
  requirement_change: '요구사항 변경',
  design_change: '설계',
  rule_title_change: '제목',
} as const satisfies Record<ApprovalKind, string>;

/** 종류 태그. 승인 대기 탭 밖 종류(계약 변경)는 전체 종류 이름. */
export const kindTag = (kind: ProposalKind): string =>
  kind === 'contract_change' ? PROPOSAL_KIND_LABELS[kind] : KIND_TAGS[kind];

const stringField = (payload: unknown, key: string): string | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
};

/**
 * 카드 제목 = 제안 본문 요약. 요구사항 종류는 문장(`text`), 그 밖은 제목(`title`)을 먼저 보고,
 * 본문에 둘 다 없으면(본문 스키마가 아직 없는 종류) 근거 문장으로 대신한다.
 */
export const proposalTitle = (proposal: Proposal): string => {
  const order = proposal.kind.startsWith('requirement_') ? ['text', 'title'] : ['title', 'text'];
  for (const key of order) {
    const value = stringField(proposal.payload, key);
    if (value !== null) return value;
  }
  return proposal.rationale;
};

const RISK_HIGH: ExceptionMark = { key: 'risk-high', label: '위험 높음', tone: 'danger' };
const DURING_IMPLEMENTATION: ExceptionMark = {
  key: 'during-implementation',
  label: '구현 중 제안',
  tone: 'warning',
};

/** 처리된 제안의 처리 결과 (승인은 흐린 점, 거절은 예외 글자). 대기 · 잠정은 없음. */
const decisionStatuses = (proposal: Proposal): BadgeStatus[] =>
  proposal.state === 'approved' || proposal.state === 'rejected'
    ? [{ kind: 'decision', status: proposal.state }]
    : [];

export const proposalExceptions = (proposal: Proposal): ExceptionMark[] => [
  ...(proposal.risk === 'high' ? [RISK_HIGH] : []),
  ...(proposal.source === 'implementation' ? [DURING_IMPLEMENTATION] : []),
];

export const proposalCard = (proposal: Proposal): CardData => ({
  title: proposalTitle(proposal),
  id: proposal.displayId,
  tag: kindTag(proposal.kind),
  statuses: decisionStatuses(proposal),
  exceptions: proposalExceptions(proposal),
  dateTime: proposal.createdAt,
  unread: proposal.readAt === null,
});

/** 처리 상태 필터의 값 (대기 · 승인 · 거절). 기본은 '대기'. */
export const STATE_OPTIONS = [
  { value: 'pending', label: '대기' },
  { value: 'approved', label: PROPOSAL_STATE_LABELS.approved },
  { value: 'rejected', label: PROPOSAL_STATE_LABELS.rejected },
] as const;

/** 필터 기준 4종 (SCR-17: 처리 상태 · 종류 · 위험도 · 제안자). 위험도는 값이 생기기 전까지 0건 비활성. */
export const APPROVAL_CRITERIA: readonly FilterCriterion<Proposal>[] = [
  {
    id: 'state',
    label: '처리 상태',
    options: STATE_OPTIONS,
    values: (p) => [p.state],
  },
  {
    id: 'kind',
    label: '종류',
    options: APPROVAL_KINDS.map((kind) => ({ value: kind, label: PROPOSAL_KIND_LABELS[kind] })),
    values: (p) => [p.kind],
  },
  {
    id: 'risk',
    label: '위험도',
    options: (Object.keys(RISK_LABELS) as Risk[]).map((risk) => ({
      value: risk,
      label: RISK_LABELS[risk],
    })),
    values: (p) => (p.risk === null ? [] : [p.risk]),
  },
  {
    id: 'author',
    label: '제안자',
    options: (Object.keys(AGENT_ROLE_LABELS) as AgentRole[]).map((role) => ({
      value: role,
      label: AGENT_ROLE_LABELS[role],
    })),
    values: (p) => [p.author.role],
  },
];
