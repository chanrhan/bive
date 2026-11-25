// 계약 화면의 표시 규칙 (screens.md SCR-04 표시 · 결함 · 필터, 1.4, NRM-03, ADR-100 I3 · 명세 변경 목록 SCR-04, M3-05 #50 · ADR-133).
// DOM · React에 의존하지 않는다 (test/contracts-view.test.ts).
// - 항목 = `contract.list`의 계약 하나 + 그 `contract` 검사 규칙의 최신 판정(`rule.list` 항목에서 규칙 ID로 찾는다). 값은 이 두
//   응답에서만 만든다(NFR-03)
// - 카드: 1줄 원본 파일(숨은 글자 표기) · 생성 주체 아이콘(판정이 통과면 앞에 흐린 점), 2줄 표시 ID · 예외 · 등록 시각
// - 예외: 결함(스키마 불일치 · 검사 규칙 없음) 다음 미확인. 스키마 불일치 = 검사 규칙의 최신 판정이 실패, 검사 규칙 없음 =
//   `contract.list`의 `rule`이 `null`. 판정 기록이 없으면 미판정이고 결함이 아니다(카드 예외 없음)
// - 필터: 종류 · 검사 규칙 · 판정 · 확인. 값과 개수는 목록 항목에서만 센다
import type {
  AuthorKind,
  ConfirmationState,
  Contract,
  ContractListResult,
  JudgmentStatus,
  RuleWithJudgment,
} from '@bive/shared';

import type { FilterCriterion } from '../../components/ListView/filter.js';
import {
  type BadgeStatus,
  CONFIRMATION_LABELS,
  type ExceptionMark,
  JUDGMENT_LABELS,
} from '../../components/StatusBadge/status.js';
import { visibleText } from '../../components/VisibleText/visibleText.js';

/** 목록 ID = 경로 ID (ADR-048). 필터 상태가 이 ID로 유지된다. */
export const CONTRACTS_LIST_ID = 'contracts';

export const TEXT = {
  list: '계약 목록',
  empty: '계약 없음',
  loadFailed: '계약 불러오기 실패',
  noProject: '프로젝트 없음',
  detail: '상세',
  noSelection: '선택 항목 없음',
  kind: '종류',
  sourceFile: '원본 파일',
  rule: '연결 규칙',
  judgment: '판정',
  parent: '부모 요구사항',
  author: '생성 주체',
  confirmation: '확인 상태',
  none: '없음',
} as const;

/** 계약 종류 표시명 (screens.md SCR-04 표시의 낱말 그대로). shared `ContractKind` 여섯 값. */
export const CONTRACT_KIND_LABELS = {
  openapi: 'API',
  'db-schema': 'DB',
  asyncapi: '이벤트',
  'external-api': '외부 API',
  cache: '캐시',
  'json-schema': 'JSON 스키마',
} as const satisfies Record<Contract['kind'], string>;

/** 표에 없는 종류 값의 표시 (응답이 넓어져도 화면이 깨지지 않게). */
export const UNKNOWN_KIND_LABEL = '알 수 없는 종류';

const isKnownKind = (kind: string): kind is Contract['kind'] =>
  Object.prototype.hasOwnProperty.call(CONTRACT_KIND_LABELS, kind);

export const contractKindLabel = (kind: string): string =>
  isKnownKind(kind) ? CONTRACT_KIND_LABELS[kind] : UNKNOWN_KIND_LABEL;

/** 계약 목록 항목: 계약 · 검사 규칙 참조 · 그 규칙의 최신 판정(규칙이 없거나 `rule.list`에 없으면 `null`). */
export interface ContractItem {
  contract: Contract;
  rule: { id: string; displayId: string } | null;
  judgment: JudgmentStatus | null;
}

/** `contract.list` 응답과 `rule.list` 항목을 합친다. 순서는 `contract.list` 그대로(표시 ID 순). */
export const contractItems = (
  contracts: ContractListResult['contracts'],
  rules: readonly RuleWithJudgment[],
): ContractItem[] => {
  const judgments = new Map(rules.map((item) => [item.rule.id, item.judgment.status]));
  return contracts.map(({ contract, rule }) => ({
    contract,
    rule,
    judgment: rule === null ? null : (judgments.get(rule.id) ?? null),
  }));
};

/** 결함 2종 (SCR-04 결함). 순서가 표시 순서다. */
export type ContractDefect = 'schema_mismatch' | 'no_rule';

