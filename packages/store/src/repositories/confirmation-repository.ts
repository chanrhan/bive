// 확인 상태 리포지토리 (NFR-01, ADR-100 D2 · I1 · C1, M7-01 #213, ADR-101). 테이블 `confirmations`(0012).
// - 규범 항목(요구사항 · 규칙)마다 1행. 행이 없으면 미확인(기본)이다
// - 확인됨을 쓰는 함수는 `confirm` 하나이고 확인한 사람(`HumanAuthor`)을 인자로 받는다. 사람이 아닌 주체는 스키마 ·
//   DB CHECK가 모두 거부한다. 누가 부를 수 있는지(사람 RPC · 사람의 요구사항 저장 · 사람의 제안 승인)는 오케스트레이터의
//   확인 서비스(`orchestrator/src/confirmations/confirmation-service.ts`)가 정한다
// - 확인 상태를 미확인으로 되돌리는 함수는 `release` 하나다(확인 풀림, M7-13 #225, ADR-113). 행은 지우지 않고 상태를 미확인으로
//   바꾸며 확인 시각 · 주체 · 근거를 비운다(0012 CHECK). 바로 앞에 그 대상의 확인 풀림 기록(`norm_changes` 종류 `unconfirmed`)이
//   있어야 DB가 받는다(0019 트리거). 누가 부를 수 있는지는 확인 서비스가 정한다(에이전트의 폐기 · 대체를 반영하는 모듈뿐)
import {
  Confirmation,
  ConfirmationBasis,
  type ConfirmationEntity,
  ConfirmationTarget,
  type HumanAuthor,
  HumanAuthor as HumanAuthorSchema,
  Timestamp,
  UNCONFIRMED,
} from '@bive/shared';

import { withTransaction, type SqliteDatabase } from '../database.js';

/** 확인 상태 칸 (요구사항 · 규칙 조회가 `LEFT JOIN`으로 함께 읽는다). 행이 없으면 모두 `null`. */
export interface ConfirmationColumns {
  confirmation_state: string | null;
  confirmation_at: string | null;
  confirmation_by: string | null;
  confirmation_basis: string | null;
}

/**
 * 요구사항 · 규칙 조회에 붙이는 `SELECT` 칸과 `LEFT JOIN` 절. `alias`는 대상 테이블의 별칭이다.
 * 확인 상태는 대상 행의 저장 필드가 아니라 이 표에서 읽는다.
 */
export const confirmationJoin = (
  entity: ConfirmationEntity,
  alias: string,
): { columns: string; join: string } => ({
  columns: `c.state AS confirmation_state, c.confirmed_at AS confirmation_at,
    c.confirmed_by AS confirmation_by, c.basis AS confirmation_basis`,
  join: `LEFT JOIN confirmations c ON c.entity = '${entity}' AND c.target_id = ${alias}.id`,
});

/** 확인 상태 칸 → `Confirmation`. 행이 없으면 미확인. */
export const toConfirmation = (row: ConfirmationColumns): Confirmation => {
  if (row.confirmation_state === null || row.confirmation_state === 'unconfirmed') {
    return Confirmation.parse(UNCONFIRMED);
  }
  return Confirmation.parse({
    state: row.confirmation_state,
    at: row.confirmation_at,
    by: row.confirmation_by === null ? null : (JSON.parse(row.confirmation_by) as unknown),
    basis: row.confirmation_basis === null ? null : (JSON.parse(row.confirmation_basis) as unknown),
  });
};

/** 확인됨으로 저장할 내용: 확인한 사람 · 시각 · 근거. */
export interface ConfirmInput {
  /** 확인한 주체. 사람만 받는다 (ADR-100 I1) */
  readonly by: HumanAuthor;
  readonly at: Timestamp;
  readonly basis: ConfirmationBasis;
}

interface ConfirmationRow {
  entity: string;
  target_id: string;
  state: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  basis: string | null;
}

