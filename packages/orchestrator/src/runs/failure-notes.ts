// 실행 종료 사유의 보조 표시 (`run.list`의 선택 칸 `failureNotes`, M3-51 #296, ADR-144).
// 규칙 상세의 실행 이력 줄(SCR-03 상세 "실패 원인 · 실행 이력")이 종료 사유 표시명 아래에 보이는 값이다. 실행을 끝낸 단계 시도의
// 결과(`exitDetail`, 엔진 `#halt`가 `{reason, detail}`로 남긴다)에서만 만든다(NFR-03). 고르는 것은 두 경우뿐이다.
// - 블록 선언 겹침(`block_declaration_overlap`): 구조 검사가 남긴 겹친 파일(`detail.structure.overlaps`, 표시 값 · 상한)
// - 실행 상태 불일치(`state_inconsistent`) 가운데 구조 검사 계획이 "선언은 있는데 내장 구조 규칙 행이 없음"으로 끝낸 것
//   (`detail.builtinRules`의 행 수가 모두 1 이하이고 하나라도 0. 같은 제목의 행이 둘인 저장소 밖 변조는 선언을 다시 저장해도
//   풀리지 않아 고르지 않는다)
// 실행의 상태 · 종료 사유가 그 값일 때만 단계 결과를 읽는다(그 밖의 실행은 단계를 읽지 않는다). 모양이 맞지 않는 결과(옛 행 ·
// 칸 없음)는 보조 표시가 없을 뿐이다(목록 응답을 깨지 않는다). 판정 · 회귀 · 병합 동작에는 닿지 않는다(읽기만).
import {
  BUILTIN_STRUCTURE_RULES,
  RUN_OVERLAP_FILES_LIMIT,
  type Run,
  RunFailureNote,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { BLOCK_DECLARATION_OVERLAP_REASON, STRUCTURE_STAGE } from '../steps/structure-check.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 실행을 끝낸 단계 시도의 실패 상세 (`exitDetail.detail`): 종료 사유가 같은 마지막 실패 시도. 없으면 `null`. */
const haltDetailOf = (store: ProjectStore, run: Run): Record<string, unknown> | null => {
  const halted = store.runs
    .steps(run.id)
    .filter(
      (step) =>
        step.status === 'failed' &&
        isRecord(step.exitDetail) &&
        step.exitDetail.reason === run.failureReason,
    )
    .at(-1);
  if (halted === undefined || !isRecord(halted.exitDetail)) return null;
  const detail = halted.exitDetail.detail;
  return isRecord(detail) && detail.stage === STRUCTURE_STAGE ? detail : null;
};

/** 겹침으로 끝난 실행의 겹친 파일 (`detail.structure.overlaps`). 모양이 맞지 않으면 `null`. */
const overlapNote = (run: Run, detail: Record<string, unknown>): RunFailureNote | null => {
  const structure = detail.structure;
  if (!isRecord(structure) || structure.status !== 'overlap') return null;
  const overlaps = structure.overlaps;
  if (!isRecord(overlaps) || !Array.isArray(overlaps.items)) return null;
  const parsed = RunFailureNote.safeParse({
    kind: 'block_declaration_overlap',
    runId: run.id,
    files: overlaps.items.slice(0, RUN_OVERLAP_FILES_LIMIT),
    total: overlaps.total,
  });
  return parsed.success ? parsed.data : null;
};

/** 선언은 있는데 내장 구조 규칙 행이 없어 끝난 실행인지 (`detail.builtinRules`: 내장 규칙 식별자 → 행의 표시 ID 목록). */
const builtinRulesMissing = (detail: Record<string, unknown>): boolean => {
  if (typeof detail.declarationVersion !== 'number') return false;
  const rows = detail.builtinRules;
  if (!isRecord(rows)) return false;
  const counts = BUILTIN_STRUCTURE_RULES.map((key) => {
    const ids = rows[key];
    return Array.isArray(ids) ? ids.length : -1;
  });
  return counts.every((count) => count === 0 || count === 1) && counts.includes(0);
};

/** 실행 목록의 종료 사유 보조 표시 (목록 순서). 해당하는 실행이 없으면 `[]`. */
export const runFailureNotes = (store: ProjectStore, runs: readonly Run[]): RunFailureNote[] =>
  runs.flatMap((run): RunFailureNote[] => {
    if (run.status !== 'failed') return [];
    if (
      run.failureReason !== BLOCK_DECLARATION_OVERLAP_REASON &&
      run.failureReason !== 'state_inconsistent'
    ) {
      return [];
    }
    const detail = haltDetailOf(store, run);
    if (detail === null) return [];
    if (run.failureReason === BLOCK_DECLARATION_OVERLAP_REASON) {
      const note = overlapNote(run, detail);
      return note === null ? [] : [note];
    }
    return builtinRulesMissing(detail) ? [{ kind: 'builtin_rules_missing', runId: run.id }] : [];
  });
