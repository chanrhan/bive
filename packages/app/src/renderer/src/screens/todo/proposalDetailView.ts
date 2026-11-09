// 승인 대기 상세의 표시 · 입력 규칙 (screens.md SCR-17 상세 · 동작, NRM-04, TODO-01, ADR-050 · ADR-063).
// DOM · React에 의존하지 않는다 (test/todo-proposal-detail.test.ts).
// - 상세 = 출처 → 에이전트 제안(변경 내용 · 근거 · 생성 주체) → 승인하면 / 거절하면 (대기) 또는 처리 기록 (처리됨)
// - 본문 값은 제안 · 요구사항 · 승인 기록 RPC 결과에서만 만든다 (NFR-03). 표시명은 사람이 읽는 이름만 쓴다(코드 표기 금지)
// - 수정 · 승인은 본문 스키마가 있는 종류(요구사항 신규 · 규칙 신규)만, 거절은 모든 대기 제안 (ADR-050 · ADR-063)
import type {
  ApprovalAction,
  ApprovalLogEntry,
  JsonRpcErrorObject,
  Proposal,
  ProposalKind,
  ProposalPayload,
} from '@bive/shared';

import {
  AGENT_ROLE_LABELS,
  CHECK_KIND_LABELS,
  PROPOSAL_SOURCE_LABELS,
  RULE_KIND_LABELS,
} from '../../proposals/labels.js';

/** 상세 문구 (screens.md 1.1: 명사형 · 짧은 문구). */
export const DETAIL_TEXT = {
  region: '선택 항목',
  noSelection: '선택 항목 없음',
  source: '출처',
  sourcePath: '생성 경로',
  parentRequirement: '부모 요구사항',
  proposal: '에이전트 제안',
  diff: '변경 내용',
  rationale: '근거',
  author: '생성 주체',
  ifApprove: '승인하면',
  ifReject: '거절하면',
  record: '처리 기록',
  recordAction: '처리',
  recordActor: '주체',
  recordTime: '시각',
  recordReason: '사유',
  recordDiff: '수정 내용',
  recordLoadFailed: '처리 기록 불러오기 실패',
  recordMissing: '처리 기록 없음',
  chainBroken: '승인 기록 검증 실패',
  actions: '처리',
  busy: '처리 중',
  reject: '거절',
  edit: '수정',
  approve: '승인',
  editCard: '수정 후 승인',
  editConfirm: '수정 후 승인',
  rejectCard: '거절 사유',
  rejectConfirm: '거절',
  cancel: '취소',
  before: '이전',
  after: '이후',
} as const;

/** 확인 · 취소 단축키 안내 (요구사항 입력 줄과 같은 형식). */
export const shortcutHint = (mac: boolean): string =>
  mac ? '⌘↵ 확인 · Esc 취소' : 'Ctrl+Enter 확인 · Esc 취소';

/** 수정 · 승인할 수 있는 종류 = 본문 스키마가 있는 종류 (shared SupportedProposalKind와 같음, ADR-050). */
export const ACTIONABLE_KINDS = [
  'requirement_new',
  'rule_new',
] as const satisfies readonly ProposalKind[];
export type ActionableKind = (typeof ACTIONABLE_KINDS)[number];

export const isActionableKind = (kind: ProposalKind): kind is ActionableKind =>
  (ACTIONABLE_KINDS as readonly string[]).includes(kind);

/** 처리 버튼 (떠 있는 버튼 순서: 거절 · 수정 · 승인). */
export type DetailAction = 'reject' | 'edit' | 'approve';

/**
 * 보일 처리 버튼. 대기 제안만 처리할 수 있고(처리됨 · 잠정은 없음), [수정] · [승인]은 본문 스키마가 있는 종류만이다.
 * 스키마가 없는 종류는 승인해도 서버가 거부하므로 버튼을 두지 않는다 (ADR-035 · ADR-063).
 */
export const availableActions = (proposal: Proposal): DetailAction[] => {
  if (proposal.state !== 'pending') return [];
  return isActionableKind(proposal.kind) ? ['reject', 'edit', 'approve'] : ['reject'];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textValue = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const labelOf = <K extends string>(labels: Record<K, string>, value: unknown): string | null =>
  typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value as K] : null;

/** 요구사항 ID → 화면 표시(표시 ID). 모르면 null (그 줄은 보이지 않는다, NFR-03). */
export type RequirementLabel = (id: string) => string | null;

/** 본문 필드 하나 (사람이 읽는 이름 · 값). */
export interface PayloadField {
  key: string;
  label: string;
  value: string;
}

const FIELD_LABELS = {
  text: '문장',
  title: '제목',
  statement: '진술',
  kind: '규칙 종류',
  checkKinds: '검사 종류',
  parentRequirementId: DETAIL_TEXT.parentRequirement,
} as const;

