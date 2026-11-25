// SCR-04 계약 (screens.md SCR-04 · 1.4, ADR-029 · ADR-060 · ADR-073, ADR-100 I3 · 명세 변경 목록 SCR-04, ADR-129 · ADR-133).
// - 기본: 목록 + 상세 2단. 카드 1줄 원본 파일 · 생성 주체 아이콘(판정이 통과면 앞에 흐린 점), 2줄 표시 ID · 예외(결함 스키마
//   불일치 · 검사 규칙 없음, 다음 미확인) · 등록 시각. 검색 · 필터 칩 4종(종류 · 검사 규칙 · 판정 · 확인) · [문제만].
//   상세(카드를 고른 뒤): 종류 · 원본 파일 · 연결 규칙 · 판정 · 부모 요구사항 · 생성 주체 · 확인 상태. [확인] · 지시 버튼은 없다
// - 빈: "계약 없음"(ADR-029)
// - 로딩 · 에러: 화면 정의서에 정의 없음 → ADR-133(ADR-060 · ADR-073과 같음: 로딩 = 목록 자리 비움, 에러 = "계약 불러오기 실패")
import type {
  ContractListResult,
  JudgmentResult,
  JudgmentStatus,
  Rule,
  RuleWithJudgment,
} from '@bive/shared';

import { REQUIREMENTS } from './scr-02.js';
import type { ElementCheck, ScreenChecklist } from './types.js';

export { PROJECT } from './scr-02.js';

/** 부모 요구사항 (REQ-001, `requirement.get` 가짜 응답). */
export const PARENT = REQUIREMENTS[0];

const CONFIRMED = {
  state: 'confirmed',
  at: '2026-11-20T02:00:00.000Z',
  by: { kind: 'human' },
  basis: { kind: 'contract_record', at: '2026-11-20T01:00:00.000Z' },
} as const;

const UNCONFIRMED = { state: 'unconfirmed' } as const;

type Entry = ContractListResult['contracts'][number];

const contractEntry = (
  n: number,
  patch: Partial<Entry['contract']> & Pick<Entry['contract'], 'kind' | 'sourceFile'>,
  rule: Entry['rule'],
): Entry => ({
  contract: {
    id: `01JF00000000000000000000${String(n).padStart(2, '0')}`,
    displayId: `CON-00${n}`,
    contentHash: 'c'.repeat(64),
    sourceCommit: 'd'.repeat(40),
    parentRequirementId: null,
    author: { kind: 'human' },
    createdAt: `2026-11-20T0${n}:00:00.000Z`,
    confirmation: CONFIRMED,
    ...patch,
  },
  rule,
  source: { status: 'same' },
});

const ruleRef = (n: number): NonNullable<Entry['rule']> => ({
  id: `01JC00000000000000000000${String(n).padStart(2, '0')}`,
  displayId: `RULE-0${n}`,
});

/**
 * `contract.list` 가짜 응답 (테스트 전용 데이터, NFR-03).
 * - CON-001 API · 검사 규칙 RULE-011(통과) · 부모 REQ-001 · 사람 · 확인됨 → 정상
 * - CON-002 DB · RULE-012(실패) → 결함 "스키마 불일치"
 * - CON-003 이벤트 · 검사 규칙 없음 · 에이전트 · 미확인 → 결함 "검사 규칙 없음" + "미확인"
 * - CON-004 API · RULE-014(판정 기록 없음 = 미판정) · 에이전트 · 미확인 → "미확인"만(미판정은 결함이 아니다)
 */
