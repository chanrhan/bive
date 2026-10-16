// 테스트용 파이프 클라이언트. 서버 전송 코드와 독립적으로 `net`과 줄 프레이밍만으로 구현한다.
// 앱 main의 파이프 클라이언트(#9)가 따를 접속 순서의 참고 구현: connect → system.hello(token) → 요청.
import net from 'node:net';

import {
  createRequest,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type MethodName,
  type MethodParams,
  type MethodResult,
  parseResponse,
  PROTOCOL_VERSION,
} from '@bive/shared';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** 응답이 JSON-RPC 오류일 때 던지는 예외. */
export class RpcCallError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcErrorObject) {
    super(`${error.code} ${error.message}`);
    this.code = error.code;
    this.data = error.data;
  }
}

export class TestClient {
  readonly #socket: net.Socket;
  readonly #pending = new Map<JsonRpcId, Pending>();
  /** ID로 짝지을 수 없는 메시지(id null 오류 응답 등)는 순서대로 쌓는다 */
  readonly unmatched: unknown[] = [];
  readonly #unmatchedWaiters: ((value: unknown) => void)[] = [];
  readonly closed: Promise<void>;
  #buffer = '';
  #nextId = 1;
  #isClosed = false;

  private constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.#onData(chunk));
    socket.on('error', () => undefined);
    this.closed = new Promise((resolve) => {
      socket.on('close', () => {
        this.#isClosed = true;
        for (const pending of this.#pending.values()) {
          pending.reject(new Error('연결 닫힘'));
        }
        this.#pending.clear();
        resolve();
      });
    });
  }

  /** 소켓에 연결만 한다 (인증 전). */
  static open(socketPath: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(new TestClient(socket));
      });
    });
  }

  get isClosed(): boolean {
    return this.#isClosed;
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      const message: unknown = JSON.parse(line);
      const id =
        typeof message === 'object' && message !== null
          ? (Reflect.get(message, 'id') as unknown)
          : null;
      const pending =
        typeof id === 'string' || typeof id === 'number' ? this.#pending.get(id) : undefined;
      if (pending !== undefined && (typeof id === 'string' || typeof id === 'number')) {
        this.#pending.delete(id);
        pending.resolve(message);
      } else {
        const waiter = this.#unmatchedWaiters.shift();
        if (waiter) waiter(message);
        else this.unmatched.push(message);
      }
    }
  }

  /** 줄 하나를 그대로 보낸다 (개행은 붙여 준다). 형식 위반 시험용. */
  sendRaw(line: string): void {
    this.#socket.write(`${line}\n`);
  }

  /** 바이트를 그대로 보낸다 (개행 없음). */
  writeBytes(data: string | Uint8Array): void {
    this.#socket.write(data);
  }

  /** 객체를 JSON 1줄로 보내고, 같은 ID의 응답 원문을 기다린다. */
  requestRaw(message: { id: JsonRpcId } & Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.#pending.set(message.id, { resolve, reject });
      this.sendRaw(JSON.stringify(message));
    });
  }

  /** 보내지 않고 해당 ID의 응답만 기다린다 (writeBytes로 직접 보낸 요청용). */
  waitForResponse(id: JsonRpcId): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  /** ID로 짝지을 수 없는 다음 메시지를 기다린다. */
  nextUnmatched(): Promise<unknown> {
    const queued = this.unmatched.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.#unmatchedWaiters.push(resolve));
  }

  /** 타입이 붙은 호출. 오류 응답이면 RpcCallError. */
  async call<M extends MethodName>(
    method: M,
    ...params: undefined extends MethodParams<M> ? [MethodParams<M>?] : [MethodParams<M>]
  ): Promise<MethodResult<M>> {
    const id = this.#nextId;
    this.#nextId += 1;
    const request = (createRequest as (...args: unknown[]) => ReturnType<typeof createRequest>)(
      id,
      method,
      ...params,
    );
    const raw = await this.requestRaw(request);
    const parsed = parseResponse(method, raw);
    if (!parsed.ok) throw new RpcCallError(parsed.error);
    return parsed.result;
  }

  hello(token: string): Promise<MethodResult<'system.hello'>> {
    return this.call('system.hello', { protocolVersion: PROTOCOL_VERSION, token });
  }

  close(): Promise<void> {
    this.#socket.end();
    return this.closed;
  }

  destroy(): void {
    this.#socket.destroy();
  }
}

/** 연결하고 `system.hello`로 인증까지 마친 클라이언트. */
export const connect = async (socketPath: string, token: string): Promise<TestClient> => {
  const client = await TestClient.open(socketPath);
  try {
    await client.hello(token);
  } catch (error) {
    client.destroy();
    throw error;
  }
  return client;
};
