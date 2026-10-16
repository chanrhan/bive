import type { Migration } from '../../migrate.js';

/**
 * 프로젝트 행 (PRJ-01, architecture.md 3장 Project). 프로젝트별 DB에는 그 프로젝트의 행 1개만 둔다.
 * 시각은 ISO 8601 UTC 문자열. 형식 검증은 `@bive/shared`의 `Project` 스키마가 맡고, 여기서는 비어 있지 않음만 막는다.
 */
export const migration: Migration = {
  version: 1,
  name: 'projects',
  up: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 26),
  name TEXT NOT NULL CHECK (length(name) > 0),
  root_path TEXT NOT NULL CHECK (length(root_path) > 0),
  base_branch TEXT NOT NULL CHECK (length(base_branch) > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
) STRICT;
`,
};
