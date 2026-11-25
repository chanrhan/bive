// 계약 리포지토리 (NRM-03, ADR-019, M3-04 #49, ADR-129). 테이블 `contracts`(0024). 입력 · 출력은 `@bive/shared`의 `Contract`로 검증한다.
// - 계약 1건 = 원본 파일 1개(등록 단위). 같은 파일의 계약은 하나뿐이다(DB UNIQUE · 트리거)
// - 표시 ID(`CON-NNN`)는 생성 트랜잭션 안에서 순번 테이블로 정한다
// - 지금은 만들기 · 읽기만 있다(고치기 · 지우기는 트리거가 막는다. 변경 반영은 M3-10). 누가 만들 수 있는지(사람의 등록 RPC ·
//   에이전트 반영 모듈)는 오케스트레이터의 계약 모듈(`orchestrator/src/norms/contract.ts`)이 정한다
// - 확인 상태(`confirmation`)는 저장 칸이 아니라 `confirmations`에서 함께 읽는다. 이 리포지토리는 쓰지 않는다 (ADR-100 D2)
import { Contract, UNCONFIRMED } from '@bive/shared';

import { withTransaction, type SqliteDatabase } from '../database.js';
import { ConflictError, NotFoundError } from '../errors.js';
import {
  type ConfirmationColumns,
  confirmationJoin,
  toConfirmation,
} from './confirmation-repository.js';
import { DisplayIdSequences } from './display-id-sequences.js';

/** 새 계약. 표시 ID는 리포지토리가 채운다. */
export type ContractCreateInput = Pick<
  Contract,
  | 'id'
  | 'kind'
  | 'sourceFile'
  | 'contentHash'
  | 'sourceCommit'
  | 'parentRequirementId'
  | 'author'
  | 'createdAt'
>;

const ENTITY = '계약';

interface ContractRow {
  id: string;
  display_id: string;
  kind: string;
  source_file: string;
  content_hash: string;
  source_commit: string;
  parent_requirement_id: string | null;
  author: string;
  created_at: string;
}

const COLUMNS = `id, display_id, kind, source_file, content_hash, source_commit, parent_requirement_id,
  author, created_at`;

const CONFIRMATION = confirmationJoin('Contract', 'k');
const SELECT = `SELECT ${COLUMNS.split(',')
  .map((column) => `k.${column.trim()}`)
  .join(', ')}, ${CONFIRMATION.columns} FROM contracts k ${CONFIRMATION.join}`;

/** 표시 ID는 접두가 같고 순번에 앞자리 0이 없으므로 길이 → 사전식 순서가 순번 순서다. */
const ORDER = 'ORDER BY length(k.display_id), k.display_id';

const toContract = (row: ContractRow & ConfirmationColumns): Contract =>
  Contract.parse({
    id: row.id,
    displayId: row.display_id,
    kind: row.kind,
    sourceFile: row.source_file,
    contentHash: row.content_hash,
    sourceCommit: row.source_commit,
    parentRequirementId: row.parent_requirement_id,
    author: JSON.parse(row.author) as unknown,
    createdAt: row.created_at,
    confirmation: toConfirmation(row),
  });

export class ContractRepository {
  readonly #db: SqliteDatabase;
  readonly #sequences: DisplayIdSequences;
  readonly #insert;
  readonly #select;
  readonly #selectAll;
  readonly #selectByFile;
  readonly #requirementState;

  constructor(db: SqliteDatabase, sequences: DisplayIdSequences = new DisplayIdSequences(db)) {
    this.#db = db;
    this.#sequences = sequences;
    this.#insert = db.prepare<[ContractRow]>(
      `INSERT INTO contracts (${COLUMNS}) VALUES (@id, @display_id, @kind, @source_file, @content_hash,
       @source_commit, @parent_requirement_id, @author, @created_at)`,
    );
    this.#select = db.prepare<[string], ContractRow & ConfirmationColumns>(
      `${SELECT} WHERE k.id = ?`,
    );
    this.#selectAll = db.prepare<[], ContractRow & ConfirmationColumns>(`${SELECT} ${ORDER}`);
    this.#selectByFile = db.prepare<[string], { id: string }>(
      'SELECT id FROM contracts WHERE source_file = ?',
    );
    this.#requirementState = db.prepare<[string], { deleted_at: string | null }>(
      'SELECT deleted_at FROM requirements WHERE id = ?',
    );
  }

  /**
   * 계약을 저장하고 표시 ID를 붙인다. 새 계약에는 확인 기록이 없다(미확인). 사람의 등록이면 오케스트레이터가 같은 트랜잭션에서
   * 확인됨으로 둔다.
   * @throws {ZodError} 스키마 위반
   * @throws {NotFoundError} 부모 요구사항이 없음
   * @throws {ConflictError} 같은 파일의 계약 · 같은 ID가 이미 있음 · 부모 요구사항이 삭제됨 (순번은 소비하지 않는다)
   */
  create(input: ContractCreateInput): Contract {
    return withTransaction(this.#db, () => {
      // 순번을 쓰기 전에 형식부터 검증한다
      Contract.parse({ ...input, displayId: 'CON-001', confirmation: UNCONFIRMED });
      if (input.parentRequirementId !== null) {
        const parent = this.#requirementState.get(input.parentRequirementId);
        if (parent === undefined) throw new NotFoundError('요구사항', input.parentRequirementId);
        if (parent.deleted_at !== null) {
          throw new ConflictError(
            '요구사항',
            input.parentRequirementId,
            `삭제됐습니다 (${parent.deleted_at})`,
          );
        }
      }
      // 같은 키 · 파일은 덮어쓰기 금지 트리거보다 먼저 저장소 오류로 거른다 (트리거 오류는 상태 충돌로 읽히지 않는다)
      if (this.#selectByFile.get(input.sourceFile) !== undefined) {
        throw new ConflictError(ENTITY, input.sourceFile, '같은 파일의 계약이 이미 있습니다');
      }
      if (this.#select.get(input.id) !== undefined) {
        throw new ConflictError(ENTITY, input.id, '이미 있습니다');
      }
      const contract = Contract.parse({
        ...input,
        displayId: this.#sequences.nextDisplayId('CON'),
        confirmation: UNCONFIRMED,
      });
      this.#insert.run({
        id: contract.id,
        display_id: contract.displayId,
        kind: contract.kind,
        source_file: contract.sourceFile,
        content_hash: contract.contentHash,
        source_commit: contract.sourceCommit,
        parent_requirement_id: contract.parentRequirementId,
        author: JSON.stringify(contract.author),
        created_at: contract.createdAt,
      });
      return contract;
    });
  }

  /** ID로 찾는다. 없으면 `null`. */
  get(id: string): Contract | null {
    const row = this.#select.get(id);
    return row === undefined ? null : toContract(row);
  }

  /** 계약 전부를 표시 ID 순(= 등록 순)으로 돌려준다. */
  list(): Contract[] {
    return this.#selectAll.all().map(toContract);
  }
}
