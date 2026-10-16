// 화면 e2e용 가짜 브리지 (architecture.md 8장). preload 대신 page.addInitScript로 window.bive를 주입한다.
// 제품 코드 경로에는 두지 않는다 (CLAUDE.md 4장, NFR-03).
//
// 사용법:
//   const bive = await mockBive(page, {
//     responses: {
//       'system.status': { result: { version: '0.0.0', uptimeMs: 0, connections: 1, runsInProgress: 0 } },
//       // 'system.status': { result: ..., delayMs: 300 },                     // 지연 뒤 응답
//       // 'system.status': { pending: true },                                  // 영원히 대기 (로딩 상태)
//       // 'system.status': { error: { code: -32603, message: '내부 오류' } },  // JSON-RPC 오류 (에러 상태)
//     },
//     events: [{ event: 'run.updated', params: {...}, delayMs: 100 }], // 첫 구독 뒤 자동 발행
//   });
//   await page.goto('/');
//   await bive.emit('run.updated', {...});          // 테스트 도중 알림 발행
//   await bive.setResponse('system.status', { error: ... });  // 응답 바꾸기 (다음 호출부터)
//   expect(await bive.calls()).toEqual([{ method: 'system.status', params: undefined }]);
//
// 계약은 실제 브리지(src/common/bridge.ts, ADR-042)와 같다: 키는 invoke · on 두 개, invoke는 결과로 풀리거나
// `{ code, message, data? }`로 거부, on은 해제 함수를 돌려준다(구독마다 독립). 응답 표에 없는 메서드는 -32601,
// main 전용 메서드(system.hello)는 -32020으로 거부한다. 한 페이지에 한 번만 부른다.
import type { JsonRpcErrorObject, MethodResult } from '@bive/shared';
import type { Page } from '@playwright/test';

import type { RendererMethodName } from '../../src/common/bridge.js';

/** 메서드 하나의 가짜 응답. 값은 브라우저로 직렬화되므로 JSON으로 표현 가능한 값만 쓴다. */
export type MockResponse<R = unknown> =
  | { result: R; delayMs?: number }
  | { error: JsonRpcErrorObject; delayMs?: number }
  | { pending: true };

/** 메서드 이름 → 가짜 응답. 결과 타입은 shared 메서드 레지스트리를 따른다. */
export type MockResponses = { [M in RendererMethodName]?: MockResponse<MethodResult<M>> };

/** 첫 구독 뒤 `delayMs`(기본 0) 지나 자동으로 발행할 알림. */
export interface MockEvent {
  event: string;
  params: unknown;
  delayMs?: number;
}

export interface MockBiveOptions {
  responses?: MockResponses;
  events?: MockEvent[];
}

/** `invoke` 호출 기록 한 건. */
export interface MockCall {
  method: string;
  params: unknown;
}

export interface BiveMock {
  /** 지금까지의 `invoke` 호출 기록 (순서대로). */
  calls(): Promise<MockCall[]>;
  /** 구독자에게 알림을 발행한다. 구독자가 없으면 아무 일도 없다. */
  emit(event: string, params?: unknown): Promise<void>;
  /** 메서드 응답을 바꾼다. 이미 대기 중인 호출에는 영향이 없다. */
  setResponse<M extends RendererMethodName>(
    method: M,
    response: MockResponse<MethodResult<M>>,
  ): Promise<void>;
  /** 이벤트별 현재 구독자 수. */
  listenerCounts(): Promise<Record<string, number>>;
}

/** 페이지 안에서 쓰는 조작 객체의 전역 이름. 화면 코드는 이 이름을 모른다. */
export const MOCK_GLOBAL = '__biveMock';

interface MockState {
  responses: Record<string, MockResponse>;
  events: MockEvent[];
  mainOnly: string[];
  globalName: string;
}

/** 페이지 안 조작 객체의 형태 (page.evaluate에서 쓴다). */
interface MockControl {
  calls: MockCall[];
  emit(event: string, params: unknown): void;
  setResponse(method: string, response: MockResponse): void;
  listenerCounts(): Record<string, number>;
}

/**
 * 브라우저 문맥에서 실행된다 (직렬화되므로 바깥 변수를 참조하지 않는다).
 * 페이지가 새로 열릴 때마다(새로고침 포함) 다시 실행돼 상태가 초기화된다.
 */
