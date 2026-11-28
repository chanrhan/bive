import type { Migration } from '../../migrate.js';

/**
 * 규칙 분할 (TODO-02 · NRM-02 · NRM-07 · NFR-01, M3-57 #320, ADR-147 ⑧, ADR-153). 새 표 하나와 트리거만 더한다(기존 표를 다시 만들지
 * 않는다. `rule_retirements` · `review_items` · `judgments`는 그대로).
 * - `rule_splits(rule_id, position, new_rule_id)`: 분할로 폐기된 규칙 1개와 그것을 대체한 새 규칙들(만든 순서, 위치 1부터). 폐기 기록
 *   (`rule_retirements`, 0018)의 `superseded_by`는 값 1개라 첫 새 규칙을 담고, 나머지까지 모두 이 표가 잇는다. 새 규칙은 한 분할에만 든다
 * - 넣을 때(트리거): 그 규칙의 폐기 기록이 대체(`superseded_by` 있음)이고 짝 규범 변경 기록(`superseded`)의 분할 상세
 *   (`detail.retirement.split`)가 2개 이상이며 이 위치의 규칙이 이 행의 새 규칙이다. 위치는 1부터 빈틈없이 늘고, 위치 1은 폐기 기록의
 *   `superseded_by`다. 새 규칙은 있고 삭제 · 폐기되지 않았으며 내장이 아니고 부모 요구사항이 폐기된 규칙과 같다(부모를 물려받는다). 추가 전용
 * - 검토 대기열의 규칙 분할 처리(`split_rule`, 0028의 CHECK에 값이 이미 있다)는 처리 결과가 실제로 있어야 한다: `detail.ruleId`가 그 항목의
 *   실행의 대상 규칙이고, 그 규칙이 분할로 폐기돼 이 표에 새 규칙이 2개 이상이며 그 수가 분할 상세의 수와 같다(처리 결과 트리거, 0030의
 *   `review_items_resolve_raise_limit`과 같은 방식). 사람 아닌 주체는 0028의 CHECK가 먼저 거부하도록 이 트리거는 사람 주체의 처리만 본다
 * 머지된 0018 · 0021 · 0028 · 0030은 고치지 않는다.
 */
export const migration: Migration = {
  version: 31,
  name: 'rule_splits',
  up: `
CREATE TABLE rule_splits (
  rule_id TEXT NOT NULL REFERENCES rule_retirements (rule_id),
  position INTEGER NOT NULL CHECK (position >= 1),
  new_rule_id TEXT NOT NULL UNIQUE CHECK (length(new_rule_id) = 26) REFERENCES rules (id),
  PRIMARY KEY (rule_id, position),
  CHECK (new_rule_id <> rule_id)
) STRICT;

CREATE TRIGGER rule_splits_insert BEFORE INSERT ON rule_splits
WHEN NOT EXISTS (
  SELECT 1 FROM rule_retirements AS r
  JOIN norm_changes AS c ON c.seq = r.norm_change_seq
  JOIN rules AS split ON split.id = r.rule_id
  JOIN rules AS successor ON successor.id = NEW.new_rule_id
  WHERE r.rule_id = NEW.rule_id
    AND r.superseded_by IS NOT NULL
    AND c.kind = 'superseded'
    AND json_valid(c.detail)
    AND json_type(c.detail, '$.retirement.split') = 'array'
    AND json_array_length(c.detail, '$.retirement.split') >= 2
    AND json_extract(c.detail, '$.retirement.split[' || (NEW.position - 1) || '].rule.id') = NEW.new_rule_id
    AND NEW.position = 1 + (SELECT count(*) FROM rule_splits WHERE rule_id = NEW.rule_id)
    AND (NEW.position <> 1 OR r.superseded_by = NEW.new_rule_id)
    AND successor.deleted_at IS NULL
    AND successor.builtin = 0
    AND NOT EXISTS (SELECT 1 FROM rule_retirements WHERE rule_id = NEW.new_rule_id)
    AND split.parent_requirement_id IS NOT NULL
    AND successor.parent_requirement_id = split.parent_requirement_id
)
BEGIN
  SELECT RAISE(ABORT, 'rule_splits: 분할의 폐기 기록 · 규범 변경 기록과 맞지 않는 새 규칙입니다');
END;

CREATE TRIGGER rule_splits_no_update BEFORE UPDATE ON rule_splits
BEGIN
  SELECT RAISE(ABORT, 'rule_splits: 분할 기록은 바꿀 수 없습니다');
END;

CREATE TRIGGER rule_splits_no_delete BEFORE DELETE ON rule_splits
BEGIN
  SELECT RAISE(ABORT, 'rule_splits: 분할 기록은 지울 수 없습니다');
END;

CREATE TRIGGER review_items_resolve_split_rule BEFORE UPDATE ON review_items
WHEN OLD.resolved_at IS NULL AND NEW.kind = 'budget_exceeded' AND NEW.action = 'split_rule'
  AND json_valid(NEW.resolved_by) AND json_extract(NEW.resolved_by, '$.kind') = 'human'
  AND NOT (
    EXISTS (
      SELECT 1 FROM run_target_rules
      WHERE run_id = NEW.run_id AND rule_id = json_extract(NEW.detail, '$.ruleId')
    )
    AND (
      SELECT count(*) FROM rule_splits WHERE rule_id = json_extract(NEW.detail, '$.ruleId')
    ) >= 2
    AND (
      SELECT count(*) FROM rule_splits WHERE rule_id = json_extract(NEW.detail, '$.ruleId')
    ) = (
      SELECT json_array_length(c.detail, '$.retirement.split')
      FROM rule_retirements AS r JOIN norm_changes AS c ON c.seq = r.norm_change_seq
      WHERE r.rule_id = json_extract(NEW.detail, '$.ruleId')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'review_items: 규칙 분할 처리에는 그 항목의 실행의 대상 규칙이 새 규칙 2개 이상으로 대체된 분할 기록이 있어야 합니다');
END;
`,
};
