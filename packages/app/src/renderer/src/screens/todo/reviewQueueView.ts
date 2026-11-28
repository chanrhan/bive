// 검토 대기열 (SCR-18, TODO-02 · COST-01, ADR-100 명세 변경 SCR-18 · 할 일 공통 · D8, ADR-145 · ADR-149 · ADR-153 · ADR-155 ·
// ADR-157)의 카드 · 필터 · 상세 · 액션 입력 · 거부 문구. DOM · React에 의존하지 않는다 (test/todo-review-queue.test.ts).
// - 값은 `reviewQueue.list` · `run.get` 응답에서만 만든다(NFR-03). 규칙 제목은 원문으로 오므로 `visibleText`로 그린다
// - 입력 검증은 서버가 기준이다: 화면은 빈 값(공백뿐 포함)이면 [확인]을 끄고, 한도 비교 · 제외 경로 문법은 서버 거부로 보인다
// - 표시명 표는 shared 표를 다시 적고 시험이 대조한다(렌더러는 shared를 타입으로만 가져온다, architecture.md 2장)
import type {
  AgentRole,
  BudgetLimits,
  BudgetSnapshot,
  ReviewAction,
  ReviewConflictReason,
  ReviewItemKind,
  ReviewItemState,
  ReviewQueueEntry,
  ReviewQueueListResult,
} from '@bive/shared';

import type { CardData } from '../../components/Card2Line/card.js';
import type { FilterCriterion } from '../../components/ListView/filter.js';
import type { ExceptionMark } from '../../components/StatusBadge/status.js';
import { visibleText } from '../../components/VisibleText/visibleText.js';
import { AGENT_ROLE_LABELS } from '../../proposals/labels.js';
import { parseTurns, parseUsd } from '../settings-modal/form.js';

/** 화면 문구 (screens.md 1.1 명사형). */
export const REVIEW_TEXT = {
  tab: '검토 대기열',
  list: '검토 대기열 목록',
  empty: '검토 항목 없음',
  loadFailed: '목록 불러오기 실패',
  noSelection: '선택 항목 없음',
  detail: '선택 항목',
  unknown: '알 수 없음',
  run: '원인 실행',
  runId: '표시 ID',
  runStatus: '상태',
  failureReason: '종료 사유',
  stoppedStep: '멈춘 단계',
  runFailed: '실행 불러오기 실패',
  rules: '대상 규칙',
  result: '처리 결과',
  action: '액션',
  resolvedAt: '처리 시각',
  createdRun: '만든 실행',
  splitRule: '나눈 규칙',
  reason: '사유',
  objection: '이의 제기',
  objectionHint: '동작 정의 전',
  confirm: '확인',
  cancel: '취소',
  saving: '저장 중',
  failed: '처리 실패',
  limits: '새 한도',
  limitsUnavailable: '지금 한도 불러오기 전',
  exclude: '제외 경로',
  excludeHint: '한 줄에 경로 하나 · 폴더 아래 전체는 끝에 /**',
  excludePlaceholder: 'src/legacy/**',
  splitTarget: '나눌 규칙',
  runAll: '실행 전체',
  usd: 'USD',
  turns: '턴',
} as const;

/** 항목 종류 표시명 (shared `REVIEW_ITEM_KIND_LABELS`와 같음, 시험이 대조). 순서가 툴팁에서 건수가 같을 때의 순서다. */
export const REVIEW_ITEM_KIND_TEXT = {
  budget_exceeded: '예산 초과',
  mutant_survived: '변이 생존',
} as const satisfies Record<ReviewItemKind, string>;

/** 처리 상태 표시명 (shared `REVIEW_ITEM_STATE_LABELS`와 같음). */
export const REVIEW_ITEM_STATE_TEXT = {
  open: '열림',
  resolved: '처리됨',
} as const satisfies Record<ReviewItemState, string>;

/** 처리 액션 표시명 (shared `REVIEW_ACTION_LABELS`와 같음). */
export const REVIEW_ACTION_TEXT = {
  raise_limit_resume: '한도 상향 재개',
  narrow_allowlist_resume: '허용 목록 축소 재개',
  split_rule: '규칙 분할',
  reinforce: '테스트 보강',
  quarantine: '판정 격리',
} as const satisfies Record<ReviewAction, string>;

/** 항목 종류마다 버튼 순서 (shared `REVIEW_ACTIONS_BY_KIND`와 같음). 변이 생존의 [이의 제기]는 액션이 아니라 늘 꺼진 버튼이다. */
export const REVIEW_ACTIONS_BY_KIND_ORDER = {
  budget_exceeded: ['raise_limit_resume', 'narrow_allowlist_resume', 'split_rule'],
  mutant_survived: ['reinforce', 'quarantine'],
} as const satisfies Record<ReviewItemKind, readonly ReviewAction[]>;

