// 렌더러 요청 처리(`bive:rpc`)와 브리지 계약 상수.
import { spawn as nodeSpawn } from 'node:child_process';

import { ErrorCode, rpcError } from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { BRIDGE_KEYS, EVENT_CHANNEL, RPC_CHANNEL } from '../src/common/bridge.js';
import { orchestratorCommand, type SpawnFn } from '../src/main/orchestrator-launch.js';
import { PipeRpcError } from '../src/main/pipe-client.js';
import { handleRendererRpc, type RpcTarget } from '../src/main/rpc-bridge.js';
import { CONNECT_FAILED_MESSAGE, startMainSession } from '../src/main/session.js';
import { cleanup, makeBiveHome, ORCHESTRATOR_DIR } from './helpers/orchestrator.js';

const target = (impl: RpcTarget['request']): RpcTarget & { calls: unknown[][] } => {
  const calls: unknown[][] = [];
  return {
    calls,
    request: (method, params) => {
      calls.push([method, params]);
      return impl(method, params);
    },
  };
};

describe('handleRendererRpc', () => {
  it('성공 결과를 { ok: true, result }로 돌려준다', async () => {
    const t = target(() => Promise.resolve({ pong: true, version: '1' }));
    await expect(handleRendererRpc(t, { method: 'ping' })).resolves.toEqual({
      ok: true,
      result: { pong: true, version: '1' },
    });
    expect(t.calls).toEqual([['ping', undefined]]);
  });

  it('JSON-RPC 오류는 오류 객체 그대로 { ok: false, error }', async () => {
    const t = target(() =>
      Promise.reject(new PipeRpcError(rpcError(ErrorCode.NotFound, '대상 없음', { id: 'x' }))),
    );
    await expect(handleRendererRpc(t, { method: 'ping' })).resolves.toEqual({
      ok: false,
      error: { code: ErrorCode.NotFound, message: '대상 없음', data: { id: 'x' } },
    });
  });

  it('그 밖의 예외는 내부 메시지를 숨기고 -32603', async () => {
    const t = target(() => Promise.reject(new Error('비밀 경로 /root/x')));
    await expect(handleRendererRpc(t, { method: 'ping' })).resolves.toEqual({
      ok: false,
      error: { code: ErrorCode.InternalError, message: '내부 오류' },
    });
  });

  it('형식이 틀린 요청은 -32600, system.hello는 -32020 (파이프로 보내지 않음)', async () => {
    const t = target(() => Promise.resolve(null));
    for (const payload of [null, 'ping', { method: 1 }, { method: '' }, []]) {
      const outcome = await handleRendererRpc(t, payload);
      expect(outcome).toMatchObject({ ok: false, error: { code: ErrorCode.InvalidRequest } });
    }
    const hello = await handleRendererRpc(t, { method: 'system.hello', params: { token: 'x' } });
    expect(hello).toMatchObject({ ok: false, error: { code: ErrorCode.Unauthorized } });
    expect(t.calls).toEqual([]);
  });

  it('없는 메서드는 -32601, 파라미터 불일치는 -32602(issues 포함)로 접속 전에 거부한다', async () => {
    const t = target(() => Promise.resolve(null));
    const missing = await handleRendererRpc(t, { method: 'nope' });
    expect(missing).toEqual({
      ok: false,
      error: { code: ErrorCode.MethodNotFound, message: '없는 메서드: nope' },
    });
    const invalid = await handleRendererRpc(t, { method: 'ping', params: { extra: 1 } });
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: ErrorCode.InvalidParams, data: { issues: expect.any(Array) } },
    });
    expect(t.calls).toEqual([]);
  });

  it('main 메서드: 처리기 없으면 -32601, 파라미터를 넣으면 -32602, 처리기 예외는 -32603 (파이프로 보내지 않음)', async () => {
    const t = target(() => Promise.resolve(null));
    const logs: string[] = [];
    const log = (message: string): void => {
      logs.push(message);
    };
    await expect(handleRendererRpc(t, { method: 'app.pickFolder' }, { log })).resolves.toEqual({
      ok: false,
      error: { code: ErrorCode.MethodNotFound, message: '없는 메서드: app.pickFolder' },
    });
    const appMethods = { 'app.pickFolder': () => Promise.resolve({ path: '/x' }) };
    await expect(
      handleRendererRpc(t, { method: 'app.pickFolder', params: {} }, { appMethods, log }),
    ).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.InvalidParams } });
    const failing = { 'app.pickFolder': () => Promise.reject(new Error('/secret/path 실패')) };
    await expect(
      handleRendererRpc(t, { method: 'app.pickFolder' }, { appMethods: failing, log }),
    ).resolves.toEqual({
      ok: false,
      error: { code: ErrorCode.InternalError, message: '내부 오류' },
    });
    expect(logs).toEqual(['app.pickFolder 실패: /secret/path 실패']);
    expect(t.calls).toEqual([]);
  });

  it('onResult는 파이프 성공 뒤에만 부르고, 그 예외는 응답을 바꾸지 않는다', async () => {
    const seen: unknown[][] = [];
    const logs: string[] = [];
    const ok = target(() => Promise.resolve({ pong: true, version: '1' }));
    const outcome = await handleRendererRpc(
      ok,
      { method: 'ping' },
      {
        onResult: (method, result) => {
          seen.push([method, result]);
          throw new Error('후처리 오류');
        },
        log: (message) => logs.push(message),
      },
    );
    expect(outcome).toEqual({ ok: true, result: { pong: true, version: '1' } });
    expect(seen).toEqual([['ping', { pong: true, version: '1' }]]);
    expect(logs).toEqual(['ping 후처리 실패: 후처리 오류']);

    const failed = target(() => Promise.reject(new PipeRpcError(rpcError(ErrorCode.NotFound))));
    await handleRendererRpc(failed, { method: 'ping' }, { onResult: (m, r) => seen.push([m, r]) });
    expect(seen).toHaveLength(1);
  });
});

