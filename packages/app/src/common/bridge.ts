// main ↔ preload ↔ renderer 사이의 브리지 계약 (architecture.md 5장 "렌더러 경로").
// preload 번들에 들어가므로 런타임 값은 문자열 상수만 두고, shared는 타입만 가져온다.
import type {
  CodeOpenRecordResult,
  CodeOpenTarget,
  JsonRpcErrorObject,
  MethodName,
  MethodParams,
  MethodResult,
  ProjectOpenResult,
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

/**
 * main이 직접 처리하는 메서드 (파이프 아님, architecture.md 5장 "main 전용").
 * - `app.pickFolder`: 파라미터 없음. OS 폴더 선택 대화상자 → `{ path }` (취소하면 `null`). 프로젝트를 열지는 않는다
 */
export const PICK_FOLDER_METHOD = 'app.pickFolder';

/**
 * - `app.openInIde`: 코드 열기 (MET-01, ADR-084). 사유를 고른 `file:line` 대상(`CodeOpenTarget`)을 받아 main이
 *   `codeOpen.record`로 먼저 기록하고, 기록이 성공해야 고정 틀의 IDE URL로 연다. 렌더러는 URL을 넘기지 않는다.
 *   결과는 남긴 기록 `{ record }`
 */
export const OPEN_IN_IDE_METHOD = 'app.openInIde';

export interface AppMethods {
  [PICK_FOLDER_METHOD]: { params: undefined; result: { path: string | null } };
  [OPEN_IN_IDE_METHOD]: { params: CodeOpenTarget; result: CodeOpenRecordResult };
}

export type AppMethodName = keyof AppMethods;

export const APP_METHOD_NAMES = [
  PICK_FOLDER_METHOD,
  OPEN_IN_IDE_METHOD,
] as const satisfies readonly AppMethodName[];

/** 렌더러가 `invoke`로 부를 수 있는 메서드: 파이프 메서드(main 전용 제외) + main 메서드. */
export type RendererMethodName =
  Exclude<MethodName, (typeof MAIN_ONLY_METHODS)[number]> | AppMethodName;

export type RendererMethodParams<M extends RendererMethodName> = M extends AppMethodName
  ? AppMethods[M]['params']
  : M extends MethodName
    ? MethodParams<M>
    : never;

export type RendererMethodResult<M extends RendererMethodName> = M extends AppMethodName
  ? AppMethods[M]['result']
  : M extends MethodName
    ? MethodResult<M>
    : never;

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

export type ProjectOpenedEventParams = ProjectOpenResult;

type InvokeParams<M extends RendererMethodName> =
  undefined extends RendererMethodParams<M>
    ? [params?: RendererMethodParams<M>]
    : [params: RendererMethodParams<M>];

/**
 * 렌더러의 `window.bive`.
 * - `invoke`: 결과로 풀리고, 실패하면 JSON-RPC 오류 객체 `{ code, message, data? }`로 거부된다.
 * - `on`: 알림 이름이 같은 것만 받는다. 돌려준 함수를 부르면 구독을 끊는다.
 */
export interface BiveBridge {
  invoke<M extends RendererMethodName>(
    method: M,
    ...params: InvokeParams<M>
  ): Promise<RendererMethodResult<M>>;
  on(event: string, listener: (params: unknown) => void): () => void;
}
