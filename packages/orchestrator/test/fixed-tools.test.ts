// 고정 도구 실행기 · 도구 정의 · 도구 호출 기록 (이슈 #20 수용 기준 3, NFR-01 · NFR-02 · ADR-024 · ADR-052).
// 역할별 도구 세트, 목록 밖 이름의 `unknown_tool` 거부, 제안 콜백, 그리고 모든 호출이
// 경로 또는 명령 · 시각 · 결과와 함께 기록되는지를 ScriptedAdapter 재생까지 포함해 확인한다.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentRole, createUlidGenerator } from '@bive/shared';
import { openProjectStore } from '@bive/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionEvent, SessionSpec } from '../src/agent/adapter.js';
import { loadScenario } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import {
  COMMAND_TOOL_NAMES,
  FILE_TOOL_NAMES,
  ROLE_TOOL_NAMES,
  roleToolNames,
  toolDefinitions,
} from '../src/tools/definitions.js';
import {
  createRoleTools,
  type ProposalContext,
  type ToolCallRecord,
} from '../src/tools/executor.js';
import type { ProposeRuleInput } from '../src/tools/definitions.js';

const newUlid = createUlidGenerator();

let home: string;
let worktree: string;
let session: string;
const tempDirs: string[] = [];

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bive-fixed-tools-')));
  tempDirs.push(home);
  worktree = path.join(home, 'work', 'p1', 'worktrees', 'r1');
  session = path.join(home, 'work', 'p1', 'sessions', 's1');
  mkdirSync(path.join(worktree, 'src', 'app', 'api', 'health'), { recursive: true });
  writeFileSync(
    path.join(worktree, 'src', 'app', 'api', 'health', 'route.ts'),
    'export async function GET() { return Response.json({ ok: true }); }\n',
  );
  mkdirSync(session, { recursive: true });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 어느 역할에도 없어야 하는 도구 (NFR-01 · NFR-02 · ADR-007) */
const FORBIDDEN_TOOLS = [
  'proposal.approve',
  'proposal_approve',
  'approve',
  'approve_proposal',
  'provisional_approve',
  'rule.create',
  'write_rule',
  'Bash',
  'bash',
  'Task',
  'Agent',
  'Write',
  'Edit',
  'Read',
];

describe('역할별 도구 세트', () => {
  it('ADR-024 매트릭스와 같다', () => {
    expect(ROLE_TOOL_NAMES['rule-writer']).toEqual([
      'propose_rule',
      'retire_rule',
      'supersede_rule',
      // 이의 판단의 유지 (M7-11 #223, ADR-115)
      'uphold_rule',
    ]);
    expect(ROLE_TOOL_NAMES['test-writer']).toEqual([...FILE_TOOL_NAMES, 'run_tests']);
    // 이의 제기 (M7-11 #223, ADR-115): 구현 역할에만
    expect(ROLE_TOOL_NAMES.implementer).toEqual([
      ...FILE_TOOL_NAMES,
      ...COMMAND_TOOL_NAMES,
      'raise_objection',
    ]);
    expect(ROLE_TOOL_NAMES.planner).toEqual([]);
    expect(ROLE_TOOL_NAMES.chat).toEqual([]);
  });

  it.each(AgentRole.options)('%s: 승인 · 규범 쓰기 · 셸 · 서브 에이전트 도구가 없다', (role) => {
    const names = roleToolNames(role) as readonly string[];
    for (const forbidden of FORBIDDEN_TOOLS) expect(names).not.toContain(forbidden);
  });

  it.each(AgentRole.options)('%s: 실행기 toolNames와 도구 정의가 같은 목록이다', (role) => {
    const tools = createRoleTools({ role, sessionRoot: session, biveHome: home });
    const definitions = toolDefinitions(role);
    expect(tools.toolNames).toEqual(roleToolNames(role));
    expect(definitions.map((definition) => definition.name)).toEqual(roleToolNames(role));
    for (const definition of definitions) {
      expect(definition.description.length).toBeGreaterThan(0);
      expect(typeof definition.inputSchema.shape).toBe('object');
    }
  });

  it('도구 정의의 입력 스키마는 모르는 인자를 거부한다', () => {
    for (const definition of toolDefinitions('implementer')) {
      expect(definition.inputSchema.safeParse({ __extra: 1 }).success).toBe(false);
    }
  });
});

