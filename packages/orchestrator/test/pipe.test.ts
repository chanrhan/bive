// 파이프 서버 실연결: Unix 소켓 · system.hello 토큰 · ping · 오류 코드 (M0-05 수용 기준 1, ADR-027 · ADR-039).
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { ErrorCode, PROTOCOL_VERSION } from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { createHandlers } from '../src/ipc/handlers.js';
import { type MethodHandlers, PipeServer, RpcError } from '../src/ipc/server.js';
import { NetPipeTransport } from '../src/ipc/transport.js';
import { type Orchestrator, startOrchestrator } from '../src/orchestrator.js';
import { ORCHESTRATOR_VERSION } from '../src/version.js';
import { connect, RpcCallError, TestClient } from './helpers/client.js';
import { cleanup, makeBiveHome, waitFor } from './helpers/process.js';

const unixOnly = process.platform === 'win32' ? it.skip : it;

const running: Orchestrator[] = [];
const clients: TestClient[] = [];

const start = async (
  options: Partial<Parameters<typeof startOrchestrator>[0]> = {},
): Promise<Orchestrator> => {
  const result = await startOrchestrator({
    biveHome: makeBiveHome(),
    idleShutdownMs: 60_000,
    ...options,
  });
  if (result.status !== 'started') throw new Error('기동 실패');
  running.push(result.orchestrator);
  return result.orchestrator;
};

const open = async (orchestrator: Orchestrator): Promise<TestClient> => {
  const client = await TestClient.open(orchestrator.paths.pipe);
  clients.push(client);
  return client;
};

/** 연결이 닫힐 때까지 기다리고, 받은 오류 응답 1건을 돌려준다. */
const expectRejected = async (client: TestClient): Promise<unknown> => {
  const message = await client.nextUnmatched();
  await client.closed;
  return message;
};

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const orchestrator of running.splice(0)) await orchestrator.stop();
  await cleanup();
});

describe('Unix 소켓 · 인증 · ping', () => {
  unixOnly(
    '$BIVE_HOME/run/orchestrator.sock에서 hello(토큰) 뒤 ping이 pong을 돌려준다',
    async () => {
      const home = makeBiveHome();
      const orchestrator = await start({ biveHome: home });
      expect(orchestrator.paths.pipe).toBe(path.join(home, 'run', 'orchestrator.sock'));
      expect(statSync(orchestrator.paths.pipe).isSocket()).toBe(true);
      expect(statSync(orchestrator.paths.pipe).mode & 0o777).toBe(0o600);

      const token = readFileSync(path.join(home, 'run', 'token'), 'utf8');
      expect(token).toBe(orchestrator.token);

      const client = await open(orchestrator);
      await expect(client.hello(token)).resolves.toEqual({
        orchestratorVersion: ORCHESTRATOR_VERSION,
      });
      await expect(client.call('ping')).resolves.toEqual({
        pong: true,
        version: ORCHESTRATOR_VERSION,
      });
    },
  );

  it('토큰이 틀리면 -32020 응답 후 연결을 닫는다', async () => {
    const orchestrator = await start();
    const client = await open(orchestrator);
    const error = await client.hello(`${orchestrator.token}x`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcCallError);
    expect((error as RpcCallError).code).toBe(ErrorCode.Unauthorized);
    await client.closed;
    expect(client.isClosed).toBe(true);
  });

  it('hello 전의 다른 메서드는 -32020 후 종료', async () => {
    const orchestrator = await start();
    const client = await open(orchestrator);
    const response = await client
      .requestRaw({ jsonrpc: '2.0', id: 1, method: 'ping' })
      .catch(() => null);
    expect(response).toMatchObject({ id: 1, error: { code: ErrorCode.Unauthorized } });
    await client.closed;
  });

  it.each([
    ['알림', JSON.stringify({ jsonrpc: '2.0', method: 'system.hello' })],
    ['JSON 아님', '{not json'],
    ['배열', JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }])],
    ['응답 모양', JSON.stringify({ jsonrpc: '2.0', id: 1, result: null })],
  ])('hello 전 %s → -32020 후 종료', async (_, line) => {
    const orchestrator = await start();
    const client = await open(orchestrator);
    client.sendRaw(line);
    const message = await client.nextUnmatched().catch(() => null);
    expect(message).toMatchObject({ error: { code: ErrorCode.Unauthorized } });
    await client.closed;
  });

  it('hello 형식 위반(프로토콜 버전 불일치)은 -32602 후 종료', async () => {
    const orchestrator = await start();
    const client = await open(orchestrator);
    const response = await client.requestRaw({
      jsonrpc: '2.0',
      id: 'h',
      method: 'system.hello',
      params: { protocolVersion: PROTOCOL_VERSION + 1, token: orchestrator.token },
    });
    expect(response).toMatchObject({ id: 'h', error: { code: ErrorCode.InvalidParams } });
    await client.closed;
  });

  it('hello가 제한 시간 안에 오지 않으면 -32020 후 종료', async () => {
    const orchestrator = await start({ helloTimeoutMs: 100 });
    const client = await open(orchestrator);
    const message = await expectRejected(client);
    expect(message).toMatchObject({ id: null, error: { code: ErrorCode.Unauthorized } });
  });

  it('연결 여러 개가 각자 인증한다', async () => {
    const orchestrator = await start();
    const a = await connect(orchestrator.paths.pipe, orchestrator.token);
    const b = await connect(orchestrator.paths.pipe, orchestrator.token);
    clients.push(a, b);
    await waitFor(() => orchestrator.connectionCount === 2, 2000, '연결 2개');
    const [pa, pb] = await Promise.all([a.call('ping'), b.call('ping')]);
    expect(pa.pong && pb.pong).toBe(true);
    await a.close();
    await waitFor(() => orchestrator.connectionCount === 1, 2000, '연결 1개');
  });
});

