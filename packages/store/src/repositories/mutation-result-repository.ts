// 변이 판정 기록 리포지토리 (JDG-04, M3-07 #52, ADR-139). 테이블 `mutation_results`(0026). 입력 · 출력은 `@bive/shared`의
// `MutationResult`로 검증한다.
// - 추가(`record`)와 읽기만 있다. 수정 · 삭제 · 덮어쓰기는 DB 트리거가 막는다
// - 규칙의 변이 상태 = 그 규칙의 가장 최근 기록(기록 시각 → ID 순)의 상태. 기록이 없는 규칙은 '변이 미검증'이다(`statusOf`)
// - 변이(`mutant`)는 에이전트가 쓴 글 원문이다. 화면 · 세션 입력에 실을 때는 부르는 쪽이 표시 값으로 바꾼다
import { MutationResult, type MutationStatus } from '@bive/shared';

import type { SqliteDatabase } from '../database.js';
import { ConflictError, isUniqueViolation } from '../errors.js';

const ENTITY = '변이 기록';

interface MutationRow {
  id: string;
  rule_id: string;
  run_id: string;
  step_id: string;
  session_id: string | null;
  commit_sha: string;
  status: string;
  outcome: string;
  mutant: string | null;
  recorded_at: string;
}

const COLUMNS =
  'id, rule_id, run_id, step_id, session_id, commit_sha, status, outcome, mutant, recorded_at';

/** 최신 순서: 기록 시각 → ID (밀리초 3자리 UTC 문자열 · ULID라 사전순 = 시간순). */
const LATEST_FIRST = 'ORDER BY recorded_at DESC, id DESC';

const toRow = (result: MutationResult): MutationRow => ({
  id: result.id,
  rule_id: result.ruleId,
  run_id: result.runId,
  step_id: result.stepId,
  session_id: result.sessionId,
  commit_sha: result.commit,
  status: result.status,
  outcome: result.outcome,
  mutant: result.mutant === null ? null : JSON.stringify(result.mutant),
  recorded_at: result.recordedAt,
});

const toResult = (row: MutationRow): MutationResult =>
  MutationResult.parse({
    id: row.id,
    ruleId: row.rule_id,
    runId: row.run_id,
    stepId: row.step_id,
    sessionId: row.session_id,
    commit: row.commit_sha,
    status: row.status,
    outcome: row.outcome,
    mutant: row.mutant === null ? null : (JSON.parse(row.mutant) as unknown),
    recordedAt: row.recorded_at,
  });

export class MutationResultRepository {
  readonly #insert;
  readonly #latest;
  readonly #byRun;

  constructor(db: SqliteDatabase) {
    this.#insert = db.prepare<[MutationRow]>(
      `INSERT INTO mutation_results (${COLUMNS}) VALUES (@id, @rule_id, @run_id, @step_id, @session_id,
       @commit_sha, @status, @outcome, @mutant, @recorded_at)`,
    );
    this.#latest = db.prepare<[string], MutationRow>(
      `SELECT ${COLUMNS} FROM mutation_results WHERE rule_id = ? ${LATEST_FIRST} LIMIT 1`,
    );
    this.#byRun = db.prepare<[string], MutationRow>(
      `SELECT ${COLUMNS} FROM mutation_results WHERE run_id = ? ORDER BY recorded_at, id`,
    );
  }

  /**
   * 변이 기록 1건을 남긴다. 기록 시각은 밀리초 3자리 UTC로 맞춘다(문자열 비교 = 시간 순서).
   * @throws {ZodError} 형식 위반 (상태가 판정 결과와 맞지 않음 등)
   * @throws {ConflictError} 같은 ID가 이미 있을 때
   * @throws {SqliteError} 없는 규칙 · 실행 · 단계를 가리킬 때 (외래 키)
   */
  record(input: MutationResult): MutationResult {
    const parsed = MutationResult.parse(input);
    const result = { ...parsed, recordedAt: new Date(Date.parse(parsed.recordedAt)).toISOString() };
    try {
      this.#insert.run(toRow(result));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(ENTITY, result.id, '이미 있습니다', { cause: error });
      }
      throw error;
    }
    return result;
  }

  /** 규칙의 가장 최근 기록. 없으면 `null`. */
  latestByRule(ruleId: string): MutationResult | null {
    const row = this.#latest.get(ruleId);
    return row === undefined ? null : toResult(row);
  }

  /** 규칙의 변이 상태: 가장 최근 기록의 상태, 기록이 없으면 '변이 미검증'. */
  statusOf(ruleId: string): MutationStatus {
    return this.latestByRule(ruleId)?.status ?? 'unverified';
  }

  /** 실행의 변이 기록 (기록 시각 순). */
  listByRun(runId: string): MutationResult[] {
    return this.#byRun.all(runId).map(toResult);
  }
}
