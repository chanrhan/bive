// 파이프 경로 (architecture.md 5장, NFR-10).
// Windows는 named pipe `\\.\pipe\bive-<사용자>`, 그 밖은 Unix 소켓 `$BIVE_HOME/run/orchestrator.sock`.
// OS를 인자로 받는 순수 함수라서 어느 OS에서든 경로 문자열을 단위 테스트할 수 있다.
import path from 'node:path';

export const RUN_DIR_NAME = 'run';
export const SOCKET_FILE_NAME = 'orchestrator.sock';
export const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\';

export interface PipePathInput {
  platform: NodeJS.Platform;
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** OS 사용자 이름 (Windows 파이프 이름에 쓴다) */
  username: string;
}

/** 파이프 이름에 쓸 수 없는 문자(역슬래시 등)와 공백을 `_`로 바꾼다. 비면 `user`. */
export const sanitizePipeSegment = (value: string): string => {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'user';
};

/** 오케스트레이터가 듣고 앱이 접속하는 파이프 경로. */
export const pipePath = ({ platform, biveHome, username }: PipePathInput): string => {
  if (platform === 'win32') {
    return `${WINDOWS_PIPE_PREFIX}bive-${sanitizePipeSegment(username)}`;
  }
  return path.posix.join(biveHome, RUN_DIR_NAME, SOCKET_FILE_NAME);
};

/**
 * Unix 소켓 경로의 최대 바이트 수 (`sockaddr_un.sun_path` 크기 - 종료 NUL).
 * Linux 108, macOS · BSD 104. Windows named pipe는 이 제한이 없다.
 */
export const maxSocketPathBytes = (platform: NodeJS.Platform): number | null => {
  if (platform === 'win32') return null;
  if (platform === 'linux' || platform === 'android') return 107;
  return 103;
};

/** 소켓 경로가 OS 제한을 넘으면 예외. `BIVE_HOME`이 너무 깊은 경우를 기동 시점에 알린다. */
export const assertSocketPathLength = (socketPath: string, platform: NodeJS.Platform): void => {
  const max = maxSocketPathBytes(platform);
  if (max === null) return;
  const bytes = Buffer.byteLength(socketPath, 'utf8');
  if (bytes > max) {
    throw new Error(
      `소켓 경로가 너무 김 (${bytes}바이트, 최대 ${max}바이트): ${socketPath}. BIVE_HOME을 더 짧은 경로로 지정해야 함`,
    );
  }
};
