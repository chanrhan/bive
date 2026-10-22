// ClaudeSdkAdapter 옵션 조립 · 스냅샷 (이슈 #39 수용 기준 1~3, NFR-02 · NFR-04 · ADR-007 · ADR-024 · ADR-059).
// `query()`는 주입한 가짜 함수로 바꾸므로 실제 SDK 호출 · 네트워크 · API 키가 없다(ADR-016).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { type AgentRole, defaultSettings, ErrorCode, type Settings } from '@bive/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import type { SessionEvent, SessionSpec, ToolExecutor, ToolResult } from '../src/agent/adapter.js';
import {
  AGENT_FIXED_ENV,
  AgentNotConfiguredError,
  agentEnv,
  buildBiveMcpTools,
  buildQueryOptions,
  ClaudeSdkAdapter,
  QUERY_OPTION_KEYS,
  type QueryFn,
  type QueryOptionsDeps,
  translateSdkMessages,
} from '../src/agent/claude-sdk-adapter.js';
import { RpcError } from '../src/ipc/server.js';
import { roleSessionSettings } from '../src/settings/settings-service.js';
import { createRoleTools } from '../src/tools/executor.js';
import { roleToolNames } from '../src/tools/definitions.js';
import { checkSessionInit, guardSession, SessionGuardError } from '../src/tools/session-guard.js';

const PROJECT_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const CONFIG_DIR = '/tmp/bive-home/agent/claude';
const WORK_DIR = '/tmp/bive-home/work/run-1/implementer';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 역할마다 다른 모델 · 한도를 둔 설정 (모델 ID는 자리 표시 값). */
const settings = (): Settings => {
  const base = defaultSettings(PROJECT_ID);
  return {
    ...base,
    run: { maxBudgetUsd: 10, maxTurns: 500 },
    roles: {
      ...base.roles,
      'rule-writer': { model: 'test-model-rule', maxBudgetUsd: 0.5, maxTurns: 20 },
      'test-writer': { model: 'test-model-writer', maxBudgetUsd: 1.25, maxTurns: 40 },
      implementer: { model: 'test-model-impl', maxBudgetUsd: 3, maxTurns: 120 },
    },
  };
};

const noTools = (role: AgentRole): ToolExecutor => ({
  toolNames: roleToolNames(role),
  execute: () => Promise.resolve({ status: 'ok', content: '' }),
});

const specFor = (role: AgentRole, overrides: Partial<SessionSpec> = {}): SessionSpec => {
  const { model, budget } = roleSessionSettings(settings(), role);
  return {
    role,
    systemPrompt: '역할 지침',
    prompt: '작업 지시',
    workDir: WORK_DIR,
    tools: noTools(role),
    budget,
    model,
    ...overrides,
  };
};

/** 프록시 · 기준 URL · 다른 인증이 섞인 원본 환경. 허용 목록만 옮겨져야 한다. */
const SOURCE_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/tester',
  LANG: 'ko_KR.UTF-8',
  ANTHROPIC_API_KEY: 'test-key',
  HTTPS_PROXY: 'http://proxy.example:3128',
  HTTP_PROXY: 'http://proxy.example:3128',
  https_proxy: 'http://proxy.example:3128',
  ALL_PROXY: 'socks5://proxy.example:1080',
  NO_PROXY: 'localhost',
  ANTHROPIC_BASE_URL: 'https://gateway.example',
  ANTHROPIC_AUTH_TOKEN: 'other-token',
  CLAUDE_CODE_USE_BEDROCK: '1',
  NODE_OPTIONS: '--require /tmp/evil.js',
  NODE_EXTRA_CA_CERTS: '/tmp/ca.pem',
  CLAUDE_CONFIG_DIR: '/home/tester/.claude',
  BIVE_AGENT: 'claude',
};

const deps = (overrides: Partial<QueryOptionsDeps> = {}): QueryOptionsDeps => ({
  env: SOURCE_ENV,
  configDir: CONFIG_DIR,
  abortController: new AbortController(),
  ...overrides,
});

/** 함수 · 서버 인스턴스를 뺀 비교용 모양. */
const plain = (options: Options): Record<string, unknown> => {
  const servers = options.mcpServers ?? {};
  return {
    ...options,
    canUseTool: typeof options.canUseTool,
    abortController: options.abortController instanceof AbortController,
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([name, config]) => [
        name,
        {
          keys: Object.keys(config).sort(),
          type: config.type,
          name: 'name' in config ? config.name : undefined,
        },
      ]),
    ),
  };
};

