// 확인 상태를 확인됨으로 쓰는 유일한 창구 (NFR-01, ADR-100 D2 · I1 · B① · C2 · A1 · A2, M7-01 #213, ADR-101).
// - 확인됨이 생기는 경로는 셋뿐이다: 사람의 확인 RPC(`confirmation.set`), 사람의 요구사항 작성 · 편집(`requirement.create` ·
//   `requirement.update`), 사람의 제안 승인(`proposal.approve` · `proposal.amend`). 그 밖에는 이행 마이그레이션(0012)뿐이다
// - 이 모듈을 부르는 곳은 위 세 경로의 파이프 처리기 · 제안 승인 함수뿐이고, 함수마다 사람 주체(`HumanAuthor`)를 인자로
//   받는다. 오케스트레이터 내부(엔진 · 단계 실행기 · 규칙 작성 서비스)와 에이전트 도구에는 이 모듈을 부르는 경로가 없다
//   (`integrity.test.ts`가 가져오는 파일을 단언한다)
// - 확인은 아무것도 막지 않는다: 실행 생성 · 단계 진행 · 판정 · 병합은 확인 상태를 읽지 않는다
import {
  type ApprovalLogEntry,
  type Author,
  type Confirmation,
  type ConfirmationTarget,
  ErrorCode,
  type HumanAuthor,
  type Requirement,
  type Rule,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { RpcError } from '../ipc/server.js';

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
    if (found.confirmation.state === 'confirmed') {
      throw new RpcError(ErrorCode.StateConflict, '이미 확인됨입니다');
    }
    const approvalLog = store.approvalLog.append({
      at,
      action: 'confirm',
      actor: by,
      targetRef: { entity: target.entity, id: target.id },
      clientId: context.clientId,
      detail: {},
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
