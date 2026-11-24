// 확인할 것 (SCR-17 자리, TODO-01 · NRM-04, ADR-100 D2 · D3 · B⑦ · D8 · G · A7 · 명세 변경 목록 SCR-17 · 할 일 공통, ADR-113 ·
// ADR-119)의 카드 · 필터 · 상세 · 배지 값. DOM · React에 의존하지 않는다 (test/todo-confirmation.test.ts).
// - 값은 `confirmation.list` · `normChange.list` 응답에서만 만든다(NFR-03). 목록 순서는 서버가 준 그대로다(다시 정렬하지 않는다)
// - 에이전트가 쓴 글(제목 · 진술 · 사유 · 근거 · 파일 경로)은 서버가 표시 값으로 준다. 화면에는 `visibleDisplayText`를 한 번 더
//   거쳐 그린다(표시 값은 바뀌지 않고, 숨은 글자가 섞여 와도 표기로 보인다)
// - 종류 태그 · 예외 · 확인 상태의 대응은 ADR-119 표와 같다
import type {
  Author,
  ConfirmationItem,
  ConfirmationItemKind,
  ConfirmationListResult,
  ConfirmationTarget,
  NormChangeActor,
  NormChangeView,
  Risk,
} from '@bive/shared';

import { AUTHOR_LABELS } from '../../components/AuthorMark/labels.js';
import type { CardData } from '../../components/Card2Line/card.js';
import { formatCardTime } from '../../components/Card2Line/time.js';
import type { FilterCriterion } from '../../components/ListView/filter.js';
import type { ExceptionMark } from '../../components/StatusBadge/status.js';
import { visibleDisplayText } from '../../components/VisibleText/visibleText.js';
import { AGENT_ROLE_LABELS } from '../../proposals/labels.js';
import {
  JUDGMENT_SUBJECT_TEXT,
  JUDGMENT_VERDICT_TEXT,
  labelOf,
  UNDECIDED_REASON_TEXT,
  UNKNOWN_TEXT,
} from '../norm-detail/normChangeView.js';
import { RISK_LABELS } from '../rules/rulesView.js';

/** 화면 문구 (screens.md 1.1 명사형). */
export const CONFIRMATION_TEXT = {
  tab: '확인할 것',
  list: '확인할 것 목록',
  empty: '확인할 항목 없음',
  loadFailed: '목록 불러오기 실패',
  noProject: '프로젝트 없음',
  noSelection: '선택 항목 없음',
  detail: '선택 항목',
  confirm: '확인',
  confirming: '저장 중',
  diff: '변경 내용',
  facts: '기록',
  before: '이전',
  after: '이후',
  title: '제목',
  statement: '진술',
  text: '본문',
  rationale: '사유',
  grounds: '근거',
  author: '생성 주체',
  files: '변경 파일',
  run: '실행',
  judgments: '판단',
  judgmentsEmpty: '판단 기록 없음',
  judgmentsFailed: '판단 기록 불러오기 실패',
  chainBroken: '변경 기록 검증 실패',
  textTruncated: '일부 생략',
  target: '대상',
  successor: '대체 규칙',
  contradicts: '모순 대상',
  undecided: '판단 없음',
  orchestrator: '오케스트레이터',
  unknown: UNKNOWN_TEXT,
  confirmFailed: '확인 실패',
} as const;

/** 잘린 목록의 머리줄: "250건 중 200건 표시". */
export const truncatedText = (total: number, shown: number): string =>
  `${String(total)}건 중 ${String(shown)}건 표시`;

/** 한 번의 [확인]이 함께 내리는 같은 대상의 다른 항목 수 문구. */
export const sameTargetText = (others: number): string =>
  `같은 대상 항목 ${String(others)}건 함께 확인`;

/** 바뀐 파일이 목록보다 많을 때: "전체 120개 중 100개". */
export const fileCountText = (count: number, shown: number): string =>
  `전체 ${String(count)}개 중 ${String(shown)}개`;

/** 테스트 파일 바뀜 종류 표시명. */
export const FILE_CHANGE_TEXT = { modified: '바뀜', removed: '지움' } as const;

/**
 * 항목 종류 표시명 (shared CONFIRMATION_ITEM_KIND_LABELS와 같음, 시험이 대조). 할 일 툴팁의 종류별 건수에 쓴다.
 * 순서가 툴팁에서 건수가 같을 때의 순서다.
 */
