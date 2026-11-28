// 이어받는 실행의 쓰기 허용 범위 리포지토리 (TODO-02 · NFR-01 · NFR-02, M3-58 #321, ADR-147 ⑥, ADR-155). 표 `run_write_scopes`(0032).
// - 붙이기(`record`)는 추가만 한다. 넣을 때의 조건(막 만든 이어받는 실행 · 1개 이상의 허용 · 제외 경로 · 원 실행의 범위를 넓히지 않음)과
//   수정 · 삭제 거부는 DB 트리거가 본다. 쓰는 곳은 오케스트레이터의 검토 대기열 모듈 하나다(구조 시험)
// - 읽기(`ofRun`): 그 실행에 붙은 범위. 행이 shared 스키마에 맞지 않으면 던진다(건너뛰지 않는다: 범위를 잃으면 넓어진다)
import { RunWriteScope } from '@bive/shared';

import type { SqliteDatabase } from '../database.js';

/** 실행 하나에 붙은 쓰기 허용 범위 기록. */
export interface RunWriteScopeRecord {
  readonly runId: string;
  readonly scope: RunWriteScope;
  readonly createdAt: string;
}

interface ScopeRow {
  run_id: string;
  allow_patterns: string;
  exclude_patterns: string;
  created_at: string;
}

export class RunWriteScopeRepository {
  readonly #insert;
  readonly #byRun;

  constructor(db: SqliteDatabase) {
    this.#insert = db.prepare<[ScopeRow]>(
      `INSERT INTO run_write_scopes (run_id, allow_patterns, exclude_patterns, created_at)
       VALUES (@run_id, @allow_patterns, @exclude_patterns, @created_at)`,
    );
    this.#byRun = db.prepare<[string], ScopeRow>(
      'SELECT run_id, allow_patterns, exclude_patterns, created_at FROM run_write_scopes WHERE run_id = ?',
    );
  }

  /**
   * 이어받는 실행에 쓰기 허용 범위를 붙인다 (추가 전용, 실행마다 하나).
   * @throws {ZodError} 범위가 스키마에 맞지 않음
   * @throws {SqliteError} 막 만든 이어받는 실행이 아님 · 원 실행의 범위를 넓힘(트리거), 중복(기본 키)
   */
  record(input: RunWriteScopeRecord): RunWriteScopeRecord {
    const scope = RunWriteScope.parse(input.scope);
    const row: ScopeRow = {
      run_id: input.runId,
      allow_patterns: JSON.stringify(scope.allow),
      exclude_patterns: JSON.stringify(scope.exclude),
      created_at: new Date(Date.parse(input.createdAt)).toISOString(),
    };
    this.#insert.run(row);
    return { runId: row.run_id, scope, createdAt: row.created_at };
  }

  /**
   * 그 실행에 붙은 쓰기 허용 범위. 없으면 `null`.
   * @throws {ZodError} 저장된 행이 스키마에 맞지 않음
   */
  ofRun(runId: string): RunWriteScope | null {
    const row = this.#byRun.get(runId);
    if (row === undefined) return null;
    return RunWriteScope.parse({
      allow: JSON.parse(row.allow_patterns) as unknown,
      exclude: JSON.parse(row.exclude_patterns) as unknown,
    });
  }
}
