import type { Migration } from '../../migrate.js';

/**
 * 규칙 작성 시도의 생략 사유에 프로젝트 하루 예산 초과(`project_daily_budget_exceeded`)를 더한다
 * (COST-01, ADR-100 B⑤ · A12, M7-04 #216, ADR-104).
 * SQLite는 CHECK를 바꾸는 ALTER가 없어 표를 다시 만든다(0010 · 0012와 같은 순서): 새 표 → 행 복사(값 그대로) →
 * 옛 트리거 · 색인 · 표 삭제 → 이름 바꾸기 → 색인 · 트리거 다시 만들기. 다른 표가 `rule_writer_requests`를 참조하지 않는다.
 * 나머지 칸 · 색인 · 트리거는 0011과 같다. 머지된 0011은 고치지 않는다.
 */
export const migration: Migration = {
  version: 14,
  name: 'rule_writer_daily_budget_skip',
  up: `
CREATE TABLE rule_writer_requests_v14 (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  requirement_id TEXT NOT NULL REFERENCES requirements (id),
  requested_at TEXT NOT NULL CHECK (length(requested_at) > 0),
  skip_reason TEXT CHECK (skip_reason IS NULL OR skip_reason IN (
    'settings_incomplete', 'closed', 'start_failed', 'requirement_unavailable',
    'project_daily_budget_exceeded'
  )),
  skip_detail TEXT CHECK (skip_detail IS NULL OR length(skip_detail) > 0),
  missing TEXT NOT NULL CHECK (json_valid(missing) AND json_type(missing) = 'array'),
  skipped_at TEXT CHECK (skipped_at IS NULL OR length(skipped_at) > 0),
  CHECK ((skip_reason IS NULL) = (skipped_at IS NULL)),
  CHECK (skip_reason IS NOT NULL OR skip_detail IS NULL)
) STRICT;

INSERT INTO rule_writer_requests_v14
  (id, requirement_id, requested_at, skip_reason, skip_detail, missing, skipped_at)
SELECT id, requirement_id, requested_at, skip_reason, skip_detail, missing, skipped_at
FROM rule_writer_requests ORDER BY rowid;

DROP TRIGGER rule_writer_requests_no_replace;
DROP TRIGGER rule_writer_requests_identity_immutable;
DROP TRIGGER rule_writer_requests_final;
DROP TRIGGER rule_writer_requests_no_delete;
DROP INDEX rule_writer_requests_requirement;
DROP TABLE rule_writer_requests;
ALTER TABLE rule_writer_requests_v14 RENAME TO rule_writer_requests;

CREATE INDEX rule_writer_requests_requirement ON rule_writer_requests (requirement_id, requested_at);

CREATE TRIGGER rule_writer_requests_no_replace BEFORE INSERT ON rule_writer_requests
WHEN EXISTS (SELECT 1 FROM rule_writer_requests WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'rule_writer_requests: 같은 시도가 이미 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER rule_writer_requests_identity_immutable BEFORE UPDATE ON rule_writer_requests
WHEN NEW.id IS NOT OLD.id OR NEW.requirement_id IS NOT OLD.requirement_id
  OR NEW.requested_at IS NOT OLD.requested_at
BEGIN
  SELECT RAISE(ABORT, 'rule_writer_requests: 시도의 식별 정보는 바꿀 수 없습니다');
END;

CREATE TRIGGER rule_writer_requests_final BEFORE UPDATE ON rule_writer_requests
WHEN OLD.skip_reason IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'rule_writer_requests: 생략된 시도는 바꿀 수 없습니다');
END;

CREATE TRIGGER rule_writer_requests_no_delete BEFORE DELETE ON rule_writer_requests
BEGIN
  SELECT RAISE(ABORT, 'rule_writer_requests: 시도 기록은 지울 수 없습니다');
END;
`,
};
