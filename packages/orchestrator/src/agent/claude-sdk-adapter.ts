// 실제 Claude Agent SDK 어댑터 (ADR-016 · ADR-024 · ADR-049 · ADR-059).
// 세션 1개 = `query()` 1회(기획서 3.2). 옵션은 `buildQueryOptions`가 SessionSpec에서만 조립하고(순수 함수),
// 내장 도구 · 파일 설정 · 세션 저장 · 서브 에이전트 · 추가 MCP · 모델 API 외 목적지를 모두 끈다(NFR-02 · NFR-04 · ADR-007).
// 도구는 인프로세스 MCP 서버 `bive` 하나로만 노출하고 실행은 세션에 주입된 ToolExecutor(고정 도구 · 가드)에 넘긴다.
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  type CanUseTool,
  createSdkMcpServer,
  type Options,
  query as sdkQuery,
  type SDKMessage,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentRole } from '@bive/shared';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { settingsIncompleteError } from '../settings/settings-service.js';
import { COMMAND_ENV_ALLOWLIST } from '../tools/commands.js';
import { BIVE_MCP_SERVER, toolDefinitions } from '../tools/definitions.js';
import { BIVE_TOOL_PREFIX, normalizeToolName } from '../tools/session-guard.js';
import { ORCHESTRATOR_VERSION } from '../version.js';
import {
  type AgentAdapter,
  executeTool,
  type ModelUsageReport,
  RESULT_SUBTYPES,
  type ResultSubtype,
  type SessionEvent,
  type SessionResultEvent,
  type SessionSpec,
  type ToolExecutor,
  type ToolResult,
} from './adapter.js';

/** 주입 가능한 `query()`. 실제 SDK 함수가 기본값이고, 테스트는 가짜 함수로 바꿔 실제 호출을 하지 않는다. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

/**
 * `query()` 옵션에 둘 수 있는 키 전부 (ADR-059). 이 밖의 키(프록시 · `baseUrl` · 원격 MCP · `agents` · `plugins` ·
 * `settings` · `sandbox` · `extraArgs` · `pathToClaudeCodeExecutable` 등)는 넣지 않는다. 테스트가 이 목록과 정확히 대조한다.
 */
export const QUERY_OPTION_KEYS = [
  'abortController',
  'allowedTools',
  'canUseTool',
  'cwd',
  'env',
  'maxBudgetUsd',
  'maxTurns',
  'mcpServers',
  'model',
  'permissionMode',
  'persistSession',
  'settingSources',
  'strictMcpConfig',
  'systemPrompt',
  'tools',
] as const satisfies readonly (keyof Options)[];

/** 모델 제공자 인증 변수. 이것만 인증으로 받는다(API 키 방식, ADR-059). */
export const AGENT_API_KEY_ENV = 'ANTHROPIC_API_KEY';

/**
 * SDK 하위 프로세스에 원본 환경에서 옮기는 변수: 명령 도구와 같은 기본 목록 + API 키.
 * 프록시(`HTTPS_PROXY` 등) · 기준 URL(`ANTHROPIC_BASE_URL`) · 다른 인증 · `NODE_OPTIONS`는 옮기지 않는다(NFR-04).
 */
export const AGENT_ENV_ALLOWLIST = [...COMMAND_ENV_ALLOWLIST, AGENT_API_KEY_ENV] as const;

/**
 * 항상 고정하는 변수: 자동 메모리 · CLAUDE.md 읽기 끄기(PRD 5.1), 모델 추론 외 통신(텔레메트리 · 오류 보고 ·
 * 자동 업데이트) 끄기(NFR-04). `CLAUDE_CONFIG_DIR`은 BIVE 전용 폴더로 따로 넣는다.
 */
export const AGENT_FIXED_ENV = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
} as const;

/** 화면에 그대로 보일 수 있는 문구 (명사형, 로드맵 키 · 모델 이름 없음). */
export const AGENT_NOT_CONFIGURED_MESSAGE = '에이전트 인증 미설정';

