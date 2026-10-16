// `$BIVE_HOME/run` 아래 실행 파일 경로 (ADR-025 · ADR-027).
import os from 'node:os';
import path from 'node:path';

import { pipePath, RUN_DIR_NAME } from './pipe-path.js';

export const TOKEN_FILE_NAME = 'token';
export const PID_FILE_NAME = 'orchestrator.pid';

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

export interface RunPaths {
  /** `$BIVE_HOME/run` (0700) */
  dir: string;
  /** 파이프 경로: Unix 소켓 파일 또는 Windows named pipe 이름 */
  pipe: string;
  /** 접속 토큰 (0600, 기동마다 갱신) */
  token: string;
  /** 단일 인스턴스 잠금 */
  pid: string;
}

export const runPaths = (
  biveHome: string,
  platform: NodeJS.Platform = process.platform,
  username: string = os.userInfo().username,
): RunPaths => {
  const dir = path.join(biveHome, RUN_DIR_NAME);
  return {
    dir,
    pipe: pipePath({ platform, biveHome, username }),
    token: path.join(dir, TOKEN_FILE_NAME),
    pid: path.join(dir, PID_FILE_NAME),
  };
};