export const CONFIRMATION_ITEM_KIND_TEXT = {
  retired: '폐기',
  superseded: '대체',
  test_changed: '테스트 변경',
  unconfirmed_norm: '미확인',
} as const satisfies Record<ConfirmationItemKind, string>;

/**
 * 카드 1줄 종류 태그 (ADR-100 명세 변경 SCR-17 "신규 · 변경 · 폐기 · 대체 · 계약 변경 등", ADR-119).
 * 미확인 규범 가운데 요구사항은 '요구사항'(아래 `kindTag`). 에이전트가 규칙 · 요구사항을 제자리에서 고치는 길이 없어(ADR-100
 * A11) 미확인 규칙은 만든 그대로인 규칙이라 '신규', 테스트 변경은 확인한 규칙의 인수 테스트가 바뀐 것이라 '변경'이다.
 */
export const KIND_TAGS = {
  retired: '폐기',
  superseded: '대체',
  test_changed: '변경',
  unconfirmed_norm: '신규',
} as const satisfies Record<ConfirmationItemKind, string>;

const REQUIREMENT_TAG = '요구사항';

export const kindTag = (item: ConfirmationItem): string =>
  item.kind === 'unconfirmed_norm' && item.target.entity === 'Requirement'
    ? REQUIREMENT_TAG
    : KIND_TAGS[item.kind];

/** 종류 필터의 값: 태그보다 자세한 전체 이름 (ADR-056처럼 태그가 같은 것을 필터에서 나눈다). */
export const KIND_FILTER_TEXT = {
  retired: '폐기',
  superseded: '대체',
  test_changed: '테스트 변경',
  rule: '규칙 신규',
  requirement: '요구사항',
} as const;
type KindValue = keyof typeof KIND_FILTER_TEXT;

const kindValue = (item: ConfirmationItem): KindValue =>
  item.kind === 'unconfirmed_norm'
    ? item.target.entity === 'Rule'
      ? 'rule'
      : 'requirement'
    : item.kind;

/**
 * 확인 상태 (필터 칩 "확인 상태"와 카드 예외의 근거):
 * - `released`: 사람이 확인한 규칙을 에이전트가 폐기 · 대체해 확인이 풀림(폐기 · 대체 항목의 `released`)
 * - `unconfirmed`: 미확인 요구사항 · 규칙, 미확인 규칙의 폐기 · 대체(확인됨 규칙의 폐기 · 대체는 같은 트랜잭션에서 풀리므로
 *   `released`가 없는 폐기 · 대체는 미확인이던 규칙이다, ADR-113)
 * - `confirmed`: 확인됨인데 다시 볼 것(확인됨 규칙의 테스트 변경 알림, ADR-100 G)
 */
export type ConfirmState = 'unconfirmed' | 'released' | 'confirmed';

export const CONFIRM_STATE_TEXT = {
  unconfirmed: '미확인',
  released: '확인 풀림',
  confirmed: '확인됨',
} as const satisfies Record<ConfirmState, string>;

export const confirmStateOf = (item: ConfirmationItem): ConfirmState => {
  switch (item.kind) {
    case 'retired':
    case 'superseded':
      return item.released === null ? 'unconfirmed' : 'released';
    case 'test_changed':
      return 'confirmed';
    case 'unconfirmed_norm':
      return 'unconfirmed';
  }
};

/** 카드 2줄째 예외 (화면 정의서 1.4 "예외만 강조"): 미확인 · 확인 풀림 · 테스트 변경. */
const EXCEPTIONS = {
  unconfirmed: { key: 'unconfirmed', label: '미확인', tone: 'info' },
  released: { key: 'released', label: '확인 풀림', tone: 'danger' },
  confirmed: { key: 'test-changed', label: '테스트 변경', tone: 'warning' },
} as const satisfies Record<ConfirmState, ExceptionMark>;

export const confirmationException = (item: ConfirmationItem): ExceptionMark =>
  EXCEPTIONS[confirmStateOf(item)];

/** 항목 키 (목록 · 선택): 기록 항목은 순번, 미확인 규범은 대상. */
export const confirmationKey = (item: ConfirmationItem): string =>
  item.kind === 'unconfirmed_norm'
    ? `${item.target.entity}:${item.target.id}`
    : `${item.kind}:${String(item.seq)}`;

