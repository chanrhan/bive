// 고정 도구 실행기 · 도구 정의 · 도구 호출 기록 (이슈 #20 수용 기준 3, NFR-01 · NFR-02 · ADR-024 · ADR-052).
// 역할별 도구 세트, 목록 밖 이름의 `unknown_tool` 거부, 제안 콜백, 그리고 모든 호출이
// 경로 또는 명령 · 시각 · 결과와 함께 기록되는지를 ScriptedAdapter 재생까지 포함해 확인한다.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentRole } from '@bive/shared';
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
    expect(ROLE_TOOL_NAMES['rule-writer']).toEqual(['propose_rule']);
    expect(ROLE_TOOL_NAMES['test-writer']).toEqual([...FILE_TOOL_NAMES, 'run_tests']);
    expect(ROLE_TOOL_NAMES.implementer).toEqual([...FILE_TOOL_NAMES, ...COMMAND_TOOL_NAMES]);
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
    rationale: '검사 가능한 형태',
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

  it('기록 요약은 길이가 제한된다', async () => {
    const tools = createRoleTools({ role: 'chat', sessionRoot: session, biveHome: home });
    await tools.execute('anything', { blob: 'x'.repeat(5000) });
    expect(tools.records[0]?.argsSummary.length).toBeLessThanOrEqual(201);
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
