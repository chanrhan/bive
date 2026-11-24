// SCR-17 자리: 확인할 것 (screens.md 6장 할 일 · SCR-17, TODO-01 · NRM-04, ADR-100 명세 변경 SCR-17 · 할 일 공통 · A7 · D8,
// ADR-029 · ADR-035 · ADR-113 · ADR-119).
// 사이드바 알림 아이콘 → 할 일. 머리 탭은 [확인할 것] 하나(검토 대기열은 그 화면 이슈가 더한다, 계약 변경 승인 탭은 없어짐).
// 왼쪽 확인할 것 목록(검색 · 필터 칩 4종 · 2줄 카드, 서버 순서 그대로), 오른쪽 상세("선택 항목"): 머리(종류 태그 · 제목 · ID ·
// 예외 · 시각 · [확인]) → 변경 내용 → 기록(사유 · 근거 · 생성 주체) → 변경 파일 → 판단 → 대상 링크.
// 옛 [거절] [수정] [승인] · 상한 머리줄은 없다(D8). 상태: 기본(항목 있음) · 빈("확인할 항목 없음", ADR-029).
// 아래 가짜 응답(FIXTURE_*)은 scr-17 · todo-entry · todo-badge spec이 함께 쓰고, test/todo-confirmation.test.ts가 shared
// 스키마로 파싱해 응답 모양이 실제 스키마와 같은지 확인한다. 숨은 글자는 이스케이프 표기로만 적는다.
import type {
  ConfirmationListResult,
  ConfirmationSetResult,
  NormChangeListResult,
  NormChangeView,
} from '@bive/shared';

import type { ElementCheck, ScreenChecklist, StateChecklist } from './types.js';

/** 할 일 머리 탭. todo-entry.spec.ts도 이 표를 쓴다. */
export const TODO_TAB_LABELS = ['확인할 것'] as const;

/** 없는 탭: 옛 승인 대기 · 계약 변경 승인(ADR-100 명세 변경 "할 일 공통" · SCR-19)과 아직 없는 검토 대기열(ADR-035). */
export const HIDDEN_TODO_TABS = ['승인 대기', '검토 대기열', '계약 변경 승인'] as const;

/** 필터 칩 4종 (수용 기준 4): 기준 ID · 이름. */
export const CONFIRMATION_FILTERS = [
  { id: 'confirm', label: '확인 상태' },
  { id: 'kind', label: '종류' },
  { id: 'risk', label: '위험도' },
  { id: 'author', label: '생성 주체' },
] as const;

export const CONFIRMATION_EMPTY_TEXT = '확인할 항목 없음';

/** 없어진 옛 처리 버튼 (ADR-063 · ADR-082가 정한 승인 대기의 버튼). */
export const REMOVED_ACTIONS = ['승인', '수정', '거절'] as const;

// ── 가짜 응답 (shared 스키마 대조: test/todo-confirmation.test.ts) ─────

export const PROJECT = {
  id: '01JBVE0000000000000000000P',
  name: 'sample-next-app',
  rootPath: '/tmp/sample-next-app',
  baseBranch: 'main',
  createdAt: '2026-10-16T00:00:00.000Z',
} as const;

export const ID = {
  rule1: '01JBVE00000000000000000R01',
  rule2: '01JBVE00000000000000000R02',
  rule3: '01JBVE00000000000000000R03',
  rule4: '01JBVE00000000000000000R04',
  rule5: '01JBVE00000000000000000R05',
  req2: '01JBVE00000000000000000Q02',
  run3: '01JBVE00000000000000000E03',
  run4: '01JBVE00000000000000000E04',
  session: '01JBVE00000000000000000S01',
  step: '01JBVE00000000000000000T01',
} as const;

const at = (hhmm: string): string => `2026-11-23T${hhmm}:00.000Z`;
const RULE_WRITER = { kind: 'agent', role: 'rule-writer' } as const;
const ORCHESTRATOR = { kind: 'orchestrator' } as const;
const hash = (c: string): string => c.repeat(64);
const INPUT = {
  requirements: { total: 2, included: 2 },
  rules: { total: 4, included: 4 },
} as const;

/** 방향 제어 글자 U+202E가 든 사유 (원문 글자가 섞여 와도 화면에는 표기로 보여야 한다). */
export const RLO_RATIONALE = 'REQ-003의 시각 형식 요구\u202e를 반영';
/** 화면에 보이는 사유 (U+202E → 표기 6글자). */
export const RLO_RATIONALE_SHOWN = 'REQ-003의 시각 형식 요구\\u202e를 반영';
/** 이미 표시 값으로 온 근거 (서버가 숨은 글자를 표기로 바꾼 글): 다시 바꾸지 않아 역슬래시가 둘이 되지 않는다. */
export const SUPERSEDE_GROUNDS =
  '기존 진술 "응답에 서버 시각을 포함한다"와 동시에 만족 불가 \\u202e 표기';

