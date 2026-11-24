// 검사 단계 · 병합 재검사의 기존 규칙 실패: 규칙을 맡는 역할의 모순 판단 (RUN-02 · RUN-08 · JDG-01, ADR-100 B⑧ · A4 · A5 · A9,
// M7-12 #224, ADR-118). 검사 실행기와 병합 실행기가 같이 쓴다.
// - 판단이 뜨는 조건: 판정에서 통과하지 못한 규칙이 모두 이 실행의 대상이 아니고 내장 구조 규칙도 아닐 때만. 대상 규칙이 함께
//   실패하면(구현이 대상부터 못 맞춘 것) · 내장 구조 규칙이 실패하면(폐기 · 대체할 수 없다, B⑨) 판단 없이 지금처럼 다룬다
// - 판단은 실행 · 실패한 규칙마다 한 번이다. 이미 판단한 규칙만 다시 실패하면 판단 세션을 열지 않고 앞 판단(모순 없음)을 따른다
// - 판단 입력은 실패한 규칙 ID와 케이스 이름뿐이다(A5). 케이스 이름은 그 규칙의 인수 테스트 파일에 글자 그대로 적힌 것만 원문으로
//   싣고 나머지는 수로만 싣는다. 실패 메시지 · 스택 · 표준 출력 · 구현 세션의 글은 넘기지 않는다
// - 판단 뒤: 하나라도 모순(폐기 · 대체)이면 그 실행은 병합 없이 끝난다(`failed`, `existing_rule_contradiction`, 실패한 규칙 ID).
//   모두 모순 없음(판단 없음 포함)이면 부른 쪽이 지금의 미충족 처리(검사 → 구현 회귀, 병합 재검사 → 실패 종료)를 한다. 판단 세션을
//   열지 못한 사유가 예산이면 `budget_exceeded`, 규칙 작성 역할 설정 미비면 `failed`(`settings_missing`)다(이의 판단과 같다)
// - 판단 뒤 같은 실행이 검사를 다시 돌아 병합하는 길은 없다: 모순 판단이 있는 실행은 검사 · 병합 단계를 열 때마다
//   {@link contradictionHalt}로 끝낸다(재기동 · 재개로 종료 처리가 끊긴 경우)
import type { JudgmentResult, NormJudgmentRuleRef, Rule } from '@bive/shared';

import type { CheckFailureInput, StepContext, StepOutcome } from '../engine/types.js';
import { knownCaseMatcher } from '../norms/case-names.js';
import {
  checkJudgmentsOf,
  contradictionJudgmentsOf,
  settleCheckFailure,
} from '../norms/check-contradiction.js';

/** 실행 실패 사유: 기존 규칙 모순 (`Run.failureReason`). */
export const EXISTING_RULE_CONTRADICTION = 'existing_rule_contradiction';

/** 판단 결과의 요약 (단계 `exitDetail.existingRuleJudgment`). 다음 구현 세션이 판단 근거를 읽는 열쇠다. */
export interface ExistingRuleJudgmentDetail {
  /** 판단 대상이 된 실패 규칙 ID (이번 시도의 실패 규칙 전부, 앞 시도에서 판단한 것 포함) */
  readonly ruleIds: string[];
  readonly decisions: {
    readonly ruleId: string;
    readonly verdict: 'no_contradiction' | 'contradiction';
    readonly judgmentSeq: number;
    readonly undecided: boolean;
  }[];
  readonly judgmentSession:
    | { readonly sessionId: string; readonly endReason: string }
    | { readonly notOpened: string; readonly message: string }
    | { readonly reused: true };
}

/**
 * 판단 결과.
 * - `not_applicable`: 판단 조건이 아니다 (대상 규칙 · 내장 구조 규칙의 실패가 섞임, 실패 없음). 부른 쪽이 지금처럼 다룬다
 * - `no_contradiction`: 모두 모순 없음. 부른 쪽이 미충족 처리를 하며 `detail`을 결과에 싣는다
 * - `halt`: 실행을 끝낸다 (모순 · 판단 세션을 열지 못한 예산 · 설정 사유)
 */
export type ExistingRuleOutcome =
  | { readonly kind: 'not_applicable' }
  | { readonly kind: 'no_contradiction'; readonly detail: ExistingRuleJudgmentDetail }
  | { readonly kind: 'halt'; readonly outcome: StepOutcome };

const halt = (reason: string, exitDetail: Record<string, unknown>): StepOutcome => ({
  status: 'halt',
  runStatus: 'failed',
  reason,
  exitDetail,
});

/**
 * 이 실행에 이미 모순 판단(폐기 · 대체 반영)이 있으면 단계를 열자마자 끝낸다 (재기동 · 재개로 종료 처리가 끊긴 경우). 없으면 `null`.
 * 폐기된 규칙은 다시 판정되지 않으므로 이 확인이 없으면 같은 실행이 검사를 통과해 병합될 수 있다(ADR-100 A4).
 */
