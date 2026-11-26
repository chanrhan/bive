// 규칙 화면 표시 규칙 (이슈 #24, screens.md SCR-03 카드 · 필터 · 1.4, ADR-060, M7-15 #227 · ADR-100 I3 · D7 · ADR-114).
import {
  CONFIRMATION_STATE_LABELS,
  type JudgmentResult,
  type JudgmentStatus,
  RISK_LABELS as SHARED_RISK_LABELS,
  RULE_KIND_LABELS as SHARED_RULE_KIND_LABELS,
  type Rule,
  type RuleWithJudgment,
} from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  countOptions,
  EMPTY_FILTER,
  filterEntries,
  type ListEntry,
} from '../src/renderer/src/components/ListView/filter.js';
import {
  CONFIRMATION_LABELS,
  statusExceptions,
} from '../src/renderer/src/components/StatusBadge/status.js';
import {
  complianceGroup,
  complianceValues,
  isRetiredRule,
  RETIRED_HIDDEN,
  RISK_LABELS,
  RULE_KIND_LABELS,
  riskText,
  ruleCriteria,
  ruleCard,
  ruleDefectsOf,
  ruleSearchText,
  visibleRules,
  whenCondition,
} from '../src/renderer/src/screens/rules/rulesView.js';

const T0 = '2026-10-16T01:00:00.000Z';
const CONFIRMED = {
  state: 'confirmed',
  at: T0,
  by: { kind: 'human' },
  basis: { kind: 'approval_log', seq: 1 },
} as const;

const rule = (patch: Partial<Rule> & Pick<Rule, 'id' | 'displayId'>): Rule => ({
  title: '중복 이메일 가입 거부',
  statement: 'WHEN 이미 가입된 이메일로 가입을 요청하면 THE SYSTEM SHALL 가입을 거부한다',
  kind: 'business',
  checkKinds: ['test'],
  parentRequirementId: '01JA0000000000000000000009',
  parentDetachedAt: null,
  builtin: false,
  targetBlockIds: [],
  risk: null,
  contractId: null,
  author: { kind: 'agent', role: 'rule-writer' },
  normState: 'approved',
  createdAt: T0,
  updatedAt: T0,
  deletedAt: null,
  confirmation: CONFIRMED,
  ...patch,
});

const judged = (item: Rule, status: Exclude<JudgmentStatus, 'unjudged'>): RuleWithJudgment => {
  const latest: JudgmentResult = {
    id: '01JA00000000000000000000J1',
    ruleId: item.id,
    runId: '01JA00000000000000000000R1',
    stepId: null,
    commit: 'a'.repeat(40),
    judgedAt: T0,
    status,
    runner: 'vitest',
    exitCode: status === 'pass' ? 0 : 1,
    reporterPath: null,
    cases: [],
    quarantineReason: status === 'quarantined' ? '결과가 흔들림' : null,
  };
  return { rule: item, judgment: { status, latest } };
};
const unjudged = (item: Rule): RuleWithJudgment => ({
  rule: item,
  judgment: { status: 'unjudged', latest: null },
});

const PASS = judged(rule({ id: '01JA0000000000000000000001', displayId: 'RULE-001' }), 'pass');
const FAIL = judged(
  rule({ id: '01JA0000000000000000000002', displayId: 'RULE-002', kind: 'architecture' }),
  'fail',
);
const FRESH = unjudged(
  rule({
    id: '01JA0000000000000000000003',
    displayId: 'RULE-003',
    author: { kind: 'human' },
    statement: 'THE SYSTEM SHALL 모든 응답을 UTF-8로 보낸다',
  }),
);
const PROVISIONAL = unjudged(
  rule({ id: '01JA0000000000000000000004', displayId: 'RULE-004', normState: 'provisional' }),
);
const QUARANTINED = judged(
  rule({ id: '01JA0000000000000000000005', displayId: 'RULE-005', kind: 'tech-constraint' }),
  'quarantined',
);
/** 에이전트가 만들고 사람이 아직 보지 않은 규칙 (판정 통과) */
const UNCONFIRMED = judged(
  rule({
    id: '01JA0000000000000000000008',
    displayId: 'RULE-008',
    confirmation: { state: 'unconfirmed' },
  }),
  'pass',
);
/** 대체된 규칙: 폐기 전 판정은 실패, 미확인 */
const RETIRED: RuleWithJudgment = {
  ...judged(
    rule({
      id: '01JA0000000000000000000009',
      displayId: 'RULE-009',
      confirmation: { state: 'unconfirmed' },
    }),
    'fail',
  ),
  retirement: {
    retiredAt: T0,
    supersededBy: { id: '01JA0000000000000000000008', displayId: 'RULE-008' },
    normChangeSeq: 6,
  },
};

