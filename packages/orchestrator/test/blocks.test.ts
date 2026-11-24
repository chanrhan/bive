// 블록 선언 모델 · 규칙의 대상 블록 · 위험도 (M3-01 #46 수용 기준 1 · 2, NRM-09 · ADR-005 · ADR-122).
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소 · 실제 처리기. 세션 사본(수용 기준 3)은 test-writer.test.ts, CLI(수용 기준 4)는
// app/test/cli-blocks.test.ts.
import fs from 'node:fs';
import path from 'node:path';

import {
  type Author,
  BLOCKS_INVALID_REASON,
  type BlockDeclaration,
  BlocksInvalidData,
  ConfirmationNormItem,
  createUlidGenerator,
  ErrorCode,
  matchesBlockPattern,
  type Requirement,
  Rule,
} from '@bive/shared';
import { openProjectStore, type ProjectStore } from '@bive/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PipeServer } from '../src/ipc/server.js';
import { createAgentRule, supersedeAgentRule } from '../src/norms/agent-rule.js';
import {
  collectNormInput,
  NORM_INPUT_END,
  type NormInputSummary,
  renderNormInput,
} from '../src/norms/norm-input.js';
import { createRoleTools } from '../src/tools/executor.js';
import { RpcCallError, type TestClient } from './helpers/client.js';
import { cleanup, REPO_ROOT } from './helpers/process.js';
import { iso, startProjectHarness, T0, type ProjectHarness } from './helpers/project-harness.js';

const human = { kind: 'human' } as const satisfies Author;
const agent = { kind: 'agent', role: 'rule-writer' } as const satisfies Author;
const newId = createUlidGenerator();

/** 예제 블록 선언 (CLI 시험과 같은 파일). */
const SAMPLE = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'fixtures', 'blocks', 'sample-next-app.json'), 'utf8'),
) as BlockDeclaration;

const servers: PipeServer[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  await cleanup();
});

let h: ProjectHarness;
beforeEach(async () => {
  h = await startProjectHarness({ servers, clients });
});

const set = (declaration: unknown, author: Author = human) =>
  h.client.call('blocks.set', { projectId: h.project.id, author, declaration });
const get = () => h.client.call('blocks.get', { projectId: h.project.id });

const rpcError = async (promise: Promise<unknown>): Promise<RpcCallError> => {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcCallError);
  return error as RpcCallError;
};

/** 저장소를 쓰기로 열고 닫는다. */
const withStore = <T>(fn: (store: ProjectStore) => T): T => {
  const store = openProjectStore(h.project.id, { home: h.biveHome, create: false });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

const block = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  kind: 'domain',
  include: [`src/${name}/**`],
  public: [],
  dependsOn: [],
  risk: 'low',
  ...over,
});

