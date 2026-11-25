// 계약 화면 표시 규칙 (이슈 #50, screens.md SCR-04 표시 · 결함 · 필터 · 1.4, ADR-100 I3, ADR-133).
import {
  ContractKind,
  type Contract,
  type JudgmentStatus,
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
  CONTRACT_CRITERIA,
  CONTRACT_KIND_LABELS,
  type ContractItem,
  contractCard,
  contractDefects,
  contractItems,
  contractKindLabel,
  contractSearchText,
  judgmentText,
  UNKNOWN_KIND_LABEL,
} from '../src/renderer/src/screens/contracts/contractsView.js';

const T0 = '2026-11-20T01:00:00.000Z';

const contract = (patch: Partial<Contract> = {}): Contract => ({
  id: '01JF0000000000000000000001',
  displayId: 'CON-001',
  kind: 'openapi',
  sourceFile: 'api/openapi.yaml',
  contentHash: 'a'.repeat(64),
  sourceCommit: 'b'.repeat(40),
  parentRequirementId: null,
  author: { kind: 'human' },
  createdAt: T0,
  confirmation: {
    state: 'confirmed',
    at: T0,
    by: { kind: 'human' },
    basis: { kind: 'contract_record', at: T0 },
  },
  ...patch,
});

const RULE_REF = { id: '01JC0000000000000000000009', displayId: 'RULE-009' } as const;

const ruleItem = (status: JudgmentStatus): RuleWithJudgment =>
  ({
    rule: { id: RULE_REF.id, displayId: RULE_REF.displayId } as Rule,
    judgment: { status, latest: null },
  }) as RuleWithJudgment;

const item = (patch: Partial<ContractItem> = {}): ContractItem => ({
  contract: contract(),
  rule: RULE_REF,
  judgment: 'unjudged',
  ...patch,
});

const entries = (items: readonly ContractItem[]): ListEntry<ContractItem>[] =>
  items.map((it, index) => {
    const card = contractCard(it);
    return {
      item: it,
      key: it.contract.id,
      searchText: contractSearchText(it),
      problem: card.exceptions.length > 0,
      time: null,
      index,
    };
  });

