// 역할 · 검사 종류 표시명 (규칙 상세 · 변경 이력 · 확인할 것이 함께 쓴다).
// renderer는 shared를 import type으로만 가져오므로(architecture.md 2장) 표시명을 다시 적고,
// test/todo-confirmation.test.ts가 shared의 *_LABELS와 같은지 대조한다.
// 옛 승인 대기(SCR-17)의 제안 표시명 · 배지 계산은 확인할 것(M7-14 #226, ADR-119)으로 바뀌어 지웠다.
import type { AgentRole, CheckKind } from '@bive/shared';

/** 검사 종류 표시명 (shared CHECK_KIND_LABELS와 같음). 규칙 상세에 쓴다. */
export const CHECK_KIND_LABELS = {
  test: '인수 테스트',
  pbt: '속성 기반 테스트',
  contract: '계약 검사',
  static: '정적 분석',
  structure: '구조 검사',
} as const satisfies Record<CheckKind, string>;

/** 에이전트 역할 표시명 (shared AGENT_ROLE_LABELS와 같음). 생성 주체 · 생성 주체 필터에 쓴다. */
export const AGENT_ROLE_LABELS = {
  'rule-writer': '규칙 작성',
  planner: '계획',
  'test-writer': '테스트 작성',
  implementer: '구현',
  chat: '채팅',
} as const satisfies Record<AgentRole, string>;
