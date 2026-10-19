// `project.*` 처리기 (PRJ-01, M1-01, ADR-054).
// - `project.open`: 폴더 열기 · `.bive.json` 생성 · 재진입 (src/project/open-project.ts)
// - `project.current`: 이 오케스트레이터가 마지막으로 연 프로젝트. 메모리에만 두고, 응답할 때 등록부 · 저장소에서
//   다시 읽는다(등록 해제됐으면 null). 오케스트레이터가 다시 뜨면 비어 있다
// - `project.list`: 등록부의 프로젝트 전부 (등록 시각 순)
import { existsSync } from 'node:fs';

import { createUlidGenerator, type Ulid } from '@bive/shared';
import { bivePaths, listRegisteredProjects, NotFoundError, openRegistry } from '@bive/store';

import { openProjectFolder } from '../project/open-project.js';
import { toRpcError, withProjectStore } from './project-store-access.js';
import type { MethodHandlers } from './server.js';

export interface ProjectHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 시계 (ms). 프로젝트 ID · 생성 시각 · 등록 시각에 쓴다 */
  now: () => number;
}

type ProjectMethods = Pick<MethodHandlers, 'project.open' | 'project.current' | 'project.list'>;

const rethrowAsRpc = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    throw toRpcError(error);
  }
};

/** 등록부에 아직 있는지. 등록부 파일이 없으면 없는 것이다. */
const stillRegistered = (biveHome: string, projectId: Ulid): boolean => {
  let registry;
  try {
    registry = openRegistry({ home: biveHome, create: false });
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    throw error;
  }
  try {
    return registry.entries.get(projectId) !== null;
  } finally {
    registry.close();
  }
};

export const createProjectHandlers = ({ biveHome, now }: ProjectHandlerDeps): ProjectMethods => {
  const newId = createUlidGenerator(now);
  const timestamp = (): string => new Date(now()).toISOString();
  /** 마지막으로 연 프로젝트 ID (오케스트레이터 메모리) */
  let currentId: Ulid | null = null;

  return {
    'project.open': ({ path }) =>
      rethrowAsRpc(() => {
        const result = openProjectFolder(path, { biveHome, newId, timestamp });
        currentId = result.project.id;
        return result;
      }),
    'project.current': () =>
      rethrowAsRpc(() => {
        const id = currentId;
        if (id === null || !stillRegistered(biveHome, id)) return { project: null };
        return { project: withProjectStore(biveHome, id, (store) => store.getProject()) };
      }),
    'project.list': () =>
      rethrowAsRpc(() => ({
        // 조회가 등록부 파일을 만들지 않게 한다
        projects: existsSync(bivePaths(biveHome).registryDb)
          ? listRegisteredProjects({ home: biveHome })
          : [],
      })),
  };
};