export const reviewState = (entry: ReviewQueueEntry): ReviewItemState =>
  entry.item.resolution === null ? 'open' : 'resolved';

export const reviewKey = (entry: ReviewQueueEntry): string => String(entry.item.seq);

/** 열린 항목의 카드 예외 (화면 정의서 1.4 "예외만 강조"). 처리된 항목은 예외가 없다(처리됨 = 정상). */
const KIND_EXCEPTIONS = {
  budget_exceeded: { key: 'budget_exceeded', label: '예산 초과', tone: 'warning' },
  mutant_survived: { key: 'mutant_survived', label: '변이 생존', tone: 'danger' },
} as const satisfies Record<ReviewItemKind, ExceptionMark>;

/**
 * 카드 1줄 제목: 대상 규칙 제목. 대상 규칙이 여럿이면(예산 초과 항목의 실행 대상) "첫 제목 외 n", 없으면 "알 수 없음".
 * 규칙 제목은 원문이라 `visibleText`를 거친다.
 */
export const reviewTitle = (entry: ReviewQueueEntry): string => {
  const [first, ...rest] = entry.rules;
  if (first === undefined) return REVIEW_TEXT.unknown;
  const title = visibleText(first.title);
  return rest.length === 0 ? title : `${title} 외 ${String(rest.length)}`;
};

/**
 * 카드 (화면 정의서 1.4 카드 2줄, SCR-18): 1줄 = 대상 규칙 제목, 2줄 = 원인 실행의 표시 ID · 종류 · 등록 시각. 열린 항목은 종류가
 * 예외(글자 + 색)이고, 처리된 항목은 종류와 처리한 액션을 흐린 보조 문구로 보인다.
 */
export const reviewCard = (entry: ReviewQueueEntry): CardData => {
  const { item } = entry;
  const resolution = item.resolution;
  return {
    title: reviewTitle(entry),
    id: entry.run.displayId,
    ...(resolution === null
      ? { exceptions: [KIND_EXCEPTIONS[item.kind]] }
      : {
          note: `${REVIEW_ITEM_KIND_TEXT[item.kind]} · ${REVIEW_ACTION_TEXT[resolution.action]}`,
        }),
    dateTime: item.createdAt,
  };
};

export const reviewSearchText = (entry: ReviewQueueEntry): string =>
  [
    reviewTitle(entry),
    entry.run.displayId,
    ...entry.rules.map((rule) => `${rule.displayId} ${visibleText(rule.title)}`),
  ].join(' ');

const options = <K extends string>(table: Readonly<Record<K, string>>) =>
  (Object.keys(table) as K[]).map((value) => ({ value, label: table[value] }));

/** 필터 칩 2종 (SCR-18 필터 "종류 · 처리 상태"). 값별 개수는 목록 항목에서만 센다(ListView). 기본값은 없다(확인할 것과 같음). */
export const REVIEW_CRITERIA: readonly FilterCriterion<ReviewQueueEntry>[] = [
  {
    id: 'kind',
    label: '종류',
    options: options(REVIEW_ITEM_KIND_TEXT),
    values: (entry) => [entry.item.kind],
  },
  {
    id: 'state',
    label: '처리 상태',
    options: options(REVIEW_ITEM_STATE_TEXT),
    values: (entry) => [reviewState(entry)],
  },
];

// ── 배지 · 툴팁 ──────────────────────────────────────────────

/** 할 일 배지에 더하는 검토 대기열 건수 = 열린 항목 수 (ADR-100 "할 일 공통"). 모르면 null. */
export const openReviewCount = (result: ReviewQueueListResult | null): number | null =>
  result === null ? null : result.entries.filter((e) => e.item.resolution === null).length;

/** 툴팁의 검토 대기열 종류별 건수 (열린 항목만, 종류 표 순서). */
export const openReviewByKind = (result: ReviewQueueListResult): Record<ReviewItemKind, number> => {
  const counts = { budget_exceeded: 0, mutant_survived: 0 };
  for (const entry of result.entries) {
    if (entry.item.resolution === null) counts[entry.item.kind] += 1;
  }
  return counts;
};

// ── 상세 ─────────────────────────────────────────────────────

/** 처리 결과 (처리된 항목만). 만든 실행은 ID만 오므로 표시 ID는 `run.get`으로 읽은 값이다(없으면 null). */
export interface ReviewResultModel {
  readonly action: string;
  readonly at: string;
  /** 테스트 보강 · 재개 액션이 만든 실행의 ID (`run.get`으로 표시 ID를 읽는다) */
  readonly runId: string | null;
  /** 규칙 분할의 나눈 규칙 (항목의 대상 규칙 가운데). 목록에 없으면 null */
  readonly rule: { readonly displayId: string; readonly title: string } | null;
  /** 판정 격리 사유 (원문을 `visibleText`로) */
  readonly reason: string | null;
}

