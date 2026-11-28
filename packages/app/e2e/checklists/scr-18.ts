// SCR-18 검토 대기열 (screens.md 6장 할 일 · SCR-18, TODO-02 · COST-01, ADR-100 명세 변경 SCR-18 · 할 일 공통 · D8, ADR-029 ·
// ADR-145 · ADR-157).
// 사이드바 알림 아이콘 → 할 일 → [검토 대기열] 탭. 왼쪽 목록(검색 · 필터 칩 2종 · 2줄 카드: 1줄 대상 규칙 제목, 2줄 원인 실행 표시
// ID · 종류 · 시각), 오른쪽 상세("선택 항목"). 상태: 기본(항목 있음) · 빈("검토 항목 없음", ADR-029).
// 아래 가짜 응답(REVIEW_*)은 scr-18 · scr-17 · todo-entry · todo-badge spec이 함께 쓰고, test/todo-review-queue.test.ts가 shared
// 스키마로 파싱해 응답 모양이 실제 스키마와 같은지 확인한다. 숨은 글자는 `String.fromCodePoint`로만 적는다.
import type {
  ReviewQueueEntry,
  ReviewQueueListResult,
  ReviewQueueQuarantineResult,
  ReviewQueueRule,
  Run,
  RunGetResult,
} from '@bive/shared';

import { PROJECT } from './scr-17.js';
import type { ElementCheck, ScreenChecklist, StateChecklist } from './types.js';

/** 필터 칩 2종 (수용 기준 4): 기준 ID · 이름 · 값. */
export const REVIEW_FILTERS = [
  { id: 'kind', label: '종류', values: ['예산 초과', '변이 생존'] },
  { id: 'state', label: '처리 상태', values: ['열림', '처리됨'] },
] as const;

export const REVIEW_EMPTY_TEXT = '검토 항목 없음';

// ── 가짜 응답 (shared 스키마 대조: test/todo-review-queue.test.ts) ─────

const RLO = String.fromCodePoint(0x202e);

export const REVIEW_ID = {
  rule1: '01JBVE00000000000000000R11',
  rule2: '01JBVE00000000000000000R12',
  rule3: '01JBVE00000000000000000R13',
  run10: '01JBVE00000000000000000E10',
  run11: '01JBVE00000000000000000E11',
  run12: '01JBVE00000000000000000E12',
  run13: '01JBVE00000000000000000E13',
  run21: '01JBVE00000000000000000E21',
  mutation: '01JBVE00000000000000000M01',
  judgment: '01JBVE00000000000000000J01',
} as const;

const at = (hhmm: string): string => `2026-11-27T${hhmm}:00.000Z`;

export const RULE_LOCK: ReviewQueueRule = {
  id: REVIEW_ID.rule1,
  displayId: 'RULE-011',
  title: `로그인 5회 실패 시 잠금${RLO}`,
};
/** 화면 표기: 숨은 글자(U+202E)가 표기로 보인다. */
export const RULE_LOCK_SHOWN = '로그인 5회 실패 시 잠금\\u202e';
export const RULE_EXPORT: ReviewQueueRule = {
  id: REVIEW_ID.rule2,
  displayId: 'RULE-012',
  title: '주문 내보내기',
};
export const RULE_IMPORT: ReviewQueueRule = {
  id: REVIEW_ID.rule3,
  displayId: 'RULE-013',
  title: '주문 가져오기',
};

/** 변이 생존 (열림): 사람 보강 실행 EXE-011이 실패로 끝남. */
export const ENTRY_MUTANT: ReviewQueueEntry = {
  item: {
    seq: 1,
    kind: 'mutant_survived',
    runId: REVIEW_ID.run11,
    mutationResultId: REVIEW_ID.mutation,
    createdAt: at('09:00'),
    resolution: null,
  },
  run: {
    id: REVIEW_ID.run11,
    displayId: 'EXE-011',
    type: 'C',
    status: 'failed',
    failureReason: 'step_unmet',
  },
  rules: [RULE_LOCK],
};

