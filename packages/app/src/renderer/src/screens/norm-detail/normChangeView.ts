// 규칙 상세의 변경 이력 줄 (screens.md SCR-06 변경 이력, NRM-07, ADR-100 D5 · C2 · 명세 변경 목록 SCR-06, M7-15 #227 · ADR-114).
// 규범 변경 기록(`normChange.list {targetRef: 이 규칙}`)의 에이전트 · 오케스트레이터 행동을 최소한으로 보인다: 시각 · 종류 · 주체,
// 판단 · 대체의 대상 규칙, 사유 또는 근거. 사람 행동(승인 기록)과 합친 전면 화면은 M3-12다.
// - 사유 · 근거 · 상세의 글은 응답에 이미 표시 값(숨은 글자 표기, 상한 4000)으로 온다(ADR-089). 여기서 다시 바꾸지 않는다
// - 대상 규칙의 표시 ID는 기록에 남은 값 그대로다(판단 · 폐기 시점의 값)
// DOM · React에 의존하지 않는다 (test/norm-change-view.test.ts).
import type {
  NormChangeKind,
  NormChangeView,
  NormJudgmentRuleRef,
  NormJudgmentSubject,
  NormJudgmentVerdict,
  NormUndecidedReason,
} from '@bive/shared';

import { AUTHOR_LABELS } from '../../components/AuthorMark/labels.js';
import { formatCardTime } from '../../components/Card2Line/time.js';
import { AGENT_ROLE_LABELS } from '../../proposals/labels.js';

export const NORM_CHANGE_TEXT = {
  history: '변경 이력',
  loadFailed: '변경 이력 불러오기 실패',
  empty: '변경 이력 없음',
  chainBroken: '변경 기록 검증 실패',
  truncated: '일부 생략',
  orchestrator: '오케스트레이터',
  noContradiction: '모순 없음',
  contradiction: '모순',
  undecided: '판단 없음',
  successor: '대체 규칙',
  reason: '사유',
  grounds: '근거',
} as const;

/** 규범 변경 기록 종류 표시명 (shared NORM_CHANGE_KIND_LABELS와 같음, 시험이 대조). */
export const NORM_CHANGE_KIND_TEXT = {
  created: '신규',
  updated: '수정',
  retired: '폐기',
  superseded: '대체',
  judgment: '판단',
  objection: '이의',
  unconfirmed: '확인 풀림',
  auto_start: '자동 시작',
  test_changed: '테스트 변경',
} as const satisfies Record<NormChangeKind, string>;

/** 판단 주제 표시명 (shared NORM_JUDGMENT_SUBJECT_LABELS와 같음, 시험이 대조). */
export const JUDGMENT_SUBJECT_TEXT = {
  new_rule: '모순 판단',
  supersede: '모순 판단',
  objection: '이의 판단',
  check_failure: '검사 실패 판단',
} as const satisfies Record<NormJudgmentSubject, string>;

/** 판단 결과 표시명 (shared NORM_JUDGMENT_VERDICT_LABELS와 같음, 시험이 대조). */
export const JUDGMENT_VERDICT_TEXT = {
  no_contradiction: '모순 없음',
  contradiction: '모순',
  upheld: '유지',
  retired: '폐기',
  superseded: '대체',
} as const satisfies Record<NormJudgmentVerdict, string>;

/** 판단 없이 끝난 이의 · 검사 실패 판단의 사정 표시명 (shared NORM_UNDECIDED_REASON_LABELS와 같음, 시험이 대조). */
export const UNDECIDED_REASON_TEXT = {
  success: '정상 종료',
  error_max_turns: '턴 한도 초과',
  error_max_budget_usd: '예산 한도 초과',
  error_during_execution: '실행 중 오류',
  aborted: '중단',
  guard_violation: '가드 위반',
  objection_raised: '이의 제기',
  project_daily_budget_exceeded: '프로젝트 하루 예산 초과',
  budget_exhausted: '실행 예산 소진',
  settings_incomplete: '예산 · 모델 미설정',
  start_failed: '시작 실패',
  not_configured: '판단 경로 없음',
  interrupted: '오케스트레이터 재기동',
} as const satisfies Record<NormUndecidedReason, string>;

/** 모르는 값(뒤 버전이 더한 값)은 날 값 대신 이것으로 그린다. */
const UNKNOWN_TEXT = '알 수 없음';

const labelOf = <T extends string>(table: Readonly<Record<T, string>>, value: string): string =>
  Object.hasOwn(table, value) ? table[value as T] : UNKNOWN_TEXT;

