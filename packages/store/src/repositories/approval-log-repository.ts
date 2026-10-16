// 승인 기록 리포지토리 (NFR-01, ADR-027, ADR-050). 추가(`append`)와 읽기만 있다. 수정 · 삭제 함수는 두지 않고
// DB 트리거도 막는다. 순번 · 앞 해시 · 해시는 리포지토리가 같은 트랜잭션 안에서 정한다.
import { APPROVAL_LOG_GENESIS_HASH, ApprovalLogEntry, type EntityRef } from '@bive/shared';

import {
  computeApprovalLogHash,
  verifyApprovalLogChain,
  type ChainVerification,
} from '../approval-chain.js';
import { withTransaction, type SqliteDatabase } from '../database.js';

/** 새 기록. 순번 · 앞 해시 · 해시는 리포지토리가 채운다. */
export type ApprovalLogAppendInput = Omit<ApprovalLogEntry, 'seq' | 'prevHash' | 'hash'>;

interface ApprovalLogRow {
  seq: number;
  at: string;
  action: string;
  actor: string;
  target_ref: string;
  client_id: string | null;
  detail: string;
  prev_hash: string;
  hash: string;
}

const COLUMNS = 'seq, at, action, actor, target_ref, client_id, detail, prev_hash, hash';

/** JSON 열을 읽는다. 해석할 수 없으면 원문 문자열 그대로 둔다(체인 검증이 형식 위반으로 잡는다). */
const readJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

/** 행을 스키마 검증 없이 기록 모양으로 옮긴다 (체인 검증은 고쳐진 행도 읽어야 한다). */
const rawEntry = (row: ApprovalLogRow): ApprovalLogEntry =>
  ({
    seq: row.seq,
    at: row.at,
    action: row.action,
    actor: readJson(row.actor),
    targetRef: readJson(row.target_ref),
    clientId: row.client_id,
    detail: readJson(row.detail),
    prevHash: row.prev_hash,
    hash: row.hash,
  }) as ApprovalLogEntry;

/** 처리된 제안 가운데 상태에 맞는 승인 기록(승인 ↔ approve · approve_edited, 거절 ↔ reject)이 없는 첫 제안. */
const DECISION_WITHOUT_LOG = `
SELECT p.id FROM proposals p
WHERE p.state IN ('approved', 'rejected') AND NOT EXISTS (
  SELECT 1 FROM approval_log a
  WHERE json_extract(a.target_ref, '$.entity') = 'Proposal'
    AND json_extract(a.target_ref, '$.id') = p.id
    AND ((p.state = 'approved' AND a.action IN ('approve', 'approve_edited'))
      OR (p.state = 'rejected' AND a.action = 'reject'))
)
ORDER BY length(p.display_id), p.display_id
LIMIT 1`;

export class ApprovalLogRepository {
  readonly #db: SqliteDatabase;
  readonly #insert;
  readonly #last;
  readonly #selectAll;
  readonly #selectByTarget;
  readonly #decisionWithoutLog;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#insert = db.prepare<[ApprovalLogRow]>(
      `INSERT INTO approval_log (${COLUMNS}) VALUES (@seq, @at, @action, @actor, @target_ref,
       @client_id, @detail, @prev_hash, @hash)`,
    );
    this.#last = db.prepare<[], Pick<ApprovalLogRow, 'seq' | 'hash'>>(
      'SELECT seq, hash FROM approval_log ORDER BY seq DESC LIMIT 1',
    );
    this.#selectAll = db.prepare<[], ApprovalLogRow>(
      `SELECT ${COLUMNS} FROM approval_log ORDER BY seq`,
    );
    this.#selectByTarget = db.prepare<[{ entity: string; id: string }], ApprovalLogRow>(
      `SELECT ${COLUMNS} FROM approval_log
       WHERE json_extract(target_ref, '$.entity') = @entity AND json_extract(target_ref, '$.id') = @id
       ORDER BY seq`,
    );
    this.#decisionWithoutLog = db.prepare<[], { id: string }>(DECISION_WITHOUT_LOG);
  }

  /**
   * 기록 1건을 끝에 덧붙인다. 순번은 마지막 + 1, `prevHash`는 마지막 기록의 해시(없으면 0 64자).
   * 호출한 쪽의 트랜잭션 안에서 부르면 규범 반영 · 제안 처리와 함께 커밋되거나 함께 되돌려진다.
   * @throws {ZodError} 스키마 위반 (수정 후 승인에 diff 없음, 거절에 사유 없음, 주체가 사람 아님 등)
   */
  append(input: ApprovalLogAppendInput): ApprovalLogEntry {
    return withTransaction(this.#db, () => {
      const last = this.#last.get();
      const base = {
        seq: (last?.seq ?? 0) + 1,
        at: input.at,
        action: input.action,
        actor: input.actor,
        targetRef: input.targetRef,
        clientId: input.clientId,
        detail: input.detail,
        prevHash: last?.hash ?? APPROVAL_LOG_GENESIS_HASH,
      };
      // 해시 계산 전에 형식을 검증해, 검증된 값(정규화된 값)으로 해시를 만든다
      const checked = ApprovalLogEntry.parse({ ...base, hash: APPROVAL_LOG_GENESIS_HASH });
      const entry = ApprovalLogEntry.parse({ ...checked, hash: computeApprovalLogHash(checked) });
      this.#insert.run({
        seq: entry.seq,
        at: entry.at,
        action: entry.action,
        actor: JSON.stringify(entry.actor),
        target_ref: JSON.stringify(entry.targetRef),
        client_id: entry.clientId,
        detail: JSON.stringify(entry.detail),
        prev_hash: entry.prevHash,
        hash: entry.hash,
      });
      return entry;
    });
  }

  /**
   * 순번 순으로 돌려준다. `targetRef`를 주면 그 대상의 기록만.
   * 형식이 깨진 행(저장소 밖에서 고친 행)은 빼고 돌려준다. 그런 행은 `verify()`가 잡는다.
   */
  list(targetRef?: EntityRef): ApprovalLogEntry[] {
    const rows =
      targetRef === undefined ? this.#selectAll.all() : this.#selectByTarget.all(targetRef);
    return rows.flatMap((row) => {
      const parsed = ApprovalLogEntry.safeParse(rawEntry(row));
      return parsed.success ? [parsed.data] : [];
    });
  }

  /**
   * 승인 기록을 검증한다: 전체 기록의 해시 체인 · 형식(`verifyApprovalLogChain`), 그다음 처리된 제안마다
   * 상태에 맞는 승인 기록이 있는지. 저장된 행을 스키마 검증 없이 그대로 해시한다.
   */
  verify(): ChainVerification {
    const chain = verifyApprovalLogChain(this.#selectAll.all().map(rawEntry));
    if (!chain.valid) return chain;
    const orphan = this.#decisionWithoutLog.get();
    if (orphan !== undefined) {
      return {
        valid: false,
        brokenAtSeq: null,
        reason: 'decision_without_log',
        proposalId: orphan.id,
      };
    }
    return chain;
  }
}