describe('blocks.get · blocks.set 왕복 · 저장 위치 (수용 기준 1, ADR-005 · ADR-122)', () => {
  it('저장 전에는 선언 없음, set이 돌려준 판과 get이 같고 $BIVE_HOME/projects/<id>/의 프로젝트 DB에 판 1행이 남는다', async () => {
    expect(await get()).toEqual({ current: null });
    h.clock.now = T0 + 1_000;
    const saved = await set(SAMPLE);
    const expected = { version: 1, declaration: SAMPLE, setAt: iso(T0 + 1_000), setBy: human };
    expect(saved).toEqual({ current: expected });
    expect(await get()).toEqual({ current: expected });
    // 이름 · 종류 · include · public · dependsOn · risk가 모두 왕복한다
    expect(saved.current.declaration.blocks.map((b) => [b.name, b.kind, b.risk])).toEqual([
      ['auth', 'domain', 'high'],
      ['health', 'domain', 'medium'],
      ['lib', 'shared', 'low'],
    ]);
    expect(saved.current.declaration.blocks[2]).toEqual({
      name: 'lib',
      kind: 'shared',
      include: ['src/lib/**'],
      public: ['src/lib/db.ts'],
      dependsOn: [],
      risk: 'low',
    });
    // 저장 위치: 프로젝트 폴더 밖 저장소의 그 프로젝트 폴더 (ADR-005 · ADR-025)
    const rows = withStore((store) => {
      expect(path.dirname(store.path)).toBe(path.join(h.biveHome, 'projects', h.project.id));
      return store.db
        .prepare<[], { version: number; set_by: string; declaration: string }>(
          'SELECT version, set_by, declaration FROM block_declarations',
        )
        .all();
    });
    expect(rows).toEqual([
      { version: 1, set_by: '{"kind":"human"}', declaration: JSON.stringify(SAMPLE) },
    ]);
  });

  it('다시 저장하면 새 판이 되고 옛 판은 그대로 남는다 (바꾼 기록 = 판 목록)', async () => {
    h.clock.now = T0 + 1_000;
    await set(SAMPLE);
    h.clock.now = T0 + 2_000;
    const changed = { blocks: [block('lib', { kind: 'shared', risk: 'medium' })] };
    expect((await set(changed)).current).toMatchObject({ version: 2, declaration: changed });
    expect((await get()).current?.version).toBe(2);
    expect(withStore((store) => store.blockDeclarations.list())).toEqual([
      { version: 1, declaration: SAMPLE, setAt: iso(T0 + 1_000), setBy: human },
      { version: 2, declaration: changed, setAt: iso(T0 + 2_000), setBy: human },
    ]);
  });

  it('에이전트 주체의 blocks.set은 -32020이고 아무것도 저장되지 않는다 (선언을 고쳐 구조 검사를 우회하지 못한다)', async () => {
    const error = await rpcError(set(SAMPLE, agent));
    expect(error.code).toBe(ErrorCode.Unauthorized);
    // 형식이 틀린 선언이어도 주체를 먼저 본다 (스키마 오류를 돌려주지 않는다)
    expect((await rpcError(set({ blocks: [] }, agent))).code).toBe(ErrorCode.Unauthorized);
    expect(await get()).toEqual({ current: null });
    expect(withStore((store) => store.blockDeclarations.list())).toEqual([]);
  });
});

describe('저장 때 거부하는 선언 (ADR-122 표): -32001 BLOCKS_INVALID, 아무것도 저장되지 않음', () => {
  const cases: [string, unknown, string][] = [
    ['블록 없음', { blocks: [] }, 'blocks'],
    [
      '이름 중복',
      { blocks: [block('lib'), block('lib', { include: ['lib/**'] })] },
      '블록 이름이 중복됐습니다: lib',
    ],
    [
      '없는 블록을 가리키는 dependsOn',
      { blocks: [block('auth', { dependsOn: ['nope'] })] },
      '선언되지 않은 블록을 허용 의존으로 가리킵니다: nope',
    ],
    [
      '자기 자신을 가리키는 dependsOn',
      { blocks: [block('auth', { dependsOn: ['auth'] })] },
      '자기 자신을 허용 의존으로 둘 수 없습니다: auth',
    ],
    [
      'dependsOn 순환',
      {
        blocks: [
          block('a', { dependsOn: ['b'] }),
          block('b', { dependsOn: ['c'] }),
          block('c', { dependsOn: ['a'] }),
        ],
      },
      '허용 의존이 순환합니다: a → b → c → a',
    ],
    [
      '두 블록에 같은 포함 경로',
      { blocks: [block('a', { include: ['src/**'] }), block('b', { include: ['src/**'] })] },
      '같은 포함 경로 패턴이 두 블록에 있습니다: src/** (a, b)',
    ],
    [
      '절대 경로 패턴',
      { blocks: [block('a', { include: ['/etc/**'] })] },
      '절대 경로는 받지 않습니다',
    ],
    [
      '.. 구간 (프로젝트 폴더 밖)',
      { blocks: [block('a', { include: ['../other/**'] })] },
      '. · .. 구간은 받지 않습니다',
    ],
    [
      '중간의 .. 구간',
      { blocks: [block('a', { public: ['src/../../x.ts'] })] },
      '. · .. 구간은 받지 않습니다',
    ],
    ['. 구간', { blocks: [block('a', { include: ['./src/**'] })] }, '. · .. 구간은 받지 않습니다'],
    ['역슬래시', { blocks: [block('a', { include: ['src\\a\\**'] })] }, '패턴에는 영문자 · 숫자'],
    ['빈 구간', { blocks: [block('a', { include: ['src//a'] })] }, '빈 경로 구간'],
    ['구간 일부의 **', { blocks: [block('a', { include: ['src/a**'] })] }, '**는 구간 전체로만'],
    ['이름 형식', { blocks: [block('Auth')] }, '블록 이름은 소문자로 시작'],
    ['위험도 값', { blocks: [block('a', { risk: 'critical' })] }, 'risk'],
    ['포함 경로 없음', { blocks: [block('a', { include: [] })] }, 'include'],
    ['모르는 칸', { blocks: [block('a', { owner: 'x' })] }, 'owner'],
  ];

  for (const [label, declaration, fragment] of cases) {
    it(label, async () => {
      const error = await rpcError(set(declaration));
      expect(error.code).toBe(ErrorCode.ValidationFailed);
      const data = BlocksInvalidData.parse(error.data);
      expect(data.reason).toBe(BLOCKS_INVALID_REASON);
      const text = data.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('\n');
      expect(text).toContain(fragment);
      expect(error.message).toContain('블록 선언 검증 실패');
      expect(await get()).toEqual({ current: null });
    });
  }

  it('대조군: 위 모양을 고친 선언은 저장된다 (거부가 다른 이유로 나지 않았음)', async () => {
    const ok = {
      blocks: [
        block('a', { dependsOn: ['b'], public: ['src/a/index.ts'] }),
        block('b', { dependsOn: ['c'], include: ['src/b/**', 'src/(group)/[id]/@slot/*.ts'] }),
        block('c', { risk: 'high', kind: 'shared' }),
      ],
    };
    expect((await set(ok)).current).toMatchObject({ version: 1, declaration: ok });
  });
});

