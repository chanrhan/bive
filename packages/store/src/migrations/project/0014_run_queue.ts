import type { Migration } from '../../migrate.js';

/**
 * 실행 대기 (RUN-01 · RUN-08, ADR-100 B⑥ · A13, M7-06 #218, ADR-105).
 * 1. `runs.status` CHECK에 `queued`(실행 대기: 프로젝트에 진행 중 · 중단된 실행이 있어 시작을 기다림)를 더한다. SQLite는
 *    CHECK를 바꾸는 ALTER가 없어 표를 다시 만든다(0010 · 0012와 같은 순서): 새 표 → 행 복사(rowid 순, 값 그대로) → 옛
 *    트리거 · 표 삭제 → 이름 바꾸기 → 색인 · 트리거 다시 만들기. 나머지 칸 · 색인 · 트리거는 0005와 글자까지 같다.
 *    `started_by`의 사람 주체 CHECK도 그대로다(넓히지 않는다, ADR-105)
 *    - `runs`는 다른 표(`run_target_rules` · `steps` · `sessions` · `tool_calls` · `judgments`)가 외래 키로 가리키고
 *      `steps`의 트리거가 이름으로 읽는다. 외래 키 검사가 켜져 있으면 옛 표를 지울 때 자식 행이 위반으로 잡히므로(미뤄도
 *      커밋 때 실패) 이 마이그레이션은 `disableForeignKeys`로 러너에게 SQLite 권장 순서(검사 끄기 → 트랜잭션 → 재구성 →
 *      `foreign_key_check` → 커밋 → 검사 켜기)를 요청한다. 지우기 전에 같은 ID의 행을 새 표에 다 옮겨 두므로 위반은 없고,
 *      러너가 트랜잭션 안에서 `foreign_key_check`로 확인한다(위반이 있으면 전부 되돌림)
 *    - 옛 표 이름을 먼저 바꾸지 않는다: 이름 바꾸기는 다른 표의 외래 키 참조까지 고쳐 쓰므로 자식 표가 옛 표를 가리키게 된다
 *    - `steps`의 트리거 2개(`steps_run_terminal_insert` · `steps_final`)는 `runs`를 이름으로 읽어, `runs`가 없는 동안의 이름
 *      바꾸기가 스키마 오류로 거부된다. 옛 표를 지우기 전에 지우고 이름을 바꾼 뒤 0005와 같은 글자로 다시 만든다
 * 2. 프로젝트당 `running` 1개(B⑥)를 DB도 막는다(트리거 2개). 앱 규칙(엔진 · 실행 서비스)이 먼저 거르고 이것은 이중 방어다
 *    - 다른 실행이 `running`이면 어떤 실행도 `running`이 될 수 없다(삽입 · 갱신)
 *    - 승인 대기 · 실행 대기에서 `running`으로 갈 때는 중단된 실행도 없어야 한다. 승인 대기에서 바로 갈 때는 실행 대기가
 *      하나도 없어야 하고(있으면 그 뒤에 선다), 실행 대기에서 갈 때는 더 먼저 만든(표시 번호가 작은) 실행 대기가 없어야
 *      한다(생성 순). 중단 → 진행 중(재개)은 다른 중단 실행 · 실행 대기가 있어도 된다
 * 머지된 0005는 고치지 않는다.
 */
export const migration: Migration = {
  version: 14,
  name: 'run_queue',
  disableForeignKeys: true,
  up: `
CREATE TABLE runs_v14 (
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
    json_valid(started_by) AND json_extract(started_by, '$.kind') = 'human'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  started_at TEXT CHECK (started_at IS NULL OR length(started_at) > 0),
  ended_at TEXT CHECK (ended_at IS NULL OR length(ended_at) > 0)
) STRICT;

INSERT INTO runs_v14 (
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
DROP TRIGGER steps_run_terminal_insert;
DROP TRIGGER steps_final;
DROP TABLE runs;
ALTER TABLE runs_v14 RENAME TO runs;

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
`,
};
