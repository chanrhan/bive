// 요구사항 리포지토리 (NRM-01, ADR-047). 입력 · 출력은 `@bive/shared`의 `Requirement` 스키마로 검증한다.
// - 표시 ID(`REQ-NNN`)는 생성 트랜잭션 안에서 순번 테이블로 정한다
// - 삭제는 `deletedAt`을 채우는 소프트 삭제다. 목록은 삭제된 것을 빼고, ID 조회는 삭제된 것도 돌려준다
// - 누가 바꿀 수 있는지(사람 · 에이전트)는 호출한 쪽(오케스트레이터)이 정한다. 여기서는 주체를 기록만 한다
import { Author, Requirement, Timestamp } from '@bive/shared';

import { withTransaction, type SqliteDatabase } from '../database.js';
import { ConflictError, NotFoundError, isUniqueViolation } from '../errors.js';
import { DisplayIdSequences } from './display-id-sequences.js';

/** 새 요구사항. 표시 ID · 수정 기록 · 삭제 시각은 리포지토리가 채운다. 모르는 필드는 거부한다. */
export const RequirementCreateInput = Requirement.pick({
  id: true,
  text: true,
  author: true,
  normState: true,
  createdAt: true,
});
export type RequirementCreateInput = Pick<
  Requirement,
  'id' | 'text' | 'author' | 'normState' | 'createdAt'
>;

/** 수정할 수 있는 필드. 모르는 필드는 거부한다. */
export const RequirementPatch = Requirement.pick({ text: true });
export type RequirementPatch = Pick<Requirement, 'text'>;

/** 변경(수정 · 소프트 삭제)의 주체와 시각. `updatedBy` · `updatedAt`이 된다. */
export interface RequirementChange {
  readonly by: Author;
  readonly at: Timestamp;
}

/**
 * 변경 주체 · 시각을 검증한다.
 * @throws {ZodError}
 */
export const parseRequirementChange = (change: RequirementChange): RequirementChange => ({
  by: Author.parse(change.by),
  at: Timestamp.parse(change.at),
});

const ENTITY = '요구사항';

interface RequirementRow {
  id: string;
  display_id: string;
  text: string;
  author: string;
  norm_state: string;
  unrulable_reason: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
}

const COLUMNS =
  'id, display_id, text, author, norm_state, unrulable_reason, created_at, updated_at, updated_by, deleted_at';

const toRequirement = (row: RequirementRow): Requirement =>
  Requirement.parse({
    id: row.id,
    displayId: row.display_id,
    text: row.text,
    author: JSON.parse(row.author) as unknown,
    normState: row.norm_state,
    unrulable: row.unrulable_reason === null ? null : { reason: row.unrulable_reason },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: JSON.parse(row.updated_by) as unknown,
    deletedAt: row.deleted_at,
  });

const toRow = (requirement: Requirement): RequirementRow => ({
  id: requirement.id,
  display_id: requirement.displayId,
  text: requirement.text,
  author: JSON.stringify(requirement.author),
  norm_state: requirement.normState,
  unrulable_reason: requirement.unrulable?.reason ?? null,
  created_at: requirement.createdAt,
  updated_at: requirement.updatedAt,
  updated_by: JSON.stringify(requirement.updatedBy),
  deleted_at: requirement.deletedAt,
});

export class RequirementRepository {
  readonly #db: SqliteDatabase;
  readonly #sequences: DisplayIdSequences;
  readonly #insert;
  readonly #select;
  readonly #selectLive;
  readonly #update;

