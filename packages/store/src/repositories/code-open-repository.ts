// 코드 열람 기록 리포지토리 (MET-01, M2-01 · ADR-084). 입력 · 출력은 `@bive/shared`의 `CodeOpenRecord`로 검증한다.
// - 기록은 추가만 한다(`record`). 수정 · 삭제 메서드는 없고 DB 트리거로도 막는다
// - 조회는 최신부터(시각 → ID 내림차순) 건수 제한까지 (`listLatest`)
// - 집계는 전체 기록의 사유별 건수 (`countByReason`, M2-02 · ADR-088). SQL에서 세므로 조회 건수 제한과 무관하다
// - 누가 기록할 수 있는지(사람만)는 호출한 쪽(오케스트레이터)이 정한다. 여기서는 형식만 검증한다
import { CodeOpenReason, type CodeOpenReasonCount, CodeOpenRecord } from '@bive/shared';

import { withTransaction, type SqliteDatabase } from '../database.js';
import { ConflictError, isUniqueViolation } from '../errors.js';

const ENTITY = '코드 열람 기록';

interface CodeOpenRow {
  id: string;
  at: string;
  reason: string;
  source_screen: string;
  item_entity: string;
  item_id: string;
  file: string;
  line: number;
}

const COLUMNS = 'id, at, reason, source_screen, item_entity, item_id, file, line';

const toRow = (record: CodeOpenRecord): CodeOpenRow => ({
  id: record.id,
  at: record.at,
  reason: record.reason,
  source_screen: record.sourceScreen,
  item_entity: record.itemRef.entity,
  item_id: record.itemRef.id,
  file: record.file,
  line: record.line,
});

const toRecord = (row: CodeOpenRow): CodeOpenRecord =>
  CodeOpenRecord.parse({
    id: row.id,
    at: row.at,
    reason: row.reason,
    sourceScreen: row.source_screen,
    itemRef: { entity: row.item_entity, id: row.item_id },
    file: row.file,
    line: row.line,
  });

export class CodeOpenRepository {
  readonly #db: SqliteDatabase;
  readonly #insert;
  readonly #exists;
  readonly #latest;
  readonly #countByReason;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#insert = db.prepare<[CodeOpenRow]>(
      `INSERT INTO code_open_records (${COLUMNS}) VALUES (@id, @at, @reason, @source_screen,
       @item_entity, @item_id, @file, @line)`,
    );
    this.#exists = db.prepare<[string], { id: string }>(
      'SELECT id FROM code_open_records WHERE id = ?',
    );
    this.#latest = db.prepare<[number], CodeOpenRow>(
      `SELECT ${COLUMNS} FROM code_open_records ORDER BY at DESC, id DESC LIMIT ?`,
    );
    this.#countByReason = db.prepare<[], { reason: string; count: number }>(
      'SELECT reason, COUNT(*) AS count FROM code_open_records GROUP BY reason',
    );
  }

  /**
   * 열람 기록 1건을 추가한다 (트랜잭션 1회). 시각은 밀리초 3자리 UTC로 맞춰 저장한다.
   * @throws {ZodError} 형식 위반 (절대 경로 · `..` · 제어 문자 · 0 이하 줄 · 모르는 사유 · 화면 ID 아님)
   * @throws {ConflictError} 같은 ID가 이미 있을 때
   */
  record(input: CodeOpenRecord): CodeOpenRecord {
    const checked = CodeOpenRecord.parse(input);
    const record = { ...checked, at: new Date(Date.parse(checked.at)).toISOString() };
    return withTransaction(this.#db, () => {
      if (this.#exists.get(record.id) !== undefined) {
        throw new ConflictError(ENTITY, record.id, '이미 있습니다');
      }
      try {
        this.#insert.run(toRow(record));
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(ENTITY, record.id, '이미 있습니다', { cause: error });
        }
        throw error;
      }
      return record;
    });
  }

  /** 최신부터 `limit`건 (시각이 같으면 ID가 큰 것 먼저). `limit`은 1 이상으로 맞춘다. */
  listLatest(limit: number): CodeOpenRecord[] {
    return this.#latest.all(Math.max(1, Math.trunc(limit))).map(toRecord);
  }

  /**
   * 전체 기록의 사유별 건수. 사유 3종을 고정 순서(`CodeOpenReason` 순서)로 모두 돌려준다(기록이 없는 사유는 0).
   * @throws {ZodError} 저장된 사유가 열거형 밖일 때 (DB CHECK가 막으므로 생기지 않는다)
   */
  countByReason(): CodeOpenReasonCount[] {
    const counts = new Map<CodeOpenReason, number>();
    for (const row of this.#countByReason.all()) {
      counts.set(CodeOpenReason.parse(row.reason), row.count);
    }
    return CodeOpenReason.options.map((reason) => ({ reason, count: counts.get(reason) ?? 0 }));
  }
}