describe('DB가 함께 막는 것 (0022: 사람 주체 · 다음 판 · 추가 전용)', () => {
  const insert = (store: ProjectStore, version: number, setBy: string) =>
    store.db
      .prepare(
        'INSERT INTO block_declarations (version, set_at, set_by, declaration) VALUES (?, ?, ?, ?)',
      )
      .run(version, iso(T0), setBy, JSON.stringify(SAMPLE));

  it('에이전트 주체 행 · 판 건너뛰기 · 덮어쓰기 · 수정 · 삭제를 거부하고 사람 주체의 다음 판은 받는다', () => {
    withStore((store) => {
      expect(() => insert(store, 1, JSON.stringify(agent))).toThrow(/CHECK constraint/);
      expect(() => insert(store, 2, '{"kind":"human"}')).toThrow(/다음 판으로만/);
      insert(store, 1, '{"kind":"human"}');
      expect(() =>
        store.db
          .prepare('INSERT OR REPLACE INTO block_declarations VALUES (1, ?, ?, ?)')
          .run(iso(T0), '{"kind":"human"}', '{}'),
      ).toThrow(/다음 판으로만/);
      expect(() =>
        store.db.prepare("UPDATE block_declarations SET declaration = '{}'").run(),
      ).toThrow(/추가만/);
      expect(() => store.db.prepare('DELETE FROM block_declarations').run()).toThrow(/추가만/);
      insert(store, 2, '{"kind":"human"}');
      expect(store.blockDeclarations.list().map((record) => record.version)).toEqual([1, 2]);
    });
  });

  it('리포지토리도 사람이 아닌 주체를 받지 않는다', () => {
    withStore((store) => {
      expect(() =>
        store.blockDeclarations.set(SAMPLE, { at: iso(T0), by: agent as never }),
      ).toThrow();
      expect(store.blockDeclarations.current()).toBeNull();
    });
  });
});

