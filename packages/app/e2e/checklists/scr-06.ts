// SCR-06 규범 상세 (screens.md SCR-06 · SCR-03 상세 · 1.4 상세 접힘, ADR-035 · ADR-073).
// 규칙 화면(SCR-03) 목록 + 상세 2단의 상세 영역이다(별도 화면 아님). 요구사항 상세(#38)는 같은 파일에 상태를 더한다.
// - 기본(규칙): 진술 · 종류 · 검사 · 부모 요구사항 · 생성 주체(이름), 테스트 실행 결과(판정 · 시각 · 커밋 · 실행 · 케이스),
//   테스트 출력(최신 판정이 실패라 자동 펼침: 실패 원인 = 케이스 이름 · `file:line` · 메시지), 실행 이력(최신부터).
//   변경 이력(P1) · 변이 상태는 미노출 (ADR-035). 규칙 화면 상세의 머리에는 [실행] (ADR-076)
// - 로딩 · 에러: 화면 정의서에 정의 없음 → ADR-073 (실행 이력 자리만 비움 · "실행 이력 불러오기 실패", 나머지 상세는 그대로)
import type {
  JudgmentCase,
  JudgmentResult,
  Requirement,
  Rule,
  RuleJudgmentEntry,
  RuleWithJudgment,
} from '@bive/shared';

import { REQUIREMENTS } from './scr-02.js';
import type { ElementCheck, ScreenChecklist } from './types.js';

export { PROJECT } from './scr-02.js';

/** 부모 요구사항 (`requirement.get` 가짜 응답, 테스트 전용 데이터). */
export const PARENT: Requirement = REQUIREMENTS[0] as Requirement;

const base = {
  parentRequirementId: PARENT.id,
  parentDetachedAt: null,
  builtin: false,
  risk: null,
  contractId: null,
  author: { kind: 'agent', role: 'rule-writer' },
  normState: 'approved',
  checkKinds: ['test'],
  targetBlockIds: [],
  createdAt: '2026-10-15T01:00:00.000Z',
  updatedAt: '2026-10-15T01:00:00.000Z',
  deletedAt: null,
} as const satisfies Partial<Rule>;

const RUN_1 = '01JE0000000000000000000001';
const RUN_2 = '01JE0000000000000000000002';
const FILE = 'bive-acceptance/RULE-002/cancel.acc.ts';

/** 실패 케이스 (실행기 출력 그대로, 테스트 전용 데이터). */
export const FAILED_CASE: JudgmentCase = {
  name: '결제 24시간 뒤 취소 요청 > 409를 돌려준다',
  file: FILE,
  line: 18,
  status: 'failed',
  message: 'AssertionError: expected 200 to be 409',
};

const PASSED_CASE: JudgmentCase = {
  name: '결제 24시간 이내 취소 요청 > 200을 돌려준다',
  file: FILE,
  line: 9,
  status: 'passed',
  message: null,
};

const judgmentOf = (
  ruleId: string,
  id: string,
  patch: Pick<JudgmentResult, 'status' | 'judgedAt' | 'commit' | 'runId' | 'cases'>,
): JudgmentResult => ({
  id,
  ruleId,
  stepId: null,
  runner: 'vitest',
  exitCode: patch.status === 'pass' ? 0 : 1,
  reporterPath: null,
  quarantineReason: null,
  ...patch,
});

const failingRule: Rule = {
  ...base,
  id: '01JC0000000000000000000002',
  displayId: 'RULE-002',
  title: '결제 24시간 뒤 주문 취소 거절',
  statement: 'WHEN 결제 후 24시간이 지난 주문의 취소를 요청하면 THE SYSTEM SHALL 요청을 거절한다',
  kind: 'business',
};

const passingRule: Rule = {
  ...base,
  id: '01JC0000000000000000000001',
  displayId: 'RULE-001',
  title: '로그인 5회 실패 시 계정 잠금',
  statement: 'WHEN 같은 계정으로 로그인이 5회 연속 실패하면 THE SYSTEM SHALL 계정을 10분간 잠근다',
  kind: 'business',
};