export const CONTRACTS: Entry[] = [
  contractEntry(
    1,
    { kind: 'openapi', sourceFile: 'api/openapi.yaml', parentRequirementId: PARENT?.id ?? null },
    ruleRef(11),
  ),
  contractEntry(2, { kind: 'db-schema', sourceFile: 'prisma/schema.prisma' }, ruleRef(12)),
  contractEntry(
    3,
    {
      kind: 'asyncapi',
      sourceFile: 'events/asyncapi.yaml',
      author: { kind: 'agent', role: 'rule-writer' },
      confirmation: UNCONFIRMED,
    },
    null,
  ),
  contractEntry(
    4,
    {
      kind: 'openapi',
      sourceFile: 'api/admin.yaml',
      author: { kind: 'agent', role: 'rule-writer' },
      confirmation: UNCONFIRMED,
    },
    ruleRef(14),
  ),
];

const contractRule = (n: number, contractN: number, status: JudgmentStatus): RuleWithJudgment => {
  const ref = ruleRef(n);
  const contractId = CONTRACTS[contractN - 1]?.contract.id ?? null;
  const rule: Rule = {
    id: ref.id,
    displayId: ref.displayId,
    title: `계약 일치: CON-00${contractN}`,
    statement: `WHILE 계약 CON-00${contractN}이 등록되어 있으면 THE SYSTEM SHALL 그 계약의 원본 파일이 형식에 맞고 구현이 그 계약과 일치한다`,
    kind: 'tech-constraint',
    checkKinds: ['contract'],
    parentRequirementId: null,
    parentDetachedAt: null,
    builtin: true,
    targetBlockIds: [],
    risk: null,
    contractId,
    author: { kind: 'human' },
    normState: 'approved',
    createdAt: '2026-11-20T01:00:00.000Z',
    updatedAt: '2026-11-20T01:00:00.000Z',
    deletedAt: null,
    confirmation: UNCONFIRMED,
  };
  if (status === 'unjudged') return { rule, judgment: { status, latest: null } };
  const latest: JudgmentResult = {
    id: `01JD00000000000000000000${String(n).padStart(2, '0')}`,
    ruleId: rule.id,
    runId: '01JE0000000000000000000001',
    stepId: null,
    commit: 'e'.repeat(40),
    judgedAt: '2026-11-21T02:00:00.000Z',
    status,
    runner: 'vitest',
    exitCode: status === 'pass' ? 0 : 1,
    reporterPath: null,
    cases: [],
    quarantineReason: null,
  };
  return { rule, judgment: { status, latest } };
};

/** `rule.list` 가짜 응답: 계약 검사 규칙 셋(테스트 전용 데이터, NFR-03). */
export const CONTRACT_RULES: RuleWithJudgment[] = [
  contractRule(11, 1, 'pass'),
  contractRule(12, 2, 'fail'),
  contractRule(14, 4, 'unjudged'),
];

/** 화면에 보이는 순서: 문제 항목(결함 · 미확인) 먼저 등록 시각 최신순, 그다음 정상 (ADR-034 · ADR-048). */
export const VISIBLE_ORDER = ['CON-004', 'CON-003', 'CON-002', 'CON-001'] as const;

/** 필터 칩 4종 (SCR-04 필터 + 확인, ADR-100 I3). */
export const CHIPS = [
  { id: 'kind', label: '종류' },
  { id: 'rule', label: '검사 규칙' },
  { id: 'judgment', label: '판정' },
  { id: 'confirmation', label: '확인' },
] as const;

const detailFrame: ElementCheck[] = [
  {
    label: '상세 자리',
    testId: 'contract-detail',
    role: 'region',
    name: '상세',
  },
  // 계약의 신규 등록 지시 · 변경 지시는 없다 (ADR-133. 상세의 [확인]이 없음은 spec이 상세 안 버튼으로 단언한다)
  { label: '지시 동작 없음', text: /지시/, absent: true },
];

const emptyDetail: ElementCheck[] = [
  ...detailFrame,
  { label: '상세 빈 상태', text: '선택 항목 없음' },
];

