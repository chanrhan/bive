// SCR-05 검증 (screens.md SCR-05 · 1.1, JDG-03 · COST-02, ADR-011 · ADR-029 · ADR-035 · ADR-072).
// - 기본: 머리줄 "판정 기준 main@커밋" · 지표 카드(준수 · 실행당 비용) · 파이프라인(최근 실행의 단계 순서 · 현재 단계) ·
//   규칙별 최신 판정 + 실행 링크(비용 합계 · 턴, 값 없으면 '없음'). 잠정 · 변이 · 규칙화 불가 · 추적성 결함 카드,
//   준수 추이 그래프, 코드 열람 영역은 미노출 (ADR-035). [재개]는 최근 실행이 중단일 때만 (ADR-011)
// - 빈: 실행이 없으면 파이프라인 자리 "실행 없음"(ADR-029), 머리줄 "판정 기준 없음", 실행당 비용 '없음'
// - 로딩 · 에러: 화면 정의서에 정의 없음 → ADR-072 (ADR-060과 같음: 로딩 = 자리 비움, 에러 = "검증 불러오기 실패")
import type {
  Run,
  RuleWithJudgment,
  StepKind,
  StepStatus,
  VerificationRunLink,
  VerificationSummaryResult,
} from '@bive/shared';

import { RULES } from './scr-03.js';
import type { ElementCheck, ScreenChecklist } from './types.js';

export { PROJECT } from './scr-02.js';
export { RULES } from './scr-03.js';

/** 판정 기준 커밋 (테스트 전용 데이터, NFR-03). */
export const BASIS_COMMIT = `a1f26b1${'0'.repeat(33)}`;

const RUN_1 = '01JE0000000000000000000001';
const RUN_2 = '01JE0000000000000000000002';
const RUN_3 = '01JE0000000000000000000003';

/** 실행 링크 (테스트 전용 데이터). EXE-002는 비용 · 턴 값이 없다. */
export const LINK_1: VerificationRunLink = {
  id: RUN_1,
  displayId: 'EXE-001',
  costUsd: 0.3,
  turns: 7,
};
export const LINK_2: VerificationRunLink = {
  id: RUN_2,
  displayId: 'EXE-002',
  costUsd: null,
  turns: null,
};

/** 실행 1건 (테스트 전용 데이터). */
export const run = (patch: Partial<Run> = {}): Run => ({
  id: RUN_3,
  displayId: 'EXE-003',
  projectId: '01JB0000000000000000000000',
  type: 'A',
  targetRuleIds: ['01JC0000000000000000000003'],
  status: 'running',
  currentStep: 'implementation',
  lastCompletedStep: 'red_check',
  regressionCount: 0,
  failureReason: null,
  branch: 'bive/EXE-003',
  worktreePath: '/work/.bive/EXE-003',
  baseBranch: 'main',
  baseCommit: BASIS_COMMIT,
  headCommit: null,
  mergeCommit: null,
  budgetSnapshot: {
    run: { maxBudgetUsd: 5, maxTurns: 200 },
    roles: {
      'test-writer': { maxBudgetUsd: 2, maxTurns: 100 },
      implementer: { maxBudgetUsd: 3, maxTurns: 150 },
    },
  },
  modelSnapshot: { 'test-writer': 'test-model', implementer: 'impl-model' },
  costUsd: 0.05,
  turns: 3,
  toolManifest: [],
  startedBy: { kind: 'human' },
  createdAt: '2026-10-16T03:00:00.000Z',
  startedAt: '2026-10-16T03:00:01.000Z',
  endedAt: null,
  ...patch,
});

const PLAN: readonly StepKind[] = [
  'approval',
  'test_writing',
  'red_check',
  'implementation',
  'check',
  'mutation',
  'merge',
  'screen_update',
];

