// 렌더러 요청 처리(`bive:rpc`)와 브리지 계약 상수.
import { ErrorCode, rpcError } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { BRIDGE_KEYS, EVENT_CHANNEL, RPC_CHANNEL } from '../src/common/bridge.js';
import { PipeRpcError } from '../src/main/pipe-client.js';
import { handleRendererRpc, type RpcTarget } from '../src/main/rpc-bridge.js';

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
});

describe('브리지 계약', () => {
  it('채널 이름과 window.bive 키 (#10 · #13의 가짜 브리지가 따른다)', () => {
    expect(RPC_CHANNEL).toBe('bive:rpc');
    expect(EVENT_CHANNEL).toBe('bive:event');
    expect(BRIDGE_KEYS).toEqual(['invoke', 'on']);
  });
});
