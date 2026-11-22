// 규칙 리포지토리 (NRM-02, NRM-04, ADR-050). 입력 · 출력은 `@bive/shared`의 `Rule` 스키마로 검증한다.
// - 이 테이블에는 효력 있는 규칙이 들어간다: 사람이 승인한 제안의 규칙(NRM-04)과 규칙 작성 역할이 바로 반영한 규칙
//   (M7-02, ADR-100 D1: 같은 트랜잭션에서 규범 변경 기록 `normChanges`에 신규 항목이 남는다)
// - 표시 ID(`RULE-NNN`)는 생성 트랜잭션 안에서 순번 테이블로 정한다
// - 부모 요구사항이 삭제되면 규칙은 남기고 부모만 해제한다(`parentRequirementId = null`, `parentDetachedAt`)
// - 규칙을 제자리에서 고치는 함수는 사람의 직접 편집(제목 · 진술, `update`)뿐이다 (ADR-100 B②, M7-03, ADR-109).
//   오케스트레이터에서 이 함수를 부르는 곳은 `rule.update` 처리기 하나다(`integrity.test.ts` 구조 시험)
// - 확인 상태(`confirmation`)는 저장 칸이 아니라 `confirmations`에서 함께 읽는다. 이 리포지토리는 쓰지 않는다 (ADR-100 D2)
import { Rule, Timestamp, UNCONFIRMED, type Requirement } from '@bive/shared';

import { withTransaction, type SqliteDatabase } from '../database.js';
import { ConflictError, NotFoundError, isUniqueViolation } from '../errors.js';
import {
  type ConfirmationColumns,
  confirmationJoin,
  toConfirmation,
} from './confirmation-repository.js';
import { DisplayIdSequences } from './display-id-sequences.js';

/** 새 규칙. 표시 ID · 수정 시각 · 부모 해제 시각 · 삭제 시각은 리포지토리가 채운다. */
export type RuleCreateInput = Pick<
  Rule,
  | 'id'
  | 'title'
  | 'statement'
  | 'kind'
  | 'checkKinds'
  | 'parentRequirementId'
  | 'builtin'
  | 'targetBlockIds'
  | 'risk'
  | 'contractId'
  | 'author'
  | 'normState'
  | 'createdAt'
>;

const ENTITY = '규칙';

interface RuleRow {
  id: string;
  display_id: string;
  title: string;
  statement: string;
  kind: string;
  check_kinds: string;
  parent_requirement_id: string | null;
  parent_detached_at: string | null;
  builtin: number;
  target_block_ids: string;
  risk: string | null;
  contract_id: string | null;
  author: string;
  norm_state: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const COLUMNS = `id, display_id, title, statement, kind, check_kinds, parent_requirement_id,
  parent_detached_at, builtin, target_block_ids, risk, contract_id, author, norm_state, created_at,
  updated_at, deleted_at`;

/** 조회: 규칙 칸 + 확인 상태 칸 (확인 상태는 `confirmations`에서 읽는다, ADR-100 D2). */
const CONFIRMATION = confirmationJoin('Rule', 'r');
const SELECT = `SELECT ${COLUMNS.split(',')
  .map((column) => `r.${column.trim()}`)
  .join(', ')}, ${CONFIRMATION.columns} FROM rules r ${CONFIRMATION.join}`;

type RuleReadRow = RuleRow & ConfirmationColumns;

const toRule = (row: RuleReadRow): Rule =>
  Rule.parse({
    id: row.id,
    displayId: row.display_id,
    title: row.title,
    statement: row.statement,
    kind: row.kind,
    checkKinds: JSON.parse(row.check_kinds) as unknown,
    parentRequirementId: row.parent_requirement_id,
    parentDetachedAt: row.parent_detached_at,
    builtin: row.builtin === 1,
    targetBlockIds: JSON.parse(row.target_block_ids) as unknown,
    risk: row.risk,
    contractId: row.contract_id,
    author: JSON.parse(row.author) as unknown,
    normState: row.norm_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    confirmation: toConfirmation(row),
  });

const toRow = (rule: Rule): RuleRow => ({
  id: rule.id,
  display_id: rule.displayId,
  title: rule.title,
  statement: rule.statement,
  kind: rule.kind,
  check_kinds: JSON.stringify(rule.checkKinds),
  parent_requirement_id: rule.parentRequirementId,
  parent_detached_at: rule.parentDetachedAt,
  builtin: rule.builtin ? 1 : 0,
  target_block_ids: JSON.stringify(rule.targetBlockIds),
  risk: rule.risk,
  contract_id: rule.contractId,
  author: JSON.stringify(rule.author),
  norm_state: rule.normState,
  created_at: rule.createdAt,
  updated_at: rule.updatedAt,
  deleted_at: rule.deletedAt,
});

/** 규칙 편집 값 (사람의 직접 편집, M7-03). 생략한 칸은 그대로다. */
export type RulePatch = Partial<Pick<Rule, 'title' | 'statement'>>;

/** 표시 ID는 접두가 같고 순번에 앞자리 0이 없으므로 길이 → 사전식 순서가 순번 순서다. */
const ORDER = 'ORDER BY length(r.display_id), r.display_id';

export class RuleRepository {
  readonly #db: SqliteDatabase;
  readonly #sequences: DisplayIdSequences;
  readonly #insert;
  readonly #select;
  readonly #selectLive;
  readonly #selectByParent;
  readonly #requirementState;
  readonly #detach;
  readonly #update;