/** [확인]이 가리키는 대상: 폐기 · 대체 · 테스트 변경은 그 규칙, 미확인 규범은 그 대상. */
export const confirmTarget = (item: ConfirmationItem): ConfirmationTarget =>
  item.kind === 'unconfirmed_norm' ? item.target : { entity: 'Rule', id: item.rule.id };

export const targetKey = (target: ConfirmationTarget): string => `${target.entity}:${target.id}`;

/** 같은 대상을 가리키는 다른 항목 수 (한 번의 [확인]이 그 대상의 항목을 함께 내린다, ADR-113 · ADR-119). */
export const sameTargetCount = (
  items: readonly ConfirmationItem[],
  item: ConfirmationItem,
): number => {
  const key = targetKey(confirmTarget(item));
  return items.filter((other) => targetKey(confirmTarget(other)) === key).length - 1;
};

/** 표시 ID: 폐기 · 대체 · 테스트 변경은 그 규칙, 미확인 규범은 그 대상. */
export const displayIdOf = (item: ConfirmationItem): string =>
  item.kind === 'unconfirmed_norm' ? item.displayId : item.rule.displayId;

/** 카드 제목: 폐기 · 대체는 폐기 직전 제목, 테스트 변경은 규칙 제목, 미확인 규범은 요구사항 본문 · 규칙 제목. */
export const confirmationTitle = (item: ConfirmationItem): string => {
  switch (item.kind) {
    case 'retired':
    case 'superseded':
      return item.before === null ? UNKNOWN_TEXT : visibleDisplayText(item.before.title);
    case 'test_changed':
      return visibleDisplayText(item.title);
    case 'unconfirmed_norm':
      return visibleDisplayText(item.text);
  }
};

export const confirmationCard = (item: ConfirmationItem): CardData => ({
  title: confirmationTitle(item),
  id: displayIdOf(item),
  tag: kindTag(item),
  exceptions: [confirmationException(item)],
  dateTime: item.at,
});

export const confirmationSearchText = (item: ConfirmationItem): string =>
  [
    confirmationTitle(item),
    displayIdOf(item),
    item.kind === 'superseded' && item.after !== null ? item.after.rule.displayId : '',
  ].join(' ');

/** 생성 주체 필터의 값: 사람 · 에이전트 역할 · 오케스트레이터. */
type AuthorValue = 'human' | keyof typeof AGENT_ROLE_LABELS | 'orchestrator';

const authorValue = (item: ConfirmationItem): AuthorValue => {
  switch (item.kind) {
    case 'retired':
    case 'superseded':
      return item.actor.kind === 'agent' ? item.actor.role : 'orchestrator';
    case 'test_changed':
      // 테스트 변경 기록의 주체는 늘 오케스트레이터다 (0019 트리거, ADR-113)
      return 'orchestrator';
    case 'unconfirmed_norm':
      return item.author.kind === 'agent' ? item.author.role : 'human';
  }
};

/** 생성 주체 표기 (화면 정의서 1.4 "에이전트 메시지는 ~ 역할명"): "에이전트 · 규칙 작성", "사람", "오케스트레이터". */
export const actorText = (actor: Author | NormChangeActor): string => {
  switch (actor.kind) {
    case 'agent':
      return `${AUTHOR_LABELS.agent} · ${AGENT_ROLE_LABELS[actor.role]}`;
    case 'human':
      return AUTHOR_LABELS.human;
    case 'orchestrator':
      return CONFIRMATION_TEXT.orchestrator;
  }
};

const options = <K extends string>(table: Readonly<Record<K, string>>) =>
  (Object.keys(table) as K[]).map((value) => ({ value, label: table[value] }));

/** 생성 주체 필터 값 순서: 에이전트 역할 → 사람 → 오케스트레이터. */
const AUTHOR_FILTER_TEXT = {
  ...AGENT_ROLE_LABELS,
  human: AUTHOR_LABELS.human,
  orchestrator: CONFIRMATION_TEXT.orchestrator,
} as const satisfies Record<AuthorValue, string>;