describe('목록 밖 이름 거부', () => {
  it.each(AgentRole.options)('%s: proposal.approve는 denied(unknown_tool)', async (role) => {
    const tools = createRoleTools({ role, sessionRoot: session, biveHome: home });

    const result = await tools.execute('proposal.approve', { proposalId: 'PRP-002' });

    expect(result).toMatchObject({ status: 'denied', reason: 'unknown_tool' });
    expect(tools.records).toEqual([
      expect.objectContaining({
        name: 'proposal.approve',
        status: 'denied',
        reason: 'unknown_tool',
        argsSummary: '{"proposalId":"PRP-002"}',
      }),
    ]);
  });

  it('빈 이름("")의 호출도 denied(unknown_tool)로 거부하고, 이름을 지어내지 않고 빈 문자열 그대로 기록하며 저장소가 그 기록을 받는다 (NFR-02, M2-11 #190 · ADR-094)', async () => {
    const tools = createRoleTools({ role: 'implementer', sessionRoot: worktree, biveHome: home });
    expect(await tools.execute('', { path: 'src/a.ts' })).toMatchObject({
      status: 'denied',
      reason: 'unknown_tool',
    });
    expect(tools.records).toEqual([
      expect.objectContaining({
        name: '',
        status: 'denied',
        reason: 'unknown_tool',
        argsSummary: '{"path":"src/a.ts"}',
      }),
    ]);
    // 엔진 · 규칙 작성 서비스가 쓰는 저장 창구(appendToolCall)가 그 기록을 그대로 남긴다
    const [record] = tools.records;
    if (record === undefined) throw new Error('기록 없음');
    const projectId = newUlid();
    const sessionId = newUlid();
    const store = openProjectStore(projectId, { home });
    try {
      store.sessions.start({
        id: sessionId,
        runId: null,
        stepId: null,
        role: 'implementer',
        model: 'model-a',
        workDir: worktree,
        startedAt: record.at,
      });
      const saved = store.sessions.appendToolCall({
        id: newUlid(),
        runId: null,
        sessionId,
        at: record.at,
        role: record.role,
        name: record.name,
        argsSummary: record.argsSummary,
        status: record.status,
        reason: record.reason ?? null,
        durationMs: Math.round(record.durationMs),
      });
      expect(store.sessions.toolCallsBySession(sessionId)).toEqual([saved]);
      expect(saved).toMatchObject({ name: '', status: 'denied', reason: 'unknown_tool', seq: 0 });
    } finally {
      store.close();
    }
  });

  it('Object 원형 이름(constructor 등)도 도구로 보지 않는다', async () => {
    const tools = createRoleTools({ role: 'implementer', sessionRoot: worktree, biveHome: home });
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(await tools.execute(name, {})).toMatchObject({
        status: 'denied',
        reason: 'unknown_tool',
      });
    }
  });
});

