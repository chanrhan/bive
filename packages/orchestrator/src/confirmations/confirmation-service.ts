// 확인 상태를 확인됨으로 쓰는 유일한 창구 (NFR-01, ADR-100 D2 · I1 · B① · C2 · A1 · A2, M7-01 #213, ADR-101).
// - 확인됨이 생기는 경로는 넷뿐이다: 사람의 확인 RPC(`confirmation.set`), 사람의 요구사항 작성 · 편집(`requirement.create` ·
//   `requirement.update`), 사람의 제안 승인(`proposal.approve` · `proposal.amend`), 사람의 규칙 직접 편집(`rule.update`,
//   M7-03 · ADR-109). 그 밖에는 이행 마이그레이션(0012)뿐이다
// - 이 모듈을 부르는 곳은 위 네 경로의 파이프 처리기 · 제안 승인 함수뿐이고, 함수마다 사람 주체(`HumanAuthor`)를 인자로
//   받는다. 오케스트레이터 내부(엔진 · 단계 실행기 · 규칙 작성 서비스)와 에이전트 도구에는 이 모듈을 부르는 경로가 없다
//   (`integrity.test.ts`가 가져오는 파일을 단언한다)
// - 확인은 아무것도 막지 않는다: 실행 생성 · 단계 진행 · 판정 · 병합은 확인 상태를 읽지 않는다
// - 확인 풀림(M7-13 #225, ADR-100 D3, ADR-113): 미확인으로 되돌리는 함수는 {@link releaseConfirmation} 하나이고, 부르는 곳은
//   에이전트의 폐기 · 대체를 반영하는 모듈(`norms/agent-rule.ts`)뿐이다. 그 모듈은 이 모듈에서 이 함수만 가져온다(확인됨을 만드는
//   함수는 가져오지 않는다, `integrity.test.ts`가 가져오는 이름을 단언한다). 에이전트 도구에는 풀기 · 확인 도구가 없다
import {
  type ApprovalLogEntry,
  type Author,
  type Confirmation,
  type ConfirmationTarget,
  ErrorCode,
  type HumanAuthor,
  type NormChangeEntry,
  type Requirement,
  type Rule,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { RpcError } from '../ipc/server.js';
import { hasPendingNotice } from './confirmation-list.js';

/** 확인 요청이 들어온 연결 (승인 기록 `clientId`). */
export interface ConfirmContext {
  readonly clientId: string | null;
}

export interface ConfirmByHumanResult {
  readonly target: ConfirmationTarget;
  readonly confirmation: Confirmation;
  readonly approvalLog: ApprovalLogEntry;
}

/** 사람 주체만 받는다. 에이전트 주체는 -32020 (NFR-01, ADR-100 I1). */
export const requireHuman = (author: Author, message: string): HumanAuthor => {
  if (author.kind !== 'human') throw new RpcError(ErrorCode.Unauthorized, message);
  return author;
};

/** 확인 대상(요구사항 · 규칙)을 찾는다. 없으면 -32004. */
const targetOf = (store: ProjectStore, target: ConfirmationTarget): Requirement | Rule => {
  const found =
    target.entity === 'Rule' ? store.rules.get(target.id) : store.requirements.get(target.id);
  if (found === null) {
    const label = target.entity === 'Rule' ? '규칙' : '요구사항';
    throw new RpcError(ErrorCode.NotFound, `${label}을 찾을 수 없습니다: ${target.id}`);
  }
  return found;
};

/**
 * 사람의 확인 (`confirmation.set`): 승인 기록 `confirm` 추가와 확인됨 저장을 트랜잭션 1개로 한다.
 * 근거는 그 승인 기록의 순번이다 (ADR-100 C2 · A2).
 * @throws {RpcError} -32020 에이전트 주체 · -32004 없는 대상 · -32009 삭제된 대상 · 이미 확인됨
 */
export const confirmByHuman = (
  store: ProjectStore,
  input: { readonly target: ConfirmationTarget; readonly author: Author },
  context: ConfirmContext,
  at: string,
): ConfirmByHumanResult => {
  const by = requireHuman(
    input.author,
    '에이전트는 확인 상태를 바꿀 수 없습니다. 확인은 사람만 합니다 (NFR-01)',
  );
  const { target } = input;
  return store.transaction(() => {
    const found = targetOf(store, target);
    if (found.deletedAt !== null) {
      throw new RpcError(ErrorCode.StateConflict, `삭제된 항목입니다 (${found.deletedAt})`);
    }
    // 이미 확인됨이어도 사람이 아직 보지 않은 폐기 · 대체 · 테스트 변경 기록이 있으면 다시 확인한다("이 알림을 봤다", ADR-113).
    // 폐기된 규칙의 확인도 같은 뜻이다(폐기는 그대로, 확인은 아무것도 막거나 되돌리지 않는다)
    if (found.confirmation.state === 'confirmed' && !hasPendingNotice(store, target)) {
      throw new RpcError(ErrorCode.StateConflict, '이미 확인됨입니다');
    }
    const approvalLog = store.approvalLog.append({
      at,
      action: 'confirm',
      actor: by,
      targetRef: { entity: target.entity, id: target.id },
      clientId: context.clientId,
      // 사람이 여기까지 봤다: 확인할 것 목록의 폐기 · 대체 · 테스트 변경 항목은 이 순번 이하면 내려간다 (ADR-113)
      detail: { seenNormChangeSeq: store.normChanges.lastSeq() },
    });
    const confirmation = store.confirmations.confirm(target, {
      by,
      at,
      basis: { kind: 'approval_log', seq: approvalLog.seq },
    });
    return { target, confirmation, approvalLog };
  });
};

/**
 * 사람이 쓰거나 고친 요구사항을 확인됨으로 둔다 (ADR-100 B① · A1). 근거는 요구사항 자체의 작성 · 수정 주체와 그 시각이고
 * 승인 기록에는 쓰지 않는다. 요구사항 저장과 같은 트랜잭션 안에서 부른다.
 * @returns 확인 상태를 실은 요구사항
 * @throws {RpcError} -32020 요구사항의 마지막 작성 · 수정 주체가 사람이 아님
 */
export const confirmHumanRequirementWrite = (
  store: ProjectStore,
  requirement: Requirement,
): Requirement => {
  const by = requireHuman(
    requirement.updatedBy,
    '사람이 쓰거나 고친 요구사항만 저장으로 확인됨이 됩니다 (ADR-100 B①)',
  );
  const confirmation = store.confirmations.confirm(
    { entity: 'Requirement', id: requirement.id },
    {
      by,
      at: requirement.updatedAt,
      basis: { kind: 'requirement_record', at: requirement.updatedAt },
    },
  );
  return { ...requirement, confirmation };
};

/**
 * 사람이 승인한 제안으로 반영된 규범을 확인됨으로 둔다 (ADR-100 A1: 사람이 보고 OK한 것). 근거는 그 승인 기록
 * (`approve` · `approve_edited`)의 순번이다. 제안 처리 · 승인 기록 추가와 같은 트랜잭션 안에서 부른다.
 * @throws {RpcError} -32020 승인 기록의 주체가 사람이 아님
 */
export const confirmApprovedNorm = (
  store: ProjectStore,
  target: ConfirmationTarget,
  approvalLog: ApprovalLogEntry,
): Confirmation => {
  if (approvalLog.action !== 'approve' && approvalLog.action !== 'approve_edited') {
    throw new RpcError(ErrorCode.StateConflict, `승인 기록이 아닙니다: ${approvalLog.action}`);
  }
  const by = requireHuman(approvalLog.actor, '사람이 승인한 제안만 확인됨이 됩니다 (ADR-100 A1)');
  return store.confirmations.confirm(target, {
    by,
    at: approvalLog.at,
    basis: { kind: 'approval_log', seq: approvalLog.seq },
  });
};

/**
 * 사람이 직접 고친 규칙을 확인됨으로 둔다 (ADR-100 B② · A8, M7-03 · ADR-109). 근거는 그 편집의 승인 기록(`rule_edit`)
 * 순번이다. 규칙 편집 · 승인 기록 추가와 같은 트랜잭션 안에서 부른다. 이미 확인됨이면 근거를 이 편집으로 바꾼다
 * (사람이 새 글을 직접 썼으므로 앞선 확인보다 이 편집이 근거다).
 * @throws {RpcError} -32009 규칙 편집 기록이 아님 · -32020 승인 기록의 주체가 사람이 아님
 */
export const confirmHumanRuleEdit = (
  store: ProjectStore,
  approvalLog: ApprovalLogEntry,
): Confirmation => {
  if (approvalLog.action !== 'rule_edit' || approvalLog.targetRef.entity !== 'Rule') {
    throw new RpcError(ErrorCode.StateConflict, `규칙 편집 기록이 아닙니다: ${approvalLog.action}`);
  }
  const by = requireHuman(
    approvalLog.actor,
    '사람이 고친 규칙만 편집으로 확인됨이 됩니다 (ADR-100 B②)',
  );
  return store.confirmations.confirm(
    { entity: 'Rule', id: approvalLog.targetRef.id },
    { by, at: approvalLog.at, basis: { kind: 'approval_log', seq: approvalLog.seq } },
  );
};

/**
 * 확인 풀림 (ADR-100 D3, M7-13 · ADR-113): 사람이 확인한 규칙을 에이전트가 폐기 · 대체한 트랜잭션 안에서, 오케스트레이터가 남긴
 * 확인 풀림 기록(종류 `unconfirmed`) 바로 뒤에 부른다. 확인 상태를 미확인으로 되돌린다(행은 남고 시각 · 주체 · 근거가 비며, 앞선
 * 확인은 기록의 `detail.unconfirm.previous`에 남는다). 승인 기록에는 쓰지 않는다(C2: 오케스트레이터 행동).
 * @returns 풀리기 전의 확인
 * @throws {Error} 기록이 오케스트레이터의 규칙 확인 풀림이 아님 · 대상이 확인됨이 아님
 */
export const releaseConfirmation = (store: ProjectStore, record: NormChangeEntry): Confirmation => {
  if (
    record.kind !== 'unconfirmed' ||
    record.actor.kind !== 'orchestrator' ||
    record.targetRef.entity !== 'Rule' ||
    record.detail.unconfirm === undefined
  ) {
    throw new Error(`확인 풀림 기록이 아닙니다: ${record.kind}`);
  }
  return store.confirmations.release({ entity: 'Rule', id: record.targetRef.id });
};
