// 실행 알림: 엔진 이벤트 → `event.step.updated` · `event.run.updated` (RUN-01 · RUN-02 · COST-02, M1-19, ADR-076).
// - 실행 상태 저장(`run.saved`, 단계 전이)마다 지난 알림 뒤 바뀐 단계 시도마다 `event.step.updated`, 그다음
//   `event.run.updated` 1개를 인증된 모든 연결에 보낸다. 저장이 곧 전이이므로 알림은 저장된 값 그대로다
// - 화면 갱신 단계의 `notify('screen_update')`는 그 실행을 저장소에서 다시 읽어 `event.run.updated`를 보내고, 모든
//   연결의 쓰기가 끝나면 풀린다(엔진은 그 뒤에 단계를 완료로 저장한다)
// - 알림은 같은 틱에 쓰므로 순서는 저장 순서와 같다. 서버가 아직 없으면(기동 중 중단 표시) 보내지 않는다
import {
  isTerminalRunStatus,
  type NotificationName,
  type NotificationParams,
  type Run,
  type RunUpdatedEvent,
  type Step,
  type StepUpdatedEvent,
} from '@bive/shared';

import type { EngineEvent } from '../engine/types.js';
import { withRegisteredProjectStore } from '../ipc/project-store-access.js';

/** 알림을 보내는 곳 (`PipeServer.notify`). */
export interface NotificationSink {
  notify<N extends NotificationName>(method: N, params: NotificationParams<N>): Promise<void>;
}

export interface RunEventPublisherOptions {
  /** `$BIVE_HOME` 절대 경로 (화면 갱신 알림 때 실행을 다시 읽는다) */
  biveHome: string;
  /** 지금 알림을 보낼 곳. 파이프 서버를 만들기 전이면 `null` */
  sink: () => NotificationSink | null;
}

export const runUpdatedParams = (projectId: string, run: Run): RunUpdatedEvent => ({
  projectId,
  runId: run.id,
  displayId: run.displayId,
  status: run.status,
  currentStep: run.currentStep,
  regressionCount: run.regressionCount,
  costUsd: run.costUsd,
});

export const stepUpdatedParams = (projectId: string, step: Step): StepUpdatedEvent => ({
  projectId,
  runId: step.runId,
  stepId: step.id,
  kind: step.kind,
  attempt: step.attempt,
  status: step.status,
});

/** 단계 시도의 알림 대상 값. 같으면 다시 알리지 않는다. */
const stepSignature = (step: Step): string => `${step.status}|${String(step.endedAt)}`;

export class RunEventPublisher {
  readonly #biveHome: string;
  readonly #sink: () => NotificationSink | null;
  /** 실행 ID → (단계 시도 ID → 마지막으로 알린 값). 실행이 끝나면 지운다 */
  readonly #sent = new Map<string, Map<string, string>>();

  constructor(options: RunEventPublisherOptions) {
    this.#biveHome = options.biveHome;
    this.#sink = options.sink;
  }

  /** 엔진 이벤트 하나를 알림으로 보낸다. 모든 연결의 쓰기가 끝나면 풀린다. */
  publish(event: EngineEvent): Promise<void> {
    if (event.type === 'run.saved') {
      const { run, steps } = event.detail;
      return this.#saved(event.projectId, run, steps);
    }
    if (event.topic !== 'screen_update') return Promise.resolve();
    const run = withRegisteredProjectStore(
      this.#biveHome,
      event.projectId,
      (store) => store.runs.get(event.runId) ?? null,
    );
    if (run === null) return Promise.reject(new Error(`실행을 찾을 수 없습니다: ${event.runId}`));
    return this.#send([['event.run.updated', runUpdatedParams(event.projectId, run)]]);
  }

  #saved(projectId: string, run: Run, steps: readonly Step[]): Promise<void> {
    const known = this.#sent.get(run.id) ?? new Map<string, string>();
    const changed = steps.filter((step) => known.get(step.id) !== stepSignature(step));
    for (const step of changed) known.set(step.id, stepSignature(step));
    if (isTerminalRunStatus(run.status)) this.#sent.delete(run.id);
    else this.#sent.set(run.id, known);
    return this.#send([
      ...changed.map((step): Notice => ['event.step.updated', stepUpdatedParams(projectId, step)]),
      ['event.run.updated', runUpdatedParams(projectId, run)],
    ]);
  }

  /** 알림을 순서대로 같은 틱에 쓴다. 스키마가 맞지 않는 알림은 그 자리에서 예외 (보내는 쪽 검증). */
  #send(notices: readonly Notice[]): Promise<void> {
    const sink = this.#sink();
    if (sink === null) return Promise.resolve();
    return Promise.all(
      notices.map((notice) =>
        notice[0] === 'event.run.updated'
          ? sink.notify('event.run.updated', notice[1])
          : sink.notify('event.step.updated', notice[1]),
      ),
    ).then(() => undefined);
  }
}

type Notice =
  | readonly ['event.run.updated', RunUpdatedEvent]
  | readonly ['event.step.updated', StepUpdatedEvent];
