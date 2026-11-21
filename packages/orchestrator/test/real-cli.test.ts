// 번들된 실제 CLI 대조 (이슈 #205 수용 기준 2 · 3 · 4, ADR-098 · ADR-059 · NFR-02 · NFR-04).
// SDK에 든 실제 CLI 실행 파일을 제품과 같은 옵션 · 환경(`buildQueryOptions` · `agentEnv`)으로 띄운다. 실제 키 · 실제
// 모델 API는 쓰지 않는다: 키는 형식만 맞춘 가짜 값이고, 모델 API 주소(`ANTHROPIC_BASE_URL`)만 이 시험이 띄운 로컬
// 가짜 Messages API(127.0.0.1)로 바꾼다(제품의 `agentEnv`는 이 변수를 넘기지 않는다, ADR-059). 가짜 API는 정해 둔
// 응답(텍스트 또는 tool_use)을 돌려주고 CLI가 보낸 요청 본문을 기록한다. 세션은 시험마다 끝나거나 중단되고, 어댑터가
// 끝에 SDK 중단 신호를 보내 CLI 자식 프로세스를 정리한다.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { type CanUseTool, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRole } from '@bive/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { SessionEvent, SessionSpec, ToolResult } from '../src/agent/adapter.js';
import {
  AGENT_API_KEY_ENV,
  ClaudeSdkAdapter,
  type QueryFn,
  SDK_DENIED_REASON,
  sdkToolName,
} from '../src/agent/claude-sdk-adapter.js';
import { BIVE_MCP_SERVER, roleToolNames } from '../src/tools/definitions.js';
import { guardSession, REQUIRED_PERMISSION_MODE } from '../src/tools/session-guard.js';

/** 시험 하나의 제한 시간. CLI 기동은 이 VM에서 1초 안팎이다. */
const TEST_TIMEOUT_MS = 60_000;

/** 형식만 맞춘 가짜 키 (실제 키 아님). */
const FAKE_API_KEY = `sk-ant-api03-${'x'.repeat(93)}-AA`;

const AGENTS_MD_MARKER = 'AGENTS_MD_MARKER_205';
const CLAUDE_MD_MARKER = 'CLAUDE_MD_MARKER_205';
const PROMPT_MARKER = 'PROMPT_MARKER_205';

interface ScriptedToolUse {
  name: string;
  input: Record<string, unknown>;
}

/** 가짜 Messages API: 주 세션 요청(`mcp__bive__` 도구를 실은 요청)마다 차례로 tool_use를 내고, 다 쓰면 텍스트로 끝낸다. */
class FakeMessagesApi {
  readonly bodies: string[] = [];
  private script: ScriptedToolUse[] = [];
  private readonly server: Server;
  private port = 0;

  constructor() {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => this.handle(req.method ?? '', req.url ?? '', body, res));
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(script: ScriptedToolUse[] = []): void {
    this.bodies.length = 0;
    this.script = [...script];
  }

  private handle(method: string, url: string, body: string, res: ServerResponse): void {
    if (method !== 'POST' || !url.startsWith('/v1/messages') || url.includes('count_tokens')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"not_found_error","message":"없음"}}');
      return;
    }
    this.bodies.push(body);
    const request = JSON.parse(body) as { model?: string; tools?: { name?: string }[] };
    const isMain = (request.tools ?? []).some((tool) => tool.name?.startsWith('mcp__bive__'));
    const next = isMain ? this.script.shift() : undefined;
    const id = `msg_${this.bodies.length}`;
    const start = {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: request.model ?? 'test-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    const block =
      next === undefined
        ? [
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '끝' } },
          ]
        : [
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: `toolu_${id}`, name: next.name, input: {} },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(next.input) },
            },
          ];
    const events = [
      start,
      ...block,
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: next === undefined ? 'end_turn' : 'tool_use', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events)
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  }
}

const api = new FakeMessagesApi();
const tempDirs: string[] = [];

