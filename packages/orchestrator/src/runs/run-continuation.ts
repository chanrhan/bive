// 이어받는 실행 (TODO-02 · COST-01 · NFR-01, M3-56 #319, ADR-147 ② ④, ADR-149).
// 예산 초과로 끝난 원 실행은 종료 상태 그대로 두고(ADR-147 ①), 그 실행을 이어받는 새 실행이 돈다. 연결은 저장소 `runContinuations`(0030)에
// 있고, 쓰는 곳은 검토 대기열 모듈 하나다(구조 시험). 이 모듈은 사슬을 읽는 함수만 둔다:
// - 한도 계산의 세션 기록(`lineageSessions`): 이어받는 실행이면 사슬의 원 실행들(뿌리부터)의 세션 다음에 이 실행의 세션. 이어받는 실행이
//   아니면 이 실행의 세션 그대로다
// - 작업 가지의 시작 자리(`continuationWorktreeStart`): 원 실행의 기준 커밋과 원 실행 브랜치
import type { Session } from '@bive/shared';
import type { ProjectStore } from '@bive/store';

/**
 * 한도 계산에 쓰는 세션 기록 (COST-01, ADR-147 ④): 사슬의 원 실행들(뿌리부터)의 세션 다음에 이 실행의 세션. 이어받는 실행이 아니면 이
 * 실행의 세션 그대로다.
 */
export const lineageSessions = (store: ProjectStore, runId: string): Session[] => {
  const ancestors = store.runContinuations.ancestorsOf(runId);
  const own = store.sessions.listByRun(runId);
  return ancestors.length === 0
    ? own
    : [...ancestors.flatMap((id) => store.sessions.listByRun(id)), ...own];
};

/** 이어받는 실행의 작업 가지 시작 자리 (`WorktreeManager.create`의 `start`). */
export interface ContinuationWorktreeStart {
  readonly baseCommit: string;
  readonly commit: string;
  readonly fromBranch: string;
}

/**
 * 이어받는 실행의 작업 가지를 만들 자리 (ADR-147 ②, ADR-149). 기준 커밋은 원 실행과 같고 가지는 원 실행 브랜치에 있는 커밋에서 시작한다.
 * 지금(M3-56 1단계)은 첫 단계부터 돌므로 시작 커밋 = 원 실행의 기준 커밋이다. 이어받는 실행이 아니거나 원 실행이 워크트리를 만들기 전에
 * 끝났으면 `null`(보통 실행처럼 기준 브랜치의 지금 커밋에서).
 */
export const continuationWorktreeStart = (
  store: ProjectStore,
  runId: string,
): ContinuationWorktreeStart | null => {
  const link = store.runContinuations.originOf(runId);
  const origin = link === null ? null : store.runs.get(link.originRunId);
  if (origin?.baseCommit == null || origin.branch === null) return null;
  return { baseCommit: origin.baseCommit, commit: origin.baseCommit, fromBranch: origin.branch };
};
