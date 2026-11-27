// 검토 대기열 (TODO-02 · COST-01 · JDG-04, SCR-18, M3-08 #53, ADR-100 B④ · A17, ADR-145).
// - 항목은 DB가 등록한다: 실행의 종료 상태(`budget_exceeded`, 또는 변이 보강 실행의 `failed`이고 원인 규칙이 아직 '변이 생존')를
//   저장하는 같은 문장의 트리거(0028). 이 모듈은 항목을 만들지 않는다
// - 항목의 처리(열림 → 처리됨 한 번)와 사람이 시작한 테스트 보강 연결을 쓰는 곳은 이 모듈 하나다(구조 시험). 처리 RPC는 사람 주체만
//   받는다(처리기가 저장소를 열기 전에 -32020). 에이전트 도구에는 이 표를 건드리는 도구가 없다
// - 변이 생존 액션:
//   - 테스트 보강: 사람의 실행 RPC 처리기(`ipc/run-handlers.ts`)가 `run.create`와 같은 문(`createRun`: 설정 · 유형 · 대상 규칙 ·
//     승인 기록 `run_start`)으로 유형 C 실행 1개를 만들고, 같은 트랜잭션에서 이 모듈이 원인 변이 기록과 잇고(사람 보강 연결)
//     항목을 처리한다. 그 실행은 자동 보강과 같은 보강 실행이다(`isReinforcementRun` · 재주입 · 더하기만, ADR-143). 저장 뒤 엔진의
//     `onRunCreated`가 효력 확인 · 실행 1개(대기)를 맡는다
//   - 판정 격리: 사유가 있어야 하고(공백만 -32001), 원인 규칙에 판정 상태 '격리' 기록 1건(실행 없음, 원인 변이 기록의 판정 커밋)을
//     남긴다. 규칙의 판정은 가장 최근 기록이므로 그 뒤 실제 판정이 나오면 그것이 최신이다. 검사 단계 · 병합 재검사는 저장된 최신
//     판정을 읽지 않고 그 실행에서 다시 판정하므로 격리가 통과로 세어지지 않는다
//   - 이의 제기: 정의 전(PRD 미결 #7)이라 메서드가 없다
// - 값은 저장된 항목 · 실행 · 규칙 · 변이 기록에서만 만든다(NFR-03)
import {
  DomainErrorReason,
  ErrorCode,
  type HumanAuthor,
  type JudgmentResult,
  type MutationResult,
  QUARANTINE_REASON_MAX,
  type ReviewConflictReason,
  type ReviewItem,
  type ReviewItemKind,
  type ReviewItemState,
  type ReviewQueueEntry,
  type RunCreateResult,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { RpcError } from '../ipc/server.js';
import type { RunClock } from '../runs/run-service.js';

const conflict = (reason: ReviewConflictReason, message: string): RpcError =>
  new RpcError(ErrorCode.StateConflict, message, { reason });

/** 항목 하나를 화면이 쓰는 모양으로 (실행 요약 · 대상 규칙). */
export const reviewQueueEntry = (store: ProjectStore, item: ReviewItem): ReviewQueueEntry => {
  const run = store.runs.get(item.runId);
  if (run === null)
    throw new RpcError(ErrorCode.NotFound, `실행을 찾을 수 없습니다: ${item.runId}`);
  const cause = item.mutationResultId === null ? null : store.mutations.get(item.mutationResultId);
  const ruleIds = cause === null ? run.targetRuleIds : [cause.ruleId];
  return {
    item,
    run: {
      id: run.id,
      displayId: run.displayId,
      type: run.type,
      status: run.status,
      failureReason: run.failureReason,
    },
    rules: ruleIds.flatMap((id) => {
      const rule = store.rules.get(id);
      return rule === null ? [] : [{ id: rule.id, displayId: rule.displayId, title: rule.title }];
    }),
  };
};

/** 항목 목록 (등록 순). */
export const listReviewQueue = (
  store: ProjectStore,
  filter: { readonly kind?: ReviewItemKind; readonly state?: ReviewItemState },
): ReviewQueueEntry[] =>
  store.reviewQueue
    .list({
      ...(filter.kind === undefined ? {} : { kind: filter.kind }),
      ...(filter.state === undefined ? {} : { state: filter.state }),
    })
    .map((item) => reviewQueueEntry(store, item));

/** 처리할 수 있는 열린 항목 (없음 -32004, 이미 처리됨 · 종류가 받지 않는 액션 -32009). */
const openItem = (store: ProjectStore, seq: number, kind: ReviewItemKind): ReviewItem => {
  const item = store.reviewQueue.get(seq);
  if (item === null)
    throw new RpcError(ErrorCode.NotFound, `검토 대기열 항목이 없습니다: ${String(seq)}`);
  if (item.resolution !== null) {
    throw conflict('already_resolved', `이미 처리된 검토 대기열 항목입니다: ${String(seq)}`);
  }
  if (item.kind !== kind) {
    throw conflict('action_not_allowed', `이 종류의 항목이 받지 않는 액션입니다: ${String(seq)}`);
  }
  return item;
};

/** 변이 생존 항목의 원인 변이 기록 (DB가 항목을 넣을 때 확인했으므로 늘 있다). */
const causeOf = (store: ProjectStore, item: ReviewItem): MutationResult => {
  const cause = item.mutationResultId === null ? null : store.mutations.get(item.mutationResultId);
  if (cause === null)
    throw new Error(`검토 대기열 항목의 원인 변이 기록이 없습니다: ${String(item.seq)}`);
  return cause;
};

/** 테스트 보강할 열린 변이 생존 항목과 그 원인 변이 기록. */
export interface ReinforcementTarget {
  readonly item: ReviewItem;
  readonly cause: MutationResult;
}

/**
 * 테스트 보강을 받을 수 있는 항목인지 본다 (실행을 만들기 전, 같은 쓰기 트랜잭션 안에서 부른다).
 * @throws {RpcError} -32004 없는 항목 · -32009 이미 처리됨 · 변이 생존 항목이 아님
 */
export const reinforcementTarget = (store: ProjectStore, seq: number): ReinforcementTarget => {
  const item = openItem(store, seq, 'mutant_survived');
  return { item, cause: causeOf(store, item) };
};

/**
 * 사람이 시작한 테스트 보강 실행(유형 C, 사람의 실행 생성 `createRun`으로 막 만든 것)을 원인 변이 기록과 잇고 항목을 처리됨으로
 * 남긴다. 실행 생성과 같은 쓰기 트랜잭션 안에서 부른다(하나라도 실패하면 실행도 남지 않는다). 실행을 만드는 곳은 사람의 실행 RPC
 * 처리기(`ipc/run-handlers.ts`)다.
 */
export const recordReinforcement = (
  store: ProjectStore,
  target: ReinforcementTarget,
  created: RunCreateResult,
  author: HumanAuthor,
): ReviewQueueEntry => {
  const at = created.run.createdAt;
  store.reviewQueue.linkReinforcement({
    reviewSeq: target.item.seq,
    runId: created.run.id,
    mutationResultId: target.cause.id,
    createdAt: at,
  });
  const resolved = store.reviewQueue.resolve(target.item.seq, {
    action: 'reinforce',
    by: author,
    at,
    reason: null,
    runId: created.run.id,
  });
  return reviewQueueEntry(store, resolved);
};

/**
 * 판정 격리 사유의 형식 (저장소를 열기 전에 본다). 공백만이면 -32001 `QUARANTINE_REASON_REQUIRED`, 상한 초과는
 * -32001 `QUARANTINE_REASON_INVALID`. 저장은 받은 원문 그대로다.
 */
export const assertQuarantineReason = (reason: string): void => {
  if (reason.trim().length === 0) {
    throw new RpcError(ErrorCode.ValidationFailed, '판정 격리 사유가 비어 있습니다', {
      reason: DomainErrorReason.QuarantineReasonRequired,
    });
  }
  if (reason.length > QUARANTINE_REASON_MAX) {
    throw new RpcError(
      ErrorCode.ValidationFailed,
      `판정 격리 사유가 ${String(QUARANTINE_REASON_MAX)}자를 넘습니다`,
      { reason: DomainErrorReason.QuarantineReasonInvalid },
    );
  }
};

export interface QuarantineOutcome {
  readonly entry: ReviewQueueEntry;
  readonly judgment: JudgmentResult;
}

/**
 * 변이 생존 항목의 판정 격리 (트랜잭션 1개): 원인 규칙의 '격리' 판정 기록 1건(실행 · 단계 없음, 원인 변이 기록의 판정 커밋, 케이스
 * 없음, 사유) → 항목 처리.
 * @throws {RpcError} -32004 없는 항목 · -32009 이미 처리됨 · 변이 생존 항목이 아님
 */
export const quarantineReviewItem = (
  store: ProjectStore,
  input: { readonly seq: number; readonly reason: string; readonly author: HumanAuthor },
  clock: RunClock,
): QuarantineOutcome =>
  store.transaction(() => {
    const item = openItem(store, input.seq, 'mutant_survived');
    const cause = causeOf(store, item);
    const at = new Date(clock.now()).toISOString();
    const [judgment] = store.judgments.record([
      {
        id: clock.newId(),
        ruleId: cause.ruleId,
        runId: null,
        stepId: null,
        commit: cause.commit,
        judgedAt: at,
        status: 'quarantined',
        runner: 'vitest',
        exitCode: null,
        reporterPath: null,
        cases: [],
        quarantineReason: input.reason,
      },
    ]);
    if (judgment === undefined) throw new Error('격리 판정 기록을 남기지 못했습니다');
    const resolved = store.reviewQueue.resolve(item.seq, {
      action: 'quarantine',
      by: input.author,
      at,
      reason: input.reason,
      judgmentId: judgment.id,
    });
    return { entry: reviewQueueEntry(store, resolved), judgment };
  });