describe('인증 뒤 JSON-RPC 디스패치', () => {
  const authed = async (): Promise<{ orchestrator: Orchestrator; client: TestClient }> => {
    const orchestrator = await start();
    const client = await connect(orchestrator.paths.pipe, orchestrator.token);
    clients.push(client);
    return { orchestrator, client };
  };

  it('없는 메서드 -32601, 파라미터 위반 -32602, 형식 위반 -32600', async () => {
    const { client } = await authed();
    await expect(
      client.requestRaw({ jsonrpc: '2.0', id: 1, method: 'nope' }),
    ).resolves.toMatchObject({ id: 1, error: { code: ErrorCode.MethodNotFound } });
    await expect(
      client.requestRaw({ jsonrpc: '2.0', id: 2, method: 'ping', params: { x: 1 } }),
    ).resolves.toMatchObject({ id: 2, error: { code: ErrorCode.InvalidParams } });
    await expect(
      client.requestRaw({ jsonrpc: '1.0', id: 3, method: 'ping' }),
    ).resolves.toMatchObject({ id: 3, error: { code: ErrorCode.InvalidRequest } });
    // 연결은 유지된다
    await expect(client.call('ping')).resolves.toMatchObject({ pong: true });
  });

  it('JSON 해석 실패는 id null의 -32700, 연결 유지', async () => {
    const { client } = await authed();
    client.sendRaw('{"jsonrpc":');
    await expect(client.nextUnmatched()).resolves.toMatchObject({
      id: null,
      error: { code: ErrorCode.ParseError },
    });
    await expect(client.call('ping')).resolves.toMatchObject({ pong: true });
  });

  it('UTF-8 아닌 프레임은 -32700, 연결 유지', async () => {
    const { client } = await authed();
    client.writeBytes(Uint8Array.from([0xff, 0xfe, 0x0a]));
    await expect(client.nextUnmatched()).resolves.toMatchObject({
      id: null,
      error: { code: ErrorCode.ParseError },
    });
    await expect(client.call('ping')).resolves.toMatchObject({ pong: true });
  });

  it('알림(id 없음)에는 응답하지 않는다', async () => {
    const { client } = await authed();
    client.sendRaw(JSON.stringify({ jsonrpc: '2.0', method: 'ping' }));
    client.sendRaw(JSON.stringify({ jsonrpc: '2.0', method: 'event.unknown', params: {} }));
    // 뒤따른 요청의 응답이 먼저 오면, 그 사이 알림에 대한 응답은 없다
    await expect(client.call('ping')).resolves.toMatchObject({ pong: true });
    expect(client.unmatched).toEqual([]);
  });

  it('인증된 연결의 두 번째 hello는 -32009', async () => {
    const { orchestrator, client } = await authed();
    const error = await client.hello(orchestrator.token).catch((e: unknown) => e);
    expect((error as RpcCallError).code).toBe(ErrorCode.StateConflict);
    await expect(client.call('ping')).resolves.toMatchObject({ pong: true });
  });

  it('한 조각에 여러 프레임, 여러 조각에 한 프레임이 와도 처리한다', async () => {
    const { client } = await authed();
    const ping = (id: number): string => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' });
    const responses = Promise.all([10, 11].map((id) => client.waitForResponse(id)));
    const joined = `${ping(10)}\n${ping(11)}\n`;
    client.writeBytes(joined.slice(0, 7));
    client.writeBytes(joined.slice(7));
    const [r10, r11] = await responses;
    expect(r10).toMatchObject({ id: 10, result: { pong: true } });
    expect(r11).toMatchObject({ id: 11, result: { pong: true } });
  });

  it('최대 프레임 크기를 넘으면 -32600 후 종료', async () => {
    const orchestrator = await start({ transport: new NetPipeTransport({ maxFrameBytes: 256 }) });
    const client = await connect(orchestrator.paths.pipe, orchestrator.token);
    clients.push(client);
    client.writeBytes('x'.repeat(1024));
    const message = await expectRejected(client);
    expect(message).toMatchObject({ id: null, error: { code: ErrorCode.InvalidRequest } });
  });
});