/** 객체 안 모든 키 경로 (서버 인스턴스 · 함수 · AbortController 내부는 들어가지 않음). */
const keyPaths = (value: unknown, prefix = ''): string[] => {
  if (typeof value !== 'object' || value === null || value instanceof AbortController) return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => keyPaths(item, `${prefix}[${i}]`));
  return Object.entries(value).flatMap(([key, item]) => {
    const here = prefix === '' ? key : `${prefix}.${key}`;
    if (key === 'instance') return [here];
    return [here, ...keyPaths(item, here)];
  });
};

describe('buildQueryOptions 스냅샷 (수용 기준 1 · 2)', () => {
  it('implementer: 내장 도구 없음 · 파일 설정 비로드 · bive MCP 하나 · 세션 저장 안 함 · 한도 · 역할별 모델', () => {
    const spec = specFor('implementer');
    const options = buildQueryOptions(spec, deps());
    expect(plain(options)).toEqual({
      model: 'test-model-impl',
      systemPrompt: '역할 지침',
      cwd: WORK_DIR,
      tools: [],
      allowedTools: [
        'mcp__bive__read_file',
        'mcp__bive__write_file',
        'mcp__bive__list_files',
        'mcp__bive__search_files',
        'mcp__bive__run_tests',
        'mcp__bive__prisma_generate',
        'mcp__bive__prisma_migrate',
        'mcp__bive__install_package',
      ],
      permissionMode: 'dontAsk',
      canUseTool: 'function',
      mcpServers: { bive: { keys: ['instance', 'name', 'type'], type: 'sdk', name: 'bive' } },
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      maxTurns: 120,
      maxBudgetUsd: 3,
      env: {
        PATH: '/usr/bin',
        HOME: '/home/tester',
        LANG: 'ko_KR.UTF-8',
        ANTHROPIC_API_KEY: 'test-key',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CONFIG_DIR: CONFIG_DIR,
      },
      abortController: true,
    });
    // SessionSpec 값 그대로
    expect(options.maxTurns).toBe(spec.budget.maxTurns);
    expect(options.maxBudgetUsd).toBe(spec.budget.maxBudgetUsd);
  });

  it.each([
    ['rule-writer', 'test-model-rule', 0.5, 20],
    ['test-writer', 'test-model-writer', 1.25, 40],
    ['implementer', 'test-model-impl', 3, 120],
  ] as const)(
    '%s: model은 설정의 역할별 모델, 한도는 역할별 값',
    (role, model, maxBudgetUsd, maxTurns) => {
      const options = buildQueryOptions(specFor(role), deps());
      expect(options.model).toBe(model);
      expect(options.maxBudgetUsd).toBe(maxBudgetUsd);
      expect(options.maxTurns).toBe(maxTurns);
      expect(options.tools).toEqual([]);
      expect(options.settingSources).toEqual([]);
      expect(options.strictMcpConfig).toBe(true);
      expect(options.persistSession).toBe(false);
      expect(Object.keys(options.mcpServers ?? {})).toEqual(['bive']);
    },
  );

  it.each(['rule-writer', 'planner', 'test-writer', 'implementer', 'chat'] as const)(
    '%s: 옵션 키는 허용 목록과 정확히 같고 agents · agent 키가 없다 (ADR-007)',
    (role) => {
      const spec = specFor(role === 'planner' || role === 'chat' ? 'implementer' : role, {
        role,
        tools: noTools(role),
      });
      const options = buildQueryOptions(spec, deps());
      expect(Object.keys(options).sort()).toEqual([...QUERY_OPTION_KEYS].sort());
      expect(options).not.toHaveProperty('agents');
      expect(options).not.toHaveProperty('agent');
      expect(options).not.toHaveProperty('plugins');
      expect(options).not.toHaveProperty('settings');
      expect(options).not.toHaveProperty('extraArgs');
    },
  );

  it('도구 이름은 세션 가드의 mcp__bive__ 접두와 맞고 init 검사를 통과한다', () => {
    for (const role of ['rule-writer', 'test-writer', 'implementer', 'planner', 'chat'] as const) {
      const spec = specFor('implementer', { role, tools: noTools(role) });
      const options = buildQueryOptions(spec, deps());
      const tools = options.allowedTools ?? [];
      expect(tools.every((name) => name.startsWith('mcp__bive__'))).toBe(true);
      const check = checkSessionInit(
        { type: 'init', sessionId: 's', model: spec.model, tools, mcpServers: ['bive'] },
        { role },
      );
      expect(check.violation).toBeNull();
    }
  });

  it('canUseTool은 역할 도구만 허용하고 나머지(내장 · 다른 서버 · 다른 역할 도구)는 거부한다', async () => {
    const options = buildQueryOptions(specFor('test-writer'), deps());
    const canUseTool = options.canUseTool;
    if (canUseTool === undefined) throw new Error('canUseTool 없음');
    const ask = (name: string) =>
      canUseTool(name, { path: 'a' }, { signal: new AbortController().signal } as Parameters<
        typeof canUseTool
      >[2]);
    await expect(ask('mcp__bive__read_file')).resolves.toMatchObject({ behavior: 'allow' });
    for (const name of [
      'Bash',
      'Read',
      'Agent',
      'mcp__evil__read_file',
      'mcp__bive__prisma_migrate',
    ]) {
      await expect(ask(name)).resolves.toMatchObject({ behavior: 'deny' });
    }
  });
});

