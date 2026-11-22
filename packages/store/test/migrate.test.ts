import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { ApprovalLogRepository } from '../src/repositories/approval-log-repository.js';
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
      expect(store.db.pragma('recursive_triggers', { simple: true })).toBe(1);
      expect(listAppliedMigrations(store.db).map((m) => m.version)).toEqual(
        PROJECT_MIGRATIONS.map((m) => m.version),
      );
    } finally {
      store.close();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'DB 파일 · WAL 파일은 0600, 디렉터리는 0700 (umask와 무관)',
    () => {
      const id = newId();
      const previous = process.umask(0o022);
      try {
        const store = openProjectStore(id, { home: home() });
        try {
          store.requirements.create({
            id: newId(),
            text: '쓰기를 일으켜 WAL 파일을 만든다',
            author: { kind: 'human' },
            normState: 'approved',
            createdAt: fixedNow(),
          });
          expect(statSync(store.path).mode & 0o777).toBe(0o600);
          expect(statSync(`${store.path}-wal`).mode & 0o777).toBe(0o600);
          expect(statSync(dirname(store.path)).mode & 0o777).toBe(0o700);
        } finally {
          store.close();
        }
        // 이미 있던 파일의 권한이 넓어져 있어도 열 때 다시 좁힌다
        const path = bivePaths(home()).projectDb(id);
        chmodSync(path, 0o644);
        openProjectStore(id, { home: home(), create: false }).close();
        expect(statSync(path).mode & 0o777).toBe(0o600);

        const registry = openRegistry({ home: home() });
        try {
          expect(statSync(registry.path).mode & 0o777).toBe(0o600);
        } finally {
          registry.close();
        }
      } finally {
        process.umask(previous);
      }
    },
  );

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

  describe('외래 키 검사를 끄는 마이그레이션 (disableForeignKeys, 표 재구성용, ADR-105)', () => {
    const parentChild = m(
      1,
      'parent_child',
      `CREATE TABLE p (id INTEGER PRIMARY KEY) STRICT;
       CREATE TABLE c (id INTEGER PRIMARY KEY, p INTEGER NOT NULL REFERENCES p (id)) STRICT;
       INSERT INTO p (id) VALUES (1); INSERT INTO c (id, p) VALUES (10, 1);`,
    );
    const rebuild = (extra = ''): Migration => ({
      ...m(
        2,
        'rebuild_parent',
        `CREATE TABLE p_v2 (id INTEGER PRIMARY KEY, note TEXT) STRICT;
         INSERT INTO p_v2 (id) SELECT id FROM p ${extra};
         DROP TABLE p; ALTER TABLE p_v2 RENAME TO p;`,
      ),
      disableForeignKeys: true,
    });

    it('부모 표를 다시 만들어도 자식 행이 그대로 이어지고, 끝나면 외래 키 검사가 다시 켜진다', () => {
      withDb((db) => {
        migrate(db, [parentChild]);
        // 요청하지 않으면 켜진 외래 키 검사가 부모 표 삭제를 막는다 (이 재구성이 필요한 이유)
        expect(() =>
          migrate(db, [parentChild, { ...rebuild(), disableForeignKeys: false }]),
        ).toThrow(/FOREIGN KEY/);
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(migrate(db, [parentChild, rebuild()]).applied).toEqual([2]);
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(db.prepare('SELECT id, p FROM c').all()).toEqual([{ id: 10, p: 1 }]);
        expect(() => db.prepare('INSERT INTO c (id, p) VALUES (11, 99)').run()).toThrow(
          /FOREIGN KEY/,
        );
      });
    });

    it('재구성 뒤 외래 키 위반이 남으면 이번 실행분 전체를 되돌리고 외래 키 검사를 다시 켠다', () => {
      withDb((db) => {
        migrate(db, [parentChild]);
        const schema = schemaOf(db);
        expect(() => migrate(db, [parentChild, rebuild('WHERE id <> 1')])).toThrow(
          /외래 키 위반 1건/,
        );
        expect(listAppliedMigrations(db).map((r) => r.version)).toEqual([1]);
        expect(schemaOf(db)).toEqual(schema);
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      });
    });
  });
});

describe('0010 tool_call_empty_name: 빈 도구 이름 기록 (M2-11 #190, ADR-094)', () => {
  const SESSION = newId();
  const CALL = newId();
  const insertSession = (db: SqliteDatabase) =>
    db
      .prepare(
        `INSERT INTO sessions (id, role, model, work_dir, model_usage, tools, mcp_servers, started_at)
         VALUES (?, 'implementer', 'm', '/w', '{}', '[]', '[]', '2026-11-14T00:00:00.000Z')`,
      )
      .run(SESSION);
  const insertCall = (db: SqliteDatabase, id: string, seq: number, name: string) =>
    db
      .prepare(
        `INSERT INTO tool_calls (id, run_id, session_id, seq, at, role, name, args_summary, status, reason, duration_ms)
         VALUES (?, NULL, ?, ?, '2026-11-14T00:00:01.000Z', 'implementer', ?, '{}', 'denied', 'unknown_tool', 3)`,
      )
      .run(id, SESSION, seq, name);

  it('0009까지의 DB에 있던 기록은 값 · 순서 그대로 옮기고, 빈 이름을 받게 되며, 덮어쓰기 · 수정 · 삭제 금지 트리거와 색인은 그대로다', () => {
    withDb((db) => {
      migrate(db, PROJECT_MIGRATIONS.slice(0, 9), { now: fixedNow });
      insertSession(db);
      insertCall(db, CALL, 0, 'proposal.approve');
      // 0009까지는 빈 이름을 DB CHECK가 막는다 (기록이 사라지던 원인)
      expect(() => insertCall(db, newId(), 1, '')).toThrow(/CHECK/);
      const before = db.prepare('SELECT * FROM tool_calls').all();
      // 트리거 · 색인의 SQL 본문 (0006 때)
      const objectSql = () =>
        db
          .prepare(
            "SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'tool_calls' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY name",
          )
          .all();
      const sqlBefore = objectSql();
      expect(sqlBefore).toHaveLength(5);

      expect(migrate(db, PROJECT_MIGRATIONS.slice(0, 10), { now: fixedNow }).applied).toEqual([10]);
      expect(db.prepare('SELECT * FROM tool_calls').all()).toEqual(before);
      insertCall(db, newId(), 1, '');
      expect(db.prepare('SELECT seq, name FROM tool_calls ORDER BY seq').all()).toEqual([
        { seq: 0, name: 'proposal.approve' },
        { seq: 1, name: '' },
      ]);
      expect(() => insertCall(db, newId(), 1, 'x')).toThrow(/덮어쓰기 금지/);
      expect(() => db.prepare("UPDATE tool_calls SET name = 'y'").run()).toThrow(/바꿀 수 없/);
      expect(() => db.prepare('DELETE FROM tool_calls').run()).toThrow(/지울 수 없/);
      // 다른 칸의 CHECK는 그대로다
      expect(() =>
        db
          .prepare(
            `INSERT INTO tool_calls (id, run_id, session_id, seq, at, role, name, args_summary, status, reason, duration_ms)
             VALUES (?, NULL, ?, 5, '2026-11-14T00:00:01.000Z', 'implementer', 'a', '{}', 'maybe', NULL, 0)`,
          )
          .run(newId(), SESSION),
      ).toThrow(/CHECK/);
      const objects = db
        .prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'tool_calls' ORDER BY name")
        .all();
      expect(objects).toEqual(
        expect.arrayContaining([
          { type: 'table', name: 'tool_calls' },
          { type: 'index', name: 'tool_calls_run' },
          { type: 'index', name: 'tool_calls_session' },
          { type: 'trigger', name: 'tool_calls_no_delete' },
          { type: 'trigger', name: 'tool_calls_no_replace' },
          { type: 'trigger', name: 'tool_calls_no_update' },
        ]),
      );
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'tool_calls_v10%'").all(),
      ).toEqual([]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      // 트리거 3개 · 색인 2개의 SQL 본문은 0006과 글자까지 같다
      expect(objectSql()).toEqual(sqlBefore);
      // 이름의 NOT NULL은 그대로다 (빈 문자열만 받는다)
      expect(() =>
        db
          .prepare(
            `INSERT INTO tool_calls (id, run_id, session_id, seq, at, role, name, args_summary, status, reason, duration_ms)
             VALUES (?, NULL, ?, 6, '2026-11-14T00:00:01.000Z', 'implementer', NULL, '{}', 'denied', 'unknown_tool', 0)`,
          )
          .run(newId(), SESSION),
      ).toThrow(/NOT NULL/);
    });
  });
});