/** API 키가 없어 실제 에이전트 세션을 열 수 없음. 순회 시작에서 던진다. */
export class AgentNotConfiguredError extends Error {
  readonly code = 'not_configured' as const;

  constructor() {
    super(AGENT_NOT_CONFIGURED_MESSAGE);
    this.name = 'AgentNotConfiguredError';
  }
}

/** SDK가 MCP 도구 호출 요청의 `_meta`에 싣는 tool_use ID 키. */
const TOOL_USE_ID_META = 'claudecode/toolUseId';

/** 도구 이름을 SDK가 보고하는 이름으로: `read_file` → `mcp__bive__read_file`. */
export const sdkToolName = (name: string): string => `${BIVE_TOOL_PREFIX}${name}`;

const toolUseIdOf = (extra: unknown): string | undefined => {
  if (typeof extra !== 'object' || extra === null) return undefined;
  const meta = (extra as { _meta?: unknown })._meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  const id = (meta as Record<string, unknown>)[TOOL_USE_ID_META];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
};

const toCallToolResult = (result: ToolResult): CallToolResult => ({
  content: [{ type: 'text', text: result.content }],
  isError: result.status !== 'ok',
});

/** 도구 결과 통지 (tool_use ID를 알면 함께). 어댑터가 `tool_result` 이벤트에 실제 결과를 싣는 데 쓴다. */
export type ToolResultListener = (
  callId: string | undefined,
  name: string,
  result: ToolResult,
) => void;

/**
 * 역할의 고정 도구 정의(`toolDefinitions(role)`)를 SDK MCP 도구로 감싼다. 입력 스키마는 같은 zod 모양이고,
 * 실행은 주입된 실행기에 넘긴다(실행기가 strict 스키마로 다시 검증 · 기록한다). 실행기 예외는 `error` 결과.
 */
export const buildBiveMcpTools = (
  role: AgentRole,
  executor: ToolExecutor,
  onResult?: ToolResultListener,
): ReturnType<typeof tool>[] =>
  toolDefinitions(role).map((definition) =>
    tool(
      definition.name,
      definition.description,
      definition.inputSchema.shape,
      async (args, extra) => {
        const result = await executeTool(
          executor,
          definition.name,
          args as Record<string, unknown>,
        );
        onResult?.(toolUseIdOf(extra), definition.name, result);
        return toCallToolResult(result);
      },
    ),
  );

/** `buildQueryOptions`의 SessionSpec 밖 입력. */
export interface QueryOptionsDeps {
  /** 원본 환경 변수. `AGENT_ENV_ALLOWLIST`만 옮긴다 */
  env: Readonly<Record<string, string | undefined>>;
  /** SDK 설정 폴더(`CLAUDE_CONFIG_DIR`). 사용자 `~/.claude`를 읽지 않도록 BIVE 전용 경로 */
  configDir: string;
  /** 세션 중단용. `spec.signal`과 이어 주는 것은 호출자 몫 */
  abortController: AbortController;
  /** 도구 결과 통지 */
  onToolResult?: ToolResultListener;
}

/** SDK 하위 프로세스 환경: 허용 목록 변수 + 고정 변수 + 전용 설정 폴더. */
export const agentEnv = (
  source: Readonly<Record<string, string | undefined>>,
  configDir: string,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of AGENT_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined && value.length > 0) env[key] = value;
  }
  return { ...env, ...AGENT_FIXED_ENV, CLAUDE_CONFIG_DIR: configDir };
};