export class ConfirmationRepository {
  readonly #db: SqliteDatabase;
  readonly #select;
  readonly #insert;
  readonly #update;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#select = db.prepare<[{ entity: string; target_id: string }], ConfirmationRow>(
      `SELECT entity, target_id, state, confirmed_at, confirmed_by, basis FROM confirmations
       WHERE entity = @entity AND target_id = @target_id`,
    );
    this.#insert = db.prepare<[ConfirmationRow]>(
      `INSERT INTO confirmations (entity, target_id, state, confirmed_at, confirmed_by, basis)
       VALUES (@entity, @target_id, @state, @confirmed_at, @confirmed_by, @basis)`,
    );
    this.#update = db.prepare<[ConfirmationRow]>(
      `UPDATE confirmations SET state = @state, confirmed_at = @confirmed_at,
       confirmed_by = @confirmed_by, basis = @basis
       WHERE entity = @entity AND target_id = @target_id`,
    );
  }

  /**
   * 대상의 확인 상태. 기록이 없으면 미확인. 대상이 있는지는 보지 않는다(호출한 쪽이 확인한다).
   * @throws {ZodError} 대상 형식 위반
   */
  get(target: ConfirmationTarget): Confirmation {
    const { entity, id } = ConfirmationTarget.parse(target);
    const row = this.#select.get({ entity, target_id: id });
    if (row === undefined) return Confirmation.parse(UNCONFIRMED);
    return toConfirmation({
      confirmation_state: row.state,
      confirmation_at: row.confirmed_at,
      confirmation_by: row.confirmed_by,
      confirmation_basis: row.basis,
    });
  }

  /**
   * 대상을 확인됨으로 저장한다(이미 확인됨이면 사람 · 시각 · 근거를 새 값으로). 호출한 쪽의 트랜잭션 안에서 부르면
   * 그 저장(요구사항 저장 · 승인 기록 추가)과 함께 커밋되거나 함께 되돌려진다.
   * @throws {ZodError} 대상 · 주체(사람 아님) · 시각 · 근거 형식 위반
   * @throws {SqliteError} 없는 대상 (트리거)
   */
  confirm(target: ConfirmationTarget, input: ConfirmInput): Confirmation {
    const { entity, id } = ConfirmationTarget.parse(target);
    const confirmation = Confirmation.parse({
      state: 'confirmed',
      at: Timestamp.parse(input.at),
      by: HumanAuthorSchema.parse(input.by),
      basis: ConfirmationBasis.parse(input.basis),
    });
    if (confirmation.state !== 'confirmed') throw new Error('확인됨이 아닙니다');
    const row: ConfirmationRow = {
      entity,
      target_id: id,
      state: confirmation.state,
      confirmed_at: confirmation.at,
      confirmed_by: JSON.stringify(confirmation.by),
      basis: JSON.stringify(confirmation.basis),
    };
    return withTransaction(this.#db, () => {
      if (this.#select.get({ entity, target_id: id }) === undefined) this.#insert.run(row);
      else this.#update.run(row);
      return confirmation;
    });
  }

  /**
   * 확인됨인 대상을 미확인으로 되돌린다(확인 풀림). 호출한 쪽의 트랜잭션 안에서, 그 대상의 확인 풀림 기록을 남긴 바로 뒤에
   * 부른다(0019 트리거가 확인한다).
   * @returns 풀리기 전의 확인
   * @throws {ZodError} 대상 형식 위반
   * @throws {Error} 대상이 확인됨이 아님
   * @throws {SqliteError} 바로 앞의 규범 변경 기록이 그 대상의 확인 풀림이 아님 (트리거)
   */
  release(target: ConfirmationTarget): Confirmation {
    const { entity, id } = ConfirmationTarget.parse(target);
    return withTransaction(this.#db, () => {
      const previous = this.get({ entity, id });
      if (previous.state !== 'confirmed') throw new Error('확인됨이 아니라 풀 확인이 없습니다');
      this.#update.run({
        entity,
        target_id: id,
        state: 'unconfirmed',
        confirmed_at: null,
        confirmed_by: null,
        basis: null,
      });
      return previous;
    });
  }
}
