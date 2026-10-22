// `run.*` 처리기 (RUN-01, RUN-02, NFR-07, M1-12, ADR-061).
// - `run.create`는 실행 시작 확인이다. 사람 주체만 받고(에이전트 주체 -32020), 설정이 비면 -32010으로 거부하며
//   실행을 만들지 않는다. 실행 저장과 승인 기록 `run_start`는 한 트랜잭션이다
// - 승인 단계 판정 · 이후 단계 진행은 엔진(M1-14)이 `RunService`로 한다. 파이프에는 상태를 바꾸는 RPC가
//   `run.create`(와 M1-14의 `run.resume`)뿐이다
import { createUlidGenerator, ErrorCode, parseDisplayId } from '@bive/shared';
import type { ProjectStore, RunDetail } from '@bive/store';

import { assertHumanRunStarter, createRun, type RunClock } from '../runs/run-service.js';
import { withProjectStore } from './project-store-access.js';
import { RpcError, type MethodHandlers } from './server.js';

export interface RunHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 시계 (ms). 생성 시각 · ULID에 쓴다 */
  now: () => number;
}

type RunMethods = Pick<MethodHandlers, 'run.create' | 'run.get' | 'run.list'>;

/** ULID 또는 표시 ID(`EXE-001`)로 실행을 찾는다. 없으면 -32004. */
const findRun = (store: ProjectStore, id: string): RunDetail => {
  const detail =
    parseDisplayId(id) === null ? store.runs.getDetail(id) : store.runs.getDetailByDisplayId(id);
  if (detail === null) throw new RpcError(ErrorCode.NotFound, `실행을 찾을 수 없습니다: ${id}`);
  return detail;
};

export const createRunHandlers = ({ biveHome, now }: RunHandlerDeps): RunMethods => {
  const clock: RunClock = { now, newId: createUlidGenerator(now) };

  return {
    'run.create': ({ projectId, ruleIds, author }, context) => {
      assertHumanRunStarter(author);
      return withProjectStore(biveHome, projectId, (store) =>
        createRun(
          store,
          { ruleIds, author },
          { clientId: `pipe-${String(context.connectionId)}` },
          clock,
        ),
      );
    },
    'run.get': ({ projectId, id }) =>
      withProjectStore(biveHome, projectId, (store) => findRun(store, id)),
    'run.list': ({ projectId, status }) =>
      withProjectStore(biveHome, projectId, (store) => ({ runs: store.runs.list({ status }) })),
  };
};
