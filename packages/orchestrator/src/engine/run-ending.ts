// 실행의 종료 상태 (ADR-091 · ADR-094). 엔진(`pipeline-engine.ts`)과 실행 서비스의 실행 대기 시작(`runs/run-service.ts`
// `startNextQueuedRun`, ADR-105 · ADR-111)이 실행을 실패 쪽으로 끝낼 때 이 함수 하나를 거친다. 엔진 모듈과 실행 서비스가
// 서로를 가져오지 않게 따로 둔다(엔진은 실행 서비스를 가져온다).
import type { Run } from '@bive/shared';

import type { HaltStatus } from './types.js';

/**
 * 실행을 끝낼 때의 종료 상태 (ADR-091 · ADR-094). 엔진이 실행을 실패 쪽으로 끝내는 모든 경로(`#halt`, `#drive`의
 * `state_inconsistent`, `#failAfterError`에서 시도가 이미 끝난 경우)와 실행 대기를 시작 전에 끝내는 경로가 이 함수 하나로 정한다.
 * - 병합 커밋이 기록된 실행(`run.mergeCommit !== null`)은 기준 브랜치에 병합 커밋이 있으므로 `merged`(실패 사유 없음,
 *   `currentStep = null`)로 끝내고 브랜치 · 워크트리를 보존하지 않는다(`merged: true`). 실패는 그 단계 시도에만 남는다
 * - 그 밖에는 `runStatus` + 사유(`failureReason`)이고 보존한다(`merged: false`, RUN-08)
 * 조건은 저장된 `mergeCommit`뿐이다. 그 값은 병합 실행기가 기준 브랜치를 git으로 확인한 `passed`일 때만 채워지므로
 * (ADR-069 · ADR-091), 병합되지 않은 실행이 이 함수로 `merged`가 되는 일은 없다.
 */
export const runEnding = (
  run: Pick<Run, 'mergeCommit'>,
  runStatus: HaltStatus,
  reason: string,
):
  | { merged: true; run: { status: 'merged'; currentStep: null } }
  | { merged: false; run: { status: HaltStatus; failureReason: string } } =>
  run.mergeCommit !== null
    ? { merged: true, run: { status: 'merged', currentStep: null } }
    : { merged: false, run: { status: runStatus, failureReason: reason } };
