// 오케스트레이터 연결 감시 (screens.md 1.2 사이드바 하단 연결 상태, ADR-045).
// 1초마다 `system.status`를 불러 그 결과를 `system.connection` 알림으로 렌더러에 보낸다.
// 연결이 끊기면 바로 '끊김'을 보내고, 다음 주기부터 다시 붙기만 한다(오케스트레이터를 띄우지 않음:
// OrchestratorLink가 한 번 붙은 뒤에는 기동하지 않는다). Electron에 의존하지 않아 단위 테스트에서 그대로 부른다.
import type { SystemStatusResult } from '@bive/shared';

import type { ConnectionEventParams } from '../common/bridge.js';
import type { ConnectionState } from './session.js';

/** 상태 확인 간격 = 끊긴 뒤 재접속 간격. */
export const CONNECTION_POLL_INTERVAL_MS = 1000;

/**
 * 상태 확인 한 번의 대기 한도. 접속 재시도(최대 5초, ADR-042)보다 길게 둔다.
 * 넘으면 끊김으로 보고 다음 주기로 넘어간다(응답 없는 오케스트레이터에서 감시가 멈추지 않게).
 */
export const CONNECTION_CHECK_TIMEOUT_MS = 10_000;

export interface ConnectionMonitorTarget {
  request(method: string, params?: unknown): Promise<unknown>;
  onStateChange(listener: (state: ConnectionState) => void): () => void;
}

export interface ConnectionMonitorOptions {
  target: ConnectionMonitorTarget;
  /** 렌더러로 알림을 보낸다 */
  emit: (params: ConnectionEventParams) => void;
  intervalMs?: number;
  timeoutMs?: number;
}

const TIMED_OUT = Symbol('timed-out');

export class ConnectionMonitor {
  readonly #target: ConnectionMonitorTarget;
  readonly #emit: (params: ConnectionEventParams) => void;
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  #timer: NodeJS.Timeout | null = null;
  #unsubscribe: (() => void) | null = null;
  #running = false;
  #last: ConnectionEventParams | null = null;

  constructor({ target, emit, intervalMs, timeoutMs }: ConnectionMonitorOptions) {
    this.#target = target;
    this.#emit = emit;
    this.#intervalMs = intervalMs ?? CONNECTION_POLL_INTERVAL_MS;
    this.#timeoutMs = timeoutMs ?? CONNECTION_CHECK_TIMEOUT_MS;
  }

  /** 마지막으로 보낸 알림 (아직 없으면 null). */
  get last(): ConnectionEventParams | null {
    return this.#last;
  }

  /** 바로 한 번 확인하고, 이후 확인이 끝날 때마다 간격을 두고 다시 확인한다. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#unsubscribe = this.#target.onStateChange((state) => {
      // 끊긴 순간을 다음 주기까지 기다리지 않고 알린다
      if (state === 'disconnected' && this.#last?.state === 'connected') {
        this.#send({ state: 'disconnected' });
      }
    });
    void this.#tick();
  }

  stop(): void {
    this.#running = false;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #send(params: ConnectionEventParams): void {
    this.#last = params;
    this.#emit(params);
  }

  async #check(): Promise<ConnectionEventParams> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.#target.request('system.status'),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timeout = setTimeout(() => resolve(TIMED_OUT), this.#timeoutMs);
        }),
      ]);
      if (result === TIMED_OUT) return { state: 'disconnected' };
      // 결과는 파이프 클라이언트가 shared 스키마로 이미 검증했다
      return { state: 'connected', status: result as SystemStatusResult };
    } catch {
      return { state: 'disconnected' };
    } finally {
      clearTimeout(timeout);
    }
  }

  async #tick(): Promise<void> {
    const params = await this.#check();
    if (!this.#running) return;
    this.#send(params);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#tick();
    }, this.#intervalMs);
  }
}
