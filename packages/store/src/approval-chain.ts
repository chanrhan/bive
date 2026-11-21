// 승인 기록 해시 체인 (NFR-01, PRD 5.1, ADR-027 · ADR-050).
// 같은 사용자 권한의 다른 프로세스가 DB를 고치는 것은 완전히 막을 수 없으므로, 기록을 고치면 드러나게 한다.
// - hash = SHA-256( "bive-approval-log-v1\n" + 정규 JSON(hash를 뺀 필드 전부) ), 소문자 16진수
// - 정규 JSON: 객체 키를 사전순으로 정렬하고 공백 없이 직렬화한다. 값이 `undefined`인 키는 뺀다
// - prevHash = 바로 앞 기록의 hash. 첫 기록은 `APPROVAL_LOG_GENESIS_HASH`(0 64자)
import { createHash } from 'node:crypto';

import {
  APPROVAL_LOG_GENESIS_HASH,
  ApprovalLogEntry,
  type ApprovalLogBreakReason,
} from '@bive/shared';

/** 해시 입력의 형식 버전 접두. 형식을 바꾸면 올리고 검증은 버전별로 한다. */
export const APPROVAL_LOG_HASH_PREFIX = 'bive-approval-log-v1\n';

/** 해시 대상: 기록에서 `hash`를 뺀 전부. */
export type ApprovalLogHashInput = Omit<ApprovalLogEntry, 'hash'>;

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, normalize(v)]));
  }
  return value;
};

/** 키를 정렬한 결정적 JSON 문자열. 같은 값이면 키 순서와 무관하게 같은 문자열이다. */
export const canonicalJson = (value: unknown): string => JSON.stringify(normalize(value));

/**
 * 해시 체인 항목 1건의 해시: SHA-256(접두 + 정규 JSON(필드)), 소문자 16진수. 접두는 체인마다 다르다(도메인 구분):
 * 승인 기록과 규범 변경 기록은 같은 계산을 쓰되 접두가 달라, 한 체인의 항목 해시가 다른 체인에서 맞지 않는다 (ADR-103).
 */
export const chainHash = (prefix: string, fields: Record<string, unknown>): string =>
  createHash('sha256').update(prefix, 'utf8').update(canonicalJson(fields), 'utf8').digest('hex');

/** 승인 기록 1건의 해시를 계산한다. */
export const computeApprovalLogHash = (input: ApprovalLogHashInput): string => {
  const { seq, at, action, actor, targetRef, clientId, detail, prevHash } = input;
  return chainHash(APPROVAL_LOG_HASH_PREFIX, {
    seq,
    at,
    action,
    actor,
    targetRef,
    clientId,
    detail,
    prevHash,
  });
};

/** 체인 검증 실패 가운데 체인 자체에서 드러나는 것 (승인 기록 · 규범 변경 기록 공통). */
export type HashChainBreakReason = 'seq_gap' | 'prev_hash_mismatch' | 'hash_mismatch' | 'malformed';

export type HashChainVerification =
  | { valid: true; brokenAtSeq: null; reason: null }
  | { valid: false; brokenAtSeq: number; reason: HashChainBreakReason };

/**
 * 순번 순으로 정렬된 전체 기록의 체인을 검증한다 (아래 `verifyApprovalLogChain`과 같은 규칙, 체인마다 해시 · 형식 함수만 다르다).
 * 저장된 값을 스키마 검증 없이 받아 해시하고, 해시가 맞는 행의 형식을 마지막에 본다.
 */
export const verifyHashChain = <E extends { seq: number; prevHash: string; hash: string }>(
  entries: readonly E[],
  genesis: string,
  hashOf: (entry: E) => string,
  wellFormed: (entry: E) => boolean,
): HashChainVerification => {
  let prevHash = genesis;
  for (const [index, entry] of entries.entries()) {
    if (entry.seq !== index + 1) {
      return { valid: false, brokenAtSeq: entry.seq, reason: 'seq_gap' };
    }
    if (entry.prevHash !== prevHash) {
      return { valid: false, brokenAtSeq: entry.seq, reason: 'prev_hash_mismatch' };
    }
    if (hashOf(entry) !== entry.hash) {
      return { valid: false, brokenAtSeq: entry.seq, reason: 'hash_mismatch' };
    }
    if (!wellFormed(entry)) {
      return { valid: false, brokenAtSeq: entry.seq, reason: 'malformed' };
    }
    prevHash = entry.hash;
  }
  return { valid: true, brokenAtSeq: null, reason: null };
};

export type ChainBreakReason = ApprovalLogBreakReason;

export type ChainVerification =
  | { valid: true; brokenAtSeq: null; reason: null }
  | {
      valid: false;
      brokenAtSeq: number;
      reason: Exclude<ChainBreakReason, 'decision_without_log'>;
    }
  | { valid: false; brokenAtSeq: null; reason: 'decision_without_log'; proposalId: string };

/**
 * 순번 순으로 정렬된 전체 기록의 체인을 검증한다. 처음 어긋난 기록의 순번과 이유를 돌려준다.
 * 저장된 값을 스키마 검증 없이 받아 해시하고(고쳐진 행도 읽어야 한다), 해시가 맞는 행의 형식을 마지막에 본다.
 * - `seq_gap`: 순번이 1부터 1씩 늘지 않는다 (기록이 빠졌거나 끼어들었다)
 * - `prev_hash_mismatch`: 앞 기록의 해시와 다르다
 * - `hash_mismatch`: 내용이 해시와 맞지 않는다 (기록이 고쳐졌다)
 * - `malformed`: 해시는 맞지만 기록 형식이 깨졌다
 * 한계: 기준점(외부에 둔 마지막 해시)이 없으므로 끝 기록을 잘라 낸 것은 체인만으로 알 수 없다.
 * 저장소의 `ApprovalLogRepository.verify`가 처리된 제안과 대조해 일부를 잡는다 (ADR-050).
 */
export const verifyApprovalLogChain = (entries: readonly ApprovalLogEntry[]): ChainVerification =>
  verifyHashChain(
    entries,
    APPROVAL_LOG_GENESIS_HASH,
    computeApprovalLogHash,
    (entry) => ApprovalLogEntry.safeParse(entry).success,
  );
