import type { Migration } from '../../migrate.js';

/**
 * 확인 풀림 · 테스트 변경 알림의 DB 제약 (NFR-01 · NRM-07, ADR-100 D2 · D3 · I1 · C2 · G, M7-13 #225, ADR-113).
 * 표를 다시 만들지 않고 트리거만 더한다(0012의 `confirmations` · 0013의 `norm_changes` 정의 · 트리거는 그대로).
 * - `norm_changes_unconfirmed`: 확인 풀림 기록(`unconfirmed`)은 주체가 오케스트레이터이고 대상이 규칙이며, 원인 순번
 *   (`detail.unconfirm.causeSeq`)이 같은 규칙을 대상으로 한 폐기 · 대체 기록(`retired` · `superseded`)을 가리키고, 그 규칙이
 *   지금 확인됨이며, 같은 원인의 확인 풀림이 아직 없을 때만 받는다. 요구사항의 확인 풀림은 받지 않는다(에이전트가 요구사항을
 *   고치는 경로가 M7에 없다, ADR-100 A11)
 * - `norm_changes_test_changed`: 테스트 변경 알림(`test_changed`)은 주체가 오케스트레이터이고 대상이 규칙이며 연결 실행이
 *   있을 때만 받는다
 * - `confirmations_release_recorded`: 확인됨 → 미확인(확인 풀림)은 바로 앞에 남긴 마지막 규범 변경 기록이 그 대상의 확인 풀림
 *   기록일 때만 받는다(기록 없이 풀 수 없다). 미확인 → 확인됨은 0012의 CHECK가 확인한 주체를 사람으로만 받는다
 * `json_extract`가 NULL을 돌려 조건이 NULL이 되면 트리거가 건너뛰므로 조건 전체를 `coalesce(…, 0)`로 감싼다.
 */
export const migration: Migration = {
  version: 19,
  name: 'confirmation_release',
  up: `
CREATE TRIGGER norm_changes_unconfirmed BEFORE INSERT ON norm_changes
WHEN NEW.kind = 'unconfirmed' AND NOT coalesce((
  json_valid(NEW.actor) AND json_valid(NEW.target_ref) AND json_valid(NEW.detail)
  AND json_type(NEW.actor) = 'object'
  AND json_extract(NEW.actor, '$.kind') = 'orchestrator'
  AND json_extract(NEW.target_ref, '$.entity') = 'Rule'
  AND json_type(NEW.detail, '$.unconfirm.causeSeq') = 'integer'
  AND EXISTS (
    SELECT 1 FROM norm_changes AS cause
    WHERE cause.seq = json_extract(NEW.detail, '$.unconfirm.causeSeq')
      AND cause.kind IN ('retired', 'superseded')
      AND json_extract(cause.target_ref, '$.entity') = 'Rule'
      AND json_extract(cause.target_ref, '$.id') = json_extract(NEW.target_ref, '$.id')
  )
  AND EXISTS (
    SELECT 1 FROM confirmations AS c
    WHERE c.entity = 'Rule' AND c.target_id = json_extract(NEW.target_ref, '$.id')
      AND c.state = 'confirmed'
  )
  AND NOT EXISTS (
    SELECT 1 FROM norm_changes AS other
    WHERE other.kind = 'unconfirmed'
      AND json_extract(other.detail, '$.unconfirm.causeSeq') = json_extract(NEW.detail, '$.unconfirm.causeSeq')
  )
), 0)
BEGIN
  SELECT RAISE(ABORT, 'norm_changes: 확인 풀림은 오케스트레이터가 확인됨 규칙의 폐기 · 대체 기록 1건마다 한 번만 남깁니다');
END;

CREATE TRIGGER norm_changes_test_changed BEFORE INSERT ON norm_changes
WHEN NEW.kind = 'test_changed' AND NOT coalesce((
  json_valid(NEW.actor) AND json_valid(NEW.target_ref)
  AND json_type(NEW.actor) = 'object'
  AND json_extract(NEW.actor, '$.kind') = 'orchestrator'
  AND json_extract(NEW.target_ref, '$.entity') = 'Rule'
  AND NEW.run_id IS NOT NULL
), 0)
BEGIN
  SELECT RAISE(ABORT, 'norm_changes: 테스트 변경 알림은 오케스트레이터가 규칙 · 실행을 가리켜 남깁니다');
END;

CREATE TRIGGER confirmations_release_recorded BEFORE UPDATE ON confirmations
WHEN OLD.state = 'confirmed' AND NEW.state = 'unconfirmed' AND NOT coalesce((
  SELECT last.kind = 'unconfirmed'
    AND json_extract(last.target_ref, '$.entity') = OLD.entity
    AND json_extract(last.target_ref, '$.id') = OLD.target_id
  FROM norm_changes AS last
  ORDER BY last.seq DESC
  LIMIT 1
), 0)
BEGIN
  SELECT RAISE(ABORT, 'confirmations: 확인 풀림 기록 없이 확인을 풀 수 없습니다');
END;
`,
};
