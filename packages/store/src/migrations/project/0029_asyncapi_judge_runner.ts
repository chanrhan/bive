import type { Migration } from '../../migrate.js';

/**
 * 판정 실행기 `asyncapi-parser` (M3-49 #294, NRM-03 · JDG-01, ADR-148). 검사 단계 · 병합 재검사가 AsyncAPI 계약 검사 규칙을
 * `@asyncapi/parser`로 판정해(문서 유효성만) 판정 기록을 남긴다. 그 기록의 실행기 값을 `judgments.runner` CHECK(0025)에 더한다.
 * - 0025와 같은 순서로 표를 다시 만든다: 새 표 → 행 복사(rowid 순, 값 그대로) → 옛 트리거 · 표 삭제 → 이름 바꾸기 → 색인 · 트리거
 *   다시 만들기. 칸 순서 · 이름 · 나머지 CHECK는 0025의 표와 같다. 색인 2개와 트리거 4개(덮어쓰기 · 미래 시각 · 수정 · 삭제 금지)는
 *   0025와 글자까지 같다
 * - 다른 표의 트리거 본문이 이 표를 읽는 곳이 하나 있다: 0028의 `review_items_resolve_quarantine`(판정 격리 처리에는 그 규칙의 격리 판정
 *   기록이 있어야 한다). 표를 지우면 그 트리거가 없는 표를 가리켜 이름 바꾸기가 거부되므로, 표를 지우기 전에 그 트리거를 지우고 이름을
 *   바꾼 뒤 0028과 글자까지 같게 다시 만든다. 이 표를 외래 키로 가리키는 표와 이 표를 읽는 뷰는 없다
 * - 외래 키 검사를 끈 채 돌리고 끝에 대조한다(표 재구성의 같은 틀)
 * 머지된 0025 · 0028은 고치지 않는다.
 */
export const migration: Migration = {
  version: 29,
  name: 'asyncapi_judge_runner',
  disableForeignKeys: true,
  up: `
CREATE TABLE judgments_v29 (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  rule_id TEXT NOT NULL REFERENCES rules (id),
  run_id TEXT REFERENCES runs (id),
  step_id TEXT REFERENCES steps (id),
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) IN (40, 64)),
  judged_at TEXT NOT NULL CHECK (
    judged_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'unjudged', 'quarantined', 'needs_recheck')),
  runner TEXT NOT NULL CHECK (runner IN ('vitest', 'dependency-cruiser', 'redocly-prism', 'asyncapi-parser')),
  exit_code INTEGER,
  reporter_path TEXT CHECK (reporter_path IS NULL OR length(reporter_path) > 0),
  cases TEXT NOT NULL CHECK (json_valid(cases) AND json_type(cases) = 'array'),
  quarantine_reason TEXT CHECK (quarantine_reason IS NULL OR length(quarantine_reason) > 0),
  CHECK ((run_id IS NULL) = (step_id IS NULL)),
  CHECK ((status = 'quarantined') = (quarantine_reason IS NOT NULL))
) STRICT;

INSERT INTO judgments_v29 (
  id, rule_id, run_id, step_id, commit_sha, judged_at, status, runner, exit_code, reporter_path,
  cases, quarantine_reason
)
SELECT
  id, rule_id, run_id, step_id, commit_sha, judged_at, status, runner, exit_code, reporter_path,
  cases, quarantine_reason
FROM judgments ORDER BY rowid;

DROP TRIGGER review_items_resolve_quarantine;
DROP TRIGGER judgments_no_replace;
DROP TRIGGER judgments_no_future;
DROP TRIGGER judgments_no_update;
DROP TRIGGER judgments_no_delete;
DROP TABLE judgments;
ALTER TABLE judgments_v29 RENAME TO judgments;

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

CREATE TRIGGER review_items_resolve_quarantine BEFORE UPDATE ON review_items
WHEN OLD.resolved_at IS NULL AND NEW.kind = 'mutant_survived' AND NEW.action = 'quarantine' AND NOT EXISTS (
  SELECT 1 FROM judgments AS j JOIN mutation_results AS cause ON cause.id = NEW.mutation_result_id
  WHERE j.id = json_extract(NEW.detail, '$.judgmentId') AND j.rule_id = cause.rule_id
    AND j.status = 'quarantined' AND j.quarantine_reason = NEW.reason
)
BEGIN
  SELECT RAISE(ABORT, 'review_items: 판정 격리 처리에는 그 규칙의 같은 사유 격리 판정 기록이 있어야 합니다');
END;
`,
};
