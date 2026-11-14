import type { Migration } from '../../migrate.js';

/**
 * 코드 열람 기록 (MET-01, architecture.md 3장 CodeOpenRecord, M2-01 · ADR-084).
 * - `code_open_records`: 사람이 `file:line` 링크에서 사유를 골라 코드를 연 1회 = 행 1개. 앱(main)이 IDE를 열기 전에 남긴다
 * - 사유는 3종(`screen_error` · `info_lacking` · `debugging`), 출발 화면은 화면 ID(`SCR-01` ~ `SCR-21`),
 *   항목은 엔터티 이름 + ID, 파일은 프로젝트 루트 기준 상대 경로, 줄은 1 이상
 * - 시각은 밀리초 3자리 UTC(`toISOString` 모양)만 받아 문자열 비교가 시간 순서와 같게 한다 (judgments와 같음)
 * - 추가만 한다: 수정 · 삭제 · `INSERT OR REPLACE` 덮어쓰기는 트리거로 막는다 (지표 기록 무결성, judgments와 같은 방어)
 * 경로 형식(절대 경로 · `..` · 제어 문자 거부)의 검증은 `@bive/shared`의 `CodeOpenRecord` 스키마와 리포지토리가 맡는다.
 */
export const migration: Migration = {
  version: 9,
  name: 'code_open_records',
  up: `
CREATE TABLE code_open_records (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  at TEXT NOT NULL CHECK (
    at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  reason TEXT NOT NULL CHECK (reason IN ('screen_error', 'info_lacking', 'debugging')),
  source_screen TEXT NOT NULL CHECK (source_screen GLOB 'SCR-[0-2][0-9]'),
  item_entity TEXT NOT NULL CHECK (length(item_entity) > 0),
  item_id TEXT NOT NULL CHECK (length(item_id) > 0),
  file TEXT NOT NULL CHECK (length(file) > 0 AND substr(file, 1, 1) <> '/'),
  line INTEGER NOT NULL CHECK (line > 0)
) STRICT;

CREATE INDEX code_open_records_latest ON code_open_records (at, id);

CREATE TRIGGER code_open_records_no_replace BEFORE INSERT ON code_open_records
WHEN EXISTS (SELECT 1 FROM code_open_records WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'code_open_records: 같은 열람 기록이 이미 있습니다 (덮어쓰기 금지)');
END;

CREATE TRIGGER code_open_records_no_update BEFORE UPDATE ON code_open_records
BEGIN
  SELECT RAISE(ABORT, 'code_open_records: 열람 기록은 바꿀 수 없습니다');
END;

CREATE TRIGGER code_open_records_no_delete BEFORE DELETE ON code_open_records
BEGIN
  SELECT RAISE(ABORT, 'code_open_records: 열람 기록은 지울 수 없습니다');
END;
`,
};