/**
 * 본문 → 표시 필드 (종류별 순서). 본문 스키마가 없는 종류 · 객체가 아닌 본문은 null(표시할 수 없음).
 * 해석할 수 없는 값의 필드는 뺀다.
 */
export const payloadFields = (
  kind: ProposalKind,
  payload: unknown,
  requirementLabel: RequirementLabel,
): PayloadField[] | null => {
  if (!isActionableKind(kind) || !isRecord(payload)) return null;
  const raw: [keyof typeof FIELD_LABELS, string | null][] =
    kind === 'requirement_new'
      ? [['text', textValue(payload.text)]]
      : [
          ['title', textValue(payload.title)],
          ['statement', textValue(payload.statement)],
          ['kind', labelOf(RULE_KIND_LABELS, payload.kind)],
          [
            'checkKinds',
            Array.isArray(payload.checkKinds)
              ? (() => {
                  const labels = payload.checkKinds.map((k) => labelOf(CHECK_KIND_LABELS, k));
                  return labels.length > 0 && labels.every((l) => l !== null)
                    ? labels.join(' · ')
                    : null;
                })()
              : null,
          ],
          [
            'parentRequirementId',
            typeof payload.parentRequirementId === 'string'
              ? requirementLabel(payload.parentRequirementId)
              : null,
          ],
        ];
  return raw.flatMap(([key, value]) =>
    value === null ? [] : [{ key, label: FIELD_LABELS[key], value }],
  );
};

/** 변경 내용 한 줄. `before`가 null이면 추가, `after`가 null이면 삭제. */
export interface DiffRow {
  key: string;
  label: string;
  before: string | null;
  after: string | null;
}

/**
 * 변경 내용 (제안 diff · 수정 diff). 바뀐 필드만 돌려준다. 이전 본문이 없으면(신규) 이후 필드 전부가 추가다.
 * 본문을 표시할 수 없는 종류면 null.
 */
export const diffRows = (
  kind: ProposalKind,
  before: unknown,
  after: unknown,
  requirementLabel: RequirementLabel,
): DiffRow[] | null => {
  const afterFields = payloadFields(kind, after, requirementLabel);
  if (afterFields === null) return null;
  const beforeFields =
    before === null || before === undefined
      ? []
      : (payloadFields(kind, before, requirementLabel) ?? []);
  const keys = [...new Set([...beforeFields.map((f) => f.key), ...afterFields.map((f) => f.key)])];
  const order = Object.keys(FIELD_LABELS);
  keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return keys.flatMap((key) => {
    const b = beforeFields.find((f) => f.key === key) ?? null;
    const a = afterFields.find((f) => f.key === key) ?? null;
    if (b?.value === a?.value) return [];
    const label = (a ?? b)?.label ?? key;
    return [{ key, label, before: b?.value ?? null, after: a?.value ?? null }];
  });
};

/** 출처 줄: 생성 경로(제안 출처) + 규칙 제안이면 부모 요구사항. */
export interface SourceRow {
  key: string;
  label: string;
  value: string;
}

export const sourceRows = (proposal: Proposal, parent: string | null): SourceRow[] => [
  { key: 'path', label: DETAIL_TEXT.sourcePath, value: PROPOSAL_SOURCE_LABELS[proposal.source] },
  ...(parent === null
    ? []
    : [{ key: 'parent', label: DETAIL_TEXT.parentRequirement, value: parent }]),
];

/** 상세 생성 주체: 에이전트 · 역할명 (1.4 생성 주체: 상세는 이름). */
export const authorName = (proposal: Proposal): string =>
  `에이전트 · ${AGENT_ROLE_LABELS[proposal.author.role]}`;

/**
 * 승인하면 / 거절하면 카드 문구 (ADR-050의 승인 · 거절 결과). 승인할 수 없는 종류는 승인하면 카드가 없다.
 * 잠정 승인을 쓰지 않으므로(ADR-012) 되돌리는 실행 문구는 없다.
 */
export const consequences = (
  kind: ProposalKind,
): { approve: string[] | null; reject: string[] } => {
  const reject = ['규범 변경 없음', '거절 사유 기록'];
  if (kind === 'requirement_new') return { approve: ['요구사항 추가', '승인 기록 추가'], reject };
  if (kind === 'rule_new') return { approve: ['규칙 추가', '승인 기록 추가'], reject };
  return { approve: null, reject };
};

// ── 수정 후 승인 입력 ────────────────────────────────────

/** 사람이 고칠 수 있는 필드: 제안 문장만 (NRM-04 "제안 문장을 고친 뒤 승인"). 종류 · 검사 종류 · 부모는 그대로 둔다. */
export type EditKey = 'text' | 'title' | 'statement';

