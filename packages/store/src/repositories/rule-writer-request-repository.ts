// 규칙 작성 시도 기록 리포지토리 (NRM-02, NFR-03, SCR-02, M3-26 #206, ADR-099).
// - 시도 1개 = 행 1개(`rule_writer_requests`). 세션을 열면 같은 ID의 `sessions` 행이 종료 사유 · 오류를 갖고,
//   열지 않으면 이 행에 생략 사유를 한 번 채운다. 생략된 행 · 세션을 연 행은 다시 생략으로 바꾸지 않는다
// - 상태는 읽을 때 두 행에서 만든다: 생략 = `skipped`, 세션이 끝남 = `ended`, 세션이 열림 = `running`, 그 밖 = `queued`
// - 이 표가 생기기 전(0011 이전)에 저장된 규칙 작성 세션(실행 밖 · `rule-writer` · 요구사항 있음)도 시도로 읽는다
import {
  MissingSettingPath,
  type MissingSetting,
  RuleWriterSkipReason,
  type RuleWriterState,
  SessionEndReason,
} from '@bive/shared';

import { withTransaction, type SqliteDatabase } from '../database.js';
import { ConflictError, NotFoundError } from '../errors.js';

const ENTITY = '규칙 작성 시도';

/** 새 시도. `skip`을 주면 세션 없이 생략된 시도로 만든다. */
export interface RuleWriterRequestInput {
  readonly id: string;
  readonly requirementId: string;
  readonly requestedAt: string;
  readonly skip?: RuleWriterSkipInput;
}

/** 생략 기록. `detail`이 빈 문자열이면 `null`로 남긴다. */
export interface RuleWriterSkipInput {
  readonly reason: RuleWriterSkipReason;
  readonly detail: string | null;
  readonly missing?: readonly MissingSetting[];
  readonly at: string;
}

/** 시도 1개를 두 행(시도 · 세션)에서 만든 값. */
export interface RuleWriterAttempt {
  readonly id: string;
  readonly requirementId: string;
  readonly requestedAt: string;
  readonly state: RuleWriterState;
  readonly skipReason: RuleWriterSkipReason | null;
  readonly missing: MissingSetting[];
  readonly endReason: SessionEndReason | null;
  /** 생략 설명 또는 세션 오류 (원문 그대로, 표시 값은 조회 처리기가 만든다) */
  readonly error: string | null;
  readonly endedAt: string | null;
}

interface AttemptRow {
  id: string;
  requirement_id: string;
  requested_at: string;
  skip_reason: string | null;
  skip_detail: string | null;
  missing: string;
  skipped_at: string | null;
  session_id: string | null;
  end_reason: string | null;
  error: string | null;
  ended_at: string | null;
}

const MissingList = MissingSettingPath.array();

const ATTEMPTS_SQL = `
SELECT r.id, r.requirement_id, r.requested_at, r.skip_reason, r.skip_detail, r.missing, r.skipped_at,
  s.id AS session_id, s.end_reason, s.error, s.ended_at
FROM rule_writer_requests r LEFT JOIN sessions s ON s.id = r.id
UNION ALL
SELECT s.id, s.requirement_id, s.started_at, NULL, NULL, '[]', NULL, s.id, s.end_reason, s.error, s.ended_at
FROM sessions s
WHERE s.run_id IS NULL AND s.role = 'rule-writer' AND s.requirement_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM rule_writer_requests r WHERE r.id = s.id)`;

const stateOf = (row: AttemptRow): RuleWriterState => {
  if (row.skip_reason !== null) return 'skipped';
  if (row.session_id === null) return 'queued';
  return row.end_reason === null ? 'running' : 'ended';
};

const toAttempt = (row: AttemptRow): RuleWriterAttempt => {
  const skipped = row.skip_reason !== null;
  return {
    id: row.id,
    requirementId: row.requirement_id,
    requestedAt: row.requested_at,
    state: stateOf(row),
    skipReason: skipped ? RuleWriterSkipReason.parse(row.skip_reason) : null,
    missing: MissingList.parse(JSON.parse(row.missing)),
    endReason: !skipped && row.end_reason !== null ? SessionEndReason.parse(row.end_reason) : null,
    error: skipped ? row.skip_detail : row.session_id === null ? null : row.error,
    endedAt: skipped ? row.skipped_at : row.ended_at,
  };
};

/** 시도 순서: 받은 시각 → ID (ULID라 같은 시각이면 만든 순서). */
const later = (a: AttemptRow, b: AttemptRow): boolean =>
  a.requested_at === b.requested_at ? a.id > b.id : a.requested_at > b.requested_at;