describe('경로 패턴 (프로젝트 루트 기준 작은 글롭)', () => {
  it('**는 0개 이상의 구간, *는 구간 안, 나머지(대괄호 · 괄호 · @ 포함)는 글자 그대로', () => {
    const cases: [string, string, boolean][] = [
      ['src/lib/**', 'src/lib/db.ts', true],
      ['src/lib/**', 'src/lib/a/b.ts', true],
      ['src/lib/**', 'src/library/x.ts', false],
      ['src/lib/**', 'src/lib', false],
      ['src/**/route.ts', 'src/route.ts', true],
      ['src/**/route.ts', 'src/app/api/health/route.ts', true],
      ['src/*/db.ts', 'src/lib/db.ts', true],
      ['src/*/db.ts', 'src/a/b/db.ts', false],
      ['src/lib/db.ts', 'src/lib/db.ts', true],
      ['src/lib/db.ts', 'src/lib/dbxts', false],
      ['src/app/items/[id]/**', 'src/app/items/[id]/route.ts', true],
      ['src/app/items/[id]/**', 'src/app/items/i/route.ts', false],
      ['src/(group)/@slot/*.ts', 'src/(group)/@slot/page.ts', true],
      ['src/(group)/@slot/*.ts', 'src/group/@slot/page.ts', false],
      ['a+b/*.ts', 'a+b/x.ts', true],
      ['a+b/*.ts', 'aab/x.ts', false],
    ];
    for (const [pattern, file, expected] of cases) {
      expect(matchesBlockPattern(pattern, file), `${pattern} ~ ${file}`).toBe(expected);
    }
  });
});

// ── 수용 기준 2: 규칙의 대상 블록 · 위험도 ───────────────────

const PROPOSAL = {
  parentRequirementId: 'REQ-1',
  title: '헬스 체크 응답의 서버 시각',
  statement: 'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL time을 담는다',
  kind: 'business',
  checkKinds: ['test'],
  targetBlocks: ['health'],
  risk: 'medium',
  rationale: '검사 가능한 형태',
  contradiction: { verdict: 'none' },
} as const;

const without = (key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(PROPOSAL).filter(([name]) => name !== key));

