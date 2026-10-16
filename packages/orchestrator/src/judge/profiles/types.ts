// 스택 프로필: 판정용 서버를 띄우고 기준 URL을 돌려준다 (ADR-026).
import type { Deadline } from '../process.js';

/** 지원 프로필. M1은 `next-prisma-sqlite`만 (ADR-026). */
export type JudgeProfileName = 'next-prisma-sqlite';

/** 프로필 단계 이름. 소요 시간 · 실패 위치 표시에 쓴다. */
export type ProfileStep = 'migrate' | 'build' | 'start';

export interface ProfileContext {
  /** 실행 워크트리 (명령은 이 안의 `node_modules/.bin`만 쓴다) */
  worktreeDir: string;
  /** 허용 목록만 남긴 기본 환경 변수 */
  env: NodeJS.ProcessEnv;
  /** 마이그레이션 · 빌드 출력 로그 */
  profileLog: string;
  /** 서버 출력 로그 */
  serverLog: string;
  deadline: Deadline;
  /** 단계 소요 시간(ms) 보고 */
  onStep: (step: ProfileStep, ms: number) => void;
}

export interface StartedServer {
  /** 인수 테스트가 받는 기준 URL (`http://127.0.0.1:<port>`) */
  baseUrl: string;
  /** 서버 프로세스 ID (종료 확인용) */
  pid: number | null;
  /** 임시 데이터베이스 파일 경로 (종료 시 삭제) */
  databasePath: string;
  /** 서버 종료 · 임시 데이터베이스 삭제. 여러 번 불러도 한 번만 수행한다 */
  stop: () => Promise<void>;
}

/** 서버 기동 실패. 러너가 `runner_error`로 바꾼다. */
export class ProfileError extends Error {
  constructor(
    readonly step: ProfileStep,
    message: string,
  ) {
    super(`판정 서버 기동 실패 (${step}): ${message}`);
    this.name = 'ProfileError';
  }
}

export interface StackProfile {
  readonly name: JudgeProfileName;
  /** 서버를 띄운다. 실패하면 띄운 것을 모두 정리한 뒤 `ProfileError` · `JudgeTimeoutError`를 던진다 */
  start: (ctx: ProfileContext) => Promise<StartedServer>;
}
