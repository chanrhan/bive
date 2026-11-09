// 에이전트 세션 · 도구 호출 기록 리포지토리 (RUN-04, NFR-02, COST-02, ADR-052 · ADR-066).
// - 세션은 열 때 `start`로 행을 만들고 끝날 때 `end`로 한 번 채운다. 끝난 세션은 다시 바뀌지 않는다(트리거도 막는다)
// - 도구 호출은 `appendToolCall`로 추가만 한다. 세션 안 순번(`seq`)은 리포지토리가 정한다
// - 세션 · 호출 기록은 실행 상태(`runs.transition`)와 별개인 기록이다: 세션 도중에도 바로 남겨야 재기동 뒤
//   역할별 세션 순번(ADR-049)과 거부 기록(NFR-02)이 이어진다
import {
  type ModelUsage,
  Session,
  type SessionEndReason,
  ToolCall,
  type ToolManifestEntry,
} from '@bive/shared';

import { withTransaction, type SqliteDatabase } from '../database.js';
import { ConflictError, NotFoundError } from '../errors.js';

/** 새 세션. 결과 필드는 `end`가 채운다. */
export type SessionStartInput = Pick<
  Session,
  'id' | 'runId' | 'stepId' | 'role' | 'model' | 'workDir' | 'startedAt'
> &
  Partial<Pick<Session, 'requirementId'>>;

/** 세션 init 보고 (SDK 세션 ID · 도구 목록 · MCP 서버). 끝나기 전에 한 번 이상 기록할 수 있다. */
export interface SessionInitInput {
  readonly sdkSessionId: string;
  readonly tools: readonly string[];
  readonly mcpServers: readonly string[];
}

/** 세션 종료 기록. */
export interface SessionEndInput {
  readonly endReason: SessionEndReason;
  readonly error?: string | null;
  readonly totalCostUsd?: number | null;
  readonly numTurns?: number | null;
  readonly modelUsage?: Readonly<Record<string, ModelUsage>>;
  readonly firstTurnCacheWrite?: number | null;
  readonly endedAt: string;
}

/** 도구 호출 1건. 순번은 리포지토리가 붙인다. */
export type ToolCallInput = Omit<ToolCall, 'seq'>;

const ENTITY = '세션';

interface SessionRow {
  id: string;
  run_id: string | null;
  step_id: string | null;
  requirement_id: string | null;
  role: string;
  model: string;
  sdk_session_id: string | null;
  work_dir: string;
  end_reason: string | null;
  error: string | null;
  total_cost_usd: number | null;
  num_turns: number | null;
  model_usage: string;
  first_turn_cache_write: number | null;
  tools: string;
  mcp_servers: string;
  started_at: string;
  ended_at: string | null;
}

interface ToolCallRow {
  id: string;
  run_id: string | null;
  session_id: string;
  seq: number;
  at: string;
  role: string;
  name: string;
  args_summary: string;
  status: string;
  reason: string | null;
  duration_ms: number;
}

const SESSION_COLUMNS = `id, run_id, step_id, requirement_id, role, model, sdk_session_id, work_dir, end_reason, error,
  total_cost_usd, num_turns, model_usage, first_turn_cache_write, tools, mcp_servers, started_at, ended_at`;

const TOOL_CALL_COLUMNS = `id, run_id, session_id, seq, at, role, name, args_summary, status, reason,
  duration_ms`;

const toSessionRow = (session: Session): SessionRow => ({
  id: session.id,
  run_id: session.runId,
  step_id: session.stepId,
  requirement_id: session.requirementId,
  role: session.role,
  model: session.model,
  sdk_session_id: session.sdkSessionId,
  work_dir: session.workDir,
  end_reason: session.endReason,
  error: session.error,
  total_cost_usd: session.totalCostUsd,
  num_turns: session.numTurns,
  model_usage: JSON.stringify(session.modelUsage),
  first_turn_cache_write: session.firstTurnCacheWrite,
  tools: JSON.stringify(session.tools),
  mcp_servers: JSON.stringify(session.mcpServers),
  started_at: session.startedAt,
  ended_at: session.endedAt,
});

const toSession = (row: SessionRow): Session =>
  Session.parse({
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    requirementId: row.requirement_id,
    role: row.role,
    model: row.model,
    sdkSessionId: row.sdk_session_id,
    workDir: row.work_dir,
    endReason: row.end_reason,
    error: row.error,
    totalCostUsd: row.total_cost_usd,
    numTurns: row.num_turns,
    modelUsage: JSON.parse(row.model_usage) as unknown,
    firstTurnCacheWrite: row.first_turn_cache_write,
    tools: JSON.parse(row.tools) as unknown,
    mcpServers: JSON.parse(row.mcp_servers) as unknown,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  });

