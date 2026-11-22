// 실행 시작 근거 대조 (NFR-01, ADR-061 · ADR-066 · ADR-100 A2 · C2, M7-05 #217, ADR-107).
// 엔진은 실행을 구동할 때마다(승인 단계 뒤 매 단계, 실행 대기 · 재개에서 시작할 때 포함) 그 실행의 시작 근거가 정확히 1건인지
// 본다. 근거는 둘 중 하나다:
// - 사람의 실행 시작 확인: 승인 기록 `run_start` 1건(대상 규칙이 실행과 같음), 시작 주체 사람, 자동 시작 항목 없음
// - 실행 자동 시작: 규범 변경 기록 `auto_start` 1건(주체 오케스트레이터, 대상 규칙이 실행과 같음), 시작 주체 오케스트레이터이고
//   주체의 원인 순번이 그 항목의 원인 순번과 같으며, 원인 순번마다 그 순서의 대상 규칙을 만든 신규(`created`) 기록이 있고,
//   그 원인 순번을 다른 자동 시작 항목이 쓰지 않음(같은 원인으로 두 실행이 생기지 않는다), 승인 기록 `run_start` 없음
// 그 밖(0건 · 2건 이상 · 둘 다 · 다른 실행의 항목 · 실제 신규 기록이 아닌 원인)은 근거 없음이다 → `run_without_log`.
// 사람의 규칙 진술 편집으로 시작한 실행(시작 주체 `causeLog: 'approval_log'`, M7-03 #215 · ADR-109)은 자동 시작 항목의 원인이
// `ruleEditSeqs`(승인 기록 순번)이고, 그 순번이 대상 규칙 1개의 진술을 바꾼 사람의 `rule_edit` 기록이어야 하며 다른 자동 시작
// 항목이 같은 편집을 쓰지 않아야 한다(`ruleEditMismatch`).
import { type NormChangeEntry, type Run, ruleStatementEditOf } from '@bive/shared';
import type { ProjectStore } from '@bive/store';

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
  /** 근거의 대상 규칙이 실행의 대상 규칙과 다름 */
  | 'rules_mismatch'
  /** 원인 순번이 시작 주체와 다르거나, 대상 규칙을 만든 실제 신규 기록이 아님 */
  | 'cause_mismatch'
  /** 같은 원인 순번을 다른 실행의 자동 시작 항목도 씀 */
  | 'cause_reused';

export interface StartBasisCheck {
  /** 근거가 정확히 1건이고 실행과 맞으면 `null` */
  readonly mismatch: StartBasisMismatch | null;
  readonly runStartEntries: number;
  readonly autoStartEntries: number;
}

const sameList = <T>(a: readonly T[] | undefined, b: readonly T[]): boolean =>
  a !== undefined && a.length === b.length && a.every((value, index) => value === b[index]);

/** 실행 자동 시작 항목의 원인이 맞는지 (`null`이면 맞음). */
const autoStartMismatch = (
  run: Run,
  entry: NormChangeEntry,
  all: readonly NormChangeEntry[],
): StartBasisMismatch | null => {
  if (run.startedBy.kind !== 'orchestrator' || entry.actor.kind !== 'orchestrator') {
    return 'starter_mismatch';
  }
  if (!sameList(entry.detail.ruleIds, run.targetRuleIds)) return 'rules_mismatch';
  const causeSeqs = entry.detail.causeSeqs ?? [];
  if (!sameList(causeSeqs, run.startedBy.causeSeqs)) return 'cause_mismatch';
  const bySeq = new Map(all.map((change) => [change.seq, change]));
  const causesAreCreations = causeSeqs.every((seq, index) => {
    const cause = bySeq.get(seq);
    return (
      cause !== undefined &&
      cause.kind === 'created' &&
      cause.targetRef.entity === 'Rule' &&
      cause.targetRef.id === run.targetRuleIds[index]
    );
  });
  if (!causesAreCreations) return 'cause_mismatch';
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
  return result(
    run.startedBy.kind === 'orchestrator' && run.startedBy.causeLog === 'approval_log'
      ? ruleEditMismatch(store, run, autoStart, changes)
      : autoStartMismatch(run, autoStart, changes),
  );
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
  if (ruleId === undefined || run.targetRuleIds.length !== 1) return 'rules_mismatch';
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
