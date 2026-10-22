import type { Migration } from '../../migrate.js';

/**
 * 실행 · 대상 규칙 · 단계 (RUN-01, RUN-02, RUN-08, COST-01, architecture.md 3장 Run · Step, ADR-061).
 * - `runs`: 프로젝트별 DB라서 프로젝트 ID 열은 두지 않는다. 예산 · 모델 스냅샷 · 도구 목록 · 시작 주체는 JSON.
 *   생성 뒤 바뀌지 않는 열(ID · 표시 ID · 유형 · 기준 브랜치 · 스냅샷 · 시작 주체 · 생성 시각)과 종료 상태
 *   (`merged` · `failed` · `budget_exceeded`) 실행의 수정, 삭제는 트리거로 막는다
 * - `run_target_rules`: 실행 ↔ 규칙(n─n). `position`은 요청 순서. 추가만 하고 수정 · 삭제는 트리거로 막는다
 * - `steps`: 단계 시도 1회 = 행 1개(`run_id` · `kind` · `attempt` 유일). 끝난 단계(`passed` · `failed` ·
 *   `skipped`) 행과 종료된 실행의 단계는 바뀌지 않는다. 다시 하는 단계는 새 시도 행을 만든다
 * - `INSERT OR REPLACE`로 기존 행을 지우고 새로 넣는 우회는 BEFORE INSERT 트리거가 막는다 (ADR-050과 같은 이중 방어)
 * 상태 전이 규칙(architecture.md 4장 상태 기계) · 형식 검증은 `@bive/shared`의 `Run` · `Step` 스키마와
 * 리포지토리가 맡고, 여기서는 기본 제약과 기록 보존 트리거만 둔다.
 */