describe('0012 confirmations: 확인 상태 · 승인 기록 행동 넓히기 · 기존 데이터 이행 (M7-01 #213, ADR-100 A1 · A2, ADR-101)', () => {
  const T = (minute: number) => `2026-11-01T00:${String(minute).padStart(2, '0')}:00.000Z`;
  const human = '{"kind":"human"}';
  const ruleWriter = '{"kind":"agent","role":"rule-writer"}';
  const chat = '{"kind":"agent","role":"chat"}';

  /** 0011까지 적용한 DB에 요구사항을 바로 넣는다 (그때의 스키마 그대로). */
  const insertRequirement = (
    db: SqliteDatabase,
    row: { id: string; seq: number; author: string; updatedBy: string; deletedAt?: string },
  ) =>
    db
      .prepare(
        `INSERT INTO requirements (id, display_id, text, author, norm_state, unrulable_reason, created_at,
         updated_at, updated_by, deleted_at) VALUES (?, ?, '본문', ?, 'approved', NULL, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        `REQ-${String(row.seq).padStart(3, '0')}`,
        row.author,
        T(row.seq),
        T(row.seq + 30),
        row.updatedBy,
        row.deletedAt ?? null,
      );
  const insertRule = (db: SqliteDatabase, id: string, seq: number, parent: string) =>
    db
      .prepare(
        `INSERT INTO rules (id, display_id, title, statement, kind, check_kinds, parent_requirement_id,
         parent_detached_at, builtin, target_block_ids, risk, contract_id, author, norm_state, created_at,
         updated_at, deleted_at) VALUES (?, ?, '제목', '진술', 'business', '["test"]', ?, NULL, 0, '[]',
         NULL, NULL, ?, 'approved', ?, ?, NULL)`,
      )
      .run(id, `RULE-${String(seq).padStart(3, '0')}`, parent, ruleWriter, T(seq), T(seq));

  const logSql = (db: SqliteDatabase) =>
    db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'approval_log' AND type = 'trigger' ORDER BY name",
      )
      .all();
  const confirmationRows = (db: SqliteDatabase) =>
    db
      .prepare(
        'SELECT entity, target_id, state, confirmed_at, confirmed_by, basis FROM confirmations ORDER BY rowid',
      )
      .all();

  it('0011까지의 DB(규칙 · 요구사항 · 승인 기록 있음): 승인 기록은 값 · 해시 체인 그대로 옮기고, 사람이 OK한 것만 확인됨(근거 남김)으로 이행하며 승인 기록에 새 항목을 만들지 않는다', () => {
    withDb((db) => {
      migrate(db, PROJECT_MIGRATIONS.slice(0, 11), { now: fixedNow });
      const humanReq = newId(); // 사람이 씀
      const editedReq = newId(); // 에이전트가 쓰고(제안 승인 없이) 사람이 고침
      const agentReq = newId(); // 에이전트가 쓰고 아무도 보지 않음
      const approvedReq = newId(); // 요구사항 신규 제안을 사람이 승인
      const deletedAgentReq = newId(); // 에이전트가 쓴 것을 사람이 지움
      insertRequirement(db, { id: humanReq, seq: 1, author: human, updatedBy: human });
      insertRequirement(db, { id: editedReq, seq: 2, author: chat, updatedBy: human });
      insertRequirement(db, { id: agentReq, seq: 3, author: chat, updatedBy: chat });
      insertRequirement(db, { id: approvedReq, seq: 4, author: chat, updatedBy: chat });
      insertRequirement(db, {
        id: deletedAgentReq,
        seq: 5,
        author: chat,
        updatedBy: human,
        deletedAt: T(35),
      });
      const approvedRule = newId();
      const amendedRule = newId();
      const agentRule = newId(); // 제안 승인 없이 생긴 규칙
      insertRule(db, approvedRule, 1, humanReq);
      insertRule(db, amendedRule, 2, humanReq);
      insertRule(db, agentRule, 3, humanReq);
      // 0011 때의 승인 기록 (리포지토리가 순번 · 해시 체인을 만든다)
      const log = new ApprovalLogRepository(db);
      const proposal = () => ({ entity: 'Proposal' as const, id: newId() });
      log.append({
        at: T(40),
        action: 'approve',
        actor: { kind: 'human' },
        targetRef: proposal(),
        clientId: 'pipe-1',
        detail: { appliedRef: { entity: 'Rule', id: approvedRule } },
      });
      log.append({
        at: T(41),
        action: 'approve_edited',
        actor: { kind: 'human' },
        targetRef: proposal(),
        clientId: 'pipe-1',
        detail: {
          diff: { before: { title: '제목' }, after: { title: '고친 제목' } },
          appliedRef: { entity: 'Rule', id: amendedRule },
        },
      });
      log.append({
        at: T(42),
        action: 'reject',
        actor: { kind: 'human' },
        targetRef: proposal(),
        clientId: null,
        detail: { reason: '중복' },
      });
      log.append({
        at: T(43),
        action: 'approve',
        actor: { kind: 'human' },
        targetRef: proposal(),
        clientId: null,
        detail: { appliedRef: { entity: 'Requirement', id: approvedReq } },
      });
      log.append({
        at: T(44),
        action: 'run_start',
        actor: { kind: 'human' },
        targetRef: { entity: 'Run', id: newId() },
        clientId: null,
        detail: { ruleIds: [agentRule] },
      });
      // 0011까지는 확인 행동을 DB CHECK가 막는다
      expect(() =>
        db
          .prepare(
            `INSERT INTO approval_log (seq, at, action, actor, target_ref, client_id, detail, prev_hash, hash)
             VALUES (99, ?, 'confirm', ?, '{}', NULL, '{}', ?, ?)`,
          )
          .run(T(50), human, '0'.repeat(64), 'f'.repeat(64)),
      ).toThrow(/CHECK/);
      const rowsBefore = db.prepare('SELECT * FROM approval_log ORDER BY seq').all();
      const entriesBefore = log.list();
      expect(entriesBefore).toHaveLength(5);
      const triggersBefore = logSql(db);
      expect(triggersBefore).toHaveLength(3);

      expect(migrate(db, PROJECT_MIGRATIONS.slice(0, 12), { now: fixedNow }).applied).toEqual([12]);

      // 승인 기록: 행 · 순서 · 값 그대로, 새 항목 없음, 해시 체인 검증 통과, 트리거 SQL은 0003과 글자까지 같다
      expect(db.prepare('SELECT * FROM approval_log ORDER BY seq').all()).toEqual(rowsBefore);
      const migratedLog = new ApprovalLogRepository(db);
      expect(migratedLog.list()).toEqual(entriesBefore);
      expect(migratedLog.verify()).toEqual({ valid: true, brokenAtSeq: null, reason: null });
      expect(logSql(db)).toEqual(triggersBefore);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'approval_log_v12%'").all(),
      ).toEqual([]);
      expect(db.pragma('foreign_key_check')).toEqual([]);

      // 이행: 사람이 쓰거나 고친 요구사항(근거 = 작성 · 수정 기록) · 사람이 승인한 규범(근거 = 승인 기록 순번)만 확인됨
      const requirementRecord = (at: string) => JSON.stringify({ kind: 'requirement_record', at });
      const approvalSeq = (seq: number) => JSON.stringify({ kind: 'approval_log', seq });
      expect(confirmationRows(db)).toEqual([
        {
          entity: 'Requirement',
          target_id: humanReq,
          state: 'confirmed',
          confirmed_at: T(31),
          confirmed_by: human,
          basis: requirementRecord(T(31)),
        },
        {
          entity: 'Requirement',
          target_id: editedReq,
          state: 'confirmed',
          confirmed_at: T(32),
          confirmed_by: human,
          basis: requirementRecord(T(32)),
        },
        {
          entity: 'Rule',
          target_id: approvedRule,
          state: 'confirmed',
          confirmed_at: T(40),
          confirmed_by: human,
          basis: approvalSeq(1),
        },
        {
          entity: 'Rule',
          target_id: amendedRule,
          state: 'confirmed',
          confirmed_at: T(41),
          confirmed_by: human,
          basis: approvalSeq(2),
        },
        {
          entity: 'Requirement',
          target_id: approvedReq,
          state: 'confirmed',
          confirmed_at: T(43),
          confirmed_by: human,
          basis: approvalSeq(4),
        },
      ]);
      // 에이전트가 만든(제안 승인 없이 생긴) 항목은 미확인으로 남는다 (행 없음 = 기본 미확인)
      for (const id of [agentReq, deletedAgentReq, agentRule]) {
        expect(
          db.prepare('SELECT count(*) AS n FROM confirmations WHERE target_id = ?').get(id),
        ).toEqual({ n: 0 });
      }
    });
  });

  it('이행 뒤: 승인 기록이 확인 행동을 받고 체인이 이어지며, 저장소 조회에 확인 상태가 실린다', () => {
    const id = newId();
    const db = openDatabase(bivePaths(home()).projectDb(id));
    const humanReq = newId();
    const agentRule = newId();
    try {
      migrate(db, PROJECT_MIGRATIONS.slice(0, 11), { now: fixedNow });
      insertRequirement(db, { id: humanReq, seq: 1, author: human, updatedBy: human });
      insertRule(db, agentRule, 1, humanReq);
      new ApprovalLogRepository(db).append({
        at: T(40),
        action: 'run_start',
        actor: { kind: 'human' },
        targetRef: { entity: 'Run', id: newId() },
        clientId: null,
        detail: { ruleIds: [agentRule] },
      });
    } finally {
      db.close();
    }
    const store = openProjectStore(id, { home: home(), now: fixedNow });
    try {
      expect(store.requirements.get(humanReq)?.confirmation).toEqual({
        state: 'confirmed',
        at: T(31),
        by: { kind: 'human' },
        basis: { kind: 'requirement_record', at: T(31) },
      });
      expect(store.rules.get(agentRule)?.confirmation).toEqual({ state: 'unconfirmed' });
      const entry = store.approvalLog.append({
        at: T(50),
        action: 'confirm',
        actor: { kind: 'human' },
        targetRef: { entity: 'Rule', id: agentRule },
        clientId: null,
        detail: {},
      });
      expect(entry.seq).toBe(2);
      expect(entry.prevHash).toBe(store.approvalLog.list()[0]?.hash);
      expect(store.approvalLog.verify()).toEqual({ valid: true, brokenAtSeq: null, reason: null });
    } finally {
      store.close();
    }
  });

  it('0011까지의 빈 DB(규칙 · 요구사항 · 승인 기록 없음)에도 적용되고 확인 상태 행이 생기지 않는다', () => {
    withDb((db) => {
      migrate(db, PROJECT_MIGRATIONS.slice(0, 11), { now: fixedNow });
      expect(migrate(db, PROJECT_MIGRATIONS.slice(0, 12), { now: fixedNow }).applied).toEqual([12]);
      expect(confirmationRows(db)).toEqual([]);
      expect(db.prepare('SELECT count(*) AS n FROM approval_log').get()).toEqual({ n: 0 });
      expect(new ApprovalLogRepository(db).verify()).toEqual({
        valid: true,
        brokenAtSeq: null,
        reason: null,
      });
      expect(logSql(db)).toHaveLength(3);
    });
  });

  it('confirmations 표: 확인한 주체는 사람만, 없는 대상 · 덮어쓰기 · 대상 변경 · 삭제는 DB가 거부한다', () => {
    withDb((db) => {
      migrate(db, PROJECT_MIGRATIONS, { now: fixedNow });
      const req = newId();
      insertRequirement(db, { id: req, seq: 1, author: chat, updatedBy: chat });
      const insert = (target: string, by: string | null, state = 'confirmed') =>
        db
          .prepare(
            `INSERT INTO confirmations (entity, target_id, state, confirmed_at, confirmed_by, basis)
             VALUES ('Requirement', ?, ?, ?, ?, ?)`,
          )
          .run(
            target,
            state,
            state === 'confirmed' ? T(1) : null,
            by,
            state === 'confirmed' ? '{"kind":"approval_log","seq":1}' : null,
          );
      // 에이전트 주체의 확인됨 · 주체 없는 확인됨 · 근거 없는 미확인 외 값은 CHECK가 막는다
      expect(() => insert(req, ruleWriter)).toThrow(/CHECK/);
      expect(() => insert(req, null)).toThrow(/CHECK/);
      expect(() => insert(req, human, 'maybe')).toThrow(/CHECK/);
      // 없는 대상
      expect(() => insert(newId(), human)).toThrow(/없는 요구사항/);
      insert(req, human);
      expect(() => insert(req, human)).toThrow(/덮어쓰기 금지/);
      expect(() => db.prepare('UPDATE confirmations SET target_id = ?').run(newId())).toThrow(
        /대상은 바꿀 수 없/,
      );
      expect(() => db.prepare('DELETE FROM confirmations').run()).toThrow(/지울 수 없/);
      // 상태 값 변경(확인 풀림, M7-13)은 막지 않는다
      db.prepare(
        "UPDATE confirmations SET state = 'unconfirmed', confirmed_at = NULL, confirmed_by = NULL, basis = NULL",
      ).run();
      expect(confirmationRows(db)).toMatchObject([{ state: 'unconfirmed' }]);
    });
  });
});

describe('0014 rule_writer_daily_budget_skip: 생략 사유 프로젝트 하루 예산 초과 (M7-04 #216, ADR-104)', () => {
  const insertRequirement = (db: SqliteDatabase, id: string) =>
    db
      .prepare(
        `INSERT INTO requirements (id, display_id, text, author, norm_state, created_at, updated_at, updated_by)
         VALUES (?, 'REQ-001', '요구사항', '{"kind":"human"}', 'approved', '2026-11-21T00:00:00.000Z',
         '2026-11-21T00:00:00.000Z', '{"kind":"human"}')`,
      )
      .run(id);
  const insertAttempt = (db: SqliteDatabase, id: string, requirementId: string, reason: string) =>
    db
      .prepare(
        `INSERT INTO rule_writer_requests (id, requirement_id, requested_at, skip_reason, skip_detail, missing, skipped_at)
         VALUES (?, ?, '2026-11-21T00:00:01.000Z', ?, '설명', '[]', '2026-11-21T00:00:01.000Z')`,
      )
      .run(id, requirementId, reason);
  const objectSql = (db: SqliteDatabase) =>
    db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'rule_writer_requests' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY name",
      )
      .all();

  it('0013까지의 시도 기록은 값 그대로 옮기고, 새 생략 사유를 받게 되며, 트리거 · 색인 · 다른 CHECK는 그대로다', () => {
    withDb((db) => {
      migrate(db, PROJECT_MIGRATIONS.slice(0, 13), { now: fixedNow });
      const requirementId = newId();
      insertRequirement(db, requirementId);
      insertAttempt(db, newId(), requirementId, 'settings_incomplete');
      // 0013까지는 새 사유를 DB CHECK가 막는다
      expect(() =>
        insertAttempt(db, newId(), requirementId, 'project_daily_budget_exceeded'),
      ).toThrow(/CHECK/);
      const before = db.prepare('SELECT * FROM rule_writer_requests').all();
      const sqlBefore = objectSql(db);
      expect(sqlBefore).toHaveLength(5);

      expect(migrate(db, PROJECT_MIGRATIONS.slice(0, 14), { now: fixedNow }).applied).toEqual([14]);
      expect(db.prepare('SELECT * FROM rule_writer_requests').all()).toEqual(before);
      insertAttempt(db, newId(), requirementId, 'project_daily_budget_exceeded');
      expect(
        db.prepare('SELECT skip_reason FROM rule_writer_requests ORDER BY rowid').all(),
      ).toEqual([
        { skip_reason: 'settings_incomplete' },
        { skip_reason: 'project_daily_budget_exceeded' },
      ]);
      // 모르는 사유 · 덮어쓰기 · 생략된 시도 수정 · 삭제는 그대로 거부한다
      expect(() => insertAttempt(db, newId(), requirementId, 'budget')).toThrow(/CHECK/);
      const [first] = before as { id: string }[];
      expect(() => insertAttempt(db, first?.id ?? '', requirementId, 'closed')).toThrow(
        /덮어쓰기 금지/,
      );
      expect(() => db.prepare("UPDATE rule_writer_requests SET skip_detail = 'x'").run()).toThrow(
        /바꿀 수 없/,
      );
      expect(() => db.prepare('DELETE FROM rule_writer_requests').run()).toThrow(/지울 수 없/);
      // 트리거 4개 · 색인 1개의 SQL 본문은 0011과 글자까지 같다
      expect(objectSql(db)).toEqual(sqlBefore);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v14%'").all()).toEqual(
        [],
      );
      expect(db.pragma('foreign_key_check')).toEqual([]);
    });
  });
});

describe('0015 run_queue: 실행 대기 상태 · 프로젝트당 진행 중 1개 (M7-06 #218, ADR-100 B⑥, ADR-105)', () => {
  const T = (minute: number) => `2026-11-21T00:${String(minute).padStart(2, '0')}:00.000Z`;
  const human = '{"kind":"human"}';
  const SHA = 'c'.repeat(40);
  const BUDGET = '{"run":{"maxBudgetUsd":5,"maxTurns":100},"roles":{}}';

  /** 0014까지 적용한 DB에 그때의 스키마 그대로 요구사항 · 규칙을 넣는다. 규칙 ID를 돌려준다. */
  const seedNorms = (db: SqliteDatabase): string => {
    const req = newId();
    const rule = newId();
    db.prepare(
      `INSERT INTO requirements (id, display_id, text, author, norm_state, unrulable_reason, created_at,
       updated_at, updated_by, deleted_at) VALUES (?, 'REQ-001', '본문', ?, 'approved', NULL, ?, ?, ?, NULL)`,
    ).run(req, human, T(0), T(0), human);
    db.prepare(
      `INSERT INTO rules (id, display_id, title, statement, kind, check_kinds, parent_requirement_id,
       parent_detached_at, builtin, target_block_ids, risk, contract_id, author, norm_state, created_at,
       updated_at, deleted_at) VALUES (?, 'RULE-001', '제목', '진술', 'business', '["test"]', ?, NULL, 0, '[]',
       NULL, NULL, '{"kind":"agent","role":"rule-writer"}', 'approved', ?, ?, NULL)`,
    ).run(rule, req, T(0), T(0));
    return rule;
  };
  const insertRun = (
    db: SqliteDatabase,
    rule: string,
    row: { id: string; seq: number; status: string; mergeCommit?: string | null },
  ) => {
    const display = `EXE-${String(row.seq).padStart(3, '0')}`;
    db.prepare(
      `INSERT INTO runs (id, display_id, type, status, current_step, last_completed_step, regression_count,
       failure_reason, branch, worktree_path, base_branch, base_commit, head_commit, merge_commit, budget_snapshot,
       model_snapshot, cost_usd, turns, tool_manifest, started_by, created_at, started_at, ended_at)
       VALUES (?, ?, 'A', ?, 'implementation', 'red_check', 1, NULL, ?, ?, 'main', ?, ?, ?, ?, '{"implementer":"m"}',
       0.5, 7, '[]', ?, ?, ?, NULL)`,
    ).run(
      row.id,
      display,
      row.status,
      `bive/run-${display}`,
      `/w/${display}`,
      SHA,
      SHA,
      row.mergeCommit ?? null,
      BUDGET,
      human,
      T(row.seq),
      T(row.seq + 1),
    );
    db.prepare('INSERT INTO run_target_rules (run_id, rule_id, position) VALUES (?, ?, 0)').run(
      row.id,
      rule,
    );
  };
  const insertStep = (db: SqliteDatabase, runId: string, kind: string): string => {
    const id = newId();
    db.prepare(
      `INSERT INTO steps (id, run_id, kind, attempt, status, role, exit_detail, commit_sha, cost_usd, turns,
       started_at, ended_at) VALUES (?, ?, ?, 1, 'pending', NULL, '{}', NULL, NULL, NULL, ?, NULL)`,
    ).run(id, runId, kind, T(5));
    return id;
  };
  /** `runs` · `steps`의 색인 · 트리거 SQL. */
  const objectSql = (db: SqliteDatabase) =>
    db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('runs', 'steps') AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY name",
      )
      .all() as { type: string; name: string; sql: string }[];
  const tableSql = (db: SqliteDatabase, name: string): string =>
    (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as {
        sql: string;
      }
    ).sql;
  const setStatus = (db: SqliteDatabase, id: string, status: string) =>
    db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id);

  it('0014까지의 DB(실행 · 단계 · 세션 · 도구 호출 · 판정 있음): 실행 행은 값 · 순서 그대로, 자식 표의 행 · 외래 키 · 트리거 · 색인은 그대로이고 실행 대기를 받는다', () => {
    withDb((db) => {
      migrate(db, PROJECT_MIGRATIONS.slice(0, 14), { now: fixedNow });
      const rule = seedNorms(db);
      const merged = newId();
      const interrupted = newId();
      const waiting = newId();
      insertRun(db, rule, { id: merged, seq: 1, status: 'merged', mergeCommit: SHA });
      insertRun(db, rule, { id: interrupted, seq: 2, status: 'interrupted' });
      insertRun(db, rule, { id: waiting, seq: 3, status: 'waiting_approval' });
      const step = insertStep(db, interrupted, 'implementation');
      const session = newId();
      db.prepare(
        `INSERT INTO sessions (id, run_id, step_id, role, model, work_dir, model_usage, tools, mcp_servers, started_at)
         VALUES (?, ?, ?, 'implementer', 'm', '/w', '{}', '[]', '[]', ?)`,
      ).run(session, interrupted, step, T(6));
      db.prepare(
        `INSERT INTO tool_calls (id, run_id, session_id, seq, at, role, name, args_summary, status, reason, duration_ms)
         VALUES (?, ?, ?, 0, ?, 'implementer', 'read_file', '{}', 'ok', NULL, 3)`,
      ).run(newId(), interrupted, session, T(7));
      db.prepare(
        `INSERT INTO judgments (id, rule_id, run_id, step_id, commit_sha, judged_at, status, runner, exit_code,
         reporter_path, cases, quarantine_reason) VALUES (?, ?, ?, ?, ?, ?, 'pass', 'vitest', 0, NULL, '[]', NULL)`,
      ).run(newId(), rule, interrupted, step, SHA, T(8));
      // 0014까지는 실행 대기를 DB CHECK가 막는다
      expect(() => insertRun(db, rule, { id: newId(), seq: 9, status: 'queued' })).toThrow(/CHECK/);

      const rows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      const childTables = ['run_target_rules', 'steps', 'sessions', 'tool_calls', 'judgments'];
      const runsBefore = rows('runs');
      const childrenBefore = childTables.map(rows);
      const childSqlBefore = childTables.map((name) => tableSql(db, name));
      const sqlBefore = objectSql(db);
      const runsTableBefore = tableSql(db, 'runs');

      expect(migrate(db, PROJECT_MIGRATIONS.slice(0, 15), { now: fixedNow }).applied).toEqual([15]);

      // 행 · 순서 · 값 그대로, 자식 표의 행 · 정의(외래 키 `REFERENCES runs`) 그대로, 위반 없음, 외래 키 검사는 켜진 채
      expect(rows('runs')).toEqual(runsBefore);
      expect(childTables.map(rows)).toEqual(childrenBefore);
      expect(childTables.map((name) => tableSql(db, name))).toEqual(childSqlBefore);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'runs_v15%'").all(),
      ).toEqual([]);
      // 표 정의는 상태 CHECK에 실행 대기가 더해진 것뿐이다 (시작 주체의 사람 CHECK도 그대로, ADR-105)
      expect(tableSql(db, 'runs').replace(/^CREATE TABLE "runs"/, 'CREATE TABLE runs')).toBe(
        runsTableBefore.replace(
          "'waiting_approval', 'running'",
          "'queued', 'waiting_approval', 'running'",
        ),
      );
      expect(tableSql(db, 'runs')).toContain("json_extract(started_by, '$.kind') = 'human'");
      // 0005의 색인 · 트리거(steps 트리거 포함)는 글자까지 같고, 새 트리거는 진행 중 1개 방어 2개뿐이다
      const sqlAfter = objectSql(db);
      expect(sqlAfter.filter((o) => !o.name.startsWith('runs_one_running'))).toEqual(sqlBefore);
      expect(sqlAfter.map((o) => o.name).filter((n) => n.startsWith('runs_one_running'))).toEqual([
        'runs_one_running_insert',
        'runs_one_running_update',
      ]);

      // 옮긴 트리거가 그대로 동작한다: 종료된 실행 · 생성 정보 · 삭제 · 덮어쓰기 · 종료된 실행의 단계 · 외래 키
      expect(() => setStatus(db, merged, 'failed')).toThrow(/종료된 실행/);
      expect(() =>
        db.prepare("UPDATE runs SET base_branch = 'dev' WHERE id = ?").run(waiting),
      ).toThrow(/생성 정보/);
      expect(() => db.prepare('DELETE FROM runs WHERE id = ?').run(waiting)).toThrow(/지울 수 없/);
      expect(() =>
        insertRun(db, rule, { id: waiting, seq: 3, status: 'waiting_approval' }),
      ).toThrow(/덮어쓰기 금지/);
      expect(() => insertStep(db, merged, 'merge')).toThrow(/종료된 실행에는/);
      expect(() => insertStep(db, newId(), 'merge')).toThrow(/FOREIGN KEY/);
      // 사람 아닌 시작 주체는 그대로 거부 (CHECK를 넓히지 않았다)
      expect(() =>
        db
          .prepare(
            `INSERT INTO runs (id, display_id, type, status, regression_count, base_branch, budget_snapshot,
             model_snapshot, tool_manifest, started_by, created_at)
             VALUES (?, 'EXE-010', 'A', 'queued', 0, 'main', ?, '{}', '[]', '{"kind":"orchestrator"}', ?)`,
          )
          .run(newId(), BUDGET, T(10)),
      ).toThrow(/CHECK/);

      // 실행 대기를 받는다
      const queued4 = newId();
      const queued5 = newId();
      insertRun(db, rule, { id: queued4, seq: 4, status: 'queued' });
      insertRun(db, rule, { id: queued5, seq: 5, status: 'queued' });
      // 중단된 실행이 있으면 승인 대기 · 실행 대기는 진행 중이 될 수 없다
      expect(() => setStatus(db, queued4, 'running')).toThrow(/진행 중 · 중단된 실행/);
      expect(() => setStatus(db, waiting, 'running')).toThrow(/진행 중 · 중단된 실행/);
      // 중단 → 진행 중(재개)은 실행 대기가 있어도 된다. 그 뒤 진행 중은 1개뿐이다(갱신 · 삽입 모두)
      setStatus(db, interrupted, 'running');
      expect(() => setStatus(db, queued4, 'running')).toThrow(/진행 중/);
      expect(() => insertRun(db, rule, { id: newId(), seq: 11, status: 'running' })).toThrow(
        /진행 중인 실행이 이미/,
      );
      db.prepare("UPDATE runs SET status = 'merged', merge_commit = ? WHERE id = ?").run(
        SHA,
        interrupted,
      );
      // 생성 순: 먼저 만든 실행 대기가 있으면 뒤 실행 대기 · 승인 대기는 진행 중이 될 수 없다
      expect(() => setStatus(db, queued5, 'running')).toThrow(/먼저 기다리는 실행/);
      expect(() => setStatus(db, waiting, 'running')).toThrow(/먼저 기다리는 실행/);
      setStatus(db, queued4, 'running');
      expect(db.prepare("SELECT display_id FROM runs WHERE status = 'running'").all()).toEqual([
        { display_id: 'EXE-004' },
      ]);
    });
  });

  it('0014까지의 빈 DB에도 적용되고, 다시 실행해도 스키마가 같다', () => {
    withDb((db) => {
      migrate(db, PROJECT_MIGRATIONS.slice(0, 14), { now: fixedNow });
      expect(migrate(db, PROJECT_MIGRATIONS.slice(0, 15), { now: fixedNow }).applied).toEqual([15]);
      const schema = schemaOf(db);
      expect(migrate(db, PROJECT_MIGRATIONS.slice(0, 15), { now: fixedNow }).applied).toEqual([]);
      expect(schemaOf(db)).toEqual(schema);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    });
  });
});

describe('0016 run_auto_start: 실행 시작 주체에 오케스트레이터(원인 기록 순번) · 자동 시작 생략 기록 (M7-05 #217, ADR-100 A2 · C2, ADR-107)', () => {
  const T = (minute: number) => `2026-11-21T01:${String(minute).padStart(2, '0')}:00.000Z`;
  const human = '{"kind":"human"}';
  const SHA = 'd'.repeat(40);
  const BUDGET = '{"run":{"maxBudgetUsd":5,"maxTurns":100},"roles":{}}';

  const seedRule = (db: SqliteDatabase): string => {
    const req = newId();
    const rule = newId();
    db.prepare(
      `INSERT INTO requirements (id, display_id, text, author, norm_state, unrulable_reason, created_at,
       updated_at, updated_by, deleted_at) VALUES (?, 'REQ-001', '본문', ?, 'approved', NULL, ?, ?, ?, NULL)`,
    ).run(req, human, T(0), T(0), human);
    db.prepare(
      `INSERT INTO rules (id, display_id, title, statement, kind, check_kinds, parent_requirement_id,
       parent_detached_at, builtin, target_block_ids, risk, contract_id, author, norm_state, created_at,
       updated_at, deleted_at) VALUES (?, 'RULE-001', '제목', '진술', 'business', '["test"]', ?, NULL, 0, '[]',
       NULL, NULL, '{"kind":"agent","role":"rule-writer"}', 'approved', ?, ?, NULL)`,
    ).run(rule, req, T(0), T(0));
    return rule;
  };
  const insertRun = (
    db: SqliteDatabase,
    rule: string,
    row: {
      id: string;
      seq: number;
      status: string;
      startedBy?: string;
      mergeCommit?: string | null;
    },
  ) => {
    const display = `EXE-${String(row.seq).padStart(3, '0')}`;
    db.prepare(
      `INSERT INTO runs (id, display_id, type, status, current_step, last_completed_step, regression_count,
       failure_reason, branch, worktree_path, base_branch, base_commit, head_commit, merge_commit, budget_snapshot,
       model_snapshot, cost_usd, turns, tool_manifest, started_by, created_at, started_at, ended_at)
       VALUES (?, ?, 'A', ?, 'implementation', 'red_check', 1, NULL, ?, ?, 'main', ?, ?, ?, ?, '{"implementer":"m"}',
       0.5, 7, '[]', ?, ?, ?, NULL)`,
    ).run(
      row.id,
      display,
      row.status,
      `bive/run-${display}`,
      `/w/${display}`,
      SHA,
      SHA,
      row.mergeCommit ?? null,
      BUDGET,
      row.startedBy ?? human,
      T(row.seq),
      T(row.seq + 1),
    );
    db.prepare('INSERT INTO run_target_rules (run_id, rule_id, position) VALUES (?, ?, 0)').run(
      row.id,
      rule,
    );
  };
  const objectSql = (db: SqliteDatabase) =>
    db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('runs', 'steps') AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY name",
      )
      .all() as { type: string; name: string; sql: string }[];
  const tableSql = (db: SqliteDatabase, name: string): string =>
    (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as {
        sql: string;
      }
    ).sql;
  const setStatus = (db: SqliteDatabase, id: string, status: string) =>
    db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id);
  const OLD_STARTED_BY_CHECK =
    "json_valid(started_by) AND json_extract(started_by, '$.kind') = 'human'";
  /** 표 정의에서 시작 주체 칸의 정의를 자리표시자로 바꾼다 (나머지가 같은지 비교용). */
  const withoutStartedBy = (sql: string) =>
    sql.replace(
      /started_by TEXT NOT NULL CHECK \([\s\S]*?\n {2}\),\n {2}created_at/,
      'STARTED_BY,\n  created_at',
    );

  it('0015까지의 DB(사람이 시작한 실행 · 실행 대기 · 중단 · 단계 · 세션 · 도구 호출 · 판정): 행 · 자식 표 · 색인 · 트리거는 그대로이고 시작 주체 CHECK만 넓어진다', () => {
    withDb((db) => {
      migrate(db, PROJECT_MIGRATIONS.slice(0, 15), { now: fixedNow });
      const rule = seedRule(db);
      const merged = newId();
      const interrupted = newId();
      const waiting = newId();
      const queued = newId();
      insertRun(db, rule, { id: merged, seq: 1, status: 'merged', mergeCommit: SHA });
      insertRun(db, rule, { id: interrupted, seq: 2, status: 'interrupted' });
      insertRun(db, rule, { id: waiting, seq: 3, status: 'waiting_approval' });
      insertRun(db, rule, { id: queued, seq: 4, status: 'queued' });
      const step = newId();
      db.prepare(
        `INSERT INTO steps (id, run_id, kind, attempt, status, role, exit_detail, commit_sha, cost_usd, turns,
         started_at, ended_at) VALUES (?, ?, 'implementation', 1, 'pending', NULL, '{}', NULL, NULL, NULL, ?, NULL)`,
      ).run(step, interrupted, T(5));
      const session = newId();
      db.prepare(
        `INSERT INTO sessions (id, run_id, step_id, role, model, work_dir, model_usage, tools, mcp_servers, started_at)
         VALUES (?, ?, ?, 'implementer', 'm', '/w', '{}', '[]', '[]', ?)`,
      ).run(session, interrupted, step, T(6));
      db.prepare(
        `INSERT INTO tool_calls (id, run_id, session_id, seq, at, role, name, args_summary, status, reason, duration_ms)
         VALUES (?, ?, ?, 0, ?, 'implementer', 'read_file', '{}', 'ok', NULL, 3)`,
      ).run(newId(), interrupted, session, T(7));
      db.prepare(
        `INSERT INTO judgments (id, rule_id, run_id, step_id, commit_sha, judged_at, status, runner, exit_code,
         reporter_path, cases, quarantine_reason) VALUES (?, ?, ?, ?, ?, ?, 'pass', 'vitest', 0, NULL, '[]', NULL)`,
      ).run(newId(), rule, interrupted, step, SHA, T(8));
      // 0015까지는 오케스트레이터 주체를 DB CHECK가 막는다
      expect(() =>
        insertRun(db, rule, {
          id: newId(),
          seq: 9,
          status: 'waiting_approval',
          startedBy: '{"kind":"orchestrator","causeSeqs":[1]}',
        }),
      ).toThrow(/CHECK/);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'auto_start_skips'").all(),
      ).toEqual([]);

      const rows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      const childTables = ['run_target_rules', 'steps', 'sessions', 'tool_calls', 'judgments'];
      const runsBefore = rows('runs');
      const childrenBefore = childTables.map(rows);
      const childSqlBefore = childTables.map((name) => tableSql(db, name));
      const sqlBefore = objectSql(db);
      const runsTableBefore = tableSql(db, 'runs');
      expect(runsTableBefore).toContain(OLD_STARTED_BY_CHECK);

      expect(migrate(db, PROJECT_MIGRATIONS.slice(0, 16), { now: fixedNow }).applied).toEqual([16]);

      // 사람이 시작한 실행 · 실행 대기 · 중단 · 승인 대기 행은 값 · 순서 그대로, 자식 표의 행 · 정의 그대로, 위반 없음
      expect(rows('runs')).toEqual(runsBefore);
      expect(
        db.prepare('SELECT display_id, status, started_by FROM runs ORDER BY rowid').all(),
      ).toEqual([
        { display_id: 'EXE-001', status: 'merged', started_by: human },
        { display_id: 'EXE-002', status: 'interrupted', started_by: human },
        { display_id: 'EXE-003', status: 'waiting_approval', started_by: human },
        { display_id: 'EXE-004', status: 'queued', started_by: human },
      ]);
      expect(childTables.map(rows)).toEqual(childrenBefore);
      expect(childTables.map((name) => tableSql(db, name))).toEqual(childSqlBefore);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'runs_v16%'").all(),
      ).toEqual([]);
      // 표 정의는 시작 주체 CHECK만 바뀌었다
      const after = tableSql(db, 'runs').replace(/^CREATE TABLE "runs"/, 'CREATE TABLE runs');
      expect(after).not.toContain(OLD_STARTED_BY_CHECK);
      expect(withoutStartedBy(after)).toContain('STARTED_BY,');
      expect(withoutStartedBy(after)).toBe(
        withoutStartedBy(runsTableBefore.replace(/^CREATE TABLE "runs"/, 'CREATE TABLE runs')),
      );
      // 색인 · 트리거(0005의 것, 다시 만든 steps 트리거 2개, 0015의 진행 중 1개 방어 2개, 손대지 않은 steps의 것)는
      // 글자까지 같다
      expect(objectSql(db)).toEqual(sqlBefore);
      expect(objectSql(db).map((o) => o.name)).toEqual([
        'runs_identity_immutable',
        'runs_no_delete',
        'runs_no_replace',
        'runs_one_running_insert',
        'runs_one_running_update',
        'runs_status',
        'runs_terminal_final',
        'steps_final',
        'steps_identity_immutable',
        'steps_no_delete',
        'steps_no_replace',
        'steps_run',
        'steps_run_terminal_insert',
      ]);

      // 옮긴 트리거가 그대로 동작한다
      expect(() => setStatus(db, merged, 'failed')).toThrow(/종료된 실행/);
      expect(() =>
        db
          .prepare(
            `UPDATE runs SET started_by = '{"kind":"orchestrator","causeSeqs":[1]}' WHERE id = ?`,
          )
          .run(waiting),
      ).toThrow(/생성 정보/);
      expect(() => db.prepare('DELETE FROM runs WHERE id = ?').run(waiting)).toThrow(/지울 수 없/);
      expect(() =>
        insertRun(db, rule, { id: waiting, seq: 3, status: 'waiting_approval' }),
      ).toThrow(/덮어쓰기 금지/);
      expect(() => setStatus(db, queued, 'running')).toThrow(/진행 중 · 중단된 실행/);

      // 시작 주체: 사람, 또는 원인 기록 순번(정수 1개 이상)이 있는 오케스트레이터만
      let seq = 10;
      const tryStarter = (startedBy: string) => {
        seq += 1;
        insertRun(db, rule, { id: newId(), seq, status: 'waiting_approval', startedBy });
      };
      tryStarter(human);
      tryStarter('{"kind":"orchestrator","causeSeqs":[1]}');
      tryStarter('{"kind":"orchestrator","causeSeqs":[3,4]}');
      for (const rejected of [
        '{"kind":"orchestrator"}',
        '{"kind":"orchestrator","causeSeqs":null}',
        '{"kind":"orchestrator","causeSeqs":[]}',
        '{"kind":"orchestrator","causeSeqs":[0]}',
        '{"kind":"orchestrator","causeSeqs":[-1]}',
        '{"kind":"orchestrator","causeSeqs":[1.5]}',
        '{"kind":"orchestrator","causeSeqs":["1"]}',
        '{"kind":"orchestrator","causeSeqs":[null]}',
        '{"kind":"orchestrator","causeSeqs":1}',
        '{"kind":"orchestrator","causeSeqs":{"0":1}}',
        '{"kind":"agent","role":"implementer"}',
        '{"kind":null}',
        '{}',
        '"human"',
        '["human"]',
        'null',
        '1',
      ]) {
        expect(() => tryStarter(rejected), rejected).toThrow(/CHECK/);
      }
      expect(db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 7 });
    });
  });

  it('0015의 시작 주체 CHECK는 객체가 아닌 JSON을 통과시켰다(NULL 구멍): 그런 행이 있으면 0016은 전부 되돌리고 그 DB를 열지 않는다', () => {
    withDb((db) => {
      migrate(db, PROJECT_MIGRATIONS.slice(0, 15), { now: fixedNow });
      const rule = seedRule(db);
      // 0015에서는 json_extract('"human"', '$.kind')가 NULL이라 CHECK가 통과했다
      insertRun(db, rule, {
        id: newId(),
        seq: 1,
        status: 'waiting_approval',
        startedBy: '"human"',
      });
      const before = db.prepare('SELECT * FROM runs').all();
      expect(() => migrate(db, PROJECT_MIGRATIONS.slice(0, 16), { now: fixedNow })).toThrow();
      expect(listAppliedMigrations(db).map((m) => m.version)).toEqual(
        PROJECT_MIGRATIONS.slice(0, 15).map((m) => m.version),
      );
      expect(db.prepare('SELECT * FROM runs').all()).toEqual(before);
      expect(tableSql(db, 'runs')).toContain(OLD_STARTED_BY_CHECK);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });
  });

  it('auto_start_skips: 세션 1개에 1행, 사유 3종 · 설정 항목 배열만, 덮어쓰기 · 수정 · 삭제는 DB가 거부한다', () => {
    withDb((db) => {
      migrate(db, PROJECT_MIGRATIONS.slice(0, 16), { now: fixedNow });
      const insert = (sessionId: string, reason: string, missing = '[]') =>
        db
          .prepare(
            'INSERT INTO auto_start_skips (session_id, reason, missing, skipped_at) VALUES (?, ?, ?, ?)',
          )
          .run(sessionId, reason, missing, T(1));
      const session = newId();
      insert(session, 'project_daily_budget_unset');
      insert(newId(), 'project_daily_budget_exceeded');
      insert(newId(), 'settings_incomplete', '["roles.implementer.model"]');
      expect(() => insert(session, 'settings_incomplete')).toThrow(/덮어쓰기 금지/);
      expect(() =>
        db
          .prepare('INSERT OR REPLACE INTO auto_start_skips VALUES (?, ?, ?, ?)')
          .run(session, 'settings_incomplete', '[]', T(2)),
      ).toThrow(/덮어쓰기 금지/);
      expect(() =>
        db.prepare("UPDATE auto_start_skips SET reason = 'settings_incomplete'").run(),
      ).toThrow(/바꿀 수 없/);
      expect(() => db.prepare('DELETE FROM auto_start_skips').run()).toThrow(/지울 수 없/);
      expect(() => insert(newId(), 'closed')).toThrow(/CHECK/);
      expect(() => insert(newId(), 'settings_incomplete', '{}')).toThrow(/CHECK/);
      expect(() => insert('short', 'settings_incomplete')).toThrow(/CHECK/);
      expect(db.prepare('SELECT count(*) AS n FROM auto_start_skips').get()).toEqual({ n: 3 });
    });
  });

  it('0015까지의 빈 DB에도 적용되고, 다시 실행해도 스키마가 같다', () => {
    withDb((db) => {
      migrate(db, PROJECT_MIGRATIONS.slice(0, 15), { now: fixedNow });
      expect(migrate(db, PROJECT_MIGRATIONS.slice(0, 16), { now: fixedNow }).applied).toEqual([16]);
      const schema = schemaOf(db);
      expect(migrate(db, PROJECT_MIGRATIONS.slice(0, 16), { now: fixedNow }).applied).toEqual([]);
      expect(schemaOf(db)).toEqual(schema);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    });
  });
});

describe('0017 session_norm_input: 세션이 받은 규범 입력의 기록 (M7-08 #220, ADR-108)', () => {
  const insertSession = (db: SqliteDatabase, id: string, normInput?: string) =>
    normInput === undefined
      ? db
          .prepare(
            `INSERT INTO sessions (id, role, model, work_dir, model_usage, tools, mcp_servers, started_at)
             VALUES (?, 'rule-writer', 'm', '/w', '{}', '[]', '[]', '2026-11-22T00:00:00.000Z')`,
          )
          .run(id)
      : db
          .prepare(
            `INSERT INTO sessions (id, role, model, work_dir, model_usage, tools, mcp_servers, started_at, norm_input)
             VALUES (?, 'rule-writer', 'm', '/w', '{}', '[]', '[]', '2026-11-22T00:00:00.000Z', ?)`,
          )
          .run(id, normInput);

  it('0016까지의 세션 행은 값 그대로 남고 기록 칸은 NULL이며, 기존 트리거(끝난 세션 · 식별 정보 · 한도)는 그대로다', () => {
    withDb((db) => {
      migrate(db, PROJECT_MIGRATIONS.slice(0, 16), { now: fixedNow });
      const old = newId();
      insertSession(db, old);
      const before = db.prepare('SELECT * FROM sessions').get() as Record<string, unknown>;
      const triggers = () =>
        db
          .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'sessions' ORDER BY name",
          )
          .all() as { name: string; sql: string }[];
      const oldTriggers = triggers();
      expect(migrate(db, PROJECT_MIGRATIONS, { now: fixedNow }).applied).toEqual([17]);
      expect(db.prepare('SELECT * FROM sessions').get()).toEqual({ ...before, norm_input: null });
      // 기존 트리거는 SQL 그대로이고 기록 칸의 불변 트리거 하나만 더해진다
      const after = triggers();
      expect(after.filter((t) => t.name !== 'sessions_norm_input_immutable')).toEqual(oldTriggers);
      expect(after.map((t) => t.name)).toContain('sessions_norm_input_immutable');
      expect(after).toHaveLength(oldTriggers.length + 1);
      // 옛 행에도 나중에 기록을 채울 수 없다 (열 때 정해지는 값)
      expect(() =>
        db.prepare(`UPDATE sessions SET norm_input = '{}' WHERE id = ?`).run(old),
      ).toThrow(/규범 입력 기록은 바꿀 수 없습니다/);
      // 다른 칸의 갱신(끝내기)은 그대로 된다
      db.prepare(`UPDATE sessions SET end_reason = 'success' WHERE id = ?`).run(old);
      expect(() => db.prepare(`UPDATE sessions SET error = 'x' WHERE id = ?`).run(old)).toThrow(
        /끝난 세션은 바꿀 수 없습니다/,
      );
    });
  });

  it('기록은 JSON 객체만 받고, 다시 실행해도 스키마가 같다', () => {
    withDb((db) => {
      migrate(db, PROJECT_MIGRATIONS, { now: fixedNow });
      insertSession(db, newId(), '{"summary":{}}');
      for (const bad of ['[]', '"x"', '1', 'not json']) {
        expect(() => insertSession(db, newId(), bad)).toThrow(/CHECK/);
      }
      const schema = schemaOf(db);
      expect(migrate(db, PROJECT_MIGRATIONS, { now: fixedNow }).applied).toEqual([]);
      expect(schemaOf(db)).toEqual(schema);
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
