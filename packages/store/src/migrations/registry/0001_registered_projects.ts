import type { Migration } from '../../migrate.js';

/**
 * 프로젝트 등록부. 등록된 프로젝트 ID와 등록 시각만 둔다.
 * 프로젝트 내용(이름 · 경로 · 기준 브랜치)의 원본은 프로젝트별 DB의 `projects` 행이다(같은 값을 두 곳에 두지 않는다).
 * 등록부 행은 프로젝트별 DB를 다 만든 뒤 마지막에 넣으므로, 등록부에 있는 ID = 등록이 끝난 프로젝트다.
 */
export const migration: Migration = {
  version: 1,
  name: 'registered_projects',
  up: `
CREATE TABLE registered_projects (
  project_id TEXT PRIMARY KEY NOT NULL CHECK (length(project_id) = 26),
  registered_at TEXT NOT NULL CHECK (length(registered_at) > 0)
) STRICT;
`,
};