  constructor(db: SqliteDatabase, sequences: DisplayIdSequences = new DisplayIdSequences(db)) {
    this.#db = db;
    this.#sequences = sequences;
    this.#insert = db.prepare<[RequirementRow]>(
      `INSERT INTO requirements (${COLUMNS}) VALUES (@id, @display_id, @text, @author, @norm_state,
       @unrulable_reason, @created_at, @updated_at, @updated_by, @deleted_at)`,
    );
    this.#select = db.prepare<[string], RequirementRow>(
      `SELECT ${COLUMNS} FROM requirements WHERE id = ?`,
    );
    // 표시 ID는 접두가 같고 순번에 앞자리 0이 없으므로(정규 형식) 길이 → 사전식 순서가 순번 순서다
    this.#selectLive = db.prepare<[], RequirementRow>(
      `SELECT ${COLUMNS} FROM requirements WHERE deleted_at IS NULL
       ORDER BY length(display_id), display_id`,
    );
    this.#update = db.prepare<[RequirementRow]>(
      `UPDATE requirements SET text = @text, norm_state = @norm_state,
       unrulable_reason = @unrulable_reason, updated_at = @updated_at, updated_by = @updated_by,
       deleted_at = @deleted_at WHERE id = @id`,
    );
  }

  /**
   * 요구사항을 저장하고 표시 ID를 붙인다. 생성 직후 `updatedAt = createdAt`, `updatedBy = author`.
   * @throws {ZodError} 스키마 위반
   * @throws {ConflictError} 같은 ID가 이미 있을 때 (순번은 소비하지 않는다)
   */
  create(input: RequirementCreateInput): Requirement {
    const { id, text, author, normState, createdAt } = RequirementCreateInput.parse(input);
    return withTransaction(this.#db, () => {
      const requirement = Requirement.parse({
        id,
        displayId: this.#sequences.nextDisplayId('REQ'),
        text,
        author,
        normState,
        unrulable: null,
        createdAt,
        updatedAt: createdAt,
        updatedBy: author,
        deletedAt: null,
      });
      try {
        this.#insert.run(toRow(requirement));
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(ENTITY, id, '이미 있습니다', { cause: error });
        }
        throw error;
      }
      return requirement;
    });
  }

  /** ID로 찾는다. 소프트 삭제된 것도 돌려준다(`deletedAt`으로 구분). 없으면 `null`. */
  get(id: string): Requirement | null {
    const row = this.#select.get(id);
    return row === undefined ? null : toRequirement(row);
  }

  /** 삭제되지 않은 요구사항을 표시 ID 순(= 생성 순)으로 돌려준다. */
  list(): Requirement[] {
    return this.#selectLive.all().map(toRequirement);
  }

  /**
   * 본문을 바꾸고 `updatedAt` · `updatedBy`를 갱신한다.
   * @throws {ZodError} 수정 값 · 주체 · 시각이 스키마 위반
   * @throws {NotFoundError} 없는 ID
   * @throws {ConflictError} 이미 삭제된 요구사항
   */
  update(id: string, patch: RequirementPatch, change: RequirementChange): Requirement {
    const changes = RequirementPatch.parse(patch);
    const { by, at } = parseRequirementChange(change);
    return withTransaction(this.#db, () => {
      const current = this.#requireLive(id);
      const next = Requirement.parse({ ...current, ...changes, updatedAt: at, updatedBy: by });
      this.#update.run(toRow(next));
      return next;
    });
  }

  /**
   * 소프트 삭제한다: `deletedAt` · `updatedAt`을 변경 시각으로, `updatedBy`를 주체로 채운다. 행은 남는다.
   * @throws {ZodError} 주체 · 시각이 스키마 위반
   * @throws {NotFoundError} 없는 ID
   * @throws {ConflictError} 이미 삭제된 요구사항
   */
  softDelete(id: string, change: RequirementChange): Requirement {
    const { by, at } = parseRequirementChange(change);
    return withTransaction(this.#db, () => {
      const current = this.#requireLive(id);
      const next = Requirement.parse({ ...current, updatedAt: at, updatedBy: by, deletedAt: at });
      this.#update.run(toRow(next));
      return next;
    });
  }

  #requireLive(id: string): Requirement {
    const current = this.get(id);
    if (current === null) throw new NotFoundError(ENTITY, id);
    if (current.deletedAt !== null) {
      throw new ConflictError(ENTITY, id, `이미 삭제됐습니다 (${current.deletedAt})`);
    }
    return current;
  }
}
