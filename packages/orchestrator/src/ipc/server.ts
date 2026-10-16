// 파이프 서버: 연결별 인증(`system.hello`) · JSON-RPC 디스패치 (architecture.md 5장 · 10장, ADR-027 · ADR-039 · ADR-041).
import {
  createErrorResponse,
  createSuccessResponse,
  ERROR_MESSAGES,
  ErrorCode,
  JsonRpcId,
  type JsonRpcErrorObject,
  type JsonRpcMessage,
  type MethodName,
  type MethodParams,
  type MethodResult,
  parseJsonFrame,
  parseNotification,
  parseRequest,
  type ParsedRequest,
  rpcError,
} from '@bive/shared';

import { tokensEqual } from '../token.js';
import type { FrameConnection, FrameErrorKind, PipeListener, PipeTransport } from './transport.js';

/** hello를 기다리는 최대 시간 기본값. 인증 안 된 연결이 유휴 종료를 막지 못하게 한다. */
export const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

const HELLO_METHOD = 'system.hello' satisfies MethodName;

/** 처리기가 던지면 해당 코드의 JSON-RPC 오류 응답이 된다. 그 밖의 예외는 -32603. */
export class RpcError extends Error {
  readonly code: ErrorCode;
  readonly data: unknown;

  constructor(code: ErrorCode, message?: string, data?: unknown) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }

  toErrorObject(): JsonRpcErrorObject {
    return rpcError(this.code, this.message, this.data);
  }
}

export interface RequestContext {
  /** 연결 번호 (기동 후 1부터) */
  connectionId: number;
}

export type MethodHandler<M extends MethodName> = (
  params: MethodParams<M>,
  context: RequestContext,
) => MethodResult<M> | Promise<MethodResult<M>>;

/** 인증 뒤 처리할 메서드. `system.hello`는 서버가 직접 처리한다. */
export type MethodHandlers = {
  [M in Exclude<MethodName, typeof HELLO_METHOD>]?: MethodHandler<M>;
};

export interface PipeServerOptions {
  transport: PipeTransport;
  path: string;
  /** `$BIVE_HOME/run/token` 내용 */
  token: string;
  orchestratorVersion: string;
  handlers: MethodHandlers;
  helloTimeoutMs?: number;
  onConnectionOpened?: () => void;
  onConnectionClosed?: () => void;
}

type SessionState = 'awaiting-hello' | 'ready' | 'closing';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 메시지에서 응답에 쓸 ID를 꺼낸다. 없거나 형식이 틀리면 null. */
const extractId = (value: unknown): JsonRpcId | null => {
  if (!isPlainObject(value)) return null;
  const id = JsonRpcId.safeParse(value.id);
  return id.success ? id.data : null;
};

type MessageKind = 'request' | 'notification' | 'response';

