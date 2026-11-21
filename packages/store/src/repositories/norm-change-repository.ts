// 규범 변경 기록 리포지토리 (NRM-07, NFR-01, ADR-100 C2 · A2, M7-02 #214, ADR-103). 테이블 `norm_changes`(0013).
// - 에이전트 · 오케스트레이터 행동 1건마다 1항목. 사람 행동은 승인 기록(`ApprovalLogRepository`)에 남고 여기에는 오지 않는다
//   (주체 스키마 · DB CHECK가 모두 사람을 거부한다)
// - 추가(`append`)와 읽기만 있다. 수정 · 삭제 함수는 두지 않고 DB 트리거도 막는다. 순번 · 앞 해시 · 해시는 리포지토리가
//   같은 트랜잭션 안에서 정한다. 호출한 쪽의 트랜잭션 안에서 부르면 규범 변경과 함께 커밋되거나 함께 되돌려진다
import { type EntityRef, NORM_CHANGE_GENESIS_HASH, NormChangeEntry } from '@bive/shared';

import type { HashChainVerification } from '../approval-chain.js';
import { withTransaction, type SqliteDatabase } from '../database.js';
import { computeNormChangeHash, verifyNormChangeChain } from '../norm-change-chain.js';

/** 새 기록. 순번 · 앞 해시 · 해시는 리포지토리가 채운다. */
export type NormChangeAppendInput = Omit<NormChangeEntry, 'seq' | 'prevHash' | 'hash'>;

interface NormChangeRow {
  seq: number;
  at: string;
  kind: string;
  actor: string;
  target_ref: string;
  session_id: string | null;
  run_id: string | null;
  reason: string | null;
  detail: string;
  prev_hash: string;
  hash: string;
}

const COLUMNS =
  'seq, at, kind, actor, target_ref, session_id, run_id, reason, detail, prev_hash, hash';

/** JSON 열을 읽는다. 해석할 수 없으면 원문 문자열 그대로 둔다(체인 검증이 형식 위반으로 잡는다). */
const readJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

/** 행을 스키마 검증 없이 기록 모양으로 옮긴다 (체인 검증은 고쳐진 행도 읽어야 한다). */
const rawEntry = (row: NormChangeRow): NormChangeEntry =>
  ({
    seq: row.seq,
    at: row.at,
    kind: row.kind,
    actor: readJson(row.actor),
    targetRef: readJson(row.target_ref),
    sessionId: row.session_id,
    runId: row.run_id,
    reason: row.reason,
    detail: readJson(row.detail),
    prevHash: row.prev_hash,
    hash: row.hash,
  }) as NormChangeEntry;

export class NormChangeRepository {
  readonly #db: SqliteDatabase;
  readonly #insert;
  readonly #last;
  readonly #selectAll;
  readonly #selectByTarget;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#insert = db.prepare<[NormChangeRow]>(
      `INSERT INTO norm_changes (${COLUMNS}) VALUES (@seq, @at, @kind, @actor, @target_ref,
       @session_id, @run_id, @reason, @detail, @prev_hash, @hash)`,
    );
    this.#last = db.prepare<[], Pick<NormChangeRow, 'seq' | 'hash'>>(
      'SELECT seq, hash FROM norm_changes ORDER BY seq DESC LIMIT 1',
    );
    this.#selectAll = db.prepare<[], NormChangeRow>(
      `SELECT ${COLUMNS} FROM norm_changes ORDER BY seq`,
    );
    this.#selectByTarget = db.prepare<[{ entity: string; id: string }], NormChangeRow>(
      `SELECT ${COLUMNS} FROM norm_changes
       WHERE json_extract(target_ref, '$.entity') = @entity AND json_extract(target_ref, '$.id') = @id
       ORDER BY seq`,
    );
  }

  /**
   * 기록 1건을 끝에 덧붙인다. 순번은 마지막 + 1, `prevHash`는 마지막 기록의 해시(없으면 0 64자).
   * @throws {ZodError} 스키마 위반 (주체가 사람, 에이전트 주체에 세션 ID · 사유 없음, 신규에 내용 없음 등)
   */
  append(input: NormChangeAppendInput): NormChangeEntry {
    return withTransaction(this.#db, () => {
      const last = this.#last.get();
      const base = {
        seq: (last?.seq ?? 0) + 1,
        at: input.at,
        kind: input.kind,
        actor: input.actor,
        targetRef: input.targetRef,
        sessionId: input.sessionId,
        runId: input.runId,
        reason: input.reason,
        detail: input.detail,
        prevHash: last?.hash ?? NORM_CHANGE_GENESIS_HASH,
      };
      // 해시 계산 전에 형식을 검증해, 검증된 값(정규화된 값)으로 해시를 만든다
      const checked = NormChangeEntry.parse({ ...base, hash: NORM_CHANGE_GENESIS_HASH });
      const entry = NormChangeEntry.parse({ ...checked, hash: computeNormChangeHash(checked) });
      this.#insert.run({
        seq: entry.seq,
        at: entry.at,
        kind: entry.kind,
        actor: JSON.stringify(entry.actor),
        target_ref: JSON.stringify(entry.targetRef),
        session_id: entry.sessionId,
        run_id: entry.runId,
        reason: entry.reason,
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
  list(targetRef?: EntityRef): NormChangeEntry[] {
    const rows =
      targetRef === undefined ? this.#selectAll.all() : this.#selectByTarget.all(targetRef);
    return rows.flatMap((row) => {
      const parsed = NormChangeEntry.safeParse(rawEntry(row));
      return parsed.success ? [parsed.data] : [];
    });
  }

  /** 전체 기록의 해시 체인 · 형식을 검증한다. 저장된 행을 스키마 검증 없이 그대로 해시한다. */
  verify(): HashChainVerification {
    return verifyNormChangeChain(this.#selectAll.all().map(rawEntry));
  }
}
