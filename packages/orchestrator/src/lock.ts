// 단일 인스턴스 잠금 (PRD 5.1: 사용자당 1개): `$BIVE_HOME/run/orchestrator.pid`.
// 파일은 임시 파일을 hard link로 걸어 만든다. link는 대상이 있으면 실패하므로 생성이 원자적이고,
// 다른 프로세스가 내용이 빈 잠금 파일을 읽는 순간이 없다.
import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

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

const unlinkIfExists = (file: string): void => {
  try {
    unlinkSync(file);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
};

/** 잠금 파일의 pid. 없거나 형식이 틀리면 null. */
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

export class PidLock {
  readonly path: string;
  readonly pid: number;
  #released = false;

  constructor(path: string, pid: number) {
    this.path = path;
    this.pid = pid;
  }

  /** 잠금을 푼다. 파일이 아직 이 pid를 가리킬 때만 지운다. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    if (readPidFile(this.path) === this.pid) unlinkIfExists(this.path);
  }
}

export type LockResult =
  | { acquired: true; lock: PidLock; staleTakenOver: boolean; stalePid: number | null }
  | { acquired: false; runningPid: number };

export interface AcquireOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

const MAX_ATTEMPTS = 5;

/**
 * 잠금을 잡는다. 살아 있는 다른 pid가 잡고 있으면 `acquired: false`.
 * 죽은 pid · 형식이 틀린 파일이면 지우고 인수한다 (`staleTakenOver: true`).
 */
export const acquirePidLock = (pidPath: string, options: AcquireOptions = {}): LockResult => {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? isProcessAlive;
  const temp = `${pidPath}.${pid}.tmp`;
  let staleTakenOver = false;
  let stalePid: number | null = null;
  writeFileSync(temp, `${pid}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        linkSync(temp, pidPath);
        return { acquired: true, lock: new PidLock(pidPath, pid), staleTakenOver, stalePid };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      const holder = readPidFile(pidPath);
      if (holder !== null && holder !== pid && isAlive(holder)) {
        return { acquired: false, runningPid: holder };
      }
      // 죽은 프로세스의 잠금: 지우고 다시 시도한다.
      // 그 사이 다른 기동이 먼저 인수했으면(내용이 바뀜) 지우지 않고 처음부터 다시 판단한다
      if (readPidFile(pidPath) !== holder) continue;
      staleTakenOver = true;
      stalePid = holder;
      unlinkIfExists(pidPath);
    }
    throw new Error(`잠금 파일을 잡지 못함: ${pidPath}`);
  } finally {
    unlinkIfExists(temp);
  }
};