/** 예산 초과 (열림): 대상 규칙 둘인 실행 EXE-012. */
export const ENTRY_BUDGET: ReviewQueueEntry = {
  item: {
    seq: 2,
    kind: 'budget_exceeded',
    runId: REVIEW_ID.run12,
    mutationResultId: null,
    createdAt: at('10:00'),
    resolution: null,
  },
  run: {
    id: REVIEW_ID.run12,
    displayId: 'EXE-012',
    type: 'A',
    status: 'budget_exceeded',
    failureReason: 'budget_exhausted',
  },
  rules: [RULE_EXPORT, RULE_IMPORT],
};

/** 예산 초과 (처리됨: 한도 상향 재개 → 이어받는 실행 EXE-021). */
export const ENTRY_RAISED: ReviewQueueEntry = {
  item: {
    seq: 3,
    kind: 'budget_exceeded',
    runId: REVIEW_ID.run10,
    mutationResultId: null,
    createdAt: at('08:00'),
    resolution: {
      action: 'raise_limit_resume',
      by: { kind: 'human' },
      at: at('08:30'),
      reason: null,
      runId: REVIEW_ID.run21,
    },
  },
  run: {
    id: REVIEW_ID.run10,
    displayId: 'EXE-010',
    type: 'A',
    status: 'budget_exceeded',
    failureReason: 'error_max_budget_usd',
  },
  rules: [RULE_EXPORT],
};

/** 변이 생존 (처리됨: 판정 격리, 사유). */
export const ENTRY_QUARANTINED: ReviewQueueEntry = {
  item: {
    seq: 4,
    kind: 'mutant_survived',
    runId: REVIEW_ID.run13,
    mutationResultId: REVIEW_ID.mutation,
    createdAt: at('07:00'),
    resolution: {
      action: 'quarantine',
      by: { kind: 'human' },
      at: at('07:30'),
      reason: '외부 시계 의존 · 다음 분기에 다시 봄',
      judgmentId: REVIEW_ID.judgment,
    },
  },
  run: {
    id: REVIEW_ID.run13,
    displayId: 'EXE-013',
    type: 'C',
    status: 'failed',
    failureReason: 'step_unmet',
  },
  rules: [RULE_LOCK],
};

/** 서버 순서(등록 순, 오래된 것 먼저). 화면은 열린 항목 먼저 · 등록 시각 최신순으로 그린다. */
export const REVIEW_LIST: ReviewQueueListResult = {
  entries: [ENTRY_QUARANTINED, ENTRY_RAISED, ENTRY_MUTANT, ENTRY_BUDGET],
};
export const REVIEW_EMPTY: ReviewQueueListResult = { entries: [] };

/** 원인 실행 (`run.get`): 지금 한도 · 멈춘 단계. 비용 · 턴 집계는 화면이 읽지 않으므로 빈 값 (테스트 전용 데이터). */
export const runOf = (patch: Partial<Run>): Run => ({
  id: REVIEW_ID.run12,
  displayId: 'EXE-012',
  projectId: PROJECT.id,
  type: 'A',
  targetRuleIds: [REVIEW_ID.rule2, REVIEW_ID.rule3],
  status: 'budget_exceeded',
  currentStep: 'implementation',
  lastCompletedStep: 'green_check',
  regressionCount: 0,
  failureReason: 'budget_exhausted',
  branch: 'bive/run-EXE-012',
  worktreePath: '/work/.bive/EXE-012',
  baseBranch: 'main',
  baseCommit: 'a1f26b1'.padEnd(40, '0'),
  headCommit: null,
  mergeCommit: null,
  budgetSnapshot: {
    run: { maxBudgetUsd: 5, maxTurns: 200 },
    roles: {
      'test-writer': { maxBudgetUsd: 2, maxTurns: 100 },
      implementer: { maxBudgetUsd: 3, maxTurns: 100 },
    },
  },
  modelSnapshot: { 'test-writer': 'test-model', implementer: 'test-model' },
  costUsd: 5,
  turns: 120,
  toolManifest: [],
  startedBy: { kind: 'human' },
  createdAt: at('09:30'),
  startedAt: at('09:31'),
  endedAt: at('10:00'),
  ...patch,
});

