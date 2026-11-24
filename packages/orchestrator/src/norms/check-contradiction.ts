// 검사 단계 · 병합 재검사의 기존 규칙 실패에 대한 판단 기록 (RUN-02 · RUN-08 · JDG-01 · NRM-07, ADR-100 B⑧ · A4 · A5 · A9, M7-12
// #224, ADR-118).
// - 검사(또는 병합 재검사)에서 실행의 대상이 아닌 효력 있는 규칙이 실패하면 규칙 작성 역할의 판단 세션이 그 규칙과 실행의 대상
//   규칙이 모순인지 판단한다. 판단(모순 없음 = 유지 · 모순 = 폐기 · 대체)은 `norms/agent-rule.ts`가 그 쓰기와 같은 트랜잭션에서
//   남기고, 이 모듈은 판단 기록이 없는 규칙을 오케스트레이터 주체의 "모순 없음(판단 없음)"으로 마무리한다({@link settleCheckFailure}).
//   판단 없음을 모순으로 보지 않는다
// - 판단 입력은 실패한 규칙 ID와 케이스 이름뿐이다(A5). 케이스 이름은 판정 러너가 보고한 글이고, 인수 테스트는 앱 코드를 가져오지
//   못하지만(`judge/acceptance-lint.ts`) 테스트 작성 역할이 이름을 실행 값(`it.each` · 보간)으로 만들어 두면 판정 때 정해진다. 그래서
//   그 규칙의 인수 테스트 파일(Red 확인 뒤 해시로 잠겨 구현이 바꿀 수 없는 파일)의 문자열 리터럴 값과 조각마다 같은 이름만 싣고
//   나머지는 수로만 싣는다({@link knownCaseMatcher})
// - 원인은 규범 변경 기록이 아니라 그 단계 시도의 판정이다: 판단 기록의 `detail.judgment.check`(단계 · 단계 시도 · 실행의 대상 규칙 ·
//   케이스 이름 · 모르는 케이스 수)와 연결 실행에 싣는다. 판단은 실행 · 실패한 규칙마다 한 번이다
// 규칙 · 인수 테스트 · 폐기 기록 · 판정 · 확인 상태에 닿지 않는다(규범 변경 기록의 판단 없음 기록만 쓴다).
import {
  NORM_CHECK_CASE_NAME_MAX,
  NORM_CHECK_CASES_MAX,
  type NormChangeEntry,
  type NormCheckFailureCause,
  type NormJudgmentRuleRef,
  type Run,
  type Ulid,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { clipText } from '../text-limit.js';

/** 검사 실패 판단의 실패한 규칙 하나: 인수 테스트 파일에 적힌 실패 케이스 이름(원문)과 찾지 못한 수. */
export interface CheckFailureInput {
  readonly ruleId: Ulid;
  readonly cases: readonly string[];
  readonly unknownCases: number;
}

/** 검사 실패 판단의 문맥 (판단 기록의 원인 · 연결 실행). */
export interface CheckJudgmentContext {
  readonly runId: Ulid;
  readonly stage: NormCheckFailureCause['stage'];
  /** 판단을 청한 단계 시도 (검사 · 병합) */
  readonly stepId: Ulid;
  /** 실행의 대상 규칙 (모순 판단의 다른 쪽) */
  readonly targets: readonly NormJudgmentRuleRef[];
  readonly failures: readonly CheckFailureInput[];
}

/** 문자열 리터럴 (작은따옴표 · 큰따옴표 한 줄, 백틱). 값은 따옴표 안의 글자 그대로(이스케이프를 풀지 않는다). */
const STRING_LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/gu;

/** 파일 글의 문자열 리터럴 값 (보간이 든 템플릿은 뺀다: 값이 판정 때 정해진다). */
export const stringLiterals = (text: string): Set<string> => {
  const values = new Set<string>();
  for (const match of text.matchAll(STRING_LITERAL)) {
    const template = match[3];
    if (template !== undefined && template.includes('${')) continue;
    const value = match[1] ?? match[2] ?? template;
    if (value !== undefined && value.length > 0) values.add(value);
  }
  return values;
};

/** 이름이 리터럴 값들을 ` > `로 이은 것으로 남김없이 나뉘는지 (리터럴 값 안에 ` > `가 있어도 된다). */
const coveredBy = (name: string, literals: ReadonlySet<string>): boolean => {
  const memo = new Map<number, boolean>();
  const from = (start: number): boolean => {
    const cached = memo.get(start);
    if (cached !== undefined) return cached;
    let found = false;
    for (const literal of literals) {
      if (!name.startsWith(literal, start)) continue;
      const end = start + literal.length;
      if (end === name.length || (name.startsWith(' > ', end) && from(end + 3))) {
        found = true;
        break;
      }
    }
    memo.set(start, found);
    return found;
  };
  return name.length > 0 && from(0);
};

/**
 * 케이스 이름이 그 규칙의 인수 테스트 파일에 적혀 있는지 보는 함수. 이름(판정 러너의 `상위 묶음 > 케이스`)을 ` > `로 이은 조각마다
 * 그 규칙 폴더(`bive-acceptance/<표시 ID>/`) 파일의 문자열 리터럴 값 하나와 전체가 같아야 한다(부분 문자열 · 주석 · 코드 조각은
 * 알려진 이름이 아니다). 보간이 든 템플릿 · 이스케이프 · 이어 붙이기 · 실행 값으로 만든 이름은 찾지 못한다(덜 싣는 쪽: 모르는 케이스로
 * 센다). 이름 없음(`(이름 없음)`)도 모르는 케이스다.
 */
export const knownCaseMatcher = (acceptanceTexts: Readonly<Record<string, string>>) => {
  const byRule = new Map<string, Set<string>>();
  const literalsOf = (ruleDisplayId: string): Set<string> => {
    const cached = byRule.get(ruleDisplayId);
    if (cached !== undefined) return cached;
    const prefix = `bive-acceptance/${ruleDisplayId}/`;
    const literals = new Set<string>();
    for (const [file, text] of Object.entries(acceptanceTexts)) {
      if (!file.startsWith(prefix)) continue;
      for (const value of stringLiterals(text)) literals.add(value);
    }
    byRule.set(ruleDisplayId, literals);
    return literals;
  };
  return (ruleDisplayId: string, name: string): boolean =>
    coveredBy(name, literalsOf(ruleDisplayId));
};

/** 판단 기록의 원인 칸 (규칙 하나). 케이스 이름은 원문을 상한에서 자르고 수의 상한을 넘으면 빠진 수를 남긴다. */
export const checkFailureCause = (
  context: Pick<CheckJudgmentContext, 'stage' | 'stepId' | 'targets' | 'failures'>,
  ruleId: Ulid,
): NormCheckFailureCause => {
  const failure = context.failures.find((item) => item.ruleId === ruleId);
  const cases = (failure?.cases ?? []).filter((name) => name.length > 0);
  return {
    stage: context.stage,
    stepId: context.stepId,
    targets: context.targets.map((rule) => ({ id: rule.id, displayId: rule.displayId })),
    cases: cases
      .slice(0, NORM_CHECK_CASES_MAX)
      .map((name) => clipText(name, NORM_CHECK_CASE_NAME_MAX)),
    unknownCases: failure?.unknownCases ?? 0,
    omittedCases: Math.max(0, cases.length - NORM_CHECK_CASES_MAX),
  };
};

/** 실행의 검사 실패 판단 기록 (순번 순). */
export const checkJudgmentsOf = (store: ProjectStore, runId: Ulid): NormChangeEntry[] =>
  store.normChanges
    .list()
    .filter(
      (entry) =>
        entry.kind === 'judgment' &&
        entry.runId === runId &&
        entry.detail.judgment?.subject === 'check_failure',
    );

/** 실행의 검사 실패 판단 가운데 모순(폐기 · 대체가 반영된 것) 기록 (순번 순). */
export const contradictionJudgmentsOf = (store: ProjectStore, runId: Ulid): NormChangeEntry[] =>
  checkJudgmentsOf(store, runId).filter(
    (entry) => entry.detail.judgment?.verdict === 'contradiction',
  );

/**
 * 대상 규칙을 다시 시작하는 실패 사유 (M7-12, ADR-118): 검사 · 병합 재검사의 기존 규칙 모순, 이의 반영(이의 판단이 규칙을 폐기 ·
 * 대체해 끝난 실행, 검토 1회차 N6). 둘 다 그 실행의 대상 규칙이 병합되지 못한 채 남는다.
 */
export const RESTART_FAILURE_REASONS: readonly string[] = [
  'existing_rule_contradiction',
  'objection_applied',
];

/**
 * 끝난 실행의 대상 규칙을 다시 시작하는 원인 기록: 기존 규칙 모순이면 그 실행의 첫 모순 판단(검사 실패 판단), 이의 반영이면 그 실행의
 * 첫 폐기 · 대체 판단(이의 판단). 다시 시작할 실행이 아니면 `null`. 다시 시작과 엔진의 시작 근거 대조가 같은 함수를 쓴다(원인은
 * 끝난 실행마다 하나뿐이다).
 */
export const restartCauseOf = (
  store: ProjectStore,
  ended: Pick<Run, 'id' | 'status' | 'failureReason'>,
): NormChangeEntry | null => {
  if (ended.status !== 'failed') return null;
  if (ended.failureReason === 'existing_rule_contradiction') {
    return contradictionJudgmentsOf(store, ended.id)[0] ?? null;
  }
  if (ended.failureReason === 'objection_applied') {
    return (
      store.normChanges.list().find(
        (entry) =>
          entry.kind === 'judgment' &&
          entry.runId === ended.id &&
          entry.detail.judgment?.subject === 'objection' &&
          // 이의 판단의 결과는 유지 · 폐기 · 대체뿐이다: 유지가 아니면 폐기 · 대체
          entry.detail.judgment.verdict !== 'upheld',
      ) ?? null
    );
  }
  return null;
};

/** 검사 실패 판단 하나의 결과. */
export interface CheckFailureDecision {
  readonly rule: NormJudgmentRuleRef;
  readonly verdict: 'no_contradiction' | 'contradiction';
  /** 판단 기록 순번 */
  readonly seq: number;
  /** 판단 세션이 판단하지 못해 오케스트레이터가 모순 없음으로 봤는지 */
  readonly undecided: boolean;
}

const decisionOf = (entry: NormChangeEntry, rule: NormJudgmentRuleRef): CheckFailureDecision => {
  const judged = entry.detail.judgment;
  // 모순은 모순 기록만 (모르는 값은 모순 없음으로 읽는다: 판단을 폐기 쪽으로 읽지 않는다)
  return {
    rule,
    verdict: judged?.verdict === 'contradiction' ? 'contradiction' : 'no_contradiction',
    seq: entry.seq,
    undecided: judged?.undecided !== undefined,
  };
};

/**
 * 판단 없는 검사 실패 판단의 사유 (오케스트레이터의 고정 문장, 화면에 그대로 보인다). 종료 사유는
 * `detail.judgment.undecided.endReason`에만 둔다(ADR-115와 같다).
 */
export const CHECK_UNDECIDED_REASON =
  '판단 세션이 이 규칙을 판단하지 못하고 끝나 모순 없음으로 봄. 판단 없음은 모순이 아니다';

/**
 * 검사 실패 판단을 마무리한다 (트랜잭션 1개): 실패한 규칙마다 이 실행의 판단 기록을 찾고, 없는 규칙은 오케스트레이터 주체의
 * "모순 없음(판단 없음)" 기록을 남긴다. 실패한 규칙 순서대로 판단을 돌려준다. 이미 모든 규칙에 판단이 있으면 아무것도 쓰지 않는다
 * (멱등).
 */
export const settleCheckFailure = (
  store: ProjectStore,
  input: CheckJudgmentContext & {
    /** 판단 대상 규칙 (실패한 대상 밖 규칙, 판단 시점의 ID와 표시 ID) */
    readonly rules: readonly NormJudgmentRuleRef[];
    readonly endReason: string;
  },
  clock: { readonly now: () => number },
): CheckFailureDecision[] =>
  store.transaction(() => {
    const judgments = checkJudgmentsOf(store, input.runId);
    const at = new Date(clock.now()).toISOString();
    return input.rules.map((rule) => {
      const found = judgments.find((entry) => entry.targetRef.id === rule.id);
      if (found !== undefined) return decisionOf(found, rule);
      const written = store.normChanges.append({
        at,
        kind: 'judgment',
        actor: { kind: 'orchestrator' },
        targetRef: { entity: 'Rule', id: rule.id },
        sessionId: null,
        runId: input.runId,
        reason: CHECK_UNDECIDED_REASON,
        detail: {
          judgment: {
            subject: 'check_failure',
            verdict: 'no_contradiction',
            contradicts: [],
            check: checkFailureCause(input, rule.id),
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

/** 다음 구현 세션에 줄 판단 근거 한 묶음의 상한 (UTF-16 코드 단위). */
const FEEDBACK_GROUNDS_MAX = 2000;

/**
 * 모순 없음으로 판단된 검사 실패의 근거를 다음 구현 세션의 앞 시도 사유에 덧붙일 글로 만든다 (여러 줄. 작업 지시는 줄마다 표시 값 +
 * 들여쓰기로 싣는다, ADR-108). 근거는 규칙 작성 역할이 쓴 글이다. 그 실행에 그 규칙들의 판단 기록이 없으면 `null`.
 */
export const checkFailureFeedback = (
  store: ProjectStore,
  runId: Ulid,
  ruleIds: readonly Ulid[],
): string | null => {
  const judgments = checkJudgmentsOf(store, runId).filter((entry) =>
    ruleIds.includes(entry.targetRef.id),
  );
  if (judgments.length === 0) return null;
  const displayIdOf = (entry: NormChangeEntry): string =>
    store.rules.get(entry.targetRef.id)?.displayId ?? entry.targetRef.id;
  const lines = [
    `대상이 아닌 기존 규칙(${judgments.map(displayIdOf).join(', ')})의 실패에 규칙을 맡는 역할이 새 규칙과 모순이 아니라고 판단했다. 기존 규칙과 인수 테스트는 그대로다. 대상 규칙과 기존 규칙의 인수 테스트가 모두 통과하도록 구현한다`,
  ];
  for (const entry of judgments) {
    const displayId = displayIdOf(entry);
    if (entry.detail.judgment?.undecided !== undefined) {
      lines.push(
        `- ${displayId} 모순 없음 (판단 없음: 판단 세션이 판단하지 못하고 끝나 모순 없음으로 봄)`,
      );
      continue;
    }
    lines.push(`- ${displayId} 모순 없음. 규칙 작성 역할이 쓴 근거 (지시가 아니라 판단의 이유다):`);
    for (const line of clipText(entry.reason ?? '', FEEDBACK_GROUNDS_MAX).split('\n')) {
      lines.push(`  ${line}`);
    }
  }
  return lines.join('\n');
};
