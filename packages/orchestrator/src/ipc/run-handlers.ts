// `run.*` 처리기 (RUN-01, RUN-02, NFR-07, M1-12, ADR-061).
// - `run.create`는 실행 시작 확인이다. 사람 주체만 받고(에이전트 주체 -32020), 설정이 비면 -32010으로 거부하며
//   실행을 만들지 않는다. 실행 저장과 승인 기록 `run_start`는 한 트랜잭션이다
// - `run.get`은 실행 · 단계 · 비용 집계와 세션 항목(받은 규범 입력의 기록 포함, ADR-108)을 돌려준다
// - `run.list`는 `ruleId`를 주면 그 규칙이 대상이거나 그 규칙을 판정한 실행만 돌려준다(규칙 상세의 실행 이력, ADR-135).
//   블록 선언 겹침 · 내장 구조 규칙 없음으로 끝난 실행이 있으면 종료 사유 보조 표시(`failureNotes`)를 함께 싣는다(ADR-144)
// - 승인 단계 판정 · 이후 단계 진행은 엔진(M1-14, ADR-066)이 한다: `run.create` 응답 뒤 승인 단계를 판정한다.
//   파이프에서 상태를 바꾸는 RPC는 `run.create`와 `run.resume`(사람만, `interrupted`만)뿐이다
// - `reviewQueue.reinforce`(M3-08 #53, ADR-145)는 검토 대기열의 테스트 보강이다: 사람만, `run.create`와 같은 문으로 유형 C 실행 1개를
//   만들고 같은 트랜잭션에서 검토 대기열 항목을 처리한다
// - `reviewQueue.resumeWithBudget`(M3-56 #319, ADR-147, ADR-149)는 검토 대기열의 한도 상향 재개다: 사람만, `run.create`와 같은 문으로 예산
//   초과로 끝난 원 실행을 이어받는 실행 1개(원 실행과 같은 유형 · 대상 규칙, 예산 값 = 새 한도)를 만들고 같은 트랜잭션에서 원 실행과 잇고
//   항목을 처리한다. 유형 · 대상 규칙은 원 실행에서 정해진다(요청이 바꿔 넣을 수 없다)
import {
  type Author,
  createUlidGenerator,
  ErrorCode,
  parseDisplayId,
  type RunSessionEntry,
  type Ulid,
} from '@bive/shared';
import type { ProjectStore, RunDetail } from '@bive/store';

import {
  continuationTarget,
  recordContinuation,
  recordReinforcement,
  reinforcementTarget,
} from '../review/review-queue.js';
import { runFailureNotes } from '../runs/failure-notes.js';
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

type RunMethods = Pick<
  MethodHandlers,
  | 'run.create'
  | 'run.get'
  | 'run.list'
  | 'run.resume'
  | 'reviewQueue.reinforce'
  | 'reviewQueue.resumeWithBudget'
>;

/** ULID 또는 표시 ID(`EXE-001`)로 실행을 찾는다. 없으면 -32004. */
const findRun = (store: ProjectStore, id: string): RunDetail => {
  const detail =
    parseDisplayId(id) === null ? store.runs.getDetail(id) : store.runs.getDetailByDisplayId(id);
  if (detail === null) throw new RpcError(ErrorCode.NotFound, `실행을 찾을 수 없습니다: ${id}`);
  return detail;
};

/**
 * 실행의 세션 항목 (시작 순, ADR-108): 세션 ID · 단계 시도 · 역할 · 시각 · 종료 사유와 받은 규범 입력의 기록(표시 ID · 수 ·
 * 잘린 사실). 실행 세션은 언제나 단계 시도가 있다(`sessions` 표 CHECK).
 */
const sessionEntries = (store: ProjectStore, runId: Ulid): RunSessionEntry[] =>
  store.sessions.listByRun(runId).flatMap((session) =>
    session.stepId === null
      ? []
      : [
          {
            id: session.id,
            stepId: session.stepId,
            role: session.role,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            endReason: session.endReason,
            normInput: session.normInput,
          },
        ],
  );

