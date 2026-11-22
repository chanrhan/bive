import type { Migration } from '../../migrate.js';

/**
 * 세션 종료 사유 `objection_raised` (M7-11 #223, ADR-100 D4, ADR-115). 구현 역할이 이의 제기 도구를 부르면 오케스트레이터가 그
 * 세션을 끝내고 이 사유로 남긴다. `sessions.end_reason` CHECK(0006)에 값을 더한다.
 * - SQLite는 CHECK를 바꾸는 ALTER가 없어 0015 · 0016과 같은 순서로 표를 다시 만든다: 새 표 → 행 복사(rowid 순, 값 그대로) →
 *   옛 트리거 · 표 삭제 → 이름 바꾸기 → 색인 · 트리거 다시 만들기. 칸 순서 · 이름 · 나머지 CHECK는 0006 · 0007 · 0017을 거친
 *   지금 표와 같다(0007 · 0017이 ALTER로 더한 칸의 CHECK는 칸 제약 · 표 제약으로 옮겼다). 색인 1개(0006)와 트리거 6개(0006의
 *   덮어쓰기 · 식별 정보 · 끝난 세션 · 삭제, 0007의 한도, 0017의 규범 입력)는 글자까지 같다
 * - `tool_calls.session_id`가 이 표를 외래 키로 가리키므로 `disableForeignKeys`를 쓴다. 다른 표의 트리거 본문은 이 표를 읽지
 *   않는다
 * 머지된 0006 · 0007 · 0017은 고치지 않는다.
 */
export const migration: Migration = {
  version: 20,
  name: 'session_objection_end',
  disableForeignKeys: true,
  up: `
CREATE TABLE sessions_v20 (
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
    'guard_violation', 'objection_raised'
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
  budget_max_usd REAL CHECK (budget_max_usd IS NULL OR budget_max_usd > 0),
  budget_max_turns INTEGER CHECK (budget_max_turns IS NULL OR budget_max_turns > 0),
  norm_input TEXT
    CHECK (norm_input IS NULL OR (json_valid(norm_input) AND json_type(norm_input) = 'object')),
  CHECK ((run_id IS NULL) = (step_id IS NULL)),
  CHECK ((budget_max_usd IS NULL) = (budget_max_turns IS NULL))
) STRICT;

INSERT INTO sessions_v20 (
  id, run_id, step_id, requirement_id, role, model, sdk_session_id, work_dir, end_reason, error,
  total_cost_usd, num_turns, model_usage, first_turn_cache_write, tools, mcp_servers, started_at,
  ended_at, budget_max_usd, budget_max_turns, norm_input
)
SELECT
  id, run_id, step_id, requirement_id, role, model, sdk_session_id, work_dir, end_reason, error,
  total_cost_usd, num_turns, model_usage, first_turn_cache_write, tools, mcp_servers, started_at,
  ended_at, budget_max_usd, budget_max_turns, norm_input
FROM sessions ORDER BY rowid;

DROP TRIGGER sessions_no_replace;
DROP TRIGGER sessions_identity_immutable;
DROP TRIGGER sessions_final;
DROP TRIGGER sessions_no_delete;
DROP TRIGGER sessions_budget_immutable;
DROP TRIGGER sessions_norm_input_immutable;
DROP TABLE sessions;
ALTER TABLE sessions_v20 RENAME TO sessions;

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

CREATE TRIGGER sessions_budget_immutable BEFORE UPDATE ON sessions
WHEN NEW.budget_max_usd IS NOT OLD.budget_max_usd OR NEW.budget_max_turns IS NOT OLD.budget_max_turns
BEGIN
  SELECT RAISE(ABORT, 'sessions: 세션 한도는 바꿀 수 없습니다');
END;

CREATE TRIGGER sessions_norm_input_immutable BEFORE UPDATE ON sessions
WHEN NEW.norm_input IS NOT OLD.norm_input
BEGIN
  SELECT RAISE(ABORT, 'sessions: 세션의 규범 입력 기록은 바꿀 수 없습니다');
END;
`,
};