/** 세션 한도 · 모델 검사. 예산 · 모델 없는 세션은 열지 않는다(NFR-07) → 설정 미비와 같은 -32010. */
const assertRunnable = (spec: SessionSpec): void => {
  const missing: `roles.${AgentRole}.${'model' | 'maxBudgetUsd' | 'maxTurns'}`[] = [];
  if (typeof spec.model !== 'string' || spec.model.trim().length === 0) {
    missing.push(`roles.${spec.role}.model`);
  }
  const { maxBudgetUsd, maxTurns } = spec.budget;
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
    missing.push(`roles.${spec.role}.maxBudgetUsd`);
  }
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    missing.push(`roles.${spec.role}.maxTurns`);
  }
  if (missing.length > 0) throw settingsIncompleteError(missing);
};

/**
 * SessionSpec → `query()` 옵션 (순수 함수, ADR-059). 키는 `QUERY_OPTION_KEYS`뿐이다.
 * - 내장 도구 전부 끔(`tools: []`), MCP는 인프로세스 `bive` 하나 + `strictMcpConfig`(계정 · 프로젝트 MCP 무시)
 * - 파일 설정 비로드(`settingSources: []`), 세션 저장 안 함(`persistSession: false`), `agents` 없음(ADR-007)
 * - 권한: 역할 도구만 미리 허용하고 나머지는 묻지 않고 거부(`dontAsk` + `canUseTool`)
 * - 시스템 프롬프트는 호출자가 준 문자열 그대로(기본 프리셋 없음), 작업 폴더는 세션 루트
 * @throws {RpcError} -32010 모델 · 한도가 비어 있거나 잘못됨
 */
export const buildQueryOptions = (spec: SessionSpec, deps: QueryOptionsDeps): Options => {
  assertRunnable(spec);
  const allowedTools = toolDefinitions(spec.role).map((definition) => sdkToolName(definition.name));
  const allowed = new Set(allowedTools);
  const canUseTool: CanUseTool = (toolName, input) =>
    Promise.resolve(
      allowed.has(toolName)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: `허용되지 않은 도구: ${toolName}` },
    );
  const bive = createSdkMcpServer({
    name: BIVE_MCP_SERVER,
    version: ORCHESTRATOR_VERSION,
    tools: buildBiveMcpTools(spec.role, spec.tools, deps.onToolResult),
  });
  return {
    model: spec.model,
    systemPrompt: spec.systemPrompt,
    cwd: spec.workDir,
    tools: [],
    allowedTools,
    permissionMode: 'dontAsk',
    canUseTool,
    mcpServers: { [BIVE_MCP_SERVER]: bive },
    strictMcpConfig: true,
    settingSources: [],
    persistSession: false,
    maxTurns: spec.budget.maxTurns,
    maxBudgetUsd: spec.budget.maxBudgetUsd,
    env: agentEnv(deps.env, deps.configDir),
    abortController: deps.abortController,
  };
};

// ── SDK 메시지 → SessionEvent ─────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const isResultSubtype = (value: unknown): value is ResultSubtype =>
  (RESULT_SUBTYPES as readonly unknown[]).includes(value);

/** tool_result 블록 본문을 문자열로 (텍스트 블록만 잇는다). */
const toolResultText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n');
};

/**
 * SDK 결과 메시지 → 결과 이벤트 (ADR-049). BIVE가 다루지 않는 오류 subtype과 `is_error`인 성공은
 * `error_during_execution`, 비용이 수가 아니면 `null`(COST-02). `modelUsage`는 BIVE가 쓰는 다섯 필드만 옮긴다.
 */
export const toResultEvent = (message: Record<string, unknown>): SessionResultEvent => {
  let subtype: ResultSubtype = isResultSubtype(message.subtype)
    ? message.subtype
    : 'error_during_execution';
  if (subtype === 'success' && message.is_error === true) subtype = 'error_during_execution';
  const cost = message.total_cost_usd;
  const modelUsage: Record<string, ModelUsageReport> = {};
  if (isRecord(message.modelUsage)) {
    for (const [model, usage] of Object.entries(message.modelUsage)) {
      if (!isRecord(usage)) continue;
      modelUsage[model] = {
        inputTokens: numberOr(usage.inputTokens, 0),
        outputTokens: numberOr(usage.outputTokens, 0),
        cacheReadInputTokens: numberOr(usage.cacheReadInputTokens, 0),
        cacheCreationInputTokens: numberOr(usage.cacheCreationInputTokens, 0),
        costUSD: numberOr(usage.costUSD, 0),
      };
    }
  }
  return {
    type: 'result',
    subtype,
    total_cost_usd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
    num_turns: Math.max(0, Math.trunc(numberOr(message.num_turns, 0))),
    modelUsage,
  };
};

