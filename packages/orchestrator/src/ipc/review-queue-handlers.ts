// `reviewQueue.*` 처리기 (TODO-02 · COST-01 · JDG-04, SCR-18, M3-08 #53, ADR-145).
// - `list` · `get`: 저장된 항목 · 실행 · 규칙에서만. 없는 항목 -32004
// - 처리 액션은 사람 주체만 받는다(에이전트 -32020, 저장소를 열기 전, 다른 사람 전용 RPC와 같다). 판정 격리의 빈 사유는 -32001
//   (저장소를 열기 전). 처리는 `review/review-queue.ts` 한 곳에서 쓴다
// - 테스트 보강(`reviewQueue.reinforce`)은 실행을 만드는 사람 RPC라 실행 처리기(`run-handlers.ts`)에 있다
// - 변이 생존의 이의 제기 메서드는 없다(PRD 미결 #7)
import { type Author, createUlidGenerator, ErrorCode, type HumanAuthor } from '@bive/shared';

import {
  assertQuarantineReason,
  listReviewQueue,
  quarantineReviewItem,
  reviewQueueEntry,
} from '../review/review-queue.js';
import type { RunClock } from '../runs/run-service.js';
import { withProjectStore } from './project-store-access.js';
import { RpcError, type MethodHandlers } from './server.js';

export interface ReviewQueueHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 시계 (ms). 처리 시각 · ULID에 쓴다 */
  now: () => number;
}

type ReviewQueueMethods = Pick<
  MethodHandlers,
  'reviewQueue.list' | 'reviewQueue.get' | 'reviewQueue.quarantine'
>;

/** 검토 대기열 처리 주체는 사람뿐이다 (NFR-01, ADR-145). */
const assertHuman = (author: Author): HumanAuthor => {
  if (author.kind !== 'human') {
    throw new RpcError(ErrorCode.Unauthorized, '에이전트는 검토 대기열 항목을 처리할 수 없습니다');
  }
  return author;
};

export const createReviewQueueHandlers = ({
  biveHome,
  now,
}: ReviewQueueHandlerDeps): ReviewQueueMethods => {
  const clock: RunClock = { now, newId: createUlidGenerator(now) };
  return {
    'reviewQueue.list': ({ projectId, kind, state }) =>
      withProjectStore(biveHome, projectId, (store) => ({
        entries: listReviewQueue(store, {
          ...(kind === undefined ? {} : { kind }),
          ...(state === undefined ? {} : { state }),
        }),
      })),
    'reviewQueue.get': ({ projectId, seq }) =>
      withProjectStore(biveHome, projectId, (store) => {
        const item = store.reviewQueue.get(seq);
        if (item === null) {
          throw new RpcError(ErrorCode.NotFound, `검토 대기열 항목이 없습니다: ${String(seq)}`);
        }
        return { entry: reviewQueueEntry(store, item) };
      }),
    'reviewQueue.quarantine': ({ projectId, seq, reason, author }) => {
      const human = assertHuman(author);
      assertQuarantineReason(reason);
      return withProjectStore(biveHome, projectId, (store) =>
        quarantineReviewItem(store, { seq, reason, author: human }, clock),
      );
    },
  };
};
