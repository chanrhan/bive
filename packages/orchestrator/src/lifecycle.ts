// 백그라운드 수명 (PRD 5.1): 진행 중 실행이 없고 앱이 닫혀 있으면 자동 종료.
// 앱이 닫혀 있음 = 파이프 연결 0개. 두 수가 모두 0인 상태가 유휴 시간 동안 이어지면 onIdle을 부른다.

/** `BIVE_IDLE_SHUTDOWN_MS` 기본값: 5분. */
export const DEFAULT_IDLE_SHUTDOWN_MS = 300_000;

/** `BIVE_IDLE_SHUTDOWN_MS` 값을 푼다. 없거나 비면 기본값, 양의 정수가 아니면 null. */
export const parseIdleShutdownMs = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === '') return DEFAULT_IDLE_SHUTDOWN_MS;
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
};

/** 진행 중 실행 1건. `end()`는 여러 번 불러도 한 번만 센다. */
export interface RunHandle {
  end(): void;
}

/** 실행 엔진(M1)이 실행 시작 · 끝을 알리는 자리. */
export interface RunTracker {
  beginRun(): RunHandle;
  readonly activeRunCount: number;
}

export interface LifecycleOptions {
  idleShutdownMs: number;
  onIdle: () => void;
}

export class Lifecycle implements RunTracker {
  readonly #idleShutdownMs: number;
  readonly #onIdle: () => void;
  #connections = 0;
  #runs = 0;
  #timer: NodeJS.Timeout | null = null;
  #started = false;
  #stopped = false;

  constructor({ idleShutdownMs, onIdle }: LifecycleOptions) {
    if (!Number.isSafeInteger(idleShutdownMs) || idleShutdownMs <= 0) {
      throw new RangeError(`유휴 종료 시간은 양의 정수(ms)여야 함: ${idleShutdownMs}`);
    }
    this.#idleShutdownMs = idleShutdownMs;
    this.#onIdle = onIdle;
  }

  get connectionCount(): number {
    return this.#connections;
  }

  get activeRunCount(): number {
    return this.#runs;
  }

  /** 유휴 종료 타이머가 돌고 있는지. */
  get idleTimerRunning(): boolean {
    return this.#timer !== null;
  }

  /** 감시를 시작한다. 기동 직후 아무도 접속하지 않아도 유휴 시간이 지나면 종료한다. */
  start(): void {
    this.#started = true;
    this.#evaluate();
  }

  /** 감시를 멈춘다. 이후 onIdle을 부르지 않는다. */
  stop(): void {
    this.#stopped = true;
    this.#clearTimer();
  }

  connectionOpened(): void {
    this.#connections += 1;
    this.#evaluate();
  }

  connectionClosed(): void {
    if (this.#connections === 0) throw new Error('연결 수가 0보다 작아질 수 없음');
    this.#connections -= 1;
    this.#evaluate();
  }

  beginRun(): RunHandle {
    this.#runs += 1;
    this.#evaluate();
    let ended = false;
    return {
      end: () => {
        if (ended) return;
        ended = true;
        this.#runs -= 1;
        this.#evaluate();
      },
    };
  }

  #evaluate(): void {
    if (!this.#started || this.#stopped) return;
    if (this.#connections === 0 && this.#runs === 0) {
      this.#timer ??= setTimeout(() => {
        this.#timer = null;
        if (this.#stopped) return;
        this.#stopped = true;
        this.#onIdle();
      }, this.#idleShutdownMs);
    } else {
      this.#clearTimer();
    }
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
