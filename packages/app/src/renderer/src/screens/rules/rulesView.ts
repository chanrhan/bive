// 규칙 화면의 표시 규칙 (screens.md SCR-03 카드 · 필터, 1.4, ADR-060, ADR-100 I3 · D7, M7-15 #227 · ADR-114). DOM · React에
// 의존하지 않는다 (test/rules-view.test.ts).
// - 카드: 1줄 제목 · 생성 주체 아이콘(판정이 통과면 앞에 흐린 점), 2줄 표시 ID · WHEN 조건 · 예외. 제목 · WHEN 조건은 숨은 글자를
//   보이는 표기로 바꿔 그린다(visibleText)
// - 예외: 판정 상태의 예외(실패 · 미판정 · 격리 · 재검증 필요, 1.4 상태 배지) 다음에 규범 예외(폐기 · 미확인). 미확인은 옛 '잠정'
//   자리다(ADR-100 명세 변경 목록 SCR-03). 폐기된 규칙은 더 판정하지 않으므로(ADR-112) 판정 예외 없이 폐기 · 미확인만 보인다.
//   변이 생존은 변이 데이터가 생기면(P1) 더한다. 값은 rule.list 결과(규칙 필드 · 최신 판정 · 폐기 사실)에서만 도출한다(NFR-03)
// - 추적성 결함(부모 없는 규칙, SCR-03 "결함: 요구사항과 연결되지 않은 규칙 (내장 구조 규칙 제외)")은 규범 예외 맨 앞
//   "추적성 결함"(danger, 요구사항 카드와 같은 낱말 · 색). 서버가 정한 목록(`rule.list`의 `traceability.parentlessRules`)에 든
//   규칙만이고 화면은 다시 세지 않는다(내장 · 폐기 규칙은 서버가 뺀다, M3-11 #56 · ADR-137). 목록을 모르면 보이지 않는다
// - 필터: 판정 · 변이 · 준수 집계 · 확인 · 블록 · 위험도 · 종류. 변이는 지금 값이 없어 0건 비활성 (ADR-035). 블록 · 위험도는
//   규칙의 대상 블록 · 위험도에서 센다(블록 값은 목록 규칙이 가진 이름 전부, 이름 순. M3-19 #64 · ADR-126).
//   폐기된 규칙은 기본 목록에서 빠지고 [폐기 포함]을 켜야 보인다(ListView `hidden`)
import type {
  AuthorKind,
  ConfirmationState,
  JudgmentStatus,
  Risk,
  RuleKind,
  RuleWithJudgment,
  Traceability,
} from '@bive/shared';

import type { FilterCriterion } from '../../components/ListView/filter.js';
import {
  type BadgeStatus,
  CONFIRMATION_LABELS,
  type ExceptionMark,
  JUDGMENT_LABELS,
  MUTATION_LABELS,
} from '../../components/StatusBadge/status.js';
import { visibleText } from '../../components/VisibleText/visibleText.js';
import { BLOCK_TEXT, blockOptions } from './blockView.js';

/** 목록 ID = 경로 ID (ADR-048). 필터 상태가 이 ID로 유지된다. */
export const RULES_LIST_ID = 'rules';

export const TEXT = {
  list: '규칙 목록',
  empty: '규칙 없음',
  loadFailed: '규칙 불러오기 실패',
  noProject: '프로젝트 없음',
  detail: '상세',
  noSelection: '선택 항목 없음',
} as const;

/** 규칙 종류 표시명 (shared RULE_KIND_LABELS와 같음, test/rules-view.test.ts가 대조). */
export const RULE_KIND_LABELS = {
  architecture: '아키텍처',
  'tech-constraint': '기술 제약',
  business: '비즈니스',
} as const satisfies Record<RuleKind, string>;

/** 위험도 표시명 (shared RISK_LABELS와 같음, test/rules-view.test.ts가 대조). */
export const RISK_LABELS = {
  low: '낮음',
  medium: '보통',
  high: '높음',
} as const satisfies Record<Risk, string>;

/** 위험도 표시 (규칙 상세). 값이 없는 옛 규칙 · 내장 규칙은 "없음"(ADR-126). */
export const riskText = (risk: Risk | null): string =>
  risk === null ? BLOCK_TEXT.none : RISK_LABELS[risk];

