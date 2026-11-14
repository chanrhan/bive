// 제안 알림: 제안 등록 · 처리 저장 뒤 → `event.proposal.changed` (TODO-01 · NRM-02, M1-36, ADR-076).
// - 제안 등록(rule-writer `propose_rule` → `ProposalService.submit`)과 처리(`proposal.approve` · `amend` · `reject`)가
//   저장소를 닫은 뒤 제안마다 1개를 인증된 모든 연결에 보낸다. 저장소 열림 구간 안에서 보내지 않는다(ADR-069)
// - 식별자와 상태만 싣는다(본문 · 근거 없음). 받는 쪽은 알림 값으로 화면을 그리지 않고 다시 조회한다
// - 기다리지 않는다: 저장 알림과 같이 송신 실패는 제안 · 요청에 영향이 없고 기록만 남는다. 송신 상한 · 역압은
//   `PipeServer.notify`의 것을 그대로 쓴다(상한을 넘긴 연결은 끊김)
// - 알림은 읽기 신호일 뿐이다. 이 모듈은 저장소를 열지 않고 쓰기 경로를 만들지 않는다(NFR-01)
import type { Proposal, ProposalChangedEvent } from '@bive/shared';

import type { NotificationSink } from './run-events.js';

export interface ProposalEventPublisherOptions {
  /** 지금 알림을 보낼 곳. 파이프 서버를 만들기 전이면 `null` */
  sink: () => NotificationSink | null;
  /** 송신 실패 기록 한 줄 */
  log?: (line: string) => void;
}

export const proposalChangedParams = (
  projectId: string,
  proposal: Proposal,
): ProposalChangedEvent => ({
  projectId,
  proposalId: proposal.id,
  displayId: proposal.displayId,
  kind: proposal.kind,
  state: proposal.state,
});

/** 제안이 저장됐을 때 부르는 자리 (`ProposalService` · 제안 처리기). 던지지 않는다. */
export type ProposalChangeListener = (projectId: string, proposal: Proposal) => void;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ProposalEventPublisher {
  readonly #sink: () => NotificationSink | null;
  readonly #log: (line: string) => void;

  constructor(options: ProposalEventPublisherOptions) {
    this.#sink = options.sink;
    const log = options.log;
    // 기록 함수의 예외가 제안 등록 · 처리 응답을 깨지 않게 한다
    this.#log = (line) => {
      try {
        log?.(line);
      } catch {
        // 기록 실패는 무시한다
      }
    };
  }

  /** 저장된 제안 1건을 알린다. 기다리지 않고 던지지 않는다(실패는 기록만). */
  readonly changed: ProposalChangeListener = (projectId, proposal) => {
    try {
      const sink = this.#sink();
      if (sink === null) return;
      sink
        .notify('event.proposal.changed', proposalChangedParams(projectId, proposal))
        .catch((error: unknown) => {
          this.#log(`제안 알림 전달 실패: ${errorMessage(error)}`);
        });
    } catch (error) {
      this.#log(`제안 알림 전달 실패: ${errorMessage(error)}`);
    }
  };
}
