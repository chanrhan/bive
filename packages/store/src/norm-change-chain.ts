// 규범 변경 기록 해시 체인 (NRM-07, NFR-01, ADR-100 C2 · A2, M7-02 #214, ADR-103).
// 승인 기록 체인(`approval-chain.ts`, ADR-027)과 같은 계산 · 검증을 쓰되 해시 입력의 접두(도메인 구분 값)가 다르다.
// - hash = SHA-256( "bive-norm-change-v1\n" + 정규 JSON(hash를 뺀 필드 전부) ), 소문자 16진수
// - prevHash = 바로 앞 기록의 hash. 첫 기록은 `NORM_CHANGE_GENESIS_HASH`(0 64자)
// 접두가 달라 한 체인의 항목을 다른 체인에 옮겨 넣으면 해시가 맞지 않는다(필드 모양이 같아도).
import { NORM_CHANGE_GENESIS_HASH, NormChangeEntry } from '@bive/shared';

import { APPROVAL_LOG_HASH_PREFIX, chainHash, verifyHashChain } from './approval-chain.js';
import type { HashChainVerification } from './approval-chain.js';

/** 해시 입력의 형식 버전 접두. 승인 기록 접두와 다르다. 형식을 바꾸면 올리고 검증은 버전별로 한다. */
export const NORM_CHANGE_HASH_PREFIX = 'bive-norm-change-v1\n';

// 두 체인의 접두가 같아지면 도메인 구분이 사라진다 (모듈을 읽을 때 바로 드러나게)
if ((NORM_CHANGE_HASH_PREFIX as string) === APPROVAL_LOG_HASH_PREFIX) {
  throw new Error('규범 변경 기록과 승인 기록의 해시 접두가 같습니다');
}

/** 해시 대상: 기록에서 `hash`를 뺀 전부. */
export type NormChangeHashInput = Omit<NormChangeEntry, 'hash'>;

/** 규범 변경 기록 1건의 해시를 계산한다. */
export const computeNormChangeHash = (input: NormChangeHashInput): string => {
  const { seq, at, kind, actor, targetRef, sessionId, runId, reason, detail, prevHash } = input;
  return chainHash(NORM_CHANGE_HASH_PREFIX, {
    seq,
    at,
    kind,
    actor,
    targetRef,
    sessionId,
    runId,
    reason,
    detail,
    prevHash,
  });
};

/**
 * 순번 순으로 정렬된 전체 규범 변경 기록의 체인을 검증한다(승인 기록과 같은 규칙: 순번 · 앞 해시 · 해시 · 형식).
 * 한계: 기준점(외부에 둔 마지막 해시)이 없으므로 끝 기록을 잘라 낸 것은 체인만으로 알 수 없다.
 */
export const verifyNormChangeChain = (entries: readonly NormChangeEntry[]): HashChainVerification =>
  verifyHashChain(
    entries,
    NORM_CHANGE_GENESIS_HASH,
    computeNormChangeHash,
    (entry) => NormChangeEntry.safeParse(entry).success,
  );