/** 단계 표시명 순서 (유형 A, 화면 문구). */
export const STAGE_LABELS = [
  '승인',
  '테스트 작성',
  'Red 확인',
  '구현',
  '검사',
  '변이 주입',
  '병합',
  '화면 갱신',
] as const;

/** 단계 계획 + 단계별 마지막 시도 상태. `upTo` 앞 단계는 통과, `upTo`는 `current`, 뒤는 대기. */
export const stages = (upTo: StepKind, current: StepStatus) =>
  PLAN.map((kind, index) => {
    const at = PLAN.indexOf(upTo);
    if (index < at) return { kind, status: 'passed' as const, attempt: 1 };
    if (index === at) return { kind, status: current, attempt: 1 };
    return { kind, status: 'pending' as const, attempt: 1 };
  });

const LIVE = RULES.filter(({ rule }) => rule.deletedAt === null);

/** 판정 가능(분모) = 승인된 · 격리 아닌 규칙: RULE-001 · 002 · 003 · 005. 잠정 RULE-006은 분리. */
const DENOMINATOR = LIVE.filter(({ rule }) => rule.normState === 'approved').map(
  ({ rule }) => rule.id,
);

/** 규칙 목록 줄: RULE-002의 최신 판정은 EXE-002, 나머지 판정된 규칙은 EXE-001. */
const rows = (items: readonly RuleWithJudgment[]): VerificationSummaryResult['rules'] =>
  items.map(({ rule, judgment }) => {
    if (judgment.latest === null) return { rule, judgment, run: null };
    if (rule.displayId === 'RULE-002') {
      return {
        rule,
        judgment: { ...judgment, latest: { ...judgment.latest, runId: RUN_2 } },
        run: LINK_2,
      };
    }
    return { rule, judgment, run: LINK_1 };
  });

/** `verification.summary` 가짜 응답: 기본 (테스트 전용 데이터, NFR-03). */
export const SUMMARY: VerificationSummaryResult = {
  basis: { branch: 'main', commit: BASIS_COMMIT, runId: RUN_1 },
  compliance: { passed: 1, judgeable: DENOMINATOR.length },
  denominator: DENOMINATOR,
  costPerRunUsd: 0.2,
  rules: rows(LIVE),
  pipeline: { run: run(), stages: stages('implementation', 'running') },
};

/** `verification.summary` 가짜 응답: 실행 없음 (규칙은 있고 판정 전). */
export const EMPTY_SUMMARY: VerificationSummaryResult = {
  basis: null,
  compliance: { passed: 0, judgeable: 2 },
  denominator: [LIVE[0]?.rule.id ?? '', LIVE[1]?.rule.id ?? ''],
  costPerRunUsd: null,
  rules: LIVE.slice(0, 2).map(({ rule }) => ({
    rule,
    judgment: { status: 'unjudged', latest: null },
    run: null,
  })),
  pipeline: null,
};

/** 미노출 요소 (ADR-035): 다음 마일스톤 카드 · 그래프 · 영역. */
const hidden: ElementCheck[] = [
  { label: '잠정 카드 미노출', testId: 'metric-provisional', absent: true },
  { label: '변이 카드 미노출', testId: 'metric-mutation', absent: true },
  { label: '규칙화 불가 카드 미노출', testId: 'metric-unrulable', absent: true },
  { label: '추적성 결함 카드 미노출', testId: 'metric-traceability', absent: true },
  { label: '잠정 승인 문구 없음', text: '잠정 승인', absent: true },
  { label: '변이 검증됨 문구 없음', text: '변이 검증됨', absent: true },
  { label: '규칙화 불가 문구 없음', text: /규칙화 불가/, absent: true },
  { label: '추적성 결함 문구 없음', text: /추적성 결함/, absent: true },
  { label: '준수 추이 미노출', text: /추이/, absent: true },
  { label: '코드 열람 미노출', text: /코드 열람/, absent: true },
];

