import type { Migration } from '../../migrate.js';

/**
 * 세션이 받은 규범 입력의 기록 (ADR-100 K1 · A15, ADR-106 · ADR-108, M7-08 #220).
 * - `norm_input`: 작업 지시에 실은 규범 입력의 수 · 잘린 사실 · 실은 표시 ID(JSON 객체, `@bive/shared`의 `SessionNormInput`).
 *   규칙 작성 · 테스트 작성 · 구현 세션이 열 때 행과 함께 쓴다. 규범 입력이 없는 세션과 이 마이그레이션 전 세션은 `NULL`
 * - 세션을 열 때 정해지고 바뀌지 않는다 (트리거). 형식 검증은 스키마와 리포지토리가 맡고 DB는 JSON 객체인지만 본다
 * `ALTER TABLE … ADD COLUMN`이라 표를 다시 만들지 않는다(기존 트리거 · 색인 그대로).
 */
export const migration: Migration = {
  version: 17,
  name: 'session_norm_input',
  up: `
ALTER TABLE sessions ADD COLUMN norm_input TEXT
  CHECK (norm_input IS NULL OR (json_valid(norm_input) AND json_type(norm_input) = 'object'));

CREATE TRIGGER sessions_norm_input_immutable BEFORE UPDATE ON sessions
WHEN NEW.norm_input IS NOT OLD.norm_input
BEGIN
  SELECT RAISE(ABORT, 'sessions: 세션의 규범 입력 기록은 바꿀 수 없습니다');
END;
`,
};
