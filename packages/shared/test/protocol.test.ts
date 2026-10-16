// IPC 프로토콜 검증: JSON-RPC 2.0 요청 · 응답 · 알림 스키마, ping 왕복, 오류 코드 (architecture.md 5장).
import { describe, expect, it } from 'vitest';

import {
  createErrorResponse,
  createRequest,
  createSuccessResponse,
  ERROR_MESSAGES,
  ErrorCode,
  isMethodName,
  JsonRpcErrorResponse,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  METHOD_NAMES,
  METHODS,
  parseJsonFrame,
  parseNotification,
  parseRequest,
  parseResponse,
  PROTOCOL_VERSION,
  rpcError,
} from '../src/index.js';

/** 파이프 프레임 왕복: JSON 1줄로 직렬화했다가 다시 해석한다. */
const throughFrame = (message: unknown): unknown => {
  const line = `${JSON.stringify(message)}\n`;
  expect(line.indexOf('\n')).toBe(line.length - 1);
  const parsed = parseJsonFrame(line.trimEnd());
  if (!parsed.ok) throw new Error('프레임 해석 실패');
  return parsed.value;
};

describe('오류 코드 (architecture.md 5장)', () => {
  it('JSON-RPC 표준 코드', () => {
    expect(ErrorCode.ParseError).toBe(-32700);
    expect(ErrorCode.InvalidRequest).toBe(-32600);
    expect(ErrorCode.MethodNotFound).toBe(-32601);
    expect(ErrorCode.InvalidParams).toBe(-32602);
    expect(ErrorCode.InternalError).toBe(-32603);
  });

  it('BIVE 정의 코드', () => {
    expect(ErrorCode.ValidationFailed).toBe(-32001);
    expect(ErrorCode.NotFound).toBe(-32004);
    expect(ErrorCode.StateConflict).toBe(-32009);
    expect(ErrorCode.SettingsIncomplete).toBe(-32010);
    expect(ErrorCode.Unauthorized).toBe(-32020);
  });

  it('모든 코드에 기본 메시지가 있고 코드가 겹치지 않는다', () => {
    const codes = Object.values(ErrorCode);
    expect(new Set(codes).size).toBe(codes.length);
    expect(Object.keys(ERROR_MESSAGES).map(Number).sort()).toEqual([...codes].sort());
    expect(rpcError(ErrorCode.NotFound)).toEqual({ code: -32004, message: '대상 없음' });
    expect(rpcError(ErrorCode.NotFound, '규칙 없음', { id: 'x' })).toEqual({
      code: -32004,
      message: '규칙 없음',
      data: { id: 'x' },
    });
  });
});

describe('요청 스키마', () => {
  it('ID는 문자열 · 정수, 파라미터는 없거나 객체 · 배열', () => {
    expect(JsonRpcRequest.safeParse({ jsonrpc: '2.0', id: 1, method: 'ping' }).success).toBe(true);
    expect(
      JsonRpcRequest.safeParse({ jsonrpc: '2.0', id: 'a', method: 'm', params: {} }).success,
    ).toBe(true);
    expect(
      JsonRpcRequest.safeParse({ jsonrpc: '2.0', id: 1, method: 'm', params: [1] }).success,
    ).toBe(true);
  });

  it.each([
    ['버전 누락', { id: 1, method: 'ping' }],
    ['버전 불일치', { jsonrpc: '1.0', id: 1, method: 'ping' }],
    ['소수 ID', { jsonrpc: '2.0', id: 1.5, method: 'ping' }],
    ['null ID', { jsonrpc: '2.0', id: null, method: 'ping' }],
    ['빈 메서드', { jsonrpc: '2.0', id: 1, method: '' }],
    ['원시값 파라미터', { jsonrpc: '2.0', id: 1, method: 'ping', params: 3 }],
    ['모르는 필드', { jsonrpc: '2.0', id: 1, method: 'ping', extra: true }],
  ])('%s는 위반', (_name, value) => {
    expect(JsonRpcRequest.safeParse(value).success).toBe(false);
  });
});

describe('응답 스키마', () => {
  it('성공 응답은 result 필수 (null 허용)', () => {
    expect(JsonRpcSuccessResponse.safeParse({ jsonrpc: '2.0', id: 1, result: null }).success).toBe(
      true,
    );
    expect(JsonRpcSuccessResponse.safeParse({ jsonrpc: '2.0', id: 1 }).success).toBe(false);
  });

  it('오류 응답은 ID를 모르면 null', () => {
    expect(
      JsonRpcErrorResponse.safeParse({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'x' },
      }).success,
    ).toBe(true);
    expect(
      JsonRpcErrorResponse.safeParse({ jsonrpc: '2.0', id: 1, error: { code: 'x', message: 'y' } })
        .success,
    ).toBe(false);
  });

  it('result와 error를 함께 가지면 위반', () => {
    expect(
      JsonRpcResponse.safeParse({
        jsonrpc: '2.0',
        id: 1,
        result: 1,
        error: { code: -32603, message: 'x' },
      }).success,
    ).toBe(false);
  });
});