const toolbar: ElementCheck[] = [
  { label: '목록', testId: 'list-view', role: 'region', name: '계약 목록' },
  { label: '검색', testId: 'list-search', role: 'searchbox', name: '검색' },
  ...CHIPS.map((chip): ElementCheck => ({
    label: `필터 칩 ${chip.label}`,
    testId: `filter-chip-${chip.id}`,
    text: chip.label,
  })),
  { label: '문제만 토글', testId: 'problem-toggle', role: 'button', name: '문제만' },
  { label: '숨김 토글 없음', testId: 'hidden-toggle', absent: true },
  { label: '결과 줄 (필터 없음)', testId: 'list-result', absent: true },
];

const value = (id: string, label: string, text: string | RegExp): ElementCheck => ({
  label: `상세 ${label}`,
  testId: `contract-value-${id}`,
  text,
});

export const contractsChecklist = {
  id: 'SCR-04',
  name: '계약',
  states: {
    // 기본: CON-001 카드를 고른 뒤
    기본: {
      title: 'BIVE',
      elements: [
        ...toolbar,
        { label: '카드', testId: 'card', count: 4 },
        { label: '카드 1줄 원본 파일', testId: 'card-title', text: 'api/admin.yaml' },
        { label: '카드 2줄 ID', testId: 'card-id', text: 'CON-004' },
        { label: '카드 2줄 예외 (결함 둘 · 미확인 둘)', testId: 'card-exception', count: 4 },
        { label: '결함 스키마 불일치', text: '스키마 불일치' },
        { label: '결함 검사 규칙 없음', text: '검사 규칙 없음' },
        { label: '예외 미확인 (CON-003 · CON-004)', text: '미확인', count: 2 },
        {
          label: '정상 판정(통과)은 흐린 점',
          testId: 'status-badge',
          role: 'img',
          name: '통과',
          count: 1,
          attributes: { 'data-tone': 'normal' },
        },
        {
          label: '생성 주체 아이콘 (사람)',
          testId: 'author-mark',
          role: 'img',
          name: '사람',
          count: 2,
        },
        {
          label: '생성 주체 아이콘 (에이전트)',
          testId: 'author-mark',
          role: 'img',
          name: '에이전트',
          count: 2,
        },
        { label: '빈 상태 없음', text: '계약 없음', absent: true },
        ...detailFrame,
        { label: '상세 제목', testId: 'contract-detail-title', text: 'api/openapi.yaml' },
        { label: '상세 표시 ID', testId: 'contract-detail-id', text: 'CON-001' },
        value('kind', '종류', 'API'),
        value('source', '원본 파일', 'api/openapi.yaml'),
        value('rule', '연결 규칙', 'RULE-011'),
        { label: '연결 규칙 링크', testId: 'contract-rule-ref', role: 'button', name: 'RULE-011' },
        value('judgment', '판정', '통과'),
        value('parent', '부모 요구사항', 'REQ-001'),
        value('author', '생성 주체', '사람'),
        value('confirmation', '확인 상태', '확인됨'),
      ],
    },
    빈: {
      title: 'BIVE',
      elements: [
        ...toolbar,
        { label: '빈 상태', testId: 'empty-state', text: '계약 없음' },
        { label: '카드 없음', testId: 'card', absent: true },
        ...emptyDetail,
      ],
    },
    로딩: {
      title: 'BIVE',
      elements: [
        {
          label: '목록 자리 (대기)',
          testId: 'contracts-loading',
          attributes: { 'aria-busy': 'true' },
        },
        { label: '목록 미표시', testId: 'list-view', absent: true },
        { label: '빈 상태 없음', text: '계약 없음', absent: true },
        { label: '불러오기 실패 없음', text: '계약 불러오기 실패', absent: true },
        ...emptyDetail,
      ],
    },
    에러: {
      title: 'BIVE',
      elements: [
        {
          label: '불러오기 실패',
          testId: 'contracts-load-error',
          role: 'alert',
          text: '계약 불러오기 실패',
        },
        { label: '목록 미표시', testId: 'list-view', absent: true },
        { label: '빈 상태 없음', text: '계약 없음', absent: true },
        ...emptyDetail,
      ],
    },
  },
} satisfies ScreenChecklist;
