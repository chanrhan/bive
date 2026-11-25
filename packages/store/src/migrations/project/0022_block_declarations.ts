import type { Migration } from '../../migrate.js';

/**
 * 블록 선언 (NRM-09 · JDG-05 · DSN-01, ADR-005, M3-01 #46, ADR-122).
 * - `block_declarations`: 사람이 블록 선언을 저장할 때마다 1행(판). 판은 1부터 1씩 늘고 지금 선언은 가장 큰 판이다. 옛 판은
 *   남는다(바꾼 기록 = 판 목록: 누가 · 언제 · 무엇으로)
 * - 저장 주체는 사람(`{"kind":"human"}`)만 DB가 받는다(에이전트 · 오케스트레이터가 선언을 고쳐 구조 검사를 우회하지 못하게)
 * - 추가 전용: 판 건너뛰기 · 덮어쓰기(`REPLACE` 포함) · 수정 · 삭제를 트리거로 막는다
 * - 선언 본문(JSON 객체)의 모양 · 저장 규칙은 리포지토리가 shared 스키마(`BlockDeclaration`)로 본다
 * 기존 표는 다시 만들지 않는다(새 표만 더한다). 규칙의 대상 블록 · 위험도 칸은 0003의 `rules.target_block_ids` · `risk` 그대로다.
 */
export const migration: Migration = {
  version: 22,
  name: 'block_declarations',
  up: `
CREATE TABLE block_declarations (
  version INTEGER PRIMARY KEY NOT NULL CHECK (version >= 1),
  set_at TEXT NOT NULL CHECK (length(set_at) > 0),
  set_by TEXT NOT NULL CHECK (
    json_valid(set_by) AND json_type(set_by) = 'object' AND json_extract(set_by, '$.kind') = 'human'
  ),
  declaration TEXT NOT NULL CHECK (json_valid(declaration) AND json_type(declaration) = 'object')
) STRICT;

CREATE TRIGGER block_declarations_next_version BEFORE INSERT ON block_declarations
WHEN NEW.version IS NOT (SELECT coalesce(max(version), 0) + 1 FROM block_declarations)
BEGIN
  SELECT RAISE(ABORT, 'block_declarations: 블록 선언은 다음 판으로만 추가합니다 (덮어쓰기 · 건너뛰기 금지)');
END;

CREATE TRIGGER block_declarations_no_update BEFORE UPDATE ON block_declarations
BEGIN
  SELECT RAISE(ABORT, 'block_declarations: 블록 선언은 추가만 할 수 있습니다');
END;

CREATE TRIGGER block_declarations_no_delete BEFORE DELETE ON block_declarations
BEGIN
  SELECT RAISE(ABORT, 'block_declarations: 블록 선언은 추가만 할 수 있습니다');
END;
`,
};