export const RULE1_BEFORE = {
  title: '헬스 응답에 서버 시각 포함',
  statement: 'WHEN 클라이언트가 헬스 체크를 요청하면 THE SYSTEM SHALL 응답에 서버 시각을 포함한다',
} as const;
export const RULE3_AFTER = {
  title: '헬스 응답에 ISO 시각 포함',
  statement:
    'WHEN 클라이언트가 헬스 체크를 요청하면 THE SYSTEM SHALL 응답에 ISO 8601 시각을 포함한다',
} as const;
export const RULE2_BEFORE = {
  title: '헬스 응답에 호스트 이름 포함',
  statement:
    'WHEN 클라이언트가 헬스 체크를 요청하면 THE SYSTEM SHALL 응답에 호스트 이름을 포함한다',
} as const;
/** 좁은 창 배치 시험용 긴 제목 · 긴 파일 경로. */
export const LONG_TITLE =
  '헬스 체크 응답 본문에 서버가 응답을 만든 시점의 시각을 밀리초 단위까지 담은 필드와 그 시각대 정보를 함께 포함';
export const RULE5_STATEMENT =
  'WHEN 클라이언트가 헬스 체크를 요청하면 THE SYSTEM SHALL 응답 시각을 밀리초까지 포함한다';
export const LONG_PATH =
  'bive-acceptance/RULE-004/very/long/nested/directory/structure/for/uptime-seconds-precision-check.acc.ts';
export const RETIRE_GROUNDS = '요구사항 REQ-002 삭제로 "응답에 호스트 이름을 포함한다"의 근거 없음';
export const RULE5_RATIONALE = 'REQ-001 본문의 시각 요구를 검사 가능한 규칙으로';
export const NEW_RULE_GROUNDS = '기존 효력 규칙 RULE-004와 동시에 만족 가능';
export const LATER_OBJECTION_GROUNDS =
  '두 번째 이의도 진술 "응답 시각을 밀리초까지"와 맞지 않아 유지';
export const OBJECTION_GROUNDS = '이의 글의 주장은 진술 "응답 시각을 밀리초까지"와 맞지 않아 유지';

/** 대체 (확인 풀림): 맨 위. */
export const ITEM_SUPERSEDED = {
  kind: 'superseded',
  seq: 10,
  at: at('10:00'),
  actor: RULE_WRITER,
  sessionId: ID.session,
  rule: { id: ID.rule1, displayId: 'RULE-001' },
  before: RULE1_BEFORE,
  after: { ...RULE3_AFTER, rule: { id: ID.rule3, displayId: 'RULE-003' } },
  grounds: SUPERSEDE_GROUNDS,
  rationale: RLO_RATIONALE,
  released: { seq: 11, at: at('10:00') },
  textTruncated: false,
} as const satisfies ConfirmationListResult['items'][number];

/** 폐기 (미확인이던 규칙). */
export const ITEM_RETIRED = {
  kind: 'retired',
  seq: 7,
  at: at('09:00'),
  actor: RULE_WRITER,
  sessionId: ID.session,
  rule: { id: ID.rule2, displayId: 'RULE-002' },
  before: RULE2_BEFORE,
  after: null,
  grounds: RETIRE_GROUNDS,
  rationale: null,
  released: null,
  textTruncated: false,
} as const satisfies ConfirmationListResult['items'][number];

/** 확인됨 규칙 RULE-004의 테스트 변경 2건 (실행 2개). 한 번의 [확인]이 둘을 함께 내린다. */
export const ITEM_TEST_1 = {
  kind: 'test_changed',
  seq: 6,
  at: at('08:30'),
  rule: { id: ID.rule4, displayId: 'RULE-004' },
  title: '헬스 응답에 가동 시간 포함',
  runId: ID.run4,
  runDisplayId: 'EXE-004',
  sessionId: ID.session,
  files: [{ path: 'bive-acceptance/RULE-004/uptime.acc.ts', change: 'modified' }],
  fileCount: 1,
  textTruncated: false,
} as const satisfies ConfirmationListResult['items'][number];

