// 에이전트 어댑터 인터페이스 (ADR-016 · ADR-024 · ADR-049).
// 세션 1개 = SDK `query()` 1회(기획서 3.2). 실행 엔진은 어댑터 종류와 무관하게 이 타입만 본다.
// 결과 이벤트는 SDK 결과 메시지와 같은 필드 이름을 쓴다(기획서 4.5): `total_cost_usd` · `num_turns` · `modelUsage`.
import type { AgentRole } from '@bive/shared';

/** 어댑터 종류. `BIVE_AGENT` 값과 같다. */
export const AGENT_KINDS = ['scripted', 'claude'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** 도구 호출 결과. `denied`는 경로 · 명령 가드나 허용 목록이 거부한 경우(NFR-02). */
export interface ToolResult {
  status: 'ok' | 'denied' | 'error';
  /** 모델에게 다음 턴 입력으로 돌려줄 본문 */
  content: string;
  /** 거부 · 오류 사유 코드 (예: `unknown_tool`) */
  reason?: string;
}

/**
 * 세션에 주입되는 고정 도구 실행기. 구현(경로 가드 · 허용 명령 · 호출 기록)은 M1-07.
 * 어댑터는 모델의 도구 호출을 여기로만 넘기고 결과를 다음 턴 입력으로 쓴다.
 */
export interface ToolExecutor {
  /** 이 세션에 노출하는 도구 이름 (init 이벤트에 그대로 실린다) */
  readonly toolNames: readonly string[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/** 세션 한도. 값은 실행 엔진이 설정 · 잔여 예산으로 정한다(COST-01, `min(역할 잔여, 실행 잔여)`). */
export interface SessionBudget {
  maxBudgetUsd: number;
  maxTurns: number;
}

/** 세션 시작 입력. */
export interface SessionSpec {
  role: AgentRole;
  systemPrompt: string;
  /** 첫 사용자 메시지(작업 지시) */
  prompt: string;
  /** 세션 작업 디렉터리 (역할별, ADR-024) */
  workDir: string;
  tools: ToolExecutor;
  budget: SessionBudget;
  /** 설정의 역할별 모델 (NFR-07) */
  model: string;
  signal?: AbortSignal;
  /** 이 세션이 속한 실행. 실행 밖 세션(규칙 작성 · 채팅)은 생략 */
  runId?: string;
  /**
   * 같은 실행 · 같은 역할 세션 중 이 세션의 0부터 순번. 재기동 뒤에도 순서가 이어지도록
   * 실행 엔진이 저장된 세션 수로 넘긴다. 생략하면 어댑터가 프로세스 안에서 센다(ScriptedAdapter만 사용).
   */
  roleSessionIndex?: number;
  /** 시나리오 자리표시자 값 (예: `ruleId` · `requirementId`). ScriptedAdapter만 사용 */
  vars?: Readonly<Record<string, string>>;
}

/** SDK 결과 메시지 subtype 중 BIVE가 다루는 것 (SessionEndReason의 SDK 쪽 값). */
export const RESULT_SUBTYPES = [
  'success',
  'error_max_turns',
  'error_max_budget_usd',
  'error_during_execution',
] as const;
export type ResultSubtype = (typeof RESULT_SUBTYPES)[number];

/** 모델별 사용량. SDK `modelUsage` 값과 같은 필드 이름. */
export interface ModelUsageReport {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

/** 세션 결과. SDK 결과 메시지와 같은 모양. 비용을 모르면 `null`(0이 아님, COST-02). */
export interface SessionResultEvent {
  type: 'result';
  subtype: ResultSubtype;
  total_cost_usd: number | null;
  num_turns: number;
  modelUsage: Record<string, ModelUsageReport>;
}

/** 세션 시작 알림. SDK init 메시지에 해당하며 세션 가드(M1-07)가 도구 · MCP 서버 목록을 검사한다. */
export interface SessionInitEvent {
  type: 'init';
  sessionId: string;
  model: string;
  tools: string[];
  mcpServers: string[];
}

export type SessionEvent =
  | SessionInitEvent
  | { type: 'turn_start'; turn: number }
  | {
      type: 'tool_call';
      turn: number;
      callId: string;
      name: string;
      args: Record<string, unknown>;
    }
  | { type: 'tool_result'; turn: number; callId: string; name: string; result: ToolResult }
  | { type: 'message'; turn: number; text: string }
  | SessionResultEvent;

/** 실행기 예외는 SDK의 MCP 도구 오류처럼 `error` 결과(`executor_error`)로 바꿔 세션을 이어간다 (ADR-049). */
export const executeTool = async (
  tools: ToolExecutor,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  try {
    return await tools.execute(name, args);
  } catch (error) {
    return {
      status: 'error',
      content: error instanceof Error ? error.message : String(error),
      reason: 'executor_error',
    };
  }
};

/**
 * 에이전트 어댑터. `startSession`은 바로 반환하고, 오류(시나리오 없음 · 인증 미설정 등)는 순회 중에 던진다.
 * `signal`이 중단되면 순회가 `signal.reason`(기본 `AbortError`)으로 끝난다.
 */
export interface AgentAdapter {
  readonly kind: AgentKind;
  startSession(spec: SessionSpec): AsyncIterable<SessionEvent>;
}
