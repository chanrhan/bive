// 표시 ID 순번 (ADR-025, ADR-047). 프로젝트별 DB의 `display_id_sequences`에 접두별 마지막 순번을 둔다.
// 순번은 1부터 증가하고, 행이 지워지거나 트랜잭션이 되돌려져도 커밋된 번호를 다시 내주지 않는다.
import { DisplayIdPrefix, formatDisplayId } from '@bive/shared';

import type { SqliteDatabase } from '../database.js';

export class DisplayIdSequences {
  readonly #next;
  readonly #peek;

  constructor(db: SqliteDatabase) {
    this.#next = db.prepare<[string], { last_seq: number }>(
      `INSERT INTO display_id_sequences (prefix, last_seq) VALUES (?, 1)
       ON CONFLICT (prefix) DO UPDATE SET last_seq = last_seq + 1
       RETURNING last_seq`,
    );
    this.#peek = db.prepare<[string], { last_seq: number }>(
      'SELECT last_seq FROM display_id_sequences WHERE prefix = ?',
    );
  }

  /**
   * 접두의 다음 순번을 받는다. 호출한 쪽의 트랜잭션 안에서 부르면 그 트랜잭션이 되돌려질 때 함께 되돌려진다.
   * @throws {ZodError} 정의되지 않은 접두
   */
  next(prefix: DisplayIdPrefix): number {
    const row = this.#next.get(DisplayIdPrefix.parse(prefix));
    if (row === undefined) throw new Error('순번을 받지 못했습니다');
    return row.last_seq;
  }

  /** 다음 표시 ID(`REQ-001` 등)를 받는다. */
  nextDisplayId(prefix: DisplayIdPrefix): string {
    return formatDisplayId(prefix, this.next(prefix));
  }

  /** 마지막으로 내준 순번. 아직 없으면 0. */
  last(prefix: DisplayIdPrefix): number {
    return this.#peek.get(DisplayIdPrefix.parse(prefix))?.last_seq ?? 0;
  }
}