describe('propose_rule · supersede_rule: 대상 블록 1개 이상과 위험도가 없으면 도구 오류 (수용 기준 2)', () => {
  const sessionRoot = () => {
    const dir = path.join(h.biveHome, 'work', h.project.id, 'sessions', 's1');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  it('빠지거나 틀린 대상 블록 · 위험도는 콜백을 부르지 않고 denied(invalid_args), 갖추면 콜백이 그 값을 받는다', async () => {
    const received: unknown[] = [];
    const tools = createRoleTools({
      role: 'rule-writer',
      sessionRoot: sessionRoot(),
      biveHome: h.biveHome,
      hooks: {
        proposeRule: (input) => {
          received.push(input);
          return 'ok';
        },
        supersedeRule: (input) => {
          received.push(input);
          return 'ok';
        },
      },
    });
    const bad: [string, Record<string, unknown>][] = [
      ['targetBlocks', without('targetBlocks')],
      ['risk', without('risk')],
      ['targetBlocks', { ...PROPOSAL, targetBlocks: [] }],
      ['targetBlocks', { ...PROPOSAL, targetBlocks: ['health', 'health'] }],
      ['targetBlocks', { ...PROPOSAL, targetBlocks: ['Health'] }],
      ['targetBlocks', { ...PROPOSAL, targetBlocks: 'health' }],
      ['risk', { ...PROPOSAL, risk: 'critical' }],
      ['risk', { ...PROPOSAL, risk: null }],
    ];
    for (const [field, args] of bad) {
      const result = await tools.execute('propose_rule', args);
      expect(result, JSON.stringify(args)).toMatchObject({
        status: 'denied',
        reason: 'invalid_args',
      });
      expect(result.content).toContain(field);
      const superseding = { ...args, ruleId: 'RULE-001', grounds: '근거' };
      expect(await tools.execute('supersede_rule', superseding)).toMatchObject({
        status: 'denied',
        reason: 'invalid_args',
      });
    }
    expect(received).toEqual([]);
    expect(await tools.execute('propose_rule', PROPOSAL)).toEqual({ status: 'ok', content: 'ok' });
    expect(received).toEqual([PROPOSAL]);
  });
});

const NORM_INPUT: NormInputSummary = {
  requirements: { total: 1, included: 1, omitted: 0 },
  rules: { total: 0, included: 0, omitted: 0 },
  truncated: false,
};

describe('반영 모듈: 대상 블록 · 위험도 저장과 블록 선언 대조 (수용 기준 2, ADR-122)', () => {
  let requirement: Requirement;
  beforeEach(() => {
    requirement = withStore((store) =>
      store.requirements.create({
        id: newId(),
        text: '헬스 체크 응답에 서버 시각 포함',
        author: human,
        normState: 'approved',
        createdAt: iso(T0),
      }),
    );
  });

  const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    title: PROPOSAL.title,
    statement: PROPOSAL.statement,
    kind: PROPOSAL.kind,
    checkKinds: PROPOSAL.checkKinds,
    targetBlocks: PROPOSAL.targetBlocks,
    risk: PROPOSAL.risk,
    parentRequirementId: requirement.id,
    ...over,
  });
  const create = (store: ProjectStore, over: Record<string, unknown> = {}) =>
    createAgentRule(
      store,
      {
        payload: payload(over),
        rationale: '근거',
        author: agent,
        sessionId: newId(),
        contradiction: { verdict: 'none' },
        normInput: NORM_INPUT,
      },
      { now: () => T0 + 5_000, newId },
    );
  const counts = (store: ProjectStore) => ({
    rules: store.rules.list().length,
    normChanges: store.normChanges.list().length,
  });

  it('블록 선언이 없으면 받은 이름을 대조 없이 그대로 저장하고, 신규 기록에 선언 없음(판 null)이 남는다', () => {
    withStore((store) => {
      const { rule, normChange } = create(store, {
        targetBlocks: ['auth', 'anything'],
        risk: 'high',
      });
      expect(rule).toMatchObject({ targetBlockIds: ['auth', 'anything'], risk: 'high' });
      expect(store.rules.get(rule.id)).toMatchObject({
        targetBlockIds: ['auth', 'anything'],
        risk: 'high',
      });
      expect(normChange.detail.after).toMatchObject({
        targetBlockIds: ['auth', 'anything'],
        risk: 'high',
        blockDeclarationVersion: null,
      });
    });
  });

  it('블록 선언이 있으면 이름이 모두 선언에 있어야 하고, 없는 이름은 스키마 오류(도구 인자 오류)로 아무것도 남기지 않는다', () => {
    withStore((store) => {
      store.blockDeclarations.set(SAMPLE, { at: iso(T0), by: human });
      const before = counts(store);
      let thrown: unknown;
      try {
        create(store, { targetBlocks: ['health', 'nope'] });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ name: 'ZodError' });
      expect((thrown as { issues: { path: unknown[]; message: string }[] }).issues).toEqual([
        expect.objectContaining({
          path: ['targetBlocks', 1],
          message: '블록 선언에 없는 블록: nope (선언된 블록: auth, health, lib)',
        }),
      ]);
      expect(counts(store)).toEqual(before);

      const { rule, normChange } = create(store, { targetBlocks: ['health', 'lib'], risk: 'low' });
      expect(store.rules.get(rule.id)).toMatchObject({
        targetBlockIds: ['health', 'lib'],
        risk: 'low',
      });
      expect(normChange.detail.after).toMatchObject({ blockDeclarationVersion: 1 });
    });
  });

  it('반영 모듈도 대상 블록 · 위험도가 없는 본문을 받지 않는다 (규칙 생성 · 대체 모두)', () => {
    withStore((store) => {
      const before = counts(store);
      expect(() => create(store, { targetBlocks: undefined })).toThrow();
      expect(() => create(store, { risk: undefined })).toThrow();
      expect(() => create(store, { targetBlocks: [] })).toThrow();
      const noBlocks = payload();
      delete noBlocks.targetBlocks;
      expect(() =>
        supersedeAgentRule(
          store,
          {
            payload: noBlocks,
            rationale: '근거',
            author: agent,
            sessionId: newId(),
            contradiction: { verdict: 'none' },
            normInput: NORM_INPUT,
            ruleId: 'RULE-001',
            grounds: '근거',
          },
          { now: () => T0, newId },
        ),
      ).toThrow();
      expect(counts(store)).toEqual(before);
    });
  });

  it('옛 규칙 행(대상 블록 빈 목록 · 위험도 null)은 그대로 읽힌다 (이행에서 지어내지 않는다)', () => {
    withStore((store) => {
      const old = store.rules.create({
        id: newId(),
        title: '옛 규칙',
        statement: 'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 200을 돌려준다',
        kind: 'business',
        checkKinds: ['test'],
        parentRequirementId: requirement.id,
        builtin: false,
        targetBlockIds: [],
        risk: null,
        contractId: null,
        author: human,
        normState: 'approved',
        createdAt: iso(T0),
      });
      expect(Rule.parse(store.rules.get(old.id))).toMatchObject({ targetBlockIds: [], risk: null });
    });
  });

  it('확인할 것 목록: 규칙 항목에 위험도 칸이 실리고, 위험도 없는 옛 규칙 · 요구사항 항목에는 칸이 없다', async () => {
    const created = withStore((store) => create(store, { risk: 'high' }).rule);
    const old = withStore((store) =>
      store.rules.create({
        id: newId(),
        title: '옛 규칙',
        statement: 'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 200을 돌려준다',
        kind: 'business',
        checkKinds: ['test'],
        parentRequirementId: requirement.id,
        builtin: false,
        targetBlockIds: [],
        risk: null,
        contractId: null,
        author: human,
        normState: 'approved',
        createdAt: iso(T0),
      }),
    );
    const { items } = await h.client.call('confirmation.list', { projectId: h.project.id });
    const norms = items.map((item) => ConfirmationNormItem.parse(item));
    const of = (id: string) => norms.find((item) => item.target.id === id);
    expect(of(created.id)?.risk).toBe('high');
    expect(of(old.id)).toBeDefined();
    expect(of(old.id) !== undefined && 'risk' in of(old.id)!).toBe(false);
    expect(of(requirement.id)).toBeDefined();
    expect(of(requirement.id) !== undefined && 'risk' in of(requirement.id)!).toBe(false);
  });
});

