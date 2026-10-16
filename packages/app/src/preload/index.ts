// preload: 렌더러에 `window.bive = { invoke, on }` 두 키만 노출한다 (architecture.md 2장 · 5장).
// 샌드박스 preload라 electron 외 모듈을 불러오지 않는다. 메서드 검증은 main이 한다.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import {
  type BiveBridge,
  type BridgeEvent,
  EVENT_CHANNEL,
  RPC_CHANNEL,
  type RpcOutcome,
  type RpcRequestPayload,
} from '../common/bridge.js';

const invoke = async (method: string, params?: unknown): Promise<unknown> => {
  const payload: RpcRequestPayload = { method, params };
  const outcome = (await ipcRenderer.invoke(RPC_CHANNEL, payload)) as RpcOutcome;
  if (outcome.ok) return outcome.result;
  // 렌더러는 JSON-RPC 오류 객체 { code, message, data? }를 받는다
  return Promise.reject(outcome.error);
};

const on = (event: string, listener: (params: unknown) => void): (() => void) => {
  const handler = (_event: IpcRendererEvent, message: BridgeEvent): void => {
    if (message.event === event) listener(message.params);
  };
  ipcRenderer.on(EVENT_CHANNEL, handler);
  return () => {
    ipcRenderer.removeListener(EVENT_CHANNEL, handler);
  };
};

const bridge = { invoke, on } as BiveBridge;

contextBridge.exposeInMainWorld('bive', bridge);