const unjudgedRule: Rule = {
  ...base,
  id: '01JC0000000000000000000003',
  displayId: 'RULE-003',
  title: '모든 응답 본문은 UTF-8',
  statement: 'THE SYSTEM SHALL 모든 응답 본문을 UTF-8로 인코딩한다',
  kind: 'tech-constraint',
  author: { kind: 'human' },
};

/** RULE-002의 판정 이력 (최신부터): 실패(EXE-002) → 통과(EXE-001). */
export const FAILING_HISTORY: RuleJudgmentEntry[] = [
  {
    judgment: judgmentOf(failingRule.id, '01JD0000000000000000000022', {
      status: 'fail',
      judgedAt: '2026-10-16T02:00:00.000Z',
      commit: 'b2c3d4e'.padEnd(40, '0'),
      runId: RUN_2,
      cases: [FAILED_CASE, PASSED_CASE],
    }),
    runDisplayId: 'EXE-002',
  },
  {
    judgment: judgmentOf(failingRule.id, '01JD0000000000000000000021', {
      status: 'pass',
      judgedAt: '2026-10-15T02:00:00.000Z',
      commit: 'a1f26b1'.padEnd(40, '0'),
      runId: RUN_1,
      cases: [{ ...FAILED_CASE, status: 'passed', message: null }, PASSED_CASE],
    }),
    runDisplayId: 'EXE-001',
  },
];

/** RULE-001의 판정 이력: 통과 1건(실행 밖 판정). */
export const PASSING_HISTORY: RuleJudgmentEntry[] = [
  {
    judgment: judgmentOf(passingRule.id, '01JD0000000000000000000011', {
      status: 'pass',
      judgedAt: '2026-10-16T03:00:00.000Z',
      commit: 'c3d4e5f'.padEnd(40, '0'),
      runId: null,
      cases: [
        {
          name: '5회 실패 뒤 로그인 > 423을 돌려준다',
          file: 'bive-acceptance/RULE-001/lock.acc.ts',
          line: 7,
          status: 'passed',
          message: null,
        },
      ],
    }),
    runDisplayId: null,
  },
];

const latestOf = (history: RuleJudgmentEntry[]): JudgmentResult =>
  (history[0] as RuleJudgmentEntry).judgment;

/** `rule.list` 가짜 응답: 실패 · 통과 · 미판정 규칙 1건씩 (테스트 전용 데이터, NFR-03). */
export const RULES: RuleWithJudgment[] = [
  { rule: passingRule, judgment: { status: 'pass', latest: latestOf(PASSING_HISTORY) } },
  { rule: failingRule, judgment: { status: 'fail', latest: latestOf(FAILING_HISTORY) } },
  { rule: unjudgedRule, judgment: { status: 'unjudged', latest: null } },
];

/** `judgment.list` 가짜 응답: 규칙 ID → 이력. */
export const HISTORY: Record<string, RuleJudgmentEntry[]> = {
  [passingRule.id]: PASSING_HISTORY,
  [failingRule.id]: FAILING_HISTORY,
  [unjudgedRule.id]: [],
};

export const FAILING_RULE = failingRule;
export const PASSING_RULE = passingRule;
export const UNJUDGED_RULE = unjudgedRule;

/** 미노출 요소 (ADR-035): 변경 이력(P1) · 변이 상태(P1) · 대상 블록 · 위험도(P1). [실행]은 규칙 화면 상세에 있다(ADR-076). */
const hidden: ElementCheck[] = [
  { label: '변경 이력 미노출', text: /변경 이력/, absent: true },
  {
    // 정상 변이 상태는 흐린 점(이름만), 예외는 글자 (1.4 상태 배지)
    label: '변이 상태 미노출 (흐린 점)',
    role: 'img',
    name: /변이/,
    absent: true,
  },
  { label: '변이 상태 미노출 (글자)', text: /변이 생존/, absent: true },
  { label: '대상 블록 미노출', testId: 'rule-field-blocks', absent: true },
  { label: '위험도 미노출', testId: 'rule-field-risk', absent: true },
];