/** 세션 하나의 메시지 변환 상태. */
interface TranslateState {
  turn: number;
  lastAssistantId: string | null;
  /** tool_use ID → (턴, 이름) */
  calls: Map<string, { turn: number; name: string }>;
  /** tool_use ID → 실행기 결과 (MCP 핸들러가 채운다) */
  results: Map<string, ToolResult>;
}

/**
 * SDK 메시지 하나를 이벤트로 옮긴다 (ADR-049 · ADR-059). 최상위(서브 에이전트가 아닌) 메시지만 본다.
 * - `system/init` → `init`(MCP 서버는 이름만)
 * - `assistant`: 메시지 ID가 바뀔 때 `turn_start`, 텍스트 → `message`, tool_use → `tool_call`(이름은 `mcp__bive__` 접두를 뗀다)
 * - `user`의 tool_result → `tool_result`(실행기 결과가 있으면 그것, 없으면 SDK가 실행 전에 거부한 것이라 `error`)
 * - `result` → 결과 이벤트. 그 밖의 메시지는 버린다
 */
const translate = (message: SDKMessage, state: TranslateState): SessionEvent[] => {
  const raw = message as unknown as Record<string, unknown>;
  if (raw.parent_tool_use_id !== undefined && raw.parent_tool_use_id !== null) return [];
  switch (raw.type) {
    case 'system': {
      if (raw.subtype !== 'init') return [];
      const servers = Array.isArray(raw.mcp_servers) ? raw.mcp_servers : [];
      return [
        {
          type: 'init',
          sessionId: typeof raw.session_id === 'string' ? raw.session_id : '',
          model: typeof raw.model === 'string' ? raw.model : '',
          tools: Array.isArray(raw.tools)
            ? raw.tools.filter((name): name is string => typeof name === 'string')
            : [],
          mcpServers: servers
            .map((server) => (isRecord(server) ? server.name : undefined))
            .filter((name): name is string => typeof name === 'string'),
        },
      ];
    }
    case 'assistant': {
      const body = isRecord(raw.message) ? raw.message : {};
      const events: SessionEvent[] = [];
      const id = typeof body.id === 'string' ? body.id : null;
      if (id === null || id !== state.lastAssistantId) {
        state.turn += 1;
        state.lastAssistantId = id;
        events.push({ type: 'turn_start', turn: state.turn });
      }
      const content = Array.isArray(body.content) ? body.content.filter(isRecord) : [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          events.push({ type: 'message', turn: state.turn, text: block.text });
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          const name = normalizeToolName(typeof block.name === 'string' ? block.name : '');
          state.calls.set(block.id, { turn: state.turn, name });
          events.push({
            type: 'tool_call',
            turn: state.turn,
            callId: block.id,
            name,
            args: isRecord(block.input) ? block.input : {},
          });
        }
      }
      return events;
    }
    case 'user': {
      const body = isRecord(raw.message) ? raw.message : {};
      const content = Array.isArray(body.content) ? body.content.filter(isRecord) : [];
      const events: SessionEvent[] = [];
      for (const block of content) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const callId = block.tool_use_id;
        const call = state.calls.get(callId);
        const executed = state.results.get(callId);
        state.results.delete(callId);
        const result: ToolResult = executed ?? {
          status: block.is_error === true ? 'error' : 'ok',
          content: toolResultText(block.content),
          ...(block.is_error === true ? { reason: 'tool_failed' } : {}),
        };
        events.push({
          type: 'tool_result',
          turn: call?.turn ?? state.turn,
          callId,
          name: call?.name ?? '',
          result,
        });
      }
      return events;
    }
    case 'result':
      return [toResultEvent(raw)];
    default:
      return [];
  }
};