export const ITEM_TEST_2 = {
  kind: 'test_changed',
  seq: 5,
  at: at('08:00'),
  rule: { id: ID.rule4, displayId: 'RULE-004' },
  title: '헬스 응답에 가동 시간 포함',
  runId: ID.run3,
  runDisplayId: 'EXE-003',
  sessionId: ID.session,
  files: [
    { path: LONG_PATH, change: 'modified' },
    { path: 'bive-acceptance/RULE-004/old-helper.acc.ts', change: 'removed' },
  ],
  fileCount: 3,
  textTruncated: false,
} as const satisfies ConfirmationListResult['items'][number];

/** 미확인 규범: 대체로 생긴 새 규칙 · 규칙 작성 역할의 규칙 · 에이전트의 요구사항. */
export const ITEM_RULE3 = {
  kind: 'unconfirmed_norm',
  at: at('10:00'),
  target: { entity: 'Rule', id: ID.rule3 },
  displayId: 'RULE-003',
  text: RULE3_AFTER.title,
  author: RULE_WRITER,
  textTruncated: false,
} as const satisfies ConfirmationListResult['items'][number];

export const ITEM_RULE5 = {
  kind: 'unconfirmed_norm',
  at: at('07:00'),
  target: { entity: 'Rule', id: ID.rule5 },
  displayId: 'RULE-005',
  text: LONG_TITLE,
  author: RULE_WRITER,
  textTruncated: false,
} as const satisfies ConfirmationListResult['items'][number];

export const ITEM_REQ2 = {
  kind: 'unconfirmed_norm',
  at: at('06:00'),
  target: { entity: 'Requirement', id: ID.req2 },
  displayId: 'REQ-002',
  text: '헬스 응답에 리전 이름을 포함한다',
  author: { kind: 'agent', role: 'chat' },
  textTruncated: false,
} as const satisfies ConfirmationListResult['items'][number];

/** 서버 순서: ① 폐기 · 대체(시각 최신순) ② 테스트 변경 ③ 미확인 규범(수정 시각 최신순). */
export const FIXTURE_ITEMS = [
  ITEM_SUPERSEDED,
  ITEM_RETIRED,
  ITEM_TEST_1,
  ITEM_TEST_2,
  ITEM_RULE3,
  ITEM_RULE5,
  ITEM_REQ2,
] as const;

/** 목록 응답을 만든다 (종류별 수는 항목에서 센다). */
export const listOf = (
  items: readonly ConfirmationListResult['items'][number][],
): ConfirmationListResult => {
  const totalByKind = { retired: 0, superseded: 0, test_changed: 0, unconfirmed_norm: 0 };
  for (const item of items) totalByKind[item.kind] += 1;
  return { items: [...items], total: items.length, truncated: false, totalByKind };
};

export const FIXTURE_LIST: ConfirmationListResult = listOf(FIXTURE_ITEMS);

/** RULE-004를 확인한 뒤의 목록: 그 규칙의 테스트 변경 2건이 함께 빠진다. */
export const FIXTURE_LIST_AFTER_RULE4: ConfirmationListResult = listOf(
  FIXTURE_ITEMS.filter((item) => !('rule' in item) || item.rule.id !== ID.rule4),
);

/** 잘린 목록: 받은 항목 7개, 자르기 전 250개 (종류별 수의 합 = 250). */
export const FIXTURE_TRUNCATED: ConfirmationListResult = {
  items: [...FIXTURE_ITEMS],
  total: 250,
  truncated: true,
  totalByKind: { retired: 1, superseded: 1, test_changed: 2, unconfirmed_norm: 246 },
};

/** 잘린 목록 (받은 항목 1개, 자르기 전 250개). */
export const FIXTURE_TRUNCATED_ONE: ConfirmationListResult = {
  items: [ITEM_SUPERSEDED],
  total: 250,
  truncated: true,
  totalByKind: { retired: 0, superseded: 1, test_changed: 0, unconfirmed_norm: 249 },
};

/** 글이 상한에서 잘린 폐기 항목 (`textTruncated`). */
export const ITEM_RETIRED_TRUNCATED = {
  ...ITEM_RETIRED,
  textTruncated: true,
} as const satisfies ConfirmationListResult['items'][number];

const entry = (
  seq: number,
  fields: Omit<NormChangeView, 'seq' | 'prevHash' | 'hash' | 'textTruncated' | 'runId'> &
    Partial<Pick<NormChangeView, 'runId'>>,
): NormChangeView => ({
  seq,
  runId: null,
  textTruncated: false,
  prevHash: hash(((seq - 1) % 10).toString()),
  hash: hash((seq % 10).toString()),
  ...fields,
});

