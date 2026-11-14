// `toolCall.*` 처리기 (NFR-01 · NFR-02 · RUN-08, M1-38, ADR-052 · ADR-083).
// - 사람(앱 · CLI)이 실행의 도구 호출 기록을 읽는 조회 전용 RPC `toolCall.list` 하나뿐이다. 기록은 도구 실행기만 쓴다
// - 역할 세션의 도구(MCP)에는 없다. 파이프 서버가 토큰 인증된 연결에서만 처리한다 (ADR-041)
// - 인자 · 결과 원문은 싣지 않는다. 파일 도구의 대상 경로만 싣는다(도구 실행기가 파일 도구의 인자 요약으로 경로만 남긴다)
// - 저장소 열림 구간은 동기다 (ADR-069)
import {
  ErrorCode,
  parseDisplayId,
  TOOL_CALL_LIST_LIMIT,
  type ToolCall,
  type ToolCallEntry,
} from '@bive/shared';
import type { ProjectStore, RunDetail } from '@bive/store';

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

/** 파일 도구의 인자 요약은 대상 경로다(`FixedToolExecutor`). 그 밖의 도구는 내용이 섞일 수 있어 싣지 않는다. */
const pathOf = (call: ToolCall): string | null =>
  FILE_TOOLS.includes(call.name) && call.argsSummary.length > 0 ? call.argsSummary : null;

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
      const calls = rows.slice(0, TOOL_CALL_LIST_LIMIT).map((call): ToolCallEntry => ({
        sessionId: call.sessionId,
        seq: call.seq,
        at: call.at,
        role: call.role,
        step: stepOfSession.get(call.sessionId) ?? null,
        name: call.name,
        status: call.status,
        reason: call.reason,
        path: pathOf(call),
      }));
      return {
        runId: detail.run.id,
        displayId: detail.run.displayId,
        calls,
        truncated: rows.length > TOOL_CALL_LIST_LIMIT,
      };
    }),
});