const metrics = (compliance: string, cost: string): ElementCheck[] => [
  { label: '지표 영역', role: 'region', name: '지표' },
  { label: '지표 카드 2개', testId: 'metric-label', count: 2 },
  {
    label: '준수 카드',
    testId: 'metric-compliance',
    role: 'button',
    attributes: { title: '통과 / 판정 가능' },
  },
  { label: '준수 이름', text: '준수' },
  { label: '준수 값', text: compliance },
  { label: '실행당 비용 카드', testId: 'metric-cost-per-run' },
  { label: '실행당 비용 이름', text: '실행당 비용' },
  { label: '실행당 비용 값', text: cost },
];

export const verificationChecklist = {
  id: 'SCR-05',
  name: '검증',
  states: {
    기본: {
      title: 'BIVE',
      elements: [
        { label: '머리줄', testId: 'verification-basis', text: '판정 기준 main@a1f26b1' },
        ...metrics('1 / 4', '$0.20'),
        { label: '파이프라인 영역', testId: 'pipeline', role: 'region', name: '파이프라인' },
        { label: '최근 실행', testId: 'pipeline-run', text: 'EXE-003' },
        { label: '최근 실행 상태', testId: 'pipeline-run-status', text: '진행 중' },
        { label: '현재 단계', testId: 'pipeline-current', text: '구현' },
        { label: '단계 순서', testId: 'pipeline-stage', count: STAGE_LABELS.length },
        { label: '재개 버튼 미노출 (중단 아님)', role: 'button', name: '재개', absent: true },
        { label: '실행 없음 미표시', text: '실행 없음', absent: true },
        {
          label: '규칙 목록 영역',
          testId: 'verification-rules',
          role: 'region',
          name: '규칙별 최신 판정',
        },
        { label: '규칙 줄 (삭제 제외)', testId: 'verification-rule', count: LIVE.length },
        { label: '규칙 제목', testId: 'verification-rule-title', text: LIVE[0]?.rule.title ?? '' },
        { label: '최신 판정 배지', testId: 'status-badge', count: LIVE.length },
        { label: '실행 링크 (판정된 규칙)', testId: 'run-link', count: 4 },
        { label: '실행 링크 ID', testId: 'run-link-id', text: 'EXE-001' },
        { label: '실행 링크 비용 합계', testId: 'run-link-cost', text: '$0.30' },
        { label: '실행 링크 턴', testId: 'run-link-turns', text: '7턴' },
        ...hidden,
      ],
    },
    빈: {
      title: 'BIVE',
      elements: [
        { label: '머리줄', testId: 'verification-basis', text: '판정 기준 없음' },
        ...metrics('0 / 2', '없음'),
        { label: '파이프라인 영역', testId: 'pipeline', role: 'region', name: '파이프라인' },
        { label: '빈 상태', testId: 'empty-state', text: '실행 없음' },
        { label: '단계 없음', testId: 'pipeline-stage', absent: true },
        { label: '재개 버튼 미노출', role: 'button', name: '재개', absent: true },
        { label: '규칙 줄', testId: 'verification-rule', count: 2 },
        { label: '실행 링크 없음', testId: 'run-link', absent: true },
        ...hidden,
      ],
    },
    로딩: {
      title: 'BIVE',
      elements: [
        {
          label: '자리 (대기)',
          testId: 'verification-loading',
          attributes: { 'aria-busy': 'true' },
        },
        { label: '머리줄 미표시', testId: 'verification-basis', absent: true },
        { label: '불러오기 실패 없음', text: '검증 불러오기 실패', absent: true },
      ],
    },
    에러: {
      title: 'BIVE',
      elements: [
        {
          label: '불러오기 실패',
          testId: 'verification-load-error',
          role: 'alert',
          text: '검증 불러오기 실패',
        },
        { label: '머리줄 미표시', testId: 'verification-basis', absent: true },
      ],
    },
  },
} satisfies ScreenChecklist;