describe('WHEN 조건 (진술에서 그대로 자른다)', () => {
  it.each([
    [
      'WHEN … THE SYSTEM SHALL',
      'WHEN 이미 가입된 이메일로 가입을 요청하면 THE SYSTEM SHALL 가입을 거부한다',
      'WHEN 이미 가입된 이메일로 가입을 요청하면',
    ],
    [
      '쉼표로 끝나는 조건 (영어 EARS)',
      'When the user submits the form, the system shall validate the email',
      'When the user submits the form',
    ],
    [
      '앞에 WHILE 조건이 있어도 WHEN 조건만',
      'WHILE 점검 중 WHEN 결제를 요청하면 THE SYSTEM SHALL 거부한다',
      'WHEN 결제를 요청하면',
    ],
    [
      '기획서 예시',
      'WHEN 결제 후 7일 초과 환불 요청 THE SYSTEM SHALL 요청 거절',
      'WHEN 결제 후 7일 초과 환불 요청',
    ],
    // 숫자 · 삽입구의 쉼표는 경계가 아니다 (리뷰 재현 사례)
    [
      '숫자 사이 쉼표',
      'WHEN 금액이 1,000원 이상이면 THE SYSTEM SHALL 확인을 요구한다',
      'WHEN 금액이 1,000원 이상이면',
    ],
    [
      '조건 안 쉼표 + 주어 앞 쉼표는 끝 쉼표만 뗀다',
      'WHEN 사용자가 로그인하고, 세션이 만료되었으면, THE SYSTEM SHALL 다시 로그인을 요구한다',
      'WHEN 사용자가 로그인하고, 세션이 만료되었으면',
    ],
    [
      '영어 삽입구',
      'WHEN the user, who is an admin, deletes a project THE SYSTEM SHALL archive it',
      'WHEN the user, who is an admin, deletes a project',
    ],
    [
      '대문자 조건 안의 THE는 마지막 것(응답 주어)만 경계',
      'WHEN THE USER LOGS IN THE SYSTEM SHALL CREATE A SESSION',
      'WHEN THE USER LOGS IN',
    ],
    [
      '대소문자 혼합 (When + THE SYSTEM SHALL)',
      'When 결제를 요청하면 THE SYSTEM SHALL 거부한다',
      'When 결제를 요청하면',
    ],
    [
      '영어 소문자 문형의 삽입구 · 조건 안 the',
      'When the user, who is an admin, deletes the project, the system shall archive it',
      'When the user, who is an admin, deletes the project',
    ],
    [
      '여러 낱말 주어',
      'WHEN 주문이 취소되면 THE ORDER SERVICE SHALL 재고를 되돌린다',
      'WHEN 주문이 취소되면',
    ],
  ])('%s', (_, statement, expected) => {
    expect(whenCondition(statement)).toBe(expected);
  });

  it.each([
    ['WHEN 없음 (항상 지키는 규칙)', 'THE SYSTEM SHALL 모든 응답을 UTF-8로 보낸다'],
    ['WHEN 뒤에 SHALL 없음', 'WHEN 결제하면 거부한다'],
    ['SHALL 뒤에만 WHEN', 'THE SYSTEM SHALL 요청 시각을 기록한다 when possible'],
    ['조건이 비었음', 'WHEN THE SYSTEM SHALL 거부한다'],
    ['단어 안의 when은 키워드가 아님', 'Whenever THE SYSTEM SHALL 거부한다'],
    // 리뷰 재현 사례
    ['괄호 주석의 WHEN · SHALL', '시스템은 사용자가 로그인할 때(WHEN) 세션을 만들어야 한다(SHALL)'],
    [
      'SHALL 뒤의 when (사전 조건 아님)',
      'The system shall log out the user when idle, and shall notify the admin',
    ],
    // 확신할 수 없으면 표시하지 않는다
    ['SHALL 앞에 WHEN이 둘', 'WHEN 결제하고 WHEN 환불하면 THE SYSTEM SHALL 거부한다'],
    ['주어가 THE로 시작하지 않음 (대문자)', 'WHEN 결제를 요청하면 SYSTEM SHALL 거부한다'],
    ['주어가 THE로 시작하지 않음 (소문자)', 'When the user opens the page, it shall load fast'],
    ['소문자 문형에 쉼표 + the 경계 없음', 'When the user opens the page the system shall load'],
    ['주어 자리에 문장 부호', 'WHEN 결제하면 THE SYSTEM, 단 점검 중이면, SHALL 거부한다'],
    ['대문자 SHALL인데 대문자 THE 주어 없음', 'WHEN 결제하면 the system SHALL 거부한다'],
  ])('%s → 없음', (_, statement) => {
    expect(whenCondition(statement)).toBeNull();
  });
});

