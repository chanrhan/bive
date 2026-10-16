// 마이그레이션 러너.
// - 마이그레이션 묶음(프로젝트 DB · 등록부 DB)마다 `src/migrations/<묶음>/<NNNN>_<name>.ts` 파일을 1부터 순서대로 둔다
// - 적용 기록은 `schema_migrations`(버전 · 이름 · SQL 해시 · 적용 시각)에 남긴다
// - 이미 적용된 마이그레이션은 다시 실행하지 않는다(멱등). 기록과 코드가 다르면 열지 않는다
// - 이번에 적용할 마이그레이션 전체를 트랜잭션 1개로 묶어, 실패하면 DB는 실행 전 버전 그대로다
import { createHash } from 'node:crypto';

import { withTransaction, type SqliteDatabase } from './database.js';
import { MigrationError } from './errors.js';

/** 마이그레이션 1건. 머지된 뒤에는 고치지 않고 새 버전을 추가한다(해시로 검사). */
export interface Migration {
  /** 1부터 1씩 증가하는 버전. 파일 이름의 `NNNN`과 같다. */
  readonly version: number;
  /** 소문자 snake_case 이름. 파일 이름의 `<name>`과 같다. */
  readonly name: string;
  /** 실행할 SQL. 여러 문장을 둘 수 있다. */
  readonly up: string;
}

/** `schema_migrations`의 행. */
export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrateResult {
  /** 이번 실행에서 적용한 버전 목록. 이미 최신이면 빈 배열. */
  readonly applied: readonly number[];
  /** 실행 뒤 DB의 버전 (적용된 최대 버전, 없으면 0). */
  readonly version: number;
}

export interface MigrateOptions {
  /** 적용 시각. 테스트에서 시계를 고정할 때 넘긴다. */
  readonly now?: () => string;
}

/** 적용 기록 테이블 이름. */
export const MIGRATIONS_TABLE = 'schema_migrations';

const MIGRATION_NAME_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

const CREATE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT`;

/** 마이그레이션 SQL의 SHA-256 해시 (16진수). */
export const migrationChecksum = (migration: Migration): string =>
  createHash('sha256').update(migration.up, 'utf8').digest('hex');

/**
 * 마이그레이션 목록이 규칙을 지키는지 확인한다: 버전 1부터 빈틈 없이 오름차순, 이름 snake_case, SQL 비어 있지 않음.
 * @throws {MigrationError}
 */
export const validateMigrations = (migrations: readonly Migration[]): void => {
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new MigrationError(
        `마이그레이션 버전은 1부터 빈틈 없이 증가해야 합니다: ${String(index + 1)}번째가 ${String(migration.version)}`,
      );
    }
    if (!MIGRATION_NAME_PATTERN.test(migration.name)) {
      throw new MigrationError(
        `마이그레이션 이름은 소문자 snake_case여야 합니다: ${migration.name}`,
      );
    }
    if (migration.up.trim() === '') {
      throw new MigrationError(`마이그레이션 SQL이 비어 있습니다: ${migration.name}`);
    }
  });
};

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

const tableExists = (db: SqliteDatabase, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
  undefined;

/** 적용 기록을 버전 순으로 읽는다. 기록 테이블이 없으면 빈 배열. */
export const listAppliedMigrations = (db: SqliteDatabase): AppliedMigration[] => {
  if (!tableExists(db, MIGRATIONS_TABLE)) return [];
  const rows = db
    .prepare(`SELECT version, name, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version`)
    .all() as AppliedRow[];
  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
};

/** 적용 기록이 코드의 마이그레이션 목록 앞부분과 정확히 같은지 확인한다. */
const assertAppliedMatches = (
  applied: readonly AppliedMigration[],
  migrations: readonly Migration[],
): void => {
  applied.forEach((record, index) => {
    if (record.version !== index + 1) {
      throw new MigrationError(
        `적용 기록에 빈 버전이 있습니다: ${String(index + 1)} 자리에 ${String(record.version)}`,
      );
    }
    const migration = migrations[index];
    if (migration === undefined) {
      throw new MigrationError(
        `DB가 코드보다 새 버전입니다 (DB ${String(applied.length)}, 코드 ${String(migrations.length)}). 이 DB는 열지 않습니다`,
      );
    }
    if (record.name !== migration.name || record.checksum !== migrationChecksum(migration)) {
      throw new MigrationError(
        `적용된 마이그레이션 ${String(record.version)}(${record.name})이 코드와 다릅니다. 머지된 마이그레이션은 고치지 않고 새 버전을 추가합니다`,
      );
    }
  });
};

/**
 * 아직 적용하지 않은 마이그레이션을 순서대로 적용한다. 두 번 실행해도 결과가 같다.
 * @throws {MigrationError} 목록 규칙 위반 · 적용 기록 불일치 · 외래 키 위반
 */
export const migrate = (
  db: SqliteDatabase,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): MigrateResult => {
  validateMigrations(migrations);
  const now = options.now ?? (() => new Date().toISOString());
  return withTransaction(db, () => {
    db.exec(CREATE_MIGRATIONS_TABLE);
    const applied = listAppliedMigrations(db);
    assertAppliedMatches(applied, migrations);

    const pending = migrations.slice(applied.length);
    const insert = db.prepare(
      `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
    );
    for (const migration of pending) {
      db.exec(migration.up);
      insert.run(migration.version, migration.name, migrationChecksum(migration), now());
    }
    if (pending.length > 0) {
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new MigrationError(
          `마이그레이션 뒤 외래 키 위반 ${String(violations.length)}건이 있습니다`,
        );
      }
    }
    return { applied: pending.map((m) => m.version), version: migrations.length };
  });
};
