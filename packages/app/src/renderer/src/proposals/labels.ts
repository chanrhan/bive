// 제안 표시명 · 할 일 배지 계산 (screens.md 6장 할 일 · SCR-17, TODO-01, ADR-056).
// renderer는 shared를 import type으로만 가져오므로(architecture.md 2장) 표시명을 다시 적고,
// test/todo-proposals.test.ts가 shared의 *_LABELS와 같은지 대조한다.
import type {
  AgentRole,
  ProposalCountResult,
  ProposalKind,
  ProposalState,
  Risk,
} from '@bive/shared';

/** 제안 종류 8종 표시명 (shared PROPOSAL_KIND_LABELS와 같음). 순서가 툴팁 · 필터 메뉴 순서다. */
export const PROPOSAL_KIND_LABELS = {
  requirement_new: '요구사항 신규',
  requirement_change: '요구사항 변경',
  rule_new: '규칙 신규',
  rule_change: '규칙 변경',
  contract_new: '계약 신규',
  design_change: '설계 변경',
  rule_title_change: '규칙 제목 변경',
  contract_change: '계약 변경',
} as const satisfies Record<ProposalKind, string>;

/** 제안 상태 표시명 (shared PROPOSAL_STATE_LABELS와 같음). */
export const PROPOSAL_STATE_LABELS = {
  pending: '승인 대기',
  approved: '승인',
  rejected: '거절',
  provisional: '잠정 승인',
} as const satisfies Record<ProposalState, string>;

/** 에이전트 역할 표시명 (shared AGENT_ROLE_LABELS와 같음). 제안자 필터에 쓴다. */
export const AGENT_ROLE_LABELS = {
  'rule-writer': '규칙 작성',
  planner: '계획',
  'test-writer': '테스트 작성',
  implementer: '구현',
  chat: '채팅',
} as const satisfies Record<AgentRole, string>;

/** 위험도 표시명 (shared RISK_LABELS와 같음). */
export const RISK_LABELS = {
  low: '낮음',
  medium: '보통',
  high: '높음',
} as const satisfies Record<Risk, string>;

const KIND_ORDER = Object.keys(PROPOSAL_KIND_LABELS) as ProposalKind[];

/**
 * 사이드바 알림 배지 숫자. 화면 정의서는 승인 대기 + 검토 대기열 + 계약 변경 대기 합계이고,
 * M1에는 제안(승인 대기)만 있으므로 `proposal.count`의 대기 건수 그대로다. 검토 대기열은 M3에서 더한다.
 * 모르면(프로젝트 없음 · 조회 전 · 실패) null — 배지를 보이지 않는다.
 */
export const todoBadgeTotal = (count: ProposalCountResult | null): number | null =>
  count === null ? null : count.pending;

/**
 * 알림 아이콘 툴팁의 종류별 건수: "규칙 신규 2 · 요구사항 신규 1". 0건 종류는 뺀다.
 * 건수 많은 순, 같으면 종류 순서. 대기가 없으면 빈 문자열.
 */
export const todoBreakdown = (count: ProposalCountResult | null): string => {
  if (count === null) return '';
  return KIND_ORDER.map((kind) => ({ kind, n: count.pendingByKind[kind] ?? 0 }))
    .filter(({ n }) => n > 0)
    .sort((a, b) => b.n - a.n || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    .map(({ kind, n }) => `${PROPOSAL_KIND_LABELS[kind]} ${n}`)
    .join(' · ');
};
