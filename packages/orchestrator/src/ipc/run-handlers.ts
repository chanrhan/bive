// `run.*` 처리기 (RUN-01, RUN-02, NFR-07, M1-12, ADR-061).
// - `run.create`는 실행 시작 확인이다. 사람 주체만 받고(에이전트 주체 -32020), 설정이 비면 -32010으로 거부하며
//   실행을 만들지 않는다. 실행 저장과 승인 기록 `run_start`는 한 트랜잭션이다
// - 승인 단계 판정 · 이후 단계 진행은 엔진(M1-14, ADR-066)이 한다: `run.create` 응답 뒤 승인 단계를 판정한다.
//   파이프에서 상태를 바꾸는 RPC는 `run.create`와 `run.resume`(사람만, `interrupted`만)뿐이다
import {
  type Author,
  createUlidGenerator,
  ErrorCode,
  parseDisplayId,
  type Ulid,
} from '@bive/shared';
import type { ProjectStore, RunDetail } from '@bive/store';

import { assertHumanRunStarter, createRun, type RunClock } from '../runs/run-service.js';
import { withProjectStore } from './project-store-access.js';
import { RpcError, type MethodHandlers } from './server.js';

/** 처리기가 부르는 실행 엔진 창구 (`PipelineEngine`). */
export interface RunEngineHooks {
  /** 실행을 만든 뒤 (응답 다음에 승인 단계를 판정한다) */
  onRunCreated(projectId: Ulid, runId: Ulid): void;
  /** 규칙을 승인한 뒤 (그 프로젝트의 승인 대기 실행을 다시 판정한다) */
  onNormsApproved(projectId: Ulid): void;
  /** `run.resume` */
  resume(projectId: Ulid, ref: string, author: Author): Promise<RunDetail>;
}

export interface RunHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 시계 (ms). 생성 시각 · ULID에 쓴다 */
  now: () => number;
  /** 실행 엔진. 없으면 실행이 승인 대기에 머물고 `run.resume`은 -32603 */
  engine?: RunEngineHooks;
}

type RunMethods = Pick<MethodHandlers, 'run.create' | 'run.get' | 'run.list' | 'run.resume'>;

/** ULID 또는 표시 ID(`EXE-001`)로 실행을 찾는다. 없으면 -32004. */
const findRun = (store: ProjectStore, id: string): RunDetail => {
  const detail =
    parseDisplayId(id) === null ? store.runs.getDetail(id) : store.runs.getDetailByDisplayId(id);
  if (detail === null) throw new RpcError(ErrorCode.NotFound, `실행을 찾을 수 없습니다: ${id}`);
  return detail;
};

export const createRunHandlers = ({ biveHome, now, engine }: RunHandlerDeps): RunMethods => {
  const clock: RunClock = { now, newId: createUlidGenerator(now) };

  return {
    'run.create': ({ projectId, ruleIds, author }, context) => {
      assertHumanRunStarter(author);
      const created = withProjectStore(biveHome, projectId, (store) =>
        createRun(
          store,
          { ruleIds, author },
          { clientId: `pipe-${String(context.connectionId)}` },
          clock,
        ),
      );
      engine?.onRunCreated(projectId, created.run.id);
      return created;
    },
    'run.get': ({ projectId, id }) =>
      withProjectStore(biveHome, projectId, (store) => findRun(store, id)),
    'run.list': ({ projectId, status }) =>
      withProjectStore(biveHome, projectId, (store) => ({ runs: store.runs.list({ status }) })),
    'run.resume': ({ projectId, id, author }) => {
      if (engine === undefined) {
        throw new RpcError(ErrorCode.InternalError, '실행 엔진이 없습니다');
      }
      return engine.resume(projectId, id, author);
    },
  };
};