describe('처리기 오류 · 결과 검증 (PipeServer 직접)', () => {
  const serve = async (
    handlers: MethodHandlers,
  ): Promise<{ client: TestClient; close: () => Promise<void> }> => {
    const home = makeBiveHome();
    const socketPath = path.join(home, 's.sock');
    const server = new PipeServer({
      transport: new NetPipeTransport(),
      path: socketPath,
      token: 't',
      orchestratorVersion: '9.9.9',
      handlers,
    });
    await server.listen();
    const client = await connect(socketPath, 't');
    clients.push(client);
    return { client, close: () => server.close() };
  };

  it('RpcError는 그 코드로, 그 밖의 예외는 -32603으로 응답한다', async () => {
    const first = await serve({
      ping: () => {
        throw new RpcError(ErrorCode.NotFound, '대상 없음: x', { id: 'x' });
      },
    });
    await expect(first.client.call('ping')).rejects.toMatchObject({
      code: ErrorCode.NotFound,
      data: { id: 'x' },
    });
    await first.close();

    const second = await serve({
      ping: () => Promise.reject(new Error('내부 실패 상세')),
    });
    const error = (await second.client.call('ping').catch((e: unknown) => e)) as RpcCallError;
    expect(error.code).toBe(ErrorCode.InternalError);
    // 내부 예외 메시지는 밖으로 내보내지 않는다
    expect(error.message).not.toContain('내부 실패 상세');
    await second.close();
  });

  it('결과가 메서드 스키마와 다르면 내보내지 않고 -32603', async () => {
    const { client, close } = await serve({
      ping: () => ({ pong: false, version: '' }) as never,
    });
    await expect(client.call('ping')).rejects.toMatchObject({ code: ErrorCode.InternalError });
    await close();
  });

  it('처리기가 없는 등록 메서드는 -32601', async () => {
    const { client, close } = await serve({});
    await expect(client.call('ping')).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
    await close();
  });

  it('기본 처리기의 ping은 주어진 버전을 돌려준다', async () => {
    const { client, close } = await serve(createHandlers({ orchestratorVersion: '9.9.9' }));
    await expect(client.call('ping')).resolves.toEqual({ pong: true, version: '9.9.9' });
    await close();
  });
});

describe('토큰 파일 · 종료 정리', () => {
  unixOnly(
    '토큰은 0600이고 기동마다 바뀌며, 종료하면 소켓 · 토큰 · 잠금 파일을 지운다',
    async () => {
      const home = makeBiveHome();
      const first = await start({ biveHome: home });
      const { token: tokenPath, pid: pidPath, pipe, dir } = first.paths;
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(readFileSync(pidPath, 'utf8').trim()).toBe(String(process.pid));
      await first.stop();
      await expect(first.closed).resolves.toBe('requested');
      expect(existsSync(pipe)).toBe(false);
      expect(existsSync(tokenPath)).toBe(false);
      expect(existsSync(pidPath)).toBe(false);

      const second = await start({ biveHome: home });
      expect(second.token).not.toBe(first.token);
      // 이전 토큰은 거부된다
      const client = await open(second);
      await expect(client.hello(first.token)).rejects.toMatchObject({
        code: ErrorCode.Unauthorized,
      });
    },
  );

  unixOnly('종료 때 다른 인스턴스가 새로 만든 소켓 · 토큰은 지우지 않는다', async () => {
    const orchestrator = await start();
    const { pipe, token: tokenPath, pid: pidPath } = orchestrator.paths;
    // 경합에서 다른 인스턴스가 같은 경로에 새 소켓을 bind하고 토큰을 다시 쓴 상황
    unlinkSync(pipe);
    const other = net.createServer((socket) => socket.end('other\n'));
    await new Promise<void>((resolve) => other.listen(pipe, resolve));
    writeFileSync(tokenPath, 'other-token', { mode: 0o600 });
    writeFileSync(pidPath, '999999\n');
    try {
      await orchestrator.stop();
      expect(statSync(pipe).isSocket()).toBe(true);
      expect(readFileSync(tokenPath, 'utf8')).toBe('other-token');
      expect(readFileSync(pidPath, 'utf8')).toBe('999999\n');
      // 옮겨 두었다 되돌린 소켓은 여전히 다른 인스턴스로 연결된다
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(pipe);
        let data = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => (data += chunk));
        socket.on('end', () => resolve(data));
        socket.on('error', reject);
      });
      expect(reply).toBe('other\n');
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
});
