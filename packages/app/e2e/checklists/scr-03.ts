// SCR-03 규칙 (screens.md SCR-03 · 1.4, ADR-029 · ADR-035 · ADR-060).
// - 기본: 목록 + 상세 2단. 카드 1줄 제목 · 생성 주체 아이콘(판정이 통과면 앞에 흐린 점), 2줄 ID · WHEN 조건 · 예외.
//   검색 · 필터 칩 6종(판정 · 변이 · 준수 집계 · 블록 · 위험도 · 종류) · [문제만]. 상세 자리는 "선택 항목 없음".
//   [실행]은 실행 시작 확인 이슈(#32) 전이라 미노출 (ADR-035)
// - 빈: "규칙 없음"(ADR-029)
// - 로딩 · 에러: 화면 정의서에 정의 없음 → ADR-060 (ADR-053과 같음: 로딩 = 목록 자리 비움, 에러 = "규칙 불러오기 실패")
import type { JudgmentResult, Rule, RuleWithJudgment } from '@bive/shared';

import type { ElementCheck, ScreenChecklist } from './types.js';

export { PROJECT } from './scr-02.js';

const base = {
  parentRequirementId: '01JB0000000000000000000001',
  parentDetachedAt: null,
  builtin: false,
  risk: null,
  contractId: null,
  author: { kind: 'agent', role: 'rule-writer' },
  normState: 'approved',
  createdAt: '2026-10-15T01:00:00.000Z',
  updatedAt: '2026-10-15T01:00:00.000Z',
  deletedAt: null,
} as const satisfies Partial<Rule>;

const rule = (
  patch: Pick<Rule, 'id' | 'displayId' | 'title' | 'statement' | 'kind'> & Partial<Rule>,
): Rule => ({ ...base, checkKinds: ['test'], targetBlockIds: [], ...patch });

/** 판정 기록 (테스트 전용 데이터, NFR-03). */
const judged = (item: Rule, status: 'pass' | 'fail' | 'needs_recheck'): RuleWithJudgment => {
  const latest: JudgmentResult = {
    id: `01JD00000000000000000000${item.displayId.slice(-2)}`,
    ruleId: item.id,
    runId: '01JE0000000000000000000001',
    stepId: null,
    commit: 'a1f26b1'.padEnd(40, '0'),
    judgedAt: '2026-10-16T02:00:00.000Z',
    status,
    runner: 'vitest',
    exitCode: status === 'pass' ? 0 : 1,
    reporterPath: null,
    cases: [],
    quarantineReason: null,
  };
  return { rule: item, judgment: { status, latest } };
};

const unjudged = (item: Rule): RuleWithJudgment => ({
  rule: item,
  judgment: { status: 'unjudged', latest: null },
});

/** `rule.list` 가짜 응답 (테스트 전용 데이터, NFR-03). 삭제된 RULE-004는 화면에 보이면 안 된다. */
export const RULES: RuleWithJudgment[] = [
  judged(
    rule({
      id: '01JC0000000000000000000001',
      displayId: 'RULE-001',
      title: '로그인 5회 실패 시 계정 잠금',
      statement:
        'WHEN 같은 계정으로 로그인이 5회 연속 실패하면 THE SYSTEM SHALL 계정을 10분간 잠근다',
      kind: 'business',
    }),
    'pass',
  ),
  judged(
    rule({
      id: '01JC0000000000000000000002',
      displayId: 'RULE-002',
      title: '결제 24시간 뒤 주문 취소 거절',
      statement:
        'WHEN 결제 후 24시간이 지난 주문의 취소를 요청하면 THE SYSTEM SHALL 요청을 거절한다',
      kind: 'business',
    }),
    'fail',
  ),
  unjudged(
    rule({
      id: '01JC0000000000000000000003',
      displayId: 'RULE-003',
      title: '모든 응답 본문은 UTF-8',
      statement: 'THE SYSTEM SHALL 모든 응답 본문을 UTF-8로 인코딩한다',
      kind: 'tech-constraint',
    }),
  ),
  unjudged(
    rule({
      id: '01JC0000000000000000000004',
      displayId: 'RULE-004',
      title: '삭제된 규칙',
      statement: 'WHEN 삭제되면 THE SYSTEM SHALL 보이지 않는다',
      kind: 'business',
      deletedAt: '2026-10-16T00:00:00.000Z',
    }),
  ),
  judged(
    rule({
      id: '01JC0000000000000000000005',
      displayId: 'RULE-005',
      title: 'API 라우트는 서비스 계층만 호출',
      statement: 'WHEN API 라우트가 데이터를 읽으면 THE SYSTEM SHALL 서비스 계층을 거친다',
      kind: 'architecture',
    }),
    'needs_recheck',
  ),
  judged(
    rule({
      id: '01JC0000000000000000000006',
      displayId: 'RULE-006',
      title: '비밀번호 재설정 링크 30분 만료',
      statement: 'WHEN 재설정 링크가 발급 후 30분을 넘기면 THE SYSTEM SHALL 링크를 거부한다',
      kind: 'business',
      normState: 'provisional',
    }),
    'pass',
  ),
];

