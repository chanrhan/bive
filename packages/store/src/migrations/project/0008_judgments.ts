import type { Migration } from '../../migrate.js';

/**
 * 규칙 판정 기록 (JDG-01 · JDG-02, architecture.md 3장 JudgmentResult, ADR-060 · ADR-069).
 * - `judgments`: 판정 러너가 케이스 결과를 낸 판정 1회 × 그 판정이 다룬 규칙 1개 = 행 1개. 근거는 실행기 결과(종료 코드 ·
 *   원본 JSON 경로 · 케이스)뿐이다. 실행 단계의 판정은 실행 · 단계 시도를 함께 가진다(둘 다 있거나 둘 다 없음)
 * - 커밋 · 판정 시각은 필수 (JDG-02 "모든 결과에 커밋 · 시각"). 격리 상태만 격리 사유를 가진다 (TODO-02, NFR-05)
 * - 판정 시각은 밀리초 3자리 UTC(`toISOString` 모양)만 받아 문자열 비교가 시간 순서와 같게 하고, 지금보다 1분 넘게
 *   미래인 기록은 받지 않는다(미래 시각으로 최신 판정을 가로채지 못하게, 검토 1회차)
 * - 추가만 한다: 수정 · 삭제 · `INSERT OR REPLACE` 덮어쓰기는 트리거로 막는다 (ADR-050 · ADR-061과 같은 이중 방어)
 * - 규칙의 최신 판정은 판정 시각이 가장 늦은 행(같으면 ID가 큰 행)이다 (`storedLatestJudgments`, ADR-060)
 * 형식 검증은 `@bive/shared`의 `JudgmentResult` 스키마와 리포지토리가 맡는다.
 */
export const migration: Migration = {
  version: 8,
  name: 'judgments',
  up: `
CREATE TABLE judgments (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  rule_id TEXT NOT NULL REFERENCES rules (id),
  run_id TEXT REFERENCES runs (id),
  step_id TEXT REFERENCES steps (id),
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) IN (40, 64)),
  judged_at TEXT NOT NULL CHECK (
    judged_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'unjudged', 'quarantined', 'needs_recheck')),
  runner TEXT NOT NULL CHECK (runner IN ('vitest')),
  exit_code INTEGER,
  reporter_path TEXT CHECK (reporter_path IS NULL OR length(reporter_path) > 0),
  cases TEXT NOT NULL CHECK (json_valid(cases) AND json_type(cases) = 'array'),
  quarantine_reason TEXT CHECK (quarantine_reason IS NULL OR length(quarantine_reason) > 0),
  CHECK ((run_id IS NULL) = (step_id IS NULL)),
  CHECK ((status = 'quarantined') = (quarantine_reason IS NOT NULL))
) STRICT;

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
