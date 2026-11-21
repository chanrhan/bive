// `normChange.*` 처리기 (NRM-07, NFR-01 · NFR-03, ADR-100 C2 · A2, M7-02 #214, ADR-103).
// - 조회 전용 RPC `normChange.list` 하나뿐이다. 기록은 오케스트레이터가 규범 변경과 같은 트랜잭션에서 남기고 쓰기 RPC는 없다
// - 사유 · 상세(만든 규칙의 제목 · 진술 등)는 에이전트가 쓴 글이라 문자열마다 표시용 표기와 길이 상한을 건 표시 값으로 내보낸다
//   (ADR-089). 저장된 기록은 바꾸지 않는다(원문 저장, 해시는 원문 기준)
// - 저장소 열림 구간은 동기다 (ADR-069)
import {
  NORM_CHANGE_TEXT_DISPLAY_MAX,
  type NormChangeDetail,
  type NormChangeEntry,
  type NormChangeListParams,
  type NormChangeListResult,
  type NormChangeView,
} from '@bive/shared';

import { displayText } from '../text-limit.js';
import { withProjectStore } from './project-store-access.js';
import type { MethodHandlers } from './server.js';

export interface NormChangeHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
}

type NormChangeMethods = Pick<MethodHandlers, 'normChange.list'>;

/** 값 안의 모든 문자열을 표시 값으로 바꾼다. 하나라도 잘리면 `truncated`를 켠다. */
const displayValue = (value: unknown, truncated: { value: boolean }): unknown => {
  if (typeof value === 'string') {
    const shown = displayText(value, NORM_CHANGE_TEXT_DISPLAY_MAX);
    if (shown.truncated) truncated.value = true;
    return shown.text;
  }
  if (Array.isArray(value)) return value.map((item) => displayValue(item, truncated));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, displayValue(item, truncated)]),
    );
  }
  return value;
};

/** 저장된 기록 → 응답 항목 (사유 · 상세의 문자열은 표시 값). */
export const normChangeView = (entry: NormChangeEntry): NormChangeView => {
  const truncated = { value: false };
  const reason = entry.reason === null ? null : (displayValue(entry.reason, truncated) as string);
  const detail = displayValue(entry.detail, truncated) as NormChangeDetail;
  return {
    seq: entry.seq,
    at: entry.at,
    kind: entry.kind,
    actor: entry.actor,
    targetRef: entry.targetRef,
    sessionId: entry.sessionId,
    runId: entry.runId,
    reason,
    detail,
    textTruncated: truncated.value,
    prevHash: entry.prevHash,
    hash: entry.hash,
  };
};

/** `normChange.list` 본체: 저장소만 읽는다. 없는 프로젝트는 -32004. */
export const readNormChanges = (
  biveHome: string,
  { projectId, targetRef }: NormChangeListParams,
): NormChangeListResult =>
  withProjectStore(biveHome, projectId, (store) => {
    const { valid, brokenAtSeq, reason } = store.normChanges.verify();
    return {
      entries: store.normChanges.list(targetRef).map(normChangeView),
      chain: { valid, brokenAtSeq, reason },
    };
  });

export const createNormChangeHandlers = ({
  biveHome,
}: NormChangeHandlerDeps): NormChangeMethods => ({
  'normChange.list': (params) => readNormChanges(biveHome, params),
});
