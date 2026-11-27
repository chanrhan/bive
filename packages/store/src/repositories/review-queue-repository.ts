// 검토 대기열 리포지토리 (TODO-02 · COST-01 · JDG-04, M3-08 #53, ADR-145). 표 `review_items` · `review_reinforcements`(0028).
// 입력 · 출력은 `@bive/shared`의 `ReviewItem` · `ReviewResolution`으로 검증한다.
// - 항목을 넣는 메서드는 없다: 실행의 종료 상태가 저장되는 같은 문장에서 DB 트리거가 넣는다
// - 처리(`resolve`)는 열린 항목에 한 번만 쓴다(트리거가 한 번 더 막는다). 처리 결과(보강 연결 · 격리 판정 기록)는 같은 트랜잭션에서
//   먼저 써야 한다(트리거가 본다)
import {
  ReviewItem,
  type ReviewItemKind,
  type ReviewItemState,
  ReviewResolution,
} from '@bive/shared';

import type { SqliteDatabase } from '../database.js';
import { ConflictError } from '../errors.js';

const ENTITY = '검토 대기열 항목';

interface ItemRow {
  seq: number;
  kind: string;
  run_id: string;
  mutation_result_id: string | null;
  created_at: string;
  resolved_at: string | null;
  action: string | null;
  resolved_by: string | null;
  reason: string | null;
  detail: string | null;
}

const COLUMNS =
  'seq, kind, run_id, mutation_result_id, created_at, resolved_at, action, resolved_by, reason, detail';

/** 사람이 시작한 테스트 보강 실행과 그 원인 변이 기록 (항목마다 · 실행마다 하나). */
export interface ReviewReinforcement {
  readonly reviewSeq: number;
  readonly runId: string;
  readonly mutationResultId: string;
  readonly createdAt: string;
}

interface ReinforcementRow {
  review_seq: number;
  run_id: string;
  mutation_result_id: string;
  created_at: string;
}

const toItem = (row: ItemRow): ReviewItem =>
  ReviewItem.parse({
    seq: row.seq,
    kind: row.kind,
    runId: row.run_id,
    mutationResultId: row.mutation_result_id,
    createdAt: row.created_at,
    resolution:
      row.resolved_at === null
        ? null
        : {
            ...(JSON.parse(row.detail ?? '{}') as Record<string, unknown>),
            action: row.action,
            by: JSON.parse(row.resolved_by ?? 'null') as unknown,
            at: row.resolved_at,
            reason: row.reason,
          },
  });

/** 처리 결과 칸 (`action` · `by` · `at` · `reason` 밖의 칸 = 액션마다 다른 결과). */
const detailOf = (resolution: ReviewResolution): Record<string, unknown> =>
  resolution.action === 'quarantine'
    ? { judgmentId: resolution.judgmentId }
    : { runId: resolution.runId };

export class ReviewQueueRepository {
  readonly #all;
  readonly #bySeq;
  readonly #resolve;
  readonly #link;
  readonly #linkByRun;
  readonly #version;