/** 판정 케이스 이름을 싣지 않는 대조 (이 시험에는 판정 기록이 없다). */
const NO_CASES = { isKnownCase: () => false };

describe('세션 입력: 효력 있는 규범 자료에 블록 선언 (규칙 작성 · 테스트 작성 · 구현 역할 공통, ADR-122)', () => {
  it('선언이 있으면 자료 끝(끝 표시 줄 앞)에 지금 판의 블록이 한 줄 값으로 실리고, 없으면 블록 자료가 없다', () => {
    withStore((store) => {
      const none = renderNormInput(
        collectNormInput(store, { requirementIds: [], ruleIds: [] }, NO_CASES),
        '대상',
      );
      expect(none).not.toContain('블록 선언');
      store.blockDeclarations.set(SAMPLE, { at: iso(T0), by: human });
      const input = collectNormInput(store, { requirementIds: [], ruleIds: [] }, NO_CASES);
      expect(input.blocks?.version).toBe(1);
      const text = renderNormInput(input, '대상');
      const lines = text.split('\n');
      const start = lines.findIndex((line) => line.startsWith('블록 선언 (판 1, 블록 3개'));
      expect(start).toBeGreaterThan(0);
      expect(lines.slice(start + 1, start + 6)).toEqual([
        '- auth',
        '  종류: domain, 위험도: high',
        '  포함 경로: src/app/api/auth/**',
        '  공개 API: 없음',
        '  허용 의존: lib',
      ]);
      expect(lines.slice(start + 11, start + 16)).toEqual([
        '- lib',
        '  종류: shared, 위험도: low',
        '  포함 경로: src/lib/**',
        '  공개 API: src/lib/db.ts',
        '  허용 의존: 없음',
      ]);
      expect(lines.at(-1)).toBe(NORM_INPUT_END);
      expect(lines.at(-2)).toBe('  허용 의존: 없음');
    });
  });
});
