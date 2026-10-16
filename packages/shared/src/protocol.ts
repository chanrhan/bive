// 앱 ↔ 오케스트레이터 IPC 프로토콜 (docs/architecture.md 5장).
// 프레임 = UTF-8 JSON 1줄 = JSON-RPC 2.0 메시지 1개. 양쪽이 같은 스키마로 검증하고,
// 파라미터 · 결과가 메서드 스키마와 맞지 않으면 -32602로 처리한다.
import { z } from 'zod';

export const JSONRPC_VERSION = '2.0';

/** 오류 코드: JSON-RPC 표준 + BIVE 정의 (architecture.md 5장). */
export const ErrorCode = {
  /** JSON 해석 실패 */
  ParseError: -32700,
  /** JSON-RPC 메시지 형식 위반 */
  InvalidRequest: -32600,
  /** 등록되지 않은 메서드 */
  MethodNotFound: -32601,
  /** 파라미터 · 결과의 스키마 불일치 */
  InvalidParams: -32602,
  /** 처리 중 내부 오류 */
  InternalError: -32603,
  /** 도메인 검증 실패 (예: 빈 거절 사유) */
  ValidationFailed: -32001,
  /** 대상 없음 */
  NotFound: -32004,
  /** 상태 충돌 (예: 승인된 제안 재승인) */
  StateConflict: -32009,
  /** 설정 미비 (예산 · 모델 없음, NFR-07) */
  SettingsIncomplete: -32010,
  /** 권한 없음 (토큰 · 출처) */
  Unauthorized: -32020,
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 오류 코드별 기본 메시지. */
export const ERROR_MESSAGES = {
  [ErrorCode.ParseError]: 'JSON 해석 실패',
  [ErrorCode.InvalidRequest]: '요청 형식 위반',
  [ErrorCode.MethodNotFound]: '없는 메서드',
  [ErrorCode.InvalidParams]: '스키마 불일치',
  [ErrorCode.InternalError]: '내부 오류',
  [ErrorCode.ValidationFailed]: '검증 실패',
  [ErrorCode.NotFound]: '대상 없음',
  [ErrorCode.StateConflict]: '상태 충돌',
  [ErrorCode.SettingsIncomplete]: '설정 미비',
  [ErrorCode.Unauthorized]: '권한 없음',
} as const satisfies Record<ErrorCode, string>;

// ── 메시지 스키마 ────────────────────────────────────────

/** 요청 ID. 소수 숫자는 허용하지 않는다 (JSON-RPC 2.0 권고). */
export const JsonRpcId = z.union([z.string(), z.int()]);
export type JsonRpcId = z.infer<typeof JsonRpcId>;

/** 파라미터 자리: 없거나, 객체 · 배열 (JSON-RPC 2.0). 메서드별 형태는 METHODS가 정한다. */
const ParamsSlot = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional();

export const JsonRpcRequest = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: JsonRpcId,
  method: z.string().min(1),
  params: ParamsSlot,
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;

/** 알림: ID 없는 요청. 응답하지 않는다. */
export const JsonRpcNotification = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  method: z.string().min(1),
  params: ParamsSlot,
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotification>;

export const JsonRpcErrorObject = z.strictObject({
  code: z.int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObject>;

/** 성공 응답. `result`는 필수 (`null`도 값). */
export const JsonRpcSuccessResponse = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: JsonRpcId,
  result: z.unknown(),
});
export type JsonRpcSuccessResponse = z.infer<typeof JsonRpcSuccessResponse>;

/** 오류 응답. 요청 ID를 알 수 없으면 `null`. */
export const JsonRpcErrorResponse = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: JsonRpcId.nullable(),
  error: JsonRpcErrorObject,
});
export type JsonRpcErrorResponse = z.infer<typeof JsonRpcErrorResponse>;

/** 응답: 성공 · 오류 중 하나. `result`와 `error`를 함께 가지면 위반. */
export const JsonRpcResponse = z.union([JsonRpcSuccessResponse, JsonRpcErrorResponse]);
export type JsonRpcResponse = z.infer<typeof JsonRpcResponse>;

/** 파이프로 오가는 메시지 전체. */
export const JsonRpcMessage = z.union([JsonRpcRequest, JsonRpcNotification, JsonRpcResponse]);
export type JsonRpcMessage = z.infer<typeof JsonRpcMessage>;

// ── 메서드 레지스트리 ────────────────────────────────────

export interface MethodSpec {
  params: z.ZodType;
  result: z.ZodType;
}