export const migration: Migration = {
  version: 5,
  name: 'runs',
  up: `
CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  display_id TEXT NOT NULL UNIQUE CHECK (display_id GLOB 'EXE-[0-9][0-9][0-9]*'),
  type TEXT NOT NULL CHECK (type IN ('A', 'B', 'C', 'D')),
  status TEXT NOT NULL CHECK (status IN (
    'waiting_approval', 'running', 'merged', 'failed', 'budget_exceeded', 'interrupted'
  )),
  current_step TEXT CHECK (current_step IS NULL OR current_step IN (
    'approval', 'test_writing', 'red_check', 'green_check', 'implementation', 'check', 'mutation',
    'merge', 'screen_update'
  )),
  last_completed_step TEXT CHECK (last_completed_step IS NULL OR last_completed_step IN (
    'approval', 'test_writing', 'red_check', 'green_check', 'implementation', 'check', 'mutation',
    'merge', 'screen_update'
  )),
  regression_count INTEGER NOT NULL CHECK (regression_count >= 0),
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) > 0),
  branch TEXT CHECK (branch IS NULL OR length(branch) > 0),
  worktree_path TEXT CHECK (worktree_path IS NULL OR length(worktree_path) > 0),
  base_branch TEXT NOT NULL CHECK (length(base_branch) > 0),
  base_commit TEXT CHECK (base_commit IS NULL OR length(base_commit) IN (40, 64)),
  head_commit TEXT CHECK (head_commit IS NULL OR length(head_commit) IN (40, 64)),
  merge_commit TEXT CHECK (merge_commit IS NULL OR length(merge_commit) IN (40, 64)),
  budget_snapshot TEXT NOT NULL CHECK (
    json_valid(budget_snapshot) AND json_type(budget_snapshot) = 'object'
  ),
  model_snapshot TEXT NOT NULL CHECK (
    json_valid(model_snapshot) AND json_type(model_snapshot) = 'object'
  ),
  cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  turns INTEGER CHECK (turns IS NULL OR turns >= 0),
  tool_manifest TEXT NOT NULL CHECK (
    json_valid(tool_manifest) AND json_type(tool_manifest) = 'array'
  ),
  started_by TEXT NOT NULL CHECK (
    json_valid(started_by) AND json_extract(started_by, '$.kind') = 'human'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  started_at TEXT CHECK (started_at IS NULL OR length(started_at) > 0),
  ended_at TEXT CHECK (ended_at IS NULL OR length(ended_at) > 0)
) STRICT;

CREATE INDEX runs_status ON runs (status);

CREATE TRIGGER runs_no_replace BEFORE INSERT ON runs
WHEN EXISTS (SELECT 1 FROM runs WHERE id = NEW.id OR display_id = NEW.display_id)
BEGIN
  SELECT RAISE(ABORT, 'runs: 같은 실행이 이미 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER runs_identity_immutable BEFORE UPDATE ON runs
WHEN NEW.id IS NOT OLD.id OR NEW.display_id IS NOT OLD.display_id OR NEW.type IS NOT OLD.type
  OR NEW.base_branch IS NOT OLD.base_branch OR NEW.budget_snapshot IS NOT OLD.budget_snapshot
  OR NEW.model_snapshot IS NOT OLD.model_snapshot OR NEW.started_by IS NOT OLD.started_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'runs: 실행의 생성 정보는 바꿀 수 없습니다');
END;

CREATE TRIGGER runs_terminal_final BEFORE UPDATE ON runs
WHEN OLD.status IN ('merged', 'failed', 'budget_exceeded')
BEGIN
  SELECT RAISE(ABORT, 'runs: 종료된 실행은 바꿀 수 없습니다');
END;

CREATE TRIGGER runs_no_delete BEFORE DELETE ON runs
BEGIN
  SELECT RAISE(ABORT, 'runs: 실행은 지울 수 없습니다');
END;

CREATE TABLE run_target_rules (
  run_id TEXT NOT NULL REFERENCES runs (id),
  rule_id TEXT NOT NULL REFERENCES rules (id),
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (run_id, rule_id),
  UNIQUE (run_id, position)
) STRICT;

CREATE INDEX run_target_rules_rule ON run_target_rules (rule_id);

CREATE TRIGGER run_target_rules_no_replace BEFORE INSERT ON run_target_rules
WHEN EXISTS (
  SELECT 1 FROM run_target_rules
  WHERE run_id = NEW.run_id AND (rule_id = NEW.rule_id OR position = NEW.position)
)
BEGIN
  SELECT RAISE(ABORT, 'run_target_rules: 대상 규칙은 덮어쓸 수 없습니다');
END;

CREATE TRIGGER run_target_rules_no_update BEFORE UPDATE ON run_target_rules
BEGIN
  SELECT RAISE(ABORT, 'run_target_rules: 대상 규칙은 바꿀 수 없습니다');
END;

CREATE TRIGGER run_target_rules_no_delete BEFORE DELETE ON run_target_rules
BEGIN
  SELECT RAISE(ABORT, 'run_target_rules: 대상 규칙은 지울 수 없습니다');
END;

CREATE TABLE steps (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  run_id TEXT NOT NULL REFERENCES runs (id),
  kind TEXT NOT NULL CHECK (kind IN (
    'approval', 'test_writing', 'red_check', 'green_check', 'implementation', 'check', 'mutation',
    'merge', 'screen_update'
  )),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'passed', 'failed', 'skipped')),
  role TEXT CHECK (role IS NULL OR length(role) > 0),
  exit_detail TEXT NOT NULL CHECK (json_valid(exit_detail)),
  commit_sha TEXT CHECK (commit_sha IS NULL OR length(commit_sha) IN (40, 64)),
  cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  turns INTEGER CHECK (turns IS NULL OR turns >= 0),
  started_at TEXT CHECK (started_at IS NULL OR length(started_at) > 0),
  ended_at TEXT CHECK (ended_at IS NULL OR length(ended_at) > 0),
  UNIQUE (run_id, kind, attempt)
) STRICT;

CREATE INDEX steps_run ON steps (run_id);

CREATE TRIGGER steps_no_replace BEFORE INSERT ON steps
WHEN EXISTS (
  SELECT 1 FROM steps
  WHERE id = NEW.id OR (run_id = NEW.run_id AND kind = NEW.kind AND attempt = NEW.attempt)
)
BEGIN
  SELECT RAISE(ABORT, 'steps: 같은 단계 시도가 이미 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER steps_run_terminal_insert BEFORE INSERT ON steps
WHEN (SELECT status FROM runs WHERE id = NEW.run_id) IN ('merged', 'failed', 'budget_exceeded')
BEGIN
  SELECT RAISE(ABORT, 'steps: 종료된 실행에는 단계를 더할 수 없습니다');
END;

CREATE TRIGGER steps_identity_immutable BEFORE UPDATE ON steps
WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.kind IS NOT OLD.kind
  OR NEW.attempt IS NOT OLD.attempt OR NEW.role IS NOT OLD.role
BEGIN
  SELECT RAISE(ABORT, 'steps: 단계의 식별 정보는 바꿀 수 없습니다');
END;

CREATE TRIGGER steps_final BEFORE UPDATE ON steps
WHEN OLD.status IN ('passed', 'failed', 'skipped')
  OR (SELECT status FROM runs WHERE id = OLD.run_id) IN ('merged', 'failed', 'budget_exceeded')
BEGIN
  SELECT RAISE(ABORT, 'steps: 끝난 단계 · 종료된 실행의 단계는 바꿀 수 없습니다');
END;

CREATE TRIGGER steps_no_delete BEFORE DELETE ON steps
BEGIN
  SELECT RAISE(ABORT, 'steps: 단계는 지울 수 없습니다');
END;
`,
};
