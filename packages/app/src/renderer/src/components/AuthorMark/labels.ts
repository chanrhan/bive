// 생성 주체 표시명 (shared AUTHOR_KIND_LABELS와 같음, test/status-badge.test.ts가 대조).
// renderer는 shared를 import type으로만 가져온다 (architecture.md 2장).
import type { AuthorKind } from '@bive/shared';

export const AUTHOR_LABELS = {
  human: '사람',
  agent: '에이전트',
} as const satisfies Record<AuthorKind, string>;