export const reviewResult = (entry: ReviewQueueEntry): ReviewResultModel | null => {
  const resolution = entry.item.resolution;
  if (resolution === null) return null;
  const base = { action: REVIEW_ACTION_TEXT[resolution.action], at: resolution.at };
  switch (resolution.action) {
    case 'reinforce':
    case 'raise_limit_resume':
    case 'narrow_allowlist_resume':
      return { ...base, runId: resolution.runId, rule: null, reason: null };
    case 'quarantine':
      return { ...base, runId: null, rule: null, reason: visibleText(resolution.reason) };
    case 'split_rule': {
      const rule = entry.rules.find((r) => r.id === resolution.ruleId);
      return {
        ...base,
        runId: null,
        rule:
          rule === undefined ? null : { displayId: rule.displayId, title: visibleText(rule.title) },
        reason: null,
      };
    }
  }
};

// ── 액션 입력 ────────────────────────────────────────────────

/** 판정 격리 [확인]: 사유가 비면(공백뿐 포함) 꺼진다. 길이 · 그 밖의 형식은 서버가 본다. */
export const quarantineReady = (reason: string): boolean => reason.trim() !== '';

/** 새 한도 입력 칸 하나: `run.<값>` 또는 `roles.<역할>.<값>` (shared `BudgetSnapshot`의 경로, 서버 거부의 `data.fields`와 같음). */
export interface BudgetField {
  readonly key: string;
  readonly label: string;
  readonly kind: 'usd' | 'turns';
}

const limitFields = (prefix: string, owner: string): BudgetField[] => [
  { key: `${prefix}.maxBudgetUsd`, label: `${owner} ${REVIEW_TEXT.usd}`, kind: 'usd' },
  { key: `${prefix}.maxTurns`, label: `${owner} ${REVIEW_TEXT.turns}`, kind: 'turns' },
];

/** 원 실행의 예산 값(`run.get`의 `budgetSnapshot`)과 같은 모양의 입력 칸: 실행 전체 → 역할(스냅샷 순서). */
export const budgetFields = (snapshot: BudgetSnapshot): BudgetField[] => [
  ...limitFields('run', REVIEW_TEXT.runAll),
  ...(Object.keys(snapshot.roles) as AgentRole[]).flatMap((role) =>
    limitFields(`roles.${role}`, AGENT_ROLE_LABELS[role]),
  ),
];

/** 처음 입력 값 = 원 실행의 지금 한도 (사람이 올릴 값만 고친다). */
export const budgetFormValues = (snapshot: BudgetSnapshot): Record<string, string> => {
  const values: Record<string, string> = {};
  const put = (prefix: string, limits: BudgetLimits): void => {
    values[`${prefix}.maxBudgetUsd`] = String(limits.maxBudgetUsd);
    values[`${prefix}.maxTurns`] = String(limits.maxTurns);
  };
  put('run', snapshot.run);
  for (const role of Object.keys(snapshot.roles) as AgentRole[]) {
    const limits = snapshot.roles[role];
    if (limits !== undefined) put(`roles.${role}`, limits);
  }
  return values;
};

/**
 * 입력 값 → 요청의 `budget`. 빈 칸이 있거나 수로 읽을 수 없는 칸이 있으면 null([확인] 꺼짐). 읽는 규칙은 설정 화면의 예산 칸과
 * 같다(`parseUsd` · `parseTurns`). 원 실행과의 비교(내림 · 쓴 양)는 서버가 본다.
 */
export const budgetFromForm = (
  snapshot: BudgetSnapshot,
  values: Readonly<Record<string, string>>,
): BudgetSnapshot | null => {
  const read = (prefix: string): BudgetLimits | null => {
    const usd = parseUsd(values[`${prefix}.maxBudgetUsd`] ?? '');
    const turns = parseTurns(values[`${prefix}.maxTurns`] ?? '');
    return typeof usd === 'number' && typeof turns === 'number'
      ? { maxBudgetUsd: usd, maxTurns: turns }
      : null;
  };
  const run = read('run');
  if (run === null) return null;
  const roles: BudgetSnapshot['roles'] = {};
  for (const role of Object.keys(snapshot.roles) as AgentRole[]) {
    const limits = read(`roles.${role}`);
    if (limits === null) return null;
    roles[role] = limits;
  }
  return { run, roles };
};

/** 제외 경로 입력(한 줄에 하나) → 요청의 `exclude`: 줄마다 앞뒤 공백을 떼고 빈 줄은 뺀다. 패턴 문법은 서버가 본다. */
export const excludeLines = (raw: string): string[] =>
  raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** 규칙 분할 [확인]: 나눌 규칙을 골랐을 때만. 대상 규칙이 하나면 그 규칙이 처음부터 골라져 있다. */
