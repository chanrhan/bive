import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../src/database.js';
import { MigrationError, NotFoundError } from '../src/errors.js';
import {
  listAppliedMigrations,
  migrate,
  migrationChecksum,
  type Migration,
} from '../src/migrate.js';
import { PROJECT_MIGRATIONS } from '../src/migrations/project/index.js';
import { REGISTRY_MIGRATIONS } from '../src/migrations/registry/index.js';
import { bivePaths } from '../src/paths.js';
import { openProjectStore } from '../src/project-store.js';
import { openRegistry } from '../src/registry.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();

/** 사용자 스키마 DDL (sqlite 내부 객체 제외). */
const schemaOf = (db: SqliteDatabase) =>
  db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();

const fixedNow = () => '2026-10-16T00:00:00.000Z';

const withDb = <T>(fn: (db: SqliteDatabase) => T): T => {
  const db = openDatabase(join(home(), 'test.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

describe('프로젝트별 DB 생성 · 마이그레이션', () => {
  it('임시 BIVE_HOME에 projects/<projectId>/bive.db를 만든다', () => {
    const id = newId();
    const store = openProjectStore(id, { home: home() });
    try {
      expect(store.path).toBe(join(home(), 'projects', id, 'bive.db'));
      expect(existsSync(store.path)).toBe(true);
      expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(store.db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(listAppliedMigrations(store.db).map((m) => m.version)).toEqual(
        PROJECT_MIGRATIONS.map((m) => m.version),
      );
    } finally {
      store.close();
    }
  });

  it('BIVE_HOME 환경 변수(임시 디렉터리)를 기본 경로로 쓴다', () => {
    const id = newId();
    openProjectStore(id).close();
    expect(existsSync(bivePaths(home()).projectDb(id))).toBe(true);
  });

  it('마이그레이션을 두 번 실행해도 스키마와 적용 기록이 같다', () => {
    const id = newId();
    const store = openProjectStore(id, { home: home(), now: fixedNow });
    try {
      const schemaAfterFirst = schemaOf(store.db);
      const appliedAfterFirst = listAppliedMigrations(store.db);
      expect(schemaAfterFirst.map((row) => (row as { name: string }).name)).toEqual(
        expect.arrayContaining(['projects', 'schema_migrations']),
      );

      const second = migrate(store.db, PROJECT_MIGRATIONS, {
        now: () => '2030-01-01T00:00:00.000Z',
      });
      expect(second.applied).toEqual([]);
      expect(second.version).toBe(PROJECT_MIGRATIONS.length);
      expect(schemaOf(store.db)).toEqual(schemaAfterFirst);
      expect(listAppliedMigrations(store.db)).toEqual(appliedAfterFirst);
    } finally {
      store.close();
    }
  });

  it('같은 DB를 다시 열어도 스키마가 같다', () => {
    const id = newId();
    const first = openProjectStore(id, { home: home() });
    const schema = schemaOf(first.db);
    first.close();
    const second = openProjectStore(id, { home: home() });
    try {
      expect(schemaOf(second.db)).toEqual(schema);
    } finally {
      second.close();
    }
  });

  it('create: false면 없는 DB를 만들지 않는다', () => {
    const id = newId();
    expect(() => openProjectStore(id, { home: home(), create: false })).toThrow(NotFoundError);
    expect(existsSync(bivePaths(home()).projectDir(id))).toBe(false);
  });

  it('등록부 DB도 같은 러너로 멱등하게 만든다', () => {
    const first = openRegistry({ home: home() });
    const schema = schemaOf(first.db);
    expect(first.path).toBe(join(home(), 'registry.db'));
    expect(migrate(first.db, REGISTRY_MIGRATIONS).applied).toEqual([]);
    expect(schemaOf(first.db)).toEqual(schema);
    first.close();
  });
});

describe('마이그레이션 러너 규칙', () => {
  const m = (version: number, name: string, up: string): Migration => ({ version, name, up });
  const base = [
    m(1, 'first', 'CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT;'),
    m(2, 'second', 'CREATE TABLE b (id INTEGER PRIMARY KEY) STRICT;'),
  ];

  it('새 마이그레이션만 순서대로 적용한다', () => {
    withDb((db) => {
      expect(migrate(db, base.slice(0, 1), { now: fixedNow }).applied).toEqual([1]);
      expect(migrate(db, base, { now: fixedNow }).applied).toEqual([2]);
      expect(listAppliedMigrations(db)).toEqual([
        { version: 1, name: 'first', checksum: migrationChecksum(base[0]!), appliedAt: fixedNow() },
        {
          version: 2,
          name: 'second',
          checksum: migrationChecksum(base[1]!),
          appliedAt: fixedNow(),
        },
      ]);
    });
  });

  it('버전이 1부터 빈틈 없이 증가하지 않으면 거부한다', () => {
    withDb((db) => {
      expect(() => migrate(db, [m(2, 'x', 'SELECT 1;')])).toThrow(MigrationError);
      expect(() => migrate(db, [base[0]!, m(3, 'x', 'SELECT 1;')])).toThrow(MigrationError);
      expect(() => migrate(db, [base[1]!, base[0]!])).toThrow(MigrationError);
    });
  });

  it('이름이 snake_case가 아니거나 SQL이 비면 거부한다', () => {
    withDb((db) => {
      expect(() => migrate(db, [m(1, 'Bad-Name', 'SELECT 1;')])).toThrow(MigrationError);
      expect(() => migrate(db, [m(1, 'empty', '  ')])).toThrow(MigrationError);
    });
  });

  it('적용된 마이그레이션의 SQL이 바뀌면 열지 않는다', () => {
    withDb((db) => {
      migrate(db, base);
      const edited = [base[0]!, m(2, 'second', 'CREATE TABLE b (id TEXT PRIMARY KEY) STRICT;')];
      expect(() => migrate(db, edited)).toThrow(/코드와 다릅니다/);
      const renamed = [base[0]!, m(2, 'renamed', base[1]!.up)];
      expect(() => migrate(db, renamed)).toThrow(MigrationError);
    });
  });

  it('DB가 코드보다 새 버전이면 열지 않는다', () => {
    withDb((db) => {
      migrate(db, base);
      expect(() => migrate(db, base.slice(0, 1))).toThrow(/새 버전/);
    });
  });

  it('실패한 마이그레이션은 이번 실행분 전체를 되돌린다', () => {
    withDb((db) => {
      const broken = [...base, m(3, 'broken', 'CREATE TABLE c (id INTEGER PRIMARY KEY); NOT SQL;')];
      expect(() => migrate(db, broken)).toThrow();
      expect(listAppliedMigrations(db)).toEqual([]);
      expect(schemaOf(db)).toEqual([]);
    });
  });
});

describe('마이그레이션 파일 규칙', () => {
  const dirOf = (set: string) =>
    fileURLToPath(new URL(`../src/migrations/${set}/`, import.meta.url));

  it.each([
    ['project', PROJECT_MIGRATIONS],
    ['registry', REGISTRY_MIGRATIONS],
  ] as const)('%s: 파일 이름 <NNNN>_<name>.ts가 목록의 버전 · 이름 · 순서와 같다', (set, list) => {
    const files = readdirSync(dirOf(set))
      .filter((file) => file !== 'index.ts')
      .sort();
    for (const file of files) expect(file).toMatch(/^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.ts$/);
    expect(files).toEqual(
      list.map((migration) => `${String(migration.version).padStart(4, '0')}_${migration.name}.ts`),
    );
  });
});
