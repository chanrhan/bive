// 규칙 폐기 · 대체 (M7-09 #221 수용 기준 1 · 2 · 3, NRM-02 · NRM-06 · NRM-07 · JDG-05, ADR-100 D5 · D6 · B⑨ · A6, ADR-112).
// 실제 SQLite 저장소(임시 BIVE_HOME)에 반영 모듈(`norms/agent-rule.ts`)을 직접 부르고, 도구 거부 사유는 실제 규칙 작성 서비스 ·
// ScriptedAdapter(실제 고정 도구 · 세션 가드)로 본다. 원자성은 "k번째 쓰기만 실패"시키는 시험용 트리거로 쓰기마다 본다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createUlidGenerator,
  type NormChangeEntry,
  type Requirement,
  type Rule,
} from '@bive/shared';
import { openProjectStore, type ProjectStore } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import { ScenarioSchema } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import type { PipeServer } from '../src/ipc/server.js';
import {
  type AgentRuleContradiction,
  NormJudgmentInputError,
  NormRetirementInputError,
  normalizeQuoteText,
  quoteCore,
  quotesRule,
  retireAgentRule,
  supersedeAgentRule,
} from '../src/norms/agent-rule.js';
import { effectiveRules } from '../src/norms/effective.js';
import { collectNormInput, renderNormInput } from '../src/norms/norm-input.js';
import { RuleWriterService } from '../src/rule-writer/rule-writer-service.js';
import { MIN_QUOTE_LENGTH } from '../src/tools/definitions.js';
import type { TestClient } from './helpers/client.js';
import { seedNormCases, seedNormRequirement, seedNormRule } from './helpers/engine-harness.js';
import { cleanup } from './helpers/process.js';
import { startProjectHarness } from './helpers/project-harness.js';

const newId = createUlidGenerator();
const T0 = Date.parse('2026-11-22T03:00:00.000Z');
const AGENT = { kind: 'agent', role: 'rule-writer' } as const;
const human = { kind: 'human' } as const;

const temps: string[] = [];
const stores: ProjectStore[] = [];
const servers: PipeServer[] = [];
const clients: TestClient[] = [];
const services: RuleWriterService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  for (const store of stores.splice(0)) store.close();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const openStore = (): ProjectStore => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bive-supersede-'));
  temps.push(home);
  const store = openProjectStore(newId(), { home });
  stores.push(store);
  return store;
};

/** RULE-001(서버 시각 포함)의 진술 · 최근 판정 케이스 (#209 모순 시험과 같은 내용). */
const OLD_STATEMENT =
  'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 응답 JSON의 time 필드에 응답 시점의 서버 시각을 ISO 8601 UTC 문자열로 담는다';
const OLD_CASE = '응답 JSON의 time이 응답 시점의 ISO 8601 UTC 시각이다';
/** 진술을 글자 그대로 인용한 근거 */
const GROUNDS =
  'RULE-001 진술 "time 필드에 응답 시점의 서버 시각을" 담으라는 내용은 새 요구사항(서버 시각 제거)과 동시에 만족될 수 없다';

interface Seeded {
  store: ProjectStore;
  first: Requirement;
  second: Requirement;
  old: Rule;
  other: Rule;
  builtin: Rule;
}

/** 요구사항 2개, RULE-001(대상) · RULE-002(대상 밖 효력 규칙) · RULE-003(내장 구조 규칙), RULE-001의 최근 판정. */
const seed = (): Seeded => {
  const store = openStore();
  const first = seedNormRequirement(store, '헬스 체크 응답에 서버 시각 포함', T0);
  const second = seedNormRequirement(store, '헬스 체크 응답에서 서버 시각 제거', T0 + 10);
  const old = seedNormRule(store, {
    title: '헬스 체크 응답의 서버 시각',
    statement: OLD_STATEMENT,
    parent: first,
    at: T0 + 1,
  });
  const other = seedNormRule(store, {
    title: '헬스 체크 응답 형식',
    statement:
      'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 상태 코드 200을 돌려준다',
    parent: first,
    at: T0 + 2,
  });
  const builtin = seedNormRule(store, {
    title: '공개 API로만 접근',
    statement: 'WHEN 모듈이 다른 블록을 가져오면 THE SYSTEM SHALL 그 블록의 공개 API만 쓴다',
    parent: null,
    builtin: true,
    at: T0 + 3,
  });
  seedNormCases(store, old, [OLD_CASE, '응답 JSON에 ok가 true다'], T0 + 5);
  return { store, first, second, old, other, builtin };
};

const NORM_INPUT = {
  requirements: { total: 2, included: 2, omitted: 0 },
  rules: { total: 3, included: 3, omitted: 0 },
  truncated: false,
} as const;

