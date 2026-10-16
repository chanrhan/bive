// 렌더러 요청 처리 (`bive:rpc`). 접속(필요하면 기동) 전에 검증한다 (ADR-039 · ADR-042 순서):
// 형식 -32600 → main 전용 메서드 -32020 → (main 메서드는 여기서 처리) → 등록 여부 -32601 → 파라미터 스키마 -32602.
// -32603은 접속 실패 · 내부 오류에만 쓰고, 원본 메시지는 응답에 싣지 않는다.
// main 메서드(`app.pickFolder`)는 파라미터가 없고 파이프로 보내지 않는다 (architecture.md 5장 "main 전용").
import { ErrorCode, isMethodName, METHODS, rpcError, toSchemaIssues } from '@bive/shared';

import {
  APP_METHOD_NAMES,
  type AppMethodName,
  type AppMethods,
  MAIN_ONLY_METHODS,
  type RpcOutcome,
} from '../common/bridge.js';
import { PipeRpcError } from './pipe-client.js';

export interface RpcTarget {
  request(method: string, params?: unknown): Promise<unknown>;
}

/** main 메서드 처리기. 없는 처리기는 -32601 (등록되지 않은 것과 같다). */
export type AppMethodHandlers = {
  [M in AppMethodName]?: () => Promise<AppMethods[M]['result']>;
};

export interface RendererRpcOptions {
  appMethods?: AppMethodHandlers;
  /** 파이프 요청이 성공한 뒤 부른다 (예: `project.open` 성공 → `project.opened` 알림). 예외는 응답에 영향이 없다 */
  onResult?: (method: string, result: unknown) => void;
  /** main 로그 (기본 표준 오류) */
  log?: (message: string) => void;
}

const isAppMethodName = (name: string): name is AppMethodName =>
  (APP_METHOD_NAMES as readonly string[]).includes(name);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const handleRendererRpc = async (
  target: RpcTarget,
  payload: unknown,
  options: RendererRpcOptions = {},
): Promise<RpcOutcome> => {
  const log = options.log ?? ((message: string) => console.error(message));
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
  if (isAppMethodName(method)) {
    const handler = options.appMethods?.[method];
    if (handler === undefined) {
      return { ok: false, error: rpcError(ErrorCode.MethodNotFound, `없는 메서드: ${method}`) };
    }
    if (payload.params !== undefined) {
      return {
        ok: false,
        error: rpcError(ErrorCode.InvalidParams, `스키마 불일치: ${method} 파라미터`),
      };
    }
    try {
      return { ok: true, result: await handler() };
    } catch (error) {
      log(`${method} 실패: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, error: rpcError(ErrorCode.InternalError) };
    }
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
  let result: unknown;
  try {
    result = await target.request(method, checked.data);
  } catch (error) {
    if (error instanceof PipeRpcError) return { ok: false, error: error.toErrorObject() };
    return { ok: false, error: rpcError(ErrorCode.InternalError) };
  }
  try {
    options.onResult?.(method, result);
  } catch (error) {
    log(`${method} 후처리 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, result };
};
