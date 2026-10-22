// 상태 배지의 표시 규칙 (screens.md 1.4 상태 배지, 기획서 3.4, ADR-048).
// - 정상 상태(통과 · 변이 검증됨 · 변이 미검증 · 승인)는 글자 없이 흐린 점, 예외만 글자 + 색
// - 제안 처리 결과(승인 · 거절)는 승인 대기 처리됨 필터에서 쓴다 (SCR-17, ADR-056)
// - renderer는 shared를 import type으로만 가져오므로(architecture.md 2장) 표시명은 여기에 다시 적고,
//   test/status-badge.test.ts가 shared의 *_LABELS와 같은지 대조한다
import type { JudgmentStatus, MutationStatus } from '@bive/shared';

/** 판정 상태 5종 표시명 (shared JUDGMENT_STATUS_LABELS와 같음). */
export const JUDGMENT_LABELS = {
  pass: '통과',
  fail: '실패',
  unjudged: '미판정',
  quarantined: '격리',
  needs_recheck: '재검증 필요',
} as const satisfies Record<JudgmentStatus, string>;

/** 변이 상태 3종 표시명 (shared MUTATION_STATUS_LABELS와 같음). */
export const MUTATION_LABELS = {
  verified: '변이 검증됨',
  unverified: '변이 미검증',
  survived: '변이 생존',
} as const satisfies Record<MutationStatus, string>;

/** 제안 처리 결과 2종 표시명 (shared PROPOSAL_STATE_LABELS의 같은 키와 같음). */
export const DECISION_LABELS = {
  approved: '승인',
  rejected: '거절',
} as const;

export type DecisionStatus = keyof typeof DECISION_LABELS;

/** 예외 표시 색. 토큰 danger · warning · accent에 대응한다 (StatusBadge.css). */
export type ExceptionTone = 'danger' | 'warning' | 'info';

/** 정상 = 흐린 점, 그 밖 = 예외 색. */
export type StatusTone = 'normal' | ExceptionTone;

const JUDGMENT_TONES = {
  pass: 'normal',
  fail: 'danger',
  unjudged: 'info',
  quarantined: 'warning',
  needs_recheck: 'warning',
} as const satisfies Record<JudgmentStatus, StatusTone>;

const MUTATION_TONES = {
  verified: 'normal',
  unverified: 'normal',
  survived: 'danger',
} as const satisfies Record<MutationStatus, StatusTone>;

/** 승인은 정상(1.4: 승인은 흐린 점), 거절은 예외 글자 (SCR-17 처리됨 필터). */
const DECISION_TONES = {
  approved: 'normal',
  rejected: 'info',
} as const satisfies Record<DecisionStatus, StatusTone>;

/** 상태 배지가 그리는 상태 하나. */
export type BadgeStatus =
  | { kind: 'judgment'; status: JudgmentStatus }
  | { kind: 'mutation'; status: MutationStatus }
  | { kind: 'decision'; status: DecisionStatus };

export const statusLabel = (badge: BadgeStatus): string => {
  switch (badge.kind) {
    case 'judgment':
      return JUDGMENT_LABELS[badge.status];
    case 'mutation':
      return MUTATION_LABELS[badge.status];
    case 'decision':
      return DECISION_LABELS[badge.status];
  }
};

export const statusTone = (badge: BadgeStatus): StatusTone => {
  switch (badge.kind) {
    case 'judgment':
      return JUDGMENT_TONES[badge.status];
    case 'mutation':
      return MUTATION_TONES[badge.status];
    case 'decision':
      return DECISION_TONES[badge.status];
  }
};

/** 카드 2줄째 예외 하나 (글자 + 색). 문제 항목 = 예외가 1개 이상인 항목 (ADR-034). */
export interface ExceptionMark {
  key: string;
  label: string;
  tone: ExceptionTone;
}

/**
 * 상태를 카드 2줄째 예외로 바꾼다. 정상 상태는 빈 배열이라 펼쳐 넣으면 된다:
 * `exceptions: [...statusExceptions({ kind: 'judgment', status: rule.judgment })]`
 */
export const statusExceptions = (badge: BadgeStatus): ExceptionMark[] => {
  const tone = statusTone(badge);
  return tone === 'normal'
    ? []
    : [{ key: `${badge.kind}:${badge.status}`, label: statusLabel(badge), tone }];
};