export interface EditField {
  key: EditKey;
  label: string;
  multiline: boolean;
}

export const EDIT_FIELDS = {
  requirement_new: [{ key: 'text', label: FIELD_LABELS.text, multiline: true }],
  rule_new: [
    { key: 'title', label: FIELD_LABELS.title, multiline: false },
    { key: 'statement', label: FIELD_LABELS.statement, multiline: true },
  ],
} as const satisfies Record<ActionableKind, readonly EditField[]>;

export type EditValues = Partial<Record<EditKey, string>>;

/** 입력 칸의 처음 값 = 제안 본문의 문장. */
export const initialEditValues = (kind: ActionableKind, payload: unknown): EditValues => {
  const source = isRecord(payload) ? payload : {};
  return Object.fromEntries(
    EDIT_FIELDS[kind].map(({ key }) => [key, typeof source[key] === 'string' ? source[key] : '']),
  ) as EditValues;
};

/**
 * 입력 검증 (shared 본문 스키마의 문장 규칙과 같음: 공백만 있는 문장은 안 됨). 키 → 화면 문구.
 * 비어 있으면 통과.
 */
export const editErrors = (
  kind: ActionableKind,
  values: EditValues,
): Partial<Record<EditKey, string>> =>
  Object.fromEntries(
    EDIT_FIELDS[kind].flatMap(({ key, label }) =>
      (values[key] ?? '').trim() === '' ? [[key, `${label} 비어 있음`]] : [],
    ),
  );

/** 수정 본문 = 원래 본문 + 고친 문장 (본문 전체, ADR-050). 입력 문구는 그대로 보낸다. */
export const editedPayload = (
  kind: ActionableKind,
  payload: unknown,
  values: EditValues,
): ProposalPayload => {
  const base = isRecord(payload) ? payload : {};
  const patch = Object.fromEntries(EDIT_FIELDS[kind].map(({ key }) => [key, values[key] ?? '']));
  // 원래 본문은 서버가 종류 스키마로 검증한 값이고, 고친 값은 서버가 다시 검증한다(-32001)
  return { ...base, ...patch } as ProposalPayload;
};

/** 거절 사유: 공백만 있으면 보내지 않는다 (NRM-04 사유 필수, 서버도 -32001). */
export const canReject = (reason: string): boolean => reason.trim() !== '';

// ── 처리 결과 · 오류 ─────────────────────────────────────

const isRpcError = (error: unknown): error is JsonRpcErrorObject =>
  isRecord(error) && typeof error.code === 'number';

const reasonOf = (error: JsonRpcErrorObject): unknown =>
  isRecord(error.data) ? error.data.reason : undefined;

/** 처리 요청 실패 → 한 줄 문구. */
export const actionErrorText = (error: unknown): string => {
  if (!isRpcError(error)) return '처리 실패';
  switch (error.code) {
    case -32009:
      return '처리 불가 (상태 변경)';
    case -32004:
      return '제안 없음';
    case -32020:
      return '처리 권한 없음';
    case -32001:
      if (reasonOf(error) === 'REJECT_REASON_REQUIRED') return '거절 사유 필요';
      if (reasonOf(error) === 'EDITED_PAYLOAD_INVALID') return '수정 내용 형식 오류';
      return '처리 실패';
    default:
      return '처리 실패';
  }
};

/** 목록과 서버가 어긋난 실패(이미 처리됨 · 없음): 목록 · 배지를 다시 불러온다. */
export const isStaleError = (error: unknown): boolean =>
  isRpcError(error) && (error.code === -32009 || error.code === -32004);

/** 처리 기록의 행동 표시명 (승인 기록 `action` 중 제안 처리 3종). */
export const DECISION_ACTION_LABELS = {
  approve: '승인',
  approve_edited: '수정 후 승인',
  reject: '거절',
} as const satisfies Partial<Record<ApprovalAction, string>>;

const DECISION_ACTIONS: ReadonlySet<string> = new Set(Object.keys(DECISION_ACTION_LABELS));

/** 제안 하나의 처리 기록 = 그 제안을 대상으로 한 승인 · 거절 기록 중 마지막. 없으면 null. */
export const decisionEntry = (
  entries: readonly ApprovalLogEntry[],
  proposalId: string,
): ApprovalLogEntry | null =>
  entries.findLast(
    (entry) =>
      entry.targetRef.entity === 'Proposal' &&
      entry.targetRef.id === proposalId &&
      DECISION_ACTIONS.has(entry.action),
  ) ?? null;

export const decisionActionLabel = (entry: ApprovalLogEntry): string =>
  labelOf(DECISION_ACTION_LABELS, entry.action) ?? entry.action;
