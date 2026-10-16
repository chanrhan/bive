import type { Migration } from '../../migrate.js';

/**
 * 요구사항 (NRM-01, architecture.md 3장 Requirement, ADR-047)과 표시 ID 순번.
 * - `requirements`: 프로젝트별 DB라서 프로젝트 ID 열은 두지 않는다. 주체(`author` · `updated_by`)는
 *   `{ kind, role? }` JSON 문자열. 삭제는 `deleted_at`을 채우는 소프트 삭제다 (NRM-07)
 * - `display_id_sequences`: 접두(`REQ` 등)별 마지막 순번. 삭제된 요구사항의 번호도 다시 쓰지 않는다.
 *   규칙 · 제안 등 다른 접두도 같은 테이블을 쓴다 (접두 목록 검증은 `@bive/shared`의 `DisplayIdPrefix`)
 * 형식 검증(ULID · 시각 · 표시 ID 형식)은 `@bive/shared`의 `Requirement` 스키마가 맡고, 여기서는 기본 제약만 둔다.
 */
export const migration: Migration = {
  version: 2,
  name: 'requirements',
  up: `
CREATE TABLE display_id_sequences (
  prefix TEXT PRIMARY KEY NOT NULL CHECK (length(prefix) > 0 AND prefix NOT GLOB '*[^A-Z]*'),
  last_seq INTEGER NOT NULL CHECK (last_seq >= 1)
) STRICT;

CREATE TABLE requirements (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  display_id TEXT NOT NULL UNIQUE CHECK (display_id GLOB 'REQ-[0-9][0-9][0-9]*'),
  text TEXT NOT NULL CHECK (length(text) > 0),
  author TEXT NOT NULL CHECK (json_valid(author)),
  norm_state TEXT NOT NULL CHECK (norm_state IN ('approved', 'provisional')),
  unrulable_reason TEXT CHECK (unrulable_reason IS NULL OR length(unrulable_reason) > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  updated_by TEXT NOT NULL CHECK (json_valid(updated_by)),
  deleted_at TEXT CHECK (deleted_at IS NULL OR length(deleted_at) > 0)
) STRICT;
`,
};