beforeAll(() => api.listen());
afterAll(() => api.close());
beforeEach(() => api.reset());
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface CliRun {
  events: SessionEvent[];
  /** CLI가 보낸 `system/init` 원문 */
  rawInit: Record<string, unknown> | undefined;
  /** 제품의 `canUseTool`이 불린 도구 이름 */
  canUseToolCalls: string[];
  /** 실행기(고정 도구)에 닿은 도구 이름 */
  executed: string[];
}

interface CliRunOptions {
  /** 작업 폴더에 둘 파일 (상대 경로 → 내용) */
  files?: Record<string, string>;
  /** 제품 옵션에서 뺄 허용 도구 (허용 목록 밖 도구의 거부 경로를 보는 시험만) */
  dropAllowedTool?: string;
}

/**
 * 실제 SDK 어댑터 + 실제 CLI로 세션 하나를 돌리고 세션 가드를 건다. `query`는 실제 SDK 함수이고, 제품이 만든 옵션에서
 * 모델 API 주소만 가짜 API로 바꾸며 `canUseTool` 호출을 센다(판단은 제품 함수 그대로).
 */
const runCli = async (role: AgentRole, options: CliRunOptions = {}): Promise<CliRun> => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bive-cli-'));
  tempDirs.push(root);
  const workDir = path.join(root, 'work');
  const home = path.join(root, 'home');
  mkdirSync(workDir);
  mkdirSync(home);
  for (const [name, content] of Object.entries(options.files ?? {})) {
    writeFileSync(path.join(workDir, name), content);
  }
  const run: CliRun = { events: [], rawInit: undefined, canUseToolCalls: [], executed: [] };
  const query: QueryFn = async function* ({ prompt, options: productOptions }) {
    const productCanUseTool = productOptions.canUseTool;
    if (productCanUseTool === undefined) throw new Error('canUseTool 없음');
    const canUseTool: CanUseTool = (toolName, input, context) => {
      run.canUseToolCalls.push(toolName);
      return productCanUseTool(toolName, input, context);
    };
    const allowedTools = (productOptions.allowedTools ?? []).filter(
      (name) => name !== options.dropAllowedTool,
    );
    for await (const message of sdkQuery({
      prompt,
      options: {
        ...productOptions,
        allowedTools,
        canUseTool,
        env: { ...productOptions.env, ANTHROPIC_BASE_URL: api.baseUrl },
      },
    })) {
      const raw = message as unknown as Record<string, unknown>;
      if (raw.type === 'system' && raw.subtype === 'init') run.rawInit ??= raw;
      yield message;
    }
  };
  const adapter = new ClaudeSdkAdapter({
    biveHome: path.join(root, 'bive'),
    env: { PATH: process.env.PATH, HOME: home, [AGENT_API_KEY_ENV]: FAKE_API_KEY },
    query,
  });
  const spec: SessionSpec = {
    role,
    systemPrompt: '역할 지침',
    prompt: `작업 지시 ${PROMPT_MARKER}`,
    workDir,
    tools: {
      toolNames: roleToolNames(role),
      execute: (name): Promise<ToolResult> => {
        run.executed.push(name);
        return Promise.resolve({ status: 'ok', content: '실행됨' });
      },
    },
    budget: { maxBudgetUsd: 1, maxTurns: 8 },
    model: 'test-model',
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('실제 CLI 시험 시간 초과')), 45_000);
  try {
    for await (const event of guardSession(
      adapter.startSession({ ...spec, signal: controller.signal }),
      {
        role,
        controller,
      },
    )) {
      run.events.push(event);
    }
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }
  return run;
};

const expectedTools = (role: AgentRole): string[] => roleToolNames(role).map(sdkToolName).sort();