const installMock = (state: MockState): void => {
  const responses = new Map<string, MockResponse>(Object.entries(state.responses));
  // 구독 1건 = 항목 1개. 같은 함수를 두 번 구독하면 두 항목이고, 해제는 자기 항목만 지운다 (preload와 같음)
  const listeners = new Map<string, Set<{ listener: (params: unknown) => void }>>();
  const pendingEvents = [...state.events];
  const calls: MockCall[] = [];

  // IPC를 지난 값처럼 호출자와 객체를 공유하지 않게 복제한다
  const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

  const deliver = (event: string, params: unknown): void => {
    for (const entry of [...(listeners.get(event) ?? [])]) entry.listener(clone(params));
  };

  const invoke = (method: unknown, params?: unknown): Promise<unknown> => {
    calls.push({ method: String(method), params: clone(params) });
    if (typeof method !== 'string') {
      return Promise.reject({ code: -32600, message: '잘못된 요청' });
    }
    if (state.mainOnly.includes(method)) {
      return Promise.reject({ code: -32020, message: '허용되지 않은 메서드' });
    }
    const response = responses.get(method);
    if (response === undefined) {
      return Promise.reject({ code: -32601, message: '메서드 없음' });
    }
    if ('pending' in response) return new Promise<never>(() => {});
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if ('error' in response) reject(clone(response.error));
        else resolve(clone(response.result));
      }, response.delayMs ?? 0);
    });
  };

  const on = (event: string, listener: (params: unknown) => void): (() => void) => {
    let set = listeners.get(event);
    if (set === undefined) {
      set = new Set();
      listeners.set(event, set);
    }
    const entry = { listener };
    set.add(entry);
    // 자동 발행 알림은 그 이름의 첫 구독 때 한 번만 예약한다
    for (let i = pendingEvents.length - 1; i >= 0; i -= 1) {
      const item = pendingEvents[i];
      if (item === undefined || item.event !== event) continue;
      pendingEvents.splice(i, 1);
      setTimeout(() => deliver(item.event, item.params), item.delayMs ?? 0);
    }
    return () => {
      set.delete(entry);
    };
  };

  const control: MockControl = {
    calls,
    emit: deliver,
    setResponse: (method, response) => {
      responses.set(method, response);
    },
    listenerCounts: () =>
      Object.fromEntries([...listeners].map(([event, set]) => [event, set.size] as const)),
  };

  // contextBridge.exposeInMainWorld처럼 고정된 객체로 노출한다
  Object.defineProperty(window, 'bive', {
    value: Object.freeze({ invoke, on }),
    enumerable: true,
  });
  Object.defineProperty(window, state.globalName, { value: control });
};

/** 이미 가짜 브리지를 주입한 페이지. 두 번째 주입은 window.bive 재정의 오류로 조용히 깨지므로 미리 막는다. */
const mockedPages = new WeakSet<Page>();

/**
 * 다음 탐색부터 window.bive를 가짜로 바꾼다. `page.goto` 전에 부른다. 페이지마다 한 번만 부른다
 * (응답을 바꾸려면 `setResponse`, 두 번 부르면 오류).
 * 응답 · 자동 알림 표는 탐색마다 처음 값으로 초기화되고, `setResponse`로 바꾼 값은 현재 문서에만 적용된다.
 */
export const mockBive = async (page: Page, options: MockBiveOptions = {}): Promise<BiveMock> => {
  if (mockedPages.has(page)) {
    throw new Error('이 페이지에는 이미 mockBive를 불렀음. 응답은 setResponse로 바꾼다');
  }
  mockedPages.add(page);
  const state: MockState = {
    responses: { ...(options.responses ?? {}) } as Record<string, MockResponse>,
    events: options.events ?? [],
    mainOnly: ['system.hello'],
    globalName: MOCK_GLOBAL,
  };
  await page.addInitScript(installMock, state);

  // page.evaluate 함수는 브라우저로 직렬화되므로 조작 객체 조회를 각 함수 안에 둔다
  type Globals = Record<string, MockControl | undefined>;
  const missing = '가짜 브리지가 주입되지 않음. mockBive를 page.goto 전에 부른다';

  return {
    calls: () =>
      page.evaluate(
        ([name, err]) => {
          const control = (window as unknown as Globals)[name];
          if (control === undefined) throw new Error(err);
          return control.calls.slice();
        },
        [MOCK_GLOBAL, missing] as const,
      ),
    emit: (event, params) =>
      page.evaluate(
        ([name, err, e, p]) => {
          const control = (window as unknown as Globals)[name];
          if (control === undefined) throw new Error(err);
          control.emit(e, p);
        },
        [MOCK_GLOBAL, missing, event, params] as const,
      ),
    setResponse: (method, response) =>
      page.evaluate(
        ([name, err, m, r]) => {
          const control = (window as unknown as Globals)[name];
          if (control === undefined) throw new Error(err);
          control.setResponse(m, r);
        },
        [MOCK_GLOBAL, missing, method, response as MockResponse] as const,
      ),
    listenerCounts: () =>
      page.evaluate(
        ([name, err]) => {
          const control = (window as unknown as Globals)[name];
          if (control === undefined) throw new Error(err);
          return control.listenerCounts();
        },
        [MOCK_GLOBAL, missing] as const,
      ),
  };
};