const NEW_RULE = {
  title: '헬스 체크 응답에서 서버 시각 제거',
  statement:
    'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 응답 JSON에 time 필드를 담지 않는다',
  kind: 'business',
  checkKinds: ['test'],
  targetBlocks: ['health'],
  risk: 'medium',
} as const;

let clockAt = T0 + 100;
const clock = () => ({
  now: () => (clockAt += 1),
  newId,
});

const supersede = (
  s: Seeded,
  overrides: Partial<{
    ruleId: string;
    grounds: string;
    contradiction: AgentRuleContradiction;
    parent: string;
  }> = {},
) =>
  supersedeAgentRule(
    s.store,
    {
      payload: { ...NEW_RULE, parentRequirementId: overrides.parent ?? s.second.id },
      rationale: "요구사항의 '서버 시각 제거'를 응답 본문의 time 필드 부재로 옮김",
      author: AGENT,
      sessionId: SESSION,
      contradiction: overrides.contradiction ?? { verdict: 'none' },
      normInput: NORM_INPUT,
      ruleId: overrides.ruleId ?? 'RULE-001',
      grounds: overrides.grounds ?? GROUNDS,
    },
    clock(),
  );

const retire = (s: Seeded, ruleId = 'RULE-001', grounds = GROUNDS) =>
  retireAgentRule(s.store, { ruleId, grounds, author: AGENT, sessionId: SESSION }, clock());

const SESSION = newId();

/** 저장소의 규범 상태 전체 (원자성 비교용). */
const snapshot = (store: ProjectStore) => ({
  rules: store.rules.list(),
  changes: store.normChanges.list(),
  retirements: store.ruleRetirements.list(),
  effective: effectiveRules(store).map((rule) => rule.displayId),
  nextRule: store.db
    .prepare<[], { last_seq: number }>(
      "SELECT last_seq FROM display_id_sequences WHERE prefix = 'RULE'",
    )
    .get(),
});

const rejection = (fn: () => unknown): { code: string; message: string } => {
  try {
    fn();
  } catch (error) {
    if (error instanceof NormRetirementInputError) {
      return { code: error.code, message: error.message };
    }
    if (error instanceof NormJudgmentInputError) {
      return { code: 'judgment', message: error.message };
    }
    throw error;
  }
  throw new Error('거부되지 않음');
};

