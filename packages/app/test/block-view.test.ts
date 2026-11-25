// 대상 블록 · 구현 위치의 표시 규칙 (이슈 #64 M3-19, NRM-09, screens.md SCR-02 상세 · SCR-03 표시, ADR-126).
import {
  BlocksResult,
  type Rule,
  RuleWithJudgment,
  type RuleWithJudgment as RuleWithJudgmentType,
} from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  BLOCK_NOTE_TEXT,
  BLOCK_TEXT,
  blockListView,
  blockOptions,
  declaredBlockNames,
  implementationBlocks,
  implementationBlocksByRequirement,
  isEffectiveRuleItem,
} from '../src/renderer/src/screens/rules/blockView.js';

const T0 = '2026-11-25T01:00:00.000Z';
const REQ_A = '01JA00000000000000000000A1';
const REQ_B = '01JA00000000000000000000B1';

const item = (n: number, patch: Partial<Rule>, retired = false): RuleWithJudgmentType => {
  const id = `01JC00000000000000000000${String(n).padStart(2, '0')}`;
  return RuleWithJudgment.parse({
    rule: {
      id,
      displayId: `RULE-${String(n).padStart(3, '0')}`,
      title: '제목',
      statement: 'THE SYSTEM SHALL 동작한다',
      kind: 'business',
      checkKinds: ['test'],
      parentRequirementId: REQ_A,
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
      confirmation: { state: 'unconfirmed' },
      ...patch,
    },
    judgment: { status: 'unjudged', latest: null },
    ...(retired && { retirement: { retiredAt: T0, supersededBy: null, normChangeSeq: 3 } }),
  });
};

const declaration = (names: string[]) =>
  BlocksResult.parse({
    current: {
      version: 2,
      setAt: T0,
      setBy: { kind: 'human' },
      declaration: {
        blocks: names.map((name, index) => ({
          name,
          kind: 'domain',
          include: [`src/${name}/**`],
          public: [],
          dependsOn: [],
          risk: index === 0 ? 'high' : 'low',
        })),
      },
    },
  });

describe('지금 블록 선언 이름', () => {
  it('선언 순서 그대로, 선언이 없으면 null', () => {
    expect(declaredBlockNames(declaration(['health', 'auth', 'lib']))).toEqual([
      'health',
      'auth',
      'lib',
    ]);
    expect(declaredBlockNames(BlocksResult.parse({ current: null }))).toBeNull();
  });
});

describe('대상 블록 목록 (규칙 상세)', () => {
  const ready = { state: 'ready', names: ['auth', 'lib'] } as const;

  it('이름은 받은 순서 그대로, 선언에 없는 이름만 "선언 외"', () => {
    expect(blockListView(['lib', 'gone', 'auth'], ready)).toEqual({
      rows: [
        { name: 'lib', undeclared: false },
        { name: 'gone', undeclared: true },
        { name: 'auth', undeclared: false },
      ],
      note: null,
    });
  });

  it('선언이 없는 프로젝트: 이름마다 붙이지 않고 "블록 선언 없음" 한 번', () => {
    expect(blockListView(['auth', 'x'], { state: 'ready', names: null })).toEqual({
      rows: [
        { name: 'auth', undeclared: false },
        { name: 'x', undeclared: false },
      ],
      note: 'noDeclaration',
    });
  });

  it('선언을 읽는 중이면 이름만, 읽지 못하면 이름과 "블록 선언 불러오기 실패"', () => {
    expect(blockListView(['auth'], { state: 'loading' })).toEqual({
      rows: [{ name: 'auth', undeclared: false }],
      note: null,
    });
    expect(blockListView(['auth'], { state: 'error' })).toEqual({
      rows: [{ name: 'auth', undeclared: false }],
      note: 'declarationFailed',
    });
  });

  it('이름이 없으면(옛 규칙 · 내장 규칙) 줄 · 알림 없음 = 화면은 "없음"', () => {
    for (const load of [
      ready,
      { state: 'ready', names: null } as const,
      { state: 'error' } as const,
    ]) {
      expect(blockListView([], load)).toEqual({ rows: [], note: null });
    }
    expect(BLOCK_TEXT.none).toBe('없음');
  });

  it('화면 문구', () => {
    expect(BLOCK_TEXT).toMatchObject({
      blocks: '대상 블록',
      risk: '위험도',
      implementation: '구현 위치',
      undeclared: '선언 외',
    });
    expect(BLOCK_NOTE_TEXT).toEqual({
      noDeclaration: '블록 선언 없음',
      declarationFailed: '블록 선언 불러오기 실패',
    });
  });
});

describe('구현 위치 (요구사항 상세)', () => {
  const A = item(1, { targetBlockIds: ['lib', 'auth'] });
  const B = item(2, { targetBlockIds: ['auth', 'zz-old', 'health'] });
  const RETIRED = item(3, { targetBlockIds: ['retired-only'] }, true);
  const PROVISIONAL = item(4, { targetBlockIds: ['provisional-only'], normState: 'provisional' });
  const DELETED = item(5, { targetBlockIds: ['deleted-only'], deletedAt: T0 });
  const OLD = item(6, {});

  it('효력 있는 자식 규칙의 블록만, 중복 없이 선언 순서 · 선언에 없는 이름은 뒤에 이름 순', () => {
    expect(
      implementationBlocks([A, B, RETIRED, PROVISIONAL, DELETED, OLD], ['health', 'auth', 'lib']),
    ).toEqual(['health', 'auth', 'lib', 'zz-old']);
  });

  it('선언이 없거나 모르면 이름 순', () => {
    expect(implementationBlocks([B, A], null)).toEqual(['auth', 'health', 'lib', 'zz-old']);
  });

  it('자식 규칙이 없거나 블록이 하나도 없으면 빈 목록', () => {
    expect(implementationBlocks([], ['auth'])).toEqual([]);
    expect(implementationBlocks([OLD, RETIRED], ['auth'])).toEqual([]);
  });

  it('효력: 삭제 · 폐기되지 않고 효력 상태인 규칙만', () => {
    expect([A, RETIRED, PROVISIONAL, DELETED].map(isEffectiveRuleItem)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it('요구사항별 구현 위치 표 (목록의 블록 칩): 부모별로 모으고, 없는 요구사항은 표에 없다', () => {
    const OTHER = item(7, { targetBlockIds: ['billing'], parentRequirementId: REQ_B });
    const DETACHED = item(8, {
      targetBlockIds: ['detached'],
      parentRequirementId: null,
      parentDetachedAt: T0,
    });
    const table = implementationBlocksByRequirement([A, B, RETIRED, OTHER, DETACHED]);
    expect([...table.entries()]).toEqual([
      [REQ_A, ['auth', 'health', 'lib', 'zz-old']],
      [REQ_B, ['billing']],
    ]);
    expect(implementationBlocksByRequirement([OLD, RETIRED]).size).toBe(0);
  });
});

describe('블록 칩 값', () => {
  it('이름 전부를 중복 없이 이름 순, 표시명 = 이름', () => {
    expect(blockOptions(['lib', 'auth', 'lib', 'a-1'])).toEqual([
      { value: 'a-1', label: 'a-1' },
      { value: 'auth', label: 'auth' },
      { value: 'lib', label: 'lib' },
    ]);
    expect(blockOptions([])).toEqual([]);
  });
});
