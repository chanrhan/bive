// 오케스트레이터 기동 · 종료: 단일 인스턴스 잠금 → 토큰 → 파이프 서버 → 수명 감시 (PRD 5.1, ADR-027 · ADR-041).
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import os from 'node:os';

import { createHandlers } from './ipc/handlers.js';
import { PipeServer } from './ipc/server.js';
import { NetPipeTransport, type PipeTransport } from './ipc/transport.js';
import { DEFAULT_IDLE_SHUTDOWN_MS, Lifecycle, type RunTracker } from './lifecycle.js';
import { acquirePidLock } from './lock.js';
import { assertSocketPathLength } from './pipe-path.js';
import { type RunPaths, runPaths } from './run-paths.js';
import { writeTokenFile } from './token.js';
import { ORCHESTRATOR_VERSION } from './version.js';

export type ShutdownReason = 'idle' | 'signal' | 'requested';

export interface OrchestratorOptions {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 연결 0개 · 진행 중 실행 0개 상태가 이만큼 이어지면 종료 (기본 300000) */
  idleShutdownMs?: number;
  helloTimeoutMs?: number;
  platform?: NodeJS.Platform;
  username?: string;
  transport?: PipeTransport;
  version?: string;
}

export interface Orchestrator {
  readonly paths: RunPaths;
  readonly token: string;
  readonly version: string;
  /** 죽은 pid의 잠금을 인수하고 기동했는지 */
  readonly staleLockTakenOver: boolean;
  /** 실행 엔진이 진행 중 실행을 알리는 자리 */
  readonly runs: RunTracker;
  readonly connectionCount: number;
  /** 정상 종료. 여러 번 불러도 한 번만 수행한다 */
  stop(reason?: ShutdownReason): Promise<void>;
  /** 종료가 끝나면 이유와 함께 풀린다 */
  readonly closed: Promise<ShutdownReason>;
}

export type StartResult =
  { status: 'started'; orchestrator: Orchestrator } | { status: 'already-running'; pid: number };

const unlinkIfExists = (file: string): void => {
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

/**
 * 기동한다. 살아 있는 다른 인스턴스가 잠금을 잡고 있으면 아무것도 바꾸지 않고 `already-running`.
 * 잠금을 잡으면 이전 소켓 파일(비정상 종료 잔여물)을 지우고 토큰을 새로 쓴 뒤 듣기 시작한다.
 */
export const startOrchestrator = async (options: OrchestratorOptions): Promise<StartResult> => {
  const platform = options.platform ?? process.platform;
  const paths = runPaths(options.biveHome, platform, options.username ?? os.userInfo().username);
  const version = options.version ?? ORCHESTRATOR_VERSION;
  const idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  const unixSocket = platform !== 'win32';
  if (unixSocket) assertSocketPathLength(paths.pipe, platform);

  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  if (unixSocket) chmodSync(paths.dir, 0o700);

  const locked = acquirePidLock(paths.pid);
  if (!locked.acquired) return { status: 'already-running', pid: locked.runningPid };
  const { lock } = locked;

  let server: PipeServer | null = null;
  try {
    // 잠금을 잡았으므로 남아 있는 소켓 파일은 죽은 인스턴스의 것이다
    if (unixSocket) unlinkIfExists(paths.pipe);
    const token = writeTokenFile(paths.token);

    let stopping: Promise<void> | null = null;
    let resolveClosed!: (reason: ShutdownReason) => void;
    const closed = new Promise<ShutdownReason>((resolve) => {
      resolveClosed = resolve;
    });

    const stop = (reason: ShutdownReason = 'requested'): Promise<void> => {
      stopping ??= (async () => {
        lifecycle.stop();
        try {
          await server?.close();
        } finally {
          if (unixSocket) unlinkIfExists(paths.pipe);
          unlinkIfExists(paths.token);
          lock.release();
          resolveClosed(reason);
        }
      })();
      return stopping;
    };

    const lifecycle = new Lifecycle({
      idleShutdownMs,
      onIdle: () => void stop('idle'),
    });
    server = new PipeServer({
      transport: options.transport ?? new NetPipeTransport({ platform }),
      path: paths.pipe,
      token,
      orchestratorVersion: version,
      handlers: createHandlers({ orchestratorVersion: version }),
      ...(options.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: options.helloTimeoutMs }),
      onConnectionOpened: () => lifecycle.connectionOpened(),
      onConnectionClosed: () => lifecycle.connectionClosed(),
    });
    await server.listen();
    lifecycle.start();

    const listening = server;
    return {
      status: 'started',
      orchestrator: {
        paths,
        token,
        version,
        staleLockTakenOver: locked.staleTakenOver,
        runs: lifecycle,
        get connectionCount() {
          return listening.connectionCount;
        },
        stop,
        closed,
      },
    };
  } catch (error) {
    await server?.close().catch(() => undefined);
    if (unixSocket) unlinkIfExists(paths.pipe);
    unlinkIfExists(paths.token);
    lock.release();
    throw error;
  }
};
