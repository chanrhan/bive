// `ruleWriter.*` 처리기 (NRM-02, NFR-03, SCR-02, M3-26, ADR-062 · ADR-099).
// - 요구사항별 가장 최근 규칙 작성 시도를 읽는 조회 전용 RPC `ruleWriter.status` 하나뿐이다. 값은 저장된 시도 기록
//   (`rule_writer_requests`)과 세션 기록(`sessions`)에서만 만들고 오케스트레이터 메모리는 읽지 않는다(재기동 뒤에도 같다)
// - 오류 문장(생략 설명 · 세션 오류)은 어댑터 · SDK · 외부에서 온 문자열일 수 있어 표시용 표기와 길이 상한을 건다.
//   저장된 기록은 바꾸지 않는다 (ADR-089)
// - 정상 종료한 시도에는 실행 자동 시작 결과(`autoStart`)를 싣는다: 생략 기록(`auto_start_skips`) 또는 규범 변경 기록의
//   자동 시작 항목에서만 만든다 (M7-05 #217, ADR-107)
// - 저장소 열림 구간은 동기다 (ADR-069)
import {
  type NormChangeEntry,
  RULE_WRITER_ERROR_DISPLAY_MAX,
  type RuleWriterAutoStart,
  type RuleWriterStatusEntry,
  type RuleWriterStatusParams,
  type RuleWriterStatusResult,
} from '@bive/shared';
import type { ProjectStore, RuleWriterAttempt } from '@bive/store';

import { displayText } from '../text-limit.js';
import { withProjectStore } from './project-store-access.js';
import type { MethodHandlers } from './server.js';

export interface RuleWriterHandlerDeps {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
}

type RuleWriterMethods = Pick<MethodHandlers, 'ruleWriter.status'>;

/**
 * 시도 뒤의 실행 자동 시작 결과 (M7-05 #217, ADR-107). 정상 종료한 세션만 대상이다: 생략 기록이 있으면 생략, 그 세션이 만든
 * 규칙의 신규 기록을 원인으로 쓴 자동 시작 항목이 있으면 시작(그 실행), 아니면 없음.
 */
export const autoStartOf = (
  store: ProjectStore,
  attempt: RuleWriterAttempt,
  changes: readonly NormChangeEntry[],
): RuleWriterAutoStart | null => {
  if (attempt.state !== 'ended' || attempt.endReason !== 'success') return null;
  const skip = store.autoStartSkips.get(attempt.id);
  if (skip !== null) return { state: 'skipped', reason: skip.reason, missing: skip.missing };
  const causeSeqs = changes
    .filter((entry) => entry.kind === 'created' && entry.sessionId === attempt.id)
    .map((entry) => entry.seq);
  const started = changes.find(
    (entry) =>
      entry.kind === 'auto_start' &&
      (entry.detail.causeSeqs ?? []).some((seq) => causeSeqs.includes(seq)),
  );
  const run = started === undefined ? null : store.runs.get(started.targetRef.id);
  return run === null ? null : { state: 'started', runId: run.id, runDisplayId: run.displayId };
};

export const ruleWriterStatusEntry = (
  attempt: RuleWriterAttempt,
  autoStart: RuleWriterAutoStart | null = null,
): RuleWriterStatusEntry => {
  const error =
    attempt.error === null || attempt.error.length === 0
      ? null
      : displayText(attempt.error, RULE_WRITER_ERROR_DISPLAY_MAX);
  return {
    requirementId: attempt.requirementId,
    attemptId: attempt.id,
    state: attempt.state,
    skipReason: attempt.skipReason,
    missing: attempt.missing,
    endReason: attempt.endReason,
    error: error?.text ?? null,
    errorTruncated: error?.truncated ?? false,
    requestedAt: attempt.requestedAt,
    endedAt: attempt.endedAt,
    autoStart,
  };
};

/** `ruleWriter.status` 본체: 저장소만 읽는다. 없는 프로젝트는 -32004. */
export const readRuleWriterStatus = (
  biveHome: string,
  { projectId, requirementId }: RuleWriterStatusParams,
): RuleWriterStatusResult =>
  withProjectStore(biveHome, projectId, (store) => {
    const attempts =
      requirementId === undefined
        ? store.ruleWriterRequests.latestAll()
        : [store.ruleWriterRequests.latest(requirementId)].filter(
            (attempt): attempt is RuleWriterAttempt => attempt !== null,
          );
    const changes = store.normChanges.list();
    return {
      entries: attempts.map((attempt) =>
        ruleWriterStatusEntry(attempt, autoStartOf(store, attempt, changes)),
      ),
    };
  });

export const createRuleWriterHandlers = ({
  biveHome,
}: RuleWriterHandlerDeps): RuleWriterMethods => ({
  'ruleWriter.status': (params) => readRuleWriterStatus(biveHome, params),
});