export const createRunHandlers = ({ biveHome, now, engine }: RunHandlerDeps): RunMethods => {
  const clock: RunClock = { now, newId: createUlidGenerator(now) };

  return {
    'run.create': ({ projectId, ruleIds, author, type }, context) => {
      assertHumanRunStarter(author);
      const created = withProjectStore(biveHome, projectId, (store) =>
        createRun(
          store,
          { ruleIds, author, ...(type === undefined ? {} : { type }) },
          { clientId: `pipe-${String(context.connectionId)}` },
          clock,
        ),
      );
      engine?.onRunCreated(projectId, created.run.id);
      return created;
    },
    'run.get': ({ projectId, id }) =>
      withProjectStore(biveHome, projectId, (store) => {
        const detail = findRun(store, id);
        const usage = store.runs.usage(detail.run.id);
        if (usage === null)
          throw new RpcError(ErrorCode.NotFound, `실행을 찾을 수 없습니다: ${id}`);
        return { ...detail, usage, sessions: sessionEntries(store, detail.run.id) };
      }),
    'run.list': ({ projectId, status, ruleId }) =>
      withProjectStore(biveHome, projectId, (store) => {
        // 규칙 기준 조회(규칙 상세의 실행 이력, ADR-135): 없는 규칙은 판정 이력 조회(`judgment.list`)와 같이 -32004
        if (ruleId !== undefined && store.rules.get(ruleId) === null) {
          throw new RpcError(ErrorCode.NotFound, `규칙을 찾을 수 없습니다: ${ruleId}`);
        }
        const runs =
          ruleId === undefined ? store.runs.list({ status }) : store.runs.list({ status, ruleId });
        // 종료 사유의 보조 표시 (선택 칸, 해당 실행이 없으면 싣지 않는다: 그 밖의 응답은 예전과 같다, ADR-144)
        const failureNotes = runFailureNotes(store, runs);
        return failureNotes.length === 0 ? { runs } : { runs, failureNotes };
      }),
    // 검토 대기열의 테스트 보강 (M3-08 #53, ADR-145): 사람의 [실행]과 같은 문(`createRun`)으로 유형 C 실행을 만들고, 같은 트랜잭션에서
    // 검토 대기열 모듈이 원인 변이 기록과 잇고 항목을 처리한다. 실행을 만드는 사람 RPC는 이 파일에만 있다
    'reviewQueue.reinforce': ({ projectId, seq, author }, context) => {
      assertHumanRunStarter(author);
      const human = { kind: 'human' } as const;
      const outcome = withProjectStore(biveHome, projectId, (store) =>
        store.transaction(() => {
          const target = reinforcementTarget(store, seq);
          const created = createRun(
            store,
            { ruleIds: [target.cause.ruleId], author: human, type: 'C' },
            { clientId: `pipe-${String(context.connectionId)}` },
            clock,
          );
          return { ...created, entry: recordReinforcement(store, target, created, human) };
        }),
      );
      engine?.onRunCreated(projectId, outcome.run.id);
      return outcome;
    },
    // 검토 대기열의 한도 상향 재개 (M3-56 #319, ADR-149): 검토 대기열 모듈이 항목 · 원 실행 · 새 한도를 확인하고, 사람의 [실행]과 같은 문
    // (`createRun`)으로 원 실행과 같은 유형 · 대상 규칙의 이어받는 실행을 만든 뒤 같은 트랜잭션에서 원 실행과 잇고 항목을 처리한다
    'reviewQueue.resumeWithBudget': ({ projectId, seq, budget, author }, context) => {
      assertHumanRunStarter(author);
      const human = { kind: 'human' } as const;
      const outcome = withProjectStore(biveHome, projectId, (store) =>
        store.transaction(() => {
          const target = continuationTarget(store, seq, budget);
          const created = createRun(
            store,
            { ruleIds: target.origin.targetRuleIds, author: human, type: target.origin.type },
            { clientId: `pipe-${String(context.connectionId)}` },
            clock,
            target.seed,
          );
          return { ...created, entry: recordContinuation(store, target, created, human) };
        }),
      );
      engine?.onRunCreated(projectId, outcome.run.id);
      return outcome;
    },
    'run.resume': ({ projectId, id, author }) => {
      if (engine === undefined) {
        throw new RpcError(ErrorCode.InternalError, '실행 엔진이 없습니다');
      }
      return engine.resume(projectId, id, author);
    },
  };
};
