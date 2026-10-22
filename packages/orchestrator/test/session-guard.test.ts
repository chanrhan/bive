// 세션 가드 (이슈 #20 수용 기준 4, NFR-02 · ADR-024 · ADR-052).
// ScriptedAdapter의 init 이벤트를 역할 허용 목록과 대조해, 도구 목록이나 MCP 서버가 다르면
// 세션을 중단(signal abort + 사유)하고 도구 목록 · MCP 수를 기록하는지 확인한다.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentRole, ToolManifestEntry } from '@bive/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  SessionEvent,
  SessionInitEvent,
  SessionSpec,
  ToolExecutor,
} from '../src/agent/adapter.js';
import { loadScenario } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import { ROLE_TOOL_NAMES } from '../src/tools/definitions.js';
import { createRoleTools, type FixedToolExecutor } from '../src/tools/executor.js';
import { checkSessionInit, guardSession, SessionGuardError } from '../src/tools/session-guard.js';

let home: string;
let worktree: string;
const tempDirs: string[] = [];

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bive-session-guard-')));
  tempDirs.push(home);
  worktree = path.join(home, 'work', 'p1', 'worktrees', 'r1');
  mkdirSync(path.join(worktree, 'src'), { recursive: true });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const adapter = (): ScriptedAdapter =>
  new ScriptedAdapter({ scenario: loadScenario('happy-path'), biveHome: home, pollIntervalMs: 10 });

const spec = (role: AgentRole, tools: ToolExecutor, signal: AbortSignal): SessionSpec => ({
  role,
  systemPrompt: '역할 지침',
  prompt: '작업 지시',
  workDir: worktree,
  tools,
  budget: { maxBudgetUsd: 5, maxTurns: 100 },
  model: 'model-a',
  signal,
  vars: { requirementId: 'REQ-1', ruleId: 'RULE-001' },
});

const implementerTools = (): FixedToolExecutor =>
  createRoleTools({ role: 'implementer', sessionRoot: worktree, biveHome: home });

/** init 이벤트만 바꿔 끼우는 래퍼 (계정 MCP · 내장 도구가 붙은 SDK 세션을 흉내 낸다). */
async function* patchInit(
  events: AsyncIterable<SessionEvent>,
  patch: (init: SessionInitEvent) => SessionInitEvent,
): AsyncGenerator<SessionEvent> {
  for await (const event of events) yield event.type === 'init' ? patch(event) : event;
}

interface GuardRun {
  events: SessionEvent[];
  error: unknown;
  manifests: ToolManifestEntry[];
  controller: AbortController;
}

const runGuarded = async (
  role: AgentRole,
  tools: ToolExecutor,
  patch?: (init: SessionInitEvent) => SessionInitEvent,
  expectation: { tools?: readonly string[]; mcpServers?: readonly string[] } = {},
): Promise<GuardRun> => {
  const controller = new AbortController();
  const manifests: ToolManifestEntry[] = [];
  const raw = adapter().startSession(spec(role, tools, controller.signal));
  const source = patch === undefined ? raw : patchInit(raw, patch);
  const events: SessionEvent[] = [];
  let error: unknown = null;
  try {
    for await (const event of guardSession(source, {
      role,
      controller,
      onManifest: (manifest) => manifests.push(manifest),
      ...expectation,
    })) {
      events.push(event);
    }
  } catch (caught) {
    error = caught;
  }
  return { events, error, manifests, controller };
};

describe('허용 목록과 같은 init', () => {
  it('implementer 세션은 끝까지 진행하고 도구 목록 · MCP 수를 기록한다', async () => {
    const tools = implementerTools();

    const run = await runGuarded('implementer', tools);

    expect(run.error).toBeNull();
    expect(run.controller.signal.aborted).toBe(false);
    expect(run.events.at(-1)?.type).toBe('result');
    expect(run.manifests).toEqual([
      { role: 'implementer', tools: [...ROLE_TOOL_NAMES.implementer], mcpServerCount: 1 },
    ]);
    // 도구 호출은 실제 실행기로 넘어갔다
    expect(tools.records.map((record) => record.name)).toEqual(['read_file', 'write_file']);
  });

  it('SDK식 이름(mcp__bive__도구)도 같은 도구로 본다', async () => {
    const run = await runGuarded('implementer', implementerTools(), (init) => ({
      ...init,
      tools: init.tools.map((name) => `mcp__bive__${name}`),
    }));

    expect(run.error).toBeNull();
    expect(run.manifests[0]?.tools[0]).toBe('mcp__bive__read_file');
  });
});