/**
 * 준수 집계 값 (SCR-03 필터 "판정 가능 = 분모 · 격리", JDG-03, ADR-100 명세 변경 목록 SCR-03 "잠정 → 사람 확인" · D7).
 * - 판정 가능: 지금 준수 분모(효력 있고 격리 아님, `verification.summary`와 같은 정의)
 * - 사람 확인: 판정 가능 가운데 확인됨인 규칙 = 사람 확인 기준 준수의 분모(D7). 판정 가능의 부분 집합이라 두 값을 함께 가진다
 * - 격리: 최신 판정이 격리(판정에서 일시 제외)
 * 폐기된 규칙 · 효력 상태가 아닌 규칙은 어느 값도 갖지 않는다(두 분모에서 빠진다, ADR-112).
 */
export type ComplianceGroup = 'judgeable' | 'human_confirmed' | 'quarantined';

export const COMPLIANCE_LABELS = {
  judgeable: '판정 가능',
  human_confirmed: '사람 확인',
  quarantined: '격리',
} as const satisfies Record<ComplianceGroup, string>;

/** 폐기된 규칙인지 (응답에 실린 폐기 사실 `retirement`만 본다, ADR-114). */
export const isRetiredRule = (item: Pick<RuleWithJudgment, 'retirement'>): boolean =>
  item.retirement !== undefined;

/**
 * 준수 집계 묶음 (ADR-060 · ADR-114): 분모(판정 가능) 또는 격리. 폐기 · 효력 상태 아님이면 `null`(분모에 들지 않음).
 * 규칙은 검사 종류가 1개 이상이라(NRM-02) 모두 검사가 붙어 있다.
 */
export const complianceGroup = (item: RuleWithJudgment): 'judgeable' | 'quarantined' | null => {
  if (isRetiredRule(item) || item.rule.normState !== 'approved') return null;
  return item.judgment.status === 'quarantined' ? 'quarantined' : 'judgeable';
};

/** 준수 집계 칩의 값들: 묶음 + (판정 가능이고 확인됨이면) 사람 확인. */
export const complianceValues = (item: RuleWithJudgment): ComplianceGroup[] => {
  const group = complianceGroup(item);
  if (group === null) return [];
  return group === 'judgeable' && item.rule.confirmation.state === 'confirmed'
    ? ['judgeable', 'human_confirmed']
    : [group];
};

/** 기본 목록에서 숨기는 항목: 폐기된 규칙 ([폐기 포함]을 켜야 보인다, ADR-100 명세 변경 목록 SCR-03). */
export const RETIRED_HIDDEN = {
  label: '폐기 포함',
  isHidden: isRetiredRule,
} as const;

/** 낱말 키워드: 앞이 문장 처음이나 공백이고 뒤가 공백(또는 끝)인 것만. 괄호 주석 `(WHEN)` 등은 키워드가 아니다. */
const SHALL = /(?:^|\s)(shall)(?=\s|$)/i;
const WHEN = /(?:^|\s)(when)(?=\s)/gi;
/** 대문자 표기(`… THE SYSTEM SHALL`)의 응답 주어 시작: 대문자 `THE`만 (조건 안의 소문자 the와 섞이지 않게). */
const UPPER_SUBJECT = /(?:^|[\s,，])(THE)(?=\s)/g;
/** 소문자 표기(`When …, the system shall`)의 응답 주어 시작: 쉼표 + 공백 뒤의 `the`만 (EARS 영어 문형). */
const LOWER_SUBJECT = /[,，]\s*(the)(?=\s)/gi;
/** 응답 주어(`THE` 다음부터 `SHALL` 앞까지)는 낱말과 공백만이다. 문장 부호가 섞이면 주어로 보지 않는다. */
const SUBJECT_BODY = /^\s+[\p{L}\p{N}_-]+(?:\s+[\p{L}\p{N}_-]+)*\s*$/u;