/** `ping`: 파라미터 없음 → `{ pong: true, version }`. 연결 확인용. */
export const PingParams = z.undefined();
export const PingResult = z.strictObject({
  pong: z.literal(true),
  /** 응답한 쪽(오케스트레이터)의 버전 문자열 */
  version: z.string().min(1),
});
export type PingResult = z.infer<typeof PingResult>;

/** 파이프 프로토콜 버전. 메시지 형태가 호환되지 않게 바뀌면 올린다. */
export const PROTOCOL_VERSION = 1;

/**
 * `system.hello`: 연결 후 첫 메시지 (architecture.md 5장, ADR-027).
 * 토큰은 `$BIVE_HOME/run/token` 내용. 버전이 다르면 -32602, 토큰이 다르면 -32020이고 둘 다 연결을 닫는다.
 */
export const SystemHelloParams = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  token: z.string().min(1),
});
export type SystemHelloParams = z.infer<typeof SystemHelloParams>;
export const SystemHelloResult = z.strictObject({
  orchestratorVersion: z.string().min(1),
});
export type SystemHelloResult = z.infer<typeof SystemHelloResult>;

/**
 * 메서드 이름 → 파라미터 · 결과 스키마. architecture.md 5장 표의 메서드는 해당 이슈에서 여기에 추가한다.
 * 파라미터가 없는 메서드는 `z.undefined()`로 둔다 (요청에 `params`를 넣으면 -32602).
 */
export const METHODS = {
  ping: { params: PingParams, result: PingResult },
  'system.hello': { params: SystemHelloParams, result: SystemHelloResult },
} as const satisfies Record<string, MethodSpec>;

export type MethodName = keyof typeof METHODS;
export type MethodParams<M extends MethodName> = z.infer<(typeof METHODS)[M]['params']>;
export type MethodResult<M extends MethodName> = z.infer<(typeof METHODS)[M]['result']>;

export const METHOD_NAMES = Object.keys(METHODS) as MethodName[];

export const isMethodName = (name: string): name is MethodName => Object.hasOwn(METHODS, name);

export interface NotificationSpec {
  params: z.ZodType;
}

/** 알림 이름 → 파라미터 스키마. `event.*` 알림은 해당 이슈에서 추가한다. */
export const NOTIFICATIONS = {} as const satisfies Record<string, NotificationSpec>;

export type NotificationName = keyof typeof NOTIFICATIONS;

export const isNotificationName = (name: string): name is NotificationName =>
  Object.hasOwn(NOTIFICATIONS, name);

// ── 생성 · 해석 ──────────────────────────────────────────

/** 오류 객체를 만든다. 메시지를 생략하면 코드별 기본 메시지. */
export const rpcError = (code: ErrorCode, message?: string, data?: unknown): JsonRpcErrorObject =>
  data === undefined
    ? { code, message: message ?? ERROR_MESSAGES[code] }
    : { code, message: message ?? ERROR_MESSAGES[code], data };

export interface SchemaIssue {
  path: string;
  message: string;
}

/** zod 오류를 `error.data.issues`로 실을 수 있는 평평한 목록으로 바꾼다. */
export const toSchemaIssues = (error: z.ZodError): SchemaIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));

const schemaMismatch = (what: string, error: z.ZodError): JsonRpcErrorObject =>
  rpcError(ErrorCode.InvalidParams, `${ERROR_MESSAGES[ErrorCode.InvalidParams]}: ${what}`, {
    issues: toSchemaIssues(error),
  });

type ParamsArg<M extends MethodName> =
  undefined extends MethodParams<M> ? [params?: MethodParams<M>] : [params: MethodParams<M>];

/** 요청을 만든다. 파라미터가 메서드 스키마와 맞지 않으면 예외 (보내는 쪽 검증). */
export const createRequest = <M extends MethodName>(
  id: JsonRpcId,
  method: M,
  ...[params]: ParamsArg<M>
): JsonRpcRequest => {
  const checked: unknown = METHODS[method].params.parse(params);
  return checked === undefined
    ? { jsonrpc: JSONRPC_VERSION, id, method }
    : { jsonrpc: JSONRPC_VERSION, id, method, params: checked as JsonRpcRequest['params'] };
};

/** 성공 응답을 만든다. 결과가 메서드 스키마와 맞지 않으면 예외 (보내는 쪽 검증). */
export const createSuccessResponse = <M extends MethodName>(
  id: JsonRpcId,
  method: M,
  result: MethodResult<M>,
): JsonRpcSuccessResponse => ({
  jsonrpc: JSONRPC_VERSION,
  id,
  result: METHODS[method].result.parse(result),
});

