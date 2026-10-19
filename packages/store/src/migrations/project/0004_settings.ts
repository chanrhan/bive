import type { Migration } from '../../migrate.js';

/**
 * 프로젝트 설정 (COST-01, NFR-07, SCR-21, architecture.md 3장 Settings, ADR-057).
 * - 프로젝트별 DB라서 행은 1개뿐이다(`singleton = 1`). 행이 없으면 한 번도 저장하지 않은 것이고
 *   리포지토리가 기본값(예산 · 모델 전부 미설정)을 돌려준다
 * - `body`는 `Settings`에서 프로젝트 ID · 변경 주체 · 시각을 뺀 JSON 객체(실행 전체 한도 · 역할별 모델 · 한도 ·
 *   승인 대기 상한 · 잠정 승인 정책 · 자동 모드 · 설치 허용 목록). 형식 검증은 `@bive/shared`의 `Settings`가 맡는다
 * - `updated_by`는 `{ kind: 'human' }` JSON 문자열 (변경 주체는 사람뿐, 오케스트레이터가 확인)
 */
export const migration: Migration = {
  version: 4,
  name: 'settings',
  up: `
CREATE TABLE settings (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  body TEXT NOT NULL CHECK (json_valid(body) AND json_type(body) = 'object'),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  updated_by TEXT NOT NULL CHECK (json_valid(updated_by))
) STRICT;
`,
};