describe('propose_rule', () => {
  const proposal = {
    parentRequirementId: 'REQ-1',
    title: '헬스 체크 응답의 서버 시각',
    statement: 'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL time을 담는다',
    kind: 'business',
    checkKinds: ['test'],
    targetBlocks: ['health'],
    risk: 'medium',
    rationale: '검사 가능한 형태',
    contradiction: { verdict: 'none' },
  };

  it('검증한 입력을 콜백으로 넘기고 콜백 본문을 돌려준다', async () => {
    const received: [ProposeRuleInput, ProposalContext][] = [];
    const tools = createRoleTools({
      role: 'rule-writer',
      sessionRoot: session,
      biveHome: home,
      sessionId: 'sess-rw',
      hooks: {
        proposeRule: (input, context) => {
          received.push([input, context]);
          return '제안 PRP-001 등록 (대기)';
        },
      },
    });

    const result = await tools.execute('propose_rule', proposal);

    expect(result).toEqual({ status: 'ok', content: '제안 PRP-001 등록 (대기)' });
    expect(received).toEqual([[proposal, { role: 'rule-writer', sessionId: 'sess-rw' }]]);
  });

  it('형식이 틀리면 콜백을 부르지 않고 denied(invalid_args)', async () => {
    let called = 0;
    const tools = createRoleTools({
      role: 'rule-writer',
      sessionRoot: session,
      biveHome: home,
      hooks: { proposeRule: () => String(++called) },
    });

    for (const args of [
      { ...proposal, kind: 'approved-rule' },
      { ...proposal, checkKinds: [] },
      { ...proposal, state: 'approved' },
      { title: '부모 없음' },
    ]) {
      expect(await tools.execute('propose_rule', args)).toMatchObject({
        status: 'denied',
        reason: 'invalid_args',
      });
    }
    expect(called).toBe(0);
  });

  it('콜백이 돌려준 거부 · 오류 결과는 그대로 모델에게 간다 (ADR-062)', async () => {
    const tools = createRoleTools({
      role: 'rule-writer',
      sessionRoot: session,
      biveHome: home,
      hooks: {
        proposeRule: () => ({
          status: 'error',
          content: '부모 요구사항이 삭제됨',
          reason: 'state_conflict',
        }),
      },
    });
    expect(await tools.execute('propose_rule', proposal)).toEqual({
      status: 'error',
      content: '부모 요구사항이 삭제됨',
      reason: 'state_conflict',
    });
    expect(tools.records[0]).toMatchObject({ status: 'error', reason: 'state_conflict' });
  });

  it('진술이 EARS 형식이 아니거나 제목 · 근거가 비면 콜백을 부르지 않고 denied(invalid_args)', async () => {
    let called = 0;
    const tools = createRoleTools({
      role: 'rule-writer',
      sessionRoot: session,
      biveHome: home,
      hooks: { proposeRule: () => String(++called) },
    });
    for (const args of [
      { ...proposal, statement: '헬스 체크 응답에 time을 담는다' },
      { ...proposal, statement: 'when 요청하면 the system shall 응답한다' },
      { ...proposal, title: ' ' },
      { ...proposal, rationale: '\n' },
      { ...proposal, checkKinds: ['test', 'test'] },
    ]) {
      expect(await tools.execute('propose_rule', args)).toMatchObject({
        status: 'denied',
        reason: 'invalid_args',
      });
    }
    expect(called).toBe(0);
  });

  it('콜백이 없으면 error(not_configured), 콜백 예외는 error(tool_failed)', async () => {
    const bare = createRoleTools({ role: 'rule-writer', sessionRoot: session, biveHome: home });
    expect(await bare.execute('propose_rule', proposal)).toMatchObject({
      status: 'error',
      reason: 'not_configured',
    });

    const throwing = createRoleTools({
      role: 'rule-writer',
      sessionRoot: session,
      biveHome: home,
      hooks: {
        proposeRule: () => {
          throw new Error('대기열 상한 초과');
        },
      },
    });
    expect(await throwing.execute('propose_rule', proposal)).toEqual({
      status: 'error',
      content: '대기열 상한 초과',
      reason: 'tool_failed',
    });
    expect(throwing.records[0]).toMatchObject({ status: 'error', reason: 'tool_failed' });
  });
});