/**
 * SDK 메시지 흐름 → SessionEvent 흐름. 결과 이벤트를 내면 끝내고(나머지는 읽지 않음),
 * 결과 없이 흐름이 끝나면 오류. `results`는 MCP 핸들러가 tool_use ID별 실행기 결과를 채우는 곳이다.
 */
export async function* translateSdkMessages(
  messages: AsyncIterable<SDKMessage>,
  results: Map<string, ToolResult> = new Map(),
  signal?: AbortSignal,
): AsyncGenerator<SessionEvent> {
  const state: TranslateState = { turn: 0, lastAssistantId: null, calls: new Map(), results };
  for await (const message of messages) {
    signal?.throwIfAborted();
    for (const event of translate(message, state)) {
      yield event;
      if (event.type === 'result') return;
    }
  }
  signal?.throwIfAborted();
  throw new Error('세션 결과 없이 에이전트 응답이 끝남');
}

// ── 어댑터 ───────────────────────────────────────────────

export interface ClaudeSdkAdapterOptions {
  /** BIVE 데이터 폴더. SDK 설정 폴더 기본값 `<biveHome>/agent/claude`의 기준 (경로 가드가 막는 곳) */
  biveHome: string;
  /** 원본 환경 변수 (기본 `process.env`). API 키 확인 · 허용 목록 전달에 쓴다 */
  env?: Readonly<Record<string, string | undefined>>;
  /** `query()` 대체 (테스트) */
  query?: QueryFn;
  /** SDK 설정 폴더 (기본 `<biveHome>/agent/claude`) */
  configDir?: string;
}

/** SDK 설정 폴더 기본값. `$BIVE_HOME` 아래 `work/` 밖이라 고정 도구의 경로 가드가 거부한다(ADR-052). */
export const defaultAgentConfigDir = (biveHome: string): string =>
  path.join(biveHome, 'agent', 'claude');

export class ClaudeSdkAdapter implements AgentAdapter {
  readonly kind = 'claude' as const;
  readonly configDir: string;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly query: QueryFn;

  constructor(options: ClaudeSdkAdapterOptions) {
    this.env = options.env ?? process.env;
    this.query = options.query ?? sdkQuery;
    this.configDir = options.configDir ?? defaultAgentConfigDir(options.biveHome);
  }

  /** API 키가 있는지. 없으면 세션이 `not_configured`로 끝난다. */
  get configured(): boolean {
    const key = this.env[AGENT_API_KEY_ENV];
    return typeof key === 'string' && key.length > 0;
  }

  startSession(spec: SessionSpec): AsyncIterable<SessionEvent> {
    return this.run(spec);
  }

  private async *run(spec: SessionSpec): AsyncGenerator<SessionEvent> {
    const { signal } = spec;
    signal?.throwIfAborted();
    if (!this.configured) throw new AgentNotConfiguredError();
    const controller = new AbortController();
    const forward = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', forward, { once: true });
    const results = new Map<string, ToolResult>();
    try {
      const options = buildQueryOptions(spec, {
        env: this.env,
        configDir: this.configDir,
        abortController: controller,
        onToolResult: (callId, _name, result) => {
          if (callId !== undefined) results.set(callId, result);
        },
      });
      mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
      yield* translateSdkMessages(this.query({ prompt: spec.prompt, options }), results, signal);
    } catch (error) {
      // 중단이면 SDK의 AbortError 대신 signal.reason으로 끝낸다 (AgentAdapter 계약)
      signal?.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener('abort', forward);
      if (!controller.signal.aborted) controller.abort();
    }
  }
}
