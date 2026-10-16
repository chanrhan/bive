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

/** 승인 기록 1건의 해시를 계산한다. */
export const computeApprovalLogHash = (input: ApprovalLogHashInput): string => {
  const { seq, at, action, actor, targetRef, clientId, detail, prevHash } = input;
  return createHash('sha256')
    .update(APPROVAL_LOG_HASH_PREFIX, 'utf8')
    .update(
      canonicalJson({ seq, at, action, actor, targetRef, clientId, detail, prevHash }),
      'utf8',
    )
    .digest('hex');
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
export const verifyApprovalLogChain = (entries: readonly ApprovalLogEntry[]): ChainVerification => {
  let prevHash = APPROVAL_LOG_GENESIS_HASH;
  for (const [index, entry] of entries.entries()) {
    if (entry.seq !== index + 1) {
      return { valid: false, brokenAtSeq: entry.seq, reason: 'seq_gap' };
    }
    if (entry.prevHash !== prevHash) {
      return { valid: false, brokenAtSeq: entry.seq, reason: 'prev_hash_mismatch' };
    }
    if (computeApprovalLogHash(entry) !== entry.hash) {
      return { valid: false, brokenAtSeq: entry.seq, reason: 'hash_mismatch' };
    }
    if (!ApprovalLogEntry.safeParse(entry).success) {
      return { valid: false, brokenAtSeq: entry.seq, reason: 'malformed' };
    }
    prevHash = entry.hash;
  }
  return { valid: true, brokenAtSeq: null, reason: null };
};
