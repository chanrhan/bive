import type { Migration } from '../../migrate.js';

/**
 * 에이전트 세션 · 도구 호출 기록 (RUN-04, NFR-02, COST-02, architecture.md 3장 Session, ADR-052 · ADR-066).
 * - `sessions`: 세션 1개 = 행 1개. 실행 엔진 · 규칙 작성 서비스가 세션을 열 때 만들고(종료 사유 `NULL`) 끝날 때
 *   한 번 채운다. 실행 단계 세션은 실행 · 단계 시도를, 실행 밖 세션(규칙 작성, ADR-062)은 둘 다 `NULL`과 요구사항을 가진다.
 *   재기동 뒤 같은 (실행, 역할)의 세션 순번(ADR-049 `roleSessionIndex`)을 이 행 수로 이어간다.
 *   식별 정보(ID · 실행 · 단계 · 역할 · 모델 · 작업 폴더 · 시작 시각)는 바뀌지 않고, 끝난 세션은 다시 바뀌지 않는다
 * - `tool_calls`: 도구 호출 1건 = 행 1개(거부 · 오류 포함). 추가만 하고 수정 · 삭제하지 않는다. 실행 밖 세션은 `run_id`가 `NULL`
 * - 둘 다 실행 기록이라 지우지 않고, `INSERT OR REPLACE` 우회는 BEFORE INSERT 트리거가 막는다 (ADR-050 · ADR-061과 같음)
 * 형식 검증은 `@bive/shared`의 `Session` · `ToolCall` 스키마와 리포지토리가 맡는다.
 */
export const migration: Migration = {
  version: 6,
  name: 'sessions_tool_calls',
  up: `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  run_id TEXT REFERENCES runs (id),
  step_id TEXT REFERENCES steps (id),
  requirement_id TEXT REFERENCES requirements (id),
  role TEXT NOT NULL CHECK (length(role) > 0),
  model TEXT NOT NULL CHECK (length(model) > 0),
  sdk_session_id TEXT CHECK (sdk_session_id IS NULL OR length(sdk_session_id) > 0),
  work_dir TEXT NOT NULL CHECK (length(work_dir) > 0),
  end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN (
    'success', 'error_max_turns', 'error_max_budget_usd', 'error_during_execution', 'aborted',
    'guard_violation'
  )),
  error TEXT CHECK (error IS NULL OR length(error) > 0),
  total_cost_usd REAL CHECK (total_cost_usd IS NULL OR total_cost_usd >= 0),
  num_turns INTEGER CHECK (num_turns IS NULL OR num_turns >= 0),
  model_usage TEXT NOT NULL CHECK (json_valid(model_usage) AND json_type(model_usage) = 'object'),
  first_turn_cache_write INTEGER CHECK (first_turn_cache_write IS NULL OR first_turn_cache_write >= 0),
  tools TEXT NOT NULL CHECK (json_valid(tools) AND json_type(tools) = 'array'),
  mcp_servers TEXT NOT NULL CHECK (json_valid(mcp_servers) AND json_type(mcp_servers) = 'array'),
  started_at TEXT NOT NULL CHECK (length(started_at) > 0),
  ended_at TEXT CHECK (ended_at IS NULL OR length(ended_at) > 0),
  CHECK ((run_id IS NULL) = (step_id IS NULL))
) STRICT;

CREATE INDEX sessions_run_role ON sessions (run_id, role);

CREATE TRIGGER sessions_no_replace BEFORE INSERT ON sessions
WHEN EXISTS (SELECT 1 FROM sessions WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'sessions: 같은 세션이 이미 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER sessions_identity_immutable BEFORE UPDATE ON sessions
WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.step_id IS NOT OLD.step_id
  OR NEW.requirement_id IS NOT OLD.requirement_id OR NEW.role IS NOT OLD.role OR NEW.model IS NOT OLD.model OR NEW.work_dir IS NOT OLD.work_dir
  OR NEW.started_at IS NOT OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'sessions: 세션의 식별 정보는 바꿀 수 없습니다');
END;

CREATE TRIGGER sessions_final BEFORE UPDATE ON sessions
WHEN OLD.end_reason IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'sessions: 끝난 세션은 바꿀 수 없습니다');
END;

CREATE TRIGGER sessions_no_delete BEFORE DELETE ON sessions
BEGIN
  SELECT RAISE(ABORT, 'sessions: 세션은 지울 수 없습니다');
END;

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  run_id TEXT REFERENCES runs (id),
  session_id TEXT NOT NULL REFERENCES sessions (id),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  at TEXT NOT NULL CHECK (length(at) > 0),
  role TEXT NOT NULL CHECK (length(role) > 0),
  name TEXT NOT NULL CHECK (length(name) > 0),
  args_summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'denied', 'error')),
  reason TEXT CHECK (reason IS NULL OR length(reason) > 0),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  UNIQUE (session_id, seq)
) STRICT;

CREATE INDEX tool_calls_run ON tool_calls (run_id);
CREATE INDEX tool_calls_session ON tool_calls (session_id);

CREATE TRIGGER tool_calls_no_replace BEFORE INSERT ON tool_calls
WHEN EXISTS (
  SELECT 1 FROM tool_calls WHERE id = NEW.id OR (session_id = NEW.session_id AND seq = NEW.seq)
)
BEGIN
  SELECT RAISE(ABORT, 'tool_calls: 같은 도구 호출 기록이 이미 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER tool_calls_no_update BEFORE UPDATE ON tool_calls
BEGIN
  SELECT RAISE(ABORT, 'tool_calls: 도구 호출 기록은 바꿀 수 없습니다');
END;

CREATE TRIGGER tool_calls_no_delete BEFORE DELETE ON tool_calls
BEGIN
  SELECT RAISE(ABORT, 'tool_calls: 도구 호출 기록은 지울 수 없습니다');
END;
`,
};