describe('대체 · 폐기는 트랜잭션 1개 (수용 기준 1, ADR-100 D6)', () => {
  it('supersede_rule: 새 규칙 + 신규 · 판단(대체) · 대체 기록 + 폐기 기록이 한 번에 남고, 옛 규칙은 효력을 잃지만 행 · 판정 이력은 남는다', () => {
    const s = seed();
    const result = supersede(s);
    const { store } = s;
    expect(result.rule.displayId).toBe('RULE-004');
    expect(result.superseded.id).toBe(s.old.id);
    const changes = store.normChanges.list();
    expect(changes.map((entry) => [entry.seq, entry.kind, entry.targetRef.id])).toEqual([
      [1, 'created', result.rule.id],
      [2, 'judgment', result.rule.id],
      [3, 'superseded', s.old.id],
    ]);
    const [created, judgment, superseded] = changes as [
      NormChangeEntry,
      NormChangeEntry,
      NormChangeEntry,
    ];
    // 같은 시각 · 같은 주체 · 같은 세션
    for (const entry of changes) {
      expect(entry).toMatchObject({
        at: result.rule.createdAt,
        actor: AGENT,
        sessionId: SESSION,
        runId: null,
      });
    }
    expect(created.detail.after).toMatchObject({
      displayId: 'RULE-004',
      statement: NEW_RULE.statement,
    });
    expect(judgment.reason).toBe(GROUNDS);
    expect(judgment.detail.judgment).toEqual({
      subject: 'supersede',
      verdict: 'contradiction',
      contradicts: [{ id: s.old.id, displayId: 'RULE-001' }],
      createdSeq: 1,
      input: { requirements: { total: 2, included: 2 }, rules: { total: 3, included: 3 } },
    });
    expect(superseded.reason).toBe(GROUNDS);
    expect(superseded.detail).toEqual({
      before: {
        displayId: 'RULE-001',
        title: s.old.title,
        statement: OLD_STATEMENT,
        kind: 'business',
        checkKinds: ['test'],
        parentRequirementId: s.first.id,
        targetBlockIds: [],
        risk: null,
      },
      retirement: {
        supersededBy: { id: result.rule.id, displayId: 'RULE-004' },
        createdSeq: 1,
        judgmentSeq: 2,
      },
    });
    expect(store.ruleRetirements.list()).toEqual([
      {
        ruleId: s.old.id,
        retiredAt: result.rule.createdAt,
        supersededBy: result.rule.id,
        normChangeSeq: 3,
      },
    ]);
    expect(store.normChanges.verify()).toMatchObject({ valid: true });
    // 효력: 옛 규칙만 빠지고 새 규칙이 들어온다 (내장 · 대상 밖 규칙은 그대로)
    expect(effectiveRules(store).map((rule) => rule.displayId)).toEqual([
      'RULE-002',
      'RULE-003',
      'RULE-004',
    ]);
    // 폐기는 삭제가 아니다: 규칙 행 · 판정 이력은 남는다
    expect(store.rules.get(s.old.id)).toMatchObject({ deletedAt: null, normState: 'approved' });
    expect(store.judgments.listByRule(s.old.id)).toHaveLength(1);
    expect(store.rules.list().map((rule) => rule.displayId)).toEqual([
      'RULE-001',
      'RULE-002',
      'RULE-003',
      'RULE-004',
    ]);
  });

  it('supersede_rule의 contradiction이 대상 밖 규칙과도 모순이면 판단 기록의 대상에 대체된 규칙 다음으로 들어가고 사유에 그 근거가 이어진다', () => {
    const s = seed();
    const result = supersede(s, {
      contradiction: {
        verdict: 'contradicts',
        ruleIds: ['RULE-002'],
        grounds: '상태 코드와도 부딪힘',
      },
    });
    expect(result.judgment.detail.judgment?.contradicts).toEqual([
      { id: s.old.id, displayId: 'RULE-001' },
      { id: s.other.id, displayId: 'RULE-002' },
    ]);
    expect(result.judgment.reason).toBe(`${GROUNDS}\n상태 코드와도 부딪힘`);
    // 대상 밖 규칙은 그대로 효력 (모순 판단만 남는다)
    expect(effectiveRules(s.store).map((rule) => rule.displayId)).toContain('RULE-002');
  });

  it('retire_rule: 폐기 기록 `retired` 1건 + 폐기 기록, 새 규칙 · 신규 · 판단 기록은 없다', () => {
    const s = seed();
    const result = retire(s);
    expect(result.rule.id).toBe(s.old.id);
    expect(s.store.normChanges.list().map((entry) => [entry.seq, entry.kind])).toEqual([
      [1, 'retired'],
    ]);
    expect(result.normChange).toMatchObject({
      targetRef: { entity: 'Rule', id: s.old.id },
      reason: GROUNDS,
      detail: { before: { displayId: 'RULE-001' }, retirement: { supersededBy: null } },
    });
    expect(result.normChange.detail.retirement).toEqual({ supersededBy: null });
    expect(s.store.ruleRetirements.get(s.old.id)).toEqual({
      ruleId: s.old.id,
      retiredAt: result.normChange.at,
      supersededBy: null,
      normChangeSeq: 1,
    });
    expect(s.store.rules.list()).toHaveLength(3);
    expect(effectiveRules(s.store).map((rule) => rule.displayId)).toEqual(['RULE-002', 'RULE-003']);
  });

  /** 대체의 쓰기 순서: 규칙 → 신규 → 판단 → 대체 기록 → 폐기 기록. k번째만 실패시키는 트리거. */
  const SUPERSEDE_WRITES = [
    ['규칙', 'BEFORE INSERT ON rules'],
    ['신규 기록', 'BEFORE INSERT ON norm_changes WHEN (SELECT count(*) FROM norm_changes) = 0'],
    ['판단 기록', 'BEFORE INSERT ON norm_changes WHEN (SELECT count(*) FROM norm_changes) = 1'],
    ['대체 기록', 'BEFORE INSERT ON norm_changes WHEN (SELECT count(*) FROM norm_changes) = 2'],
    ['폐기 기록', 'BEFORE INSERT ON rule_retirements'],
  ] as const;

  it.each(SUPERSEDE_WRITES.map(([label, when], index) => [index + 1, label, when] as const))(
    '원자성: 대체의 %i번째 쓰기(%s)만 실패하면 아무것도 바뀌지 않아 옛 규칙만 효력이고 새 규칙 · 기록 · 순번이 남지 않는다',
    (_k, label, when) => {
      const s = seed();
      const before = snapshot(s.store);
      s.store.db.exec(
        `CREATE TRIGGER test_block ${when} BEGIN SELECT RAISE(ABORT, '시험: ${label} 실패'); END;`,
      );
      expect(() => supersede(s)).toThrow(`시험: ${label} 실패`);
      expect(snapshot(s.store)).toEqual(before);
      // 두 규칙이 함께 효력을 갖는 시점도, 옛 규칙만 폐기된 시점도 없다
      expect(before.effective).toEqual(['RULE-001', 'RULE-002', 'RULE-003']);
      s.store.db.exec('DROP TRIGGER test_block');
      // 막는 것을 치우면 같은 호출이 그대로 성공한다 (실패가 상태를 남기지 않았다)
      expect(supersede(s).rule.displayId).toBe('RULE-004');
    },
  );

  it.each([
    [1, '폐기 기록(retired)', 'BEFORE INSERT ON norm_changes'],
    [2, '폐기 기록 행', 'BEFORE INSERT ON rule_retirements'],
  ] as const)(
    '원자성: 폐기의 %i번째 쓰기(%s)만 실패하면 아무것도 바뀌지 않는다',
    (_k, label, when) => {
      const s = seed();
      const before = snapshot(s.store);
      s.store.db.exec(
        `CREATE TRIGGER test_block ${when} BEGIN SELECT RAISE(ABORT, '시험: ${label} 실패'); END;`,
      );
      expect(() => retire(s)).toThrow(`시험: ${label} 실패`);
      expect(snapshot(s.store)).toEqual(before);
    },
  );
});

