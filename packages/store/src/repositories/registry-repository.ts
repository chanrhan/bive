// 프로젝트 등록부 리포지토리 (`registry.db`의 `registered_projects`).
import { Timestamp, Ulid } from '@bive/shared';

import type { SqliteDatabase } from '../database.js';
import { ConflictError, isUniqueViolation } from '../errors.js';

/** 등록부 항목. 프로젝트 내용은 프로젝트별 DB에 있다. */
export interface RegistryEntry {
  readonly projectId: Ulid;
  readonly registeredAt: Timestamp;
}

/**
 * 등록부 항목을 검증한다 (ID는 ULID, 시각은 ISO 8601 UTC).
 * @throws {ZodError}
 */
export const parseRegistryEntry = (input: RegistryEntry): RegistryEntry => ({
  projectId: Ulid.parse(input.projectId),
  registeredAt: Timestamp.parse(input.registeredAt),
});

interface RegistryRow {
  project_id: string;
  registered_at: string;
}

const toEntry = (row: RegistryRow): RegistryEntry =>
  parseRegistryEntry({ projectId: row.project_id, registeredAt: row.registered_at });

export class RegistryRepository {
  readonly #insert;
  readonly #select;
  readonly #selectAll;
  readonly #delete;

  constructor(db: SqliteDatabase) {
    this.#insert = db.prepare<[RegistryRow]>(
      'INSERT INTO registered_projects (project_id, registered_at) VALUES (@project_id, @registered_at)',
    );
    this.#select = db.prepare<[string], RegistryRow>(
      'SELECT project_id, registered_at FROM registered_projects WHERE project_id = ?',
    );
    this.#selectAll = db.prepare<[], RegistryRow>(
      'SELECT project_id, registered_at FROM registered_projects ORDER BY registered_at, project_id',
    );
    this.#delete = db.prepare<[string]>('DELETE FROM registered_projects WHERE project_id = ?');
  }

  /**
   * 항목을 추가한다.
   * @throws {ZodError} 스키마 위반
   * @throws {ConflictError} 이미 등록된 ID
   */
  add(input: RegistryEntry): RegistryEntry {
    const entry = parseRegistryEntry(input);
    try {
      this.#insert.run({ project_id: entry.projectId, registered_at: entry.registeredAt });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('등록부 항목', entry.projectId, '이미 등록돼 있습니다', {
          cause: error,
        });
      }
      throw error;
    }
    return entry;
  }

  /** ID로 찾는다. 없으면 `null`. */
  get(projectId: string): RegistryEntry | null {
    const row = this.#select.get(projectId);
    return row === undefined ? null : toEntry(row);
  }

  /** 등록 시각 순(같으면 ID 순)으로 전부 돌려준다. */
  list(): RegistryEntry[] {
    return this.#selectAll.all().map(toEntry);
  }

  /** 항목만 지운다(프로젝트별 DB는 남는다). 지웠으면 `true`. */
  remove(projectId: string): boolean {
    return this.#delete.run(projectId).changes > 0;
  }
}