/** 실행 이력 밖의 상세 (상태와 무관하게 같다). */
const detail: ElementCheck[] = [
  {
    label: '상세 영역',
    testId: 'rule-detail',
    role: 'region',
    name: '상세',
    attributes: { 'data-selected-id': failingRule.id },
  },
  { label: '상세 빈 상태 없음', text: '선택 항목 없음', absent: true },
  { label: '제목', testId: 'rule-detail-title', text: failingRule.title },
  { label: '표시 ID', testId: 'rule-detail-id', text: 'RULE-002' },
  { label: '진술', testId: 'rule-field-statement', text: `진술${failingRule.statement}` },
  { label: '종류', testId: 'rule-field-kind', text: '종류비즈니스' },
  { label: '검사', testId: 'rule-field-checks', text: '검사인수 테스트' },
  {
    label: '부모 요구사항',
    testId: 'rule-field-parent',
    text: `부모 요구사항${PARENT.displayId} · ${PARENT.text}`,
  },
  { label: '생성 주체 (이름)', testId: 'rule-field-author', text: '생성 주체에이전트 · 규칙 작성' },
  { label: '테스트 실행 결과', testId: 'rule-result', role: 'region', name: '테스트 실행 결과' },
  { label: '결과 판정 (실패)', testId: 'rule-field-result-status', text: '판정실패' },
  { label: '결과 커밋', testId: 'rule-field-result-commit', text: '커밋b2c3d4e' },
  { label: '결과 케이스', testId: 'rule-field-result-cases', text: '케이스통과 1 · 실패 1' },
  {
    label: '테스트 출력 (자동 펼침)',
    role: 'button',
    name: '테스트 출력',
    attributes: { 'aria-expanded': 'true' },
  },
  { label: '실패 원인', text: '실패 원인' },
  { label: '실패 케이스', testId: 'failure-case', count: 1 },
  { label: '실패 케이스 이름', testId: 'failure-case-name', text: FAILED_CASE.name },
  { label: '실패 케이스 위치', testId: 'failure-case-location', text: `${FILE}:18` },
  {
    label: '실패 케이스 메시지',
    testId: 'failure-case-message',
    text: 'AssertionError: expected 200 to be 409',
  },
  { label: '전체 케이스', testId: 'test-case', count: 2 },
  { label: '실행 이력', testId: 'rule-history', role: 'region', name: '실행 이력' },
  { label: '실행 버튼 (규칙 화면 상세 머리)', testId: 'run-start', role: 'button', name: '실행' },
  ...hidden,
];

/** 최신 판정의 실행 ID는 실행 이력(`judgment.list`)에서 찾으므로 이력이 있을 때만 보인다. */
const latestRun: ElementCheck = {
  label: '결과 실행',
  testId: 'rule-field-result-run',
  text: '실행EXE-002',
};
const noLatestRun: ElementCheck = {
  label: '결과 실행 미표시',
  testId: 'rule-field-result-run',
  absent: true,
};

export const ruleDetailChecklist = {
  id: 'SCR-06',
  name: '규범 상세',
  states: {
    기본: {
      title: 'BIVE',
      elements: [
        ...detail,
        latestRun,
        { label: '실행 이력 행 (최신부터)', testId: 'history-row', count: 2 },
        { label: '실행 이력 실행 ID', testId: 'history-run', count: 2 },
        { label: '이력 불러오기 실패 없음', testId: 'rule-history-error', absent: true },
      ],
    },
    로딩: {
      title: 'BIVE',
      elements: [
        ...detail,
        {
          label: '실행 이력 자리 (대기)',
          testId: 'rule-history-loading',
          attributes: { 'aria-busy': 'true' },
        },
        { label: '실행 이력 행 없음', testId: 'history-row', absent: true },
        noLatestRun,
      ],
    },
    에러: {
      title: 'BIVE',
      elements: [
        ...detail,
        {
          label: '실행 이력 불러오기 실패',
          testId: 'rule-history-error',
          role: 'alert',
          text: '실행 이력 불러오기 실패',
        },
        { label: '실행 이력 행 없음', testId: 'history-row', absent: true },
        noLatestRun,
      ],
    },
  },
} satisfies ScreenChecklist;
