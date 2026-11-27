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
 * 규범 변경 기록이 늘어난 저장소 사용이 끝났을 때(닫은 뒤) 부르는 함수 (M7-14 #226, ADR-119). 던지지 않아야 한다.
 * `lastSeq`는 그 사용이 끝난 순간의 마지막 순번이다.
 */
export type NormChangeAppendedListener = (projectId: string, lastSeq: number) => void;

/** `$BIVE_HOME` → 규범 변경 알림 함수들. 한 프로세스에 오케스트레이터가 여럿(시험)이어도 섞이지 않게 홈별로 둔다 */
const normChangeListeners = new Map<string, Set<NormChangeAppendedListener>>();

/**
 * 이 `$BIVE_HOME`의 저장소 사용에서 규범 변경 기록이 늘면 `listener`를 부르게 한다. 해제 함수를 돌려준다.
 * 규범 변경 기록을 쓰는 곳(바로 반영 · 폐기 · 판단 · 자동 시작 · 테스트 변경 등)은 모두 아래 `withRegisteredProjectStore`로
 * 저장소를 열므로, 쓰는 곳마다 알림 코드를 두지 않고 여기 한 곳에서 사용 전후의 마지막 순번을 비교한다(읽기만 한다).
 */
export const onNormChangeAppended = (
  biveHome: string,
  listener: NormChangeAppendedListener,
): (() => void) => {
  let set = normChangeListeners.get(biveHome);
  if (set === undefined) {
    set = new Set();
    normChangeListeners.set(biveHome, set);
  }
  const entry: NormChangeAppendedListener = (projectId, lastSeq) => listener(projectId, lastSeq);
  set.add(entry);
  return () => {
    const current = normChangeListeners.get(biveHome);
    if (current === undefined) return;
    current.delete(entry);
    if (current.size === 0) normChangeListeners.delete(biveHome);
  };
};

/** 검토 대기열 항목이 생기거나 처리된 저장소 사용이 끝났을 때(닫은 뒤) 부르는 함수 (M3-08 #53, ADR-145). 던지지 않아야 한다. */
export type ReviewQueueChangedListener = (projectId: string) => void;

const reviewQueueListeners = new Map<string, Set<ReviewQueueChangedListener>>();

/**
 * 이 `$BIVE_HOME`의 저장소 사용에서 검토 대기열이 바뀌면(항목이 생김 · 처리됨) `listener`를 부르게 한다. 해제 함수를 돌려준다.
 * 항목은 실행 종료 저장과 같은 문장에서 DB가 넣으므로, 규범 변경 알림처럼 여기 한 곳에서 사용 전후의 변경 표지를 비교한다.
 */
export const onReviewQueueChanged = (
  biveHome: string,
  listener: ReviewQueueChangedListener,
): (() => void) => {
  let set = reviewQueueListeners.get(biveHome);
  if (set === undefined) {
    set = new Set();
    reviewQueueListeners.set(biveHome, set);
  }
  const entry: ReviewQueueChangedListener = (projectId) => listener(projectId);
  set.add(entry);
  return () => {
    const current = reviewQueueListeners.get(biveHome);
    if (current === undefined) return;
    current.delete(entry);
    if (current.size === 0) reviewQueueListeners.delete(biveHome);
  };
};

/** 검토 대기열의 변경 표지. 읽지 못하면 `null`(알림만 건너뛴다). */
const reviewQueueVersion = (store: ProjectStore): number | null => {
  try {
    return store.reviewQueue.version();
  } catch {
    return null;
  }
};

/** 마지막 규범 변경 순번. 읽지 못하면 `null`(알림만 건너뛴다. 저장소 사용의 결과를 바꾸지 않는다). */
const lastNormChangeSeq = (store: ProjectStore): number | null => {
  try {
    return store.normChanges.lastSeq();
  } catch {
    return null;
  }
};

/**
 * 등록된 프로젝트의 저장소를 열어 함수를 실행하고 닫는다. 함수가 던진 오류는 그대로 다시 던진다
 * (오케스트레이터 내부 API용, 예: `ProposalService.submit`). 등록부에 없거나 프로젝트별 DB · 프로젝트 행이
 * 없으면 -32004 `RpcError` (저장소를 새로 만들지 않는다).
 * 이 홈에 규범 변경 알림 함수가 있으면 사용 전후의 마지막 규범 변경 순번을 읽어, 늘었으면 닫은 뒤(커밋 뒤) 알린다.
 * 함수가 던져도 그 전에 커밋된 기록이 있으면 알린다.
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
  const listeners = normChangeListeners.get(biveHome);
  const reviewListeners = reviewQueueListeners.get(biveHome);
  let before: number | null = null;
  let after: number | null = null;
  let reviewBefore: number | null = null;
  let reviewAfter: number | null = null;
  try {
    if (store.getProject() === null) throw projectNotFound(projectId);
    if (listeners !== undefined) before = lastNormChangeSeq(store);
    if (reviewListeners !== undefined) reviewBefore = reviewQueueVersion(store);
    return fn(store);
  } finally {
    if (before !== null) after = lastNormChangeSeq(store);
    if (reviewBefore !== null) reviewAfter = reviewQueueVersion(store);
    store.close();
    if (reviewListeners !== undefined && reviewBefore !== null && reviewAfter !== null) {
      if (reviewAfter > reviewBefore) {
        for (const listener of [...reviewListeners]) {
          try {
            listener(projectId);
          } catch {
            // 알림 실패는 저장소 사용의 결과를 바꾸지 않는다
          }
        }
      }
    }
    if (listeners !== undefined && before !== null && after !== null && after > before) {
      for (const listener of [...listeners]) {
        try {
          listener(projectId, after);
        } catch {
          // 알림 실패는 저장소 사용의 결과를 바꾸지 않는다
        }
      }
    }
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