export const createErrorResponse = (
  id: JsonRpcId | null,
  error: JsonRpcErrorObject,
): JsonRpcErrorResponse => ({ jsonrpc: JSONRPC_VERSION, id, error });

/** 줄 프레임 1개를 JSON으로 해석한다. 실패하면 -32700. */
export const parseJsonFrame = (
  line: string,
): { ok: true; value: unknown } | { ok: false; error: JsonRpcErrorObject } => {
  try {
    return { ok: true, value: JSON.parse(line) as unknown };
  } catch {
    return { ok: false, error: rpcError(ErrorCode.ParseError) };
  }
};

/** 해석된 요청. 메서드 이름으로 파라미터 타입이 좁혀진다. */
export type ParsedRequest = {
  [M in MethodName]: { id: JsonRpcId; method: M; params: MethodParams<M> };
}[MethodName];

export type ParseRequestResult =
  | { ok: true; request: ParsedRequest }
  | { ok: false; id: JsonRpcId | null; error: JsonRpcErrorObject };

/**
 * 받은 요청을 검증한다 (받는 쪽). 실패하면 응답에 쓸 ID와 오류를 돌려준다.
 * 형식 위반 -32600 → 없는 메서드 -32601 → 파라미터 스키마 불일치 -32602 순으로 판단한다.
 */
export const parseRequest = (value: unknown): ParseRequestResult => {
  const envelope = JsonRpcRequest.safeParse(value);
  if (!envelope.success) {
    const rawId = typeof value === 'object' && value !== null ? Reflect.get(value, 'id') : null;
    const id = JsonRpcId.safeParse(rawId);
    return {
      ok: false,
      id: id.success ? id.data : null,
      error: rpcError(ErrorCode.InvalidRequest, undefined, {
        issues: toSchemaIssues(envelope.error),
      }),
    };
  }
  const { id, method, params } = envelope.data;
  if (!isMethodName(method)) {
    return { ok: false, id, error: rpcError(ErrorCode.MethodNotFound, `없는 메서드: ${method}`) };
  }
  const checked = METHODS[method].params.safeParse(params);
  if (!checked.success) {
    return { ok: false, id, error: schemaMismatch(`${method} 파라미터`, checked.error) };
  }
  return { ok: true, request: { id, method, params: checked.data } as ParsedRequest };
};

export type ParseResponseResult<M extends MethodName> =
  | { ok: true; id: JsonRpcId; result: MethodResult<M> }
  | { ok: false; id: JsonRpcId | null; error: JsonRpcErrorObject };

/**
 * 받은 응답을 보낸 요청의 메서드 기준으로 검증한다 (요청한 쪽).
 * 오류 응답은 그 오류를, 형식 · 결과 스키마 위반은 -32602 오류를 돌려준다.
 */
export const parseResponse = <M extends MethodName>(
  method: M,
  value: unknown,
): ParseResponseResult<M> => {
  const envelope = JsonRpcResponse.safeParse(value);
  if (!envelope.success) {
    return { ok: false, id: null, error: schemaMismatch(`${method} 응답 형식`, envelope.error) };
  }
  const response = envelope.data;
  if ('error' in response) {
    return { ok: false, id: response.id, error: response.error };
  }
  const checked = METHODS[method].result.safeParse(response.result);
  if (!checked.success) {
    return { ok: false, id: response.id, error: schemaMismatch(`${method} 결과`, checked.error) };
  }
  return { ok: true, id: response.id, result: checked.data as MethodResult<M> };
};

export type ParseNotificationResult =
  | { ok: true; method: NotificationName; params: unknown }
  | { ok: false; error: JsonRpcErrorObject };

/** 받은 알림을 검증한다. 알림은 응답하지 않으므로 실패는 받는 쪽 기록용이다. */
export const parseNotification = (value: unknown): ParseNotificationResult => {
  const envelope = JsonRpcNotification.safeParse(value);
  if (!envelope.success) {
    return {
      ok: false,
      error: rpcError(ErrorCode.InvalidRequest, undefined, {
        issues: toSchemaIssues(envelope.error),
      }),
    };
  }
  const { method, params } = envelope.data;
  if (!isNotificationName(method)) {
    return { ok: false, error: rpcError(ErrorCode.MethodNotFound, `없는 알림: ${method}`) };
  }
  const spec: NotificationSpec = NOTIFICATIONS[method];
  const checked = spec.params.safeParse(params);
  if (!checked.success) {
    return { ok: false, error: schemaMismatch(`${method} 파라미터`, checked.error) };
  }
  return { ok: true, method, params: checked.data };
};