describe('모델 API 외 목적지 없음 (수용 기준 3, NFR-04)', () => {
  it('옵션 어디에도 프록시 · 기준 URL · 원격 MCP 설정이 없다', () => {
    const options = buildQueryOptions(specFor('implementer'), deps());
    const paths = keyPaths(options);
    expect(paths.filter((key) => /proxy|base_?url|url|endpoint|host|headers/i.test(key))).toEqual(
      [],
    );
    // MCP 서버는 인프로세스(sdk) 하나뿐: command · url · args가 없다
    for (const config of Object.values(options.mcpServers ?? {})) {
      expect(config.type).toBe('sdk');
      expect(config).not.toHaveProperty('url');
      expect(config).not.toHaveProperty('command');
      expect(config).not.toHaveProperty('args');
    }
    // 직렬화한 옵션에 URL이 없다 (서버 인스턴스 · 함수 제외)
    const text = JSON.stringify(options, (key, value: unknown) =>
      key === 'instance' || key === 'abortController' ? undefined : value,
    );
    expect(text).not.toMatch(/https?:\/\/|socks5?:\/\//i);
  });

  it('하위 프로세스 환경은 허용 목록 + 고정 변수뿐 (프록시 · 기준 URL · 다른 인증 · NODE_OPTIONS 없음)', () => {
    const env = agentEnv(SOURCE_ENV, CONFIG_DIR);
    for (const key of [
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'https_proxy',
      'ALL_PROXY',
      'NO_PROXY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'NODE_OPTIONS',
      'NODE_EXTRA_CA_CERTS',
      'BIVE_AGENT',
    ]) {
      expect(env).not.toHaveProperty(key);
    }
    // 사용자 설정 폴더 대신 BIVE 전용 폴더
    expect(env.CLAUDE_CONFIG_DIR).toBe(CONFIG_DIR);
    expect(env).toMatchObject(AGENT_FIXED_ENV);
  });
});

describe('설정 → SessionSpec · 미설정 거부', () => {
  it('roleSessionSettings: 역할별 모델 · 한도, cap으로 더 작게 묶는다', () => {
    expect(roleSessionSettings(settings(), 'implementer')).toEqual({
      model: 'test-model-impl',
      budget: { maxBudgetUsd: 3, maxTurns: 120 },
    });
    expect(
      roleSessionSettings(settings(), 'implementer', { maxBudgetUsd: 1.5, maxTurns: 500 }),
    ).toEqual({ model: 'test-model-impl', budget: { maxBudgetUsd: 1.5, maxTurns: 120 } });
  });

  it('roleSessionSettings: 미설정이면 -32010 (requireRunnableSettings와 같은 오류)', () => {
    const empty = defaultSettings(PROJECT_ID);
    let caught: unknown;
    try {
      roleSessionSettings(empty, 'test-writer');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect(caught).toMatchObject({
      code: ErrorCode.SettingsIncomplete,
      message: '예산 · 모델 미설정',
      data: {
        reason: 'SETTINGS_INCOMPLETE',
        missing: [
          'run.maxBudgetUsd',
          'run.maxTurns',
          'roles.test-writer.model',
          'roles.test-writer.maxBudgetUsd',
          'roles.test-writer.maxTurns',
        ],
      },
    });
  });

  it.each([
    [{ model: '  ' }, 'roles.implementer.model'],
    [{ budget: { maxBudgetUsd: 0, maxTurns: 10 } }, 'roles.implementer.maxBudgetUsd'],
    [{ budget: { maxBudgetUsd: Number.NaN, maxTurns: 10 } }, 'roles.implementer.maxBudgetUsd'],
    [{ budget: { maxBudgetUsd: 1, maxTurns: 0 } }, 'roles.implementer.maxTurns'],
    [{ budget: { maxBudgetUsd: 1, maxTurns: 2.5 } }, 'roles.implementer.maxTurns'],
  ] as const)(
    'buildQueryOptions: 모델 · 한도가 비거나 잘못되면 -32010 (%j)',
    (override, missing) => {
      expect(() => buildQueryOptions(specFor('implementer', override), deps())).toThrow(
        expect.objectContaining({
          code: ErrorCode.SettingsIncomplete,
          data: expect.objectContaining({ missing: [missing] }) as unknown,
        }) as Error,
      );
    },
  );
});

describe('bive MCP 도구 (고정 도구 실행기에 위임)', () => {
  it('역할 도구 정의를 그대로 감싸고 핸들러는 실행기에 넘긴다', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const executor: ToolExecutor = {
      toolNames: roleToolNames('test-writer'),
      execute: (name, args) => {
        calls.push([name, args]);
        return Promise.resolve(
          name === 'read_file'
            ? { status: 'ok', content: '본문' }
            : { status: 'denied', content: '거부됨: 경로', reason: 'path_denied' },
        );
      },
    };
    const notified: [string | undefined, string, ToolResult][] = [];
    const tools = buildBiveMcpTools('test-writer', executor, (...args) => notified.push(args));
    expect(tools.map((item) => item.name)).toEqual([...roleToolNames('test-writer')]);

    const read = tools.find((item) => item.name === 'read_file');
    const write = tools.find((item) => item.name === 'write_file');
    if (read === undefined || write === undefined) throw new Error('도구 없음');
    await expect(
      read.handler({ path: 'a.txt' }, { _meta: { 'claudecode/toolUseId': 'tu-1' } }),
    ).resolves.toEqual({ content: [{ type: 'text', text: '본문' }], isError: false });
    await expect(write.handler({ path: '../x', content: '' }, {})).resolves.toEqual({
      content: [{ type: 'text', text: '거부됨: 경로' }],
      isError: true,
    });
    expect(calls).toEqual([
      ['read_file', { path: 'a.txt' }],
      ['write_file', { path: '../x', content: '' }],
    ]);
    expect(notified).toEqual([
      ['tu-1', 'read_file', { status: 'ok', content: '본문' }],
      [
        undefined,
        'write_file',
        { status: 'denied', content: '거부됨: 경로', reason: 'path_denied' },
      ],
    ]);
  });

  it('실행기 예외는 오류 결과(executor_error)로 바꾼다', async () => {
    const executor: ToolExecutor = {
      toolNames: roleToolNames('rule-writer'),
      execute: () => Promise.reject(new Error('폭발')),
    };
    const [propose] = buildBiveMcpTools('rule-writer', executor);
    if (propose === undefined) throw new Error('도구 없음');
    await expect(propose.handler({}, {})).resolves.toEqual({
      content: [{ type: 'text', text: '폭발' }],
      isError: true,
    });
  });

  it('도구가 없는 역할은 빈 도구 목록 (bive 서버는 그대로 하나)', () => {
    expect(buildBiveMcpTools('planner', noTools('planner'))).toEqual([]);
    expect(buildBiveMcpTools('chat', noTools('chat'))).toEqual([]);
  });
});

// ── 어댑터: 가짜 query로 SDK 메시지 흐름을 흉내 낸다 ──────────────

const msg = (value: Record<string, unknown>): SDKMessage => value as unknown as SDKMessage;

const initMessage = (options: Options, extraServers: string[] = []): SDKMessage =>
  msg({
    type: 'system',
    subtype: 'init',
    session_id: 'sess-1',
    model: options.model,
    tools: options.allowedTools,
    mcp_servers: [...Object.keys(options.mcpServers ?? {}), ...extraServers].map((name) => ({
      name,
      status: 'connected',
    })),
    parent_tool_use_id: undefined,
  });

const resultMessage = (overrides: Record<string, unknown> = {}): SDKMessage =>
  msg({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    total_cost_usd: 0.12,
    modelUsage: {
      'test-model-impl': {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 1,
        webSearchRequests: 0,
        costUSD: 0.12,
        contextWindow: 1000,
        maxOutputTokens: 100,
      },
    },
    ...overrides,
  });

const collect = async (events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> => {
  const out: SessionEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};

/** 옵션의 bive 서버에 MCP 클라이언트로 붙어 도구를 부른다 (SDK가 하는 일과 같은 경로). */
const callBiveTool = async (
  options: Options,
  name: string,
  args: Record<string, unknown>,
  toolUseId: string,
): Promise<void> => {
  const config = options.mcpServers?.bive;
  if (config === undefined || config.type !== 'sdk' || !('instance' in config)) {
    throw new Error('bive 서버 없음');
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await config.instance.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  try {
    await client.callTool({
      name,
      arguments: args,
      _meta: { 'claudecode/toolUseId': toolUseId },
    });
  } finally {
    await client.close();
  }
};

describe('ClaudeSdkAdapter (가짜 query)', () => {
  it('SDK 메시지를 AgentAdapter 이벤트로 옮기고 도구는 실제 고정 도구 실행기로 실행한다', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'bive-sdk-'));
    tempDirs.push(root);
    const biveHome = path.join(root, 'home');
    const sessionRoot = path.join(root, 'work');
    mkdirSync(sessionRoot, { recursive: true });
    writeFileSync(path.join(sessionRoot, 'a.txt'), '파일 내용');
    const tools = createRoleTools({ role: 'implementer', sessionRoot, biveHome });

    const received: { prompt: string; options: Options }[] = [];
    const query: QueryFn = async function* (params) {
      received.push(params);
      const { options } = params;
      yield initMessage(options);
      yield msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { id: 'm1', content: [{ type: 'text', text: '파일을 읽는다' }] },
      });
      yield msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'm1',
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'mcp__bive__read_file',
              input: { path: 'a.txt' },
            },
          ],
        },
      });
      await callBiveTool(options, 'read_file', { path: 'a.txt' }, 'tu-1');
      yield msg({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: '파일 내용' }],
        },
      });
      // 서브 에이전트 메시지는 버린다
      yield msg({
        type: 'assistant',
        parent_tool_use_id: 'tu-x',
        message: { id: 'sub', content: [{ type: 'text', text: '무시' }] },
      });
      yield msg({ type: 'stream_event', event: {} });
      yield msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { id: 'm2', content: [{ type: 'text', text: '끝' }] },
      });
      yield resultMessage();
      throw new Error('결과 뒤는 읽지 않아야 함');
    };

    const adapter = new ClaudeSdkAdapter({
      biveHome,
      env: { ANTHROPIC_API_KEY: 'test-key', PATH: '/usr/bin' },
      query,
    });
    const spec = specFor('implementer', { workDir: sessionRoot, tools });
    const events = await collect(adapter.startSession(spec));

    expect(received).toHaveLength(1);
    expect(received[0]?.prompt).toBe('작업 지시');
    expect(received[0]?.options.cwd).toBe(sessionRoot);
    expect(received[0]?.options.env?.CLAUDE_CONFIG_DIR).toBe(
      path.join(biveHome, 'agent', 'claude'),
    );

    expect(events).toEqual([
      {
        type: 'init',
        sessionId: 'sess-1',
        model: 'test-model-impl',
        tools: roleToolNames('implementer').map((name) => `mcp__bive__${name}`),
        mcpServers: ['bive'],
      },
      { type: 'turn_start', turn: 1 },
      { type: 'message', turn: 1, text: '파일을 읽는다' },
      {
        type: 'tool_call',
        turn: 1,
        callId: 'tu-1',
        name: 'read_file',
        args: { path: 'a.txt' },
      },
      {
        type: 'tool_result',
        turn: 1,
        callId: 'tu-1',
        name: 'read_file',
        result: { status: 'ok', content: '파일 내용' },
      },
      { type: 'turn_start', turn: 2 },
      { type: 'message', turn: 2, text: '끝' },
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.12,
        num_turns: 2,
        modelUsage: {
          'test-model-impl': {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 5,
            cacheCreationInputTokens: 1,
            costUSD: 0.12,
          },
        },
      },
    ]);
    // 실행기가 호출을 기록했다 (NFR-02)
    expect(tools.records.map((record) => [record.name, record.status])).toEqual([
      ['read_file', 'ok'],
    ]);
  });

  it('세션 가드와 함께 쓰면 추가 MCP 서버가 보고된 세션을 멈춘다', async () => {
    const query: QueryFn = async function* ({ options }) {
      yield initMessage(options, ['account-connector']);
      yield resultMessage();
    };
    const adapter = new ClaudeSdkAdapter({
      biveHome: '/tmp/bive-home',
      env: { ANTHROPIC_API_KEY: 'test-key' },
      configDir: mkdtempSync(path.join(os.tmpdir(), 'bive-cfg-')),
      query,
    });
    const controller = new AbortController();
    const events = guardSession(
      adapter.startSession(specFor('test-writer', { signal: controller.signal })),
      { role: 'test-writer', controller },
    );
    await expect(collect(events)).rejects.toBeInstanceOf(SessionGuardError);
    expect(controller.signal.aborted).toBe(true);
  });

  it('중단 신호는 SDK abortController로 이어지고 순회는 signal.reason으로 끝난다', async () => {
    let sdkSignal: AbortSignal | undefined;
    const query: QueryFn = async function* ({ options }) {
      sdkSignal = options.abortController?.signal;
      yield initMessage(options);
      await new Promise<void>((resolve) => sdkSignal?.addEventListener('abort', () => resolve()));
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    const adapter = new ClaudeSdkAdapter({
      biveHome: '/tmp/bive-home',
      env: { ANTHROPIC_API_KEY: 'test-key' },
      configDir: mkdtempSync(path.join(os.tmpdir(), 'bive-cfg-')),
      query,
    });
    const controller = new AbortController();
    const iterator = adapter
      .startSession(specFor('implementer', { signal: controller.signal }))
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'init' } });
    const reason = new Error('사용자 중단');
    const pending = iterator.next();
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(sdkSignal?.aborted).toBe(true);
  });

  it('API 키가 없으면 query를 부르지 않고 not_configured', async () => {
    let called = false;
    const query: QueryFn = async function* () {
      called = true;
      yield resultMessage();
    };
    const adapter = new ClaudeSdkAdapter({ biveHome: '/tmp/bive-home', env: {}, query });
    await expect(collect(adapter.startSession(specFor('implementer')))).rejects.toBeInstanceOf(
      AgentNotConfiguredError,
    );
    expect(called).toBe(false);
  });
});

