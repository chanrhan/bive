// main ↔ preload ↔ renderer 사이의 브리지 계약 (architecture.md 5장 "렌더러 경로").
// preload 번들에 들어가므로 런타임 값은 문자열 상수만 두고, shared는 타입만 가져온다.
import type {
  JsonRpcErrorObject,
  MethodName,
  MethodParams,
  MethodResult,
  SystemStatusResult,
} from '@bive/shared';

/** renderer → main 요청 채널 (`ipcRenderer.invoke`). 값: {@link RpcRequestPayload} → {@link RpcOutcome} */
export const RPC_CHANNEL = 'bive:rpc';

/** main → renderer 알림 채널 (`webContents.send`). 값: {@link BridgeEvent} */
export const EVENT_CHANNEL = 'bive:event';

/** `window.bive`가 노출하는 키. 이 두 개뿐이다. */
export const BRIDGE_KEYS = ['invoke', 'on'] as const;

/** 렌더러가 부를 수 없는 메서드: 파이프 인증은 main이 맡는다. */
export const MAIN_ONLY_METHODS = ['system.hello'] as const satisfies readonly MethodName[];

export type RendererMethodName = Exclude<MethodName, (typeof MAIN_ONLY_METHODS)[number]>;

export interface RpcRequestPayload {
  method: string;
  params?: unknown;
}

export type RpcOutcome = { ok: true; result: unknown } | { ok: false; error: JsonRpcErrorObject };

export interface BridgeEvent {
  event: string;
  params: unknown;
}

/**
 * main이 만드는 알림(파이프 알림 아님): 오케스트레이터 연결 상태 (ADR-045).
 * main이 1초마다 `system.status`를 부른 결과와, 연결이 끊긴 순간에 보낸다.
 */
export const CONNECTION_EVENT = 'system.connection';

/** {@link CONNECTION_EVENT}의 값. 연결됨이면 마지막 `system.status` 결과를 함께 싣는다. */
export type ConnectionEventParams =
  { state: 'connected'; status: SystemStatusResult } | { state: 'disconnected' };

/**
 * main이 만드는 알림: 프로젝트가 열림 (M1-01). main을 거친 `project.open`이 성공할 때마다
 * (기동 인자 `--open`, 렌더러 요청 모두) 모든 창에 보낸다. 값은 `project.open` 결과 그대로다.
 */
export const PROJECT_OPENED_EVENT = 'project.opened';

type InvokeParams<M extends RendererMethodName> =
  undefined extends MethodParams<M> ? [params?: MethodParams<M>] : [params: MethodParams<M>];

/**
 * 렌더러의 `window.bive`.
 * - `invoke`: 결과로 풀리고, 실패하면 JSON-RPC 오류 객체 `{ code, message, data? }`로 거부된다.
 * - `on`: 알림 이름이 같은 것만 받는다. 돌려준 함수를 부르면 구독을 끊는다.
 */
export interface BiveBridge {
  invoke<M extends RendererMethodName>(
    method: M,
    ...params: InvokeParams<M>
  ): Promise<MethodResult<M>>;
  on(event: string, listener: (params: unknown) => void): () => void;
}