/** 글의 이름: 규칙을 만들거나 고친 이유는 사유, 판단 · 폐기 · 대체 · 이의의 뒷받침은 근거. */
const GROUNDS_KINDS: ReadonlySet<NormChangeKind> = new Set([
  'judgment',
  'retired',
  'superseded',
  'objection',
]);

/** 변경 이력 한 줄의 값. */
export interface NormChangeRow {
  readonly seq: number;
  readonly at: string;
  readonly time: string;
  readonly kind: string;
  readonly actor: string;
  /** 판단 결과 · 대체 대상 (없으면 null). 규칙은 링크로 그린다 */
  readonly subject: {
    readonly label: string;
    readonly rules: readonly NormJudgmentRuleRef[];
  } | null;
  /** 사유 · 근거 (없으면 null) */
  readonly text: { readonly label: string; readonly value: string } | null;
  readonly truncated: boolean;
}

const actorText = (actor: NormChangeView['actor']): string =>
  actor.kind === 'agent'
    ? `${AUTHOR_LABELS.agent} · ${AGENT_ROLE_LABELS[actor.role]}`
    : NORM_CHANGE_TEXT.orchestrator;

const subjectOf = (entry: NormChangeView): NormChangeRow['subject'] => {
  const { judgment, retirement } = entry.detail;
  if (entry.kind === 'judgment' && judgment !== undefined) {
    // 이의 판단 (M7-11, ADR-115): "이의 판단 · 유지 · 폐기 · 대체", 판단 없이 끝났으면 "판단 없음(사정)"을 덧붙인다
    if (judgment.subject === 'objection') {
      const verdict = labelOf(JUDGMENT_VERDICT_TEXT, judgment.verdict);
      const undecided =
        judgment.undecided === undefined
          ? ''
          : ` · ${NORM_CHANGE_TEXT.undecided} (${labelOf(UNDECIDED_REASON_TEXT, judgment.undecided.endReason)})`;
      return {
        label: `${JUDGMENT_SUBJECT_TEXT.objection} · ${verdict}${undecided}`,
        rules: [],
      };
    }
    // 검사 실패 판단 (M7-12, ADR-118): "검사 실패 판단 · 모순(대상 규칙 링크) · 모순 없음", 판단 없이 끝났으면 "판단 없음(사정)"
    if (judgment.subject === 'check_failure') {
      const contradiction = judgment.verdict === 'contradiction';
      const verdict = contradiction
        ? NORM_CHANGE_TEXT.contradiction
        : judgment.verdict === 'no_contradiction'
          ? NORM_CHANGE_TEXT.noContradiction
          : UNKNOWN_TEXT;
      const undecided =
        judgment.undecided === undefined
          ? ''
          : ` · ${NORM_CHANGE_TEXT.undecided} (${labelOf(UNDECIDED_REASON_TEXT, judgment.undecided.endReason)})`;
      return {
        label: `${JUDGMENT_SUBJECT_TEXT.check_failure} · ${verdict}${undecided}`,
        rules: contradiction ? judgment.contradicts : [],
      };
    }
    if (!Object.hasOwn(JUDGMENT_SUBJECT_TEXT, judgment.subject)) {
      return { label: UNKNOWN_TEXT, rules: [] };
    }
    return judgment.verdict === 'contradiction'
      ? { label: NORM_CHANGE_TEXT.contradiction, rules: judgment.contradicts }
      : judgment.verdict === 'no_contradiction'
        ? { label: NORM_CHANGE_TEXT.noContradiction, rules: [] }
        : { label: UNKNOWN_TEXT, rules: [] };
  }
  if (retirement !== undefined && retirement.supersededBy !== null) {
    return { label: NORM_CHANGE_TEXT.successor, rules: [retirement.supersededBy] };
  }
  return null;
};

/** 기록 1건 → 줄. */
export const normChangeRow = (entry: NormChangeView): NormChangeRow => ({
  seq: entry.seq,
  at: entry.at,
  time: formatCardTime(entry.at) ?? entry.at,
  kind: NORM_CHANGE_KIND_TEXT[entry.kind],
  actor: actorText(entry.actor),
  subject: subjectOf(entry),
  text:
    entry.reason === null
      ? null
      : {
          label: GROUNDS_KINDS.has(entry.kind) ? NORM_CHANGE_TEXT.grounds : NORM_CHANGE_TEXT.reason,
          value: entry.reason,
        },
  truncated: entry.textTruncated,
});