describe('알림 스키마', () => {
  it('ID가 없는 메시지', () => {
    expect(
      JsonRpcNotification.safeParse({ jsonrpc: '2.0', method: 'event.run.updated' }).success,
    ).toBe(true);
    expect(
      JsonRpcNotification.safeParse({ jsonrpc: '2.0', id: 1, method: 'event.run.updated' }).success,
    ).toBe(false);
  });

  it('메시지 전체 스키마는 요청 · 알림 · 응답을 모두 받는다', () => {
    for (const message of [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'event.todo.count', params: { count: 1 } },
      { jsonrpc: '2.0', id: 1, result: { pong: true, version: '0.0.0' } },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'x' } },
    ]) {
      expect(JsonRpcMessage.safeParse(message).success).toBe(true);
    }
    expect(JsonRpcMessage.safeParse({ jsonrpc: '2.0' }).success).toBe(false);
  });

  it('등록되지 않은 알림은 -32601, 형식 위반은 -32600', () => {
    const unknown = parseNotification({ jsonrpc: '2.0', method: 'event.unknown' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe(-32601);
    const malformed = parseNotification({ jsonrpc: '2.0', method: 1 });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe(-32600);
  });
});

describe('메서드 레지스트리', () => {
  it('ping이 등록돼 있다', () => {
    expect(METHOD_NAMES).toContain('ping');
    expect(isMethodName('ping')).toBe(true);
    expect(isMethodName('toString')).toBe(false);
    expect(isMethodName('system.unknown')).toBe(false);
    expect(METHOD_NAMES).toEqual(Object.keys(METHODS));
  });

  it('system.hello: 프로토콜 버전 · 토큰 → 오케스트레이터 버전', () => {
    expect(isMethodName('system.hello')).toBe(true);
    const request = createRequest(1, 'system.hello', {
      protocolVersion: PROTOCOL_VERSION,
      token: 'abc',
    });
    const received = parseRequest(throughFrame(request));
    expect(received.ok && received.request.method).toBe('system.hello');
    const response = createSuccessResponse(1, 'system.hello', { orchestratorVersion: '0.0.0' });
    expect(parseResponse('system.hello', throughFrame(response))).toEqual({
      ok: true,
      id: 1,
      result: { orchestratorVersion: '0.0.0' },
    });
  });

  it.each([
    ['토큰 누락', { protocolVersion: PROTOCOL_VERSION }],
    ['빈 토큰', { protocolVersion: PROTOCOL_VERSION, token: '' }],
    ['버전 불일치', { protocolVersion: PROTOCOL_VERSION + 1, token: 'abc' }],
    ['모르는 필드', { protocolVersion: PROTOCOL_VERSION, token: 'abc', extra: 1 }],
  ])('system.hello %s → -32602', (_, params) => {
    const result = parseRequest({ jsonrpc: '2.0', id: 2, method: 'system.hello', params });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(-32602);
  });

  it('system.status: 파라미터 없음 → 버전 · 가동 시간 · 연결 수 · 진행 중 실행 수', () => {
    expect(isMethodName('system.status')).toBe(true);
    const request = createRequest(3, 'system.status');
    expect(request).toEqual({ jsonrpc: '2.0', id: 3, method: 'system.status' });
    const status = { version: '0.0.0', uptimeMs: 1200, connections: 1, runsInProgress: 0 };
    const response = createSuccessResponse(3, 'system.status', status);
    expect(parseResponse('system.status', throughFrame(response))).toEqual({
      ok: true,
      id: 3,
      result: status,
    });
  });

  it('system.status에 params를 넣으면 -32602', () => {
    const result = parseRequest({ jsonrpc: '2.0', id: 4, method: 'system.status', params: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(-32602);
  });

  it.each([
    ['버전 누락', { uptimeMs: 0, connections: 0, runsInProgress: 0 }],
    ['음수 가동 시간', { version: '1', uptimeMs: -1, connections: 0, runsInProgress: 0 }],
    ['소수 연결 수', { version: '1', uptimeMs: 0, connections: 0.5, runsInProgress: 0 }],
    ['모르는 필드', { version: '1', uptimeMs: 0, connections: 0, runsInProgress: 0, extra: 1 }],
  ])('system.status 결과 %s → 받는 쪽 -32602', (_, result) => {
    const parsed = parseResponse('system.status', { jsonrpc: '2.0', id: 5, result });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe(-32602);
  });
});

describe('ping 왕복', () => {
  it('요청 → 서버 검증 → 응답 → 클라이언트 검증', () => {
    // 클라이언트: 파라미터 없는 요청
    const request = createRequest(7, 'ping');
    expect(request).toEqual({ jsonrpc: '2.0', id: 7, method: 'ping' });
    expect('params' in request).toBe(false);

    // 서버: 받은 요청 검증
    const received = parseRequest(throughFrame(request));
    expect(received.ok).toBe(true);
    if (!received.ok) return;
    expect(received.request.method).toBe('ping');
    expect(received.request.params).toBeUndefined();

    // 서버: 응답
    const response = createSuccessResponse(received.request.id, 'ping', {
      pong: true,
      version: '0.0.0',
    });

    // 클라이언트: 응답 검증
    const result = parseResponse('ping', throughFrame(response));
    expect(result).toEqual({ ok: true, id: 7, result: { pong: true, version: '0.0.0' } });
  });

  it('문자열 ID도 그대로 돌아온다', () => {
    const received = parseRequest(throughFrame(createRequest('req-1', 'ping')));
    expect(received.ok && received.request.id).toBe('req-1');
  });

  it('보내는 쪽도 결과 스키마를 검증한다', () => {
    expect(() =>
      createSuccessResponse(1, 'ping', { pong: false, version: '0.0.0' } as never),
    ).toThrow();
    expect(() => createRequest(1, 'ping', { x: 1 } as never)).toThrow();
  });
});

describe('스키마 위반 → -32602', () => {
  it('ping에 params를 넣으면 -32602와 위반 경로를 돌려준다', () => {
    const result = parseRequest({ jsonrpc: '2.0', id: 3, method: 'ping', params: { x: 1 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.id).toBe(3);
    expect(result.error.code).toBe(-32602);
    expect(result.error.code).toBe(ErrorCode.InvalidParams);
    expect(result.error.message).toContain('ping');
    expect(result.error.data).toMatchObject({ issues: [expect.objectContaining({ path: '' })] });

    // 오류 응답으로 감싸면 응답 스키마를 만족하고 클라이언트에 -32602로 전달된다
    const response = createErrorResponse(result.id, result.error);
    expect(JsonRpcErrorResponse.parse(throughFrame(response))).toEqual(response);
    const clientSide = parseResponse('ping', throughFrame(response));
    expect(clientSide.ok).toBe(false);
    if (!clientSide.ok) expect(clientSide.error.code).toBe(-32602);
  });

  it('ping 결과가 스키마와 다르면 받는 쪽에서 -32602', () => {
    const cases = [
      { pong: true },
      { pong: false, version: '1' },
      { pong: true, version: '' },
      { pong: true, version: '1', extra: 1 },
    ];
    for (const result of cases) {
      const parsed = parseResponse('ping', { jsonrpc: '2.0', id: 1, result });
      expect(parsed.ok, JSON.stringify(result)).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe(-32602);
        expect(parsed.id).toBe(1);
      }
    }
  });

  it('응답 형식 자체가 깨져도 -32602', () => {
    const parsed = parseResponse('ping', { jsonrpc: '2.0', id: 1 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe(-32602);
      expect(parsed.id).toBeNull();
    }
  });
});

describe('그 밖의 요청 오류', () => {
  it('없는 메서드는 -32601', () => {
    const result = parseRequest({ jsonrpc: '2.0', id: 'a', method: 'system.unknown' });
    expect(result).toMatchObject({ ok: false, id: 'a', error: { code: -32601 } });
  });

  it('형식 위반은 -32600, 읽을 수 있는 ID는 살린다', () => {
    expect(parseRequest({ jsonrpc: '1.0', id: 5, method: 'ping' })).toMatchObject({
      ok: false,
      id: 5,
      error: { code: -32600 },
    });
    expect(parseRequest('ping')).toMatchObject({ ok: false, id: null, error: { code: -32600 } });
    expect(parseRequest(null)).toMatchObject({ ok: false, id: null, error: { code: -32600 } });
  });

  it('JSON이 아닌 프레임은 -32700', () => {
    expect(parseJsonFrame('{"jsonrpc":')).toEqual({
      ok: false,
      error: { code: -32700, message: ERROR_MESSAGES[ErrorCode.ParseError] },
    });
  });

  it('오류 응답은 받은 오류를 그대로 돌려준다', () => {
    const parsed = parseResponse('ping', {
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32020, message: '권한 없음' },
    });
    expect(parsed).toEqual({ ok: false, id: 2, error: { code: -32020, message: '권한 없음' } });
  });
});