/** 화면에 보이는 순서: 문제 항목(실패 · 미판정 · 재검증 필요 · 잠정) 먼저 받은 순서, 그다음 정상 (ADR-034 · ADR-060). */
export const VISIBLE_ORDER = ['RULE-002', 'RULE-003', 'RULE-005', 'RULE-006', 'RULE-001'] as const;

/** 필터 칩 6종 (SCR-03 필터). 변이 · 블록 · 위험도는 값이 없어 0건 비활성 (ADR-035). */
export const CHIPS = [
  { id: 'judgment', label: '판정', enabled: true },
  { id: 'mutation', label: '변이', enabled: false },
  { id: 'compliance', label: '준수 집계', enabled: true },
  { id: 'block', label: '블록', enabled: false },
  { id: 'risk', label: '위험도', enabled: false },
  { id: 'kind', label: '종류', enabled: true },
] as const;

const frame: ElementCheck[] = [
  {
    label: '상세 자리',
    testId: 'rule-detail',
    role: 'region',
    name: '상세',
    attributes: { 'data-selected-id': '' },
  },
  { label: '상세 빈 상태', text: '선택 항목 없음' },
  // [실행]은 실행 시작 확인(#32) 전 미노출 (ADR-035)
  { label: '실행 버튼 미노출', role: 'button', name: '실행', absent: true },
];

const toolbar: ElementCheck[] = [
  { label: '목록', testId: 'list-view', role: 'region', name: '규칙 목록' },
  { label: '검색', testId: 'list-search', role: 'searchbox', name: '검색' },
  ...CHIPS.map((chip): ElementCheck => ({
    label: `필터 칩 ${chip.label}`,
    testId: `filter-chip-${chip.id}`,
    text: chip.label,
  })),
  { label: '문제만 토글', testId: 'problem-toggle', role: 'button', name: '문제만' },
  { label: '결과 줄 (필터 없음)', testId: 'list-result', absent: true },
];

export const rulesChecklist = {
  id: 'SCR-03',
  name: '규칙',
  states: {
    기본: {
      title: 'BIVE',
      elements: [
        ...toolbar,
        { label: '카드 (삭제 항목 제외)', testId: 'card', count: 5 },
        { label: '카드 1줄 제목', testId: 'card-title', text: '결제 24시간 뒤 주문 취소 거절' },
        { label: '카드 2줄 ID', testId: 'card-id', text: 'RULE-002' },
        {
          label: '카드 2줄 WHEN 조건',
          testId: 'card-note',
          count: 4,
          text: 'WHEN 결제 후 24시간이 지난 주문의 취소를 요청하면',
        },
        { label: '카드 2줄 예외', testId: 'card-exception', count: 4, text: '실패' },
        { label: '예외 미판정', text: '미판정' },
        { label: '예외 재검증 필요', text: '재검증 필요' },
        { label: '예외 잠정', text: '잠정' },
        {
          label: '정상 판정(통과)은 흐린 점',
          testId: 'status-badge',
          role: 'img',
          name: '통과',
          count: 2,
          attributes: { 'data-tone': 'normal' },
        },
        {
          label: '생성 주체 아이콘 (에이전트)',
          testId: 'author-mark',
          role: 'img',
          name: '에이전트',
          count: 5,
        },
        { label: '삭제된 규칙 미표시', text: '삭제된 규칙', absent: true },
        { label: '빈 상태 없음', text: '규칙 없음', absent: true },
        ...frame,
      ],
    },
    빈: {
      title: 'BIVE',
      elements: [
        ...toolbar,
        { label: '빈 상태', testId: 'empty-state', text: '규칙 없음' },
        { label: '카드 없음', testId: 'card', absent: true },
        ...frame,
      ],
    },
    로딩: {
      title: 'BIVE',
      elements: [
        {
          label: '목록 자리 (대기)',
          testId: 'rules-loading',
          attributes: { 'aria-busy': 'true' },
        },
        { label: '목록 미표시', testId: 'list-view', absent: true },
        { label: '빈 상태 없음', text: '규칙 없음', absent: true },
        { label: '불러오기 실패 없음', text: '규칙 불러오기 실패', absent: true },
        ...frame,
      ],
    },
    에러: {
      title: 'BIVE',
      elements: [
        {
          label: '불러오기 실패',
          testId: 'rules-load-error',
          role: 'alert',
          text: '규칙 불러오기 실패',
        },
        { label: '목록 미표시', testId: 'list-view', absent: true },
        { label: '빈 상태 없음', text: '규칙 없음', absent: true },
        ...frame,
      ],
    },
  },
} satisfies ScreenChecklist;
