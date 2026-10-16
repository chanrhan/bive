// 제안 리포지토리 (NRM-04, TODO-01, ADR-050). 입력 · 출력은 `@bive/shared`의 `Proposal` 스키마로 검증한다.
// - 제안은 항상 `pending`으로 들어오고(에이전트는 승인 상태를 정할 수 없다, NFR-01), 처리는 `decide`로 한 번만 한다
// - 본문은 등록 뒤 바뀌지 않는다. 수정 후 승인의 수정 본문은 처리 기록(`decision.editedPayload`)에 남는다
// - 지우는 함수는 없다. 처리된 제안도 기록으로 남는다 (DB 트리거가 수정 · 삭제를 한 번 더 막는다)
import {
  ProposalDecision,
  Proposal,
  Timestamp,
  type ProposalKind,
  type ProposalState,
} from '@bive/shared';

import { withTransaction, type SqliteDatabase } from '../database.js';
import { ConflictError, NotFoundError, isUniqueViolation } from '../errors.js';
import { DisplayIdSequences } from './display-id-sequences.js';

/** 새 제안. 표시 ID · 상태(`pending`) · 처리 기록 · 읽은 시각은 리포지토리가 채운다. */
export type ProposalCreateInput = Pick<
  Proposal,
  | 'id'
  | 'kind'
  | 'targetRef'
  | 'payload'
  | 'diff'
  | 'rationale'
  | 'author'
  | 'source'
  | 'risk'
  | 'adrId'
  | 'runId'
  | 'createdAt'
>;

/** 처리 결과: 승인 또는 거절. 잠정 승인은 정책이 정해질 때까지 쓰지 않는다 (ADR-012). */
export interface ProposalDecisionInput {
  readonly state: Extract<ProposalState, 'approved' | 'rejected'>;
  readonly decision: ProposalDecision;
}

export interface ProposalListFilter {
  readonly state?: ProposalState;
  readonly kind?: ProposalKind;
}

const ENTITY = '제안';

interface ProposalRow {
  id: string;
  display_id: string;
  kind: string;
  target_ref: string | null;
  payload: string;
  diff: string;
  rationale: string;
  author: string;
  source: string;
  risk: string | null;
  read_at: string | null;
  state: string;
  decision: string | null;
  adr_id: string | null;
  run_id: string | null;
  created_at: string;
}

const COLUMNS = `id, display_id, kind, target_ref, payload, diff, rationale, author, source, risk,
  read_at, state, decision, adr_id, run_id, created_at`;

const parseJson = (text: string | null): unknown => (text === null ? null : JSON.parse(text));

const toProposal = (row: ProposalRow): Proposal =>
  Proposal.parse({
    id: row.id,
    displayId: row.display_id,
    kind: row.kind,
    targetRef: parseJson(row.target_ref),
    payload: parseJson(row.payload),
    diff: parseJson(row.diff),
    rationale: row.rationale,
    author: parseJson(row.author),
    source: row.source,
    risk: row.risk,
    readAt: row.read_at,
    state: row.state,
    decision: parseJson(row.decision),
    adrId: row.adr_id,
    runId: row.run_id,
    createdAt: row.created_at,
  });

/** JSON 열 값. `undefined`(본문 없음)는 `null`로 저장해 JSON으로 유효하게 한다. */
const json = (value: unknown): string => JSON.stringify(value ?? null);

const toRow = (proposal: Proposal): ProposalRow => ({
  id: proposal.id,
  display_id: proposal.displayId,
  kind: proposal.kind,
  target_ref: proposal.targetRef === null ? null : json(proposal.targetRef),
  payload: json(proposal.payload),
  diff: json(proposal.diff),
  rationale: proposal.rationale,
  author: json(proposal.author),
  source: proposal.source,
  risk: proposal.risk,
  read_at: proposal.readAt,
  state: proposal.state,
  decision: proposal.decision === null ? null : json(proposal.decision),
  adr_id: proposal.adrId,
  run_id: proposal.runId,
  created_at: proposal.createdAt,
});

const ORDER = 'ORDER BY length(display_id), display_id';

export class ProposalRepository {
  readonly #db: SqliteDatabase;
  readonly #sequences: DisplayIdSequences;
  readonly #insert;
  readonly #select;
  readonly #selectAll;
  readonly #countPending;
  readonly #decide;
  readonly #markRead;