/**
 * 필터 칩 4종 (ADR-100 명세 변경 SCR-17, 화면 정의서 SCR-17 필터의 "처리 상태"는 확인 상태로, "제안자"는 생성 주체로 바뀐다):
 * 확인 상태 · 종류 · 위험도 · 생성 주체. 값별 개수는 목록 항목에서만 센다(ListView, NFR-03).
 * 위험도는 규칙의 위험도(NRM-09)인데 `confirmation.list` 항목에 그 칸이 없고 지금 규칙의 위험도를 채우는 제품 코드도 없어
 * 값을 갖는 항목이 없다(모든 값 0건 비활성, ADR-119). 지어내지 않는다.
 */
export const CONFIRMATION_CRITERIA: readonly FilterCriterion<ConfirmationItem>[] = [
  {
    id: 'confirm',
    label: '확인 상태',
    options: options(CONFIRM_STATE_TEXT),
    values: (item) => [confirmStateOf(item)],
  },
  {
    id: 'kind',
    label: '종류',
    options: options(KIND_FILTER_TEXT),
    values: (item) => [kindValue(item)],
  },
  {
    id: 'risk',
    label: '위험도',
    options: options<Risk>(RISK_LABELS),
    values: () => [],
  },
  {
    id: 'author',
    label: '생성 주체',
    options: options(AUTHOR_FILTER_TEXT),
    values: (item) => [authorValue(item)],
  },
];

// ── 상세 ─────────────────────────────────────────────────────

/** 변경 내용 한 줄 (칸 이름 · 이전 · 이후). 신규는 이후만, 폐기는 이전만. */
export interface DiffRow {
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
}

/** 대상 링크 (규칙 · 요구사항 상세로). 폐기된 규칙은 [폐기 포함]을 켜야 보인다. */
export interface TargetLink {
  readonly label: string;
  readonly entity: 'Rule' | 'Requirement';
  readonly displayId: string;
  readonly retired: boolean;
}

/** 판단 카드 (규범 담당 역할의 판단 기록 1건). */
export interface JudgmentCard {
  readonly seq: number;
  readonly time: string;
  /** 주제: 모순 판단 · 이의 판단 · 검사 실패 판단 · 요구사항 변경 판단 (모르면 "알 수 없음") */
  readonly subject: string;
  /** 결과: 모순 없음 · 모순 · 유지 · 폐기 · 대체 */
  readonly verdict: string;
  /** 판단 없이 끝났으면 사정 */
  readonly undecided: string | null;
  /** 모순이면 그 대상 규칙의 표시 ID */
  readonly contradicts: readonly string[];
  readonly grounds: string | null;
  readonly actor: string;
  readonly truncated: boolean;
}

export interface ConfirmationDetailModel {
  readonly diff: readonly DiffRow[];
  readonly rationale: string | null;
  readonly grounds: string | null;
  readonly author: string;
  readonly files: { readonly path: string; readonly change: string }[] | null;
  readonly fileCount: string | null;
  readonly run: string | null;
  readonly links: readonly TargetLink[];
  readonly truncated: boolean;
}

const text = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : visibleDisplayText(value);

