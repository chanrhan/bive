// 파이프 서버: 연결별 인증(`system.hello`) · JSON-RPC 디스패치 (architecture.md 5장 · 10장, ADR-027 · ADR-039 · ADR-041).
import {
  createErrorResponse,
  createNotification,
  createSuccessResponse,
  ERROR_MESSAGES,
  ErrorCode,
  JsonRpcId,
  type JsonRpcErrorObject,
  type JsonRpcMessage,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type NotificationName,
  type NotificationParams,
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

/**
 * 연결 하나에 알림 1개를 쓰는 동안 쓰기 진척 없이 기다리는 최대 시간 기본값 (ADR-076). 넘기면 읽지 않는(멈춘) 연결로
 * 보고 끊는다. 앱 main은 받는 즉시 읽고, 연결 감시가 1초마다 `system.status`를 부르므로 정상 연결이 5초 동안 한 줄도
 * 비우지 못하는 일은 없다고 본다. 멈춘 연결 때문에 화면 갱신 단계가 기다리는 최대 시간도 이 값이다.
 */
export const DEFAULT_NOTIFY_TIMEOUT_MS = 5_000;

/**
 * 한 연결의 처리 대기 프레임 수 상한 기본값 (ADR-076 보강). 넘으면 그 연결의 소켓 읽기를 멈추고, 대기열이
 * {@link resumeBelow} 이하로 줄면 다시 읽는다. 앱 렌더러는 화면마다 조회 1개 · 뒤따르는 조회 1개만 두고(합치기)
 * CLI는 요청 1건씩 응답을 기다리므로 정상 연결은 이 값에 닿지 않는다. 읽기를 멈춰도 이미 읽은 조각(최대 64KB)의
 * 프레임은 들어오므로 대기열은 상한 + 한 조각의 프레임까지 찰 수 있다.
 */
export const DEFAULT_MAX_PENDING_FRAMES = 256;

/** 읽기를 다시 시작하는 대기열 길이 (상한의 1/4). */
const resumeBelow = (max: number): number => Math.floor(max / 4);

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
  /** 연결별 알림 쓰기 상한 (기본 {@link DEFAULT_NOTIFY_TIMEOUT_MS}) */
  notifyTimeoutMs?: number;
  /** 연결별 처리 대기 프레임 수 상한 (기본 {@link DEFAULT_MAX_PENDING_FRAMES}) */
  maxPendingFrames?: number;
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
  /**
   * 처리 차례를 기다리는 프레임. 프레임은 받은 순서대로 하나씩 처리하고, 다음 프레임 전에 이벤트 루프를 양보한다
   * (`setImmediate`). 한 연결이 요청을 몰아 보내도 다른 연결의 요청 · 알림 송신 · 타이머가 그 사이에 돈다.
   */
  readonly #backlog: (() => void)[] = [];
  /** 프레임 하나를 처리했고 양보 뒤 다음 차례를 기다리는 중 */
  #yielding = false;
  /** 대기열이 상한을 넘어 소켓 읽기를 멈춘 상태 */
  #readingPaused = false;

  constructor(id: number, connection: FrameConnection, options: PipeServerOptions) {
    this.#id = id;
    this.#connection = connection;
    this.#options = options;
    connection.onFrame((frame) => this.#enqueue(() => this.#onFrame(frame)));
    connection.onFrameError((error) => this.#enqueue(() => this.#onFrameError(error)));
    connection.onClose(() => {
      this.#clearHelloTimer();
      // 응답을 받을 상대가 없다. 아직 처리하지 않은 요청은 실행하지 않고 버린다
      this.#backlog.length = 0;
    });
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

  /** 인증된 연결에만 알림 프레임을 보낸다. 쓰기가 끝나면(또는 보낼 수 없으면) 풀린다. */
  notify(frame: string): Promise<void> {
    if (this.#state !== 'ready') return Promise.resolve();
    return this.#connection.sendFlushed(
      frame,
      this.#options.notifyTimeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS,
    );
  }

  /**
   * 프레임 처리를 차례에 넣는다. 쉬고 있으면 바로 처리하고, 아니면 앞 프레임들이 끝난 뒤 처리한다. 처리기의 동기 부분과
   * 응답 송신(마이크로태스크)은 다음 차례 전에 끝나므로 한 연결의 응답 순서는 요청 순서와 같다(비동기 처리기 제외).
   * 처리기는 동기라 저장소를 여는 구간이 양보를 사이에 두고 걸치지 않는다(ADR-069).
   */
  #enqueue(work: () => void): void {
    if (this.#yielding) {
      this.#backlog.push(work);
      if (
        !this.#readingPaused &&
        this.#backlog.length > (this.#options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES)
      ) {
        this.#readingPaused = true;
        this.#connection.pauseReading();
      }
      return;
    }
    this.#runThenYield(work);
  }

  #runThenYield(work: () => void): void {
    this.#yielding = true;
    try {
      work();
    } finally {
      setImmediate(this.#next);
    }
  }

  readonly #next = (): void => {
    this.#yielding = false;
    const work = this.#backlog.shift();
    if (
      this.#readingPaused &&
      this.#backlog.length <=
        resumeBelow(this.#options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES)
    ) {
      // 다시 읽어야 상대가 닫은 것(EOF)도 알 수 있다
      this.#readingPaused = false;
      this.#connection.resumeReading();
    }
    if (work !== undefined) this.#runThenYield(work);
  };

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

  /**
   * 인증된 모든 연결에 알림을 보낸다 (오케스트레이터 → 앱, ADR-076). 보내는 쪽 검증: 파라미터가 알림 스키마와
   * 다르면 아무 연결에도 보내지 않고 예외. 프레임은 연결마다 같은 틱에 쓰므로 알림 순서는 부른 순서와 같고,
   * 돌려준 약속은 모든 연결의 쓰기가 끝나면 풀린다. 인증 전 연결은 받지 않는다. 쓰기 상한(`notifyTimeoutMs`)을
   * 넘긴 연결은 끊고 완료로 본다(다른 연결 · 실행에는 영향 없음).
   */
  notify<N extends NotificationName>(method: N, params: NotificationParams<N>): Promise<void> {
    const frame = JSON.stringify(createNotification(method, params));
    return Promise.all([...this.#sessions].map((session) => session.notify(frame))).then(
      () => undefined,
    );
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
