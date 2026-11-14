// 렌더러 요청 처리 (`bive:rpc`). 접속(필요하면 기동) 전에 검증한다 (ADR-039 · ADR-042 순서):
// 형식 -32600 → main 전용 메서드 -32020 → (main 메서드는 여기서 처리) → 등록 여부 -32601 → 파라미터 스키마 -32602.
// -32603은 접속 실패 · 내부 오류에만 쓰고, 원본 메시지는 응답에 싣지 않는다.
// main 메서드(`app.*`)는 파이프로 그대로 보내지 않는다 (architecture.md 5장 "main 전용"). 파라미터는 메서드마다 여기서
// 검증한다: `app.pickFolder`는 없음, `app.openInIde`는 `CodeOpenTarget` (ADR-084). 처리기가 던진 파이프 오류는 그 코드 그대로
// 돌려주고, 그 밖의 오류는 -32603(원본 메시지는 로그에만).
import {
  CodeOpenTarget,
  ErrorCode,
  isMethodName,
  METHODS,
  rpcError,
  type SchemaIssue,
  toSchemaIssues,
} from '@bive/shared';

import {
  APP_METHOD_NAMES,
  type AppMethodName,
  type AppMethods,
  MAIN_ONLY_METHODS,
  OPEN_IN_IDE_METHOD,
  PICK_FOLDER_METHOD,
  type RpcOutcome,
} from '../common/bridge.js';
import { PipeRpcError } from './pipe-client.js';

export interface RpcTarget {
  request(method: string, params?: unknown): Promise<unknown>;
}

/** main 메서드 처리기. 없는 처리기는 -32601 (등록되지 않은 것과 같다). 파라미터는 검증된 값이다. */
export type AppMethodHandlers = {
  [M in AppMethodName]?: (params: AppMethods[M]['params']) => Promise<AppMethods[M]['result']>;
};

type ParamCheck =
  { success: true; data: unknown } | { success: false; issues: SchemaIssue[] | undefined };

/** main 메서드별 파라미터 검증 (파라미터 없는 메서드는 `undefined`만). */
const APP_PARAM_CHECKS: Record<AppMethodName, (params: unknown) => ParamCheck> = {
  [PICK_FOLDER_METHOD]: (params) =>
    params === undefined
      ? { success: true, data: undefined }
      : { success: false, issues: undefined },
  [OPEN_IN_IDE_METHOD]: (params) => {
    const checked = CodeOpenTarget.safeParse(params);
    return checked.success
      ? { success: true, data: checked.data }
      : { success: false, issues: toSchemaIssues(checked.error) };
  },
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
    const checked = APP_PARAM_CHECKS[method](payload.params);
    if (!checked.success) {
      return {
        ok: false,
        error: rpcError(
          ErrorCode.InvalidParams,
          `스키마 불일치: ${method} 파라미터`,
          checked.issues === undefined ? undefined : { issues: checked.issues },
        ),
      };
    }
    try {
      const call = handler as (params: unknown) => Promise<unknown>;
      return { ok: true, result: await call(checked.data) };
    } catch (error) {
      if (error instanceof PipeRpcError) return { ok: false, error: error.toErrorObject() };
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