  constructor(db: SqliteDatabase, sequences: DisplayIdSequences = new DisplayIdSequences(db)) {
    this.#db = db;
    this.#sequences = sequences;
    this.#insert = db.prepare<[RuleRow]>(
      `INSERT INTO rules (${COLUMNS}) VALUES (@id, @display_id, @title, @statement, @kind,
       @check_kinds, @parent_requirement_id, @parent_detached_at, @builtin, @target_block_ids, @risk,
       @contract_id, @author, @norm_state, @created_at, @updated_at, @deleted_at)`,
    );
    this.#select = db.prepare<[string], RuleReadRow>(`${SELECT} WHERE r.id = ?`);
    this.#selectLive = db.prepare<[], RuleReadRow>(`${SELECT} WHERE r.deleted_at IS NULL ${ORDER}`);
    this.#selectByParent = db.prepare<[string], RuleReadRow>(
      `${SELECT} WHERE r.parent_requirement_id = ? AND r.deleted_at IS NULL ${ORDER}`,
    );
    this.#requirementState = db.prepare<[string], Pick<Requirement, 'deletedAt'>>(
      'SELECT deleted_at AS deletedAt FROM requirements WHERE id = ?',
    );
    this.#detach = db.prepare<[{ requirement_id: string; at: string }]>(
      `UPDATE rules SET parent_requirement_id = NULL, parent_detached_at = @at, updated_at = @at
       WHERE parent_requirement_id = @requirement_id AND deleted_at IS NULL`,
    );
    this.#update = db.prepare<[{ id: string; title: string; statement: string; at: string }]>(
      `UPDATE rules SET title = @title, statement = @statement, updated_at = @at
       WHERE id = @id AND deleted_at IS NULL`,
    );
  }

  /**
   * 규칙을 저장하고 표시 ID를 붙인다. 생성 직후 `updatedAt = createdAt`.
   * @throws {ZodError} 스키마 위반 (내장 규칙이 아닌데 부모 없음 등)
   * @throws {NotFoundError} 부모 요구사항이 없을 때
   * @throws {ConflictError} 부모 요구사항이 삭제됐거나 같은 ID가 이미 있을 때 (순번은 소비하지 않는다)
   */
  create(input: RuleCreateInput): Rule {
    return withTransaction(this.#db, () => {
      const draft = { ...input, displayId: 'RULE-001' };
      // 순번을 쓰기 전에 형식부터 검증한다
      Rule.parse({
        ...draft,
        parentDetachedAt: null,
        updatedAt: input.createdAt,
        deletedAt: null,
        confirmation: UNCONFIRMED,
      });
      if (input.parentRequirementId !== null) this.#assertLiveParent(input.parentRequirementId);
      const rule = Rule.parse({
        id: input.id,
        displayId: this.#sequences.nextDisplayId('RULE'),
        title: input.title,
        statement: input.statement,
        kind: input.kind,
        checkKinds: input.checkKinds,
        parentRequirementId: input.parentRequirementId,
        parentDetachedAt: null,
        builtin: input.builtin,
        targetBlockIds: input.targetBlockIds,
        risk: input.risk,
        contractId: input.contractId,
        author: input.author,
        normState: input.normState,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        deletedAt: null,
        // 새 규칙에는 확인 기록이 없다(미확인). 사람이 승인한 제안이면 오케스트레이터가 같은 트랜잭션에서 확인됨으로 둔다
        confirmation: UNCONFIRMED,
      });
      try {
        this.#insert.run(toRow(rule));
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(ENTITY, input.id, '이미 있습니다', { cause: error });
        }
        throw error;
      }
      return rule;
    });
  }

  /** ID로 찾는다. 소프트 삭제된 것도 돌려준다. 없으면 `null`. */
  get(id: string): Rule | null {
    const row = this.#select.get(id);
    return row === undefined ? null : toRule(row);
  }

  /** 삭제되지 않은 규칙을 표시 ID 순(= 생성 순)으로 돌려준다. */
  list(): Rule[] {
    return this.#selectLive.all().map(toRule);
  }

  /** 요구사항의 (삭제되지 않은) 자식 규칙을 표시 ID 순으로 돌려준다. */
  listByParent(requirementId: string): Rule[] {
    return this.#selectByParent.all(requirementId).map(toRule);
  }

  /**
   * 요구사항의 자식 규칙에서 부모를 해제한다: `parentRequirementId = null`, `parentDetachedAt = updatedAt = at`.
   * 규칙 자체는 지우지 않는다. 요구사항 소프트 삭제와 같은 트랜잭션에서 부른다.
   * @returns 해제한 규칙 수
   * @throws {ZodError} 시각 형식 위반
   */
  detachFromParent(requirementId: string, at: string): number {
    const when = Timestamp.parse(at);
    return this.#detach.run({ requirement_id: requirementId, at: when }).changes;
  }

  /**
   * 제목 · 진술을 바꾸고 `updatedAt`을 `at`으로 둔다 (사람의 직접 편집, M7-03). 그 밖의 칸 · 확인 상태는 바꾸지 않는다.
   * 형식(한 줄 · EARS 등)은 부르는 쪽이 본다. 이 함수는 스키마(빈 글 아님 · 시각 형식)만 본다.
   * @throws {ZodError} 빈 제목 · 진술, 시각 형식 위반
   * @throws {NotFoundError} 없는 규칙
   * @throws {ConflictError} 이미 삭제된 규칙
   */
  update(id: string, patch: RulePatch, at: string): Rule {
    return withTransaction(this.#db, () => {
      const current = this.get(id);
      if (current === null) throw new NotFoundError(ENTITY, id);
      if (current.deletedAt !== null) {
        throw new ConflictError(ENTITY, id, `삭제됐습니다 (${current.deletedAt})`);
      }
      const next = Rule.parse({
        ...current,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.statement === undefined ? {} : { statement: patch.statement }),
        updatedAt: Timestamp.parse(at),
      });
      this.#update.run({ id, title: next.title, statement: next.statement, at: next.updatedAt });
      return next;
    });
  }

  #assertLiveParent(requirementId: string): void {
    const parent = this.#requirementState.get(requirementId);
    if (parent === undefined) throw new NotFoundError('부모 요구사항', requirementId);
    if (parent.deletedAt !== null) {
      throw new ConflictError('부모 요구사항', requirementId, `삭제됐습니다 (${parent.deletedAt})`);
    }
  }
}
