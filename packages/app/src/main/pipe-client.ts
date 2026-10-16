// 오케스트레이터 파이프 클라이언트 (architecture.md 5장, ADR-027 · ADR-039 · ADR-041).
// 접속 순서: connect → `system.hello { protocolVersion, token }` → 요청. 프레임 = UTF-8 JSON 1줄.
// 보내는 요청 · 받는 응답을 shared 스키마로 검증한다. `net`은 주입할 수 있어 소켓 없이도 시험한다.
import nodeNet from 'node:net';

import {
  createRequest,
  ErrorCode,
  isMethodName,
  type JsonRpcErrorObject,
  type JsonRpcId,
  METHODS,
  type MethodName,
  type MethodParams,
  type MethodResult,
  parseNotification,
  parseResponse,
  PROTOCOL_VERSION,
  rpcError,
  toSchemaIssues,
} from '@bive/shared';

/** 클라이언트가 쓰는 소켓 기능만 모은 것. `net.Socket`이 그대로 맞는다. */
export interface PipeSocket {
  setEncoding(encoding: 'utf8'): unknown;
  write(data: string): unknown;
  end(): unknown;
  destroy(): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'connect', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
}

/** `node:net`에서 쓰는 부분. 시험에서는 가짜를 넣는다. */
export interface PipeNet {
  createConnection(path: string): PipeSocket;
}

/** JSON-RPC 오류(원격 응답 또는 보내기 전 검증 실패). */
export class PipeRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcErrorObject) {
    super(error.message);
    this.name = 'PipeRpcError';
    this.code = error.code;
    this.data = error.data;
  }

  toErrorObject(): JsonRpcErrorObject {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

/** 응답 전에 연결이 닫힘. */
export const CONNECTION_CLOSED_MESSAGE = '오케스트레이터 연결 끊김';

export interface PipeNotification {
  event: string;
  params: unknown;
}

type Pending = {
  method: MethodName;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class PipeClient {
  readonly #socket: PipeSocket;
  readonly #pending = new Map<JsonRpcId, Pending>();
  readonly #notificationListeners = new Set<(notification: PipeNotification) => void>();
  readonly #closeListeners = new Set<() => void>();
  readonly closed: Promise<void>;
  #buffer = '';
  #nextId = 1;
  #isClosed = false;

  private constructor(socket: PipeSocket) {
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.#onData(chunk));
    // 소켓 오류는 close로 이어진다
    socket.on('error', () => undefined);
    this.closed = new Promise((resolve) => {
      socket.on('close', () => {
        this.#isClosed = true;
        const pending = [...this.#pending.values()];
        this.#pending.clear();
        for (const p of pending) {
          p.reject(new PipeRpcError(rpcError(ErrorCode.InternalError, CONNECTION_CLOSED_MESSAGE)));
        }
        for (const listener of this.#closeListeners) listener();
        resolve();
      });
    });
  }

  /** 소켓에 연결만 한다(인증 전). 실패하면 `net` 오류(ENOENT · ECONNREFUSED 등)로 거부된다. */
  static open(path: string, net: PipeNet = nodeNet): Promise<PipeClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(path);
      const onError = (error: Error): void => reject(error);
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        resolve(new PipeClient(socket));
      });
    });
  }

  get isClosed(): boolean {
    return this.#isClosed;
  }

  /** 알림 구독. 돌려준 함수를 부르면 끊는다. */
  onNotification(listener: (notification: PipeNotification) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) this.#onFrame(line);
    }
  }

  #onFrame(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (Object.hasOwn(message, 'method') && !Object.hasOwn(message, 'id')) {
      const parsed = parseNotification(message);
      if (!parsed.ok) return;
      for (const listener of this.#notificationListeners) {
        listener({ event: parsed.method, params: parsed.params });
      }
      return;
    }
    const id = message.id;
    if (typeof id !== 'string' && typeof id !== 'number') return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    const parsed = parseResponse(pending.method, message);
    if (parsed.ok) pending.resolve(parsed.result);
    else pending.reject(new PipeRpcError(parsed.error));
  }

  /**
   * 이름이 문자열인 요청(렌더러 · CLI 경로). 보내기 전에 검증한다:
   * 등록되지 않은 메서드 -32601, 파라미터 스키마 불일치 -32602 (ADR-039 순서).
   */
  request(method: string, params?: unknown): Promise<unknown> {
    if (!isMethodName(method)) {
      return Promise.reject(
        new PipeRpcError(rpcError(ErrorCode.MethodNotFound, `없는 메서드: ${method}`)),
      );
    }
    const checked = METHODS[method].params.safeParse(params);
    if (!checked.success) {
      return Promise.reject(
        new PipeRpcError(
          rpcError(ErrorCode.InvalidParams, `스키마 불일치: ${method} 파라미터`, {
            issues: toSchemaIssues(checked.error),
          }),
        ),
      );
    }
    if (this.#isClosed) {
      return Promise.reject(
        new PipeRpcError(rpcError(ErrorCode.InternalError, CONNECTION_CLOSED_MESSAGE)),
      );
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const message = (createRequest as (...args: unknown[]) => ReturnType<typeof createRequest>)(
      id,
      method,
      checked.data,
    );
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#socket.write(`${JSON.stringify(message)}\n`);
    });
  }

  /** 타입이 붙은 요청. */
  call<M extends MethodName>(
    method: M,
    ...params: undefined extends MethodParams<M> ? [MethodParams<M>?] : [MethodParams<M>]
  ): Promise<MethodResult<M>> {
    return this.request(method, params[0]) as Promise<MethodResult<M>>;
  }

  hello(token: string): Promise<MethodResult<'system.hello'>> {
    return this.call('system.hello', { protocolVersion: PROTOCOL_VERSION, token });
  }

  /** 보낸 내용을 흘려보낸 뒤 닫는다. */
  close(): Promise<void> {
    if (!this.#isClosed) this.#socket.end();
    return this.closed;
  }

  destroy(): void {
    this.#socket.destroy();
  }
}

/** 연결하고 `system.hello`로 인증까지 마친 클라이언트. 인증이 실패하면 연결을 끊고 거부된다. */
export const connectPipe = async (
  path: string,
  token: string,
  net: PipeNet = nodeNet,
): Promise<PipeClient> => {
  const client = await PipeClient.open(path, net);
  try {
    await client.hello(token);
  } catch (error) {
    client.destroy();
    throw error;
  }
  return client;
};
