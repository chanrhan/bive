// 폴더 밖 저장소의 경로 (docs/architecture.md 3장 "저장소 배치", ADR-025).
// - BIVE_HOME 환경 변수가 있으면 그 경로, 없으면 `~/.bive`
// - 규범 · 기록: `$BIVE_HOME/projects/<projectId>/bive.db`, 등록부: `$BIVE_HOME/registry.db`
// - 작업 디렉터리 · 워크트리: `$BIVE_HOME/work`, 런타임(파이프 · 토큰 · pid): `$BIVE_HOME/run`
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { Ulid } from '@bive/shared';

/** 저장소 루트를 덮어쓰는 환경 변수 이름. 테스트는 임시 디렉터리로 덮어쓴다. */
export const BIVE_HOME_ENV = 'BIVE_HOME';

/** `BIVE_HOME`이 없을 때 홈 디렉터리 아래에 쓰는 폴더 이름. */
export const DEFAULT_BIVE_DIR_NAME = '.bive';

/** 프로젝트별 DB 파일 이름. */
export const PROJECT_DB_FILE_NAME = 'bive.db';

/** 프로젝트 등록부 DB 파일 이름. */
export const REGISTRY_DB_FILE_NAME = 'registry.db';

/**
 * 저장소 루트를 정한다. 환경 변수가 비어 있으면 미설정으로 본다. 상대 경로는 절대 경로로 바꾼다.
 * @param env 환경 변수 맵. 테스트에서 주입한다
 * @param home 사용자 홈 디렉터리. 테스트에서 주입한다
 */
export const resolveBiveHome = (
  env: NodeJS.ProcessEnv = process.env,
  home: () => string = homedir,
): string => {
  const value = env[BIVE_HOME_ENV];
  if (value !== undefined && value.trim() !== '') return resolve(value);
  return join(home(), DEFAULT_BIVE_DIR_NAME);
};

/**
 * 프로젝트 ID가 경로 조각으로 안전한지 확인한다. ULID만 허용해 `..` · 구분자로 저장소 밖을 가리키지 못하게 한다 (NFR-01).
 * @throws {TypeError} ULID가 아닐 때
 */
export const assertProjectId = (projectId: string): void => {
  if (!Ulid.safeParse(projectId).success) {
    throw new TypeError(`프로젝트 ID가 ULID 형식이 아닙니다: ${JSON.stringify(projectId)}`);
  }
};

/** 저장소 경로 묶음. 모든 경로는 절대 경로다. */
export interface BivePaths {
  /** 저장소 루트 (`$BIVE_HOME`). */
  readonly home: string;
  /** 프로젝트 등록부 DB (`$BIVE_HOME/registry.db`). */
  readonly registryDb: string;
  /** 프로젝트별 저장소의 상위 디렉터리 (`$BIVE_HOME/projects`). 에이전트 접근 불가. */
  readonly projectsRoot: string;
  /** 작업 디렉터리 · 워크트리 루트 (`$BIVE_HOME/work`). */
  readonly workRoot: string;
  /** 런타임 디렉터리 (`$BIVE_HOME/run`). 에이전트 접근 불가. */
  readonly runDir: string;
  /** 프로젝트별 저장소 디렉터리 (`$BIVE_HOME/projects/<projectId>`). */
  projectDir(projectId: string): string;
  /** 프로젝트별 DB (`$BIVE_HOME/projects/<projectId>/bive.db`). */
  projectDb(projectId: string): string;
}

/**
 * 저장소 경로 묶음을 만든다.
 * @param home 저장소 루트. 생략하면 `resolveBiveHome()`
 */
export const bivePaths = (home: string = resolveBiveHome()): BivePaths => {
  const root = resolve(home);
  const projectsRoot = join(root, 'projects');
  const projectDir = (projectId: string): string => {
    assertProjectId(projectId);
    return join(projectsRoot, projectId);
  };
  return {
    home: root,
    registryDb: join(root, REGISTRY_DB_FILE_NAME),
    projectsRoot,
    workRoot: join(root, 'work'),
    runDir: join(root, 'run'),
    projectDir,
    projectDb: (projectId) => join(projectDir(projectId), PROJECT_DB_FILE_NAME),
  };
};