/** 규범 변경 기록 (표시 값). 대상별 조회도 이 전체를 돌려주는 가짜 응답이라 화면이 대상으로 거르는지도 본다. */
export const FIXTURE_CHANGES: NormChangeView[] = [
  entry(1, {
    at: at('07:00'),
    kind: 'created',
    actor: RULE_WRITER,
    targetRef: { entity: 'Rule', id: ID.rule5 },
    sessionId: ID.session,
    reason: RULE5_RATIONALE,
    detail: { after: { title: LONG_TITLE, statement: RULE5_STATEMENT } },
  }),
  entry(2, {
    at: at('07:00'),
    kind: 'judgment',
    actor: RULE_WRITER,
    targetRef: { entity: 'Rule', id: ID.rule5 },
    sessionId: ID.session,
    reason: NEW_RULE_GROUNDS,
    detail: {
      judgment: {
        subject: 'new_rule',
        verdict: 'no_contradiction',
        contradicts: [],
        createdSeq: 1,
        input: INPUT,
      },
    },
  }),
  entry(4, {
    at: at('07:30'),
    kind: 'judgment',
    actor: RULE_WRITER,
    targetRef: { entity: 'Rule', id: ID.rule5 },
    sessionId: ID.session,
    reason: OBJECTION_GROUNDS,
    detail: {
      judgment: {
        subject: 'objection',
        verdict: 'upheld',
        contradicts: [],
        causeSeq: 3,
        input: INPUT,
      },
    },
  }),
  entry(5, {
    at: at('08:00'),
    kind: 'test_changed',
    actor: ORCHESTRATOR,
    targetRef: { entity: 'Rule', id: ID.rule4 },
    sessionId: ID.session,
    runId: ID.run3,
    reason: null,
    detail: {
      testChange: {
        files: ITEM_TEST_2.files.slice(),
        fileCount: 3,
        baseCommit: 'a'.repeat(40),
        headCommit: 'b'.repeat(40),
      },
    },
  }),
  entry(7, {
    at: at('09:00'),
    kind: 'retired',
    actor: RULE_WRITER,
    targetRef: { entity: 'Rule', id: ID.rule2 },
    sessionId: ID.session,
    reason: RETIRE_GROUNDS,
    detail: { before: RULE2_BEFORE, retirement: { supersededBy: null } },
  }),
  entry(8, {
    at: at('10:00'),
    kind: 'created',
    actor: RULE_WRITER,
    targetRef: { entity: 'Rule', id: ID.rule3 },
    sessionId: ID.session,
    reason: RLO_RATIONALE,
    detail: { after: RULE3_AFTER },
  }),
  entry(9, {
    at: at('10:00'),
    kind: 'judgment',
    actor: RULE_WRITER,
    targetRef: { entity: 'Rule', id: ID.rule3 },
    sessionId: ID.session,
    reason: SUPERSEDE_GROUNDS,
    detail: {
      judgment: {
        subject: 'supersede',
        verdict: 'contradiction',
        contradicts: [{ id: ID.rule1, displayId: 'RULE-001' }],
        createdSeq: 8,
        input: INPUT,
      },
    },
  }),
  entry(10, {
    at: at('10:00'),
    kind: 'superseded',
    actor: RULE_WRITER,
    targetRef: { entity: 'Rule', id: ID.rule1 },
    sessionId: ID.session,
    reason: SUPERSEDE_GROUNDS,
    detail: {
      before: RULE1_BEFORE,
      retirement: {
        supersededBy: { id: ID.rule3, displayId: 'RULE-003' },
        createdSeq: 8,
        judgmentSeq: 9,
      },
    },
  }),
];

export const FIXTURE_CHANGE_LIST: NormChangeListResult = {
  entries: FIXTURE_CHANGES,
  chain: { valid: true, brokenAtSeq: null, reason: null },
};

/** 체인 검증이 깨진 규범 변경 기록 응답 (기록은 그대로, 검증 결과만 실패). */
export const FIXTURE_CHANGE_LIST_BROKEN: NormChangeListResult = {
  entries: FIXTURE_CHANGES,
  chain: { valid: false, brokenAtSeq: 4, reason: 'hash_mismatch' },
};

/** 판단 1건이 더해진 규범 변경 기록 (상세가 열린 동안 알림으로 다시 읽을 때). */
export const FIXTURE_CHANGE_LIST_MORE: NormChangeListResult = {
  entries: [
    ...FIXTURE_CHANGES,
    {
      seq: 12,
      at: at('11:30'),
      kind: 'judgment',
      actor: RULE_WRITER,
      targetRef: { entity: 'Rule', id: ID.rule5 },
      sessionId: ID.session,
      runId: null,
      reason: LATER_OBJECTION_GROUNDS,
      detail: {
        judgment: {
          subject: 'objection',
          verdict: 'upheld',
          contradicts: [],
          causeSeq: 11,
          input: INPUT,
        },
      },
      textTruncated: false,
      prevHash: hash('1'),
      hash: hash('2'),
    },
  ],
  chain: { valid: true, brokenAtSeq: null, reason: null },
};

