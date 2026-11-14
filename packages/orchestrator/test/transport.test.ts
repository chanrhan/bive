// 줄 단위 프레이밍 · Node net 전송 (architecture.md 5장, 8장 IPC 층).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type FrameConnection,
  LineFramer,
  NetPipeTransport,
  type PipeListener,
} from '../src/ipc/transport.js';
import { cleanup, makeBiveHome, waitFor } from './helpers/process.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('LineFramer', () => {
  it('한 조각의 여러 줄을 나누고 빈 줄 · 줄 끝 \\r을 버린다', () => {
    const framer = new LineFramer();
    expect(framer.push(enc('a\nb\r\n\n\r\nc'))).toEqual([
      { kind: 'frame', text: 'a' },
      { kind: 'frame', text: 'b' },
    ]);
    expect(framer.push(enc('d\n'))).toEqual([{ kind: 'frame', text: 'cd' }]);
  });

  it('여러 조각에 걸친 다중 바이트 문자를 온전히 잇는다', () => {
    const framer = new LineFramer();
    const bytes = enc('{"t":"한글"}\n');
    const out = [];
    for (const byte of bytes) out.push(...framer.push(Uint8Array.of(byte)));
    expect(out).toEqual([{ kind: 'frame', text: '{"t":"한글"}' }]);
  });

  it('UTF-8 아닌 줄은 오류, 다음 줄은 정상', () => {
    const framer = new LineFramer();
    expect(framer.push(Uint8Array.from([0xc3, 0x28, 0x0a, 0x61, 0x0a]))).toEqual([
      { kind: 'error', error: 'invalid-utf8' },
      { kind: 'frame', text: 'a' },
    ]);
  });

  it('최대 크기를 넘으면 오류 1회 뒤 모든 입력을 무시한다', () => {
    const framer = new LineFramer(4);
    expect(framer.push(enc('abcd\n'))).toEqual([{ kind: 'frame', text: 'abcd' }]);
    expect(framer.push(enc('abc'))).toEqual([]);
    expect(framer.push(enc('de'))).toEqual([{ kind: 'error', error: 'frame-too-large' }]);
    expect(framer.overflowed).toBe(true);
    expect(framer.push(enc('ok\n'))).toEqual([]);
  });

  it('잘못된 최대 크기는 거부', () => {
    expect(() => new LineFramer(0)).toThrow(RangeError);
    expect(() => new NetPipeTransport({ maxFrameBytes: 1.5 })).toThrow(RangeError);
  });
});

describe('NetPipeTransport', () => {
  const listeners: PipeListener[] = [];

  afterEach(async () => {
    for (const listener of listeners.splice(0)) await listener.close();
    await cleanup();
  });

  it('listen · connect로 프레임을 주고받고, close가 열린 연결을 닫는다', async () => {
    const socketPath = path.join(makeBiveHome(), 't.sock');
    const transport = new NetPipeTransport();
    const serverSide: FrameConnection[] = [];
    const listener = await transport.listen(socketPath, (connection) => {
      serverSide.push(connection);
      connection.onFrame((frame) => connection.send(`echo:${frame}`));
    });
    listeners.push(listener);

    const client = await transport.connect(socketPath);
    const received: string[] = [];
    client.onFrame((frame) => received.push(frame));
    let clientClosed = false;
    client.onClose(() => (clientClosed = true));
    client.send('하나');
    client.send('둘');
    await waitFor(() => received.length === 2, 2000, '에코 2건');
    expect(received).toEqual(['echo:하나', 'echo:둘']);
    expect(() => client.send('a\nb')).toThrow();

    await listener.close();
    await waitFor(() => clientClosed, 2000, '클라이언트 닫힘');
    expect(serverSide[0]?.closed).toBe(true);
  });

  it('이미 있는 경로에는 listen하지 않는다', async () => {
    const socketPath = path.join(makeBiveHome(), 'busy.sock');
    writeFileSync(socketPath, '');
    await expect(new NetPipeTransport().listen(socketPath, () => undefined)).rejects.toThrow();
  });

  it('듣는 쪽이 없으면 connect 실패', async () => {
    const socketPath = path.join(makeBiveHome(), 'none.sock');
    await expect(new NetPipeTransport().connect(socketPath)).rejects.toThrow();
  });
});

/**
 * 다른 스레드(자기 이벤트 루프)에서 소켓을 읽는 상대. 오케스트레이터 쪽 루프가 막혀 있어도 계속 읽는다.
 * - `steady`: 받는 대로 읽는다 · `slow`: 조각을 받을 때마다 `pauseMs` 쉬고 다시 읽는다 · `stalled`: 읽지 않는다
 * `last` 줄까지 받으면 `sawLast`가 참이 되고, 연결이 닫히면 `closed`가 참이 된다. 읽기를 멈춘 소켓은 이벤트 루프를
 * 붙잡지 않으므로(멈춘 상대의 스레드가 바로 끝나 소켓이 닫힘) 타이머로 루프를 붙잡는다. 스레드가 끝나면 `exited`가 참.
 */