describe('허용 목록과 다른 init → 세션 중단', () => {
  it('계정 MCP 서버가 붙으면 중단하고 MCP 수 2를 기록한다', async () => {
    const tools = implementerTools();

    const run = await runGuarded('implementer', tools, (init) => ({
      ...init,
      tools: [...init.tools, 'mcp__account-drive__search'],
      mcpServers: [...init.mcpServers, 'account-drive'],
    }));

    expect(run.error).toBeInstanceOf(SessionGuardError);
    const error = run.error as SessionGuardError;
    expect(error.code).toBe('guard_violation');
    expect(error.violation).toMatchObject({
      kind: 'mcp_mismatch',
      unexpectedMcpServers: ['account-drive'],
      unexpectedTools: ['mcp__account-drive__search'],
    });
    expect(error.message).toContain('account-drive');
    expect(run.controller.signal.aborted).toBe(true);
    expect(run.controller.signal.reason).toBe(error);
    expect(run.manifests).toEqual([
      {
        role: 'implementer',
        tools: [...ROLE_TOOL_NAMES.implementer, 'mcp__account-drive__search'],
        mcpServerCount: 2,
      },
    ]);
    expect(error.manifest).toEqual(run.manifests[0]);
    // init 다음으로 넘어가지 않았다: 이벤트 0개 · 도구 호출 0건
    expect(run.events).toEqual([]);
    expect(tools.records).toEqual([]);
  });

  it('MCP 서버가 없어도(고정 도구 서버 누락) 중단한다', async () => {
    const run = await runGuarded('implementer', implementerTools(), (init) => ({
      ...init,
      mcpServers: [],
    }));

    expect((run.error as SessionGuardError).violation).toMatchObject({
      kind: 'mcp_mismatch',
      missingMcpServers: ['bive'],
    });
    expect(run.manifests[0]?.mcpServerCount).toBe(0);
  });

  it('실행기 도구 목록에 내장 도구(Bash)가 섞이면 중단한다', async () => {
    const inner = implementerTools();
    const leaky: ToolExecutor = {
      toolNames: [...inner.toolNames, 'Bash'],
      execute: (name, args) => inner.execute(name, args),
    };

    const run = await runGuarded('implementer', leaky);

    expect((run.error as SessionGuardError).violation).toMatchObject({
      kind: 'tools_mismatch',
      unexpectedTools: ['Bash'],
      missingTools: [],
    });
    expect(run.controller.signal.aborted).toBe(true);
    expect(run.manifests[0]).toMatchObject({ mcpServerCount: 1 });
    expect(run.manifests[0]?.tools).toContain('Bash');
    expect(inner.records).toEqual([]);
  });

  it('승인 도구가 init에 있으면 중단한다', async () => {
    const run = await runGuarded(
      'rule-writer',
      createRoleTools({ role: 'rule-writer', sessionRoot: worktree, biveHome: home }),
      (init) => ({
        ...init,
        tools: [...init.tools, 'mcp__bive__proposal_approve'],
      }),
    );

    expect((run.error as SessionGuardError).violation.unexpectedTools).toEqual([
      'proposal_approve',
    ]);
  });

  it('역할과 다른 도구 세트(rule-writer 세션에 implementer 도구)면 중단한다', async () => {
    const run = await runGuarded('rule-writer', implementerTools());

    const { violation } = run.error as SessionGuardError;
    expect(violation.kind).toBe('tools_mismatch');
    expect(violation.missingTools).toEqual(['propose_rule']);
    expect(violation.unexpectedTools).toContain('write_file');
    expect(run.manifests[0]).toMatchObject({ role: 'rule-writer', mcpServerCount: 1 });
  });

  it('허용 도구가 빠져도 중단한다', async () => {
    const run = await runGuarded('implementer', implementerTools(), (init) => ({
      ...init,
      tools: init.tools.filter((name) => name !== 'run_tests'),
    }));

    expect((run.error as SessionGuardError).violation).toMatchObject({
      kind: 'tools_mismatch',
      missingTools: ['run_tests'],
    });
  });

  it('init 없이 다른 이벤트가 먼저 오면 중단한다', async () => {
    const controller = new AbortController();
    async function* noInit(): AsyncGenerator<SessionEvent> {
      yield { type: 'turn_start', turn: 1 };
      yield { type: 'message', turn: 1, text: '안녕' };
    }
    const events: SessionEvent[] = [];

    await expect(async () => {
      for await (const event of guardSession(noInit(), { role: 'implementer', controller })) {
        events.push(event);
      }
    }).rejects.toMatchObject({ code: 'guard_violation', violation: { kind: 'init_missing' } });
    expect(controller.signal.aborted).toBe(true);
    expect(events).toEqual([]);
  });
});

