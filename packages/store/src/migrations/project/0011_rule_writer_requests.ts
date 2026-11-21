import type { Migration } from '../../migrate.js';

/**
 * 규칙 작성 시도 기록 (NRM-02, NFR-03, SCR-02, M3-26 #206, ADR-099).
 * - 요구사항 저장(또는 다시 시도) 때 규칙 작성 서비스가 중복이 아닌 시도 1개마다 행 1개를 만든다. 세션을 열면 같은 ID로
 *   `sessions` 행이 생기고(종료 사유 · 오류는 그쪽), 세션을 열지 않으면(설정 미비 · 종료 중 · 시작 실패 · 요구사항 없음)
 *   생략 사유 · 설명 · 비어 있던 설정 항목을 이 행에 한 번 채운다. 화면 · 조회는 이 행과 세션 행에서만 상태를 만든다
 * - 식별 정보(ID · 요구사항 · 받은 시각)는 바뀌지 않고, 생략이 채워진 행은 다시 바뀌지 않으며, 지우지 않는다
 *   (`sessions`와 같은 기록 규칙, ADR-050 · ADR-066). `INSERT OR REPLACE` 우회는 BEFORE INSERT 트리거가 막는다
 * 형식 검증은 `@bive/shared`의 `RuleWriterSkipReason` · `MissingSettingPath`와 리포지토리가 맡는다.
 */
export const migration: Migration = {
  version: 11,
  name: 'rule_writer_requests',
  up: `
CREATE TABLE rule_writer_requests (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  requirement_id TEXT NOT NULL REFERENCES requirements (id),
  requested_at TEXT NOT NULL CHECK (length(requested_at) > 0),
  skip_reason TEXT CHECK (skip_reason IS NULL OR skip_reason IN (
    'settings_incomplete', 'closed', 'start_failed', 'requirement_unavailable'
  )),
  skip_detail TEXT CHECK (skip_detail IS NULL OR length(skip_detail) > 0),
  missing TEXT NOT NULL CHECK (json_valid(missing) AND json_type(missing) = 'array'),
  skipped_at TEXT CHECK (skipped_at IS NULL OR length(skipped_at) > 0),
  CHECK ((skip_reason IS NULL) = (skipped_at IS NULL)),
  CHECK (skip_reason IS NOT NULL OR skip_detail IS NULL)
) STRICT;

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