describe('도구 호출 기록', () => {
  it('ok · denied · error 모두 경로 · 시각 · 결과 · 세션과 함께 남는다', async () => {
    const seen: ToolCallRecord[] = [];
    let tick = Date.parse('2026-10-16T00:00:00.000Z');
    const tools = createRoleTools({
      role: 'implementer',
      sessionRoot: worktree,
      biveHome: home,
      hooks: { onToolCall: (record) => seen.push(record) },
      now: () => new Date((tick += 1000)),
    });

    await tools.execute('read_file', { path: 'src/app/api/health/route.ts' });
    tools.setSessionId('sdk-session-1');
    await tools.execute('write_file', { path: '.git/config', content: 'x' });
    await tools.execute('read_file', { path: 'src/missing.ts' });
    await tools.execute('list_files', {});
    await tools.execute('search_files', { query: 'GET' });
    await tools.execute('write_file', { path: 'src/x.ts' });

    expect(seen).toEqual(tools.records);
    expect(
      tools.records.map(({ at, sessionId, name, argsSummary, status, reason }) => ({
        at,
        sessionId,
        name,
        argsSummary,
        status,
        reason,
      })),
    ).toEqual([
      {
        at: '2026-10-16T00:00:01.000Z',
        sessionId: null,
        name: 'read_file',
        argsSummary: 'src/app/api/health/route.ts',
        status: 'ok',
        reason: undefined,
      },
      {
        at: '2026-10-16T00:00:02.000Z',
        sessionId: 'sdk-session-1',
        name: 'write_file',
        argsSummary: '.git/config',
        status: 'denied',
        reason: 'path_denied',
      },
      {
        at: '2026-10-16T00:00:03.000Z',
        sessionId: 'sdk-session-1',
        name: 'read_file',
        argsSummary: 'src/missing.ts',
        status: 'error',
        reason: 'not_found',
      },
      {
        at: '2026-10-16T00:00:04.000Z',
        sessionId: 'sdk-session-1',
        name: 'list_files',
        argsSummary: '.',
        status: 'ok',
        reason: undefined,
      },
      {
        at: '2026-10-16T00:00:05.000Z',
        sessionId: 'sdk-session-1',
        name: 'search_files',
        argsSummary: '.',
        status: 'ok',
        reason: undefined,
      },
      {
        at: '2026-10-16T00:00:06.000Z',
        sessionId: 'sdk-session-1',
        name: 'write_file',
        argsSummary: 'src/x.ts',
        status: 'denied',
        reason: 'invalid_args',
      },
    ]);
    for (const record of tools.records) {
      expect(record.role).toBe('implementer');
      expect(Number.isInteger(record.durationMs) && record.durationMs >= 0).toBe(true);
    }
  });

  it('파일 도구가 예외를 던져도 인자 요약은 경로뿐이다 (쓰기 내용이 기록에 섞이지 않음, ADR-083)', async () => {
    // 세션 루트의 파일 아래 경로에 쓰면 폴더 만들기가 예외를 던진다(ENOTDIR · EEXIST) → tool_failed
    writeFileSync(path.join(worktree, 'package.json'), '{}\n');
    const tools = createRoleTools({ role: 'implementer', sessionRoot: worktree, biveHome: home });
    await tools.execute('write_file', {
      path: 'package.json/x.ts',
      content: 'SECRET_CONTENT_LINE',
    });
    expect(tools.records[0]).toMatchObject({
      name: 'write_file',
      status: 'error',
      reason: 'tool_failed',
      argsSummary: 'package.json/x.ts',
    });
    expect(JSON.stringify(tools.records)).not.toContain('SECRET');
  });

  it('파일 도구 이름이면 역할에 없어 거부돼도 · 경로가 문자열이 아니어도 내용을 남기지 않는다', async () => {
    const writer = createRoleTools({ role: 'rule-writer', sessionRoot: session, biveHome: home });
    await writer.execute('write_file', { path: 'a.ts', content: 'SECRET_DENIED' });
    expect(writer.records[0]).toMatchObject({
      name: 'write_file',
      status: 'denied',
      reason: 'unknown_tool',
      argsSummary: 'a.ts',
    });

    const implementer = createRoleTools({
      role: 'implementer',
      sessionRoot: worktree,
      biveHome: home,
    });
    await implementer.execute('write_file', { path: { nested: 'SECRET_PATH' }, content: 'SECRET' });
    expect(implementer.records[0]).toMatchObject({ status: 'denied', reason: 'invalid_args' });
    expect(JSON.stringify([...writer.records, ...implementer.records])).not.toContain('SECRET');
  });

  it('기록 요약은 길이가 제한된다', async () => {
    const tools = createRoleTools({ role: 'chat', sessionRoot: session, biveHome: home });
    await tools.execute('anything', { blob: 'x'.repeat(5000) });
    expect(tools.records[0]?.argsSummary.length).toBeLessThanOrEqual(201);
  });

  describe('인자가 객체가 아니거나 읽기에 실패해도 예외 없이 기록하고 결과가 바뀌지 않는다 (M2-06, ADR-089)', () => {
    const circular = (): Record<string, unknown> => {
      const value: Record<string, unknown> = { path: 'src/a.ts' };
      value.self = value;
      return value;
    };
    const deep = (): Record<string, unknown> => {
      let value: Record<string, unknown> = {};
      for (let i = 0; i < 100_000; i += 1) value = { d: value };
      return value;
    };
    const throwingGetter = (): Record<string, unknown> =>
      Object.defineProperty({}, 'path', {
        enumerable: true,
        get: () => {
          throw new Error('SECRET_GETTER');
        },
      }) as Record<string, unknown>;
    const throwingProxy = (): Record<string, unknown> =>
      new Proxy(
        {},
        {
          get: () => {
            throw new Error('SECRET_PROXY');
          },
          ownKeys: () => {
            throw new Error('SECRET_PROXY');
          },
          getOwnPropertyDescriptor: () => {
            throw new Error('SECRET_PROXY');
          },
        },
      );
    /**
     * 실행기 경계(`ToolExecutor.execute`)의 타입 밖 값: MCP · 시나리오가 잘못된 인자를 넘긴 경우를 흉내 낸다.
     * 셋째 값은 읽기가 예외를 던지는지: 그러면 허용된 도구의 인자 검증이 예외로 끝나 error(tool_failed)가 될 수 있다
     */
    const hostile: [string, () => unknown, boolean][] = [
      ['null', () => null, false],
      ['undefined', () => undefined, false],
      ['배열', () => ['src/a.ts'], false],
      ['문자열', () => 'src/a.ts', false],
      ['숫자', () => 42, false],
      ['순환 참조', circular, false],
      ['매우 깊은 객체', deep, false],
      ['getter가 예외를 던지는 객체', throwingGetter, true],
      ['모든 접근이 예외인 Proxy', throwingProxy, true],
    ];
    /** [역할, 도구, 기대 상태, 기대 사유] — 역할 허용 · 인자 검증이 지금과 같게 끝나야 한다 */
    const calls: [AgentRole, string, string, string][] = [
      ['implementer', 'write_file', 'denied', 'invalid_args'],
      ['implementer', 'read_file', 'denied', 'invalid_args'],
      ['implementer', 'list_files', 'denied', 'invalid_args'],
      ['implementer', 'run_tests', 'denied', 'invalid_args'],
      ['rule-writer', 'write_file', 'denied', 'unknown_tool'],
      ['rule-writer', 'propose_rule', 'denied', 'invalid_args'],
      ['test-writer', 'proposal.approve', 'denied', 'unknown_tool'],
    ];

    it.each(hostile)('%s', async (_label, make, readThrows) => {
      for (const [role, name, expectedStatus, expectedReason] of calls) {
        // 역할에 없는 도구는 인자를 읽기 전에 거부된다. 허용된 도구는 인자 검증이 그 값을 읽다 예외가 나면
        // 검증 결과 대신 error(tool_failed)가 된다(스키마가 모르는 키를 읽지 않고 거부하면 검증 결과 그대로)
        const expected = { status: expectedStatus, reason: expectedReason };
        const allowed =
          readThrows && expectedReason !== 'unknown_tool'
            ? [expected, { status: 'error', reason: 'tool_failed' }]
            : [expected];
        const seen: ToolCallRecord[] = [];
        const tools = createRoleTools({
          role,
          sessionRoot: role === 'implementer' ? worktree : session,
          biveHome: home,
          hooks: { onToolCall: (record) => seen.push(record) },
        });
        const result = await tools.execute(name, make() as Record<string, unknown>);
        const label = `${role} ${name}`;
        // 역할 허용 목록 · 인자 검증이 정한 결과 그대로 (요약 예외로 기록 없는 executor_error가 되거나 통과로 바뀌지 않는다)
        const outcome = { status: result.status, reason: result.reason };
        expect(allowed, label).toContainEqual(outcome);
        expect(seen, label).toHaveLength(1);
        expect(seen[0], label).toMatchObject({ role, name, ...outcome });
        expect(typeof seen[0]?.argsSummary, label).toBe('string');
        expect(seen[0]?.argsSummary.length, label).toBeLessThanOrEqual(201);
        expect(JSON.stringify(seen), label).not.toContain('SECRET');
      }
      // 쓰기는 일어나지 않았다
      expect(
        readFileSync(path.join(worktree, 'src', 'app', 'api', 'health', 'route.ts'), 'utf8'),
      ).toBe('export async function GET() { return Response.json({ ok: true }); }\n');
    });
  });

  it('저장할 경로 요약 · 도구 이름에도 길이 상한이 있다: 글자는 그대로 두고 경로는 가운데, 이름은 끝을 …로 줄인다 (ADR-089)', async () => {
    const tools = createRoleTools({ role: 'implementer', sessionRoot: worktree, biveHome: home });
    const longPath = `src/${'a'.repeat(5000)}\n.ts`;
    await tools.execute('write_file', { path: longPath, content: 'x' });
    const longName = `x\u001b${'n'.repeat(3000)}`;
    await tools.execute(longName, {});
    const shortPath = `src/${'b'.repeat(4092)}`;
    await tools.execute('read_file', { path: shortPath });

    // 경로 인자 상한(4096)을 넘어 거부되는 호출도 저장 요약의 끝에 노린 대상이 남는다
    const padded = `${'./'.repeat(3000)}src/missing.ts`;
    await tools.execute('read_file', { path: padded });

    const [write, unknown, read, paddedRead] = tools.records;
    // 경로는 앞 1/3 · 뒤 2/3 (남길 몫 4095 = 1365 + 2730)
    expect(write?.argsSummary).toBe(`${longPath.slice(0, 1365)}…${longPath.slice(-2730)}`);
    expect(write?.status).not.toBe('ok');
    expect(unknown).toMatchObject({ name: `${longName.slice(0, 1023)}…`, reason: 'unknown_tool' });
    // 정확히 상한(4096)이면 자르지 않는다
    expect(read?.argsSummary).toBe(shortPath);
    expect(shortPath).toHaveLength(4096);
    expect(paddedRead).toMatchObject({ status: 'denied', reason: 'invalid_args' });
    expect(paddedRead?.argsSummary).toHaveLength(4096);
    expect(paddedRead?.argsSummary.endsWith('/./src/missing.ts')).toBe(true);
  });
});

