// `$BIVE_HOME/run` 아래 파일 경로 (ADR-025 · ADR-027 · ADR-041).
// app은 orchestrator 패키지를 import할 수 없으므로(architecture.md 2장) 같은 규칙을 여기에 둔다.
// 두 구현이 같은 경로를 내는지는 test/run-paths.test.ts가 orchestrator 원본과 대조한다.
import os from 'node:os';
import path from 'node:path';

export const RUN_DIR_NAME = 'run';
export const SOCKET_FILE_NAME = 'orchestrator.sock';
export const TOKEN_FILE_NAME = 'token';
export const ORCHESTRATOR_PID_FILE_NAME = 'orchestrator.pid';
export const APP_PID_FILE_NAME = 'app.pid';
const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\';

/** `BIVE_HOME` 환경 변수(기본 `~/.bive`)를 절대 경로로 푼다. */
export const resolveBiveHome = (
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string => {
  const fromEnv = env.BIVE_HOME;
  return fromEnv !== undefined && fromEnv.length > 0
    ? path.resolve(fromEnv)
    : path.join(homeDir, '.bive');
};

const sanitizePipeSegment = (value: string): string => {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'user';
};

export interface AppRunPaths {
  /** `$BIVE_HOME/run` */
  dir: string;
  /** 파이프: Unix 소켓 파일 또는 Windows named pipe 이름 */
  pipe: string;
  /** 접속 토큰 (오케스트레이터가 기동마다 갱신) */
  token: string;
  /** 오케스트레이터 단일 인스턴스 잠금 */
  orchestratorPid: string;
  /** 앱 main 프로세스 pid */
  appPid: string;
}

export const appRunPaths = (
  biveHome: string,
  platform: NodeJS.Platform = process.platform,
  username: string = os.userInfo().username,
): AppRunPaths => {
  const dir = path.join(biveHome, RUN_DIR_NAME);
  return {
    dir,
    pipe:
      platform === 'win32'
        ? `${WINDOWS_PIPE_PREFIX}bive-${sanitizePipeSegment(username)}`
        : path.posix.join(biveHome, RUN_DIR_NAME, SOCKET_FILE_NAME),
    token: path.join(dir, TOKEN_FILE_NAME),
    orchestratorPid: path.join(dir, ORCHESTRATOR_PID_FILE_NAME),
    appPid: path.join(dir, APP_PID_FILE_NAME),
  };
};