/** RULE-004 [확인]의 응답 (사람 주체, 승인 기록 `confirm`, 본 마지막 순번 11). */
export const FIXTURE_CONFIRM_RULE4: ConfirmationSetResult = {
  target: { entity: 'Rule', id: ID.rule4 },
  confirmation: {
    state: 'confirmed',
    at: at('11:00'),
    by: { kind: 'human' },
    basis: { kind: 'approval_log', seq: 4 },
  },
  approvalLog: {
    seq: 4,
    at: at('11:00'),
    action: 'confirm',
    actor: { kind: 'human' },
    targetRef: { entity: 'Rule', id: ID.rule4 },
    clientId: 'pipe-1',
    detail: { seenNormChangeSeq: 11 },
    prevHash: hash('c'),
    hash: hash('d'),
  },
};

// ── 체크리스트 ───────────────────────────────────────────────

const common: ElementCheck[] = [
  {
    label: '할 일 알림 아이콘 (선택됨)',
    testId: 'todo-button',
    role: 'button',
    name: '할 일',
    attributes: { 'aria-pressed': 'true' },
  },
  { label: '할 일 화면', testId: 'todo-screen', role: 'region', name: '할 일' },
  { label: '탭 목록', role: 'tablist', name: '할 일 종류' },
  { label: '탭 수', role: 'tab', count: TODO_TAB_LABELS.length },
  {
    label: '확인할 것 탭 (선택됨)',
    role: 'tab',
    name: '확인할 것',
    attributes: { 'aria-selected': 'true' },
  },
  ...HIDDEN_TODO_TABS.map((name): ElementCheck => ({
    label: `${name} 탭 없음`,
    role: 'tab',
    name,
    absent: true,
  })),
  { label: '상한 머리줄 없음 (ADR-100 D8)', text: /상한/, absent: true },
  { label: '대기 머리줄 없음', text: /대기 \d/, absent: true },
  ...REMOVED_ACTIONS.map((name): ElementCheck => ({
    label: `[${name}] 없음`,
    role: 'button',
    name,
    absent: true,
  })),
  { label: '떠 있는 처리 버튼 없음', testId: 'floating-actions', absent: true },
  { label: '상세 자리', testId: 'todo-detail', role: 'region', name: '선택 항목' },
];

const basic: StateChecklist = {
  title: 'BIVE',
  elements: [
    { label: '할 일 배지', testId: 'todo-badge', text: /^\d+$/ },
    ...common,
    { label: '확인할 것 목록', testId: 'list-view', role: 'region', name: '확인할 것 목록' },
    { label: '검색', testId: 'list-search', role: 'searchbox', name: '검색' },
    ...CONFIRMATION_FILTERS.map(({ id, label }): ElementCheck => ({
      label: `필터 칩 ${label}`,
      testId: `filter-chip-${id}`,
    })),
    { label: '카드', testId: 'card' },
    { label: '카드 1줄 종류 태그', testId: 'card-tag' },
    { label: '카드 1줄 제목', testId: 'card-title' },
    { label: '카드 2줄 표시 ID', testId: 'card-id', text: /^(RULE|REQ)-\d{3,}$/ },
    { label: '카드 2줄 예외', testId: 'card-exception' },
    { label: '안 읽음 점 없음', testId: 'card-unread', absent: true },
    { label: '결과 줄 없음 (기본 필터 없음)', testId: 'list-result', absent: true },
    { label: '상세 빈 자리', testId: 'empty-state', text: '선택 항목 없음' },
    { label: '[확인] 없음 (선택 없음)', testId: 'confirm-button', absent: true },
  ],
};

const empty: StateChecklist = {
  title: 'BIVE',
  elements: [
    { label: '할 일 배지 (0건)', testId: 'todo-badge', absent: true },
    ...common,
    { label: '빈 상태', testId: 'empty-state', text: CONFIRMATION_EMPTY_TEXT },
    { label: '카드 없음', testId: 'card', count: 0 },
    { label: '결과 줄 없음', testId: 'list-result', absent: true },
  ],
};

export const confirmationChecklist = {
  id: 'SCR-17',
  name: '확인할 것',
  states: { 기본: basic, 빈: empty },
} satisfies ScreenChecklist;