export const initialSplitRule = (entry: ReviewQueueEntry): string | null =>
  entry.rules.length === 1 ? (entry.rules[0]?.id ?? null) : null;

// ── 거부 문구 ────────────────────────────────────────────────

/** -32001 고정 사유(`data.reason`) → 문구 (shared `DomainErrorReason` 가운데 검토 대기열 액션의 값, 시험이 대조). */
export const REVIEW_VALIDATION_TEXT = {
  QUARANTINE_REASON_REQUIRED: '사유 없음',
  QUARANTINE_REASON_INVALID: '사유 길이 초과',
  BUDGET_SHAPE_MISMATCH: '한도 역할 불일치',
  BUDGET_LOWERED: '지금 한도보다 낮은 값',
  BUDGET_NOT_ABOVE_SPENT: '사용량을 넘지 않는 값',
  SPLIT_RULE_NOT_TARGET: '대상 규칙 아님',
  WRITE_SCOPE_EXCLUDE_REQUIRED: '제외 경로 없음',
  WRITE_SCOPE_EXCLUDE_INVALID: '제외 경로 형식 오류',
  WRITE_SCOPE_ALLOW_EMPTY: '대상 블록 포함 경로 없음',
} as const;

/** -32009 사유(`data.reason`, shared `ReviewConflictReason`) → 문구 (시험이 대조). */
export const REVIEW_CONFLICT_TEXT = {
  already_resolved: '이미 처리됨',
  action_not_allowed: '이 종류에 없는 액션',
  builtin_rule: '내장 규칙',
  rule_not_effective: '효력 없는 규칙',
  rule_without_parent: '부모 요구사항 없는 규칙',
  split_in_progress: '분할 진행 중',
  project_daily_budget_exceeded: '프로젝트 하루 예산 초과',
} as const satisfies Record<ReviewConflictReason, string>;

/** 사유 없는 오류 코드 → 문구 (shared `ErrorCode`, 시험이 대조). */
export const REVIEW_ERROR_CODE_TEXT: Readonly<Record<string, string>> = {
  '-32602': '입력 형식 오류',
  '-32004': '항목 없음',
  '-32010': '예산 · 모델 미설정',
  '-32020': '처리 권한 없음',
};

const errorField = (error: unknown, key: string): unknown =>
  typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[key] : undefined;

const has = <T extends object>(table: T, key: unknown): key is keyof T =>
  typeof key === 'string' && Object.hasOwn(table, key);

/** 거부의 `data.fields` 한 칸 → 이름: 한도 칸은 입력 칸 이름, 제외 경로는 "n번째 경로"(보낸 목록의 순서). 모르면 null. */
const fieldName = (field: string, fields: readonly BudgetField[]): string | null => {
  const budget = fields.find((f) => f.key === field);
  if (budget !== undefined) return budget.label;
  const match = /^exclude\.(\d+)$/.exec(field);
  if (match?.[1] !== undefined) return `${String(Number(match[1]) + 1)}번째 경로`;
  return null;
};

/**
 * 액션 거부 → 한 줄 "처리 실패 · <사유>"(서버 글은 그리지 않는다). -32001 · -32009는 `data.reason`의 표, 그 밖은 코드 표, 모르는
 * 사유 · 코드는 "처리 실패"만. -32001의 `data.fields`가 있으면 칸 이름을 덧붙인다.
 */
export const reviewErrorText = (error: unknown, fields: readonly BudgetField[] = []): string => {
  const code = errorField(error, 'code');
  const data = errorField(error, 'data');
  const reason = errorField(data, 'reason');
  let text: string | null = null;
  if (code === -32001 && has(REVIEW_VALIDATION_TEXT, reason)) {
    text = REVIEW_VALIDATION_TEXT[reason];
    const named = errorField(data, 'fields');
    if (Array.isArray(named)) {
      const names = named
        .filter((f): f is string => typeof f === 'string')
        .map((f) => fieldName(f, fields))
        .filter((n): n is string => n !== null);
      if (names.length > 0) text = `${text} · ${names.join(' · ')}`;
    }
  } else if (code === -32009 && has(REVIEW_CONFLICT_TEXT, reason)) {
    text = REVIEW_CONFLICT_TEXT[reason];
  } else if (typeof code === 'number') {
    text = REVIEW_ERROR_CODE_TEXT[String(code)] ?? null;
  }
  return text === null ? REVIEW_TEXT.failed : `${REVIEW_TEXT.failed} · ${text}`;
};

/** 이미 처리된 항목의 거부: 목록을 다시 읽어 처리된 모습을 보인다. */
export const isAlreadyResolved = (error: unknown): boolean =>
  errorField(error, 'code') === -32009 &&
  errorField(errorField(error, 'data'), 'reason') === 'already_resolved';