describe('폐기된 규칙은 모든 역할 세션의 규범 입력에서 빠진다 (수용 기준 3, M7-07 · M7-08, ADR-112)', () => {
  it('규칙 작성 · 테스트 작성 · 구현 역할이 같이 쓰는 규범 입력(collectNormInput)에 폐기된 규칙이 없고, 초점 규칙으로 줘도 싣지 않는다', () => {
    const s = seed();
    const before = collectNormInput(s.store, { requirementIds: [], ruleIds: [s.old.id] });
    expect(before.rules.map((rule) => rule.displayId)).toEqual([
      'RULE-001',
      'RULE-002',
      'RULE-003',
    ]);
    const { rule } = supersede(s);
    for (const focus of [[], [s.old.id], [rule.id]]) {
      const input = collectNormInput(s.store, { requirementIds: [s.second.id], ruleIds: focus });
      expect(input.rules.map((item) => item.displayId)).toEqual([
        'RULE-002',
        'RULE-003',
        'RULE-004',
      ]);
      expect(input.summary.rules).toEqual({ total: 3, included: 3, omitted: 0 });
      const text = renderNormInput(input, '대상');
      expect(text).not.toContain('- RULE-001');
      expect(text).not.toContain(OLD_STATEMENT);
    }
  });
});

describe('근거 인용 검사 (수용 기준 2, ADR-100 A6 · R3)', () => {
  it('근거가 진술 · 케이스 이름을 인용하지 않으면 invalid_args로 거부되고 아무것도 남지 않는다', () => {
    const s = seed();
    const before = snapshot(s.store);
    for (const grounds of [
      '서버 시각을 빼라는 요구사항과 모순이다',
      // 다른 규칙의 진술 인용
      'RULE-002 "상태 코드 200을 돌려준다"와 부딪힌다',
    ]) {
      expect(rejection(() => supersede(s, { grounds }))).toMatchObject({
        code: 'invalid_args',
        message: expect.stringContaining('인용하지 않음') as string,
      });
      expect(rejection(() => retire(s, 'RULE-001', grounds)).code).toBe('invalid_args');
    }
    expect(snapshot(s.store)).toEqual(before);
  });

  it(`최소 길이: 공백 · EARS 틀 글자를 뺀 연속 ${String(MIN_QUOTE_LENGTH)}자는 인용, ${String(MIN_QUOTE_LENGTH - 1)}자는 인용이 아니다 (경계값, ADR-115)`, () => {
    const source = 'ISO 8601 UTC 문자열로 담는다';
    // 공백을 빼고 센다 (M7-11 #223 전에는 공백도 셌다: "ISO 8601 U"가 10자였다)
    const core = quoteCore(source);
    expect(core.join('')).toBe('ISO8601UTC문자열로담는다');
    const exact = core.slice(0, MIN_QUOTE_LENGTH).join('');
    const short = core.slice(0, MIN_QUOTE_LENGTH - 1).join('');
    expect(quotesRule(`근거: "${exact}"`, [source])).toBe(true);
    expect(quotesRule(`근거: "${short}"`, [source])).toBe(false);
    // 한두 글자 인용 · 빈 근거로는 통과하지 못한다
    expect(quotesRule('"담는"', [source])).toBe(false);
    expect(quotesRule('', [source])).toBe(false);
    // 코드 포인트 단위로 센다 (서로게이트 쌍 글자도 1자)
    const emoji = String.fromCodePoint(0x1f600);
    const wide = `${emoji.repeat(MIN_QUOTE_LENGTH)}`;
    expect(quotesRule(wide, [`앞${wide}뒤`])).toBe(true);
    expect(quotesRule(emoji.repeat(MIN_QUOTE_LENGTH - 1), [`앞${wide}뒤`])).toBe(false);
  });

  it('공백 정리: 줄바꿈 · 탭 · 연속 공백은 공백 한 칸으로 보고, 대소문자 · 다른 글자는 구분한다', () => {
    expect(normalizeQuoteText('  a\n\tb   c  ')).toBe('a b c');
    const s = seed();
    expect(
      retire(s, 'RULE-001', '진술의 "응답 시점의\n   서버   시각을" 담는 부분이 모순이다').rule.id,
    ).toBe(s.old.id);
    const t = seed();
    expect(rejection(() => retire(t, 'RULE-001', '"the system shall 응답 json의"')).code).toBe(
      'invalid_args',
    );
  });

  it('최근 판정의 인수 테스트 케이스 이름 인용도 받는다', () => {
    const s = seed();
    expect(retire(s, 'RULE-001', `케이스 "${OLD_CASE}"가 새 요구사항과 반대다`).rule.id).toBe(
      s.old.id,
    );
  });

  it('작업 지시의 표시 값(숨은 글자 표기)을 그대로 인용해도 받는다: 에이전트가 본 모양 (ADR-106 · ADR-108)', () => {
    const store = openStore();
    const req = seedNormRequirement(store, '본문', T0);
    const BEL = String.fromCodePoint(0x07);
    const rule = seedNormRule(store, {
      title: '숨은 글자 규칙',
      statement: `WHEN 요청이 오면 THE SYSTEM SHALL 응답${BEL}본문을 그대로 돌려준다`,
      parent: req,
      at: T0 + 1,
    });
    const shown = renderNormInput(
      collectNormInput(store, { requirementIds: [], ruleIds: [] }),
      '대상',
    );
    expect(shown).toContain('응답\\u0007본문을 그대로');
    const s: Seeded = { store, first: req, second: req, old: rule, other: rule, builtin: rule };
    expect(
      retire(s, rule.displayId, '진술 "응답\\u0007본문을 그대로 돌려준다"와 모순').rule.id,
    ).toBe(rule.id);
  });
});

