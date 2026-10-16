// 판정 러너의 자식 프로세스 도우미 (JDG-01).
// - 셸 없이 실행한다 (`shell: false`, 인자 배열 그대로). 출력은 파일 서술자로 로그 파일에 바로 쓴다
// - POSIX에서는 새 프로세스 그룹으로 띄우고, 종료할 때 그룹 전체와 미리 찾은 하위 프로세스 트리
//   (자기 그룹을 따로 만드는 next build의 타입 검사 등)를 함께 끝낸다
// - 환경 변수는 허용 목록만 넘긴다 (architecture.md 10장 "환경 변수 정리")
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';

/** 자식 프로세스에 넘기는 부모 환경 변수 허용 목록. 나머지(VITEST_* · NODE_ENV · 비밀 값 등)는 넘기지 않는다. */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  // Windows 실행에 필요한 값
  'Path',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'ComSpec',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
] as const;

/** 허용 목록만 남긴 기본 환경 변수. */
export const baseChildEnv = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
};

/** 판정 실행 전체의 마감 시각. 단계마다 남은 시간만 쓴다. */
export class Deadline {
  readonly #at: number;

  constructor(timeoutMs: number, now: number = Date.now()) {
    this.#at = now + timeoutMs;
  }

  /** 남은 시간(ms). 지났으면 0. */
  remaining(): number {
    return Math.max(0, this.#at - Date.now());
  }

  expired(): boolean {
    return this.remaining() === 0;
  }
}

/** 마감 시각을 넘긴 단계. 러너가 `runner_error`로 바꾼다. */
export class JudgeTimeoutError extends Error {
  constructor(readonly step: string) {
    super(`판정 시간 초과 (${step} 단계)`);
    this.name = 'JudgeTimeoutError';
  }
}

const isWindows = process.platform === 'win32';

export interface StartOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 표준 출력을 덧붙일 파일 */
  stdoutFile: string;
  /** 표준 오류를 덧붙일 파일 (생략하면 표준 출력과 같은 파일) */
  stderrFile?: string;
}

/** 로그 파일에 명령 머리줄을 남기고 프로세스를 띄운다. */
export const startProcess = (cmd: string, args: string[], options: StartOptions): ChildProcess => {
  appendFileSync(options.stdoutFile, `\n$ ${[cmd, ...args].join(' ')}\n`);
  const out = openSync(options.stdoutFile, 'a');
  const err =
    options.stderrFile === undefined || options.stderrFile === options.stdoutFile
      ? out
      : openSync(options.stderrFile, 'a');
  try {
    return spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', out, err],
      shell: false,
      detached: !isWindows,
      windowsHide: true,
    });
  } finally {
    // 자식은 spawn 시점에 서술자를 복제하므로 부모 쪽은 바로 닫는다
    closeSync(out);
    if (err !== out) closeSync(err);
  }
};

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** 실행 자체 실패 (ENOENT 등) */
  error: Error | null;
}

const exitedAlready = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

/** 프로세스 종료를 기다린다. 실행 실패(`error` 이벤트)도 종료로 돌려준다. */
export const waitExit = (child: ChildProcess): Promise<ExitInfo> => {
  if (exitedAlready(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode, error: null });
  }
  return new Promise((resolve) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      child.off('error', onError);
      resolve({ code, signal, error: null });
    };
    const onError = (error: Error): void => {
      child.off('exit', onExit);
      resolve({ code: null, signal: null, error });
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
};

interface ProcInfo {
  pid: number;
  ppid: number;
  /** 시작 시각 표식 (Linux /proc stat 22번째 필드). PID 재사용 확인용, 모르면 빈 문자열 */
  start: string;
}

const readLinuxStat = (pid: string): ProcInfo | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // 2번째 필드(실행 파일 이름)에 공백 · 괄호가 있을 수 있어 마지막 ')' 뒤부터 나눈다
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid: Number(pid), ppid: Number(fields[1]), start: fields[19] ?? '' };
  } catch {
    return null;
  }
};

/** 현재 프로세스 표 (pid · ppid). Linux는 /proc, 그 밖 POSIX는 ps. */
const readProcessTable = (): ProcInfo[] => {
  if (isWindows) return [];
  if (process.platform === 'linux') {
    try {
      return readdirSync('/proc')
        .filter((name) => /^\d+$/.test(name))
        .map(readLinuxStat)
        .filter((info): info is ProcInfo => info !== null);
    } catch {
      return [];
    }
  }
  try {
    return execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols.length === 2)
      .map(([pid, ppid]) => ({ pid: Number(pid), ppid: Number(ppid), start: '' }));
  } catch {
    return [];
  }
};