export const runGetOf = (run: Run): RunGetResult => ({
  run,
  steps: [],
  usage: {
    run: {
      costUsd: null,
      turns: null,
      modelUsage: null,
      sessionCount: 0,
      costUnknownCount: 0,
      turnsUnknownCount: 0,
    },
    roles: {},
    steps: [],
  },
  sessions: [],
});

export const RUN_GET_BUDGET = runGetOf(runOf({}));

/** `reviewQueue.quarantine` 성공 응답: 처리된 항목 + 격리 판정 기록. */
export const QUARANTINE_RESULT: ReviewQueueQuarantineResult = {
  entry: {
    ...ENTRY_MUTANT,
    item: {
      ...ENTRY_MUTANT.item,
      resolution: {
        action: 'quarantine',
        by: { kind: 'human' },
        at: at('11:00'),
        reason: '외부 시계 의존',
        judgmentId: REVIEW_ID.judgment,
      },
    },
  },
  judgment: {
    id: REVIEW_ID.judgment,
    ruleId: REVIEW_ID.rule1,
    runId: null,
    stepId: null,
    commit: 'b2c3d4e'.padEnd(40, '0'),
    judgedAt: at('11:00'),
    status: 'quarantined',
    runner: 'vitest',
    exitCode: null,
    reporterPath: null,
    cases: [],
    quarantineReason: '외부 시계 의존',
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
  { label: '탭 수', role: 'tab', count: 2 },
  {
    label: '검토 대기열 탭 (선택됨)',
    role: 'tab',
    name: '검토 대기열',
    attributes: { 'aria-selected': 'true' },
  },
  { label: '상한 머리줄 없음 (ADR-100 D8)', text: /상한/, absent: true },
  { label: '상세 자리', testId: 'todo-detail', role: 'region', name: '선택 항목' },
];

const basic: StateChecklist = {
  title: 'BIVE',
  elements: [
    ...common,
    { label: '검토 대기열 목록', testId: 'list-view', role: 'region', name: '검토 대기열 목록' },
    { label: '검색', testId: 'list-search', role: 'searchbox', name: '검색' },
    ...REVIEW_FILTERS.map(({ id, label }): ElementCheck => ({
      label: `필터 칩 ${label}`,
      testId: `filter-chip-${id}`,
    })),
    { label: '[문제만] 없음', testId: 'problem-toggle', absent: true },
    { label: '카드', testId: 'card' },
    { label: '카드 1줄 대상 규칙 제목', testId: 'card-title' },
    { label: '카드 2줄 원인 실행 표시 ID', testId: 'card-id', text: /^EXE-\d{3,}$/ },
    { label: '카드 2줄 종류 (열린 항목 예외)', testId: 'card-exception' },
    { label: '결과 줄 없음 (기본 필터 없음)', testId: 'list-result', absent: true },
    { label: '상세 빈 자리', testId: 'empty-state', text: '선택 항목 없음' },
    { label: '액션 없음 (선택 없음)', testId: 'review-actions', absent: true },
  ],
};

const empty: StateChecklist = {
  title: 'BIVE',
  elements: [
    ...common,
    { label: '빈 상태', testId: 'empty-state', text: REVIEW_EMPTY_TEXT },
    { label: '카드 없음', testId: 'card', count: 0 },
  ],
};

export const reviewQueueChecklist = {
  id: 'SCR-18',
  name: '검토 대기열',
  states: { 기본: basic, 빈: empty },
} satisfies ScreenChecklist;
