// 처리기가 프로젝트별 저장소를 여는 방법과 저장소 오류 → IPC 오류 코드 변환 (architecture.md 5장, ADR-040 · ADR-047).
// 저장소 접근 주체는 오케스트레이터 프로세스뿐이다 (NFR-01). 요청마다 열고 끝나면 닫는다.
import { ErrorCode } from '@bive/shared';
import {
  ConflictError,
  NotFoundError,
  openProjectStore,
  openRegistry,
  type ProjectStore,
} from '@bive/store';

import { RpcError } from './server.js';

/**
 * 저장소 오류를 IPC 오류로 바꾼다. 이미 `RpcError`면 그대로, 모르는 오류는 그대로 다시 던져 -32603이 되게 한다.
 * - `NotFoundError` → -32004, `ConflictError` → -32009, 도메인 스키마 위반(`ZodError`) → -32001
 */
export const toRpcError = (error: unknown): unknown => {
  if (error instanceof RpcError) return error;
  if (error instanceof NotFoundError) return new RpcError(ErrorCode.NotFound, error.message);
  if (error instanceof ConflictError) return new RpcError(ErrorCode.StateConflict, error.message);
  // zod는 orchestrator의 직접 의존성이 아니므로 이름으로 가린다
  if (error instanceof Error && error.name === 'ZodError') {
    return new RpcError(ErrorCode.ValidationFailed, '도메인 검증 실패');
  }
  return error;
};

const projectNotFound = (projectId: string): RpcError =>
  new RpcError(ErrorCode.NotFound, `등록되지 않은 프로젝트: ${projectId}`);

/** 등록부에 있는 프로젝트인지 확인한다. 등록부 파일이 없으면 등록된 프로젝트가 없는 것이다. */
const assertRegistered = (biveHome: string, projectId: string): void => {
  let registry;
  try {
    registry = openRegistry({ home: biveHome, create: false });
  } catch (error) {
    if (error instanceof NotFoundError) throw projectNotFound(projectId);
    throw error;
  }
  try {
    if (registry.entries.get(projectId) === null) throw projectNotFound(projectId);
  } finally {
    registry.close();
  }
};

/**
 * 등록된 프로젝트의 저장소를 열어 함수를 실행하고 닫는다. 함수가 던진 오류는 그대로 다시 던진다
 * (오케스트레이터 내부 API용, 예: `ProposalService.submit`). 등록부에 없거나 프로젝트별 DB · 프로젝트 행이
 * 없으면 -32004 `RpcError` (저장소를 새로 만들지 않는다).
 */
export const withRegisteredProjectStore = <T>(
  biveHome: string,
  projectId: string,
  fn: (store: ProjectStore) => T,
): T => {
  assertRegistered(biveHome, projectId);
  let store: ProjectStore;
  try {
    store = openProjectStore(projectId, { home: biveHome, create: false });
  } catch (error) {
    if (error instanceof NotFoundError) throw projectNotFound(projectId);
    throw error;
  }
  try {
    if (store.getProject() === null) throw projectNotFound(projectId);
    return fn(store);
  } finally {
    store.close();
  }
};

/**
 * 등록된 프로젝트의 저장소를 열어 함수를 실행하고 닫는다. 함수가 던진 저장소 오류는 IPC 오류로 바꾼다.
 * 등록부에 없거나, 프로젝트별 DB · 프로젝트 행이 없으면 -32004 (저장소를 새로 만들지 않는다).
 */
export const withProjectStore = <T>(
  biveHome: string,
  projectId: string,
  fn: (store: ProjectStore) => T,
): T => {
  try {
    return withRegisteredProjectStore(biveHome, projectId, fn);
  } catch (error) {
    throw toRpcError(error);
  }
};