/**
 * 진술(EARS)의 WHEN 조건 (ADR-060). 확신할 수 있을 때만 진술 문구를 그대로 잘라 돌려주고(고쳐 쓰지 않음, NFR-03),
 * 아니면 `null`(표시하지 않음):
 * 1. 첫 낱말 `SHALL`을 찾고, 그 앞에 낱말 `WHEN`이 정확히 하나 있어야 한다 (`SHALL` 뒤의 when은 조건이 아니다)
 * 2. 조건의 끝 = 응답 주어 바로 앞. `SHALL`이 대문자면 `WHEN`과 `SHALL` 사이 마지막 대문자 `THE`,
 *    아니면 마지막 "쉼표 + `the`". 주어(`THE` ~ `SHALL`)에 문장 부호가 있으면 경계를 확신할 수 없어 `null`
 * 3. 조건 = `WHEN`부터 주어 앞까지(끝 공백 · 쉼표 제거). 조건 안의 쉼표(숫자 `1,000` · 삽입구)는 그대로 둔다
 */
export const whenCondition = (statement: string): string | null => {
  const shall = SHALL.exec(statement);
  if (shall === null) return null;
  const shallStart = shall.index + shall[0].length - (shall[1] ?? '').length;
  const head = statement.slice(0, shallStart);

  const whens = [...head.matchAll(WHEN)];
  const when = whens[0];
  if (when === undefined || whens.length !== 1) return null;
  const whenStart = when.index + when[0].length - (when[1] ?? '').length;
  const afterWhen = whenStart + (when[1] ?? '').length;

  const upper = shall[1] === 'SHALL';
  const clause = head.slice(afterWhen);
  const subject = [...clause.matchAll(upper ? UPPER_SUBJECT : LOWER_SUBJECT)].at(-1);
  if (subject === undefined) return null;
  const subjectWord = subject[1] ?? '';
  const subjectStart = subject.index + subject[0].length - subjectWord.length;
  if (!SUBJECT_BODY.test(clause.slice(subjectStart + subjectWord.length))) return null;

  const condition = statement.slice(whenStart, afterWhen + subjectStart).replace(/[\s,，]+$/u, '');
  return condition.length > (when[1] ?? '').length ? condition : null;
};

/** 카드의 규범 예외 (판정 예외 다음, 이 순서로: 추적성 결함 · 폐기 · 미확인). */
export const TRACEABILITY_MARK: ExceptionMark = {
  key: 'traceability',
  label: '추적성 결함',
  tone: 'danger',
};
export const RETIRED_MARK: ExceptionMark = { key: 'retired', label: '폐기', tone: 'warning' };
export const UNCONFIRMED_MARK: ExceptionMark = {
  key: 'unconfirmed',
  label: CONFIRMATION_LABELS.unconfirmed,
  tone: 'info',
};

/**
 * 카드 값 (Card2Line `CardData`와 같은 모양. 이 파일은 단위 테스트가 JSX 없이 읽도록 .tsx를 가져오지 않는다).
 * 상태는 Card2Line이 정상(흐린 점) · 예외(2줄 글자)로 나눈다. 시각은 두지 않는다 (SCR-03 카드, ADR-060).
 */
export interface RuleCardData {
  title: string;
  id: string;
  note?: string;
  statuses: BadgeStatus[];
  exceptions: ExceptionMark[];
  author: AuthorKind;
}

/** 서버가 정한 부모 없는 규칙 ID (`rule.list`의 `traceability.parentlessRules`). 모르면 `null`. */
export type RuleDefects = ReadonlySet<string> | null;

export const ruleDefectsOf = (
  traceability: Pick<Traceability, 'parentlessRules'> | null,
): RuleDefects =>
  traceability === null ? null : new Set(traceability.parentlessRules.map((item) => item.id));

export const ruleCard = (item: RuleWithJudgment, defects: RuleDefects = null): RuleCardData => {
  const { rule, judgment } = item;
  const retired = isRetiredRule(item);
  // 폐기된 규칙의 판정은 폐기 전 기록이다(폐기 뒤 판정하지 않음): 카드에는 지금의 예외(폐기)만
  const statuses: BadgeStatus[] = retired ? [] : [{ kind: 'judgment', status: judgment.status }];
  const note = whenCondition(rule.statement);
  const exceptions: ExceptionMark[] = [];
  if (defects?.has(rule.id) === true) exceptions.push(TRACEABILITY_MARK);
  if (retired) exceptions.push(RETIRED_MARK);
  if (rule.confirmation.state === 'unconfirmed') exceptions.push(UNCONFIRMED_MARK);
  return {
    title: visibleText(rule.title),
    id: rule.displayId,
    ...(note !== null && { note: visibleText(note) }),
    statuses,
    exceptions,
    author: rule.author.kind,
  };
};

