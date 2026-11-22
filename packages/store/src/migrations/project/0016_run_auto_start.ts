import type { Migration } from '../../migrate.js';

/**
 * 실행 자동 시작 (RUN-01 · RUN-02 · NFR-07, ADR-100 A2 · A3 · B⑤ · C2, M7-05 #217, ADR-107).
 * 1. `runs.started_by` CHECK(사람만, 0005 · 0015)를 넓혀 오케스트레이터 주체를 받는다. 오케스트레이터 주체는 원인 규범 변경
 *    기록 ID(`causeSeqs`: 대상 규칙을 만든 신규 기록의 순번, 정수 1개 이상)가 있을 때만 받는다. 사람 주체는 그대로다.
 *    JSON 칸의 CHECK는 `json_extract`가 NULL을 돌려도(키 없음 · null 값 · 객체 아님) 통과하지 않게 `json_type` · `coalesce`로
 *    감싼다(0013과 같은 방식). 0005의 사람 CHECK(`json_extract(...) = 'human'`)는 객체가 아닌 JSON(문자열 등)에서 NULL이
 *    되어 통과했는데, 새 CHECK는 그것도 거부한다(제품 코드는 늘 `{"kind":"human"}`만 썼다). CHECK에는 부분 질의를 쓸 수 없어
 *    목록의 첫 값만 정수 · 양수인지 보고, 나머지 값의 형식은 `@bive/shared` 스키마(`RunStarter`)가, 그 순번이 실제 규범 변경
 *    기록인지는 엔진의 시작 근거 대조가 본다
 *    - SQLite는 CHECK를 바꾸는 ALTER가 없어 0015와 같은 순서로 표를 다시 만든다: 새 표 → 행 복사(rowid 순, 값 그대로) → 옛
 *      트리거 · 표 삭제 → 이름 바꾸기 → 색인 · 트리거 다시 만들기. 나머지 칸 · 색인 · 트리거(0005의 것과 0015의 진행 중 1개
 *      방어 2개)는 0015와 글자까지 같다. `runs`를 외래 키로 가리키는 자식 표가 있어 `disableForeignKeys`를 쓰고, `steps`의
 *      트리거 2개는 옛 표를 지우기 전에 지우고 이름을 바꾼 뒤 다시 만든다(0015의 설명과 같은 이유)
 * 2. `auto_start_skips`: 규칙 작성 세션이 규칙을 만들고 정상 종료했는데 실행을 자동 시작하지 않은 사실과 사유(하루 한도 없음 ·
 *    하루 예산 초과 · 설정 미비). 요구사항 상세의 규칙 작성 상태 줄(`ruleWriter.status`)이 이 기록에서만 생략을 보인다.
 *    세션 1개에 1행(세션 ID가 키), 추가 전용(덮어쓰기 · 수정 · 삭제 트리거). 세션 ID는 외래 키로 묶지 않는다(0013과 같은 이유)
 * 머지된 0005 · 0015는 고치지 않는다.
 */
