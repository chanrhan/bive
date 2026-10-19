// git CLI 실행기 (RUN-08 · ADR-052 · ADR-058).
// - 셸 없이 `execFile`(`shell: false`)로 git만 실행한다. 인자는 배열 그대로 넘긴다
// - 환경 변수는 고정 도구와 같은 허용 목록만 넘긴다(API 키 · 토큰 · `GIT_DIR` 같은 git 변수 미전달)
// - 모든 호출에 커밋 주체 · 훅 끄기 · 서명 끄기를 `-c`로 고정해 저장소 · 사용자 설정에 의존하지 않는다
import { execFile } from 'node:child_process';
import os from 'node:os';

import { COMMAND_ENV_ALLOWLIST } from '../tools/commands.js';

/** BIVE가 만드는 커밋 · 병합 커밋의 작성자 겸 커미터 (ADR-058). `.invalid`는 배달되지 않는 예약 도메인이다. */
export const BIVE_GIT_IDENTITY = { name: 'BIVE', email: 'bive@bive.invalid' } as const;

/** git 한 번의 기본 제한 시간. 워크트리 체크아웃이 가장 오래 걸린다. */
export const DEFAULT_GIT_TIMEOUT_MS = 5 * 60_000;

/** git 출력 상한 (상태 · 목록 출력 보호). */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * 모든 호출 앞에 붙이는 설정.
 * - 커밋 주체를 BIVE로 고정한다(저장소 · 전역 설정의 `user.*` 무시)
 * - 훅을 끈다: 프로젝트 훅이 BIVE 커밋 · 병합을 막거나 임의 코드를 돌리지 않게 한다. 장치 파일 아래 경로라 훅 파일이 있을 수 없다
 * - 서명 · 자동 정리 · 확인 프롬프트를 끈다(대화형 입력 없이 끝나야 한다)
 */
export const gitConfigArgs = (): string[] => [
  '-c',
  `user.name=${BIVE_GIT_IDENTITY.name}`,
  '-c',
  `user.email=${BIVE_GIT_IDENTITY.email}`,
  '-c',
  `core.hooksPath=${os.devNull}`,
  '-c',
  'commit.gpgsign=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'core.quotePath=false',
  '-c',
  'advice.detachedHead=false',
];

/**
 * 자식 git에 넘기는 환경 변수. 허용 목록 밖 변수(`GIT_AUTHOR_NAME` · `GIT_DIR` · `GIT_INDEX_FILE` · API 키 등)는 넘기지 않는다.
 * @param base 원본 환경 (기본 `process.env`)
 */
export const gitEnv = (
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of COMMAND_ENV_ALLOWLIST) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    // 자격 증명 프롬프트 없이 실패하게 한다
    GIT_TERMINAL_PROMPT: '0',
    // 사용자의 git과 겹칠 때 상태 조회가 색인 잠금을 잡지 않게 한다
    GIT_OPTIONAL_LOCKS: '0',
    // 시스템 전역 설정은 읽지 않는다. 사용자 전역 설정(줄 끝 변환 · safe.directory 등)은 `HOME`으로 읽는다
    GIT_CONFIG_NOSYSTEM: '1',
    // 사람이 읽는 메시지 해석에 기대지 않지만, 오류 사유를 같은 언어로 남긴다
    LC_ALL: 'C',
  };
};

export interface GitResult {
  stdout: string;
  stderr: string;
  /** 종료 코드. 신호로 끝났으면 `null`. */
  code: number | null;
}

/** git이 허용하지 않은 종료 코드로 끝났거나 실행되지 않은 경우. */
export class GitCommandError extends Error {
  override readonly name = 'GitCommandError';
  constructor(
    readonly args: readonly string[],
    readonly result: GitResult,
  ) {
    const detail = result.stderr.trim() || result.stdout.trim();
    super(
      `git ${args.join(' ')} 실패 (종료 코드 ${String(result.code)})${detail === '' ? '' : `: ${detail}`}`,
    );
  }
}

export interface GitRunOptions {
  cwd: string;
  /** 오류로 보지 않을 종료 코드 (기본 `[0]`) */
  okCodes?: readonly number[];
  timeoutMs?: number;
}

/** git 실행 함수. 시험에서 바꿔 끼울 수 있게 주입받는다. */
export type GitRunner = (args: readonly string[], options: GitRunOptions) => Promise<GitResult>;

export interface GitRunnerOptions {
  /** git 실행 파일 (기본 PATH의 `git`) */
  gitPath?: string;
  /** 허용 목록 변수를 고를 원본 (기본 `process.env`) */
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

/**
 * 셸 없이 git을 실행하는 함수를 만든다. 허용 종료 코드가 아니면 `GitCommandError`로 거부한다.
 */
export const createGitRunner = (options: GitRunnerOptions = {}): GitRunner => {
  const gitPath = options.gitPath ?? 'git';
  return (args, run) =>
    new Promise((resolve, reject) => {
      const fullArgs = [...gitConfigArgs(), ...args];
      execFile(
        gitPath,
        fullArgs,
        {
          cwd: run.cwd,
          env: gitEnv(options.baseEnv),
          shell: false,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: MAX_BUFFER_BYTES,
          timeout: run.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        },
        (error, stdout, stderr) => {
          let code: number | null = 0;
          if (error !== null) {
            // 실행 파일 없음(ENOENT) 등은 숫자 코드가 없다
            code = typeof error.code === 'number' ? error.code : null;
          }
          const result: GitResult = { stdout, stderr, code };
          const okCodes = run.okCodes ?? [0];
          if (code !== null && okCodes.includes(code)) {
            resolve(result);
            return;
          }
          if (error !== null && typeof error.code !== 'number') {
            result.stderr = `${stderr}${stderr === '' ? '' : '\n'}${error.message}`;
          }
          reject(new GitCommandError(args, result));
        },
      );
    });
};