describe('카드', () => {
  it('1줄 제목 · 생성 주체, 2줄 표시 ID · WHEN 조건, 시각은 두지 않는다', () => {
    expect(ruleCard(PASS)).toEqual({
      title: '중복 이메일 가입 거부',
      id: 'RULE-001',
      note: 'WHEN 이미 가입된 이메일로 가입을 요청하면',
      statuses: [{ kind: 'judgment', status: 'pass' }],
      exceptions: [],
      author: 'agent',
    });
    expect(ruleCard(PASS)).not.toHaveProperty('dateTime');
  });

  it('WHEN 조건이 없는 진술은 2줄에 조건을 두지 않는다', () => {
    expect(ruleCard(FRESH)).not.toHaveProperty('note');
    expect(ruleCard(FRESH).author).toBe('human');
  });

  it('예외: 판정 상태(통과 외)는 상태 배지 규칙대로 2줄 예외, 그다음 미확인. 확인됨은 예외 없음 (옛 잠정 자리)', () => {
    const marks = (item: RuleWithJudgment) => {
      const card = ruleCard(item);
      return [...card.statuses.flatMap(statusExceptions), ...card.exceptions].map((m) => m.label);
    };
    expect(marks(PASS)).toEqual([]);
    expect(marks(FAIL)).toEqual(['실패']);
    expect(marks(FRESH)).toEqual(['미판정']);
    expect(marks(QUARANTINED)).toEqual(['격리']);
    expect(marks(judged(PASS.rule, 'needs_recheck'))).toEqual(['재검증 필요']);
    expect(marks(UNCONFIRMED)).toEqual(['미확인']);
    expect(marks(judged(UNCONFIRMED.rule, 'fail'))).toEqual(['실패', '미확인']);
    expect(ruleCard(UNCONFIRMED).exceptions).toEqual([
      { key: 'unconfirmed', label: '미확인', tone: 'info' },
    ]);
    // 잠정 표시는 없어졌다 (ADR-100 명세 변경 목록 SCR-03)
    expect(marks(PROVISIONAL)).toEqual(['미판정']);
  });

  it('부모 없는 규칙 (M3-11, ADR-137): 서버 목록에 든 규칙만 판정 예외 다음 "추적성 결함"(위험 색), 모르면 없다', () => {
    const defects = ruleDefectsOf({
      parentlessRules: [
        { id: PASS.rule.id, displayId: PASS.rule.displayId },
        { id: UNCONFIRMED.rule.id, displayId: UNCONFIRMED.rule.displayId },
      ],
    });
    expect(ruleCard(PASS, defects).exceptions).toEqual([
      { key: 'traceability', label: '추적성 결함', tone: 'danger' },
    ]);
    const unconfirmedFailed = judged(UNCONFIRMED.rule, 'fail');
    const card = ruleCard(unconfirmedFailed, defects);
    expect(
      [...card.statuses.flatMap(statusExceptions), ...card.exceptions].map((m) => m.label),
    ).toEqual(['실패', '추적성 결함', '미확인']);
    expect(ruleCard(FAIL, defects).exceptions).toEqual([]);
    expect(ruleCard(PASS, null).exceptions).toEqual([]);
    expect(ruleCard(PASS, ruleDefectsOf(null)).exceptions).toEqual([]);
    expect(ruleCard(PASS).exceptions).toEqual([]);
  });

  it('폐기된 규칙: 폐기 전 판정 예외 없이 폐기 · 미확인 (폐기 뒤 판정하지 않음, ADR-112)', () => {
    const card = ruleCard(RETIRED);
    expect(card.statuses).toEqual([]);
    expect(card.exceptions).toEqual([
      { key: 'retired', label: '폐기', tone: 'warning' },
      { key: 'unconfirmed', label: '미확인', tone: 'info' },
    ]);
    const confirmedRetired = { ...RETIRED, rule: { ...RETIRED.rule, confirmation: CONFIRMED } };
    expect(ruleCard(confirmedRetired).exceptions.map((m) => m.label)).toEqual(['폐기']);
    expect(isRetiredRule(RETIRED)).toBe(true);
    expect(isRetiredRule(PASS)).toBe(false);
    // 기본 목록에서 숨기는 기준 = 폐기 사실, 토글 이름은 [폐기 포함]
    expect(RETIRED_HIDDEN.label).toBe('폐기 포함');
    expect([PASS, RETIRED, UNCONFIRMED].filter(RETIRED_HIDDEN.isHidden)).toEqual([RETIRED]);
  });

  it('제목 · WHEN 조건 · 검색 대상은 숨은 글자를 보이는 표기로 (방향 제어 글자가 글 순서를 바꾸지 않게)', () => {
    const tricky = judged(
      rule({
        id: '01JA000000000000000000000A',
        displayId: 'RULE-010',
        title: '가입 \u202e거부\u202c',
        statement: 'WHEN 가입을\u200b 요청하면 THE SYSTEM SHALL 거부한다',
      }),
      'pass',
    );
    const card = ruleCard(tricky);
    expect(card.title).toBe('가입 \\u202e거부\\u202c');
    expect(card.note).toBe('WHEN 가입을\\u200b 요청하면');
    expect(ruleSearchText(tricky)).toBe(
      '가입 \\u202e거부\\u202c RULE-010 WHEN 가입을\\u200b 요청하면',
    );
  });

  it('검색 대상은 카드에 보이는 제목 · 표시 ID · WHEN 조건', () => {
    expect(ruleSearchText(PASS)).toBe(
      '중복 이메일 가입 거부 RULE-001 WHEN 이미 가입된 이메일로 가입을 요청하면',
    );
    expect(ruleSearchText(FRESH)).toBe('중복 이메일 가입 거부 RULE-003 ');
  });

  it('삭제된 규칙은 목록에 보이지 않는다', () => {
    const deleted = unjudged(
      rule({ id: '01JA0000000000000000000006', displayId: 'RULE-006', deletedAt: T0 }),
    );
    expect(visibleRules([PASS, deleted, FAIL]).map(({ rule: r }) => r.displayId)).toEqual([
      'RULE-001',
      'RULE-002',
    ]);
  });
});