/** id 유무로 요청 · 알림을 가른다. method 없이 result · error만 있으면 응답. 나머지는 요청 검증으로 보낸다. */
const classify = (value: unknown): MessageKind => {
  if (!isPlainObject(value)) return 'request';
  const hasMethod = Object.hasOwn(value, 'method');
  if (hasMethod && !Object.hasOwn(value, 'id')) return 'notification';
  if (!hasMethod && (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'))) {
    return 'response';
  }
  return 'request';
};

class Session {
  readonly #id: number;
  readonly #connection: FrameConnection;
  readonly #options: PipeServerOptions;
  #state: SessionState = 'awaiting-hello';
  #helloTimer: NodeJS.Timeout | null;

  constructor(id: number, connection: FrameConnection, options: PipeServerOptions) {
    this.#id = id;
    this.#connection = connection;
    this.#options = options;
    connection.onFrame((frame) => this.#onFrame(frame));
    connection.onFrameError((error) => this.#onFrameError(error));
    connection.onClose(() => this.#clearHelloTimer());
    this.#helloTimer = setTimeout(() => {
      this.#helloTimer = null;
      if (this.#state === 'awaiting-hello') {
        this.#reject(null, rpcError(ErrorCode.Unauthorized, '인증 시간 초과'));
      }
    }, options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS);
  }

  get authenticated(): boolean {
    return this.#state === 'ready';
  }

  #clearHelloTimer(): void {
    if (this.#helloTimer !== null) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = null;
    }
  }

  #send(message: JsonRpcMessage): void {
    this.#connection.send(JSON.stringify(message));
  }

  /** 오류를 보내고 연결을 닫는다. 이후 프레임은 무시한다. */
  #reject(id: JsonRpcId | null, error: JsonRpcErrorObject): void {
    if (this.#state === 'closing') return;
    this.#state = 'closing';
    this.#clearHelloTimer();
    this.#send(createErrorResponse(id, error));
    this.#connection.end();
  }

  #onFrameError(error: FrameErrorKind): void {
    if (this.#state === 'closing') return;
    if (error === 'frame-too-large') {
      // 프레임 경계를 더는 믿을 수 없으므로 닫는다
      this.#reject(null, rpcError(ErrorCode.InvalidRequest, '프레임 크기 초과'));
      return;
    }
    if (this.#state === 'awaiting-hello') {
      this.#reject(null, rpcError(ErrorCode.Unauthorized));
      return;
    }
    this.#send(createErrorResponse(null, rpcError(ErrorCode.ParseError, 'UTF-8 아닌 프레임')));
  }

  #onFrame(frame: string): void {
    if (this.#state === 'closing') return;
    const parsed = parseJsonFrame(frame);
    if (this.#state === 'awaiting-hello') {
      this.#onHelloFrame(parsed.ok ? parsed.value : undefined, parsed.ok);
      return;
    }
    if (!parsed.ok) {
      this.#send(createErrorResponse(null, parsed.error));
      return;
    }
    const value = parsed.value;
    switch (classify(value)) {
      case 'notification':
        // 앱 → 오케스트레이터 알림은 아직 없다. 알림에는 어떤 경우에도 응답하지 않는다
        parseNotification(value);
        return;
      case 'response':
        // 오케스트레이터는 앱에 요청을 보내지 않으므로 응답은 버린다
        return;
      case 'request':
        void this.#onRequest(value);
        return;
    }
  }

  /** 인증 전: `system.hello` 요청만 받는다. 그 밖은 -32020 후 종료. */
  #onHelloFrame(value: unknown, parsedOk: boolean): void {
    if (
      !parsedOk ||
      classify(value) !== 'request' ||
      !isPlainObject(value) ||
      value.method !== HELLO_METHOD
    ) {
      this.#reject(extractId(value), rpcError(ErrorCode.Unauthorized, '연결 인증 필요'));
      return;
    }
    const result = parseRequest(value);
    if (!result.ok) {
      this.#reject(result.id, result.error);
      return;
    }
    const { request } = result;
    if (request.method !== HELLO_METHOD) {
      this.#reject(request.id, rpcError(ErrorCode.Unauthorized, '연결 인증 필요'));
      return;
    }
    if (!tokensEqual(this.#options.token, request.params.token)) {
      this.#reject(request.id, rpcError(ErrorCode.Unauthorized, '토큰 불일치'));
      return;
    }
    this.#state = 'ready';
    this.#clearHelloTimer();
    this.#send(
      createSuccessResponse(request.id, HELLO_METHOD, {
        orchestratorVersion: this.#options.orchestratorVersion,
      }),
    );
  }

  async #onRequest(value: unknown): Promise<void> {
    const result = parseRequest(value);
    if (!result.ok) {
      this.#send(createErrorResponse(result.id, result.error));
      return;
    }
    const { request } = result;
    if (request.method === HELLO_METHOD) {
      this.#send(
        createErrorResponse(request.id, rpcError(ErrorCode.StateConflict, '이미 인증된 연결')),
      );
      return;
    }
    this.#send(await this.#dispatch(request));
  }

  async #dispatch(
    request: Exclude<ParsedRequest, { method: typeof HELLO_METHOD }>,
  ): Promise<JsonRpcMessage> {
    // 메서드별 처리기 타입은 레지스트리 키로 맞춰져 있으나, 합집합 위에서는 좁혀지지 않아 한 번 넓혀 부른다
    const handler = this.#options.handlers[request.method] as
      ((params: unknown, context: RequestContext) => unknown) | undefined;
    if (handler === undefined) {
      return createErrorResponse(
        request.id,
        rpcError(ErrorCode.MethodNotFound, `없는 메서드: ${request.method}`),
      );
    }
    let output: unknown;
    try {
      output = await handler(request.params, { connectionId: this.#id });
    } catch (error) {
      return createErrorResponse(
        request.id,
        error instanceof RpcError ? error.toErrorObject() : rpcError(ErrorCode.InternalError),
      );
    }
    try {
      // 보내는 쪽 검증: 결과가 메서드 스키마와 다르면 내보내지 않는다
      return createSuccessResponse(request.id, request.method, output as never);
    } catch {
      return createErrorResponse(
        request.id,
        rpcError(ErrorCode.InternalError, `${request.method} 결과 스키마 불일치`),
      );
    }
  }
}

/** 파이프 서버. 연결마다 `Session`을 만들고, 연결 수 변화를 수명 관리에 알린다. */
export class PipeServer {
  readonly #options: PipeServerOptions;
  readonly #sessions = new Set<Session>();
  #listener: PipeListener | null = null;
  #nextId = 1;

  constructor(options: PipeServerOptions) {
    this.#options = options;
  }

  get connectionCount(): number {
    return this.#sessions.size;
  }

  get authenticatedCount(): number {
    let count = 0;
    for (const session of this.#sessions) if (session.authenticated) count += 1;
    return count;
  }

  async listen(): Promise<void> {
    if (this.#listener !== null) throw new Error('이미 듣는 중');
    this.#listener = await this.#options.transport.listen(this.#options.path, (connection) => {
      const session = new Session(this.#nextId, connection, this.#options);
      this.#nextId += 1;
      this.#sessions.add(session);
      this.#options.onConnectionOpened?.();
      connection.onClose(() => {
        if (this.#sessions.delete(session)) this.#options.onConnectionClosed?.();
      });
    });
  }

  /** 새 연결을 받지 않고 열린 연결을 모두 닫는다. */
  async close(): Promise<void> {
    const listener = this.#listener;
    if (listener === null) return;
    await listener.close();
  }
}
