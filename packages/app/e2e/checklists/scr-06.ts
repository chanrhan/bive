// SCR-06 규범 상세 (screens.md SCR-06 · SCR-03 상세 · 1.4 상세 접힘, ADR-035 · ADR-073).
// 규칙 화면(SCR-03) · 요구사항 화면(SCR-02) 목록 + 상세 2단의 상세 영역이다(별도 화면 아님).
// 규칙 상세는 `ruleDetailChecklist`(index.ts에 등록), 요구사항 상세는 `requirementDetailChecklist`(spec이 넘김)
// - 기본(규칙): 진술 · 종류 · 검사 · 부모 요구사항 · 생성 주체(이름), 테스트 실행 결과(판정 · 시각 · 커밋 · 실행 · 케이스),
//   테스트 출력(최신 판정이 실패라 자동 펼침: 실패 원인 = 케이스 이름 · `file:line` · 메시지), 실행 이력(최신부터).
//   변이 상태는 미노출 (ADR-035). 규칙 화면 상세의 머리에는 [편집] · [실행] (ADR-076 · ADR-109),
//   속성 줄에 확인 상태와 (미확인이면) [확인], 맨 아래 변경 이력(규범 변경 기록, 기본 접힘) (M7-03 · M7-15 · ADR-114)
// - 로딩 · 에러: 화면 정의서에 정의 없음 → ADR-073 (실행 이력 자리만 비움 · "실행 이력 불러오기 실패", 나머지 상세는 그대로)
// - 기본(요구사항): 표시 ID · [편집] · [삭제], 본문, 생성 주체(이름), 자식 규칙 목록(접힘). 변경 이력 · 구현 위치(P1)는
//   미노출 (ADR-035). 로딩 · 에러는 ADR-078 (자식 규칙 자리만 비움 · "자식 규칙 불러오기 실패", 나머지 상세는 그대로)
import type {
  JudgmentCase,
  JudgmentResult,
  NormChangeListResult,
  NormChangeView,
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
  confirmation: { state: 'unconfirmed' },
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

/**
 * 폐기된 규칙 (테스트 전용 데이터): RULE-002가 대체했다. 폐기 전 판정은 실패, 미확인. [폐기 포함]을 켜야 목록에 보인다.
 */
export const RETIRED_RULE: Rule = {
  ...base,
  id: '01JC0000000000000000000009',
  displayId: 'RULE-009',
  title: '결제 12시간 뒤 주문 취소 거절',
  statement: 'WHEN 결제 후 12시간이 지난 주문의 취소를 요청하면 THE SYSTEM SHALL 요청을 거절한다',
  kind: 'business',
  createdAt: '2026-10-14T01:00:00.000Z',
  updatedAt: '2026-10-14T01:00:00.000Z',
};
const RETIRED_AT = '2026-10-15T00:30:00.000Z';
export const RETIRED_ITEM: RuleWithJudgment = {
  rule: RETIRED_RULE,
  judgment: {
    status: 'fail',
    latest: judgmentOf(RETIRED_RULE.id, '01JD0000000000000000000091', {
      status: 'fail',
      judgedAt: '2026-10-14T02:00:00.000Z',
      commit: 'd4e5f6a'.padEnd(40, '0'),
      runId: RUN_1,
      cases: [],
    }),
  },
  retirement: {
    retiredAt: RETIRED_AT,
    supersededBy: { id: failingRule.id, displayId: failingRule.displayId },
    normChangeSeq: 6,
  },
};

const SESSION = '01JS0000000000000000000001';
const hashOf = (seq: number): string => String(seq).repeat(64).slice(0, 64);
const change = (
  patch: Pick<NormChangeView, 'seq' | 'at' | 'kind' | 'targetRef' | 'reason' | 'detail'>,
): NormChangeView => ({
  actor: { kind: 'agent', role: 'rule-writer' },
  sessionId: SESSION,
  runId: null,
  textTruncated: false,
  prevHash: hashOf(patch.seq - 1),
  hash: hashOf(patch.seq),
  ...patch,
});

/** 대체 근거 (표시 값: 응답에 이미 숨은 글자 표기로 온다. 화면은 다시 바꾸지 않는다). */
export const SUPERSEDE_GROUNDS =
  'RULE-009 진술 "결제 후 12시간이 지난 주문의 취소를" 거절하라는 내용은 24시간 기준과 동시에 만족될 수 없음';
export const CREATE_REASON = '요구사항의 24시간 기준을 응답 거절 규칙으로 옮김';

/** `normChange.list {targetRef: RULE-009}` 가짜 응답: 대체 기록 1건. */
export const RETIRED_CHANGES: NormChangeListResult = {
  entries: [
    change({
      seq: 6,
      at: RETIRED_AT,
      kind: 'superseded',
      targetRef: { entity: 'Rule', id: RETIRED_RULE.id },
      reason: SUPERSEDE_GROUNDS,
      detail: {
        retirement: {
          supersededBy: { id: failingRule.id, displayId: failingRule.displayId },
          createdSeq: 4,
          judgmentSeq: 5,
        },
      },
    }),
  ],
  chain: { valid: true, brokenAtSeq: null, reason: null },
};

/** `normChange.list {targetRef: RULE-002}` 가짜 응답: 신규 · 대체 판단(대상 RULE-009). */
export const FAILING_CHANGES: NormChangeListResult = {
  entries: [
    change({
      seq: 4,
      at: RETIRED_AT,
      kind: 'created',
      targetRef: { entity: 'Rule', id: failingRule.id },
      reason: CREATE_REASON,
      detail: {},
    }),
    change({
      seq: 5,
      at: RETIRED_AT,
      kind: 'judgment',
      targetRef: { entity: 'Rule', id: failingRule.id },
      reason: SUPERSEDE_GROUNDS,
      detail: {
        judgment: {
          subject: 'supersede',
          verdict: 'contradiction',
          contradicts: [{ id: RETIRED_RULE.id, displayId: RETIRED_RULE.displayId }],
          createdSeq: 4,
          input: { requirements: { total: 1, included: 1 }, rules: { total: 3, included: 3 } },
        },
      },
    }),
  ],
  chain: { valid: true, brokenAtSeq: null, reason: null },
};

/** 기록 없음 (사람이 만든 규칙 등). */
export const NO_CHANGES: NormChangeListResult = {
  entries: [],
  chain: { valid: true, brokenAtSeq: null, reason: null },
};

export const FAILING_RULE = failingRule;
export const PASSING_RULE = passingRule;
export const UNJUDGED_RULE = unjudgedRule;

/** 미노출 요소 (ADR-035): 변이 상태(P1) · 대상 블록 · 위험도(P1). [실행]은 규칙 화면 상세에 있다(ADR-076). */
const hidden: ElementCheck[] = [
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
  // 규칙 작성 역할이 바로 반영한 규칙은 미확인 (ADR-100 D1 · D2). 사람이 고치면 확인됨 (M7-03)
  { label: '확인 상태 (미확인)', testId: 'rule-field-confirmation', text: '확인미확인확인' },
  { label: '확인 상태 값', testId: 'rule-confirmation-state', text: '미확인' },
  // 미확인이면 [확인] (사람 주체 confirmation.set, ADR-100 D2 · M7-15)
  { label: '확인 버튼', testId: 'rule-confirm', role: 'button', name: '확인' },
  { label: '폐기 표시 없음 (효력 있는 규칙)', testId: 'rule-detail-retired', absent: true },
  {
    label: '변경 이력 (기본 접힘)',
    role: 'button',
    name: '변경 이력',
    attributes: { 'aria-expanded': 'false' },
  },
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
  { label: '편집 버튼 (규칙 상세 머리, M7-03)', testId: 'rule-edit', role: 'button', name: '편집' },
  { label: '편집 입력 닫힘', testId: 'rule-editor', absent: true },
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

// ── 요구사항 상세 ─────────────────────────────────────────

/** 요구사항 상세의 기본 요소 (자식 규칙 자리 밖, 상태와 무관하게 같다). PARENT = REQ-001 (사람이 씀). */
const requirementDetail: ElementCheck[] = [
  {
    label: '상세 영역',
    testId: 'requirement-detail',
    role: 'region',
    name: '상세',
    attributes: { 'data-selected-id': PARENT.id },
  },
  { label: '상세 빈 상태 없음', text: '선택 항목 없음', absent: true },
  { label: '표시 ID', testId: 'requirement-detail-id', text: PARENT.displayId },
  { label: '편집 버튼', testId: 'requirement-edit', role: 'button', name: '편집' },
  {
    label: '삭제 버튼 (확인 대기 아님)',
    testId: 'requirement-delete',
    role: 'button',
    name: '삭제',
  },
  { label: '본문', testId: 'requirement-field-text', text: `본문${PARENT.text}` },
  { label: '생성 주체 (이름)', testId: 'requirement-field-author', text: '생성 주체사람' },
  { label: '자식 규칙 영역', testId: 'requirement-rules', role: 'region', name: '자식 규칙' },
  { label: '편집 입력 닫힘', testId: 'requirement-editor', absent: true },
  { label: '동작 실패 문구 없음', testId: 'requirement-action-error', absent: true },
  // 미노출 (ADR-035): 변경 이력(P1) · 구현 위치(자식 규칙의 대상 블록, P1)
  { label: '변경 이력 미노출', text: /변경 이력/, absent: true },
  { label: '구현 위치 미노출', text: /구현 위치/, absent: true },
];

export const requirementDetailChecklist = {
  id: 'SCR-06',
  name: '규범 상세',
  states: {
    기본: {
      title: 'BIVE',
      elements: [
        ...requirementDetail,
        { label: '자식 규칙 (표시 ID 순)', testId: 'child-rule', count: RULES.length },
        {
          label: '자식 규칙 줄 (접힘)',
          testId: 'child-rule-toggle',
          role: 'button',
          attributes: { 'aria-expanded': 'false' },
        },
        { label: '펼친 규칙 없음', testId: 'child-rule-detail', absent: true },
        { label: '자식 규칙 불러오기 실패 없음', testId: 'requirement-rules-error', absent: true },
      ],
    },
    로딩: {
      title: 'BIVE',
      elements: [
        ...requirementDetail,
        {
          label: '자식 규칙 자리 (대기)',
          testId: 'requirement-rules-loading',
          attributes: { 'aria-busy': 'true' },
        },
        { label: '자식 규칙 없음', testId: 'child-rule', absent: true },
      ],
    },
    에러: {
      title: 'BIVE',
      elements: [
        ...requirementDetail,
        {
          label: '자식 규칙 불러오기 실패',
          testId: 'requirement-rules-error',
          role: 'alert',
          text: '자식 규칙 불러오기 실패',
        },
        { label: '자식 규칙 없음', testId: 'child-rule', absent: true },
      ],
    },
  },
} satisfies ScreenChecklist;