describe('준수 집계 묶음', () => {
  it('최신 판정 격리 → 격리, 나머지 효력 규칙 → 판정 가능(분모), 폐기 · 효력 상태 아님은 어디에도 없음', () => {
    expect(complianceGroup(PASS)).toBe('judgeable');
    expect(complianceGroup(FAIL)).toBe('judgeable');
    expect(complianceGroup(FRESH)).toBe('judgeable');
    expect(complianceGroup(QUARANTINED)).toBe('quarantined');
    expect(complianceGroup(PROVISIONAL)).toBeNull();
    expect(complianceGroup(RETIRED)).toBeNull();
  });

  it('사람 확인 = 판정 가능 가운데 확인됨 (판정 가능과 함께 가진다, ADR-100 D7)', () => {
    expect(complianceValues(PASS)).toEqual(['judgeable', 'human_confirmed']);
    expect(complianceValues(UNCONFIRMED)).toEqual(['judgeable']);
    // 격리는 사람 확인 기준 분모에도 들지 않는다
    expect(complianceValues(QUARANTINED)).toEqual(['quarantined']);
    expect(complianceValues(RETIRED)).toEqual([]);
    expect(
      complianceValues({ ...RETIRED, rule: { ...RETIRED.rule, confirmation: CONFIRMED } }),
    ).toEqual([]);
  });
});

