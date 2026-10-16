// 판정 러너의 자식 프로세스 도우미 (JDG-01).
// - 셸 없이 실행한다 (`shell: false`, 인자 배열 그대로). 출력은 파일 서술자로 로그 파일에 바로 쓴다
// - POSIX에서는 새 프로세스 그룹으로 띄워 종료할 때 그룹 전체(next build 워커 · next start 하위 프로세스)를 끝낸다
// - 환경 변수는 허용 목록만 넘긴다 (architecture.md 10장 "환경 변수 정리")
import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync } from 'node:fs';
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

/** 프로세스(POSIX에서는 프로세스 그룹 전체)에 신호를 보낸다. 이미 끝났으면 무시. */
export const signalTree = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.pid === undefined) return;
  try {
    if (isWindows) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // ESRCH: 이미 끝남
  }
};

/**
 * 프로세스를 끝낸다: SIGTERM → `graceMs` 뒤에도 살아 있으면 SIGKILL.
 * 부모가 끝난 뒤에도 그룹에 남은 하위 프로세스가 있을 수 있어 마지막에 그룹 SIGKILL을 한 번 더 보낸다.
 */
export const stopProcess = async (child: ChildProcess, graceMs = 5_000): Promise<void> => {
  if (!exitedAlready(child)) {
    const exited = waitExit(child);
    signalTree(child, 'SIGTERM');
    const timer = setTimeout(() => signalTree(child, 'SIGKILL'), graceMs);
    await exited;
    clearTimeout(timer);
  }
  signalTree(child, 'SIGKILL');
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
  const timer = setTimeout(() => {
    timedOut = true;
    signalTree(child, 'SIGKILL');
  }, options.timeoutMs);
  const exit = await waitExit(child);
  clearTimeout(timer);
  // 정상 종료여도 그룹에 남은 하위 프로세스를 정리한다
  signalTree(child, 'SIGKILL');
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
