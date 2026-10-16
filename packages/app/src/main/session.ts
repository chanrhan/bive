// 앱 main의 시작 · 끝 처리 (NFR-06): app.pid 기록 · 오케스트레이터 연결 유지 · 종료 시 app.pid 삭제.
// Electron에 의존하지 않아 단위 테스트에서 그대로 부른다(test/orchestrator-launch.test.ts).
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

import { ErrorCode, rpcError } from '@bive/shared';

import {
  ensureOrchestrator,
  type EnsureOptions,
  type EnsureResult,
  readPidFile,
} from './orchestrator-launch.js';
import { type PipeClient, type PipeNotification, PipeRpcError } from './pipe-client.js';
import { type AppRunPaths, appRunPaths } from './run-paths.js';

/** `$BIVE_HOME/run/app.pid`에 pid를 원자적으로 쓴다 (run 폴더 0700, 파일 0600). */
export const writeAppPid = (paths: AppRunPaths, pid: number): void => {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const temp = `${paths.appPid}.${pid}.tmp`;
  writeFileSync(temp, `${pid}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, paths.appPid);
};

/** app.pid가 아직 이 pid를 가리킬 때만 지운다(다른 앱 인스턴스의 기록은 남긴다). */
export const removeAppPid = (paths: AppRunPaths, pid: number): void => {
  if (readPidFile(paths.appPid) !== pid) return;
  try {
    unlinkSync(paths.appPid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/** 접속 실패 응답 메시지. 상세(`data`)는 붙이지 않는다. */
export const CONNECT_FAILED_MESSAGE = '오케스트레이터 연결 실패';

const defaultLog = (message: string): void => {
  console.error(message);
};

/**
 * 오케스트레이터 연결 1개를 유지한다. 요청 때 연결이 없거나 끊겼으면 다시 접속(필요하면 기동)한다.
 * 동시에 들어온 요청은 같은 접속 시도를 기다린다.
 */
export class OrchestratorLink {
  readonly #connect: () => Promise<EnsureResult>;
  readonly #log: (message: string) => void;
  readonly #notificationListeners = new Set<(notification: PipeNotification) => void>();
  #current: EnsureResult | null = null;
  #connecting: Promise<EnsureResult> | null = null;
  #state: ConnectionState = 'disconnected';
  #closed = false;

  /** `log`: main 프로세스 로그 (기본 표준 오류). 렌더러로 가지 않는 상세를 남긴다 */
  constructor(connect: () => Promise<EnsureResult>, log: (message: string) => void = defaultLog) {
    this.#connect = connect;
    this.#log = log;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** 접속한다. 이미 연결돼 있으면 그 연결을 쓴다. */
  connect(): Promise<EnsureResult> {
    if (this.#closed) return Promise.reject(new Error('연결 관리자가 닫힘'));
    if (this.#current !== null && !this.#current.client.isClosed) {
      return Promise.resolve(this.#current);
    }
    this.#connecting ??= (async () => {
      this.#state = 'connecting';
      try {
        const result = await this.#connect();
        if (this.#closed) {
          result.client.destroy();
          throw new Error('연결 관리자가 닫힘');
        }
        this.#attach(result);
        return result;
      } catch (error) {
        this.#state = 'disconnected';
        throw error;
      } finally {
        this.#connecting = null;
      }
    })();
    return this.#connecting;
  }

  #attach(result: EnsureResult): void {
    const { client } = result;
    this.#current = result;
    this.#state = 'connected';
    client.onNotification((n) => {
      for (const listener of this.#notificationListeners) listener(n);
    });
    client.onClose(() => {
      if (this.#current === result) {
        this.#current = null;
        this.#state = 'disconnected';
      }
    });
  }

  onNotification(listener: (notification: PipeNotification) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  /**
   * 요청. 연결 실패는 -32603 `오케스트레이터 연결 실패`로 바꾼다.
   * 원본 오류(로컬 경로 · 시스템 메시지)는 응답에 싣지 않고 main 로그에만 남긴다 (ADR-041 · ADR-042).
   */
  async request(method: string, params?: unknown): Promise<unknown> {
    let client: PipeClient;
    try {
      client = (await this.connect()).client;
    } catch (error) {
      this.#log(
        `오케스트레이터 연결 실패: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new PipeRpcError(rpcError(ErrorCode.InternalError, CONNECT_FAILED_MESSAGE));
    }
    return client.request(method, params);
  }

  /** 연결을 닫는다. 오케스트레이터 프로세스는 건드리지 않는다. */
  close(): void {
    this.#closed = true;
    this.#current?.client.destroy();
    this.#current = null;
    this.#state = 'disconnected';
  }
}

export interface MainSessionOptions extends Omit<EnsureOptions, 'biveHome'> {
  biveHome: string;
  /** 기록할 앱 main pid (기본 현재 프로세스) */
  appPid?: number;
  /** main 로그 (기본 표준 오류) */
  log?: (message: string) => void;
}

export interface MainSession {
  readonly paths: AppRunPaths;
  readonly appPid: number;
  readonly link: OrchestratorLink;
  /** 연결을 닫고 app.pid를 지운다. 오케스트레이터는 그대로 둔다 (NFR-06). */
  dispose(): void;
}

/** 앱 main 시작: app.pid를 쓰고 연결 관리자를 만든다. 접속은 `link.connect()` 또는 첫 요청 때. */
export const startMainSession = (options: MainSessionOptions): MainSession => {
  const { appPid = process.pid, log, ...ensure } = options;
  const paths = appRunPaths(options.biveHome, options.platform, options.username);
  writeAppPid(paths, appPid);
  const link = new OrchestratorLink(() => ensureOrchestrator(ensure), log);
  let disposed = false;
  return {
    paths,
    appPid,
    link,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      link.close();
      removeAppPid(paths, appPid);
    },
  };
};
