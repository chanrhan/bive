// 생성 주체 표시 (screens.md 1.4 생성 주체, ADR-008): 사람 · 에이전트.
// 목록은 아이콘만(접근 가능한 이름 · 툴팁 = 주체 이름), 상세는 `showLabel`로 이름을 함께 보인다.
import './AuthorMark.css';

import type { AuthorKind } from '@bive/shared';
import { Bot, UserRound } from 'lucide-react';

import { AUTHOR_LABELS } from './labels.js';

export interface AuthorMarkProps {
  kind: AuthorKind;
  /** 상세 화면: 아이콘 옆에 이름을 보인다 */
  showLabel?: boolean;
  /** 보일 이름 (기본: 주체 이름). 상세의 에이전트 역할명 등 */
  name?: string;
}

export const AuthorMark = ({
  kind,
  showLabel = false,
  name,
}: AuthorMarkProps): React.JSX.Element => {
  const label = name ?? AUTHOR_LABELS[kind];
  const Icon = kind === 'agent' ? Bot : UserRound;
  if (showLabel) {
    return (
      <span className="author-mark" data-testid="author-mark" data-author={kind}>
        <Icon className="inline-icon" aria-hidden="true" />
        <span>{label}</span>
      </span>
    );
  }
  return (
    <span
      className="author-mark"
      data-testid="author-mark"
      data-author={kind}
      role="img"
      aria-label={label}
      title={label}
    >
      <Icon className="inline-icon" aria-hidden="true" />
    </span>
  );
};
