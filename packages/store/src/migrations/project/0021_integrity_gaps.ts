import type { Migration } from '../../migrate.js';

/**
 * 무결성 틈 보강 (NFR-01 · NFR-02 · RUN-08, M3-36 #264, ADR-120). 표를 다시 만들지 않고 트리거와 새 표 하나만 더한다(0019와
 * 같은 방식). 기존 표의 정의 · 색인 · 트리거와 이미 있는 행은 그대로다: 새 제약은 새로 쓰는 행에만 걸린다(옛 행을 고치거나
 * 지우지 않는다. `approval_log` · `norm_changes`는 추가 전용이고 해시 체인은 행 값에서 계산하므로 그대로 검증된다).
 * 1. `runs`: 병합 완료(`merged`)로 들어가는 행은 병합 커밋(`merge_commit`)이 있어야 한다(넣기 · 바꾸기 트리거 2개). 이 변경
 *    전에 병합 커밋 없이 `merged`가 된 행은 종료 상태라 바뀌지 않으므로(0005 `runs_terminal_final`) 그대로 남는다
 * 2. `approval_log.actor`: 승인 기록의 주체는 사람(`{"kind":"human"}`, 다른 칸 없음)만 받는다(넣기 트리거). 0012의 표 CHECK는
 *    `json_valid`만 본다
 * 3. `rule_retirements`: 대체한 규칙은 효력이 있어야 하고(삭제 안 됨 · 폐기 안 됨(0018) · `norm_state = 'approved'`), 짝 기록의
 *    `detail.retirement.supersededBy`가 행과 같아야 한다(대체면 그 `id`가 `superseded_by`, 폐기만이면 JSON `null`). 넣기 트리거 2개.
 *    짝 기록이 없거나 종류 · 대상이 다른 경우는 0018의 `rule_retirements_norm_change`가 거부한다
 * 4. `run_test_change_checks`: 병합으로 끝난 실행마다 테스트 변경 알림 확인 1행(실행 ID가 키). 실행이 `merged`로 저장되는 같은
 *    문장에서 트리거가 `checked_at = NULL`(확인 전)로 넣고, 알림 기록과 같은 트랜잭션에서 확인 시각을 한 번 채운다. 기동 때
 *    확인 전 행의 실행만 되짚는다. 이 마이그레이션 전에 병합된 실행은 행이 없다(되짚지 않는다). 채운 시각은 바꿀 수 없고 행은
 *    지울 수 없다
 * `json_extract`가 NULL을 돌려 조건이 NULL이 되면 트리거가 건너뛰므로 조건을 `coalesce(…, 0)`로 감싸고, JSON이 아닌 값은
 * `CASE WHEN json_valid(…)`로 먼저 거른다.
 * 머지된 0003 · 0005 · 0012 · 0015 · 0016 · 0018은 고치지 않는다.
 */
export const migration: Migration = {
  version: 21,
  name: 'integrity_gaps',
  up: `
CREATE TRIGGER runs_merged_commit_insert BEFORE INSERT ON runs
WHEN NEW.status = 'merged' AND NEW.merge_commit IS NULL
BEGIN
  SELECT RAISE(ABORT, 'runs: 병합 완료 실행에는 병합 커밋이 있어야 합니다');
END;

CREATE TRIGGER runs_merged_commit_update BEFORE UPDATE ON runs
WHEN NEW.status = 'merged' AND NEW.merge_commit IS NULL
BEGIN
  SELECT RAISE(ABORT, 'runs: 병합 완료 실행에는 병합 커밋이 있어야 합니다');
END;

CREATE TRIGGER approval_log_actor_human BEFORE INSERT ON approval_log
WHEN NOT coalesce(CASE WHEN json_valid(NEW.actor) THEN json(NEW.actor) = '{"kind":"human"}' ELSE 0 END, 0)
BEGIN
  SELECT RAISE(ABORT, 'approval_log: 승인 기록의 주체는 사람이어야 합니다');
END;

CREATE TRIGGER rule_retirements_effective_successor BEFORE INSERT ON rule_retirements
WHEN NEW.superseded_by IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM rules WHERE id = NEW.superseded_by AND deleted_at IS NULL AND norm_state = 'approved'
)
BEGIN
  SELECT RAISE(ABORT, 'rule_retirements: 대체한 규칙이 효력 있는 규칙이 아닙니다');
END;

CREATE TRIGGER rule_retirements_norm_change_successor BEFORE INSERT ON rule_retirements
WHEN EXISTS (SELECT 1 FROM norm_changes WHERE seq = NEW.norm_change_seq) AND NOT coalesce((
  SELECT CASE
    WHEN NOT json_valid(detail) THEN 0
    WHEN NEW.superseded_by IS NULL THEN json_type(detail, '$.retirement.supersededBy') = 'null'
    ELSE json_type(detail, '$.retirement.supersededBy') = 'object'
      AND json_type(detail, '$.retirement.supersededBy.id') = 'text'
      AND json_extract(detail, '$.retirement.supersededBy.id') = NEW.superseded_by
  END
  FROM norm_changes WHERE seq = NEW.norm_change_seq
), 0)
BEGIN
  SELECT RAISE(ABORT, 'rule_retirements: 짝 기록의 대체한 규칙이 폐기 기록과 다릅니다');
END;

CREATE TABLE run_test_change_checks (
  run_id TEXT PRIMARY KEY NOT NULL CHECK (length(run_id) = 26) REFERENCES runs (id),
  checked_at TEXT CHECK (checked_at IS NULL OR length(checked_at) > 0)
) STRICT;

CREATE TRIGGER run_test_change_checks_insert BEFORE INSERT ON run_test_change_checks
WHEN NEW.checked_at IS NOT NULL
  OR NOT EXISTS (SELECT 1 FROM runs WHERE id = NEW.run_id AND status = 'merged')
  OR EXISTS (SELECT 1 FROM run_test_change_checks WHERE run_id = NEW.run_id)
BEGIN
  SELECT RAISE(ABORT, 'run_test_change_checks: 병합으로 끝난 실행마다 확인 전 행 하나만 둡니다');
END;

CREATE TRIGGER run_test_change_checks_update BEFORE UPDATE ON run_test_change_checks
WHEN NEW.run_id IS NOT OLD.run_id OR OLD.checked_at IS NOT NULL OR NEW.checked_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'run_test_change_checks: 확인 시각은 한 번만 채웁니다');
END;

CREATE TRIGGER run_test_change_checks_no_delete BEFORE DELETE ON run_test_change_checks
BEGIN
  SELECT RAISE(ABORT, 'run_test_change_checks: 확인 기록은 지울 수 없습니다');
END;

CREATE TRIGGER runs_merged_test_change_insert AFTER INSERT ON runs
WHEN NEW.status = 'merged'
BEGIN
  INSERT INTO run_test_change_checks (run_id, checked_at) VALUES (NEW.id, NULL);
END;

CREATE TRIGGER runs_merged_test_change_update AFTER UPDATE OF status ON runs
WHEN NEW.status = 'merged' AND OLD.status IS NOT 'merged'
BEGIN
  INSERT INTO run_test_change_checks (run_id, checked_at) VALUES (NEW.id, NULL);
END;
`,
};