export const ruleKey = ({ rule }: RuleWithJudgment): string => rule.id;

/** 검색 대상: 카드에 보이는 제목 · 표시 ID · WHEN 조건 (ADR-048 기본 + 화면 2줄 문구). */
export const ruleSearchText = ({ rule }: RuleWithJudgment): string => {
  const note = whenCondition(rule.statement);
  return [visibleText(rule.title), rule.displayId, note === null ? '' : visibleText(note)].join(
    ' ',
  );
};

/** 항목 하나를 같은 ID의 새 값으로 바꾼다(직접 편집 저장 뒤, M7-03). 없으면 그대로. */
export const replaceRuleItem = (
  items: readonly RuleWithJudgment[],
  item: RuleWithJudgment,
): RuleWithJudgment[] =>
  items.map((current) => (current.rule.id === item.rule.id ? item : current));

/** 목록에 보일 규칙: 삭제된 것은 뺀다 (`list`는 삭제되지 않은 것만 주지만 한 번 더 거른다). */
export const visibleRules = (rules: readonly RuleWithJudgment[]): RuleWithJudgment[] =>
  rules.filter(({ rule }) => rule.deletedAt === null);

const options = <K extends string>(labels: Record<K, string>) =>
  (Object.keys(labels) as K[]).map((value) => ({ value, label: labels[value] }));

/**
 * 필터 기준 7종 (SCR-03 필터: 판정 · 변이 · 준수 집계 · 확인 · 블록 · 위험도 · 종류, 확인은 ADR-100 I3). 순서가 칩 순서다.
 * 블록 값은 받은 규칙(`items`, 폐기 포함)이 가진 이름이라 목록 데이터마다 만든다(ADR-126).
 */
export const ruleCriteria = (
  items: readonly RuleWithJudgment[],
): readonly FilterCriterion<RuleWithJudgment>[] => [
  {
    id: 'judgment',
    label: '판정',
    options: options<JudgmentStatus>(JUDGMENT_LABELS),
    // 폐기된 규칙은 더 판정하지 않는다: 지금 판정 값이 없다(카드에도 판정 예외가 없다, ADR-114)
    values: (item) => (isRetiredRule(item) ? [] : [item.judgment.status]),
  },
  {
    id: 'mutation',
    label: '변이',
    // 변이 결과(변이 주입 단계, P1)가 아직 없다 → 값 없음 = 0건 비활성 (ADR-035)
    options: options(MUTATION_LABELS),
    values: () => [],
  },
  {
    id: 'compliance',
    label: '준수 집계',
    options: options(COMPLIANCE_LABELS),
    values: complianceValues,
  },
  {
    id: 'confirmation',
    label: '확인',
    options: options<ConfirmationState>(CONFIRMATION_LABELS),
    values: ({ rule }) => [rule.confirmation.state],
  },
  {
    id: 'block',
    label: '블록',
    // 대상 블록 이름(선언에 없는 이름 포함). 블록 여러 개인 규칙은 블록마다 한 번씩 센다. 빈 목록인 옛 규칙은 값이 없다
    options: blockOptions(items.flatMap(({ rule }) => rule.targetBlockIds)),
    values: ({ rule }) => rule.targetBlockIds,
  },
  {
    id: 'risk',
    label: '위험도',
    // 값이 없는(null) 옛 규칙 · 내장 규칙은 값이 없다 ("없음" 칩 값은 두지 않는다, 다른 칩과 같음)
    options: options<Risk>(RISK_LABELS),
    values: ({ rule }) => (rule.risk === null ? [] : [rule.risk]),
  },
  {
    id: 'kind',
    label: '종류',
    options: options<RuleKind>(RULE_KIND_LABELS),
    values: ({ rule }) => [rule.kind],
  },
];
