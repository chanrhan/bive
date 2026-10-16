// 줄 단위 프레이밍 · Node net 전송 (architecture.md 5장, 8장 IPC 층).
import { writeFileSync } from 'node:fs';
import path from 'node:path';

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