const criterion = (id: string) => {
  const found = CONTRACT_CRITERIA.find((c) => c.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};

describe('계약 항목 합치기', () => {
  it('검사 규칙의 최신 판정을 규칙 ID로 찾고, 규칙이 없거나 rule.list에 없으면 판정은 null', () => {
    const items = contractItems(
      [
        { contract: contract(), rule: RULE_REF, source: { status: 'same' } },
        {
          contract: contract({ id: '01JF0000000000000000000002', displayId: 'CON-002' }),
          rule: null,
          source: { status: 'same' },
        },
        {
          contract: contract({ id: '01JF0000000000000000000003', displayId: 'CON-003' }),
          rule: { id: '01JC0000000000000000000010', displayId: 'RULE-010' },
          source: { status: 'missing' },
        },
      ],
      [ruleItem('fail')],
    );
    expect(items.map((it) => [it.contract.displayId, it.judgment])).toEqual([
      ['CON-001', 'fail'],
      ['CON-002', null],
      ['CON-003', null],
    ]);
  });
});

describe('결함 · 카드 예외', () => {
  it('스키마 불일치 = 검사 규칙의 최신 판정이 실패', () => {
    expect(contractDefects(item({ judgment: 'fail' }))).toEqual(['schema_mismatch']);
    for (const status of ['pass', 'unjudged', 'quarantined', 'needs_recheck'] as const) {
      expect(contractDefects(item({ judgment: status }))).toEqual([]);
    }
  });

  it('검사 규칙 없음 = rule이 null (판정과 무관)', () => {
    expect(contractDefects(item({ rule: null, judgment: null }))).toEqual(['no_rule']);
    // 판정을 모르는 것(null)만으로는 결함이 아니다
    expect(contractDefects(item({ judgment: null }))).toEqual([]);
  });

  it('카드: 1줄 원본 파일(숨은 글자 표기), 2줄 표시 ID · 결함 · 미확인 순 · 등록 시각, 생성 주체', () => {
    const card = contractCard(
      item({
        contract: contract({
          sourceFile: 'api/‮open.yaml',
          author: { kind: 'agent', role: 'rule-writer' },
          confirmation: { state: 'unconfirmed' },
        }),
        judgment: 'fail',
      }),
    );
    expect(card.title).toBe('api/\\u202eopen.yaml');
    expect(card.id).toBe('CON-001');
    expect(card.exceptions.map((e) => [e.label, e.tone])).toEqual([
      ['스키마 불일치', 'danger'],
      ['미확인', 'info'],
    ]);
    expect(card.statuses).toEqual([]);
    expect(card.dateTime).toBe(T0);
    expect(card.author).toBe('agent');
    const noRule = contractCard(item({ rule: null, judgment: null }));
    expect(noRule.exceptions.map((e) => [e.label, e.tone])).toEqual([['검사 규칙 없음', 'danger']]);
  });

  it('미확인만 있어도 예외(문제 항목), 확인됨 · 통과는 예외 없이 흐린 점, 미판정은 카드에 표시 없음', () => {
    expect(
      contractCard(item({ contract: contract({ confirmation: { state: 'unconfirmed' } }) }))
        .exceptions,
    ).toEqual([{ key: 'unconfirmed', label: '미확인', tone: 'info' }]);
    const pass = contractCard(item({ judgment: 'pass' }));
    expect(pass.exceptions).toEqual([]);
    expect(pass.statuses).toEqual([{ kind: 'judgment', status: 'pass' }]);
    const unjudged = contractCard(item());
    expect(unjudged.exceptions).toEqual([]);
    expect(unjudged.statuses).toEqual([]);
  });

  it('검색 대상은 표시 원본 파일 · 표시 ID', () => {
    expect(contractSearchText(item())).toBe('api/openapi.yaml CON-001');
  });
});

describe('종류 표시명', () => {
  it('shared ContractKind 여섯 값을 모두 화면 정의서 낱말로', () => {
    expect(Object.keys(CONTRACT_KIND_LABELS).sort()).toEqual([...ContractKind.options].sort());
    expect(ContractKind.options.map((kind) => contractKindLabel(kind))).toEqual([
      'API',
      'DB',
      '이벤트',
      '외부 API',
      '캐시',
      'JSON 스키마',
    ]);
  });

  it('모르는 값은 "알 수 없는 종류"이고 종류 칩 값이 없다', () => {
    expect(contractKindLabel('graphql')).toBe(UNKNOWN_KIND_LABEL);
    expect(contractKindLabel('toString')).toBe(UNKNOWN_KIND_LABEL);
    const odd = item({ contract: { ...contract(), kind: 'graphql' as Contract['kind'] } });
    expect(criterion('kind').values(odd)).toEqual([]);
  });

  it('판정 표시: 상태 표시명, 모르면 "없음"', () => {
    expect(judgmentText('unjudged')).toBe('미판정');
    expect(judgmentText('fail')).toBe('실패');
    expect(judgmentText(null)).toBe('없음');
  });
});

describe('필터 칩 (종류 · 검사 규칙 · 판정 · 확인)', () => {
  const items: ContractItem[] = [
    item({ judgment: 'pass' }),
    item({
      contract: contract({
        id: '01JF0000000000000000000002',
        displayId: 'CON-002',
        kind: 'db-schema',
        confirmation: { state: 'unconfirmed' },
      }),
      judgment: 'fail',
    }),
    item({
      contract: contract({
        id: '01JF0000000000000000000003',
        displayId: 'CON-003',
        kind: 'asyncapi',
      }),
      rule: null,
      judgment: null,
    }),
  ];
  const list = entries(items);

  it('칩 순서와 이름', () => {
    expect(CONTRACT_CRITERIA.map((c) => [c.id, c.label])).toEqual([
      ['kind', '종류'],
      ['rule', '검사 규칙'],
      ['judgment', '판정'],
      ['confirmation', '확인'],
    ]);
    expect(criterion('rule').options.map((o) => o.label)).toEqual(['있음', '없음']);
    expect(criterion('confirmation').options.map((o) => o.label)).toEqual(['미확인', '확인됨']);
  });

  it('값별 개수는 목록 항목에서만 센다', () => {
    const counts = countOptions(list, CONTRACT_CRITERIA, EMPTY_FILTER);
    expect(counts.kind).toEqual({
      openapi: 1,
      'db-schema': 1,
      asyncapi: 1,
      'external-api': 0,
      cache: 0,
      'json-schema': 0,
    });
    expect(counts.rule).toEqual({ linked: 2, missing: 1 });
    expect(counts.judgment).toEqual({
      pass: 1,
      fail: 1,
      unjudged: 0,
      quarantined: 0,
      needs_recheck: 0,
    });
    expect(counts.confirmation).toEqual({ unconfirmed: 1, confirmed: 2 });
  });

  it('칩마다 고른 값의 항목만 남는다', () => {
    const pick = (id: string, values: string[]): string[] =>
      filterEntries(list, CONTRACT_CRITERIA, {
        ...EMPTY_FILTER,
        selected: { [id]: values },
      }).map((e) => e.item.contract.displayId);
    expect(pick('kind', ['db-schema'])).toEqual(['CON-002']);
    expect(pick('rule', ['missing'])).toEqual(['CON-003']);
    expect(pick('rule', ['linked'])).toEqual(['CON-001', 'CON-002']);
    expect(pick('judgment', ['fail'])).toEqual(['CON-002']);
    expect(pick('confirmation', ['unconfirmed'])).toEqual(['CON-002']);
    expect(pick('confirmation', ['confirmed'])).toEqual(['CON-001', 'CON-003']);
  });
});
