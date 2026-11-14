// 규범 저장소 쓰기 장부 · 무결성 대조 (NFR-01, #117 기본 조치, ADR-052 한계 · ADR-069).
// 고정 도구의 경로 가드는 파일 도구만 막는다. `run_tests` · 판정이 실행하는 프로젝트 코드는 같은 OS 사용자 권한으로
// `bive.db`를 따로 열어 읽고 쓸 수 있다. 그래서 이 프로세스(오케스트레이터)가 `ProjectStore`로 한 쓰기만 믿는다:
// - 장부: DB 파일마다 "믿는 상태" = 모든 테이블(+ 스키마 · 트리거 정의)의 행 해시를 프로세스 메모리에 둔다.
//   DB에 두지 않는다(같은 경로로 고칠 수 있다)
// - `ProjectStore`를 열 때(`observeStoreState`) 지금 상태가 장부와 다르면 이 프로세스 밖의 변경이므로 사건으로 남기고
//   장부를 지금 상태로 맞춘다(같은 변경을 한 번만 남긴다). 장부가 없으면(프로세스 시작 뒤 처음) 지금 상태로 만든다
// - `ProjectStore`가 쓰고 닫을 때(`trustStoreState`) 지금 상태를 믿는 상태로 기록한다. 단, 연 뒤 다른 연결이 커밋했으면
//   (`PRAGMA data_version`이 바뀜: 자기 연결의 쓰기로는 바뀌지 않고 다른 연결의 커밋으로만 바뀜을 실측) 믿지 않고
//   `observeStoreState`로 사건을 남긴다(열려 있는 동안 끼어든 위조가 흡수되지 않게, 검토 2회차). 열 때 · 닫을 때 모두
//   `data_version`과 행 해시를 같은 읽기 트랜잭션(같은 스냅숏)에서 읽는다: 따로 읽으면 비교와 해시 사이에 커밋된 위조가
//   믿는 상태로 흡수된다(#146). 읽기 트랜잭션 안에서는 `data_version`도 행도 스냅숏에 고정된다(실측)
// - 감시(`beginNormWatch` · `verifyNormWatch`): 단계 실행기가 시작할 때 아직 보고되지 않은 사건부터 대조 대상으로 잡고,
//   대조할 때마다 다시 관찰해 그 뒤의 사건 · 깨진 승인 기록 체인 · 미래 시각 판정 기록을 불일치로 돌려준다
// 어느 테이블이든(규칙 행 추가 · 승인 기록 꼬리 추가 · 규칙 열 변경 · 판정 행 · 트리거 삭제) 오케스트레이터 밖에서 바뀌면
// 불일치다(fail closed). 오케스트레이터 자신의 쓰기(세션 · 도구 호출 기록, 사람의 승인 RPC)는 장부에 남아 불일치가 아니다.
import { createHash } from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from './approval-chain.js';
import type { SqliteDatabase } from './database.js';
import type { ProjectStore } from './project-store.js';

/** 장부 대조 결과 한 건. */
export interface NormMismatch {
  readonly kind: 'untrusted_change' | 'approval_chain_broken' | 'future_judgment' | 'unreadable';
  readonly detail: string;
}

/** 오케스트레이터 밖의 변경을 관찰한 사건. */
interface ForeignChange {
  readonly seq: number;
  readonly tables: readonly string[];
  readonly at: string;
}

interface Ledger {
  digests: Map<string, string>;
  events: ForeignChange[];
  nextSeq: number;
  /** 감시가 이미 보고한 사건의 다음 순번 (이보다 작은 사건은 새 감시의 대상이 아님) */
  reportedUntil: number;
}

const SCHEMA_KEY = '#schema';

/** 판정 시각을 미래로 볼 여유 (시계 차이). */
export const FUTURE_JUDGMENT_SKEW_MS = 60_000;

const ledgers = new Map<string, Ledger>();

const keyOf = (store: ProjectStore): string => path.resolve(store.path);

/** 테이블마다 모든 행(rowid 순)의 해시와 스키마(테이블 · 인덱스 · 트리거 정의) 해시. 행은 검증 없이 그대로 읽는다. */
export const tableDigests = (db: SqliteDatabase): Map<string, string> =>
  // 읽기 트랜잭션 하나 안에서 읽는다: 테이블마다 따로 읽으면 해시하는 도중 다른 연결의 커밋이 섞인다 (검토 2회차)
  db.transaction(() => readDigests(db))();

/**
 * `tableDigests`와 같은 해시를 트랜잭션 없이 읽는다. 호출자가 읽기 트랜잭션 안에서 부른다(같은 스냅숏에서
 * `PRAGMA data_version`과 함께 읽으려고, #146).
 */
