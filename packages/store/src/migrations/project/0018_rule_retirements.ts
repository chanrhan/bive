import type { Migration } from '../../migrate.js';

/**
 * 규칙 폐기 기록 (NRM-02 · NRM-06 · NRM-07 · JDG-03 · JDG-05, ADR-100 D5 · D6 · B⑨, M7-09 #221, ADR-112).
 * - `rule_retirements`: 폐기된 규칙 1개에 1행. 행이 있으면 그 규칙은 효력이 없다(규칙 행 · 판정 이력은 지우지 않는다).
 *   `superseded_by`가 있으면 대체(그 규칙이 이 규칙을 대신함), 없으면 폐기만. `norm_change_seq`는 같은 트랜잭션에서 남긴 규범
 *   변경 기록(`retired` · `superseded`)의 순번이다
 * - 되돌릴 수 없다: 덮어쓰기(`REPLACE` 포함) · 수정 · 삭제를 트리거로 막는다. 사람이 폐기를 되돌리는 길은 M5-08이 정한다
 * - 넣을 때 DB가 함께 보는 것(트리거): 대상 규칙이 있고 삭제되지 않았으며 내장 구조 규칙이 아님(B⑨), 대체한 규칙이 있고
 *   삭제 · 폐기되지 않음, 순번의 기록이 이 규칙을 대상으로 한 `retired`(대체 없음) 또는 `superseded`(대체 있음)임
 * `rules` 표는 다시 만들지 않는다(새 표만 더한다. 기존 표 · 트리거 · 색인 그대로).
 */
export const migration: Migration = {
  version: 18,
  name: 'rule_retirements',
  up: `
CREATE TABLE rule_retirements (
  rule_id TEXT PRIMARY KEY NOT NULL CHECK (length(rule_id) = 26) REFERENCES rules (id),
  retired_at TEXT NOT NULL CHECK (length(retired_at) > 0),
  superseded_by TEXT CHECK (superseded_by IS NULL OR length(superseded_by) = 26) REFERENCES rules (id),
  norm_change_seq INTEGER NOT NULL UNIQUE CHECK (norm_change_seq >= 1) REFERENCES norm_changes (seq),
  CHECK (superseded_by IS NULL OR superseded_by <> rule_id)
) STRICT;

CREATE INDEX rule_retirements_superseded_by ON rule_retirements (superseded_by);

CREATE TRIGGER rule_retirements_no_replace BEFORE INSERT ON rule_retirements
WHEN EXISTS (SELECT 1 FROM rule_retirements WHERE rule_id = NEW.rule_id OR norm_change_seq = NEW.norm_change_seq)
BEGIN
  SELECT RAISE(ABORT, 'rule_retirements: 이미 폐기된 규칙입니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER rule_retirements_live_rule BEFORE INSERT ON rule_retirements
WHEN NOT EXISTS (SELECT 1 FROM rules WHERE id = NEW.rule_id AND deleted_at IS NULL AND builtin = 0)
BEGIN
  SELECT RAISE(ABORT, 'rule_retirements: 없거나 삭제된 규칙 · 내장 구조 규칙은 폐기할 수 없습니다');
END;

CREATE TRIGGER rule_retirements_live_successor BEFORE INSERT ON rule_retirements
WHEN NEW.superseded_by IS NOT NULL AND (
  NOT EXISTS (SELECT 1 FROM rules WHERE id = NEW.superseded_by AND deleted_at IS NULL)
  OR EXISTS (SELECT 1 FROM rule_retirements WHERE rule_id = NEW.superseded_by)
)
BEGIN
  SELECT RAISE(ABORT, 'rule_retirements: 대체한 규칙이 없거나 효력이 없습니다');
END;

CREATE TRIGGER rule_retirements_norm_change BEFORE INSERT ON rule_retirements
WHEN NOT EXISTS (
  SELECT 1 FROM norm_changes
  WHERE seq = NEW.norm_change_seq
    AND kind = CASE WHEN NEW.superseded_by IS NULL THEN 'retired' ELSE 'superseded' END
    AND json_valid(target_ref)
    AND json_extract(target_ref, '$.entity') = 'Rule'
    AND json_extract(target_ref, '$.id') = NEW.rule_id
)
BEGIN
  SELECT RAISE(ABORT, 'rule_retirements: 폐기 · 대체의 규범 변경 기록이 없습니다');
END;

CREATE TRIGGER rule_retirements_no_update BEFORE UPDATE ON rule_retirements
BEGIN
  SELECT RAISE(ABORT, 'rule_retirements: 폐기는 되돌리거나 바꿀 수 없습니다');
END;

CREATE TRIGGER rule_retirements_no_delete BEFORE DELETE ON rule_retirements
BEGIN
  SELECT RAISE(ABORT, 'rule_retirements: 폐기는 되돌리거나 바꿀 수 없습니다');
END;
`,
};