describe('대상 검증과 내장 구조 규칙 보호 (수용 기준 2, ADR-100 B⑨)', () => {
  it('내장 구조 규칙(부모 없는 내장 종류)은 폐기 · 대체 모두 builtin_rule로 거부되고 아무것도 남지 않는다', () => {
    const s = seed();
    // 규범 자료에서 이 규칙은 "없음 (내장 구조 규칙)"으로 보인다 (ADR-106의 표기와 같은 기준)
    const shown = renderNormInput(
      collectNormInput(s.store, { requirementIds: [], ruleIds: [] }),
      '대상',
    );
    expect(shown).toContain('- RULE-003\n  제목: 공개 API로만 접근');
    expect(shown).toContain('  부모 요구사항: 없음 (내장 구조 규칙)');
    const before = snapshot(s.store);
    const grounds = '진술 "그 블록의 공개 API만 쓴다"는 더 필요 없다';
    for (const ruleId of ['RULE-003', s.builtin.id]) {
      expect(rejection(() => retire(s, ruleId, grounds))).toMatchObject({ code: 'builtin_rule' });
      expect(rejection(() => supersede(s, { ruleId, grounds }))).toMatchObject({
        code: 'builtin_rule',
      });
    }
    expect(snapshot(s.store)).toEqual(before);
    // DB도 내장 구조 규칙의 폐기 기록을 받지 않는다 (반영 모듈을 거치지 않는 쓰기의 방어)
    expect(() =>
      s.store.transaction(() => {
        const entry = s.store.normChanges.append({
          at: new Date(T0).toISOString(),
          kind: 'retired',
          actor: AGENT,
          targetRef: { entity: 'Rule', id: s.builtin.id },
          sessionId: SESSION,
          runId: null,
          reason: grounds,
          detail: { before: {}, retirement: { supersededBy: null } },
        });
        s.store.ruleRetirements.record({
          ruleId: s.builtin.id,
          retiredAt: entry.at,
          supersededBy: null,
          normChangeSeq: entry.seq,
        });
      }),
    ).toThrow(/내장 구조 규칙/);
    expect(snapshot(s.store)).toEqual(before);
  });

  it('없는 규칙 · 다른 프로젝트의 규칙 · 같은 호출이 만들 규칙 · 삭제 · 폐기 · 잠정 규칙은 invalid_args, 표시 ID와 ID 둘 다 받는다', () => {
    const s = seed();
    const elsewhere = seed();
    const provisional = seedNormRule(s.store, {
      title: '잠정 규칙',
      statement: 'WHEN 요청이 오면 THE SYSTEM SHALL 잠정 상태의 응답을 돌려준다',
      parent: s.first,
      at: T0 + 6,
      normState: 'provisional',
    });
    const grounds = (statement: string) => `진술 "${statement.slice(-20)}"과 모순`;
    const cases: [string, string, RegExp][] = [
      ['RULE-999', GROUNDS, /규칙이 없음/],
      // 다른 프로젝트 저장소의 규칙 ID
      [elsewhere.old.id, GROUNDS, /규칙이 없음/],
      // 이 호출이 만들 새 규칙의 표시 ID (대상은 만들기 전에 고른다)
      ['RULE-005', GROUNDS, /규칙이 없음/],
      [provisional.id, grounds(provisional.statement), /효력 없는 규칙\(잠정\)/],
    ];
    for (const [ruleId, text, message] of cases) {
      expect(
        rejection(() => supersede(s, { ruleId, grounds: text })),
        ruleId,
      ).toMatchObject({
        code: 'invalid_args',
        message: expect.stringMatching(message) as string,
      });
      expect(rejection(() => retire(s, ruleId, text)).code, ruleId).toBe('invalid_args');
    }
    // 삭제된 규칙 (부모 요구사항 삭제가 아닌 규칙 자체의 소프트 삭제)
    s.store.db
      .prepare('UPDATE rules SET deleted_at = ? WHERE id = ?')
      .run(new Date(T0).toISOString(), s.other.id);
    expect(rejection(() => retire(s, s.other.id, grounds(s.other.statement)))).toMatchObject({
      code: 'invalid_args',
      message: expect.stringContaining('삭제된 규칙') as string,
    });
    // 같은 호출 안 대상 · 모순 대상 중복: 대체 대상은 contradiction에 넣지 않는다
    expect(
      rejection(() =>
        supersede(s, {
          contradiction: { verdict: 'contradicts', ruleIds: ['RULE-001'], grounds: '같은 규칙' },
        }),
      ),
    ).toMatchObject({
      code: 'judgment',
      message: expect.stringContaining('넣지 않는다') as string,
    });
    // ID로 대체 → 같은 규칙을 다시 폐기 · 대체하면 이미 폐기됨
    supersede(s, { ruleId: s.old.id });
    for (const ruleId of ['RULE-001', s.old.id]) {
      expect(rejection(() => retire(s, ruleId))).toMatchObject({
        code: 'invalid_args',
        message: expect.stringContaining('이미 폐기된 규칙') as string,
      });
      expect(rejection(() => supersede(s, { ruleId })).code).toBe('invalid_args');
    }
    expect(s.store.ruleRetirements.list()).toHaveLength(1);
  });
});

