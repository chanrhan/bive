// 프로젝트별 저장소 (`$BIVE_HOME/projects/<projectId>/bive.db`, ADR-005 · ADR-025 · NFR-01).
// 실행 · 판정 등은 이후 이슈가 마이그레이션과 리포지토리를 이 저장소에 추가한다.
import type { Project, Ulid } from '@bive/shared';

import { openDatabase, withTransaction, type SqliteDatabase } from './database.js';
import { migrate, type MigrateOptions } from './migrate.js';
import { PROJECT_MIGRATIONS } from './migrations/project/index.js';
import { bivePaths, assertProjectId } from './paths.js';
import { ApprovalLogRepository } from './repositories/approval-log-repository.js';
import { DisplayIdSequences } from './repositories/display-id-sequences.js';
import { ProjectRepository } from './repositories/project-repository.js';
import { ProposalRepository } from './repositories/proposal-repository.js';
import { RequirementRepository } from './repositories/requirement-repository.js';
import { RuleRepository } from './repositories/rule-repository.js';
import { SettingsRepository } from './repositories/settings-repository.js';

export interface OpenStoreOptions extends MigrateOptions {
  /** 저장소 루트. 생략하면 `BIVE_HOME` 또는 `~/.bive`. */
  readonly home?: string;
  /** `false`면 DB가 없을 때 만들지 않고 `NotFoundError`. 기본 `true`. */
  readonly create?: boolean;
}

/** 열린 프로젝트별 저장소. 다 쓰면 `close()`를 부른다. */
export class ProjectStore {
  readonly projects: ProjectRepository;
  /** 표시 ID 순번 (`REQ-001` 등). 규칙 · 제안 리포지토리도 이것을 함께 쓴다. */
  readonly sequences: DisplayIdSequences;
  readonly requirements: RequirementRepository;
  /** 승인된 규칙 (NRM-02). 승인 전 제안은 `proposals`에만 있다 (NRM-04). */
  readonly rules: RuleRepository;
  readonly proposals: ProposalRepository;
  /** 추가 전용 승인 기록 · 해시 체인 (NFR-01, ADR-027). */
  readonly approvalLog: ApprovalLogRepository;
  /** 프로젝트 설정 1행 (예산 · 모델 등, COST-01 · NFR-07). */
  readonly settings: SettingsRepository;

  constructor(
    readonly projectId: Ulid,
    /** DB 파일의 절대 경로. */
    readonly path: string,
    readonly db: SqliteDatabase,
  ) {
    this.projects = new ProjectRepository(db);
    this.sequences = new DisplayIdSequences(db);
    this.requirements = new RequirementRepository(db, this.sequences);
    this.rules = new RuleRepository(db, this.sequences);
    this.proposals = new ProposalRepository(db, this.sequences);
    this.approvalLog = new ApprovalLogRepository(db);
    this.settings = new SettingsRepository(db, projectId);
  }

  /** 함수를 쓰기 트랜잭션 안에서 실행한다 (`withTransaction`). */
  transaction<T>(fn: () => T): T {
    return withTransaction(this.db, fn);
  }

  /** 이 저장소의 프로젝트 행. 아직 없으면 `null`. */
  getProject(): Project | null {
    return this.projects.get(this.projectId);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * 프로젝트별 DB를 열고(없으면 만들고) 마이그레이션을 적용한다.
 * @throws {TypeError} 프로젝트 ID가 ULID가 아닐 때
 * @throws {NotFoundError} `create: false`인데 DB가 없을 때
 * @throws {MigrationError} 적용 기록이 코드와 맞지 않을 때 (DB는 닫힌다)
 */
export const openProjectStore = (
  projectId: string,
  options: OpenStoreOptions = {},
): ProjectStore => {
  assertProjectId(projectId);
  const path = bivePaths(options.home).projectDb(projectId);
  const db = openDatabase(path, { create: options.create });
  try {
    migrate(db, PROJECT_MIGRATIONS, options);
    return new ProjectStore(projectId, path, db);
  } catch (error) {
    db.close();
    throw error;
  }
};