export const DEFECT_LABELS = {
  schema_mismatch: '스키마 불일치',
  no_rule: '검사 규칙 없음',
} as const satisfies Record<ContractDefect, string>;

/** 결함: 검사 규칙이 없으면 "검사 규칙 없음", 검사 규칙의 최신 판정이 실패면 "스키마 불일치". */
export const contractDefects = (item: ContractItem): ContractDefect[] => {
  if (item.rule === null) return ['no_rule'];
  return item.judgment === 'fail' ? ['schema_mismatch'] : [];
};

const DEFECT_MARKS: Record<ContractDefect, ExceptionMark> = {
  schema_mismatch: { key: 'schema_mismatch', label: DEFECT_LABELS.schema_mismatch, tone: 'danger' },
  no_rule: { key: 'no_rule', label: DEFECT_LABELS.no_rule, tone: 'danger' },
};

/** 미확인 예외 (요구사항 · 규칙 카드와 같은 글자 · 색). */
export const UNCONFIRMED_MARK: ExceptionMark = {
  key: 'unconfirmed',
  label: CONFIRMATION_LABELS.unconfirmed,
  tone: 'info',
};

/** 카드 값 (Card2Line `CardData`와 같은 모양. 이 파일은 단위 테스트가 JSX 없이 읽도록 .tsx를 가져오지 않는다). */
export interface ContractCardData {
  title: string;
  id: string;
  statuses: BadgeStatus[];
  exceptions: ExceptionMark[];
  dateTime: string;
  author: AuthorKind;
}

export const contractCard = (item: ContractItem): ContractCardData => {
  const { contract } = item;
  const exceptions = contractDefects(item).map((defect) => DEFECT_MARKS[defect]);
  if (contract.confirmation.state === 'unconfirmed') exceptions.push(UNCONFIRMED_MARK);
  return {
    title: visibleText(contract.sourceFile),
    id: contract.displayId,
    // 통과만 1줄 앞 흐린 점. 실패는 결함 "스키마 불일치"로 보이고, 그 밖의 판정은 카드에 두지 않는다(상세 · 판정 칩)
    statuses: item.judgment === 'pass' ? [{ kind: 'judgment', status: 'pass' }] : [],
    exceptions,
    dateTime: contract.createdAt,
    author: contract.author.kind,
  };
};

export const contractKey = ({ contract }: ContractItem): string => contract.id;

/** 검색 대상: 카드에 보이는 원본 파일 · 표시 ID. */
export const contractSearchText = ({ contract }: ContractItem): string =>
  `${visibleText(contract.sourceFile)} ${contract.displayId}`;

/** 판정 표시 (상세). 검사 규칙이 없거나 판정을 모르면 "없음". */
export const judgmentText = (judgment: JudgmentStatus | null): string =>
  judgment === null ? TEXT.none : JUDGMENT_LABELS[judgment];

/** 검사 규칙 칩 값. */
export type RuleLink = 'linked' | 'missing';

export const RULE_LINK_LABELS = {
  linked: '있음',
  missing: '없음',
} as const satisfies Record<RuleLink, string>;

const options = <K extends string>(labels: Record<K, string>) =>
  (Object.keys(labels) as K[]).map((value) => ({ value, label: labels[value] }));

/** 필터 기준 4종 (SCR-04 필터: 종류 · 검사 규칙 · 판정, 확인은 ADR-100 I3). 순서가 칩 순서다. */
export const CONTRACT_CRITERIA: readonly FilterCriterion<ContractItem>[] = [
  {
    id: 'kind',
    label: '종류',
    options: options(CONTRACT_KIND_LABELS),
    values: ({ contract }) => (isKnownKind(contract.kind) ? [contract.kind] : []),
  },
  {
    id: 'rule',
    label: '검사 규칙',
    options: options<RuleLink>(RULE_LINK_LABELS),
    values: ({ rule }) => [rule === null ? 'missing' : 'linked'],
  },
  {
    id: 'judgment',
    label: '판정',
    options: options<JudgmentStatus>(JUDGMENT_LABELS),
    // 검사 규칙이 없거나 그 판정을 모르면 값이 없다
    values: ({ judgment }) => (judgment === null ? [] : [judgment]),
  },
  {
    id: 'confirmation',
    label: '확인',
    options: options<ConfirmationState>(CONFIRMATION_LABELS),
    values: ({ contract }) => [contract.confirmation.state],
  },
];