export const contradictionHalt = (context: StepContext): StepOutcome | null => {
  const found = context.read((store) => {
    const judgments = contradictionJudgmentsOf(store, context.run.id);
    return judgments.map((entry) => ({
      seq: entry.seq,
      ruleId: store.rules.get(entry.targetRef.id)?.displayId ?? entry.targetRef.id,
    }));
  });
  if (found.length === 0) return null;
  return halt(EXISTING_RULE_CONTRADICTION, {
    message: '대상이 아닌 기존 규칙이 새 규칙과 모순으로 판단되어 이 실행은 병합 없이 끝납니다',
    failedRuleIds: found.map((item) => item.ruleId),
    judgmentSeqs: found.map((item) => item.seq),
    resumed: true,
  });
};

/**
 * 판정에서 실패한 규칙에 판단을 적용한다. `judgments`는 이번 판정의 기록, `rules`는 판정한 규칙, `acceptanceTexts`는 판정한 체크아웃의
 * 인수 테스트 파일 내용이다.
 */
export const judgeExistingRuleFailures = async (
  context: StepContext,
  input: {
    readonly stage: 'check' | 'merge_recheck';
    readonly judgments: readonly JudgmentResult[];
    readonly rules: readonly Rule[];
    readonly acceptanceTexts: Readonly<Record<string, string>>;
  },
): Promise<ExistingRuleOutcome> => {
  const failed = input.judgments
    .filter((judgment) => judgment.status !== 'pass')
    .flatMap((judgment) => {
      const rule = input.rules.find((item) => item.id === judgment.ruleId);
      return rule === undefined ? [] : [{ rule, judgment }];
    });
  if (failed.length === 0) return { kind: 'not_applicable' };
  const targets = context.run.targetRuleIds;
  if (failed.some(({ rule }) => targets.includes(rule.id) || rule.builtin)) {
    return { kind: 'not_applicable' };
  }
  const isKnownCase = knownCaseMatcher(input.acceptanceTexts);
  const failures: CheckFailureInput[] = failed.map(({ rule, judgment }) => {
    const names = judgment.cases
      .filter((item) => item.status !== 'passed')
      .map((item) => item.name);
    const known = names.filter((name) => isKnownCase(rule.displayId, name));
    return { ruleId: rule.id, cases: known, unknownCases: names.length - known.length };
  });
  const failedRefs: NormJudgmentRuleRef[] = failed.map(({ rule }) => ({
    id: rule.id,
    displayId: rule.displayId,
  }));
  const already = context.read((store) =>
    checkJudgmentsOf(store, context.run.id).map((entry) => entry.targetRef.id),
  );
  const fresh = failedRefs.filter((rule) => !already.includes(rule.id));
  const targetRefs = context.read((store) =>
    targets.map((id) => ({ id, displayId: store.rules.get(id)?.displayId ?? id })),
  );
  // 새로 판단할 규칙이 있을 때만 판단 세션을 연다 (실행 · 규칙마다 한 번)
  const judged =
    fresh.length === 0
      ? null
      : await context.judgeNorms({
          cause: { kind: 'check_failure', stage: input.stage, failures, isKnownCase },
          ruleIds: fresh.map((rule) => rule.id),
        });
  context.signal.throwIfAborted();
  const endReason =
    judged === null ? 'success' : judged.status === 'ended' ? judged.endReason : judged.reason;
  const decisions = context.read((store) =>
    settleCheckFailure(
      store,
      {
        runId: context.run.id,
        stage: input.stage,
        stepId: context.step.id,
        targets: targetRefs,
        failures,
        rules: failedRefs,
        endReason,
      },
      { now: Date.now },
    ),
  );
  const detail: ExistingRuleJudgmentDetail = {
    ruleIds: failedRefs.map((rule) => rule.id),
    decisions: decisions.map((decision) => ({
      ruleId: decision.rule.displayId,
      verdict: decision.verdict,
      judgmentSeq: decision.seq,
      undecided: decision.undecided,
    })),
    judgmentSession:
      judged === null
        ? { reused: true }
        : judged.status === 'ended'
          ? { sessionId: judged.sessionId, endReason: judged.endReason }
          : { notOpened: judged.reason, message: judged.detail },
  };
  const contradicted = decisions.filter((decision) => decision.verdict === 'contradiction');
  if (contradicted.length > 0) {
    return {
      kind: 'halt',
      outcome: halt(EXISTING_RULE_CONTRADICTION, {
        stage: input.stage,
        message:
          '대상이 아닌 기존 규칙이 새 규칙과 모순으로 판단되어(폐기 · 대체) 이 실행은 병합 없이 끝납니다',
        failedRuleIds: contradicted.map((decision) => decision.rule.displayId),
        existingRuleJudgment: detail,
      }),
    };
  }
  if (judged?.status === 'not_opened') {
    if (judged.reason === 'project_daily_budget_exceeded' || judged.reason === 'budget_exhausted') {
      return {
        kind: 'halt',
        outcome: {
          status: 'halt',
          runStatus: 'budget_exceeded',
          reason: judged.reason,
          exitDetail: { stage: input.stage, existingRuleJudgment: detail },
        },
      };
    }
    if (judged.reason === 'settings_incomplete') {
      return {
        kind: 'halt',
        outcome: halt('settings_missing', {
          stage: input.stage,
          role: 'rule-writer',
          existingRuleJudgment: detail,
        }),
      };
    }
  }
  return { kind: 'no_contradiction', detail };
};
