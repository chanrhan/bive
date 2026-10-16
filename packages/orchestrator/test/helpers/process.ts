// 테스트용 임시 BIVE_HOME · 오케스트레이터 자식 프로세스 도우미.
// 테스트가 끝나면 cleanup()으로 자식 프로세스 · 임시 폴더를 모두 정리한다.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isProcessAlive, readPidFile } from '../../src/lock.js';
import { runPaths } from '../../src/run-paths.js';

export const ORCHESTRATOR_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const REPO_ROOT = path.resolve(ORCHESTRATOR_DIR, '../..');

/** `start` 스크립트와 같은 실행 방식: 빌드 없이 src를 tsx로 (ADR-039의 `@bive/source` 조건). */
const CLI_ARGS = ['--conditions=@bive/source', '--import', 'tsx', 'src/cli.ts'];

const homes: string[] = [];
const children = new Set<ChildProcess>();

/**
 * 짧은 임시 BIVE_HOME. Unix 소켓 경로 제한(Linux 108바이트)을 넘지 않도록 `/tmp` 바로 아래에 만든다.
 */
export const makeBiveHome = (): string => {
  const base = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const home = mkdtempSync(path.join(base, 'bive-'));
  homes.push(home);
  return home;
};

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface Spawned {
  child: ChildProcess;
  exited: Promise<Exit>;
  readonly stdout: string;
}

const track = (child: ChildProcess): Spawned => {
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => (stdout += chunk));
  child.stderr?.on('data', (chunk: string) => (stderr += chunk));
  const exited = new Promise<Exit>((resolve) => {
    child.on('close', (code, signal) => {
      children.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return {
    child,
    exited,
    get stdout() {
      return stdout;
    },
  };
};

const childEnv = (env: Record<string, string>): NodeJS.ProcessEnv => {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
  // 부모 테스트 환경의 값이 새지 않게, 넘기지 않은 BIVE 변수는 지운다
  if (env.BIVE_IDLE_SHUTDOWN_MS === undefined) delete merged.BIVE_IDLE_SHUTDOWN_MS;
  return merged;
};

/** 오케스트레이터 CLI를 node로 직접 띄운다 (pid = 자식 pid). */
export const spawnCli = (env: Record<string, string>): Spawned =>
  track(
    spawn(process.execPath, CLI_ARGS, {
      cwd: ORCHESTRATOR_DIR,
      env: childEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );

/** 수용 기준 그대로 `pnpm --filter @bive/orchestrator start`로 띄운다. */
export const spawnPnpmStart = (env: Record<string, string>): Spawned =>
  track(
    spawn('pnpm', ['--silent', '--filter', '@bive/orchestrator', 'start'], {
      cwd: REPO_ROOT,
      env: childEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    }),
  );

/** 조건이 참이 될 때까지 기다린다. */
export const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`시간 초과: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 남은 자식 프로세스 · 잠금 파일이 가리키는 프로세스를 죽이고 임시 폴더를 지운다. */
export const cleanup = async (): Promise<void> => {
  for (const home of homes) {
    const pid = readPidFile(runPaths(home).pid);
    if (pid !== null && pid !== process.pid && isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 이미 끝남
      }
    }
  }
  const waiting = [...children].map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('close', () => resolve());
        child.kill('SIGKILL');
      }),
  );
  await Promise.all(waiting);
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
};
