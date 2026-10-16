// SQLite 연결 열기 · 트랜잭션 헬퍼 (better-sqlite3, ADR-028).
// 저장소 접근 주체는 오케스트레이터 프로세스 1개뿐이다 (architecture.md 2장).
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { NotFoundError, StoreError } from './errors.js';

/** better-sqlite3 연결. */
export type SqliteDatabase = Database.Database;

/** 다른 연결이 쓰기 잠금을 쥐고 있을 때 기다리는 시간(ms). */
export const BUSY_TIMEOUT_MS = 5000;

/** 저장소 디렉터리 권한. 같은 사용자만 읽고 쓴다 (architecture.md 3장, Windows는 무시). */
export const STORE_DIR_MODE = 0o700;

/** DB 파일 권한. 같은 사용자만 읽고 쓴다. SQLite가 만드는 `-wal` · `-shm`도 DB 파일 권한을 따른다 (Windows는 무시). */
export const STORE_FILE_MODE = 0o600;

export interface OpenDatabaseOptions {
  /** `false`면 파일이 없을 때 만들지 않고 `NotFoundError`. 기본 `true`. */
  readonly create?: boolean;
}

/**
 * DB 파일을 열고 연결 설정을 맞춘다.
 * - WAL 모드: 읽기와 쓰기가 서로 막지 않는다
 * - foreign_keys ON: 연결마다 켜야 한다 (SQLite 기본 OFF)
 * - synchronous FULL: 커밋이 디스크에 닿은 뒤 돌아온다 (무결성 우선, NFR-01)
 * - recursive_triggers ON: `REPLACE`가 지우는 행에도 DELETE 트리거가 돈다. 추가 전용 · 불변 테이블의 트리거를
 *   `INSERT OR REPLACE`로 우회하지 못하게 하는 이중 방어 (테이블마다 BEFORE INSERT 트리거도 있다, ADR-050)
 * - 파일 권한 0600 (Unix): 같은 사용자만 읽고 쓴다 (architecture.md 3장)
 * @throws {NotFoundError} `create: false`인데 파일이 없을 때
 */
export const openDatabase = (file: string, options: OpenDatabaseOptions = {}): SqliteDatabase => {
  const create = options.create ?? true;
  if (create) {
    mkdirSync(dirname(file), { recursive: true, mode: STORE_DIR_MODE });
  } else if (!existsSync(file)) {
    throw new NotFoundError('DB 파일', file);
  }
  const db = new Database(file, { fileMustExist: !create, timeout: BUSY_TIMEOUT_MS });
  try {
    // 파일은 umask대로(보통 0644) 만들어지므로 WAL 파일이 생기기 전에 좁힌다. 이미 있던 파일도 맞춘다
    if (process.platform !== 'win32') chmodSync(file, STORE_FILE_MODE);
    const mode: unknown = db.pragma('journal_mode = WAL', { simple: true });
    if (mode !== 'wal') {
      throw new StoreError(`WAL 모드로 바꾸지 못했습니다: ${String(mode)}`);
    }
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = FULL');
    db.pragma('recursive_triggers = ON');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
};

/**
 * 함수를 쓰기 트랜잭션(`BEGIN IMMEDIATE`) 안에서 실행한다. 예외가 나면 전부 되돌리고 예외를 다시 던진다.
 * 트랜잭션 안에서 다시 부르면 저장점(savepoint)으로 중첩된다. 함수는 동기여야 한다(Promise 반환 시 예외).
 */
export const withTransaction = <T>(db: SqliteDatabase, fn: () => T): T =>
  db.transaction(fn).immediate();