  constructor(db: SqliteDatabase) {
    this.#all = db.prepare<[], ItemRow>(`SELECT ${COLUMNS} FROM review_items ORDER BY seq`);
    this.#bySeq = db.prepare<[number], ItemRow>(
      `SELECT ${COLUMNS} FROM review_items WHERE seq = ?`,
    );
    this.#resolve = db.prepare<
      [
        {
          seq: number;
          at: string;
          action: string;
          by: string;
          reason: string | null;
          detail: string;
        },
      ]
    >(
      `UPDATE review_items SET resolved_at = @at, action = @action, resolved_by = @by, reason = @reason,
       detail = @detail WHERE seq = @seq AND resolved_at IS NULL`,
    );
    this.#link = db.prepare<[ReinforcementRow]>(
      `INSERT INTO review_reinforcements (review_seq, run_id, mutation_result_id, created_at)
       VALUES (@review_seq, @run_id, @mutation_result_id, @created_at)`,
    );
    this.#linkByRun = db.prepare<[string], ReinforcementRow>(
      'SELECT review_seq, run_id, mutation_result_id, created_at FROM review_reinforcements WHERE run_id = ?',
    );
    this.#version = db.prepare<[], { total: number; resolved: number }>(
      `SELECT count(*) AS total, count(resolved_at) AS resolved FROM review_items`,
    );
  }

  /** 항목들 (등록 순). `kind` · `state`로 거른다. */
  list(filter: { kind?: ReviewItemKind; state?: ReviewItemState } = {}): ReviewItem[] {
    return this.#all
      .all()
      .map(toItem)
      .filter(
        (item) =>
          (filter.kind === undefined || item.kind === filter.kind) &&
          (filter.state === undefined || (filter.state === 'open') === (item.resolution === null)),
      );
  }

  /** 순번으로 읽는다. 없으면 `null`. */
  get(seq: number): ReviewItem | null {
    const row = this.#bySeq.get(seq);
    return row === undefined ? null : toItem(row);
  }

  /**
   * 열린 항목의 처리를 한 번 기록한다. 처리 결과(테스트 보강의 연결 · 판정 격리의 판정 기록)는 같은 트랜잭션에서 먼저 써야 한다.
   * @throws {ZodError} 처리 형식 위반
   * @throws {ConflictError} 없거나 이미 처리된 항목
   * @throws {SqliteError} 종류가 받지 않는 액션 · 처리 결과 없음 (CHECK · 트리거: 한도 상향 재개는 이어받는 실행의 연결, 0030)
   */
  resolve(seq: number, input: ReviewResolution): ReviewItem {
    const resolution = ReviewResolution.parse(input);
    const changed = this.#resolve.run({
      seq,
      at: new Date(Date.parse(resolution.at)).toISOString(),
      action: resolution.action,
      by: JSON.stringify(resolution.by),
      reason: resolution.reason,
      detail: JSON.stringify(detailOf(resolution)),
    });
    if (changed.changes !== 1) {
      throw new ConflictError(ENTITY, String(seq), '없거나 이미 처리된 항목입니다');
    }
    const saved = this.get(seq);
    if (saved === null) throw new ConflictError(ENTITY, String(seq), '처리 뒤 읽지 못했습니다');
    return saved;
  }

  /**
   * 사람이 시작한 테스트 보강 실행을 변이 생존 항목의 원인 변이 기록과 잇는다 (추가 전용, 항목마다 · 실행마다 하나).
   * @throws {SqliteError} 열린 변이 생존 항목이 아님 · 원인이 다름 · 실행이 사람이 시작한 그 규칙의 유형 C가 아님(트리거), 중복
   */
  linkReinforcement(input: ReviewReinforcement): ReviewReinforcement {
    this.#link.run({
      review_seq: input.reviewSeq,
      run_id: input.runId,
      mutation_result_id: input.mutationResultId,
      created_at: new Date(Date.parse(input.createdAt)).toISOString(),
    });
    return input;
  }

  /** 실행의 사람 보강 연결 (그 실행이 사람이 시작한 보강 실행이면). 없으면 `null`. */
  reinforcementOfRun(runId: string): ReviewReinforcement | null {
    const row = this.#linkByRun.get(runId);
    return row === undefined
      ? null
      : {
          reviewSeq: row.review_seq,
          runId: row.run_id,
          mutationResultId: row.mutation_result_id,
          createdAt: row.created_at,
        };
  }

  /**
   * 대기열의 변경 표지: 항목 수 + 처리된 수. 항목은 지워지지 않고 처리는 한 번이라, 항목이 생기거나 처리될 때마다 늘기만 한다
   * (알림이 사용 전후를 비교한다).
   */
  version(): number {
    const row = this.#version.get();
    return row === undefined ? 0 : row.total + row.resolved;
  }
}