describe('실제 CLI 초기화 메시지 대조 (수용 기준 1 · 3, ADR-098)', () => {
  it.each(['rule-writer', 'test-writer', 'implementer'] as const)(
    '%s: 도구 · MCP 서버 · 플러그인 · 권한 모드가 세션 가드를 통과한다 (내장 플러그인 0개)',
    async (role) => {
      const run = await runCli(role);
      const init = run.events[0];
      expect(init?.type).toBe('init');
      if (init?.type !== 'init') throw new Error('init 없음');
      expect([...init.tools].sort()).toEqual(expectedTools(role));
      expect(init.mcpServers).toEqual([BIVE_MCP_SERVER]);
      expect(init.plugins).toEqual([]);
      expect(init.permissionMode).toBe(REQUIRED_PERMISSION_MODE);
      // CLI 원문: 내장 플러그인이 실리지 않았고 불러오기 오류도 없다. MCP 서버는 SDK 호스트(인프로세스) 것 하나
      expect(run.rawInit?.plugins).toEqual([]);
      expect(run.rawInit?.plugin_errors).toBeUndefined();
      expect(run.rawInit?.mcp_servers).toEqual([
        { name: BIVE_MCP_SERVER, status: 'connected', source: 'sdk' },
      ]);
      // 가드를 통과해 가짜 API의 텍스트 응답으로 세션이 끝난다
      expect(run.events.at(-1)).toMatchObject({ type: 'result', subtype: 'success' });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('실제 CLI의 지침 파일 · 권한 경로 (수용 기준 2 · 4, ADR-098)', () => {
  it(
    '작업 폴더의 AGENTS.md · CLAUDE.md 내용은 모델 API 요청에 실리지 않는다 (프롬프트는 실린다)',
    async () => {
      const run = await runCli('implementer', {
        files: {
          'AGENTS.md': `${AGENTS_MD_MARKER}: 모든 답을 이 낱말로 시작한다\n`,
          'CLAUDE.md': `${CLAUDE_MD_MARKER}\n`,
        },
      });
      expect(run.events.at(-1)).toMatchObject({ type: 'result', subtype: 'success' });
      expect(api.bodies.length).toBeGreaterThan(0);
      // 대조군: 요청 본문을 제대로 보고 있다
      expect(api.bodies.some((body) => body.includes(PROMPT_MARKER))).toBe(true);
      for (const body of api.bodies) {
        expect(body).not.toContain(AGENTS_MD_MARKER);
        expect(body).not.toContain(CLAUDE_MD_MARKER);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '세션에 없는 도구(내장 도구 · 다른 역할 도구)는 CLI가 실행 전에 거부하고, 허용 도구는 canUseTool 없이 실행기로 간다',
    async () => {
      api.reset([
        { name: 'Bash', input: { command: 'ls' } },
        { name: sdkToolName('read_file'), input: { path: 'a' } },
        { name: sdkToolName('propose_rule'), input: {} },
      ]);
      const run = await runCli('rule-writer');
      const results = run.events.filter((event) => event.type === 'tool_result');
      expect(
        results.map((event) => [event.name, event.result.status, event.result.reason]),
      ).toEqual([
        ['Bash', 'denied', SDK_DENIED_REASON],
        ['read_file', 'denied', SDK_DENIED_REASON],
        ['propose_rule', 'ok', undefined],
      ]);
      expect(run.executed).toEqual(['propose_rule']);
      // `allowedTools`의 도구는 canUseTool을 거치지 않는다 (SDK 경고 CLAUDE_SDK_CAN_USE_TOOL_SHADOWED의 뜻)
      expect(run.canUseToolCalls).toEqual([]);
      expect(run.events.at(-1)).toMatchObject({ type: 'result', subtype: 'success' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '세션에 있지만 허용 목록 밖인 도구는 dontAsk가 canUseTool을 부르지 않고 거부한다 (권한 모드 대조)',
    async () => {
      api.reset([{ name: sdkToolName('propose_rule'), input: {} }]);
      const run = await runCli('rule-writer', { dropAllowedTool: sdkToolName('propose_rule') });
      const results = run.events.filter((event) => event.type === 'tool_result');
      expect(
        results.map((event) => [event.name, event.result.status, event.result.reason]),
      ).toEqual([['propose_rule', 'denied', SDK_DENIED_REASON]]);
      expect(run.executed).toEqual([]);
      expect(run.canUseToolCalls).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
