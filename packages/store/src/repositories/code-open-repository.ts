// 코드 열람 기록 리포지토리 (MET-01, M2-01 · ADR-084). 입력 · 출력은 `@bive/shared`의 `CodeOpenRecord`로 검증한다.
// - 기록은 추가만 한다(`record`). 수정 · 삭제 메서드는 없고 DB 트리거로도 막는다
// - 조회는 최신부터(시각 → ID 내림차순) 건수 제한까지 (`listLatest`)
// - 집계는 전체 기록의 사유별 건수 (`countByReason`, M2-02 · ADR-088). SQL에서 세므로 조회 건수 제한과 무관하다
// - 누가 기록할 수 있는지(사람만)는 호출한 쪽(오케스트레이터)이 정한다. 여기서는 형식만 검증한다
// - 쓰기는 엄격하게(`CodeOpenRecord`), 읽기는 느슨하게(`StoredCodeOpenRecord`, ADR-094): 쓰기 규칙이 조여지기 전에 저장된
//   행(PR #184 전의 `%`가 든 경로 등)도 읽어서 돌려준다. 타입 · 열거형이 깨진 행(DB CHECK가 막지만 그래도 들어온 경우)은
//   그 행만 건너뛰고 경고 한 줄(같은 프로젝트 · 같은 건수면 프로세스당 한 번)을 남긴다. 나머지는 그대로 돌려준다
import {
  CodeOpenReason,
  type CodeOpenReasonCount,
  CodeOpenRecord,
  StoredCodeOpenRecord,
  type Ulid,
} from '@bive/shared';

import { withTransaction, type SqliteDatabase } from '../database.js';
import { ConflictError, isUniqueViolation } from '../errors.js';
import { warnOnce } from '../read-warnings.js';

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

/** 저장된 행을 읽기 형식으로. 타입 · 열거형이 깨진 행이면 `null`. */
const toRecord = (row: CodeOpenRow): StoredCodeOpenRecord | null => {
  const parsed = StoredCodeOpenRecord.safeParse({
    id: row.id,
    at: row.at,
    reason: row.reason,
    sourceScreen: row.source_screen,
    itemRef: { entity: row.item_entity, id: row.item_id },
    file: row.file,
    line: row.line,
  });
  return parsed.success ? parsed.data : null;
};

export class CodeOpenRepository {
  readonly #db: SqliteDatabase;
  readonly #projectId: Ulid;
  readonly #insert;
  readonly #exists;
  readonly #latest;
  readonly #countByReason;

  constructor(db: SqliteDatabase, projectId: Ulid) {
    this.#db = db;
    this.#projectId = projectId;
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

  /**
   * 최신부터 `limit`건 (시각이 같으면 ID가 큰 것 먼저). `limit`은 1 이상으로 맞춘다. 읽기 형식(ADR-094)으로 읽으며,
   * 그 형식에도 맞지 않는 행은 건너뛰고(건수 제한 안의 행만 센다) 경고를 남긴다.
   */
  listLatest(limit: number): StoredCodeOpenRecord[] {
    const records: StoredCodeOpenRecord[] = [];
    let skipped = 0;
    for (const row of this.#latest.all(Math.max(1, Math.trunc(limit)))) {
      const record = toRecord(row);
      if (record === null) skipped += 1;
      else records.push(record);
    }
    if (skipped > 0) this.#warnSkipped('list', skipped);
    return records;
  }

  /**
   * 전체 기록의 사유별 건수. 사유 3종을 고정 순서(`CodeOpenReason` 순서)로 모두 돌려준다(기록이 없는 사유는 0).
   * 저장된 사유가 열거형 밖인 행(DB CHECK가 막으므로 보통 생기지 않는다)은 세지 않고 경고를 남긴다 (ADR-094).
   */
  countByReason(): CodeOpenReasonCount[] {
    const counts = new Map<CodeOpenReason, number>();
    let skipped = 0;
    for (const row of this.#countByReason.all()) {
      const reason = CodeOpenReason.safeParse(row.reason);
      if (reason.success) counts.set(reason.data, row.count);
      else skipped += row.count;
    }
    if (skipped > 0) this.#warnSkipped('summary', skipped);
    return CodeOpenReason.options.map((reason) => ({ reason, count: counts.get(reason) ?? 0 }));
  }

  #warnSkipped(what: 'list' | 'summary', count: number): void {
    warnOnce(
      `code_open_records.${what}:${this.#projectId}`,
      String(count),
      `코드 열람 기록 ${String(count)}건이 저장 형식에 맞지 않아 ${what === 'list' ? '조회' : '집계'}에서 건너뜀 (프로젝트 ${this.#projectId})`,
    );
  }
}