/**
 * `root`의 모든 하위 프로세스. 하위 프로세스가 자기 프로세스 그룹을 따로 만들면(next build의 타입 검사 등)
 * 그룹 신호가 닿지 않고, 부모가 끝나면 init으로 옮겨져 찾을 수 없으므로 종료 전에 미리 찾아 둔다.
 */
const descendants = (root: number): ProcInfo[] => {
  const table = readProcessTable();
  const found: ProcInfo[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const info of table) {
      if (info.ppid === parent && !found.some((f) => f.pid === info.pid)) {
        found.push(info);
        queue.push(info.pid);
      }
    }
  }
  return found;
};

/** 스냅숏의 프로세스가 아직 같은 프로세스인지 (PID 재사용이면 신호를 보내지 않는다). */
const isSameProcess = (info: ProcInfo): boolean => {
  if (info.start === '') return true;
  return readLinuxStat(String(info.pid))?.start === info.start;
};

const trySignal = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH: 이미 끝남
  }
};

/** 스냅숏에 있던 하위 프로세스에 신호를 보낸다. */
const signalSnapshot = (snapshot: readonly ProcInfo[], signal: NodeJS.Signals): void => {
  for (const info of snapshot) if (isSameProcess(info)) trySignal(info.pid, signal);
};

/**
 * 프로세스와 그 하위 전체에 신호를 보낸다: POSIX 프로세스 그룹 + 미리 찾은 하위 프로세스.
 * 이미 끝났으면 무시. 보낸 대상 스냅숏을 돌려준다.
 */
export const signalTree = (child: ChildProcess, signal: NodeJS.Signals): ProcInfo[] => {
  if (child.pid === undefined) return [];
  if (isWindows) {
    child.kill(signal);
    return [];
  }
  const snapshot = descendants(child.pid);
  trySignal(-child.pid, signal);
  trySignal(child.pid, signal);
  signalSnapshot(snapshot, signal);
  return snapshot;
};

/**
 * 프로세스를 끝낸다: SIGTERM → `graceMs` 뒤에도 살아 있으면 SIGKILL.
 * 부모가 끝난 뒤에도 남은 하위 프로세스가 있을 수 있어 마지막에 그룹 · 스냅숏 전체에 SIGKILL을 보낸다.
 */
export const stopProcess = async (child: ChildProcess, graceMs = 5_000): Promise<void> => {
  const snapshot: ProcInfo[] = [];
  if (!exitedAlready(child)) {
    const exited = waitExit(child);
    snapshot.push(...signalTree(child, 'SIGTERM'));
    const timer = setTimeout(() => snapshot.push(...signalTree(child, 'SIGKILL')), graceMs);
    await exited;
    clearTimeout(timer);
  }
  if (child.pid !== undefined && !isWindows) trySignal(-child.pid, 'SIGKILL');
  signalSnapshot(snapshot, 'SIGKILL');
};

export interface CommandResult extends ExitInfo {
  timedOut: boolean;
  durationMs: number;
}

/** 명령을 끝까지 실행한다. `timeoutMs`가 지나면 프로세스 그룹을 SIGKILL하고 `timedOut`을 돌려준다. */
export const runCommand = async (
  cmd: string,
  args: string[],
  options: StartOptions & { timeoutMs: number },
): Promise<CommandResult> => {
  const started = Date.now();
  if (options.timeoutMs <= 0) {
    return { code: null, signal: null, error: null, timedOut: true, durationMs: 0 };
  }
  const child = startProcess(cmd, args, options);
  let timedOut = false;
  let killed: ProcInfo[] = [];
  const timer = setTimeout(() => {
    timedOut = true;
    killed = signalTree(child, 'SIGKILL');
  }, options.timeoutMs);
  const exit = await waitExit(child);
  clearTimeout(timer);
  // 정상 종료여도 그룹에 남은 하위 프로세스를 정리한다
  if (child.pid !== undefined && !isWindows) trySignal(-child.pid, 'SIGKILL');
  signalSnapshot(killed, 'SIGKILL');
  return { ...exit, timedOut, durationMs: Date.now() - started };
};

/** 종료 정보를 한 줄로. */
export const describeExit = (exit: ExitInfo): string => {
  if (exit.error !== null) return `실행 실패: ${exit.error.message}`;
  if (exit.signal !== null) return `신호 ${exit.signal}로 종료`;
  return `종료 코드 ${String(exit.code)}`;
};

/** 127.0.0.1의 빈 TCP 포트. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