const READER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const net = require('node:net');
const socket = net.createConnection(workerData.path);
socket.on('error', () => undefined);
if (workerData.mode === 'stalled') socket.pause();
let tail = '';
socket.on('data', (chunk) => {
  tail = (tail + chunk.toString('latin1')).slice(-16);
  if (tail.endsWith('last\\n')) parentPort.postMessage('last');
  if (workerData.mode === 'slow') {
    socket.pause();
    setTimeout(() => socket.resume(), workerData.pauseMs);
  }
});
socket.on('close', () => parentPort.postMessage('closed'));
setInterval(() => undefined, 1 << 30);
`;

interface Reader {
  sawLast: boolean;
  closed: boolean;
  exited: boolean;
  stop(): Promise<number>;
}

const startReader = (
  socketPath: string,
  mode: 'steady' | 'slow' | 'stalled',
  pauseMs = 0,
): Reader => {
  const worker = new Worker(READER_SOURCE, {
    eval: true,
    workerData: { path: socketPath, mode, pauseMs },
  });
  const reader: Reader = {
    sawLast: false,
    closed: false,
    exited: false,
    stop: () => worker.terminate(),
  };
  worker.on('exit', () => (reader.exited = true));
  worker.on('message', (message: string) => {
    if (message === 'last') reader.sawLast = true;
    if (message === 'closed') reader.closed = true;
  });
  return reader;
};

/** 이 스레드의 이벤트 루프를 `ms` 동안 동기로 막는다 (긴 동기 처리 재현). */
const blockEventLoop = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** 상대의 수신 버퍼 · 커널 버퍼를 넘치게 할 만큼의 프레임 (512KB × 8). */
const BIG_FRAME = 'x'.repeat(512 * 1024);
const fill = (connection: FrameConnection): void => {
  for (let i = 0; i < 8; i += 1) connection.send(BIG_FRAME);
};

describe('sendFlushed 송신 상한: 총 시간이 아니라 진척 없음 (ADR-076)', () => {
  const listeners: PipeListener[] = [];
  const readers: Reader[] = [];

  afterEach(async () => {
    for (const reader of readers.splice(0)) await reader.stop();
    for (const listener of listeners.splice(0)) await listener.close();
    await cleanup();
  });

  const accept = async (
    mode: 'steady' | 'slow' | 'stalled',
    pauseMs = 0,
  ): Promise<{ connection: FrameConnection; reader: Reader }> => {
    const socketPath = path.join(makeBiveHome(), 'f.sock');
    let accepted: FrameConnection | null = null;
    const listener = await new NetPipeTransport().listen(socketPath, (connection) => {
      accepted = connection;
    });
    listeners.push(listener);
    const reader = startReader(socketPath, mode, pauseMs);
    readers.push(reader);
    await waitFor(() => accepted !== null, 2000, '연결 수락');
    return { connection: accepted as unknown as FrameConnection, reader };
  };

  it('쓰기가 밀린 채 이벤트 루프가 상한보다 오래 막혀도, 그동안 읽던 연결은 끊지 않고 쓰기가 끝나면 풀린다', async () => {
    const { connection, reader } = await accept('steady');
    // check 단계(setImmediate)에서 막으면 루프가 다시 돌 때 타이머 단계가 쓰기 가능(poll) 처리보다 먼저 온다
    const flushed = await new Promise<Promise<void>>((resolve) => {
      setImmediate(() => {
        fill(connection);
        const pending = connection.sendFlushed('last', 200);
        blockEventLoop(600);
        resolve(pending);
      });
    });
    await flushed;
    expect(connection.closed).toBe(false);
    await waitFor(() => reader.sawLast, 3000, '상대가 마지막 프레임까지 받음');
    expect(reader.closed).toBe(false);
    expect(reader.exited).toBe(false);
    expect(connection.closed).toBe(false);
  }, 10_000);

  it('느리지만 계속 읽는 상대는 전송 총 시간이 상한을 넘어도 끊지 않는다', async () => {
    const { connection, reader } = await accept('slow', 25);
    fill(connection);
    const started = Date.now();
    await connection.sendFlushed('last', 300);
    // 상한보다 오래 걸린 전송이다 (총 시간 기준이면 끊겼을 것)
    expect(Date.now() - started).toBeGreaterThan(300);
    expect(connection.closed).toBe(false);
    await waitFor(() => reader.sawLast, 3000, '상대가 마지막 프레임까지 받음');
    expect(reader.closed).toBe(false);
    expect(reader.exited).toBe(false);
    expect(connection.closed).toBe(false);
  }, 10_000);

  it('읽지 않는 상대는 상한 동안 진척이 없으면 끊고 풀린다', async () => {
    const { connection, reader } = await accept('stalled');
    fill(connection);
    const started = Date.now();
    let settled = false;
    const flushed = connection.sendFlushed('last', 200).then(() => (settled = true));
    // 상한 전: 풀리지 않았고 연결 · 상대가 살아 있다 (상대가 먼저 끝나 쓰기가 오류로 끝난 것이 아님)
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    expect(connection.closed).toBe(false);
    expect(reader.closed).toBe(false);
    expect(reader.exited).toBe(false);
    await flushed;
    const elapsed = Date.now() - started;
    // 타이머는 이벤트 루프가 반복 처음에 잡아 둔 시각부터 재므로 `Date.now()` 기준으로 일찍 올 수 있다.
    // 하한은 여유를 두어 150ms로 둔다. 상한(200ms) 전에 풀리지 않았음은 위 100ms 시점 확인이 함께 본다
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2000);
    await waitFor(() => connection.closed, 2000, '연결 닫힘');
    expect(reader.sawLast).toBe(false);
    expect(reader.exited).toBe(false);
  }, 10_000);
});
