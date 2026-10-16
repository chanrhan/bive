// 소켓 없는 가짜 `net` (pipe-client 단위 테스트용). 클라이언트가 쓴 줄을 받아 응답을 흘려보낸다.
import { EventEmitter } from 'node:events';

import type { PipeNet, PipeSocket } from '../../src/main/pipe-client.js';

export class FakeSocket extends EventEmitter implements PipeSocket {
  readonly written: string[] = [];
  ended = false;
  destroyed = false;
  onLine: (line: string, socket: FakeSocket) => void = () => undefined;

  setEncoding(): this {
    return this;
  }

  write(data: string): boolean {
    this.written.push(data);
    for (const line of data.split('\n')) {
      if (line.length > 0) queueMicrotask(() => this.onLine(line, this));
    }
    return true;
  }

  /** 서버 → 클라이언트 원문 조각. */
  push(chunk: string): void {
    this.emit('data', chunk);
  }

  /** 서버 → 클라이언트 JSON 1줄. */
  send(message: unknown): void {
    this.push(`${JSON.stringify(message)}\n`);
  }

  end(): this {
    this.ended = true;
    queueMicrotask(() => this.emit('close'));
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
    return this;
  }
}

export interface FakeNet extends PipeNet {
  readonly sockets: FakeSocket[];
  readonly paths: string[];
}

/**
 * `connectError`가 있으면 그 코드(ENOENT 등)로 접속 실패, 없으면 접속 성공 후 `onLine`으로 응답한다.
 */
export const createFakeNet = (
  onLine: (line: string, socket: FakeSocket) => void,
  connectError?: () => string | null,
): FakeNet => {
  const sockets: FakeSocket[] = [];
  const paths: string[] = [];
  return {
    sockets,
    paths,
    createConnection(path: string) {
      paths.push(path);
      const socket = new FakeSocket();
      socket.onLine = onLine;
      sockets.push(socket);
      const code = connectError?.() ?? null;
      queueMicrotask(() => {
        if (code === null) {
          socket.emit('connect');
        } else {
          socket.emit('error', Object.assign(new Error(code), { code }));
        }
      });
      return socket;
    },
  };
};