export const migration: Migration = {
  version: 16,
  name: 'run_auto_start',
  disableForeignKeys: true,
  up: `
CREATE TABLE runs_v16 (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  display_id TEXT NOT NULL UNIQUE CHECK (display_id GLOB 'EXE-[0-9][0-9][0-9]*'),
  type TEXT NOT NULL CHECK (type IN ('A', 'B', 'C', 'D')),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'waiting_approval', 'running', 'merged', 'failed', 'budget_exceeded', 'interrupted'
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
    json_valid(started_by) AND json_type(started_by) = 'object' AND (
      coalesce(json_extract(started_by, '$.kind'), '') = 'human'
      OR (
        coalesce(json_extract(started_by, '$.kind'), '') = 'orchestrator'
        AND coalesce(json_type(started_by, '$.causeSeqs'), '') = 'array'
        AND coalesce(json_array_length(started_by, '$.causeSeqs'), 0) > 0
        AND coalesce(json_type(started_by, '$.causeSeqs[0]'), '') = 'integer'
        AND coalesce(json_extract(started_by, '$.causeSeqs[0]'), 0) > 0
      )
    )
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  started_at TEXT CHECK (started_at IS NULL OR length(started_at) > 0),
  ended_at TEXT CHECK (ended_at IS NULL OR length(ended_at) > 0)
) STRICT;

INSERT INTO runs_v16 (
  id, display_id, type, status, current_step, last_completed_step, regression_count, failure_reason,
  branch, worktree_path, base_branch, base_commit, head_commit, merge_commit, budget_snapshot,
  model_snapshot, cost_usd, turns, tool_manifest, started_by, created_at, started_at, ended_at
)
SELECT
  id, display_id, type, status, current_step, last_completed_step, regression_count, failure_reason,
  branch, worktree_path, base_branch, base_commit, head_commit, merge_commit, budget_snapshot,
  model_snapshot, cost_usd, turns, tool_manifest, started_by, created_at, started_at, ended_at
FROM runs ORDER BY rowid;

DROP TRIGGER runs_no_replace;
DROP TRIGGER runs_identity_immutable;
DROP TRIGGER runs_terminal_final;
DROP TRIGGER runs_no_delete;
DROP TRIGGER runs_one_running_insert;
DROP TRIGGER runs_one_running_update;
DROP TRIGGER steps_run_terminal_insert;
DROP TRIGGER steps_final;
DROP TABLE runs;
ALTER TABLE runs_v16 RENAME TO runs;

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

CREATE TRIGGER steps_run_terminal_insert BEFORE INSERT ON steps
WHEN (SELECT status FROM runs WHERE id = NEW.run_id) IN ('merged', 'failed', 'budget_exceeded')
BEGIN
  SELECT RAISE(ABORT, 'steps: 종료된 실행에는 단계를 더할 수 없습니다');
END;

CREATE TRIGGER steps_final BEFORE UPDATE ON steps
WHEN OLD.status IN ('passed', 'failed', 'skipped')
  OR (SELECT status FROM runs WHERE id = OLD.run_id) IN ('merged', 'failed', 'budget_exceeded')
BEGIN
  SELECT RAISE(ABORT, 'steps: 끝난 단계 · 종료된 실행의 단계는 바꿀 수 없습니다');
END;

CREATE TRIGGER runs_one_running_insert BEFORE INSERT ON runs
WHEN NEW.status = 'running' AND EXISTS (SELECT 1 FROM runs WHERE status = 'running')
BEGIN
  SELECT RAISE(ABORT, 'runs: 프로젝트에 진행 중인 실행이 이미 있습니다');
END;

CREATE TRIGGER runs_one_running_update BEFORE UPDATE OF status ON runs
WHEN NEW.status = 'running' AND OLD.status IS NOT 'running' AND (
  EXISTS (SELECT 1 FROM runs WHERE status = 'running' AND id IS NOT OLD.id)
  OR (
    OLD.status IN ('waiting_approval', 'queued')
    AND EXISTS (
      SELECT 1 FROM runs
      WHERE status = 'interrupted'
        OR (
          status = 'queued' AND id IS NOT OLD.id AND (
            OLD.status = 'waiting_approval'
            OR CAST(substr(display_id, 5) AS INTEGER) < CAST(substr(OLD.display_id, 5) AS INTEGER)
          )
        )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'runs: 프로젝트에 진행 중 · 중단된 실행이나 먼저 기다리는 실행이 있습니다');
END;

CREATE TABLE auto_start_skips (
  session_id TEXT PRIMARY KEY NOT NULL CHECK (length(session_id) = 26),
  reason TEXT NOT NULL CHECK (reason IN (
    'project_daily_budget_unset', 'project_daily_budget_exceeded', 'settings_incomplete'
  )),
  missing TEXT NOT NULL CHECK (json_valid(missing) AND json_type(missing) = 'array'),
  skipped_at TEXT NOT NULL CHECK (length(skipped_at) > 0)
) STRICT;

CREATE TRIGGER auto_start_skips_no_replace BEFORE INSERT ON auto_start_skips
WHEN EXISTS (SELECT 1 FROM auto_start_skips WHERE session_id = NEW.session_id)
BEGIN
  SELECT RAISE(ABORT, 'auto_start_skips: 같은 세션의 생략 기록이 이미 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER auto_start_skips_no_update BEFORE UPDATE ON auto_start_skips
BEGIN
  SELECT RAISE(ABORT, 'auto_start_skips: 생략 기록은 바꿀 수 없습니다');
END;

CREATE TRIGGER auto_start_skips_no_delete BEFORE DELETE ON auto_start_skips
BEGIN
  SELECT RAISE(ABORT, 'auto_start_skips: 생략 기록은 지울 수 없습니다');
END;
`,
};
