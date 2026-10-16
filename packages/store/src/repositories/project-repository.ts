// 프로젝트 리포지토리 (PRJ-01). 입력 · 출력은 `@bive/shared`의 `Project` 스키마로 검증한다.
import { Project } from '@bive/shared';

import { withTransaction, type SqliteDatabase } from '../database.js';
import { ConflictError, NotFoundError, isUniqueViolation } from '../errors.js';

/** 수정할 수 있는 필드. ID · 생성 시각은 바꾸지 않는다. 모르는 필드는 거부한다. */
export const ProjectPatch = Project.pick({
  name: true,
  rootPath: true,
  baseBranch: true,
}).partial();
export type ProjectPatch = Partial<Pick<Project, 'name' | 'rootPath' | 'baseBranch'>>;

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  base_branch: string;
  created_at: string;
}

const COLUMNS = 'id, name, root_path, base_branch, created_at';

const toProject = (row: ProjectRow): Project =>
  Project.parse({
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    baseBranch: row.base_branch,
    createdAt: row.created_at,
  });

const toRow = (project: Project): ProjectRow => ({
  id: project.id,
  name: project.name,
  root_path: project.rootPath,
  base_branch: project.baseBranch,
  created_at: project.createdAt,
});

export class ProjectRepository {
  readonly #db: SqliteDatabase;
  readonly #insert;
  readonly #select;
  readonly #selectAll;
  readonly #update;
  readonly #delete;

  constructor(db: SqliteDatabase) {
    this.#db = db;
    this.#insert = db.prepare<[ProjectRow]>(
      `INSERT INTO projects (${COLUMNS}) VALUES (@id, @name, @root_path, @base_branch, @created_at)`,
    );
    this.#select = db.prepare<[string], ProjectRow>(`SELECT ${COLUMNS} FROM projects WHERE id = ?`);
    this.#selectAll = db.prepare<[], ProjectRow>(
      `SELECT ${COLUMNS} FROM projects ORDER BY created_at, id`,
    );
    this.#update = db.prepare<[ProjectRow]>(
      'UPDATE projects SET name = @name, root_path = @root_path, base_branch = @base_branch WHERE id = @id',
    );
    this.#delete = db.prepare<[string]>('DELETE FROM projects WHERE id = ?');
  }

  /**
   * 프로젝트를 저장한다.
   * @throws {ZodError} 스키마 위반
   * @throws {ConflictError} 같은 ID가 이미 있을 때
   */
  create(input: Project): Project {
    const project = Project.parse(input);
    try {
      this.#insert.run(toRow(project));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('프로젝트', project.id, '이미 있습니다', { cause: error });
      }
      throw error;
    }
    return project;
  }

  /** ID로 찾는다. 없으면 `null`. */
  get(id: string): Project | null {
    const row = this.#select.get(id);
    return row === undefined ? null : toProject(row);
  }

  /** 생성 시각 순(같으면 ID 순)으로 전부 돌려준다. */
  list(): Project[] {
    return this.#selectAll.all().map(toProject);
  }

  /**
   * 일부 필드를 바꾸고 바뀐 프로젝트를 돌려준다.
   * @throws {ZodError} 수정 값이 스키마 위반
   * @throws {NotFoundError} 없는 ID
   */
  update(id: string, patch: ProjectPatch): Project {
    const changes = ProjectPatch.parse(patch);
    return withTransaction(this.#db, () => {
      const current = this.get(id);
      if (current === null) throw new NotFoundError('프로젝트', id);
      const next = Project.parse({ ...current, ...changes });
      this.#update.run(toRow(next));
      return next;
    });
  }

  /** 지우고, 지웠으면 `true`. 없으면 `false`. */
  delete(id: string): boolean {
    return this.#delete.run(id).changes > 0;
  }
}
