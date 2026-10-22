// 규칙 화면 표시 규칙 (이슈 #24, screens.md SCR-03 카드 · 필터 · 1.4, ADR-060).
import {
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
  type ListEntry,
} from '../src/renderer/src/components/ListView/filter.js';
import { statusExceptions } from '../src/renderer/src/components/StatusBadge/status.js';
import {
  complianceGroup,
  RISK_LABELS,
  RULE_CRITERIA,
  RULE_KIND_LABELS,
  ruleCard,
  ruleSearchText,
  visibleRules,
  whenCondition,
} from '../src/renderer/src/screens/rules/rulesView.js';

const T0 = '2026-10-16T01:00:00.000Z';

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
  ])('%s', (_, statement, expected) => {
    expect(whenCondition(statement)).toBe(expected);
  });

  it.each([
    ['WHEN 없음 (항상 지키는 규칙)', 'THE SYSTEM SHALL 모든 응답을 UTF-8로 보낸다'],
    ['WHEN 뒤에 SHALL 없음', 'WHEN 결제하면 거부한다'],
    ['SHALL 뒤에만 WHEN', 'THE SYSTEM SHALL 요청 시각을 기록한다 when possible'],
    ['조건이 비었음', 'WHEN THE SYSTEM SHALL 거부한다'],
    ['단어 안의 when은 키워드가 아님', 'Whenever THE SYSTEM SHALL 거부한다'],
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

  it('예외: 판정 상태(통과 외)는 상태 배지 규칙대로 2줄 예외, 잠정 승인은 "잠정"', () => {
    const marks = (item: RuleWithJudgment) => {
      const card = ruleCard(item);
      return [...card.statuses.flatMap(statusExceptions), ...card.exceptions].map((m) => m.label);
    };
    expect(marks(PASS)).toEqual([]);
    expect(marks(FAIL)).toEqual(['실패']);
    expect(marks(FRESH)).toEqual(['미판정']);
    expect(marks(QUARANTINED)).toEqual(['격리']);
    expect(marks(judged(PASS.rule, 'needs_recheck'))).toEqual(['재검증 필요']);
    expect(marks(PROVISIONAL)).toEqual(['미판정', '잠정']);
    expect(ruleCard(PROVISIONAL).exceptions).toEqual([
      { key: 'provisional', label: '잠정', tone: 'info' },
    ]);
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
  it('잠정 승인 → 잠정, 최신 판정 격리 → 격리, 나머지 승인 규칙 → 판정 가능(분모)', () => {
    expect(complianceGroup(PASS)).toBe('judgeable');
    expect(complianceGroup(FAIL)).toBe('judgeable');
    expect(complianceGroup(FRESH)).toBe('judgeable');
    expect(complianceGroup(QUARANTINED)).toBe('quarantined');
    expect(complianceGroup(PROVISIONAL)).toBe('provisional');
    expect(complianceGroup(judged(PROVISIONAL.rule, 'quarantined'))).toBe('provisional');
  });
});

describe('필터 기준', () => {
  const items = [PASS, FAIL, FRESH, PROVISIONAL, QUARANTINED];
  const entries: ListEntry<RuleWithJudgment>[] = items.map((item, index) => ({
    item,
    key: item.rule.id,
    searchText: item.rule.title,
    problem: false,
    time: null,
    index,
  }));
  const counts = countOptions(entries, RULE_CRITERIA, EMPTY_FILTER);
  const labels = (id: string) =>
    RULE_CRITERIA.find((c) => c.id === id)?.options.map((o) => o.label);

  it('6종: 판정 · 변이 · 준수 집계 · 블록 · 위험도 · 종류 순서', () => {
    expect(RULE_CRITERIA.map((c) => c.label)).toEqual([
      '판정',
      '변이',
      '준수 집계',
      '블록',
      '위험도',
      '종류',
    ]);
  });

  it('판정: 5종, 개수는 최신 판정에서', () => {
    expect(labels('judgment')).toEqual(['통과', '실패', '미판정', '격리', '재검증 필요']);
    expect(counts['judgment']).toEqual({
      pass: 1,
      fail: 1,
      unjudged: 2,
      quarantined: 1,
      needs_recheck: 0,
    });
  });

  it('변이 · 블록 · 위험도: 값이 없어 전부 0건 (칩 비활성, ADR-035)', () => {
    expect(labels('mutation')).toEqual(['변이 검증됨', '변이 미검증', '변이 생존']);
    expect(counts['mutation']).toEqual({ verified: 0, unverified: 0, survived: 0 });
    expect(labels('block')).toEqual([]);
    expect(counts['block']).toEqual({});
    expect(labels('risk')).toEqual(['낮음', '보통', '높음']);
    expect(counts['risk']).toEqual({ low: 0, medium: 0, high: 0 });
  });

  it('위험도는 규칙에 값이 생기면 그대로 센다', () => {
    const risky = unjudged(
      rule({ id: '01JA0000000000000000000007', displayId: 'RULE-007', risk: 'high' }),
    );
    const one: ListEntry<RuleWithJudgment>[] = [
      { item: risky, key: risky.rule.id, searchText: '', problem: false, time: null, index: 0 },
    ];
    expect(countOptions(one, RULE_CRITERIA, EMPTY_FILTER)['risk']).toEqual({
      low: 0,
      medium: 0,
      high: 1,
    });
  });

  it('준수 집계: 판정 가능 · 잠정 · 격리', () => {
    expect(labels('compliance')).toEqual(['판정 가능', '잠정', '격리']);
    expect(counts['compliance']).toEqual({ judgeable: 3, provisional: 1, quarantined: 1 });
  });

  it('종류: 아키텍처 · 기술 제약 · 비즈니스', () => {
    expect(labels('kind')).toEqual(['아키텍처', '기술 제약', '비즈니스']);
    expect(counts['kind']).toEqual({ architecture: 1, 'tech-constraint': 1, business: 3 });
  });

  it('종류 · 위험도 표시명이 shared와 같다', () => {
    expect(RULE_KIND_LABELS).toEqual(SHARED_RULE_KIND_LABELS);
    expect(RISK_LABELS).toEqual(SHARED_RISK_LABELS);
  });
});