describe('필터 기준', () => {
  const items = [PASS, FAIL, FRESH, PROVISIONAL, QUARANTINED, UNCONFIRMED, RETIRED];
  const entries: ListEntry<RuleWithJudgment>[] = items.map((item, index) => ({
    item,
    key: item.rule.id,
    searchText: item.rule.title,
    problem: false,
    time: null,
    index,
  }));
  const RULE_CRITERIA = ruleCriteria(items);
  const counts = countOptions(entries, RULE_CRITERIA, EMPTY_FILTER);
  const labels = (id: string) =>
    RULE_CRITERIA.find((c) => c.id === id)?.options.map((o) => o.label);

  it('7종: 판정 · 변이 · 준수 집계 · 확인 · 블록 · 위험도 · 종류 순서', () => {
    expect(RULE_CRITERIA.map((c) => c.label)).toEqual([
      '판정',
      '변이',
      '준수 집계',
      '확인',
      '블록',
      '위험도',
      '종류',
    ]);
  });

  it('판정: 5종, 개수는 최신 판정에서 (폐기된 규칙은 세지 않는다)', () => {
    expect(labels('judgment')).toEqual(['통과', '실패', '미판정', '격리', '재검증 필요']);
    expect(counts['judgment']).toEqual({
      pass: 2,
      fail: 1,
      unjudged: 2,
      quarantined: 1,
      needs_recheck: 0,
    });
  });

  it('변이: 값이 없어 전부 0건 (칩 비활성, ADR-035). 블록 · 위험도도 값이 없는 옛 규칙뿐이면 0건', () => {
    expect(labels('mutation')).toEqual(['변이 검증됨', '변이 미검증', '변이 생존']);
    expect(counts['mutation']).toEqual({ verified: 0, unverified: 0, survived: 0 });
    expect(labels('block')).toEqual([]);
    expect(counts['block']).toEqual({});
    expect(labels('risk')).toEqual(['낮음', '보통', '높음']);
    expect(counts['risk']).toEqual({ low: 0, medium: 0, high: 0 });
  });

  describe('블록 · 위험도 (ADR-126)', () => {
    const withBlocks = (n: number, targetBlockIds: string[], risk: Rule['risk']) =>
      unjudged(
        rule({
          id: `01JA00000000000000000001${String(n).padStart(2, '0')}`,
          displayId: `RULE-1${String(n).padStart(2, '0')}`,
          targetBlockIds,
          risk,
        }),
      );
    const A = withBlocks(1, ['lib', 'auth'], 'high');
    const B = withBlocks(2, ['auth'], 'low');
    const C = withBlocks(3, [], null);
    const D = withBlocks(4, ['zz-legacy'], 'high');
    const list = [A, B, C, D];
    const all: ListEntry<RuleWithJudgment>[] = list.map((item, index) => ({
      item,
      key: item.rule.id,
      searchText: item.rule.displayId,
      problem: false,
      time: null,
      index,
    }));
    const criteria = ruleCriteria(list);

    it('블록 값은 받은 규칙의 이름 전부(중복 없이 이름 순), 블록마다 한 번씩 센다', () => {
      expect(criteria.find((c) => c.id === 'block')?.options).toEqual([
        { value: 'auth', label: 'auth' },
        { value: 'lib', label: 'lib' },
        { value: 'zz-legacy', label: 'zz-legacy' },
      ]);
      expect(countOptions(all, criteria, EMPTY_FILTER)['block']).toEqual({
        auth: 2,
        lib: 1,
        'zz-legacy': 1,
      });
    });

    it('위험도는 규칙의 값을 센다 (null은 값 없음)', () => {
      expect(countOptions(all, criteria, EMPTY_FILTER)['risk']).toEqual({
        low: 1,
        medium: 0,
        high: 2,
      });
    });

    it('여러 블록을 고르면 하나라도 가진 규칙이 남는다 (기준 안 OR), 위험도와는 AND', () => {
      const keys = (selected: Record<string, string[]>) =>
        filterEntries(all, criteria, { ...EMPTY_FILTER, selected }).map(
          (e) => e.item.rule.displayId,
        );
      expect(keys({ block: ['lib'] })).toEqual(['RULE-101']);
      expect(keys({ block: ['lib', 'zz-legacy'] })).toEqual(['RULE-101', 'RULE-104']);
      expect(keys({ block: ['auth'], risk: ['low'] })).toEqual(['RULE-102']);
      // 블록이 없는 옛 규칙은 어느 블록 값에도 걸리지 않는다
      expect(keys({ block: ['auth', 'lib', 'zz-legacy'] })).not.toContain('RULE-103');
    });

    it('위험도 표시: 표시명, null은 "없음"', () => {
      expect(riskText('low')).toBe('낮음');
      expect(riskText('medium')).toBe('보통');
      expect(riskText('high')).toBe('높음');
      expect(riskText(null)).toBe('없음');
    });
  });

  it('준수 집계: 판정 가능 · 사람 확인 · 격리 (폐기 · 효력 상태 아님은 세지 않는다)', () => {
    expect(labels('compliance')).toEqual(['판정 가능', '사람 확인', '격리']);
    // 판정 가능 = PASS · FAIL · FRESH · UNCONFIRMED, 사람 확인 = 그 가운데 확인됨인 PASS · FAIL · FRESH
    expect(counts['compliance']).toEqual({ judgeable: 4, human_confirmed: 3, quarantined: 1 });
  });

  it('확인: 미확인 · 확인됨, 개수는 확인 상태에서 (폐기된 규칙도 보이는 카드라 센다)', () => {
    expect(labels('confirmation')).toEqual(['미확인', '확인됨']);
    expect(counts['confirmation']).toEqual({ unconfirmed: 2, confirmed: 5 });
    expect(CONFIRMATION_LABELS).toEqual(CONFIRMATION_STATE_LABELS);
  });

  it('종류: 아키텍처 · 기술 제약 · 비즈니스', () => {
    expect(labels('kind')).toEqual(['아키텍처', '기술 제약', '비즈니스']);
    expect(counts['kind']).toEqual({ architecture: 1, 'tech-constraint': 1, business: 5 });
  });

  it('종류 · 위험도 표시명이 shared와 같다', () => {
    expect(RULE_KIND_LABELS).toEqual(SHARED_RULE_KIND_LABELS);
    expect(RISK_LABELS).toEqual(SHARED_RISK_LABELS);
  });
});
