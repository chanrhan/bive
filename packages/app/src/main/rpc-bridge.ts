// 렌더러 요청 처리 (`bive:rpc`): 형식 확인 → main 전용 메서드 거부 → 파이프 요청.
// 메서드 등록 여부 · 파라미터 스키마는 파이프 클라이언트가 보내기 전에 검증한다 (ADR-039 순서).
import { ErrorCode, rpcError } from '@bive/shared';

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
  try {
    return { ok: true, result: await target.request(method, payload.params) };
  } catch (error) {
    if (error instanceof PipeRpcError) return { ok: false, error: error.toErrorObject() };
    return { ok: false, error: rpcError(ErrorCode.InternalError) };
  }
};
