// 규칙 판정 기록 리포지토리 (JDG-01 · JDG-02, ADR-060 · ADR-069). 입력 · 출력은 `@bive/shared`의 `JudgmentResult`로 검증한다.
// - 판정 기록은 추가만 한다(`record`). 같은 판정 1회가 다룬 규칙들은 트랜잭션 1회로 함께 남긴다
// - 규칙의 최신 판정 = 판정 시각이 가장 늦은 기록(같으면 ID가 큰 기록, ULID라 나중에 만든 것). 규칙 화면(SCR-03) ·
//   준수 지표(#31) · 규칙 상세(#41)가 이 기준을 함께 쓴다 (`latestByRule` · `latestForRules`)
// - 판정 기록은 실행 상태(`runs.transition`)와 별개인 기록이다: 판정 러너가 결과를 낸 즉시 남긴다(세션 기록과 같은 이유)
import { JudgmentResult } from '@bive/shared';

import { withTransaction, type SqliteDatabase } from '../database.js';
import { ConflictError, isUniqueViolation } from '../errors.js';

const ENTITY = '판정 기록';

interface JudgmentRow {
  id: string;
  rule_id: string;
  run_id: string | null;
  step_id: string | null;
  commit_sha: string;
  judged_at: string;
  status: string;
  runner: string;
  exit_code: number | null;
  reporter_path: string | null;
  cases: string;
  quarantine_reason: string | null;
}

const COLUMNS = `id, rule_id, run_id, step_id, commit_sha, judged_at, status, runner, exit_code,
  reporter_path, cases, quarantine_reason`;

/** 최신 판정 순서: 판정 시각 → ID (둘 다 사전순 = 시간순). */
const LATEST_FIRST = 'ORDER BY judged_at DESC, id DESC';

const toRow = (result: JudgmentResult): JudgmentRow => ({
  id: result.id,
  rule_id: result.ruleId,
  run_id: result.runId,
  step_id: result.stepId,
  commit_sha: result.commit,
  judged_at: result.judgedAt,
  status: result.status,
  runner: result.runner,
  exit_code: result.exitCode,
  reporter_path: result.reporterPath,
  cases: JSON.stringify(result.cases),
  quarantine_reason: result.quarantineReason,
});

const toJudgment = (row: JudgmentRow): JudgmentResult =>
  JudgmentResult.parse({
    id: row.id,
    ruleId: row.rule_id,
    runId: row.run_id,
    stepId: row.step_id,
    commit: row.commit_sha,
    judgedAt: row.judged_at,
    status: row.status,
    runner: row.runner,
    exitCode: row.exit_code,
    reporterPath: row.reporter_path,
    cases: JSON.parse(row.cases) as unknown,
    quarantineReason: row.quarantine_reason,
  });

export class JudgmentRepository {
  readonly #db: SqliteDatabase;
  readonly #insert;
  readonly #exists;
  readonly #latest;
  readonly #latestAll;
  readonly #byRun;
  readonly #byRule;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#insert = db.prepare<[JudgmentRow]>(
      `INSERT INTO judgments (${COLUMNS}) VALUES (@id, @rule_id, @run_id, @step_id, @commit_sha,
       @judged_at, @status, @runner, @exit_code, @reporter_path, @cases, @quarantine_reason)`,
    );
    this.#exists = db.prepare<[string], { id: string }>('SELECT id FROM judgments WHERE id = ?');
    this.#latest = db.prepare<[string], JudgmentRow>(
      `SELECT ${COLUMNS} FROM judgments WHERE rule_id = ? ${LATEST_FIRST} LIMIT 1`,
    );
    // 규칙마다 최신 1건: 같은 규칙에서 더 늦은 기록이 없는 행
    this.#latestAll = db.prepare<[], JudgmentRow>(
      `SELECT ${COLUMNS} FROM judgments AS j WHERE NOT EXISTS (
         SELECT 1 FROM judgments AS later WHERE later.rule_id = j.rule_id
           AND (later.judged_at > j.judged_at OR (later.judged_at = j.judged_at AND later.id > j.id))
       ) ORDER BY rule_id`,
    );
    this.#byRun = db.prepare<[string], JudgmentRow>(
      `SELECT ${COLUMNS} FROM judgments WHERE run_id = ? ORDER BY judged_at, id`,
    );
    this.#byRule = db.prepare<[string, number], JudgmentRow>(
      `SELECT ${COLUMNS} FROM judgments WHERE rule_id = ? ${LATEST_FIRST} LIMIT ?`,
    );
  }

  /**
   * 판정 기록을 추가한다 (트랜잭션 1회). 형식은 `JudgmentResult` 스키마로 검증한다.
   * @throws {ZodError} 형식 위반 (격리 사유 규칙 등)
   * @throws {ConflictError} 같은 ID가 이미 있을 때
   * @throws {SqliteError} 없는 규칙 · 실행 · 단계를 가리킬 때 (외래 키)
   */
  record(results: readonly JudgmentResult[]): JudgmentResult[] {
    const parsed = results.map((result) => JudgmentResult.parse(result));
    return withTransaction(this.#db, () => {
      for (const result of parsed) {
        if (this.#exists.get(result.id) !== undefined) {
          throw new ConflictError(ENTITY, result.id, '이미 있습니다');
        }
        try {
          this.#insert.run(toRow(result));
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ConflictError(ENTITY, result.id, '이미 있습니다', { cause: error });
          }
          throw error;
        }
      }
      return parsed;
    });
  }

  /** 규칙의 최신 판정 기록. 없으면 `null`. */
  latestByRule(ruleId: string): JudgmentResult | null {
    const row = this.#latest.get(ruleId);
    return row === undefined ? null : toJudgment(row);
  }

  /** 규칙 ID → 최신 판정 기록 (판정 기록이 있는 규칙만). 목록 화면 · 준수 지표가 한 번에 읽는다. */
  latestForRules(): Map<string, JudgmentResult> {
    return new Map(this.#latestAll.all().map((row) => [row.rule_id, toJudgment(row)]));
  }

  /** 실행의 판정 기록 (판정 시각 순). */
  listByRun(runId: string): JudgmentResult[] {
    return this.#byRun.all(runId).map(toJudgment);
  }

  /** 규칙의 판정 이력 (최신부터, 기본 50건). */
  listByRule(ruleId: string, limit = 50): JudgmentResult[] {
    return this.#byRule.all(ruleId, Math.max(1, Math.trunc(limit))).map(toJudgment);
  }
}
