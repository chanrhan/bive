import type { Migration } from '../../migrate.js';

/**
 * 판정 실행기 `dependency-cruiser` (M3-03 #48, JDG-01 · JDG-05, ADR-127). 검사 단계 · 병합 재검사가 내장 구조 규칙을 파서(구조 검사)
 * 결과로 판정해 판정 기록을 남긴다. 그 기록의 실행기는 vitest가 아니므로 `judgments.runner` CHECK(0008)에 값을 더한다.
 * - SQLite는 CHECK를 바꾸는 ALTER가 없어 0020과 같은 순서로 표를 다시 만든다: 새 표 → 행 복사(rowid 순, 값 그대로) → 옛 트리거 ·
 *   표 삭제 → 이름 바꾸기 → 색인 · 트리거 다시 만들기. 칸 순서 · 이름 · 나머지 CHECK는 0008의 표와 같다. 색인 2개와 트리거 4개
 *   (덮어쓰기 · 미래 시각 · 수정 · 삭제 금지)는 글자까지 같다
 * - 이 표를 외래 키로 가리키는 표가 없고 다른 표의 트리거 본문도 이 표를 읽지 않는다. 그래도 표 재구성의 같은 틀(0015 · 0016 ·
 *   0020)을 따라 외래 키 검사를 끈 채 돌리고 끝에 대조한다
 * 머지된 0008은 고치지 않는다.
 */
export const migration: Migration = {
  version: 23,
  name: 'structure_judge_runner',
  disableForeignKeys: true,
  up: `
CREATE TABLE judgments_v23 (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  rule_id TEXT NOT NULL REFERENCES rules (id),
  run_id TEXT REFERENCES runs (id),
  step_id TEXT REFERENCES steps (id),
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) IN (40, 64)),
  judged_at TEXT NOT NULL CHECK (
    judged_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'unjudged', 'quarantined', 'needs_recheck')),
  runner TEXT NOT NULL CHECK (runner IN ('vitest', 'dependency-cruiser')),
  exit_code INTEGER,
  reporter_path TEXT CHECK (reporter_path IS NULL OR length(reporter_path) > 0),
  cases TEXT NOT NULL CHECK (json_valid(cases) AND json_type(cases) = 'array'),
  quarantine_reason TEXT CHECK (quarantine_reason IS NULL OR length(quarantine_reason) > 0),
  CHECK ((run_id IS NULL) = (step_id IS NULL)),
  CHECK ((status = 'quarantined') = (quarantine_reason IS NOT NULL))
) STRICT;

INSERT INTO judgments_v23 (
  id, rule_id, run_id, step_id, commit_sha, judged_at, status, runner, exit_code, reporter_path,
  cases, quarantine_reason
)
SELECT
  id, rule_id, run_id, step_id, commit_sha, judged_at, status, runner, exit_code, reporter_path,
  cases, quarantine_reason
FROM judgments ORDER BY rowid;

DROP TRIGGER judgments_no_replace;
DROP TRIGGER judgments_no_future;
DROP TRIGGER judgments_no_update;
DROP TRIGGER judgments_no_delete;
DROP TABLE judgments;
ALTER TABLE judgments_v23 RENAME TO judgments;

CREATE INDEX judgments_rule_latest ON judgments (rule_id, judged_at, id);
CREATE INDEX judgments_run ON judgments (run_id);

CREATE TRIGGER judgments_no_replace BEFORE INSERT ON judgments
WHEN EXISTS (SELECT 1 FROM judgments WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'judgments: 같은 판정 기록이 이미 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER judgments_no_future BEFORE INSERT ON judgments
WHEN NEW.judged_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 minutes')
BEGIN
  SELECT RAISE(ABORT, 'judgments: 판정 시각이 미래입니다');
END;

CREATE TRIGGER judgments_no_update BEFORE UPDATE ON judgments
BEGIN
  SELECT RAISE(ABORT, 'judgments: 판정 기록은 바꿀 수 없습니다');
END;

CREATE TRIGGER judgments_no_delete BEFORE DELETE ON judgments
BEGIN
  SELECT RAISE(ABORT, 'judgments: 판정 기록은 지울 수 없습니다');
END;
`,
};