describe('규칙 작성 세션의 도구 결과 (수용 기준 2, 실제 서비스 · 고정 도구)', () => {
  it('supersede_rule · retire_rule의 거부는 denied(invalid_args · builtin_rule)로 모델에 돌아가고, 고친 호출은 반영된다', async () => {
    const turns = [
      // 인용 없음
      { tool: 'retire_rule', args: { ruleId: 'RULE-001', grounds: '모순이라 폐기한다' } },
      // 내장 구조 규칙
      {
        tool: 'retire_rule',
        args: { ruleId: 'RULE-003', grounds: '진술 "그 블록의 공개 API만 쓴다"는 필요 없다' },
      },
      // 다른 요구사항을 부모로 둔 새 규칙
      {
        tool: 'supersede_rule',
        args: {
          ...NEW_RULE,
          parentRequirementId: '{{otherRequirementId}}',
          rationale: '옮김',
          contradiction: { verdict: 'none' },
          ruleId: 'RULE-001',
          grounds: GROUNDS,
        },
      },
      // 칸 빠짐 (인자 스키마)
      { tool: 'supersede_rule', args: { ruleId: 'RULE-001', grounds: GROUNDS } },
      {
        tool: 'supersede_rule',
        args: {
          ...NEW_RULE,
          parentRequirementId: '{{requirementId}}',
          rationale: '옮김',
          contradiction: { verdict: 'none' },
          ruleId: 'RULE-001',
          grounds: GROUNDS,
        },
      },
      { message: '대체했습니다.' },
    ];
    const scenario = ScenarioSchema.parse({
      name: 'supersede-tool-test',
      description: '대체 도구 시험',
      roles: {
        'rule-writer': {
          sessions: [
            {
              turns,
              result: {
                subtype: 'success',
                total_cost_usd: 0.01,
                num_turns: 1,
                modelUsage: {
                  m: {
                    inputTokens: 1,
                    outputTokens: 1,
                    cacheReadInputTokens: 0,
                    cacheCreationInputTokens: 0,
                    costUSD: 0.01,
                  },
                },
              },
            },
          ],
        },
      },
    });
    let service: RuleWriterService | null = null;
    let otherRequirementId = '';
    const h = await startProjectHarness(
      { servers, clients },
      {
        ruleWriter: ({ biveHome, now }) => {
          const adapter = new ScriptedAdapter({ scenario, biveHome, pollIntervalMs: 10 });
          service = new RuleWriterService({
            biveHome,
            adapter: {
              kind: 'scripted',
              startSession: (spec) =>
                adapter.startSession({
                  ...spec,
                  vars: { ...spec.vars, otherRequirementId },
                }),
            },
            now,
          });
          services.push(service);
          return service;
        },
      },
    );
    if (service === null) throw new Error('서비스 없음');
    const svc: RuleWriterService = service;
    // 기존 규범: RULE-001 · RULE-002 (REQ-001), 내장 RULE-003 (세션 없이 저장소에 직접)
    const seeded = h.read((store) => {
      const first = seedNormRequirement(store, '헬스 체크 응답에 서버 시각 포함', T0);
      const old = seedNormRule(store, {
        title: '서버 시각',
        statement: OLD_STATEMENT,
        parent: first,
        at: T0 + 1,
      });
      seedNormRule(store, {
        title: '응답 형식',
        statement:
          'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 상태 코드 200을 돌려준다',
        parent: first,
        at: T0 + 2,
      });
      seedNormRule(store, {
        title: '공개 API로만 접근',
        statement: 'WHEN 모듈이 다른 블록을 가져오면 THE SYSTEM SHALL 그 블록의 공개 API만 쓴다',
        parent: null,
        builtin: true,
        at: T0 + 3,
      });
      return { first, old };
    });
    otherRequirementId = seeded.first.id;
    await h.client.call('settings.update', {
      projectId: h.project.id,
      patch: {
        run: { maxBudgetUsd: 5, maxTurns: 200 },
        roles: { 'rule-writer': { model: 'test-model', maxBudgetUsd: 1, maxTurns: 20 } },
      },
      author: human,
    });
    const { requirement } = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '헬스 체크 응답에서 서버 시각 제거',
      author: human,
    });
    await svc.whenSettled(h.project.id, requirement.id);
    const [record] = svc.recordsFor(h.project.id, requirement.id);
    if (record === undefined) throw new Error('기록 없음');
    expect(record.toolCalls.map((call) => [call.name, call.status, call.reason])).toEqual([
      ['retire_rule', 'denied', 'invalid_args'],
      ['retire_rule', 'denied', 'builtin_rule'],
      ['supersede_rule', 'denied', 'invalid_args'],
      ['supersede_rule', 'denied', 'invalid_args'],
      ['supersede_rule', 'ok', undefined],
    ]);
    h.read((store) => {
      const rules = store.rules.list();
      expect(rules.map((rule) => rule.displayId)).toEqual([
        'RULE-001',
        'RULE-002',
        'RULE-003',
        'RULE-004',
      ]);
      expect(effectiveRules(store).map((rule) => rule.displayId)).toEqual([
        'RULE-002',
        'RULE-003',
        'RULE-004',
      ]);
      expect(store.normChanges.list().map((entry) => entry.kind)).toEqual([
        'created',
        'judgment',
        'superseded',
      ]);
      expect(store.ruleRetirements.get(seeded.old.id)?.supersededBy).toBe(rules[3]?.id);
      // 승인 기록에는 에이전트 행동을 쓰지 않는다 (C2)
      expect(store.approvalLog.list()).toEqual([]);
    });
    // 새 규칙은 이 세션이 만든 규칙으로 센다 (자동 시작 · 중복 방지의 원인)
    expect(record.ruleIds).toHaveLength(1);
    // rule.list 기본 결과에서 폐기된 규칙이 빠진다 (rule.get은 그대로 돌려준다, 판정 이력은 지우지 않는다)
    const listed = await h.client.call('rule.list', { projectId: h.project.id });
    expect(listed.rules.map((entry) => entry.rule.displayId)).toEqual([
      'RULE-002',
      'RULE-003',
      'RULE-004',
    ]);
    const got = await h.client.call('rule.get', { projectId: h.project.id, id: seeded.old.id });
    expect(got.rule.displayId).toBe('RULE-001');
    // 폐기된 규칙의 항목에만 폐기 사실이 실린다: 시각 · 대체한 규칙(ID · 표시 ID) · 사유가 든 규범 변경 기록 순번 (ADR-114)
    const successor = h.read((store) => store.rules.list()[3]);
    const supersededSeq = h.read(
      (store) => store.normChanges.list().find((entry) => entry.kind === 'superseded')?.seq,
    );
    expect(got.retirement).toEqual({
      retiredAt: h.read((store) => store.ruleRetirements.get(seeded.old.id)?.retiredAt),
      supersededBy: { id: successor?.id, displayId: 'RULE-004' },
      normChangeSeq: supersededSeq,
    });
    expect(listed.rules.map((entry) => entry.retirement)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    // 폐기 포함: 폐기된 규칙도 표시 ID 순으로 함께, 폐기 사실은 rule.get과 같다 (읽기 전용 옵션)
    const withRetired = await h.client.call('rule.list', {
      projectId: h.project.id,
      includeRetired: true,
    });
    expect(
      withRetired.rules.map((entry) => [entry.rule.displayId, entry.retirement ?? null]),
    ).toEqual([
      ['RULE-001', got.retirement],
      ['RULE-002', null],
      ['RULE-003', null],
      ['RULE-004', null],
    ]);
    // 규범 변경 기록 조회는 근거 · 상세를 표시 값으로 내보낸다 (대체 기록의 폐기 직전 내용 포함)
    const changes = await h.client.call('normChange.list', {
      projectId: h.project.id,
      targetRef: { entity: 'Rule', id: seeded.old.id },
    });
    expect(changes.chain.valid).toBe(true);
    expect(changes.entries.map((entry) => [entry.kind, entry.reason])).toEqual([
      ['superseded', GROUNDS],
    ]);
    expect(changes.entries[0]?.detail).toMatchObject({
      before: { displayId: 'RULE-001', statement: OLD_STATEMENT },
      retirement: { supersededBy: { displayId: 'RULE-004' }, createdSeq: 1, judgmentSeq: 2 },
    });
  }, 30_000);
});

