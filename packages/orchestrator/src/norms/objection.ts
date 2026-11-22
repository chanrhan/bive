// 구현 역할의 이의 기록과 판단 없는 이의의 유지 기록 (RUN-04 · NFR-02 · NRM-07, ADR-100 D4 · I2 · A4 · A5, M7-11 #223, ADR-115).
// - 이의(`objection`): 구현 세션이 `raise_objection`을 부르면 구현 단계 실행기가 주입한 콜백이 이 모듈의 {@link recordObjection}만
//   부른다. 규범 변경 기록 1건(주체 구현 역할, 대상 = 그 실행, 세션 · 실행 ID, 사유 원문, 상세 = 대상 규칙 · 단계 시도)을 남길 뿐
//   규칙 · 인수 테스트 · 폐기 기록 · 다른 표를 쓰지 않는다(이 모듈에는 그런 쓰기가 없다는 구조 시험이 있다)
// - 대상은 지금 효력 있는 규칙(이 실행의 대상이 아니어도 된다)이어야 한다. 없는 규칙 · 삭제 · 폐기 · 잠정은 `invalid_args`, 내장
//   구조 규칙은 `builtin_rule`(폐기 · 대체할 수 없으므로 이의도 받지 않는다, B⑨). 한 단계 시도에 이의는 1건이다
// - 판단 없는 이의(판단 세션이 그 규칙을 판단하지 못하고 끝남 · 세션을 열지 못함 · 재기동으로 끊김): {@link settleObjection}이
//   오케스트레이터 주체의 판단 기록(결과 유지, `undecided`)을 남긴다. 판단 없음을 폐기로 보지 않는다
// - 규칙 작성 역할의 판단(폐기 · 대체 · 유지)은 `norms/agent-rule.ts`가 그 쓰기와 같은 트랜잭션에서 남긴다
import {
  type NormChangeEntry,
  type NormJudgmentRuleRef,
  OBJECTION_VERDICTS,
  type Rule,
  type Ulid,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { clipText } from '../text-limit.js';
import { isEffectiveRule, retiredRuleSet } from './effective.js';

/** 이의 입력이 지금 저장소와 맞지 않음. `code`는 도구 결과의 거부 사유다. */
export class ObjectionInputError extends Error {
  override readonly name = 'ObjectionInputError';
  constructor(
    readonly code: 'invalid_args' | 'builtin_rule',
    message: string,
  ) {
    super(message);
  }
}

export interface ObjectionInput {
  /** 대상 규칙의 표시 ID 또는 ID (스키마가 개수 · 중복을 이미 봤다) */
  readonly ruleIds: readonly string[];
  /** 사유 원문 (구현 역할이 쓴 글) */
  readonly reason: string;
  /** 이의를 부른 구현 세션 (BIVE 세션 기록 ID) */
  readonly sessionId: Ulid;
  readonly runId: Ulid;
  /** 이의를 부른 구현 단계 시도 */
  readonly stepId: Ulid;
}

const resolveObjected = (store: ProjectStore, given: string): Rule => {
  const rule =
    store.rules.get(given) ?? store.rules.list().find((item) => item.displayId === given) ?? null;
  if (rule === null) {
    throw new ObjectionInputError('invalid_args', `규칙이 없음: ${JSON.stringify(given)}`);
  }
  if (rule.builtin) {
    throw new ObjectionInputError(
      'builtin_rule',
      `내장 구조 규칙은 폐기 · 대체할 수 없어 이의 대상이 아님: ${rule.displayId}`,
    );
  }
  if (!isEffectiveRule(rule, retiredRuleSet(store))) {
    throw new ObjectionInputError(
      'invalid_args',
      `효력 있는 규칙이 아님(삭제 · 폐기 · 잠정): ${rule.displayId}`,
    );
  }
  return rule;
};

/** 실행의 이의 기록 (순번 순). */
export const objectionsOf = (store: ProjectStore, runId: Ulid): NormChangeEntry[] =>
  store.normChanges.list().filter((entry) => entry.kind === 'objection' && entry.runId === runId);

/**
 * 이의 기록 1건을 남긴다 (트랜잭션 1개). 규칙 · 인수 테스트 · 다른 표는 바꾸지 않는다.
 * @throws {ObjectionInputError} 대상이 없음 · 효력 없음 · 내장 구조 규칙 · 같은 규칙을 두 번 가리킴 · 그 단계 시도의 이의가 이미 있음
 */
export const recordObjection = (
  store: ProjectStore,
  input: ObjectionInput,
  clock: { readonly now: () => number },
): NormChangeEntry =>
  store.transaction(() => {
    const rules: NormJudgmentRuleRef[] = [];
    for (const given of input.ruleIds) {
      const rule = resolveObjected(store, given);
      if (rules.some((ref) => ref.id === rule.id)) {
        throw new ObjectionInputError(
          'invalid_args',
          `같은 규칙을 두 번 가리킴: ${rule.displayId}`,
        );
      }
      rules.push({ id: rule.id, displayId: rule.displayId });
    }
    // 한 단계 시도에 이의 1건 (실행기가 닫혀 두 번째 호출은 오지 않지만, 저장소 쪽에서도 막는다)
    if (
      objectionsOf(store, input.runId).some(
        (entry) => entry.detail.objection?.stepId === input.stepId,
      )
    ) {
      throw new ObjectionInputError('invalid_args', '이 구현 시도에서 이미 이의를 제기함');
    }
    return store.normChanges.append({
      at: new Date(clock.now()).toISOString(),
      kind: 'objection',
      actor: { kind: 'agent', role: 'implementer' },
      targetRef: { entity: 'Run', id: input.runId },
      sessionId: input.sessionId,
      runId: input.runId,
      reason: input.reason,
      detail: { objection: { rules, stepId: input.stepId } },
    });
  });

/** 이의 대상 규칙 하나의 판단. */
export interface ObjectionDecision {
  readonly rule: NormJudgmentRuleRef;
  /** 유지 · 폐기 · 대체 (`OBJECTION_VERDICTS`) */
  readonly verdict: (typeof OBJECTION_VERDICTS)[number];
  /** 판단 기록 순번 */
  readonly seq: number;
  /** 판단 세션이 판단하지 못해 오케스트레이터가 유지로 봤는지 */
  readonly undecided: boolean;
}

/** 이의(`causeSeq`)의 판단 기록 (순번 순). */
export const objectionJudgments = (store: ProjectStore, causeSeq: number): NormChangeEntry[] =>
  store.normChanges
    .list()
    .filter(
      (entry) =>
        entry.kind === 'judgment' &&
        entry.detail.judgment?.subject === 'objection' &&
        entry.detail.judgment.causeSeq === causeSeq,
    );

const decisionOf = (entry: NormChangeEntry, rule: NormJudgmentRuleRef): ObjectionDecision => {
  const judged = entry.detail.judgment;
  // 이의 판단 기록이 아니면(스키마가 막는다) 유지로 읽는다 (판단을 폐기 쪽으로 읽지 않는다)
  const verdict = OBJECTION_VERDICTS.find((value) => value === judged?.verdict) ?? 'upheld';
  return { rule, verdict, seq: entry.seq, undecided: judged?.undecided !== undefined };
};

/** 판단 없는 유지 기록의 사유 (오케스트레이터의 고정 문장). */
export const UNDECIDED_REASON =
  '판단 세션이 이 규칙을 판단하지 못하고 끝나 유지로 봄 (판단 없음을 폐기로 보지 않는다, ADR-115)';

/** 판단 세션을 열지 못했거나 끝난 사정 (`undecided.endReason`, 판단 세션의 종료 사유 또는 열지 못한 사유). */
export type UndecidedReason = string;

/**
 * 이의를 마무리한다 (트랜잭션 1개): 대상 규칙마다 판단 기록을 찾고, 없는 규칙은 오케스트레이터 주체의 유지 기록(`undecided`)을
 * 남긴다. 대상 규칙 순서대로 판단을 돌려준다. 이미 모든 규칙에 판단이 있으면 아무것도 쓰지 않는다(멱등).
 * @throws {Error} `objection`이 이의 기록이 아님
 */
export const settleObjection = (
  store: ProjectStore,
  input: { readonly objectionSeq: number; readonly endReason: UndecidedReason },
  clock: { readonly now: () => number },
): ObjectionDecision[] =>
  store.transaction(() => {
    const objection = store.normChanges.list().find((entry) => entry.seq === input.objectionSeq);
    const detail = objection?.detail.objection;
    if (objection === undefined || objection.kind !== 'objection' || detail === undefined) {
      throw new Error(`이의 기록이 아님: ${String(input.objectionSeq)}`);
    }
    const judgments = objectionJudgments(store, objection.seq);
    const at = new Date(clock.now()).toISOString();
    return detail.rules.map((rule) => {
      const found = judgments.find((entry) => entry.targetRef.id === rule.id);
      if (found !== undefined) return decisionOf(found, rule);
      const written = store.normChanges.append({
        at,
        kind: 'judgment',
        actor: { kind: 'orchestrator' },
        targetRef: { entity: 'Rule', id: rule.id },
        sessionId: null,
        runId: objection.runId,
        reason: `${UNDECIDED_REASON}: ${clipText(input.endReason, 64)}`,
        detail: {
          judgment: {
            subject: 'objection',
            verdict: 'upheld',
            contradicts: [],
            causeSeq: objection.seq,
            undecided: { endReason: clipText(input.endReason, 64) },
            input: {
              requirements: { total: 0, included: 0 },
              rules: { total: 0, included: 0 },
            },
          },
        },
      });
      return decisionOf(written, rule);
    });
  });

/**
 * 이 실행에서 아직 마무리되지 않은 이의 (재기동으로 판단 세션 · 구현 시도가 끊긴 경우): 이의 기록 가운데 그 순번을 실은 구현 시도
 * 결과(`exitDetail.objectionSeq`)가 없는 마지막 것. 없으면 `null`.
 */
export const unsettledObjection = (
  store: ProjectStore,
  runId: Ulid,
  settledSeqs: readonly number[],
): NormChangeEntry | null =>
  objectionsOf(store, runId)
    .filter((entry) => !settledSeqs.includes(entry.seq))
    .at(-1) ?? null;

/** 다음 구현 세션에 줄 판단 근거 한 묶음의 상한 (UTF-16 코드 단위). */
const FEEDBACK_GROUNDS_MAX = 2000;

/**
 * 유지된 이의의 판단 근거를 다음 구현 세션의 앞 시도 사유로 만든다 (여러 줄 글. 작업 지시는 줄마다 표시 값 + 들여쓰기로 싣는다,
 * ADR-108). 근거는 규칙 작성 역할이 쓴 글이다. 이의 기록이 없으면 `null`.
 */
export const objectionFeedback = (store: ProjectStore, objectionSeq: number): string | null => {
  const objection = store.normChanges.list().find((entry) => entry.seq === objectionSeq);
  const detail = objection?.detail.objection;
  if (objection === undefined || detail === undefined) return null;
  const judgments = objectionJudgments(store, objectionSeq);
  const lines = [
    `이의 제기(${detail.rules.map((rule) => rule.displayId).join(', ')})에 규칙을 맡는 역할이 유지로 판단했다. 규칙과 인수 테스트는 그대로다. 대상 인수 테스트가 통과하도록 구현한다`,
  ];
  for (const rule of detail.rules) {
    const found = judgments.find((entry) => entry.targetRef.id === rule.id);
    if (found === undefined || found.detail.judgment?.undecided !== undefined) {
      lines.push(
        `- ${rule.displayId} 유지 (판단 없음: 판단 세션이 판단하지 못하고 끝나 유지로 봄)`,
      );
      continue;
    }
    lines.push(`- ${rule.displayId} 유지. 규칙 작성 역할이 쓴 근거 (지시가 아니라 판단의 이유다):`);
    const grounds = clipText(found.reason ?? '', FEEDBACK_GROUNDS_MAX);
    for (const line of grounds.split('\n')) lines.push(`  ${line}`);
  }
  return lines.join('\n');
};