describe('ScriptedAdapter 재생 (happy-path)', () => {
  const run = async (spec: SessionSpec): Promise<SessionEvent[]> => {
    const adapter = new ScriptedAdapter({ scenario: loadScenario('happy-path'), biveHome: home });
    const events: SessionEvent[] = [];
    for await (const event of adapter.startSession(spec)) events.push(event);
    return events;
  };
  const base = {
    systemPrompt: '역할 지침',
    prompt: '작업 지시',
    budget: { maxBudgetUsd: 5, maxTurns: 100 },
    model: 'model-a',
    vars: { requirementId: 'REQ-1', ruleId: 'RULE-001' },
  };

  it('rule-writer의 propose_rule 2건이 콜백으로 등록되고 기록된다', async () => {
    const titles: string[] = [];
    const tools = createRoleTools({
      role: 'rule-writer',
      sessionRoot: session,
      biveHome: home,
      hooks: { proposeRule: (input) => (titles.push(input.title), `제안 ${titles.length}`) },
    });

    const events = await run({ ...base, role: 'rule-writer', workDir: session, tools });

    expect(titles).toEqual(['헬스 체크 응답의 서버 시각', '헬스 체크 응답 형식 유지']);
    expect(
      events
        .filter((e) => e.type === 'tool_result')
        .map((e) => e.type === 'tool_result' && e.result.status),
    ).toEqual(['ok', 'ok']);
    expect(tools.records.map((record) => record.status)).toEqual(['ok', 'ok']);
  });

  it('test-writer는 세션 디렉터리의 bive-acceptance에 인수 테스트를 쓴다', async () => {
    const tools = createRoleTools({ role: 'test-writer', sessionRoot: session, biveHome: home });

    await run({ ...base, role: 'test-writer', workDir: session, tools });

    expect(tools.records).toEqual([
      expect.objectContaining({
        name: 'write_file',
        argsSummary: 'bive-acceptance/RULE-001/health-time.acc.ts',
        status: 'ok',
      }),
    ]);
    expect(
      readFileSync(path.join(session, 'bive-acceptance', 'RULE-001', 'health-time.acc.ts'), 'utf8'),
    ).toContain('RULE-001');
  });

  it('implementer는 워크트리의 route.ts를 읽고 고친다', async () => {
    const tools = createRoleTools({ role: 'implementer', sessionRoot: worktree, biveHome: home });

    await run({ ...base, role: 'implementer', workDir: worktree, tools });

    expect(tools.records.map(({ name, status }) => [name, status])).toEqual([
      ['read_file', 'ok'],
      ['write_file', 'ok'],
    ]);
    expect(
      readFileSync(path.join(worktree, 'src', 'app', 'api', 'health', 'route.ts'), 'utf8'),
    ).toContain('time: new Date().toISOString()');
  });
});