describe('규칙 목록 · 단건 조회의 폐기 표시 (M7-15 #227, ADR-114)', () => {
  it('폐기만 한 규칙은 대체 규칙 없이 폐기 시각 · 기록 순번이 실리고, 폐기 기록 행을 읽을 수 없으면 세 칸이 null인 채 폐기로 남는다', async () => {
    const h = await startProjectHarness({ servers, clients });
    const ids = h.read((store) => {
      const first = seedNormRequirement(store, '헬스 체크 응답에 서버 시각 포함', T0);
      const old = seedNormRule(store, {
        title: '서버 시각',
        statement: OLD_STATEMENT,
        parent: first,
        at: T0 + 1,
      });
      const kept = seedNormRule(store, {
        title: '응답 형식',
        statement:
          'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 상태 코드 200을 돌려준다',
        parent: first,
        at: T0 + 2,
      });
      const result = retireAgentRule(
        store,
        { ruleId: 'RULE-001', grounds: GROUNDS, author: AGENT, sessionId: SESSION },
        clock(),
      );
      return { old: old.id, kept: kept.id, seq: result.normChange.seq };
    });
    const retiredAt = h.read((store) => store.ruleRetirements.get(ids.old)?.retiredAt);
    const got = await h.client.call('rule.get', { projectId: h.project.id, id: ids.old });
    expect(got.retirement).toEqual({ retiredAt, supersededBy: null, normChangeSeq: ids.seq });
    const kept = await h.client.call('rule.get', { projectId: h.project.id, id: ids.kept });
    expect(kept).not.toHaveProperty('retirement');
    // 폐기 기록 행이 깨지면(저장소 밖 변조) 효력은 여전히 없고, 화면 응답에도 폐기로 남는다(효력 있는 규칙으로 보이지 않는다)
    h.read((store) => {
      store.db.exec('DROP TRIGGER rule_retirements_no_update');
      store.db
        .prepare("UPDATE rule_retirements SET retired_at = 'broken' WHERE rule_id = ?")
        .run(ids.old);
    });
    const broken = await h.client.call('rule.list', {
      projectId: h.project.id,
      includeRetired: true,
    });
    expect(broken.rules.map((entry) => [entry.rule.displayId, entry.retirement ?? null])).toEqual([
      ['RULE-001', { retiredAt: null, supersededBy: null, normChangeSeq: null }],
      ['RULE-002', null],
    ]);
    const plain = await h.client.call('rule.list', { projectId: h.project.id });
    expect(plain.rules.map((entry) => entry.rule.displayId)).toEqual(['RULE-002']);
  });
});