describe('translateSdkMessages', () => {
  const run = async (messages: SDKMessage[]): Promise<SessionEvent[]> => {
    async function* source(): AsyncGenerator<SDKMessage> {
      yield* messages;
    }
    return collect(translateSdkMessages(source()));
  };

  it.each([
    [{ subtype: 'error_max_turns' }, 'error_max_turns'],
    [{ subtype: 'error_max_budget_usd' }, 'error_max_budget_usd'],
    [{ subtype: 'error_during_execution', is_error: true }, 'error_during_execution'],
    [{ subtype: 'error_max_structured_output_retries' }, 'error_during_execution'],
    [{ subtype: 'success', is_error: true }, 'error_during_execution'],
  ] as const)('결과 subtype 대응 (%j → %s)', async (overrides, expected) => {
    const [event] = await run([resultMessage(overrides)]);
    expect(event).toMatchObject({ type: 'result', subtype: expected });
  });

  it('비용을 모르면 null (0이 아님, COST-02)', async () => {
    const [event] = await run([resultMessage({ total_cost_usd: undefined, modelUsage: {} })]);
    expect(event).toEqual({
      type: 'result',
      subtype: 'success',
      total_cost_usd: null,
      num_turns: 2,
      modelUsage: {},
    });
  });

  it('실행기를 거치지 않은 오류 tool_result는 error 결과', async () => {
    const events = await run([
      msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'm1',
          content: [{ type: 'tool_use', id: 'tu-9', name: 'mcp__bive__read_file', input: {} }],
        },
      }),
      msg({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-9',
              is_error: true,
              content: [{ type: 'text', text: '권한 거부' }],
            },
          ],
        },
      }),
      resultMessage(),
    ]);
    expect(events[2]).toEqual({
      type: 'tool_result',
      turn: 1,
      callId: 'tu-9',
      name: 'read_file',
      result: { status: 'error', content: '권한 거부', reason: 'tool_failed' },
    });
  });

  it('결과 없이 끝나면 오류', async () => {
    await expect(run([msg({ type: 'system', subtype: 'status' })])).rejects.toThrow(
      '세션 결과 없이',
    );
  });
});
