// 블록 선언 리포지토리 (NRM-09 · JDG-05, ADR-005, M3-01 #46, ADR-122). 테이블 `block_declarations`(0022).
// - 사람이 저장할 때마다 새 판 1행. 지금 선언은 가장 큰 판이다. 추가(`set`)와 읽기만 있다
// - 저장 주체가 사람인지, 판이 다음 번호인지, 덮어쓰기 · 수정 · 삭제 금지는 DB가 함께 본다(0022 CHECK · 트리거)
// - 선언 본문은 쓸 때 · 읽을 때 shared 스키마(`BlockDeclaration`)로 본다. 읽을 때 깨진 행(저장소 밖에서 고친 행)은
//   `StoredBlockDeclarationError`다(지금 선언을 모르는 채 판정 · 세션 입력을 만들지 않는 닫힌 쪽). 스키마 오류(`ZodError`)로 던지지
//   않아 부른 쪽이 에이전트 인자 오류와 헷갈리지 않는다. 경고 로그에는 판 번호 · 건수 · 프로젝트 ID만 싣고 저장된 값은 싣지 않는다
import {
  BlockDeclaration,
  BlockDeclarationRecord,
  HumanAuthor,
  Timestamp,
  Ulid,
} from '@bive/shared';

import type { SqliteDatabase } from '../database.js';
import { StoreError } from '../errors.js';
import { warnOnce } from '../read-warnings.js';

interface DeclarationRow {
  version: number;
  set_at: string;
  set_by: string;
  declaration: string;
}

const COLUMNS = 'version, set_at, set_by, declaration';

/** 저장된 블록 선언 행이 저장 형식에 맞지 않는다 (저장소 밖 변조). 메시지에는 판 번호 · 건수 · 프로젝트 ID만 있다. */
export class StoredBlockDeclarationError extends StoreError {}

const parseRow = (row: DeclarationRow): BlockDeclarationRecord | null => {
  try {
    const parsed = BlockDeclarationRecord.safeParse({
      version: row.version,
      setAt: row.set_at,
      setBy: JSON.parse(row.set_by) as unknown,
      declaration: JSON.parse(row.declaration) as unknown,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export class BlockDeclarationRepository {
  readonly #insert;
  readonly #selectLatest;
  readonly #selectAll;

  readonly #projectId: Ulid;

  constructor(db: SqliteDatabase, projectId: Ulid) {
    this.#projectId = projectId;
    this.#insert = db.prepare<[DeclarationRow]>(
      `INSERT INTO block_declarations (${COLUMNS})
       VALUES (@version, @set_at, @set_by, @declaration)`,
    );
    this.#selectLatest = db.prepare<[], DeclarationRow>(
      `SELECT ${COLUMNS} FROM block_declarations ORDER BY version DESC LIMIT 1`,
    );
    this.#selectAll = db.prepare<[], DeclarationRow>(
      `SELECT ${COLUMNS} FROM block_declarations ORDER BY version`,
    );
  }

  /** 깨진 행을 알린다: 경고 한 줄(같은 내용이면 프로세스당 한 번)과 오류. */
  #broken(what: string, count: number): StoredBlockDeclarationError {
    const message = `블록 선언 ${what} ${String(count)}건이 저장 형식에 맞지 않아 읽지 못함 (프로젝트 ${this.#projectId})`;
    warnOnce(`block-declarations:${this.#projectId}`, `${what}:${String(count)}`, message);
    return new StoredBlockDeclarationError(message);
  }

  /**
   * 지금 블록 선언(가장 큰 판). 한 번도 저장하지 않았으면 `null`.
   * @throws {StoredBlockDeclarationError} 가장 큰 판의 행이 깨졌을 때
   */
  current(): BlockDeclarationRecord | null {
    const row = this.#selectLatest.get();
    if (row === undefined) return null;
    const record = parseRow(row);
    if (record === null) throw this.#broken(`판 ${String(row.version)}`, 1);
    return record;
  }

  /** 모든 판 (판 순서). @throws {StoredBlockDeclarationError} 깨진 행이 하나라도 있을 때 */
  list(): BlockDeclarationRecord[] {
    const records = this.#selectAll.all().map(parseRow);
    const broken = records.filter((record) => record === null).length;
    if (broken > 0) throw this.#broken('판', broken);
    return records as BlockDeclarationRecord[];
  }

  /**
   * 선언을 다음 판으로 저장한다. 저장 주체는 사람만(타입 · 스키마 · DB 셋 다).
   * @throws {ZodError} 선언 스키마 · 저장 규칙 위반, 주체가 사람이 아님, 시각 형식 위반
   */
  set(declaration: unknown, change: { at: string; by: HumanAuthor }): BlockDeclarationRecord {
    const parsed = BlockDeclaration.parse(declaration);
    const by = HumanAuthor.parse(change.by);
    const at = Timestamp.parse(change.at);
    const version = (this.#selectLatest.get()?.version ?? 0) + 1;
    this.#insert.run({
      version,
      set_at: at,
      set_by: JSON.stringify(by),
      declaration: JSON.stringify(parsed),
    });
    return { version, declaration: parsed, setAt: at, setBy: by };
  }
}
