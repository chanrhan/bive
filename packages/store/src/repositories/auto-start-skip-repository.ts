// 실행 자동 시작 생략 기록 리포지토리 (RUN-01 · NFR-03, ADR-100 B⑤ · A12, M7-05 #217, ADR-107). 테이블 `auto_start_skips`(0016).
// - 규칙 작성 세션 1개에 1행: 그 세션이 규칙을 만들고 정상 종료했는데 실행을 자동 시작하지 않은 사유
// - 추가(`record`)와 읽기만 있다. 수정 · 삭제는 DB 트리거가 막는다
import { AutoStartSkipReason, MissingSettingPath, type MissingSetting } from '@bive/shared';

import type { SqliteDatabase } from '../database.js';

/** 생략 기록 1건. `sessionId` = 규칙 작성 세션 ID(= 시도 ID). */
export interface AutoStartSkip {
  readonly sessionId: string;
  readonly reason: AutoStartSkipReason;
  /** `settings_incomplete`일 때 비어 있던 설정 항목 */
  readonly missing: MissingSetting[];
  readonly skippedAt: string;
}

interface SkipRow {
  session_id: string;
  reason: string;
  missing: string;
  skipped_at: string;
}

const MissingList = MissingSettingPath.array();

/** 저장된 행을 읽는다. 형식이 깨진 행(저장소 밖에서 고친 행)은 `null`. */
const toSkip = (row: SkipRow): AutoStartSkip | null => {
  const reason = AutoStartSkipReason.safeParse(row.reason);
  let missing: unknown;
  try {
    missing = JSON.parse(row.missing) as unknown;
  } catch {
    return null;
  }
  const parsed = MissingList.safeParse(missing);
  if (!reason.success || !parsed.success) return null;
  return {
    sessionId: row.session_id,
    reason: reason.data,
    missing: parsed.data,
    skippedAt: row.skipped_at,
  };
};

export class AutoStartSkipRepository {
  readonly #insert;
  readonly #select;

  constructor(db: SqliteDatabase) {
    this.#insert = db.prepare<[SkipRow]>(
      `INSERT INTO auto_start_skips (session_id, reason, missing, skipped_at)
       VALUES (@session_id, @reason, @missing, @skipped_at)`,
    );
    this.#select = db.prepare<[string], SkipRow>(
      'SELECT session_id, reason, missing, skipped_at FROM auto_start_skips WHERE session_id = ?',
    );
  }

  /**
   * 생략 기록을 남긴다.
   * @throws {ZodError} 사유 · 설정 항목 형식 위반
   * @throws {SqliteError} 같은 세션의 기록이 이미 있음 (덮어쓰기 금지)
   */
  record(input: AutoStartSkip): AutoStartSkip {
    const reason = AutoStartSkipReason.parse(input.reason);
    const missing = MissingList.parse(input.missing);
    this.#insert.run({
      session_id: input.sessionId,
      reason,
      missing: JSON.stringify(missing),
      skipped_at: input.skippedAt,
    });
    return { sessionId: input.sessionId, reason, missing, skippedAt: input.skippedAt };
  }

  /** 세션의 생략 기록. 없거나 형식이 깨졌으면 `null`. */
  get(sessionId: string): AutoStartSkip | null {
    const row = this.#select.get(sessionId);
    return row === undefined ? null : toSkip(row);
  }
}
