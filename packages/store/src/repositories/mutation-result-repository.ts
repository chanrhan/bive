// 변이 판정 기록 리포지토리 (JDG-04, M3-07 #52, ADR-139). 테이블 `mutation_results`(0026). 입력 · 출력은 `@bive/shared`의
// `MutationResult`로 검증한다.
// - 추가(`record`)와 읽기만 있다. 수정 · 삭제 · 덮어쓰기는 DB 트리거가 막는다
// - 규칙의 변이 상태 = 그 규칙의 가장 최근 기록(기록 시각 → ID 순)의 상태. 기록이 없는 규칙은 '변이 미검증'이다(`statusOf`)
// - 변이(`mutant`)는 에이전트가 쓴 글 원문이다. 화면 · 세션 입력에 실을 때는 부르는 쪽이 표시 값으로 바꾼다
import { MutationReinforcement, MutationResult, type MutationStatus } from '@bive/shared';

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

interface ReinforcementRow {
  seq: number;
  run_id: string;
  mutation_result_id: string;
  created_at: string;
}

const REINFORCEMENT_COLUMNS = 'seq, run_id, mutation_result_id, created_at';

const toReinforcement = (row: ReinforcementRow): MutationReinforcement =>
  MutationReinforcement.parse({
    seq: row.seq,
    runId: row.run_id,
    mutationResultId: row.mutation_result_id,
    createdAt: row.created_at,
  });

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
  readonly #byId;
  readonly #nextSeq;
  readonly #link;
  readonly #linkBySeq;
  readonly #linkByRun;
  readonly #linkByResult;

  constructor(db: SqliteDatabase) {
    this.#byId = db.prepare<[string], MutationRow>(
      `SELECT ${COLUMNS} FROM mutation_results WHERE id = ?`,
    );
    this.#nextSeq = db.prepare<[], { next: number }>(
      'SELECT coalesce(max(seq), 0) + 1 AS next FROM mutation_reinforcements',
    );
    this.#link = db.prepare<[ReinforcementRow]>(
      `INSERT INTO mutation_reinforcements (${REINFORCEMENT_COLUMNS})
       VALUES (@seq, @run_id, @mutation_result_id, @created_at)`,
    );
    const select = `SELECT ${REINFORCEMENT_COLUMNS} FROM mutation_reinforcements`;
    this.#linkBySeq = db.prepare<[number], ReinforcementRow>(`${select} WHERE seq = ?`);
    this.#linkByRun = db.prepare<[string], ReinforcementRow>(`${select} WHERE run_id = ?`);
    this.#linkByResult = db.prepare<[string], ReinforcementRow>(
      `${select} WHERE mutation_result_id = ?`,
    );
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

  /** ID로 읽는다. 없으면 `null`. */
  get(id: string): MutationResult | null {
    const row = this.#byId.get(id);
    return row === undefined ? null : toResult(row);
  }

  // ── 변이 보강 연결 (0027, M3-54 #311, ADR-143) ──

  /** 다음 연결 순번 (쓰기 트랜잭션 안에서 부르고 같은 트랜잭션에서 `linkReinforcement`로 쓴다). */
  nextReinforcementSeq(): number {
    return this.#nextSeq.get()?.next ?? 1;
  }

  /**
   * 보강 실행과 원인 변이 기록을 잇는다 (추가 전용). 실행 · 변이 기록마다 하나.
   * @throws {ZodError} 형식 위반
   * @throws {SqliteError} 같은 실행 · 변이 기록 · 순번의 연결이 이미 있음(UNIQUE), 원인이 유형 A의 생존 기록이 아님 · 실행이 그 규칙의
   *   유형 C가 아님(트리거), 없는 실행 · 기록(외래 키)
   */
  linkReinforcement(input: MutationReinforcement): MutationReinforcement {
    const link = MutationReinforcement.parse(input);
    this.#link.run({
      seq: link.seq,
      run_id: link.runId,
      mutation_result_id: link.mutationResultId,
      created_at: link.createdAt,
    });
    return link;
  }

  reinforcementBySeq(seq: number): MutationReinforcement | null {
    const row = this.#linkBySeq.get(seq);
    return row === undefined ? null : toReinforcement(row);
  }

  /** 실행의 보강 연결 (그 실행이 보강 실행이면). 없으면 `null`. */
  reinforcementOfRun(runId: string): MutationReinforcement | null {
    const row = this.#linkByRun.get(runId);
    return row === undefined ? null : toReinforcement(row);
  }

  /** 변이 기록을 원인으로 한 보강 연결. 없으면 `null`. */
  reinforcementOfResult(mutationResultId: string): MutationReinforcement | null {
    const row = this.#linkByResult.get(mutationResultId);
    return row === undefined ? null : toReinforcement(row);
  }

  /** 실행의 변이 기록 (기록 시각 순). */
  listByRun(runId: string): MutationResult[] {
    return this.#byRun.all(runId).map(toResult);
  }
}
