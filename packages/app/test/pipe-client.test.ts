// pipe-client 단위 테스트: 가짜 net으로 접속 순서 · 검증 · 응답 짝짓기 · 알림 · 끊김을 확인한다.
import { ErrorCode, PROTOCOL_VERSION } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  CONNECTION_CLOSED_MESSAGE,
  connectPipe,
  PipeClient,
  PipeRpcError,
} from '../src/main/pipe-client.js';
import { createFakeNet, type FakeSocket } from './helpers/fake-net.js';

interface Req {
  id: number;
  method: string;
  params?: unknown;
}

/** 오케스트레이터 흉내: hello(토큰 good) · ping. */
const respond = (line: string, socket: FakeSocket): void => {
  const req = JSON.parse(line) as Req;
  if (req.method === 'system.hello') {
    const { token } = req.params as { token: string };
    if (token === 'good') {
      socket.send({ jsonrpc: '2.0', id: req.id, result: { orchestratorVersion: '0.0.0' } });
    } else {
      socket.send({ jsonrpc: '2.0', id: req.id, error: { code: -32020, message: '토큰 불일치' } });
    }
    return;
  }
  if (req.method === 'ping') {
    socket.send({ jsonrpc: '2.0', id: req.id, result: { pong: true, version: '0.0.0' } });
  }
};

const rejection = async (promise: Promise<unknown>): Promise<PipeRpcError> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PipeRpcError);
  return error as PipeRpcError;
};

describe('pipe-client', () => {
  it('connect → system.hello(token) 순서로 인증하고 ping 결과를 검증해 돌려준다', async () => {
    const net = createFakeNet(respond);
    const client = await connectPipe('/x/orchestrator.sock', 'good', net);
    expect(net.paths).toEqual(['/x/orchestrator.sock']);
    const [socket] = net.sockets;
    const first = JSON.parse(socket?.written[0] ?? '{}') as Req;
    expect(first).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'system.hello',
      params: { protocolVersion: PROTOCOL_VERSION, token: 'good' },
    });

    await expect(client.call('ping')).resolves.toEqual({ pong: true, version: '0.0.0' });
    // 파라미터 없는 메서드는 params 키를 보내지 않는다
    expect(JSON.parse(socket?.written[1] ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 2,
      method: 'ping',
    });
    await client.close();
    expect(client.isClosed).toBe(true);
  });

  it('토큰이 틀리면 -32020으로 거부하고 소켓을 끊는다', async () => {
    const net = createFakeNet(respond);
    const error = await rejection(connectPipe('/x', 'bad', net));
    expect(error.code).toBe(ErrorCode.Unauthorized);
    expect(net.sockets[0]?.destroyed).toBe(true);
  });

  it('접속 실패는 net 오류 코드(ENOENT)를 그대로 전한다', async () => {
    const net = createFakeNet(respond, () => 'ENOENT');
    await expect(PipeClient.open('/x', net)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('보내기 전에 검증한다: 없는 메서드 -32601, 파라미터 불일치 -32602 (아무것도 쓰지 않음)', async () => {
    const net = createFakeNet(respond);
    const client = await connectPipe('/x', 'good', net);
    const socket = net.sockets[0];
    const before = socket?.written.length;

    expect((await rejection(client.request('project.create', {}))).code).toBe(
      ErrorCode.MethodNotFound,
    );
    const invalid = await rejection(client.request('ping', { extra: 1 }));
    expect(invalid.code).toBe(ErrorCode.InvalidParams);
    expect(invalid.data).toMatchObject({ issues: expect.any(Array) });
    expect(socket?.written.length).toBe(before);
    await client.close();
  });

  it('결과가 메서드 스키마와 다르면 -32602, 오류 응답은 그 오류로 거부한다', async () => {
    let mode: 'bad-result' | 'error' = 'bad-result';
    const net = createFakeNet((line, socket) => {
      const req = JSON.parse(line) as Req;
      if (req.method === 'system.hello') return respond(line, socket);
      if (mode === 'bad-result')
        socket.send({ jsonrpc: '2.0', id: req.id, result: { pong: 'yes' } });
      else
        socket.send({ jsonrpc: '2.0', id: req.id, error: { code: -32009, message: '상태 충돌' } });
    });
    const client = await connectPipe('/x', 'good', net);
    expect((await rejection(client.request('ping'))).code).toBe(ErrorCode.InvalidParams);
    mode = 'error';
    const error = await rejection(client.request('ping'));
    expect(error.toErrorObject()).toEqual({ code: -32009, message: '상태 충돌' });
    await client.close();
  });

  it('응답을 id로 짝짓는다: 순서가 바뀌고 조각나 도착해도 각 요청에 맞는 결과', async () => {
    const held: Req[] = [];
    const net = createFakeNet((line, socket) => {
      const req = JSON.parse(line) as Req;
      if (req.method === 'system.hello') return respond(line, socket);
      held.push(req);
      if (held.length === 2) {
        const [a, b] = held;
        // 두 번째 응답을 먼저, 줄을 두 조각으로 나눠 보낸다
        const second = `${JSON.stringify({ jsonrpc: '2.0', id: b?.id, result: { pong: true, version: 'b' } })}\r\n`;
        socket.push(second.slice(0, 10));
        socket.push(second.slice(10));
        socket.send({ jsonrpc: '2.0', id: a?.id, result: { pong: true, version: 'a' } });
      }
    });
    const client = await connectPipe('/x', 'good', net);
    const [a, b] = await Promise.all([client.call('ping'), client.call('ping')]);
    expect(a.version).toBe('a');
    expect(b.version).toBe('b');
    await client.close();
  });

  it('연결이 닫히면 기다리던 요청을 -32603 연결 끊김으로 거부하고 onClose를 부른다', async () => {
    const net = createFakeNet((line, socket) => {
      const req = JSON.parse(line) as Req;
      if (req.method === 'system.hello') return respond(line, socket);
      socket.destroy();
    });
    const client = await connectPipe('/x', 'good', net);
    let closedCalls = 0;
    client.onClose(() => {
      closedCalls += 1;
    });
    const error = await rejection(client.request('ping'));
    expect(error.code).toBe(ErrorCode.InternalError);
    expect(error.message).toBe(CONNECTION_CLOSED_MESSAGE);
    expect(closedCalls).toBe(1);
    // 닫힌 뒤 요청은 보내지 않고 바로 거부한다
    expect((await rejection(client.request('ping'))).message).toBe(CONNECTION_CLOSED_MESSAGE);
  });

  it('알림은 등록된 이름만 전달하고 JSON 아닌 줄 · 모르는 id는 무시한다', async () => {
    const net = createFakeNet(respond);
    const client = await connectPipe('/x', 'good', net);
    const received: unknown[] = [];
    client.onNotification((n) => received.push(n));
    const socket = net.sockets[0];
    socket?.push('not json\n');
    socket?.send({ jsonrpc: '2.0', id: 999, result: {} });
    // NOTIFICATIONS가 아직 비어 있으므로 어떤 알림도 전달되지 않는다
    socket?.send({ jsonrpc: '2.0', method: 'event.unknown', params: {} });
    await expect(client.call('ping')).resolves.toMatchObject({ pong: true });
    expect(received).toEqual([]);
    await client.close();
  });
});