  constructor(db: SqliteDatabase, sequences: DisplayIdSequences = new DisplayIdSequences(db)) {
    this.#db = db;
    this.#sequences = sequences;
    this.#insert = db.prepare<[ProposalRow]>(
      `INSERT INTO proposals (${COLUMNS}) VALUES (@id, @display_id, @kind, @target_ref, @payload,
       @diff, @rationale, @author, @source, @risk, @read_at, @state, @decision, @adr_id, @run_id,
       @created_at)`,
    );
    this.#select = db.prepare<[string], ProposalRow>(
      `SELECT ${COLUMNS} FROM proposals WHERE id = ?`,
    );
    this.#selectAll = db.prepare<[{ state: string | null; kind: string | null }], ProposalRow>(
      `SELECT ${COLUMNS} FROM proposals
       WHERE (@state IS NULL OR state = @state) AND (@kind IS NULL OR kind = @kind) ${ORDER}`,
    );
    this.#countPending = db.prepare<[], { kind: string; n: number }>(
      "SELECT kind, count(*) AS n FROM proposals WHERE state = 'pending' GROUP BY kind",
    );
    this.#decide = db.prepare<[{ id: string; state: string; decision: string }]>(
      "UPDATE proposals SET state = @state, decision = @decision WHERE id = @id AND state = 'pending'",
    );
    this.#markRead = db.prepare<[{ id: string; at: string }]>(
      'UPDATE proposals SET read_at = @at WHERE id = @id AND read_at IS NULL',
    );
  }

  /**
   * 제안을 승인 대기(`pending`)로 저장하고 표시 ID(`PRP-NNN`)를 붙인다.
   * @throws {ZodError} 스키마 위반 (작성자가 에이전트가 아님 등)
   * @throws {ConflictError} 같은 ID가 이미 있을 때 (순번은 소비하지 않는다)
   */
  create(input: ProposalCreateInput): Proposal {
    const fields = {
      id: input.id,
      kind: input.kind,
      targetRef: input.targetRef,
      payload: input.payload,
      diff: input.diff,
      rationale: input.rationale,
      author: input.author,
      source: input.source,
      risk: input.risk,
      readAt: null,
      state: 'pending',
      decision: null,
      adrId: input.adrId,
      runId: input.runId,
      createdAt: input.createdAt,
    };
    // 순번을 쓰기 전에 형식부터 검증한다
    Proposal.parse({ ...fields, displayId: 'PRP-001' });
    return withTransaction(this.#db, () => {
      const proposal = Proposal.parse({
        ...fields,
        displayId: this.#sequences.nextDisplayId('PRP'),
      });
      try {
        this.#insert.run(toRow(proposal));
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(ENTITY, input.id, '이미 있습니다', { cause: error });
        }
        throw error;
      }
      return proposal;
    });
  }

  /** ID로 찾는다. 없으면 `null`. */
  get(id: string): Proposal | null {
    const row = this.#select.get(id);
    return row === undefined ? null : toProposal(row);
  }

  /** 표시 ID 순(= 등록 순)으로 돌려준다. 상태 · 종류로 거를 수 있다. */
  list(filter: ProposalListFilter = {}): Proposal[] {
    return this.#selectAll
      .all({ state: filter.state ?? null, kind: filter.kind ?? null })
      .map(toProposal);
  }

  /** 승인 대기 건수: 전체와 종류별(대기 건이 있는 종류만). */
  countPending(): { total: number; byKind: Partial<Record<ProposalKind, number>> } {
    const byKind: Partial<Record<ProposalKind, number>> = {};
    let total = 0;
    for (const { kind, n } of this.#countPending.all()) {
      byKind[kind as ProposalKind] = n;
      total += n;
    }
    return { total, byKind };
  }

  /**
   * 대기 중인 제안을 승인 또는 거절로 처리한다. 한 번만 할 수 있다.
   * @throws {ZodError} 처리 기록이 스키마 위반 (거절 사유 없음 등)
   * @throws {NotFoundError} 없는 ID
   * @throws {ConflictError} 이미 처리된 제안
   */
  decide(id: string, input: ProposalDecisionInput): Proposal {
    return withTransaction(this.#db, () => {
      const current = this.get(id);
      if (current === null) throw new NotFoundError(ENTITY, id);
      if (current.state !== 'pending') {
        throw new ConflictError(ENTITY, id, `이미 처리됐습니다 (${current.state})`);
      }
      const next = Proposal.parse({
        ...current,
        state: input.state,
        decision: ProposalDecision.parse(input.decision),
      });
      const result = this.#decide.run({
        id,
        state: next.state,
        decision: json(next.decision),
      });
      if (result.changes !== 1) throw new ConflictError(ENTITY, id, '이미 처리됐습니다');
      return next;
    });
  }

  /**
   * 처음 읽은 시각을 남긴다 (안 읽음 점, SCR-17). 이미 읽었으면 처음 시각을 그대로 둔다.
   * @throws {ZodError} 시각 형식 위반
   * @throws {NotFoundError} 없는 ID
   */
  markRead(id: string, at: string): Proposal {
    const when = Timestamp.parse(at);
    return withTransaction(this.#db, () => {
      if (this.get(id) === null) throw new NotFoundError(ENTITY, id);
      this.#markRead.run({ id, at: when });
      const updated = this.get(id);
      if (updated === null) throw new NotFoundError(ENTITY, id);
      return updated;
    });
  }
}