const stringField = (value: unknown, key: string): string | null => {
  if (typeof value !== 'object' || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : null;
};

/** 미확인 규칙의 신규 기록 (사유 · 만든 내용). 없으면 undefined. */
const createdOf = (
  item: ConfirmationItem,
  changes: readonly NormChangeView[],
): NormChangeView | undefined =>
  item.kind === 'unconfirmed_norm' && item.target.entity === 'Rule'
    ? changes.find(
        (entry) =>
          entry.kind === 'created' &&
          entry.targetRef.entity === 'Rule' &&
          entry.targetRef.id === item.target.id,
      )
    : undefined;

/**
 * 상세 값. `changes`는 그 대상의 `normChange.list` 결과(못 읽었으면 빈 배열): 미확인 규칙의 사유 · 만든 내용(진술)은 그 신규
 * 기록에서 읽는다(목록 항목에는 제목만 있다).
 */
export const confirmationDetail = (
  item: ConfirmationItem,
  changes: readonly NormChangeView[],
): ConfirmationDetailModel => {
  switch (item.kind) {
    case 'retired':
    case 'superseded': {
      const diff: DiffRow[] = [
        {
          field: CONFIRMATION_TEXT.title,
          before: item.before === null ? UNKNOWN_TEXT : visibleDisplayText(item.before.title),
          after: item.after === null ? null : visibleDisplayText(item.after.title),
        },
        {
          field: CONFIRMATION_TEXT.statement,
          before: item.before === null ? UNKNOWN_TEXT : visibleDisplayText(item.before.statement),
          after: item.after === null ? null : visibleDisplayText(item.after.statement),
        },
      ];
      return {
        diff,
        rationale: text(item.rationale),
        grounds: text(item.grounds),
        author: actorText(item.actor),
        files: null,
        fileCount: null,
        run: null,
        links: [
          {
            label: CONFIRMATION_TEXT.target,
            entity: 'Rule',
            displayId: item.rule.displayId,
            retired: true,
          },
          ...(item.after === null
            ? []
            : [
                {
                  label: CONFIRMATION_TEXT.successor,
                  entity: 'Rule' as const,
                  displayId: item.after.rule.displayId,
                  retired: false,
                },
              ]),
        ],
        truncated: item.textTruncated,
      };
    }
    case 'test_changed':
      return {
        diff: [],
        rationale: null,
        grounds: null,
        author: CONFIRMATION_TEXT.orchestrator,
        files: item.files.map((file) => ({
          path: visibleDisplayText(file.path),
          change: labelOf(FILE_CHANGE_TEXT, file.change),
        })),
        fileCount:
          item.fileCount > item.files.length
            ? fileCountText(item.fileCount, item.files.length)
            : null,
        run: item.runDisplayId ?? UNKNOWN_TEXT,
        links: [
          {
            label: CONFIRMATION_TEXT.target,
            entity: 'Rule',
            displayId: item.rule.displayId,
            retired: false,
          },
        ],
        truncated: item.textTruncated,
      };
    case 'unconfirmed_norm': {
      const created = createdOf(item, changes);
      const after = created?.detail.after;
      const statement = stringField(after, 'statement');
      const diff: DiffRow[] =
        item.target.entity === 'Requirement'
          ? [{ field: CONFIRMATION_TEXT.text, before: null, after: visibleDisplayText(item.text) }]
          : [
              {
                field: CONFIRMATION_TEXT.title,
                before: null,
                after: visibleDisplayText(stringField(after, 'title') ?? item.text),
              },
              ...(statement === null
                ? []
                : [
                    {
                      field: CONFIRMATION_TEXT.statement,
                      before: null,
                      after: visibleDisplayText(statement),
                    },
                  ]),
            ];
      return {
        diff,
        rationale: text(created?.reason),
        grounds: null,
        author: actorText(item.author),
        files: null,
        fileCount: null,
        run: null,
        links: [
          {
            label: CONFIRMATION_TEXT.target,
            entity: item.target.entity,
            displayId: item.displayId,
            retired: false,
          },
        ],
        truncated: item.textTruncated || created?.textTruncated === true,
      };
    }
  }
};

/** 판단 기록 1건 → 카드. 표시명은 변경 이력과 같은 표(shared 표를 다시 적은 것)를 쓰고, 모르는 값은 "알 수 없음"이다. */
export const judgmentCard = (entry: NormChangeView): JudgmentCard => {
  const judgment = entry.detail.judgment;
  const contradiction = judgment?.verdict === 'contradiction';
  return {
    seq: entry.seq,
    time: formatCardTime(entry.at) ?? entry.at,
    subject:
      judgment === undefined ? UNKNOWN_TEXT : labelOf(JUDGMENT_SUBJECT_TEXT, judgment.subject),
    verdict:
      judgment === undefined ? UNKNOWN_TEXT : labelOf(JUDGMENT_VERDICT_TEXT, judgment.verdict),
    undecided:
      judgment?.undecided === undefined
        ? null
        : labelOf(UNDECIDED_REASON_TEXT, judgment.undecided.endReason),
    contradicts: contradiction
      ? judgment.contradicts.map((rule) => visibleDisplayText(rule.displayId))
      : [],
    grounds: text(entry.reason),
    actor: actorText(entry.actor),
    truncated: entry.textTruncated,
  };
};

/**
 * 판단 카드들: 대상들(`judgmentTargets`)을 대상으로 한 규범 변경 기록 가운데 판단 기록만, 순번 순, 같은 기록은 한 번.
 * 서버가 대상으로 걸러 주지만 여기서도 대상을 본다(다른 규칙의 판단이 그 항목의 카드로 보이지 않게).
 */
export const judgmentCards = (
  changes: readonly NormChangeView[],
  targets: readonly ConfirmationTarget[],
): JudgmentCard[] => {
  const keys = new Set(targets.map(targetKey));
  const bySeq = new Map<number, NormChangeView>();
  for (const entry of changes) {
    if (entry.kind !== 'judgment') continue;
    if (!keys.has(`${entry.targetRef.entity}:${entry.targetRef.id}`)) continue;
    bySeq.set(entry.seq, entry);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).map(judgmentCard);
};

/**
 * 판단 기록을 읽을 대상들: [확인] 대상에 더해, 대체 항목은 새 규칙(대체 판단은 새 규칙을 대상으로 남는다, ADR-112).
 */
export const judgmentTargets = (item: ConfirmationItem): ConfirmationTarget[] => [
  confirmTarget(item),
  ...(item.kind === 'superseded' && item.after !== null
    ? [{ entity: 'Rule' as const, id: item.after.rule.id }]
    : []),
];

// ── [확인] ───────────────────────────────────────────────────

const errorCode = (error: unknown): number | null =>
  typeof error === 'object' &&
  error !== null &&
  typeof (error as { code?: unknown }).code === 'number'
    ? (error as { code: number }).code
    : null;

/** 이미 확인됨 · 삭제된 대상(-32009): 오류를 남기지 않고 목록을 다시 읽는다 (그 사이 다른 곳에서 확인함). */
export const isStaleConfirm = (error: unknown): boolean => errorCode(error) === -32009;

/** `confirmation.set` 실패 → 한 줄. */
export const confirmErrorText = (error: unknown): string => {
  switch (errorCode(error)) {
    case -32004:
      return `${CONFIRMATION_TEXT.confirmFailed} · 대상 없음`;
    case -32020:
      return `${CONFIRMATION_TEXT.confirmFailed} · 확인 권한 없음`;
    default:
      return CONFIRMATION_TEXT.confirmFailed;
  }
};

// ── 배지 · 툴팁 ──────────────────────────────────────────────

/**
 * 사이드바 알림 배지 숫자 (ADR-100 A7 · 명세 변경 "할 일 공통": 확인할 것 + 검토 대기열, ADR-113 · ADR-119).
 * 확인할 것은 `confirmation.list`의 `total`(자르기 전 수). 검토 대기열(SCR-18, M3-08)은 아직 없어 더할 수가 없다.
 * 상한 · 빨강 경고는 없다(D8). 모르면(프로젝트 없음 · 조회 전 · 실패) null — 배지를 보이지 않는다.
 */
export const todoBadgeTotal = (result: ConfirmationListResult | null): number | null =>
  result === null ? null : result.total;

const KIND_ORDER = Object.keys(CONFIRMATION_ITEM_KIND_TEXT) as ConfirmationItemKind[];

/**
 * 알림 아이콘 툴팁의 종류별 건수: "미확인 3 · 폐기 1". 0건 종류는 빼고, 건수 많은 순, 같으면 종류 순서(ADR-056과 같은 규칙).
 * 종류별 수는 자르기 전 수(`totalByKind`)를 쓴다: 목록이 잘려도 합이 배지 숫자와 같다. 그 칸이 없는 응답이면 받은 항목에서
 * 세되, 잘렸으면 합이 맞지 않으므로 비운다(툴팁은 "할 일"). 항목이 없으면 빈 문자열.
 */
export const todoBreakdown = (result: ConfirmationListResult | null): string => {
  if (result === null) return '';
  let counts: Readonly<Record<ConfirmationItemKind, number>>;
  if (result.totalByKind !== undefined) {
    counts = result.totalByKind;
  } else {
    if (result.truncated) return '';
    const counted = { retired: 0, superseded: 0, test_changed: 0, unconfirmed_norm: 0 };
    for (const item of result.items) counted[item.kind] += 1;
    counts = counted;
  }
  return KIND_ORDER.map((kind) => ({ kind, n: counts[kind] }))
    .filter(({ n }) => n > 0)
    .sort((a, b) => b.n - a.n || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    .map(({ kind, n }) => `${CONFIRMATION_ITEM_KIND_TEXT[kind]} ${String(n)}`)
    .join(' · ');
};
