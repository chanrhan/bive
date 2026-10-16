// 렌더러 요청 처리 (`bive:rpc`). 접속(필요하면 기동) 전에 검증한다 (ADR-039 · ADR-042 순서):
// 형식 -32600 → main 전용 메서드 -32020 → 등록 여부 -32601 → 파라미터 스키마 -32602.
// -32603은 접속 실패 · 내부 오류에만 쓰고, 원본 메시지는 응답에 싣지 않는다.
import { ErrorCode, isMethodName, METHODS, rpcError, toSchemaIssues } from '@bive/shared';

import { MAIN_ONLY_METHODS, type RpcOutcome } from '../common/bridge.js';
import { PipeRpcError } from './pipe-client.js';

export interface RpcTarget {
  request(method: string, params?: unknown): Promise<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const handleRendererRpc = async (
  target: RpcTarget,
  payload: unknown,
): Promise<RpcOutcome> => {
  if (!isRecord(payload) || typeof payload.method !== 'string' || payload.method.length === 0) {
    return { ok: false, error: rpcError(ErrorCode.InvalidRequest) };
  }
  const { method } = payload;
  if ((MAIN_ONLY_METHODS as readonly string[]).includes(method)) {
    return {
      ok: false,
      error: rpcError(ErrorCode.Unauthorized, `렌더러가 부를 수 없는 메서드: ${method}`),
    };
  }
  if (!isMethodName(method)) {
    return { ok: false, error: rpcError(ErrorCode.MethodNotFound, `없는 메서드: ${method}`) };
  }
  const checked = METHODS[method].params.safeParse(payload.params);
  if (!checked.success) {
    return {
      ok: false,
      error: rpcError(ErrorCode.InvalidParams, `스키마 불일치: ${method} 파라미터`, {
        issues: toSchemaIssues(checked.error),
      }),
    };
  }
  try {
    return { ok: true, result: await target.request(method, checked.data) };
  } catch (error) {
    if (error instanceof PipeRpcError) return { ok: false, error: error.toErrorObject() };
    return { ok: false, error: rpcError(ErrorCode.InternalError) };
  }
};