const toToolCall = (row: ToolCallRow): ToolCall =>
  ToolCall.parse({
    id: row.id,
    runId: row.run_id,
    sessionId: row.session_id,
    seq: row.seq,
    at: row.at,
    role: row.role,
    name: row.name,
    argsSummary: row.args_summary,
    status: row.status,
    reason: row.reason,
    durationMs: row.duration_ms,
  });

export class SessionRepository {
  readonly #db: SqliteDatabase;
  readonly #insert;
  readonly #update;
  readonly #select;
  readonly #selectByRun;
  readonly #selectByRequirement;
  readonly #selectUnended;
  readonly #selectCallsBySession;
  readonly #countByRunRole;
  readonly #stepOf;
  readonly #insertCall;
  readonly #nextSeq;
  readonly #selectCalls;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#insert = db.prepare<[SessionRow]>(
      `INSERT INTO sessions (${SESSION_COLUMNS}) VALUES (@id, @run_id, @step_id, @requirement_id, @role, @model,
       @sdk_session_id, @work_dir, @end_reason, @error, @total_cost_usd, @num_turns, @model_usage,
       @first_turn_cache_write, @tools, @mcp_servers, @started_at, @ended_at)`,
    );
    this.#update = db.prepare<[SessionRow]>(
      `UPDATE sessions SET sdk_session_id = @sdk_session_id, end_reason = @end_reason, error = @error,
       total_cost_usd = @total_cost_usd, num_turns = @num_turns, model_usage = @model_usage,
       first_turn_cache_write = @first_turn_cache_write, tools = @tools, mcp_servers = @mcp_servers,
       ended_at = @ended_at
       WHERE id = @id`,
    );
    this.#select = db.prepare<[string], SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`,
    );
    this.#selectByRun = db.prepare<[string], SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE run_id = ? ORDER BY started_at, id`,
    );
    this.#selectUnended = db.prepare<[], SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE end_reason IS NULL ORDER BY started_at, id`,
    );
    this.#selectByRequirement = db.prepare<[string], SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE requirement_id = ? ORDER BY started_at, id`,
    );
    this.#selectCallsBySession = db.prepare<[string], ToolCallRow>(
      `SELECT ${TOOL_CALL_COLUMNS} FROM tool_calls WHERE session_id = ? ORDER BY seq`,
    );
    this.#countByRunRole = db.prepare<[string, string], { n: number }>(
      'SELECT count(*) AS n FROM sessions WHERE run_id = ? AND role = ?',
    );
    this.#stepOf = db.prepare<[string], { run_id: string; role: string | null }>(
      'SELECT run_id, role FROM steps WHERE id = ?',
    );
    this.#insertCall = db.prepare<[ToolCallRow]>(
      `INSERT INTO tool_calls (${TOOL_CALL_COLUMNS}) VALUES (@id, @run_id, @session_id, @seq, @at,
       @role, @name, @args_summary, @status, @reason, @duration_ms)`,
    );
    this.#nextSeq = db.prepare<[string], { next: number }>(
      'SELECT coalesce(max(seq) + 1, 0) AS next FROM tool_calls WHERE session_id = ?',
    );
    this.#selectCalls = db.prepare<[string], ToolCallRow>(
      `SELECT ${TOOL_CALL_COLUMNS} FROM tool_calls WHERE run_id = ? ORDER BY at, session_id, seq`,
    );
  }

  /**
   * 세션 행을 만든다(종료 사유 `null`). 실행 세션은 단계 시도가 그 실행 · 역할의 것이어야 하고,
   * 실행 밖 세션(규칙 작성)은 실행 · 단계 없이 대상 요구사항(`requirementId`)을 가진다.
   * @throws {NotFoundError} 단계 시도가 없을 때
   * @throws {ConflictError} 단계가 다른 실행 · 다른 역할이거나 같은 ID가 이미 있을 때
   */
  start(input: SessionStartInput): Session {
    return withTransaction(this.#db, () => {
      const session = Session.parse({
        requirementId: null,
        ...input,
        sdkSessionId: null,
        endReason: null,
        error: null,
        totalCostUsd: null,
        numTurns: null,
        modelUsage: {},
        firstTurnCacheWrite: null,
        tools: [],
        mcpServers: [],
        endedAt: null,
      });
      if (session.stepId !== null) {
        const step = this.#stepOf.get(session.stepId);
        if (step === undefined) throw new NotFoundError('단계', session.stepId);
        if (step.run_id !== session.runId || step.role !== session.role) {
          throw new ConflictError(ENTITY, session.id, '단계 시도의 실행 · 역할과 다릅니다');
        }
      }
      if (this.#select.get(session.id) !== undefined) {
        throw new ConflictError(ENTITY, session.id, '이미 있습니다');
      }
      this.#insert.run(toSessionRow(session));
      return session;
    });
  }

  /** init 보고를 기록한다 (끝나지 않은 세션만). */
  recordInit(id: string, init: SessionInitInput): Session {
    return this.#patch(id, {
      sdkSessionId: init.sdkSessionId,
      tools: [...init.tools],
      mcpServers: [...init.mcpServers],
    });
  }

  /** 세션 종료를 기록한다. 끝난 세션은 `ConflictError`. */
  end(id: string, input: SessionEndInput): Session {
    return this.#patch(id, {
      endReason: input.endReason,
      error: input.error ?? null,
      totalCostUsd: input.totalCostUsd ?? null,
      numTurns: input.numTurns ?? null,
      modelUsage: { ...(input.modelUsage ?? {}) },
      firstTurnCacheWrite: input.firstTurnCacheWrite ?? null,
      endedAt: input.endedAt,
    });
  }

  get(id: string): Session | null {
    const row = this.#select.get(id);
    return row === undefined ? null : toSession(row);
  }

  /** 실행의 세션을 시작 순으로. */
  listByRun(runId: string): Session[] {
    return this.#selectByRun.all(runId).map(toSession);
  }

  /** 끝나지 않은 세션 전부 (시작 순). 재기동 때 앞 프로세스가 남긴 세션을 닫는 데 쓴다. */
  listUnended(): Session[] {
    return this.#selectUnended.all().map(toSession);
  }

  /** 실행 밖 세션 포함, 요구사항을 대상으로 한 세션 (시작 순). */
  listByRequirement(requirementId: string): Session[] {
    return this.#selectByRequirement.all(requirementId).map(toSession);
  }

  /** 세션의 도구 호출 기록 (순번 순). */
  toolCallsBySession(sessionId: string): ToolCall[] {
    return this.#selectCallsBySession.all(sessionId).map(toToolCall);
  }

  /** 실행 · 역할의 세션 수 (끝나지 않은 · 비정상 종료된 세션 포함). 다음 세션의 0부터 순번이다 (ADR-049). */
  countByRunRole(runId: string, role: string): number {
    return this.#countByRunRole.get(runId, role)?.n ?? 0;
  }

  /** 실행의 도구 목록 · MCP 수 (init을 보고한 세션만, 시작 순). `Run.toolManifest`에 넣는 값이다. */
  manifest(runId: string): ToolManifestEntry[] {
    return this.listByRun(runId)
      .filter((session) => session.sdkSessionId !== null)
      .map((session) => ({
        role: session.role,
        tools: session.tools,
        mcpServerCount: session.mcpServers.length,
      }));
  }

  /** 도구 호출 1건을 세션 순번을 붙여 추가한다. */
  appendToolCall(input: ToolCallInput): ToolCall {
    return withTransaction(this.#db, () => {
      const session = this.get(input.sessionId);
      if (session === null) throw new NotFoundError(ENTITY, input.sessionId);
      if (session.runId !== input.runId) {
        throw new ConflictError(ENTITY, session.id, '도구 호출의 실행과 다릅니다');
      }
      const seq = this.#nextSeq.get(input.sessionId)?.next ?? 0;
      const call = ToolCall.parse({ ...input, seq });
      this.#insertCall.run({
        id: call.id,
        run_id: call.runId,
        session_id: call.sessionId,
        seq: call.seq,
        at: call.at,
        role: call.role,
        name: call.name,
        args_summary: call.argsSummary,
        status: call.status,
        reason: call.reason,
        duration_ms: call.durationMs,
      });
      return call;
    });
  }

  /** 실행의 도구 호출 기록 (시각 → 세션 → 순번). */
  toolCalls(runId: string): ToolCall[] {
    return this.#selectCalls.all(runId).map(toToolCall);
  }

  #patch(id: string, patch: Partial<Session>): Session {
    return withTransaction(this.#db, () => {
      const current = this.get(id);
      if (current === null) throw new NotFoundError(ENTITY, id);
      if (current.endReason !== null) {
        throw new ConflictError(ENTITY, id, `끝난 세션입니다 (${current.endReason})`);
      }
      const next = Session.parse({ ...current, ...patch });
      this.#update.run(toSessionRow(next));
      return next;
    });
  }
}
