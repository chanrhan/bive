// 규칙 화면의 표시 규칙 (screens.md SCR-03 카드 · 필터, 1.4, ADR-060). DOM · React에 의존하지 않는다
// (test/rules-view.test.ts).
// - 카드: 1줄 제목 · 생성 주체 아이콘(판정이 통과면 앞에 흐린 점), 2줄 표시 ID · WHEN 조건 · 예외
// - 예외: 판정 상태의 예외(실패 · 미판정 · 격리 · 재검증 필요, 1.4 상태 배지) + 잠정. 변이 생존은 변이 데이터가
//   생기면(P1) 더한다. 값은 rule.list 결과(규칙 필드 · 최신 판정)에서만 도출한다(NFR-03)
// - 필터: 판정 · 변이 · 준수 집계 · 블록 · 위험도 · 종류. 변이 · 블록 · 위험도는 지금 값이 없어 0건 비활성 (ADR-035)
import type { AuthorKind, JudgmentStatus, Risk, RuleKind, RuleWithJudgment } from '@bive/shared';

import type { FilterCriterion } from '../../components/ListView/filter.js';
import {
  type BadgeStatus,
  type ExceptionMark,
  JUDGMENT_LABELS,
  MUTATION_LABELS,
} from '../../components/StatusBadge/status.js';

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

/** 준수 집계 묶음 (SCR-03 필터 "판정 가능 = 분모 · 잠정 · 격리", JDG-03). 규칙 하나는 한 묶음에만 든다. */
export type ComplianceGroup = 'judgeable' | 'provisional' | 'quarantined';

export const COMPLIANCE_LABELS = {
  judgeable: '판정 가능',
  provisional: '잠정',
  quarantined: '격리',
} as const satisfies Record<ComplianceGroup, string>;

/**
 * 준수 집계 묶음 (ADR-060). 잠정 승인 규칙은 분모에서 분리(JDG-03), 최신 판정이 격리면 판정에서 일시 제외
 * (기획서 3.4), 나머지 승인된 규칙이 판정 가능(분모)이다. 규칙은 검사 종류가 1개 이상이라(NRM-02) 모두 검사가 붙어 있다.
 */
export const complianceGroup = ({ rule, judgment }: RuleWithJudgment): ComplianceGroup => {
  if (rule.normState === 'provisional') return 'provisional';
  if (judgment.status === 'quarantined') return 'quarantined';
  return 'judgeable';
};

const WHEN = /\bwhen\b/i;
const SHALL = /\bshall\b/i;
const THE = /\bthe\b/gi;

/**
 * 진술(EARS)의 WHEN 조건 (ADR-060): 첫 `WHEN`부터 그 뒤 첫 `SHALL` 앞까지에서, 쉼표가 있으면 쉼표 앞까지,
 * 없으면 마지막 `THE`(응답 주어 "THE SYSTEM") 앞까지. 진술 문구를 그대로 잘라 쓰고 고쳐 쓰지 않는다(NFR-03).
 * `WHEN`이 없거나 그 뒤에 `SHALL`이 없으면(이벤트 조건이 없는 진술) `null`.
 */
export const whenCondition = (statement: string): string | null => {
  const when = WHEN.exec(statement);
  if (when === null) return null;
  const afterWhen = when.index + when[0].length;
  const shall = SHALL.exec(statement.slice(afterWhen));
  if (shall === null) return null;
  let clause = statement.slice(afterWhen, afterWhen + shall.index);
  const comma = clause.search(/[,，]/);
  if (comma >= 0) {
    clause = clause.slice(0, comma);
  } else {
    const subjects = [...clause.matchAll(THE)];
    const last = subjects.at(-1);
    if (last !== undefined) clause = clause.slice(0, last.index);
  }
  const condition = clause.trim();
  return condition === '' ? null : `${when[0]} ${condition}`;
};

const PROVISIONAL_MARK: ExceptionMark = { key: 'provisional', label: '잠정', tone: 'info' };

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

export const ruleCard = ({ rule, judgment }: RuleWithJudgment): RuleCardData => {
  const statuses: BadgeStatus[] = [{ kind: 'judgment', status: judgment.status }];
  const note = whenCondition(rule.statement);
  return {
    title: rule.title,
    id: rule.displayId,
    ...(note !== null && { note }),
    statuses,
    exceptions: rule.normState === 'provisional' ? [PROVISIONAL_MARK] : [],
    author: rule.author.kind,
  };
};

export const ruleKey = ({ rule }: RuleWithJudgment): string => rule.id;

/** 검색 대상: 카드에 보이는 제목 · 표시 ID · WHEN 조건 (ADR-048 기본 + 화면 2줄 문구). */
export const ruleSearchText = ({ rule }: RuleWithJudgment): string =>
  [rule.title, rule.displayId, whenCondition(rule.statement) ?? ''].join(' ');

/** 목록에 보일 규칙: 삭제된 것은 뺀다 (`list`는 삭제되지 않은 것만 주지만 한 번 더 거른다). */
export const visibleRules = (rules: readonly RuleWithJudgment[]): RuleWithJudgment[] =>
  rules.filter(({ rule }) => rule.deletedAt === null);

const options = <K extends string>(labels: Record<K, string>) =>
  (Object.keys(labels) as K[]).map((value) => ({ value, label: labels[value] }));

/** 필터 기준 6종 (SCR-03 필터: 판정 · 변이 · 준수 집계 · 블록 · 위험도 · 종류). 순서가 칩 순서다. */
export const RULE_CRITERIA: readonly FilterCriterion<RuleWithJudgment>[] = [
  {
    id: 'judgment',
    label: '판정',
    options: options<JudgmentStatus>(JUDGMENT_LABELS),
    values: ({ judgment }) => [judgment.status],
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
    values: (item) => [complianceGroup(item)],
  },
  {
    id: 'block',
    label: '블록',
    // 블록(파서, M2)이 아직 없어 블록 이름을 알 수 없다 → 값 없음 = 0건 비활성 (ADR-035)
    options: [],
    values: () => [],
  },
  {
    id: 'risk',
    label: '위험도',
    // 위험도는 P1(M2)부터 채워진다. 지금은 모든 규칙이 null이라 0건 비활성 (ADR-035)
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