export class RuleWriterRequestRepository {
  readonly #db: SqliteDatabase;
  readonly #insert;
  readonly #select;
  readonly #sessionExists;
  readonly #markSkipped;
  readonly #pending;
  readonly #attempts;
  readonly #attemptsOf;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#insert = db.prepare<
      [
        {
          id: string;
          requirement_id: string;
          requested_at: string;
          skip_reason: string | null;
          skip_detail: string | null;
          missing: string;
          skipped_at: string | null;
        },
      ]
    >(
      `INSERT INTO rule_writer_requests (id, requirement_id, requested_at, skip_reason, skip_detail, missing,
       skipped_at) VALUES (@id, @requirement_id, @requested_at, @skip_reason, @skip_detail, @missing, @skipped_at)`,
    );
    this.#select = db.prepare<[string], { skip_reason: string | null }>(
      'SELECT skip_reason FROM rule_writer_requests WHERE id = ?',
    );
    this.#sessionExists = db.prepare<[string], { n: number }>(
      'SELECT count(*) AS n FROM sessions WHERE id = ?',
    );
    this.#markSkipped = db.prepare<
      [
        {
          id: string;
          skip_reason: string;
          skip_detail: string | null;
          missing: string;
          skipped_at: string;
        },
      ]
    >(
      `UPDATE rule_writer_requests SET skip_reason = @skip_reason, skip_detail = @skip_detail, missing = @missing,
       skipped_at = @skipped_at WHERE id = @id`,
    );
    this.#pending = db.prepare<[], { id: string }>(
      `SELECT r.id FROM rule_writer_requests r
       WHERE r.skip_reason IS NULL AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = r.id)
       ORDER BY r.requested_at, r.id`,
    );
    this.#attempts = db.prepare<[], AttemptRow>(ATTEMPTS_SQL);
    this.#attemptsOf = db.prepare<[string], AttemptRow>(
      `SELECT * FROM (${ATTEMPTS_SQL}) WHERE requirement_id = ?`,
    );
  }

  /**
   * 시도 행을 만든다.
   * @throws {ConflictError} 같은 ID가 이미 있을 때
   */
  create(input: RuleWriterRequestInput): void {
    withTransaction(this.#db, () => {
      if (this.#select.get(input.id) !== undefined) {
        throw new ConflictError(ENTITY, input.id, '이미 있습니다');
      }
      const skip = input.skip === undefined ? null : this.#skipColumns(input.skip);
      this.#insert.run({
        id: input.id,
        requirement_id: input.requirementId,
        requested_at: input.requestedAt,
        skip_reason: skip?.skip_reason ?? null,
        skip_detail: skip?.skip_detail ?? null,
        missing: skip?.missing ?? '[]',
        skipped_at: skip?.skipped_at ?? null,
      });
    });
  }

  /**
   * 대기 중이던 시도를 세션 없이 생략으로 끝낸다.
   * @throws {NotFoundError} 시도가 없을 때
   * @throws {ConflictError} 이미 생략됐거나 세션을 연 시도일 때
   */
  skip(id: string, skip: RuleWriterSkipInput): void {
    withTransaction(this.#db, () => {
      const row = this.#select.get(id);
      if (row === undefined) throw new NotFoundError(ENTITY, id);
      if (row.skip_reason !== null) throw new ConflictError(ENTITY, id, '이미 생략됐습니다');
      if ((this.#sessionExists.get(id)?.n ?? 0) > 0) {
        throw new ConflictError(ENTITY, id, '세션을 연 시도입니다');
      }
      this.#markSkipped.run({ id, ...this.#skipColumns(skip) });
    });
  }

  /**
   * 세션도 생략도 없는 시도(앞 프로세스의 대기열에 남은 것)를 모두 `closed`로 끝낸다. 재기동 때 부른다.
   * 끝낸 시도 ID를 돌려준다(받은 순서).
   */
  closePending(detail: string, at: string): string[] {
    return withTransaction(this.#db, () => {
      const ids = this.#pending.all().map((row) => row.id);
      for (const id of ids) {
        this.#markSkipped.run({
          id,
          ...this.#skipColumns({ reason: 'closed', detail, at }),
        });
      }
      return ids;
    });
  }

  /** 요구사항의 시도 전부 (받은 순서). */
  listByRequirement(requirementId: string): RuleWriterAttempt[] {
    return this.#attemptsOf
      .all(requirementId)
      .sort((a, b) => (later(a, b) ? 1 : later(b, a) ? -1 : 0))
      .map(toAttempt);
  }

  /** 요구사항의 가장 최근 시도. 없으면 `null`. */
  latest(requirementId: string): RuleWriterAttempt | null {
    return this.listByRequirement(requirementId).at(-1) ?? null;
  }

  /** 시도가 있는 요구사항마다 가장 최근 시도 하나 (요구사항 ID 순). */
  latestAll(): RuleWriterAttempt[] {
    const latest = new Map<string, AttemptRow>();
    for (const row of this.#attempts.all()) {
      const current = latest.get(row.requirement_id);
      if (current === undefined || later(row, current)) latest.set(row.requirement_id, row);
    }
    return [...latest.values()]
      .sort((a, b) => (a.requirement_id < b.requirement_id ? -1 : 1))
      .map(toAttempt);
  }

  #skipColumns(skip: RuleWriterSkipInput) {
    return {
      skip_reason: RuleWriterSkipReason.parse(skip.reason),
      skip_detail: skip.detail === null || skip.detail.length === 0 ? null : skip.detail,
      missing: JSON.stringify(MissingList.parse([...(skip.missing ?? [])])),
      skipped_at: skip.at,
    };
  }
}