export const readDigests = (db: SqliteDatabase): Map<string, string> => {
  const digests = new Map<string, string>();
  const schema = db
    .prepare<[], { type: string; name: string; tbl_name: string; sql: string | null }>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
  digests.set(SCHEMA_KEY, createHash('sha256').update(canonicalJson(schema)).digest('hex'));
  for (const { name, type } of schema) {
    if (type !== 'table') continue;
    const hash = createHash('sha256');
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`);
    for (const row of rows.iterate()) hash.update(canonicalJson(row)).update('\n');
    digests.set(name, hash.digest('hex'));
  }
  return digests;
};

const changedTables = (a: Map<string, string>, b: Map<string, string>): string[] =>
  [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key)).sort();

/**
 * 지금 상태를 장부와 대조한다. 다르면 사건으로 남기고 장부를 지금 상태로 맞춘다. 장부가 없으면 만든다.
 * `ProjectStore`를 열 때 부른다.
 */
export const observeStoreState = (
  store: ProjectStore,
  current: Map<string, string> = tableDigests(store.db),
): void => {
  const key = keyOf(store);
  const ledger = ledgers.get(key);
  if (ledger === undefined) {
    ledgers.set(key, { digests: current, events: [], nextSeq: 0, reportedUntil: 0 });
    return;
  }
  const tables = changedTables(ledger.digests, current);
  if (tables.length > 0) {
    ledger.events.push({ seq: ledger.nextSeq, tables, at: new Date().toISOString() });
    ledger.nextSeq += 1;
    ledger.digests = current;
  }
};

/**
 * 이 프로세스의 쓰기 뒤 상태(`digests`, 생략하면 지금 읽음)를 믿는 상태로 기록한다. `ProjectStore`가 쓰고 닫을 때
 * `data_version`과 같은 읽기 트랜잭션에서 읽은 해시를 넘긴다.
 */
export const trustStoreState = (
  store: ProjectStore,
  digests: Map<string, string> = tableDigests(store.db),
): void => {
  const key = keyOf(store);
  const ledger = ledgers.get(key);
  if (ledger === undefined) {
    ledgers.set(key, { digests, events: [], nextSeq: 0, reportedUntil: 0 });
  } else {
    ledger.digests = digests;
  }
};

/** 단계 실행기의 감시. 오케스트레이터 메모리에만 둔다. */
export interface NormWatch {
  readonly key: string;
  /** 이 순번부터의 사건을 보고한다 */
  readonly fromSeq: number;
}

/**
 * 감시를 시작한다. 아직 어떤 감시도 보고하지 않은 사건(단계 사이에 생긴 변경 포함)부터 대상으로 잡는다.
 */
export const beginNormWatch = (store: ProjectStore): NormWatch => {
  observeStoreState(store);
  const ledger = ledgers.get(keyOf(store));
  return { key: keyOf(store), fromSeq: ledger?.reportedUntil ?? 0 };
};

/**
 * 감시 시작 뒤(와 그 전에 보고되지 않은) 오케스트레이터 밖의 변경 · 깨진 승인 기록 체인 · 미래 시각 판정 기록을 돌려준다.
 * 빈 목록이면 믿는 상태 그대로다.
 */
export const verifyNormWatch = (
  store: ProjectStore,
  watch: NormWatch,
  now: number = Date.now(),
): NormMismatch[] => {
  if (keyOf(store) !== watch.key) {
    return [{ kind: 'unreadable', detail: '감시를 시작한 저장소와 다른 저장소입니다' }];
  }
  observeStoreState(store);
  const ledger = ledgers.get(watch.key);
  const mismatches: NormMismatch[] = [];
  for (const event of ledger?.events ?? []) {
    if (event.seq < watch.fromSeq) continue;
    mismatches.push({
      kind: 'untrusted_change',
      detail: `오케스트레이터 밖에서 바뀐 테이블: ${event.tables.join(', ')} (${event.at})`,
    });
  }
  if (ledger !== undefined) ledger.reportedUntil = Math.max(ledger.reportedUntil, ledger.nextSeq);
  const chain = store.approvalLog.verify();
  if (!chain.valid) {
    mismatches.push({
      kind: 'approval_chain_broken',
      detail: `승인 기록 해시 체인이 깨졌습니다: ${chain.reason}${chain.brokenAtSeq === null ? '' : ` (순번 ${String(chain.brokenAtSeq)})`}`,
    });
  }
  const limit = new Date(now + FUTURE_JUDGMENT_SKEW_MS).toISOString();
  const future = store.db
    .prepare<[string], { n: number }>('SELECT count(*) AS n FROM judgments WHERE judged_at > ?')
    .get(limit);
  if (future !== undefined && future.n > 0) {
    mismatches.push({
      kind: 'future_judgment',
      detail: `판정 시각이 미래인 판정 기록 ${String(future.n)}건`,
    });
  }
  return mismatches;
};

/** 시험용: 장부를 비운다 (프로세스 재시작 흉내). */
export const resetNormLedgerForTests = (): void => {
  ledgers.clear();
};
