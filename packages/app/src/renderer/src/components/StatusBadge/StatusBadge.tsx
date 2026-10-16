// 상태 배지 (screens.md 1.4): 판정 상태 5종 · 변이 상태 3종.
// 정상(통과 · 변이 검증됨 · 변이 미검증)은 글자 없이 흐린 점(접근 가능한 이름 = 상태 이름), 예외만 글자 + 색.
import './StatusBadge.css';

import { type BadgeStatus, type ExceptionTone, statusLabel, statusTone } from './status.js';

export type StatusBadgeProps = BadgeStatus;

export const StatusBadge = (props: StatusBadgeProps): React.JSX.Element => {
  const label = statusLabel(props);
  const tone = statusTone(props);
  if (tone === 'normal') {
    return (
      <span
        className="status-badge"
        data-testid="status-badge"
        data-kind={props.kind}
        data-status={props.status}
        data-tone="normal"
        role="img"
        aria-label={label}
        title={label}
      >
        <span className="status-dot" aria-hidden="true" />
      </span>
    );
  }
  return (
    <ExceptionLabel
      label={label}
      tone={tone}
      testId="status-badge"
      data={{ 'data-kind': props.kind, 'data-status': props.status }}
    />
  );
};

/** 예외 글자 + 색. 상태 배지와 카드 2줄째 예외가 같은 모양을 쓴다. */
export const ExceptionLabel = ({
  label,
  tone,
  testId = 'exception',
  data,
}: {
  label: string;
  tone: ExceptionTone;
  testId?: string;
  data?: Record<`data-${string}`, string>;
}): React.JSX.Element => (
  <span className="status-badge" data-testid={testId} data-tone={tone} {...data}>
    {label}
  </span>
);