describe('checkSessionInit', () => {
  const init = (tools: string[], mcpServers: string[]): SessionInitEvent => ({
    type: 'init',
    sessionId: 's1',
    model: 'model-a',
    tools,
    mcpServers,
  });

  it('순서는 무시하고 집합으로 비교한다', () => {
    const tools = [...ROLE_TOOL_NAMES['test-writer']].reverse();
    expect(checkSessionInit(init(tools, ['bive']), { role: 'test-writer' }).violation).toBeNull();
  });

  it('다른 서버 접두(mcp__evil__) · 이중 접두는 같은 이름이어도 허용 도구로 보지 않는다', () => {
    const base = ROLE_TOOL_NAMES['test-writer'].slice(0, 4);
    for (const impostor of ['mcp__evil__run_tests', 'mcp__bive__mcp__bive__run_tests']) {
      const { violation } = checkSessionInit(init([...base, impostor], ['bive']), {
        role: 'test-writer',
      });
      expect(violation, impostor).toMatchObject({
        kind: 'tools_mismatch',
        missingTools: ['run_tests'],
      });
      expect(violation?.unexpectedTools).toHaveLength(1);
    }
  });

  it('MCP 서버 이름은 대소문자까지 같아야 한다', () => {
    const tools = [...ROLE_TOOL_NAMES['rule-writer']];
    expect(checkSessionInit(init(tools, ['Bive']), { role: 'rule-writer' }).violation?.kind).toBe(
      'mcp_mismatch',
    );
  });

  it('같은 도구 · 서버의 중복 보고도 다르다고 본다', () => {
    const tools = [...ROLE_TOOL_NAMES['rule-writer']];
    expect(
      checkSessionInit(init(tools, ['bive', 'bive']), { role: 'rule-writer' }).violation?.kind,
    ).toBe('mcp_mismatch');
    expect(
      checkSessionInit(init(['propose_rule', 'mcp__bive__propose_rule'], ['bive']), {
        role: 'rule-writer',
      }).violation?.kind,
    ).toBe('tools_mismatch');
  });

  it('플러그인 · 권한 모드는 보고될 때만 검사한다 (플러그인 0개 · dontAsk만 통과)', () => {
    const tools = [...ROLE_TOOL_NAMES['rule-writer']];
    const base = init(tools, ['bive']);
    const check = (patch: Partial<SessionInitEvent>) =>
      checkSessionInit({ ...base, ...patch }, { role: 'rule-writer' }).violation;
    expect(check({})).toBeNull();
    expect(check({ plugins: [], permissionMode: 'dontAsk' })).toBeNull();
    expect(check({ plugins: ['b-plugin', 'a-plugin'] })).toMatchObject({
      kind: 'plugins_loaded',
      unexpectedPlugins: ['a-plugin', 'b-plugin'],
      unexpectedPermissionMode: null,
    });
    const mode = check({ plugins: [], permissionMode: 'acceptEdits' });
    expect(mode).toMatchObject({
      kind: 'permission_mode_mismatch',
      unexpectedPlugins: [],
      unexpectedPermissionMode: 'acceptEdits',
    });
    expect(new SessionGuardError(mode!, null).message).toContain('권한 모드 acceptEdits');
    // 도구 · MCP 위반이 함께 있으면 그쪽 종류가 먼저다
    expect(check({ mcpServers: [], plugins: ['a-plugin'] })?.kind).toBe('mcp_mismatch');
  });

  it('도구가 없는 역할(chat)은 기대 MCP 서버를 지정해 검사할 수 있다', () => {
    expect(checkSessionInit(init([], []), { role: 'chat', mcpServers: [] }).violation).toBeNull();
    expect(
      checkSessionInit(init([], ['bive']), { role: 'chat', mcpServers: [] }).violation?.kind,
    ).toBe('mcp_mismatch');
  });
});
