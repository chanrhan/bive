// 파이프 전송 계층 (architecture.md 5장).
// 프레임 = UTF-8 텍스트 1줄 (`\n` 구분). JSON 해석 · JSON-RPC 의미는 위 계층(server.ts)이 맡는다.
// 구현은 Node `net` 하나로 Unix 소켓과 Windows named pipe를 함께 다룬다.
import { chmodSync } from 'node:fs';
import net from 'node:net';

/** 프레임 1개의 기본 최대 크기 (개행 제외). 넘으면 연결을 닫는다 (ADR-041). */
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/** 프레임 계층 오류: 최대 크기 초과 · UTF-8 아닌 바이트. */
export type FrameErrorKind = 'frame-too-large' | 'invalid-utf8';

export type FramerOutput =
  { kind: 'frame'; text: string } | { kind: 'error'; error: FrameErrorKind };

/**
 * 바이트 조각을 줄 프레임으로 자른다. 줄 끝의 `\r`은 떼고 빈 줄은 버린다.
 * 최대 크기를 넘으면 오류를 한 번 내고 그 뒤 입력은 모두 무시한다 (경계를 신뢰할 수 없으므로).
 */
export class LineFramer {
  readonly #maxFrameBytes: number;
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #overflowed = false;

  constructor(maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new RangeError(`최대 프레임 크기는 양의 정수여야 함: ${maxFrameBytes}`);
    }
    this.#maxFrameBytes = maxFrameBytes;
  }

  get overflowed(): boolean {
    return this.#overflowed;
  }

  push(chunk: Uint8Array): FramerOutput[] {
    const out: FramerOutput[] = [];
    if (this.#overflowed) return out;
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (;;) {
      const newline = buffer.indexOf(NEWLINE, start);
      const end = newline === -1 ? buffer.length : newline;
      if (this.#pendingBytes + (end - start) > this.#maxFrameBytes) {
        this.#overflowed = true;
        this.#pending = [];
        this.#pendingBytes = 0;
        out.push({ kind: 'error', error: 'frame-too-large' });
        return out;
      }
      if (newline === -1) {
        if (end > start) {
          // 받은 버퍼를 계속 붙잡지 않도록 복사해 둔다
          this.#pending.push(Buffer.from(buffer.subarray(start, end)));
          this.#pendingBytes += end - start;
        }
        return out;
      }
      const part = buffer.subarray(start, end);
      const line = this.#pendingBytes > 0 ? Buffer.concat([...this.#pending, part]) : part;
      this.#pending = [];
      this.#pendingBytes = 0;
      start = newline + 1;
      const trimmed =
        line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN
          ? line.subarray(0, line.length - 1)
          : line;
      if (trimmed.length === 0) continue;
      try {
        out.push({ kind: 'frame', text: this.#decoder.decode(trimmed) });
      } catch {
        out.push({ kind: 'error', error: 'invalid-utf8' });
      }
    }
  }
}

/** 프레임 단위 연결 1개. 리스너는 연결을 받은 직후(같은 틱) 붙인다. */
export interface FrameConnection {
  /** 프레임 1개(개행 없는 한 줄)를 보낸다. 닫힌 연결이면 무시. */
  send(frame: string): void;
  /** 보낸 내용을 흘려보낸 뒤 닫는다. */
  end(): void;
  /** 즉시 닫는다. */
  destroy(): void;
  readonly closed: boolean;
  onFrame(listener: (frame: string) => void): void;
  onFrameError(listener: (error: FrameErrorKind) => void): void;
  onClose(listener: () => void): void;
}

export interface PipeListener {
  readonly path: string;
  /** 새 연결을 받지 않고, 열린 연결을 모두 닫은 뒤 끝난다. */
  close(): Promise<void>;
}

/** 파이프 전송 추상화. Unix 소켓 · Windows named pipe를 같은 모양으로 다룬다. */
export interface PipeTransport {
  listen(path: string, onConnection: (connection: FrameConnection) => void): Promise<PipeListener>;
  connect(path: string): Promise<FrameConnection>;
}

class NetFrameConnection implements FrameConnection {
  readonly #socket: net.Socket;
  readonly #framer: LineFramer;
  readonly #frameListeners: ((frame: string) => void)[] = [];
  readonly #errorListeners: ((error: FrameErrorKind) => void)[] = [];
  readonly #closeListeners: (() => void)[] = [];
  #closed = false;

  constructor(socket: net.Socket, maxFrameBytes: number) {
    this.#socket = socket;
    this.#framer = new LineFramer(maxFrameBytes);
    socket.on('data', (chunk: Buffer) => {
      for (const item of this.#framer.push(chunk)) {
        if (item.kind === 'frame') {
          for (const listener of this.#frameListeners) listener(item.text);
        } else {
          for (const listener of this.#errorListeners) listener(item.error);
        }
      }
    });
    // 소켓 오류(상대가 끊음 등)는 close로 이어지므로 여기서는 삼킨다
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.#closed = true;
      for (const listener of this.#closeListeners) listener();
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(frame: string): void {
    if (frame.includes('\n')) throw new Error('프레임에 개행을 넣을 수 없음');
    if (this.#closed || this.#socket.writableEnded) return;
    this.#socket.write(`${frame}\n`);
  }

  end(): void {
    if (this.#closed) return;
    this.#socket.end();
    // 상대가 반쪽 연결을 붙잡아도 오래 남지 않게 한다
    setTimeout(() => this.#socket.destroy(), 1000).unref();
  }

  destroy(): void {
    this.#socket.destroy();
  }

  onFrame(listener: (frame: string) => void): void {
    this.#frameListeners.push(listener);
  }

  onFrameError(listener: (error: FrameErrorKind) => void): void {
    this.#errorListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.#closeListeners.push(listener);
  }
}

export interface NetPipeTransportOptions {
  maxFrameBytes?: number;
  platform?: NodeJS.Platform;
}

/** Node `net` 기반 구현. Unix 소켓은 기동 직후 0600으로 바꾼다. */
export class NetPipeTransport implements PipeTransport {
  readonly #maxFrameBytes: number;
  readonly #platform: NodeJS.Platform;

  constructor(options: NetPipeTransportOptions = {}) {
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.#platform = options.platform ?? process.platform;
    // 잘못된 값을 생성 시점에 거른다
    new LineFramer(this.#maxFrameBytes);
  }

  listen(path: string, onConnection: (connection: FrameConnection) => void): Promise<PipeListener> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      onConnection(new NetFrameConnection(socket, this.#maxFrameBytes));
    });
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(path, () => {
        server.off('error', onError);
        server.on('error', () => undefined);
        if (this.#platform !== 'win32') {
          try {
            chmodSync(path, 0o600);
          } catch (error) {
            server.close();
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
        }
        let closing: Promise<void> | null = null;
        resolve({
          path,
          close: () => {
            closing ??= new Promise<void>((done) => {
              server.close(() => done());
              for (const socket of sockets) socket.destroy();
            });
            return closing;
          },
        });
      });
    });
  }

  connect(path: string): Promise<FrameConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(path);
      const onError = (error: Error): void => reject(error);
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        resolve(new NetFrameConnection(socket, this.#maxFrameBytes));
      });
    });
  }
}
