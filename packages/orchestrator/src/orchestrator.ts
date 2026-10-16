// 오케스트레이터 기동 · 종료: 어댑터 선택 → 단일 인스턴스 잠금 → 토큰 → 파이프 서버 → 수명 감시
// (PRD 5.1, ADR-027 · ADR-041 · ADR-049).
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import os from 'node:os';

import { type AgentSelection, selectAgent } from './agent/select.js';
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
  /** 에이전트 어댑터. 생략하면 `BIVE_AGENT` · `BIVE_SCENARIO`로 고른다 (잘못되면 AgentConfigError) */
  agent?: AgentSelection;
}

export interface Orchestrator {
  readonly paths: RunPaths;
  readonly token: string;
  readonly version: string;
  /** 죽은 pid의 잠금을 인수하고 기동했는지 */
  readonly staleLockTakenOver: boolean;
  /** 기동 시 고른 에이전트 어댑터. 실행 엔진(M1-14)이 세션을 열 때 쓴다 */
  readonly agent: AgentSelection;
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

const isEnoent = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const unlinkIfExists = (file: string): void => {
  try {
    unlinkSync(file);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
};

/** 파일 식별자(장치 · inode). 없으면 null. 같은 경로에 다른 프로세스가 새로 만든 파일을 가린다. */
const fileIdentity = (file: string): string | null => {
  try {
    const stat = lstatSync(file);
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
};

/** 토큰 파일이 아직 이 인스턴스의 토큰일 때만 지운다. */
const unlinkTokenIfOurs = (tokenPath: string, token: string): void => {
  let current: string;
  try {
    current = readFileSync(tokenPath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (current === token) unlinkIfExists(tokenPath);
};

/**
 * 기동한다. 살아 있는 다른 인스턴스가 잠금을 잡고 있으면 아무것도 바꾸지 않고 `already-running`.
 * 잠금을 잡으면 이전 소켓 파일(비정상 종료 잔여물)을 지우고 토큰을 새로 쓴 뒤 듣기 시작한다.
 */
export const startOrchestrator = async (options: OrchestratorOptions): Promise<StartResult> => {
  // 설정 오류는 잠금 · 파일을 건드리기 전에 드러낸다
  const agent = options.agent ?? selectAgent(process.env, { biveHome: options.biveHome });
  const platform = options.platform ?? process.platform;
  const paths = runPaths(options.biveHome, platform, options.username ?? os.userInfo().username);
  const version = options.version ?? ORCHESTRATOR_VERSION;
  const idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  const startedAt = Date.now();
  const unixSocket = platform !== 'win32';
  if (unixSocket) assertSocketPathLength(paths.pipe, platform);

  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  if (unixSocket) chmodSync(paths.dir, 0o700);

  const locked = acquirePidLock(paths.pid);
  if (!locked.acquired) return { status: 'already-running', pid: locked.runningPid };
  const { lock } = locked;

  let server: PipeServer | null = null;
  let token: string | null = null;
  /** 이 인스턴스가 bind한 소켓 파일의 식별자. bind 전이면 null */
  let boundSocket: string | null = null;

  /**
   * 소켓 · 토큰은 이 인스턴스의 것일 때만 지운다 (같은 죽은 잠금을 동시에 인수한 경합의 진 쪽이
   * 이긴 쪽 파일을 지우지 않게, ADR-041). Node는 서버를 닫을 때 소켓 경로를 지우므로,
   * 그 경로에 다른 인스턴스의 소켓이 있으면 닫는 동안 잠시 옆으로 옮겨 둔다.
   */
  const closeAndCleanup = async (): Promise<void> => {
    const current = unixSocket ? fileIdentity(paths.pipe) : null;
    const foreign = boundSocket !== null && current !== null && current !== boundSocket;
    const aside = `${paths.pipe}.${process.pid}.keep`;
    if (foreign) renameSync(paths.pipe, aside);
    try {
      await server?.close();
    } finally {
      if (foreign) {
        renameSync(aside, paths.pipe);
      } else if (boundSocket !== null && fileIdentity(paths.pipe) === boundSocket) {
        unlinkIfExists(paths.pipe);
      }
      if (token !== null) unlinkTokenIfOurs(paths.token, token);
      lock.release();
    }
  };

  try {
    // 잠금을 잡았으므로 남아 있는 소켓 파일은 죽은 인스턴스의 것이다
    if (unixSocket) unlinkIfExists(paths.pipe);
    const ownToken = writeTokenFile(paths.token);
    token = ownToken;

    let stopping: Promise<void> | null = null;
    let resolveClosed!: (reason: ShutdownReason) => void;
    const closed = new Promise<ShutdownReason>((resolve) => {
      resolveClosed = resolve;
    });

    const stop = (reason: ShutdownReason = 'requested'): Promise<void> => {
      stopping ??= (async () => {
        lifecycle.stop();
        try {
          await closeAndCleanup();
        } finally {
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
      token: ownToken,
      orchestratorVersion: version,
      handlers: createHandlers({
        orchestratorVersion: version,
        biveHome: options.biveHome,
        status: {
          startedAt,
          get connectionCount() {
            return lifecycle.connectionCount;
          },
          get activeRunCount() {
            return lifecycle.activeRunCount;
          },
        },
      }),
      ...(options.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: options.helloTimeoutMs }),
      onConnectionOpened: () => lifecycle.connectionOpened(),
      onConnectionClosed: () => lifecycle.connectionClosed(),
    });
    await server.listen();
    if (unixSocket) boundSocket = fileIdentity(paths.pipe);
    lifecycle.start();

    const listening = server;
    return {
      status: 'started',
      orchestrator: {
        paths,
        token: ownToken,
        version,
        staleLockTakenOver: locked.staleTakenOver,
        agent,
        runs: lifecycle,
        get connectionCount() {
          return listening.connectionCount;
        },
        stop,
        closed,
      },
    };
  } catch (error) {
    await closeAndCleanup().catch(() => undefined);
    throw error;
  }
};
