// 도구 결과 생성 도우미와 사유 코드 (ADR-052). 사유 코드는 도구 호출 기록 · 화면 · 시험이 그대로 단언한다.
import type { ToolResult } from '../agent/adapter.js';

/** `denied` 사유: 허용 목록 · 가드가 거부함 */
export const DENIED_REASONS = [
  /** 역할 허용 목록 밖 도구 이름 (M1 흐름 13 · M1-22) */
  'unknown_tool',
  /** 입력 스키마 위반 (모르는 인자 · 형식 오류) */
  'invalid_args',
  /** 경로 가드 거부 */
  'path_denied',
  /** 패키지 설치 허용 목록 밖 */
  'not_allowed',
] as const;
export type DeniedReason = (typeof DENIED_REASONS)[number];

/** `error` 사유: 허용된 호출이 실패함 */
export const ERROR_REASONS = [
  'not_found',
  'not_a_file',
  'not_a_directory',
  'too_large',
  /** 명령 실행 파일이 없음 (의존성 미설치) */
  'command_unavailable',
  /** 명령이 0이 아닌 코드로 끝남 */
  'nonzero_exit',
  'timeout',
  /** 세션 중단 신호로 명령을 멈춤 */
  'aborted',
  /** 명령 출력이 하드 상한을 넘어 중단됨 */
  'output_limit',
  /** 이 OS에서 지원하지 않는 명령 */
  'unsupported_platform',
  /** 제안 등록 콜백이 주입되지 않음 */
  'not_configured',
  /** 대상의 상태가 호출과 맞지 않음 (예: 부모 요구사항이 삭제됨, ADR-062) */
  'state_conflict',
  /** 그 밖의 실행 오류 (입출력 · 콜백 예외) */
  'tool_failed',
] as const;
export type ErrorReason = (typeof ERROR_REASONS)[number];

export const ok = (content: string): ToolResult => ({ status: 'ok', content });

export const denied = (reason: DeniedReason, detail: string): ToolResult => ({
  status: 'denied',
  content: `거부됨: ${detail}`,
  reason,
});

export const failed = (reason: ErrorReason, detail: string): ToolResult => ({
  status: 'error',
  content: detail,
  reason,
});

/** zod 검증 오류의 모양 (필요한 부분만). */
export interface IssueList {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}

/** 입력 스키마 위반 → `denied`(`invalid_args`). */
export const invalidArgs = (name: string, error: IssueList): ToolResult =>
  denied(
    'invalid_args',
    `${name} 인자 오류: ${error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(인자)'} ${issue.message}`)
      .join('; ')}`,
  );
