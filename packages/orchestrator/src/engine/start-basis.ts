// 실행 시작 근거 대조 (NFR-01, ADR-061 · ADR-066 · ADR-100 A2 · C2, M7-05 #217 · M7-19 #244, ADR-107 · ADR-111).
// 엔진은 실행을 구동할 때마다(승인 단계 뒤 매 단계, 실행 대기 · 재개에서 시작할 때 포함) 그 실행의 시작 근거가 정확히 1건인지
// 본다. 근거는 둘 중 하나다:
// - 사람의 실행 시작 확인: 승인 기록 `run_start` 1건(대상 규칙이 실행과 같음), 시작 주체 사람, 자동 시작 항목 없음
// - 실행 자동 시작: 규범 변경 기록 `auto_start` 1건(주체 오케스트레이터, 대상 규칙이 실행과 같음), 시작 주체 오케스트레이터이고
//   실행의 대상 규칙과 주체의 원인 순번이 각각 정확히 1개이며(규칙마다 실행 1개, ADR-110 · ADR-111),
//   주체의 원인 순번이 그 항목의 원인 순번과 같으며, 원인 순번마다 그 순서의 대상 규칙을 만든 신규(`created`) 기록이 있고,
//   그 원인 순번을 다른 자동 시작 항목이 쓰지 않음(같은 원인으로 두 실행이 생기지 않는다), 승인 기록 `run_start` 없음
// 그 밖(0건 · 2건 이상 · 둘 다 · 다른 실행의 항목 · 실제 신규 기록이 아닌 원인)은 근거 없음이다 → `run_without_log`.
// 사람의 규칙 진술 편집으로 시작한 실행(시작 주체 `causeLog: 'approval_log'`, M7-03 #215 · ADR-109)은 자동 시작 항목의 원인이
// `ruleEditSeqs`(승인 기록 순번)이고, 그 순번이 대상 규칙 1개의 진술을 바꾼 사람의 `rule_edit` 기록이어야 하며 다른 자동 시작
// 항목이 같은 편집을 쓰지 않아야 한다(`ruleEditMismatch`).
// 기존 규칙 모순 · 이의 반영으로 끝난 실행의 대상 규칙을 다시 시작한 실행(M7-12 #224, ADR-118)은 원인이 그 끝난 실행의 첫 모순 판단
// (검사 실패 판단) · 첫 폐기 · 대체 판단(이의 판단)이고 대상 규칙이 그 끝난 실행의 대상 규칙이어야 한다. 원인은 끝난 실행마다 하나라
// 재사용은 "같은 원인 · 같은 대상 규칙" = "같은 끝난 실행 · 같은 대상 규칙"을 다른 항목이 쓸 때다.
// 위 두 갈래(신규 기록 · 다시 시작 원인)의 실행은 유형도 대조한다(M3-30 #245, ADR-151): 대상 규칙의 동작 선언이 기존 동작이면 유형 C,
// 새 동작 · 모름(선언 없는 옛 기록)이면 유형 A여야 한다(`type_mismatch`). 선언을 읽는 자리는 {@link declaredBehaviorOf} 하나다.
import {
  type NormChangeEntry,
  type Run,
  type RuleBehavior,
  type RunType,
  ruleStatementEditOf,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { restartCauseOf } from '../norms/check-contradiction.js';

/** 근거가 맞지 않는 이유 (`exitDetail.mismatch`). */
export type StartBasisMismatch =
  /** 근거 기록이 하나도 없음 */
  | 'no_entry'
  /** 같은 종류의 근거가 2건 이상 */
  | 'multiple_entries'
  /** 사람 `run_start`와 자동 시작 항목이 둘 다 있음 */
  | 'both_entries'
  /** 근거의 종류가 실행의 시작 주체와 다름 */
  | 'starter_mismatch'
  /** 오케스트레이터가 시작한 실행의 대상 규칙 또는 원인 순번이 1개가 아님 (규칙마다 실행 1개, ADR-111) */
  | 'not_single_rule'
  /** 근거의 대상 규칙이 실행의 대상 규칙과 다름 */
  | 'rules_mismatch'
  /**
   * 원인 순번이 시작 주체와 다르거나, 대상 규칙을 만든 실제 신규 기록 · 그 대상 규칙을 모순 대상으로 둔 기존 규칙 모순 판단(M7-12)이
   * 아님
   */
  | 'cause_mismatch'
  /** 같은 원인 순번을 다른 실행의 자동 시작 항목도 씀 */
  | 'cause_reused'
  /** 신규 기록 · 다시 시작 원인으로 시작한 실행의 유형이 대상 규칙의 동작 선언으로 고른 유형과 다름 (M3-30, ADR-151) */
  | 'type_mismatch';

export interface StartBasisCheck {
  /** 근거가 정확히 1건이고 실행과 맞으면 `null` */
  readonly mismatch: StartBasisMismatch | null;
  readonly runStartEntries: number;
  readonly autoStartEntries: number;
}

/**
 * 규칙의 동작 선언 (M3-30 #245, ADR-151): 그 규칙을 만든 신규 기록(`created`)의 `detail.behavior`. 선언을 읽는 자리는 이 함수
 * 하나다(실행 · 다른 기록에 복사하지 않는다). 신규 기록이 없거나 선언 칸이 없으면(이 변경 전의 기록, 사람 · 오케스트레이터가 만든
 * 규칙) `null` = 모름.
 * 사람이 그 규칙의 진술을 고친 적이 있으면(승인 기록 `rule_edit` 가운데 진술이 바뀐 것, `ruleStatementEditOf`, 제목만 고친 편집은 아님,
 * ADR-109) 선언은 옛 진술에 대한 판단이므로 모름으로 읽는다(조율자 결정, 유형 A: Red 확인을 거친다).
 */
export const declaredBehaviorOf = (
  store: ProjectStore,
  ruleId: string,
  changes: readonly NormChangeEntry[] = store.normChanges.list(),
): RuleBehavior | null => {
  const edited = store.approvalLog
    .list({ entity: 'Rule', id: ruleId })
    .some((entry) => ruleStatementEditOf(entry) !== null);
  if (edited) return null;
  return (
    changes.find(
      (entry) =>
        entry.kind === 'created' &&
        entry.targetRef.entity === 'Rule' &&
        entry.targetRef.id === ruleId,
    )?.detail.behavior ?? null
  );
};

/**
 * 오케스트레이터가 규칙 하나로 시작하는 실행(규칙 작성 세션 뒤 자동 시작 · 기존 규칙 모순 뒤 다시 시작)의 유형 (ADR-110 · ADR-151):
 * 기존 동작 → 유형 C(Green 확인, 구현 생략), 새 동작 · 모름 → 유형 A(지금까지와 같다).
 */
export const declaredRunTypeOf = (behavior: RuleBehavior | null): Extract<RunType, 'A' | 'C'> =>
  behavior === 'existing' ? 'C' : 'A';

/**
 * 실행이 동작 선언으로 유형을 고른 실행이면 그 대상 규칙의 선언 (M3-30, ADR-151): 시작 주체가 오케스트레이터이고 원인이 규범 변경 기록
 * (`causeLog` 없음: 신규 기록 · 다시 시작 원인)이며 대상 규칙이 1개일 때. 그 밖(사람의 [실행] · 편집 뒤 시작 · 변이 보강)이나 선언이
 * 없으면 `null`. 엔진이 Red · Green 확인 미충족으로 실행을 끝낼 때 종료 상세에 싣는다(선언과 실제가 달랐음을 사람이 보게).
 */
export const runDeclarationOf = (store: ProjectStore, run: Run): RuleBehavior | null => {
  if (run.startedBy.kind !== 'orchestrator' || run.startedBy.causeLog !== undefined) return null;
  const [ruleId] = run.targetRuleIds;
  if (ruleId === undefined || run.targetRuleIds.length !== 1) return null;
  return declaredBehaviorOf(store, ruleId);
};

const sameList = <T>(a: readonly T[] | undefined, b: readonly T[]): boolean =>
  a !== undefined && a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * 원인이 끝난 실행의 대상 규칙 다시 시작의 원인인지 (M7-12 · 검토 1회차 N4 · N6, ADR-118): 원인 기록이 연결 실행(이 실행이 아닌 끝난
 * 실행)의 다시 시작 원인(`restartCauseOf`: 기존 규칙 모순이면 첫 모순 판단, 이의 반영이면 첫 폐기 · 대체 판단)과 같은 순번이고, `ruleId`가
 * 그 끝난 실행의 대상 규칙이며 그 판단이 겨눈 규칙이 아니다.
 */
const isRestartCause = (
  store: ProjectStore,
  run: Run,
  cause: NormChangeEntry,
  ruleId: string | undefined,
): boolean => {
  if (cause.kind !== 'judgment' || ruleId === undefined || cause.runId === null) return false;
  if (cause.runId === run.id || cause.targetRef.id === ruleId) return false;
  const ended = store.runs.get(cause.runId);
  if (ended === null || !ended.targetRuleIds.includes(ruleId)) return false;
  return restartCauseOf(store, ended)?.seq === cause.seq;
};

/** 실행 자동 시작 항목의 원인이 맞는지 (`null`이면 맞음). */
const autoStartMismatch = (
  store: ProjectStore,
  run: Run,
  entry: NormChangeEntry,
  all: readonly NormChangeEntry[],
): StartBasisMismatch | null => {
  if (run.startedBy.kind !== 'orchestrator' || entry.actor.kind !== 'orchestrator') {
    return 'starter_mismatch';
  }
  // 자동 시작은 규칙마다 실행 1개다(ADR-110): 대상 규칙 여러 개 · 원인 여러 개인 실행(ADR-107 때의 모양 포함)은 구동하지 않는다
  if (run.targetRuleIds.length !== 1 || run.startedBy.causeSeqs.length !== 1) {
    return 'not_single_rule';
  }
  if (!sameList(entry.detail.ruleIds, run.targetRuleIds)) return 'rules_mismatch';
  const causeSeqs = entry.detail.causeSeqs ?? [];
  if (!sameList(causeSeqs, run.startedBy.causeSeqs)) return 'cause_mismatch';
  const bySeq = new Map(all.map((change) => [change.seq, change]));
  const [causeSeq] = causeSeqs;
  const cause = causeSeq === undefined ? undefined : bySeq.get(causeSeq);
  if (cause === undefined) return 'cause_mismatch';
  const [ruleId] = run.targetRuleIds;
  // 유형은 대상 규칙의 동작 선언으로 정해진다 (M3-30, ADR-151): 원인을 확인한 뒤 · 재사용을 보기 전에 본다
  const typeMatches =
    ruleId !== undefined && run.type === declaredRunTypeOf(declaredBehaviorOf(store, ruleId, all));
  if (cause.kind === 'judgment') {
    // 기존 규칙 모순으로 끝난 실행의 대상 규칙 다시 시작: 같은 원인 · 같은 대상 규칙을 다른 항목이 쓰면 재사용
    if (!isRestartCause(store, run, cause, ruleId)) return 'cause_mismatch';
    if (!typeMatches) return 'type_mismatch';
    const reused = all.some(
      (other) =>
        other.kind === 'auto_start' &&
        other.seq !== entry.seq &&
        (other.detail.causeSeqs ?? []).includes(cause.seq) &&
        sameList(other.detail.ruleIds, run.targetRuleIds),
    );
    return reused ? 'cause_reused' : null;
  }
  const isCreation =
    cause.kind === 'created' && cause.targetRef.entity === 'Rule' && cause.targetRef.id === ruleId;
  if (!isCreation) return 'cause_mismatch';
  if (!typeMatches) return 'type_mismatch';
  const reused = all.some(
    (other) =>
      other.kind === 'auto_start' &&
      other.seq !== entry.seq &&
      (other.detail.causeSeqs ?? []).some((seq) => causeSeqs.includes(seq)),
  );
  return reused ? 'cause_reused' : null;
};

/** 열린 저장소에서 실행의 시작 근거를 대조한다. 저장하지 않는다. */
export const checkRunStartBasis = (store: ProjectStore, run: Run): StartBasisCheck => {
  const runStarts = store.approvalLog
    .list({ entity: 'Run', id: run.id })
    .filter((entry) => entry.action === 'run_start');
  const changes = store.normChanges.list();
  const autoStarts = changes.filter(
    (entry) =>
      entry.kind === 'auto_start' &&
      entry.targetRef.entity === 'Run' &&
      entry.targetRef.id === run.id,
  );
  const counts = { runStartEntries: runStarts.length, autoStartEntries: autoStarts.length };
  const result = (mismatch: StartBasisMismatch | null): StartBasisCheck => ({
    mismatch,
    ...counts,
  });
  if (runStarts.length === 0 && autoStarts.length === 0) return result('no_entry');
  if (runStarts.length > 0 && autoStarts.length > 0) return result('both_entries');
  if (runStarts.length > 1 || autoStarts.length > 1) return result('multiple_entries');
  const [runStart] = runStarts;
  if (runStart !== undefined) {
    if (run.startedBy.kind !== 'human') return result('starter_mismatch');
    return result(sameList(runStart.detail.ruleIds, run.targetRuleIds) ? null : 'rules_mismatch');
  }
  const [autoStart] = autoStarts;
  if (autoStart === undefined) return result('no_entry');
  const causeLog = run.startedBy.kind === 'orchestrator' ? run.startedBy.causeLog : undefined;
  return result(
    causeLog === 'approval_log'
      ? ruleEditMismatch(store, run, autoStart, changes)
      : causeLog === 'mutation_reinforcements'
        ? reinforcementMismatch(store, run, autoStart, changes)
        : autoStartMismatch(store, run, autoStart, changes),
  );
};

/**
 * 변이 생존의 자동 테스트 보강 실행의 자동 시작 항목이 맞는지 (`null`이면 맞음, M3-54 #311 · ADR-143). 유형 C · 대상 규칙 1개 · 원인 1개이고,
 * 시작 주체의 순번이 이 실행의 변이 보강 연결이며 그 연결의 변이 기록이 항목의 원인(`mutationResultIds`)과 같고, 그 기록이 대상 규칙의
 * '변이 생존'이며 병합으로 끝난 유형 A 실행의 것이고(보강 실행의 재주입 기록은 원인이 아니다), 다른 자동 시작 항목이 같은 기록을 쓰지 않는다.
 */
const reinforcementMismatch = (
  store: ProjectStore,
  run: Run,
  entry: NormChangeEntry,
  all: readonly NormChangeEntry[],
): StartBasisMismatch | null => {
  if (run.startedBy.kind !== 'orchestrator' || entry.actor.kind !== 'orchestrator') {
    return 'starter_mismatch';
  }
  const [ruleId] = run.targetRuleIds;
  if (
    ruleId === undefined ||
    run.targetRuleIds.length !== 1 ||
    run.startedBy.causeSeqs.length !== 1
  ) {
    return 'not_single_rule';
  }
  if (!sameList(entry.detail.ruleIds, run.targetRuleIds)) return 'rules_mismatch';
  const resultIds = entry.detail.mutationResultIds ?? [];
  const [resultId] = resultIds;
  if (resultId === undefined || resultIds.length !== 1 || run.type !== 'C') return 'cause_mismatch';
  const [seq] = run.startedBy.causeSeqs;
  const link = seq === undefined ? null : store.mutations.reinforcementBySeq(seq);
  if (link === null || link.runId !== run.id || link.mutationResultId !== resultId) {
    return 'cause_mismatch';
  }
  const cause = store.mutations.get(resultId);
  const origin = cause === null ? null : store.runs.get(cause.runId);
  if (
    cause === null ||
    cause.status !== 'survived' ||
    cause.ruleId !== ruleId ||
    origin === null ||
    origin.type !== 'A' ||
    origin.status !== 'merged'
  ) {
    return 'cause_mismatch';
  }
  const reused = all.some(
    (other) =>
      other.kind === 'auto_start' &&
      other.seq !== entry.seq &&
      (other.detail.mutationResultIds ?? []).includes(resultId),
  );
  return reused ? 'cause_reused' : null;
};

/**
 * 사람의 규칙 진술 편집으로 시작한 실행의 자동 시작 항목이 맞는지 (`null`이면 맞음, ADR-109).
 * 대상 규칙 1개 · 원인 승인 기록 1건(그 규칙의 진술을 바꾼 사람의 `rule_edit`) · 같은 편집을 다른 항목이 쓰지 않음.
 */
const ruleEditMismatch = (
  store: ProjectStore,
  run: Run,
  entry: NormChangeEntry,
  all: readonly NormChangeEntry[],
): StartBasisMismatch | null => {
  if (run.startedBy.kind !== 'orchestrator' || entry.actor.kind !== 'orchestrator') {
    return 'starter_mismatch';
  }
  const [ruleId] = run.targetRuleIds;
  if (ruleId === undefined || run.targetRuleIds.length !== 1) return 'not_single_rule';
  if (!sameList(entry.detail.ruleIds, run.targetRuleIds)) return 'rules_mismatch';
  const editSeqs = entry.detail.ruleEditSeqs ?? [];
  if (!sameList(editSeqs, run.startedBy.causeSeqs) || editSeqs.length !== 1) {
    return 'cause_mismatch';
  }
  const [editSeq] = editSeqs;
  const edit = store.approvalLog
    .list({ entity: 'Rule', id: ruleId })
    .find((logEntry) => logEntry.seq === editSeq);
  if (edit === undefined || ruleStatementEditOf(edit) === null) return 'cause_mismatch';
  const reused = all.some(
    (other) =>
      other.kind === 'auto_start' &&
      other.seq !== entry.seq &&
      (other.detail.ruleEditSeqs ?? []).some((seq) => editSeqs.includes(seq)),
  );
  return reused ? 'cause_reused' : null;
};
