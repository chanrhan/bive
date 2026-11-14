// `toolCall.*` 처리기 (NFR-01 · NFR-02 · RUN-08, M1-38, ADR-052 · ADR-083).
// - 사람(앱 · CLI)이 실행의 도구 호출 기록을 읽는 조회 전용 RPC `toolCall.list` 하나뿐이다. 기록은 도구 실행기만 쓴다
// - 역할 세션의 도구(MCP)에는 없다. 파이프 서버가 토큰 인증된 연결에서만 처리한다 (ADR-041)
// - 인자 · 결과 원문은 싣지 않는다. 파일 도구의 대상 경로만 싣는다(도구 실행기가 파일 도구의 인자 요약으로 경로만 남긴다)
// - 도구 이름 · 경로는 표시용 표기(제어 문자 이스케이프)로 바꾸고 길이 상한을 건다. 저장된 기록은 바꾸지 않는다 (ADR-089)
// - 저장소 열림 구간은 동기다 (ADR-069)
import {
  ErrorCode,
  parseDisplayId,
  TOOL_CALL_LIST_LIMIT,
  TOOL_CALL_NAME_DISPLAY_MAX,
  TOOL_CALL_PATH_DISPLAY_MAX,
  type ToolCall,
  type ToolCallEntry,
} from '@bive/shared';
import type { ProjectStore, RunDetail } from '@bive/store';

import { displayText } from '../text-limit.js';
import { FILE_TOOL_NAMES } from '../tools/definitions.js';
import { withProjectStore } from './project-store-access.js';
import { RpcError, type MethodHandlers } from './server.js';

export interface ToolCallHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
}

type ToolCallMethods = Pick<MethodHandlers, 'toolCall.list'>;

const FILE_TOOLS: readonly string[] = FILE_TOOL_NAMES;

/** ULID 또는 표시 ID(`EXE-001`)로 실행을 찾는다. 없으면(다른 프로젝트의 실행 포함) -32004. */
const findRun = (store: ProjectStore, id: string): RunDetail => {
  const detail =
    parseDisplayId(id) === null ? store.runs.getDetail(id) : store.runs.getDetailByDisplayId(id);
  if (detail === null) throw new RpcError(ErrorCode.NotFound, `실행을 찾을 수 없습니다: ${id}`);
  return detail;
};

/**
 * 파일 도구의 인자 요약은 대상 경로다(`FixedToolExecutor`). 그 밖의 도구는 내용이 섞일 수 있어 싣지 않는다.
 * 실행기 수정 전에 저장된 기록에는 파일 도구라도 인자 JSON(쓰기 내용 포함)이 요약으로 남은 행이 있을 수 있다:
 * `{`로 시작하면 JSON으로 읽어 문자열 `path`만 꺼내고, 읽을 수 없거나(잘린 JSON) 없으면 `null` (ADR-083).
 */
const pathOf = (call: ToolCall): string | null => {
  if (!FILE_TOOLS.includes(call.name) || call.argsSummary.length === 0) return null;
  if (!call.argsSummary.startsWith('{')) return call.argsSummary;
  try {
    const parsed: unknown = JSON.parse(call.argsSummary);
    const candidate =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).path
        : undefined;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
  } catch {
    return null;
  }
};

export const createToolCallHandlers = ({ biveHome }: ToolCallHandlerDeps): ToolCallMethods => ({
  'toolCall.list': ({ projectId, runId }) =>
    withProjectStore(biveHome, projectId, (store) => {
      const detail = findRun(store, runId);
      const stepById = new Map(detail.steps.map((step) => [step.id, step]));
      const stepOfSession = new Map(
        store.sessions.listByRun(detail.run.id).map((session) => {
          const step = session.stepId === null ? undefined : stepById.get(session.stepId);
          return [
            session.id,
            step === undefined ? null : { kind: step.kind, attempt: step.attempt },
          ] as const;
        }),
      );
      // 상한보다 1건 더 읽어 넘쳤는지 안다
      const rows = store.sessions.toolCallsLimited(detail.run.id, TOOL_CALL_LIST_LIMIT + 1);
      const calls = rows.slice(0, TOOL_CALL_LIST_LIMIT).map((call): ToolCallEntry => {
        const name = displayText(call.name, TOOL_CALL_NAME_DISPLAY_MAX);
        const rawPath = pathOf(call);
        const shown = rawPath === null ? null : displayText(rawPath, TOOL_CALL_PATH_DISPLAY_MAX);
        return {
          sessionId: call.sessionId,
          seq: call.seq,
          at: call.at,
          role: call.role,
          step: stepOfSession.get(call.sessionId) ?? null,
          name: name.text,
          nameTruncated: name.truncated,
          status: call.status,
          reason: call.reason,
          path: shown?.text ?? null,
          pathTruncated: shown?.truncated ?? false,
        };
      });
      return {
        runId: detail.run.id,
        displayId: detail.run.displayId,
        calls,
        truncated: rows.length > TOOL_CALL_LIST_LIMIT,
      };
    }),
});
