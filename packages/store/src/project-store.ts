// 프로젝트별 저장소 (`$BIVE_HOME/projects/<projectId>/bive.db`, ADR-005 · ADR-025 · NFR-01).
import type { Project, Ulid } from '@bive/shared';

import { openDatabase, withTransaction, type SqliteDatabase } from './database.js';
import { migrate, type MigrateOptions } from './migrate.js';
import { observeStoreState, readDigests, trustStoreState } from './norm-snapshot.js';
import { PROJECT_MIGRATIONS } from './migrations/project/index.js';
import { bivePaths, assertProjectId } from './paths.js';
import { ApprovalLogRepository } from './repositories/approval-log-repository.js';
import { DisplayIdSequences } from './repositories/display-id-sequences.js';
import { JudgmentRepository } from './repositories/judgment-repository.js';
import { ProjectRepository } from './repositories/project-repository.js';
import { ProposalRepository } from './repositories/proposal-repository.js';
import { RequirementRepository } from './repositories/requirement-repository.js';
import { RuleRepository } from './repositories/rule-repository.js';
import { RunRepository } from './repositories/run-repository.js';
import { SessionRepository } from './repositories/session-repository.js';
import { SettingsRepository } from './repositories/settings-repository.js';

export interface OpenStoreOptions extends MigrateOptions {
  /** 저장소 루트. 생략하면 `BIVE_HOME` 또는 `~/.bive`. */
  readonly home?: string;
  /** `false`면 DB가 없을 때 만들지 않고 `NotFoundError`. 기본 `true`. */
  readonly create?: boolean;
}

let closeProbeForTests: (() => void) | null = null;

/**
 * 시험 전용: 닫기가 `data_version`을 비교한 뒤 · 믿을 행 해시를 읽기 전에 부를 함수(다른 연결의 커밋을 그 순간에
 * 끼워 넣는다).
 * 제품 코드는 부르지 않는다. `null`이면 아무것도 하지 않는다.
 */
export const setCloseProbeForTests = (probe: (() => void) | null): void => {
  closeProbeForTests = probe;
};

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
  /** 실행 · 대상 규칙 · 단계 시도 (RUN-01, RUN-02). 상태 저장은 `runs.transition` 1회 = 트랜잭션 1회. */
  readonly runs: RunRepository;
  /** 에이전트 세션 · 도구 호출 기록 (RUN-04, NFR-02, ADR-066). 세션 도중에도 바로 남기는 기록이다. */
  readonly sessions: SessionRepository;
  /** 규칙 판정 기록 (JDG-01 · JDG-02, ADR-069). 추가만 하고 규칙의 최신 판정은 판정 시각 기준이다. */
  readonly judgments: JudgmentRepository;

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
    this.sessions = new SessionRepository(db);
    this.runs = new RunRepository(db, projectId, this.sequences, this.sessions);
    this.judgments = new JudgmentRepository(db);
  }

  /** 함수를 쓰기 트랜잭션 안에서 실행한다 (`withTransaction`). */
  transaction<T>(fn: () => T): T {
    return withTransaction(this.db, fn);
  }

  /** 이 저장소의 프로젝트 행. 아직 없으면 `null`. */
  getProject(): Project | null {
    return this.projects.get(this.projectId);
  }

  /** 열 때(장부 대조와 같은 읽기 트랜잭션에서) 읽은 `PRAGMA data_version`. 다른 연결이 커밋하면 바뀐다 */
  #dataVersion: number | null = null;

  /**
   * `data_version`을 기록하고 같은 읽기 트랜잭션(같은 스냅숏)에서 읽은 행 해시를 돌려준다 (`openProjectStore`가 부른다).
   * 기록한 `data_version`과 대조에 쓰는 해시가 같은 시점의 것이라 그 사이에 끼어든 커밋이 없다(#146).
   */
  markDataVersion(): Map<string, string> {
    return this.db.transaction(() => {
      this.#dataVersion = this.#readDataVersion();
      return readDigests(this.db);
    })();
  }

  #readDataVersion(): number {
    return Number(this.db.pragma('data_version', { simple: true }));
  }

  /**
   * 닫는다. 이 연결이 무언가를 썼으면 지금 상태를 쓰기 장부의 믿는 상태로 남긴다(`norm-snapshot.ts`, ADR-069).
   * 열 때 장부와 대조했고, 연 뒤 다른 연결의 커밋이 없으면(`data_version` 그대로) 연 뒤의 변경은 이 연결의 쓰기다.
   * 다른 연결의 커밋이 있었으면 믿지 않고 사건으로 남긴다(그 위조가 이 연결의 정상 쓰기와 함께 흡수되지 않게).
   * `data_version` 비교와 믿을 행 해시는 같은 읽기 트랜잭션에서 읽는다: 트랜잭션 안에서는 둘 다 스냅숏에 고정되므로
   * 비교 뒤에 다른 연결이 커밋해도 그 변경은 믿는 해시에 들어가지 않고 다음 열기의 대조가 사건으로 잡는다(#146 3차 검토:
   * 따로 읽으면 비교와 해시 사이의 커밋이 흡수됐다).
   */
  close(): void {
    try {
      if (this.db.open) {
        const changes = this.db.prepare<[], { n: number }>('SELECT total_changes() AS n').get();
        if (changes !== undefined && changes.n > 0) {
          const trusted = this.db.transaction(() => {
            const unchanged =
              this.#dataVersion !== null && this.#readDataVersion() === this.#dataVersion;
            closeProbeForTests?.();
            return unchanged ? readDigests(this.db) : null;
          })();
          if (trusted !== null) {
            trustStoreState(this, trusted);
          } else {
            observeStoreState(this);
          }
        }
      }
    } finally {
      this.db.close();
    }
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
    const store = new ProjectStore(projectId, path, db);
    // 쓰기 장부와 대조한다: 이 프로세스 밖의 변경은 사건으로 남는다 (ADR-069). data_version과 대조할 해시는 같은 읽기
    // 트랜잭션에서 읽는다. 그 뒤 다른 연결의 커밋은 닫을 때 바뀐 것으로 보여 믿지 않는 쪽(실패 쪽)으로 닫힌다
    observeStoreState(store, store.markDataVersion());
    return store;
  } catch (error) {
    db.close();
    throw error;
  }
};
