// 오케스트레이터 기동 · 접속 (PRD 5.1, NFR-06, ADR-041 · ADR-042).
// `$BIVE_HOME/run/orchestrator.pid`가 살아 있으면 붙고, 없으면 분리(detached) 프로세스로 띄운 뒤 접속한다.
// 앱이 끝나도 오케스트레이터는 그대로 둔다. 종료는 오케스트레이터의 유휴 종료가 맡는다.
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ErrorCode } from '@bive/shared';

import { appRunPaths } from './run-paths.js';
import { connectPipe, type PipeClient, type PipeNet, PipeRpcError } from './pipe-client.js';

/** 접속 재시도 간격 · 한도 (ADR-041: 잠금을 잡은 뒤 소켓을 bind하기 전 틈). */
export const CONNECT_RETRY_INTERVAL_MS = 100;
export const CONNECT_TIMEOUT_MS = 5000;

/**
 * 오케스트레이터 실행 방식.
 * - `source`: 빌드 없이 tsx로 `src/cli.ts` (`pnpm --filter @bive/orchestrator start`와 같은 방식)
 * - `dist`: 빌드 산출물 `dist/cli.js`
 */
export type OrchestratorMode = 'source' | 'dist';

export interface OrchestratorCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * 실행 방식을 고른다. `BIVE_ORCHESTRATOR_MODE`(source | dist)가 있으면 그 값,
 * 없으면 패키징된 앱은 `dist`, 개발 실행은 `source`.
 */
export const resolveOrchestratorMode = (
  env: NodeJS.ProcessEnv,
  packaged: boolean,
): OrchestratorMode => {
  const fromEnv = env.BIVE_ORCHESTRATOR_MODE;
  if (fromEnv === 'source' || fromEnv === 'dist') return fromEnv;
  if (fromEnv !== undefined && fromEnv !== '') {
    throw new Error(`BIVE_ORCHESTRATOR_MODE는 source 또는 dist여야 함: ${fromEnv}`);
  }
  return packaged ? 'dist' : 'source';
};

export interface OrchestratorCommandInput {
  mode: OrchestratorMode;
  /** orchestrator 패키지 폴더 (`src/` · `dist/`가 있는 곳) */
  orchestratorDir: string;
  /** Node 실행 파일 */
  nodePath: string;
  biveHome: string;
  /** 부모 환경. 그대로 물려주되 `BIVE_HOME`은 확정한 값으로 덮는다 */
  env: NodeJS.ProcessEnv;
  /** Electron 실행 파일을 Node로 쓸 때(패키징) `ELECTRON_RUN_AS_NODE=1`을 붙인다 */
  runAsNode?: boolean;
}

export const orchestratorCommand = ({
  mode,
  orchestratorDir,
  nodePath,
  biveHome,
  env,
  runAsNode = false,
}: OrchestratorCommandInput): OrchestratorCommand => {
  const childEnv: NodeJS.ProcessEnv = { ...env, BIVE_HOME: biveHome };
  if (runAsNode) childEnv.ELECTRON_RUN_AS_NODE = '1';
  else delete childEnv.ELECTRON_RUN_AS_NODE;
  const args =
    mode === 'source'
      ? [
          '--conditions=@bive/source',
          '--import',
          'tsx',
          path.join(orchestratorDir, 'src', 'cli.ts'),
        ]
      : [path.join(orchestratorDir, 'dist', 'cli.js')];
  // cwd = 패키지 폴더: `--import tsx`를 orchestrator의 node_modules에서 찾는다
  return { command: nodePath, args, cwd: orchestratorDir, env: childEnv };
};

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface EnsureOptions {
  biveHome: string;
  command: OrchestratorCommand;
  spawn?: SpawnFn;
  net?: PipeNet;
  isAlive?: (pid: number) => boolean;
  retryIntervalMs?: number;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  username?: string;
}

export interface EnsureResult {
  client: PipeClient;
  /** 이번 호출이 오케스트레이터를 띄웠는지 */
  launched: boolean;
  /** 띄운 자식 프로세스 pid (붙었으면 null) */
  spawnedPid: number | null;
}

/** pid가 살아 있는지. 다른 사용자 프로세스라 신호 권한이 없으면(EPERM) 살아 있는 것으로 본다. */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

/** pid 파일 내용. 없거나 형식이 틀리면 null. */
export const readPidFile = (pidPath: string): number | null => {
  let text: string;
  try {
    text = readFileSync(pidPath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  const trimmed = text.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) ? pid : null;
};

/**
 * 재시도할 오류: 소켓 · 토큰이 아직 없음(ENOENT), 아직 듣지 않음(ECONNREFUSED),
 * 토큰이 바뀌는 중이라 인증 거부(-32020, 죽은 인스턴스의 토큰을 읽은 경우).
 */
const isRetryable = (error: unknown): boolean => {
  const code = errorCode(error);
  if (code === 'ENOENT' || code === 'ECONNREFUSED') return true;
  return error instanceof PipeRpcError && error.code === ErrorCode.Unauthorized;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 분리 프로세스로 띄운다: 새 프로세스 그룹 · 표준 입출력 없음 · 부모가 기다리지 않음. */
export const spawnDetached = (spawn: SpawnFn, command: OrchestratorCommand): ChildProcess => {
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: command.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child;
};

/**
 * 오케스트레이터에 접속한다. 잠금 파일의 pid가 살아 있지 않으면 분리 프로세스로 띄운다.
 * 접속은 {@link CONNECT_RETRY_INTERVAL_MS} 간격으로 {@link CONNECT_TIMEOUT_MS}까지 재시도한다.
 * 기다리는 동안 붙으려던 인스턴스가 사라지면(유휴 종료 직전 등) 그때 띄운다.
 */
export const ensureOrchestrator = async (options: EnsureOptions): Promise<EnsureResult> => {
  const paths = appRunPaths(options.biveHome, options.platform, options.username);
  const spawn = options.spawn ?? (nodeSpawn as SpawnFn);
  const isAlive = options.isAlive ?? isProcessAlive;
  const interval = options.retryIntervalMs ?? CONNECT_RETRY_INTERVAL_MS;
  const deadline = Date.now() + (options.timeoutMs ?? CONNECT_TIMEOUT_MS);

  let launched = false;
  let spawnedPid: number | null = null;
  let spawnError: Error | null = null;

  const runningPid = (): number | null => {
    const pid = readPidFile(paths.orchestratorPid);
    return pid !== null && isAlive(pid) ? pid : null;
  };

  for (;;) {
    if (!launched && runningPid() === null) {
      const child = spawnDetached(spawn, options.command);
      child.once('error', (error) => {
        spawnError = error;
      });
      launched = true;
      spawnedPid = child.pid ?? null;
    }
    if (spawnError !== null) {
      throw new Error(`오케스트레이터 기동 실패: ${(spawnError as Error).message}`);
    }
    try {
      const token = readFileSync(paths.token, 'utf8');
      const client = await connectPipe(paths.pipe, token, options.net);
      return { client, launched, spawnedPid };
    } catch (error) {
      if (!isRetryable(error)) throw error;
      if (Date.now() + interval > deadline) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`오케스트레이터 접속 시간 초과 (${paths.pipe}): ${detail}`, {
          cause: error,
        });
      }
    }
    await sleep(interval);
  }
};
