// 프로젝트 등록부 (`$BIVE_HOME/registry.db`). 프로젝트별 DB와 분리한 별도 SQLite 파일이다 (ADR-040).
// - 등록부에는 등록된 프로젝트 ID · 등록 시각만 둔다. 프로젝트 내용의 원본은 프로젝트별 DB의 `projects` 행
// - 등록 순서: 프로젝트별 DB 생성 · 행 저장 → 등록부 항목 추가(마지막). 등록부에 있는 ID = 등록이 끝난 프로젝트
// - 등록 해제는 등록부 항목만 지운다. 프로젝트별 DB(규범 · 기록)는 지우지 않는다 (NFR-01, NRM-07)
import { isDeepStrictEqual } from 'node:util';

import { Project } from '@bive/shared';

import { openDatabase, withTransaction, type SqliteDatabase } from './database.js';
import { ConflictError, NotFoundError } from './errors.js';
import { migrate } from './migrate.js';
import { REGISTRY_MIGRATIONS } from './migrations/registry/index.js';
import { openProjectStore, type OpenStoreOptions } from './project-store.js';
import { bivePaths } from './paths.js';
import { RegistryRepository } from './repositories/registry-repository.js';

/** 열린 등록부. 다 쓰면 `close()`를 부른다. */
export class RegistryStore {
  readonly entries: RegistryRepository;

  constructor(
    /** DB 파일의 절대 경로. */
    readonly path: string,
    readonly db: SqliteDatabase,
  ) {
    this.entries = new RegistryRepository(db);
  }

  /** 함수를 쓰기 트랜잭션 안에서 실행한다 (`withTransaction`). */
  transaction<T>(fn: () => T): T {
    return withTransaction(this.db, fn);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * 등록부 DB를 열고(없으면 만들고) 마이그레이션을 적용한다.
 * @throws {NotFoundError} `create: false`인데 DB가 없을 때
 * @throws {MigrationError} 적용 기록이 코드와 맞지 않을 때 (DB는 닫힌다)
 */
export const openRegistry = (options: OpenStoreOptions = {}): RegistryStore => {
  const path = bivePaths(options.home).registryDb;
  const db = openDatabase(path, { create: options.create });
  try {
    migrate(db, REGISTRY_MIGRATIONS, options);
    return new RegistryStore(path, db);
  } catch (error) {
    db.close();
    throw error;
  }
};

export interface RegisterOptions {
  /** 저장소 루트. 생략하면 `BIVE_HOME` 또는 `~/.bive`. */
  readonly home?: string;
  /** 등록 시각 · 마이그레이션 적용 시각. 생략하면 현재 시각. */
  readonly now?: () => string;
}

const withRegistry = <T>(options: RegisterOptions, fn: (registry: RegistryStore) => T): T => {
  const registry = openRegistry(options);
  try {
    return fn(registry);
  } finally {
    registry.close();
  }
};

/**
 * 프로젝트를 등록한다: 프로젝트별 DB를 만들어 행을 저장하고 등록부에 추가한다.
 * 앞서 등록부 추가 전에 멈춘 등록(프로젝트별 DB에 같은 내용의 행만 있음)은 이어서 끝낸다.
 * @throws {ZodError} 스키마 위반
 * @throws {ConflictError} 이미 등록된 ID, 또는 프로젝트별 DB에 다른 내용 · 다른 프로젝트의 행이 있을 때
 */
export const registerProject = (input: Project, options: RegisterOptions = {}): Project => {
  const project = Project.parse(input);
  const now = options.now ?? (() => new Date().toISOString());
  return withRegistry(options, (registry) => {
    if (registry.entries.get(project.id) !== null) {
      throw new ConflictError('프로젝트', project.id, '이미 등록돼 있습니다');
    }
    const store = openProjectStore(project.id, options);
    try {
      store.transaction(() => {
        const existing = store.projects.list();
        if (existing.length === 0) {
          store.projects.create(project);
          return;
        }
        const [only] = existing;
        if (existing.length > 1 || !isDeepStrictEqual(only, project)) {
          throw new ConflictError(
            '프로젝트',
            project.id,
            '프로젝트별 DB에 다른 내용의 프로젝트 행이 있습니다',
          );
        }
      });
    } finally {
      store.close();
    }
    registry.entries.add({ projectId: project.id, registeredAt: now() });
    return project;
  });
};

/**
 * 등록부에서 지운다. 프로젝트별 DB는 남긴다. 지웠으면 `true`.
 */
export const unregisterProject = (projectId: string, options: RegisterOptions = {}): boolean =>
  withRegistry(options, (registry) => registry.entries.remove(projectId));

/**
 * 등록된 프로젝트를 등록 시각 순으로 돌려준다. 내용은 각 프로젝트별 DB에서 읽는다.
 * @throws {NotFoundError} 등록부에 있는데 프로젝트별 DB나 행이 없을 때 (저장소 손상을 숨기지 않는다)
 */
export const listRegisteredProjects = (options: RegisterOptions = {}): Project[] =>
  withRegistry(options, (registry) =>
    registry.entries.list().map(({ projectId }) => {
      const store = openProjectStore(projectId, { ...options, create: false });
      try {
        const project = store.getProject();
        if (project === null) throw new NotFoundError('프로젝트 행', projectId);
        return project;
      } finally {
        store.close();
      }
    }),
  );
