// SCR-05 검증 (screens.md SCR-05 · 1.1, JDG-03 · COST-02, ADR-011 · ADR-029 · ADR-035 · ADR-072).
// - 기본: 머리줄 "판정 기준 main@커밋" · 지표 카드(준수의 전체 기준 · 사람 확인 기준, 에이전트 폐기 규칙, 실행당 비용, ADR-117) ·
//   코드 열람(사유 3종 건수, M2-02 · ADR-088) ·
//   파이프라인(최근 실행의 단계 순서 · 현재 단계) · 규칙별 최신 판정 + 실행 링크(비용 합계 · 턴, 값 없으면 '없음').
//   잠정 · 변이 · 규칙화 불가 · 추적성 결함 카드, 준수 추이 그래프는 미노출 (ADR-035). [재개]는 최근 실행이 중단일 때만 (ADR-011)
// - 빈: 실행이 없으면 파이프라인 자리 "실행 없음"(ADR-029), 머리줄 "판정 기준 없음", 실행당 비용 '없음',
//   열람 기록이 없으면 코드 열람 영역 값 '없음'(ADR-088)
// - 로딩 · 에러: 화면 정의서에 정의 없음 → ADR-072 (ADR-060과 같음: 로딩 = 자리 비움, 에러 = "검증 불러오기 실패")
import type {
  CodeOpenSummaryResult,
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
const RUN_3 = '01JE0000000000000000000003';

/** 실행 링크 = 판정 기준 실행 EXE-001 (테스트 전용 데이터). */
export const LINK_1: VerificationRunLink = {
  id: RUN_1,
  displayId: 'EXE-001',
  costUsd: 0.3,
  turns: 7,
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

/** 검증 화면의 규칙 목록 = 효력 있는 규칙: 삭제 · 폐기(RULE-007) 제외 (ADR-112). */
const LIVE = RULES.filter(({ rule, retirement }) => rule.deletedAt === null && !retirement);

/** 판정 가능(분모) = 효력 있고 격리 아닌 규칙: RULE-001 · 002 · 003 · 005 · 006 (미확인 RULE-006도 전체 기준 분모). */
const DENOMINATOR = LIVE.filter(({ rule }) => rule.normState === 'approved').map(
  ({ rule }) => rule.id,
);

/**
 * 규칙 목록 줄: 판정 기준 실행(EXE-001)이 기준 커밋에서 낸 판정만 보인다(ADR-072). 병합된 실행의 검사 · 병합 재검사
 * 판정은 통과뿐이므로 RULE-001 · 006만 판정(통과, 실행 링크 EXE-001)이고 나머지는 미판정 · 실행 링크 없음.
 */
const rows = (items: readonly RuleWithJudgment[]): VerificationSummaryResult['rules'] =>
  items.map(({ rule, judgment }) =>
    judgment.latest !== null &&
    judgment.status === 'pass' &&
    judgment.latest.runId === RUN_1 &&
    judgment.latest.commit === BASIS_COMMIT
      ? { rule, judgment, run: LINK_1 }
      : { rule, judgment: { status: 'unjudged', latest: null }, run: null },
  );

/**
 * 사람 확인 기준 분모 = 판정 가능 가운데 확인됨: RULE-001 · 003 · 005 (규칙 화면 "판정 가능 + 확인됨"과 같은 목록, ADR-117).
 * 통과는 기준 실행에서 통과한 확인됨 규칙 RULE-001 하나 → 1 / 3.
 */
const CONFIRMED_DENOMINATOR = LIVE.filter(
  ({ rule }) => rule.normState === 'approved' && rule.confirmation.state === 'confirmed',
).map(({ rule }) => rule.id);

/** 에이전트 폐기 규칙 수 = 폐기된 RULE-007 하나 (RULE-006이 대체, 테스트 전용 데이터). */
const AGENT_RETIRED = RULES.filter(({ retirement }) => retirement !== undefined).length;

/** `verification.summary` 가짜 응답: 기본 (테스트 전용 데이터, NFR-03). */
export const SUMMARY: VerificationSummaryResult = {
  basis: { branch: 'main', commit: BASIS_COMMIT, runId: RUN_1 },
  compliance: { passed: 2, judgeable: DENOMINATOR.length },
  denominator: DENOMINATOR,
  confirmedCompliance: {
    passed: 1,
    judgeable: CONFIRMED_DENOMINATOR.length,
    confirmed: CONFIRMED_DENOMINATOR.length,
  },
  confirmedDenominator: CONFIRMED_DENOMINATOR,
  agentRetiredRules: AGENT_RETIRED,
  costPerRunUsd: 0.2,
  rules: rows(LIVE),
  pipeline: { run: run(), stages: stages('implementation', 'running'), queued: 0 },
};

/**
 * `verification.summary` 가짜 응답: 최근 실행이 병합 완료이고 변이 주입은 생략 (M1의 실제 흐름: 변이 주입은 P1이라
 * `skipped`로 기록, roadmap M1-14). 생략 단계의 보이는 문구 "생략"을 검사한다 (#165).
 */
export const SKIPPED_SUMMARY: VerificationSummaryResult = {
  ...SUMMARY,
  pipeline: {
    run: run({
      status: 'merged',
      currentStep: null,
      lastCompletedStep: 'screen_update',
      endedAt: '2026-10-16T03:20:00.000Z',
    }),
    stages: PLAN.map((kind) => ({
      kind,
      status: kind === 'mutation' ? ('skipped' as const) : ('passed' as const),
      attempt: 1,
    })),
    queued: 0,
  },
};

/** 병합 커밋 (테스트 전용 데이터). */
export const MERGE_COMMIT_3 = `b2c37d4${'0'.repeat(33)}`;

/** 실행 링크 = 판정 기준 실행 EXE-003 (테스트 전용 데이터). */
export const LINK_3: VerificationRunLink = {
  id: RUN_3,
  displayId: 'EXE-003',
  costUsd: 0.25,
  turns: 5,
};

/**
 * `verification.summary` 가짜 응답: 최근 실행 EXE-003이 병합된 뒤 화면 갱신 단계만 실패 (ADR-091). 실행은 병합 완료이고
 * 판정 기준은 그 실행의 병합 커밋, 목록의 판정 · 실행 링크도 그 실행이다. 파이프라인의 화면 갱신 단계만 실패.
 */
export const SCREEN_UPDATE_FAILED_SUMMARY: VerificationSummaryResult = {
  ...SUMMARY,
  basis: { branch: 'main', commit: MERGE_COMMIT_3, runId: RUN_3 },
  rules: SUMMARY.rules.map((row) =>
    row.run === null || row.judgment.latest === null
      ? row
      : {
          ...row,
          judgment: { ...row.judgment, latest: { ...row.judgment.latest, runId: RUN_3 } },
          run: LINK_3,
        },
  ),
  pipeline: {
    run: run({
      status: 'merged',
      currentStep: null,
      lastCompletedStep: 'merge',
      mergeCommit: MERGE_COMMIT_3,
      endedAt: '2026-10-16T03:20:00.000Z',
    }),
    stages: PLAN.map((kind) => ({
      kind,
      status:
        kind === 'mutation'
          ? ('skipped' as const)
          : kind === 'screen_update'
            ? ('failed' as const)
            : ('passed' as const),
      attempt: 1,
    })),
    queued: 0,
  },
};

/**
 * `verification.summary` 가짜 응답: 사람이 확인한 효력 있는 규칙이 없음 → 사람 확인 기준 `null`('없음', 0 / 0 금지),
 * 에이전트 폐기 0 (테스트 전용 데이터).
 */
export const NO_CONFIRMED_SUMMARY: VerificationSummaryResult = {
  ...SUMMARY,
  confirmedCompliance: null,
  confirmedDenominator: [],
  agentRetiredRules: 0,
};

/** `verification.summary` 가짜 응답: 실행 없음 (규칙은 있고 판정 전, RULE-001은 확인됨 · RULE-002는 미확인). */
export const EMPTY_SUMMARY: VerificationSummaryResult = {
  basis: null,
  compliance: { passed: 0, judgeable: 2 },
  denominator: [LIVE[0]?.rule.id ?? '', LIVE[1]?.rule.id ?? ''],
  confirmedCompliance: { passed: 0, judgeable: 1, confirmed: 1 },
  confirmedDenominator: [LIVE[0]?.rule.id ?? ''],
  agentRetiredRules: 0,
  costPerRunUsd: null,
  rules: LIVE.slice(0, 2).map(({ rule }) => ({
    rule,
    judgment: { status: 'unjudged', latest: null },
    run: null,
  })),
  pipeline: null,
};

/** `codeOpen.summary` 가짜 응답: 기록 있음 (화면 오류 2 · 정보 부족 0 · 디버깅 5, 테스트 전용 데이터, NFR-03). */
export const CODE_OPEN_SUMMARY: CodeOpenSummaryResult = {
  reasons: [
    { reason: 'screen_error', count: 2 },
    { reason: 'info_lacking', count: 0 },
    { reason: 'debugging', count: 5 },
  ],
  total: 7,
};

/** `codeOpen.summary` 가짜 응답: 기록 없음. */
export const EMPTY_CODE_OPEN_SUMMARY: CodeOpenSummaryResult = {
  reasons: [
    { reason: 'screen_error', count: 0 },
    { reason: 'info_lacking', count: 0 },
    { reason: 'debugging', count: 0 },
  ],
  total: 0,
};

/** 미노출 요소 (ADR-035): 다음 마일스톤 카드 · 그래프. */
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
];

/**
 * 공통 툴팁 문구 (#201 · ADR-124, screens.md 1.1 명사형 · 코드 표기 없음): 대상의 `data-testid` → 툴팁 문구. 화면 문구와 글자까지
 * 같아야 한다(scr-05.spec.ts가 열린 툴팁의 글자와 대조). `kind`는 누름의 뜻: `action` = 원래 동작(규칙 화면 이동)이 있어 툴팁은
 * 올림 · 키보드 초점으로만, `press` = 원래 동작이 없어 누름(Enter · Space)으로도 연다.
 */
export const TOOLTIPS = {
  'metric-compliance-all': { text: '통과 / 판정 가능', kind: 'action' },
  'metric-compliance-confirmed': { text: '통과 / 판정 가능 · 확인됨 규칙만', kind: 'action' },
  'code-open-hint': { text: '링크 경유 열기 시도 수 · 링크 밖 열람 미집계', kind: 'press' },
} as const satisfies Record<string, { text: string; kind: 'action' | 'press' }>;

const metrics = (
  { all, confirmed, retired }: { all: string; confirmed: string; retired: string },
  cost: string,
): ElementCheck[] => [
  { label: '지표 영역', role: 'region', name: '지표' },
  { label: '지표 카드 3개', testId: 'metric-label', count: 3 },
  { label: '준수 카드', testId: 'metric-compliance', role: 'group', name: '준수' },
  { label: '준수 이름', text: '준수' },
  { label: '준수 기준 2개', testId: 'metric-part-label', count: 2 },
  {
    label: '준수 전체 기준',
    testId: 'metric-compliance-all',
    role: 'button',
    text: `전체 기준 ${all}`,
  },
  {
    label: '준수 사람 확인 기준',
    testId: 'metric-compliance-confirmed',
    role: 'button',
    text: `사람 확인 기준 ${confirmed}`,
  },
  {
    label: '에이전트 폐기 규칙 카드',
    testId: 'metric-agent-retired',
    role: 'button',
    text: `에이전트 폐기 규칙 ${retired}`,
    attributes: { title: '폐기 · 대체 누적' },
  },
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
        ...metrics({ all: '2 / 5', confirmed: '1 / 3', retired: '1' }, '$0.20'),
        { label: '코드 열람 영역', testId: 'code-open', role: 'region', name: '코드 열람' },
        { label: '코드 열람 사유 3종', testId: 'code-open-label', count: 3 },
        { label: '화면 오류 건수', text: '화면 오류 2' },
        { label: '정보 부족 건수 (0건도 0)', text: '정보 부족 0' },
        { label: '디버깅 건수', text: '디버깅 5' },
        { label: '코드 열람 없음 미표시', testId: 'code-open-none', absent: true },
        { label: '파이프라인 영역', testId: 'pipeline', role: 'region', name: '파이프라인' },
        { label: '최근 실행', testId: 'pipeline-run', text: 'EXE-003' },
        { label: '최근 실행 상태', testId: 'pipeline-run-status', text: '진행 중' },
        { label: '현재 단계', testId: 'pipeline-current', text: '구현' },
        { label: '단계 순서', testId: 'pipeline-stage', count: STAGE_LABELS.length },
        { label: '생략 문구 없음 (생략 단계 없음)', testId: 'pipeline-skip', absent: true },
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
        { label: '실행 링크 (기준 실행에서 판정된 규칙)', testId: 'run-link', count: 2 },
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
        ...metrics({ all: '0 / 2', confirmed: '0 / 1', retired: '0' }, '없음'),
        { label: '코드 열람 영역', testId: 'code-open', role: 'region', name: '코드 열람' },
        { label: '코드 열람 값 없음', testId: 'code-open-none', text: '없음' },
        { label: '코드 열람 사유 미표시', testId: 'code-open-reason', absent: true },
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

/**
 * 생략 단계가 있는 파이프라인 (`SKIPPED_SUMMARY`, #165). screens.md "생략 단계 흐림 + '생략'": 생략 단계에는 툴팁이 아니라
 * 보이는 문구 "생략"이 있다. 상태 이름은 기본이지만 데이터가 다르므로 scr-05.spec.ts가 이 표를 직접 넘긴다.
 */
export const verificationSkippedChecklist = {
  id: 'SCR-05',
  name: '검증 (생략 단계)',
  states: {
    기본: {
      title: 'BIVE',
      elements: [
        { label: '파이프라인 영역', testId: 'pipeline', role: 'region', name: '파이프라인' },
        { label: '최근 실행', testId: 'pipeline-run', text: 'EXE-003' },
        { label: '최근 실행 상태', testId: 'pipeline-run-status', text: '병합 완료' },
        { label: '현재 단계 없음 (끝난 실행)', testId: 'pipeline-current', absent: true },
        { label: '단계 순서', testId: 'pipeline-stage', count: STAGE_LABELS.length },
        { label: '생략 단계 이름', text: '변이 주입' },
        { label: '생략 단계 문구 (보이는 글자)', testId: 'pipeline-skip', text: '생략', count: 1 },
      ],
    },
  },
} satisfies ScreenChecklist;

/**
 * 병합 뒤 화면 갱신 단계만 실패한 실행 (`SCREEN_UPDATE_FAILED_SUMMARY`, ADR-091). 실행 상태는 "병합 완료", 머리줄은 그 실행의
 * 병합 커밋, 목록의 실행 링크는 그 실행. 상태 이름은 기본이지만 데이터가 다르므로 scr-05.spec.ts가 이 표를 직접 넘긴다.
 */
export const verificationScreenUpdateFailedChecklist = {
  id: 'SCR-05',
  name: '검증 (병합 뒤 화면 갱신 실패)',
  states: {
    기본: {
      title: 'BIVE',
      elements: [
        {
          label: '머리줄 (그 실행의 병합 커밋)',
          testId: 'verification-basis',
          text: '판정 기준 main@b2c37d4',
        },
        { label: '파이프라인 영역', testId: 'pipeline', role: 'region', name: '파이프라인' },
        { label: '최근 실행', testId: 'pipeline-run', text: 'EXE-003' },
        { label: '최근 실행 상태', testId: 'pipeline-run-status', text: '병합 완료' },
        { label: '현재 단계 없음 (끝난 실행)', testId: 'pipeline-current', absent: true },
        { label: '단계 순서', testId: 'pipeline-stage', count: STAGE_LABELS.length },
        { label: '재개 버튼 미노출 (중단 아님)', role: 'button', name: '재개', absent: true },
        { label: '실행 링크 ID (그 실행)', testId: 'run-link-id', text: 'EXE-003' },
      ],
    },
  },
} satisfies ScreenChecklist;
