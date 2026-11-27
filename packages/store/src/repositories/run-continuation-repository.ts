// 이어받는 실행의 연결 리포지토리 (TODO-02 · COST-01 · NFR-01, M3-56 #319, ADR-147 ②, ADR-149). 표 `run_continuations`(0030).
// - 연결(`link`)은 추가만 한다. 넣을 때의 조건(원 실행이 예산 초과 · 같은 유형 · 대상 규칙 · 사람이 막 시작한 실행)과 수정 · 삭제 거부는
//   DB 트리거가 본다. 쓰는 곳은 오케스트레이터의 검토 대기열 모듈 하나다(구조 시험)
// - 읽기: 이 실행이 이어받은 원 실행(`originOf`), 사슬의 뿌리부터 바로 앞 원 실행까지(`ancestorsOf`), 원 실행을 이어받은 실행
//   (`continuationOf`). 판정 근거 · 한도 누적 · 회귀 수는 `ancestorsOf`의 실행들 기록에서 읽는다
import type { SqliteDatabase } from '../database.js';

/** 이어받는 실행 1쌍. */
export interface RunContinuation {
  readonly runId: string;
  readonly originRunId: string;
  readonly createdAt: string;
}

interface ContinuationRow {
  run_id: string;
  origin_run_id: string;
  created_at: string;
}

const toContinuation = (row: ContinuationRow): RunContinuation => ({
  runId: row.run_id,
  originRunId: row.origin_run_id,
  createdAt: row.created_at,
});

export class RunContinuationRepository {
  readonly #insert;
  readonly #byRun;
  readonly #byOrigin;
  readonly #ancestors;

  constructor(db: SqliteDatabase) {
    this.#insert = db.prepare<[ContinuationRow]>(
      `INSERT INTO run_continuations (run_id, origin_run_id, created_at)
       VALUES (@run_id, @origin_run_id, @created_at)`,
    );
    this.#byRun = db.prepare<[string], ContinuationRow>(
      'SELECT run_id, origin_run_id, created_at FROM run_continuations WHERE run_id = ?',
    );
    this.#byOrigin = db.prepare<[string], ContinuationRow>(
      'SELECT run_id, origin_run_id, created_at FROM run_continuations WHERE origin_run_id = ?',
    );
    // 사슬을 거슬러 올라간다 (원 실행은 실행마다 하나이고 넣을 때 막 만든 실행만 이어지므로 고리가 없다). 뿌리가 먼저
    this.#ancestors = db.prepare<[string], { run_id: string }>(
      `WITH RECURSIVE up (run_id, depth) AS (
         SELECT origin_run_id, 1 FROM run_continuations WHERE run_id = ?
         UNION ALL
         SELECT c.origin_run_id, up.depth + 1 FROM run_continuations AS c JOIN up ON c.run_id = up.run_id
       )
       SELECT run_id FROM up ORDER BY depth DESC`,
    );
  }

  /**
   * 이어받는 실행을 원 실행과 잇는다 (추가 전용, 실행마다 하나 · 원 실행마다 하나).
   * @throws {SqliteError} 원 실행이 예산 초과가 아님 · 유형 · 대상 규칙이 다름 · 사람이 막 시작한 실행이 아님 · 보강 연결이 있음(트리거),
   *   중복(UNIQUE)
   */
  link(input: RunContinuation): RunContinuation {
    const row = {
      run_id: input.runId,
      origin_run_id: input.originRunId,
      created_at: new Date(Date.parse(input.createdAt)).toISOString(),
    };
    this.#insert.run(row);
    return toContinuation(row);
  }

  /** 이 실행이 이어받은 원 실행의 연결. 이어받는 실행이 아니면 `null`. */
  originOf(runId: string): RunContinuation | null {
    const row = this.#byRun.get(runId);
    return row === undefined ? null : toContinuation(row);
  }

  /** 원 실행을 이어받은 실행의 연결. 없으면 `null`. */
  continuationOf(originRunId: string): RunContinuation | null {
    const row = this.#byOrigin.get(originRunId);
    return row === undefined ? null : toContinuation(row);
  }

  /** 이 실행이 이어받은 원 실행들의 ID (사슬의 뿌리부터 바로 앞 원 실행까지). 이어받는 실행이 아니면 빈 목록. */
  ancestorsOf(runId: string): string[] {
    return this.#ancestors.all(runId).map((row) => row.run_id);
  }
}
