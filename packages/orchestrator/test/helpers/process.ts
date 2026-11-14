// 테스트용 임시 BIVE_HOME · 오케스트레이터 자식 프로세스 도우미.
// 테스트가 끝나면 cleanup()으로 자식 프로세스 · 임시 폴더를 모두 정리한다.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
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
  readonly stderr: string;
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
    get stderr() {
      return stderr;
    },
  };
};

const childEnv = (env: Record<string, string>): NodeJS.ProcessEnv => {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
  // 부모 테스트 환경의 값이 새지 않게, 넘기지 않은 BIVE 변수는 지운다
  for (const name of ['BIVE_IDLE_SHUTDOWN_MS', 'BIVE_AGENT', 'BIVE_SCENARIO']) {
    if (env[name] === undefined) delete merged[name];
  }
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

/** 패키지 폴더 기준 상대 경로의 시험 진입점(예: `test/helpers/engine-orchestrator.ts`)을 같은 방식으로 띄운다. */
export const spawnScript = (script: string, env: Record<string, string>): Spawned =>
  track(
    spawn(process.execPath, [...CLI_ARGS.slice(0, -1), script], {
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

/**
 * 조건이 참이 될 때까지 기다린다. 조건이 던진 예외(예: 파일이 잠깐 없어 ENOENT)는 거짓으로 보고 계속 기다리며,
 * 시간이 다 되면 마지막 예외를 메시지에 붙인다.
 */
export const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      if (await condition()) return;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const detail = lastError instanceof Error ? ` (마지막 오류: ${lastError.message})` : '';
      throw new Error(`시간 초과: ${what}${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `pid`가 이 테스트가 만든 `home`의 오케스트레이터인지 (환경 변수 `BIVE_HOME`이 그 폴더인 프로세스).
 * 잠금 파일의 pid는 테스트가 지어낸 숫자이거나 다른 프로세스가 다시 쓰는 번호일 수 있어, 확인된 것만 죽인다.
 * 확인할 수 없으면(권한 없음 · Windows) 거짓: 남은 오케스트레이터는 유휴 종료로 스스로 끝난다.
 */
export const isOrchestratorOf = (pid: number, home: string): boolean => {
  const wanted = `BIVE_HOME=${home}`;
  try {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(wanted);
    }
    if (process.platform === 'win32') return false;
    // macOS · BSD: `ps e`는 명령줄 뒤에 환경 변수를 붙여 보여 준다
    const shown = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    return shown.split(/\s+/).includes(wanted);
  } catch {
    return false;
  }
};

/** 잠금 파일이 가리키는 이 테스트의 오케스트레이터 pid (살아 있고 `BIVE_HOME`이 그 폴더인 것만). */
const ownOrchestratorPids = (): { pid: number; home: string }[] =>
  homes.flatMap((home) => {
    const pid = readPidFile(runPaths(home).pid);
    return pid !== null && pid !== process.pid && isProcessAlive(pid) && isOrchestratorOf(pid, home)
      ? [{ pid, home }]
      : [];
  });

const closedOf = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('close', () => resolve());
  });

/**
 * 정상 종료 요청: 남은 자식 프로세스(자기가 띄운 핸들)와 잠금 파일이 가리키는 이 테스트의 오케스트레이터
 * (`isOrchestratorOf`로 확인한 것만)에 SIGTERM을 보내고 `timeoutMs`까지 끝나기를 기다린다. 오케스트레이터의 SIGTERM
 * 처리기(`src/cli.ts`)는 진행 중 실행을 중단하고, 판정 러너는 중단 신호로 자기가 띄운 프로세스 그룹 · 하위 프로세스를
 * 끝낸 뒤에야 엔진이 멈춘다(`src/judge/process.ts`의 `runCommand`). 그래서 판정 도중 실패 · 시간 초과한 시험도
 * `next start` 등을 남기지 않는다. 그때까지 끝나지 않은 프로세스는 `cleanup`의 SIGKILL이 맡는다.
 */
export const terminate = async (timeoutMs: number): Promise<void> => {
  const waits: Promise<void>[] = [];
  const childPids = new Set<number>();
  for (const child of children) {
    if (child.pid !== undefined) childPids.add(child.pid);
    if (child.exitCode !== null || child.signalCode !== null) continue;
    waits.push(closedOf(child));
    child.kill('SIGTERM');
  }
  for (const { pid, home } of ownOrchestratorPids()) {
    if (childPids.has(pid)) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      continue; // 이미 끝남
    }
    waits.push(
      waitFor(() => !(isProcessAlive(pid) && isOrchestratorOf(pid, home)), timeoutMs, '종료'),
    );
  }
  if (waits.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(waits),
    new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs))),
  ]);
  clearTimeout(timer);
};

export interface LeftoverProcess {
  pid: number;
  /** 명령줄 (공백 구분) */
  command: string;
  /** 작업 폴더 */
  cwd: string;
}

/**
 * 이 테스트의 `home` 안을 작업 폴더로 쓰는 프로세스(판정 체크아웃의 `next start` 등)와 환경 변수 `BIVE_HOME`이
 * `home`인 프로세스 목록. 판정 러너의 하위 프로세스는 환경 변수 허용 목록만 받아 `BIVE_HOME`이 없으므로 작업 폴더로 찾는다.
 * 확인만 한다(죽이지 않는다). Linux 밖에서는 빈 목록.
 */
export const leftoverProcesses = (home: string): LeftoverProcess[] => {
  if (process.platform !== 'linux') return [];
  let names: string[];
  try {
    names = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const found: LeftoverProcess[] = [];
  for (const name of names) {
    const pid = Number(name);
    if (pid === process.pid) continue;
    let cwd = '';
    try {
      // 지워진 폴더는 끝에 ` (deleted)`가 붙는다
      cwd = readlinkSync(`/proc/${name}/cwd`).replace(/ \(deleted\)$/u, '');
    } catch {
      // 끝났거나 좀비 · 권한 없음
    }
    const inHome = cwd !== '' && (cwd === home || cwd.startsWith(`${home}/`));
    if (!inHome && !isOrchestratorOf(pid, home)) continue;
    let command: string;
    try {
      command = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').join(' ').trim();
    } catch {
      continue;
    }
    found.push({ pid, command, cwd });
  }
  return found;
};

/** 지금 정리 대상인 임시 BIVE_HOME 목록 (남은 프로세스 확인용). */
export const trackedHomes = (): readonly string[] => [...homes];

/** 남은 자식 프로세스 · 잠금 파일이 가리키는 이 테스트의 오케스트레이터를 죽이고 임시 폴더를 지운다. */
export const cleanup = async (): Promise<void> => {
  for (const { pid } of ownOrchestratorPids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 이미 끝남
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