describe('handleRendererRpc + main 세션 (오케스트레이터 없음)', () => {
  afterEach(cleanup);

  const sessionWithoutOrchestrator = (nodePath: string) => {
    const home = makeBiveHome();
    let spawns = 0;
    const logs: string[] = [];
    const spawn: SpawnFn = (command, args, options) => {
      spawns += 1;
      return nodeSpawn(command, args, options);
    };
    const command = orchestratorCommand({
      mode: 'source',
      orchestratorDir: ORCHESTRATOR_DIR,
      nodePath,
      biveHome: home,
      env: process.env,
    });
    const session = startMainSession({
      biveHome: home,
      command,
      spawn,
      timeoutMs: 1000,
      log: (m) => logs.push(m),
    });
    return { session, logs, spawns: () => spawns };
  };

  it('없는 메서드 · 파라미터 불일치는 기동을 시도하지 않는다', async () => {
    const { session, spawns } = sessionWithoutOrchestrator(process.execPath);
    await expect(handleRendererRpc(session.link, { method: 'nope' })).resolves.toMatchObject({
      error: { code: ErrorCode.MethodNotFound },
    });
    await expect(
      handleRendererRpc(session.link, { method: 'ping', params: { extra: 1 } }),
    ).resolves.toMatchObject({ error: { code: ErrorCode.InvalidParams } });
    expect(spawns()).toBe(0);
    expect(session.link.state).toBe('disconnected');
    session.dispose();
  });

  it('접속 실패 응답은 -32603 메시지만 싣고 data가 없다 (상세 · 경로는 main 로그에만)', async () => {
    const { session, logs, spawns } = sessionWithoutOrchestrator('/nonexistent/bive-node');
    const outcome = await handleRendererRpc(session.link, { method: 'ping' });
    expect(spawns()).toBe(1);
    expect(outcome).toEqual({
      ok: false,
      error: { code: ErrorCode.InternalError, message: CONNECT_FAILED_MESSAGE },
    });
    expect(JSON.stringify(outcome)).not.toContain('/nonexistent');
    expect(outcome.ok === false && 'data' in outcome.error).toBe(false);
    expect(logs.join('\n')).toContain('/nonexistent/bive-node');
    session.dispose();
  });
});

describe('브리지 계약', () => {
  it('채널 이름과 window.bive 키 (#10 · #13의 가짜 브리지가 따른다)', () => {
    expect(RPC_CHANNEL).toBe('bive:rpc');
    expect(EVENT_CHANNEL).toBe('bive:event');
    expect(BRIDGE_KEYS).toEqual(['invoke', 'on']);
  });
});
