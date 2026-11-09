// 시나리오 재생 어댑터 (ADR-016 · ADR-049). 모든 자동 테스트가 쓰는 가짜 에이전트.
// 도구 호출은 세션에 주입된 ToolExecutor(실제 고정 도구 · 가드)로 넘기므로 가드도 함께 검증된다.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  type AgentAdapter,
  executeTool,
  type SessionEvent,
  type SessionResultEvent,
  type SessionSpec,
} from './adapter.js';
import {
  type Scenario,
  ScenarioError,
  type ScenarioSession,
  type ScenarioTurn,
} from './scenario.js';

/** 시나리오 세션의 MCP 서버 이름 (고정 도구 서버 하나, ADR-024) */
export const SCRIPTED_MCP_SERVERS = ['bive'] as const;

const DEFAULT_POLL_INTERVAL_MS = 100;

export interface ScriptedAdapterOptions {
  scenario: Scenario;
  /** `{{biveHome}}` 자리표시자 값 */
  biveHome: string;
  /** pause 대기 중 파일 확인 간격 (기본 100ms) */
  pollIntervalMs?: number;
}

/** `{{이름}}` 자리표시자. 값은 `biveHome` · `workDir` · 세션 `vars`에서 찾는다. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

const fill = (text: string, vars: Readonly<Record<string, string>>): string =>
  text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new ScenarioError(`시나리오 자리표시자 값 없음: {{${name}}}`);
    return value;
  });

const fillDeep = (value: unknown, vars: Readonly<Record<string, string>>): unknown => {
  if (typeof value === 'string') return fill(value, vars);
  if (Array.isArray(value)) return value.map((item) => fillDeep(item, vars));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fillDeep(item, vars)]),
    );
  }
  return value;
};

type ResolvedTurn =
  | { kind: 'tool'; tool: string; args: Record<string, unknown> }
  | { kind: 'message'; text: string }
  | { kind: 'pause'; file: string; until: 'removed' | 'created' };

const resolveTurn = (
  turn: ScenarioTurn,
  vars: Readonly<Record<string, string>>,
  workDir: string,
): ResolvedTurn => {
  if ('tool' in turn) {
    return {
      kind: 'tool',
      tool: turn.tool,
      args: fillDeep(turn.args, vars) as Record<string, unknown>,
    };
  }
  if ('message' in turn) return { kind: 'message', text: fill(turn.message, vars) };
  return {
    kind: 'pause',
    file: path.resolve(workDir, fill(turn.pause.file, vars)),
    until: turn.pause.until,
  };
};

/** `removed`: 파일이 없으면 만들고 지워질 때까지, `created`: 생길 때까지 기다린다. */
const waitForPause = async (
  file: string,
  until: 'removed' | 'created',
  pollIntervalMs: number,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (until === 'removed' && !existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${process.pid}\n`);
  }
  const done = (): boolean => (until === 'removed' ? !existsSync(file) : existsSync(file));
  while (!done()) {
    signal?.throwIfAborted();
    await delay(pollIntervalMs, undefined, signal ? { signal } : undefined).catch(
      (error: unknown) => {
        // 대기 중 중단은 signal.reason으로 끝낸다 (timers의 AbortError 대신)
        signal?.throwIfAborted();
        throw error;
      },
    );
  }
};

/**
 * 시나리오 결과를 세션 한도와 대조한다. 실제 SDK는 한도를 넘으면 그 subtype으로 끝나므로,
 * 성공 결과의 비용 · 턴이 한도를 넘으면 subtype만 바꾸고 값은 파일 그대로 둔다.
 */
const applyLimits = (
  result: ScenarioSession['result'],
  budget: SessionSpec['budget'],
): SessionResultEvent => {
  let subtype = result.subtype;
  if (subtype === 'success') {
    if (result.total_cost_usd !== null && result.total_cost_usd > budget.maxBudgetUsd) {
      subtype = 'error_max_budget_usd';
    } else if (result.num_turns > budget.maxTurns) {
      subtype = 'error_max_turns';
    }
  }
  return {
    type: 'result',
    subtype,
    total_cost_usd: result.total_cost_usd,
    num_turns: result.num_turns,
    modelUsage: structuredClone(result.modelUsage),
  };
};

export class ScriptedAdapter implements AgentAdapter {
  readonly kind = 'scripted' as const;
  readonly scenario: Scenario;
  private readonly biveHome: string;
  private readonly pollIntervalMs: number;
  /** (실행, 역할)별로 이미 연 세션 수 */
  private readonly opened = new Map<string, number>();

  constructor(options: ScriptedAdapterOptions) {
    this.scenario = options.scenario;
    this.biveHome = options.biveHome;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * 세션 정의는 호출 시점에 고른다(순번이 순회 시점에 흔들리지 않게). 오류는 순회에서 던진다.
   */
  startSession(spec: SessionSpec): AsyncIterable<SessionEvent> {
    let picked: ScenarioSession | Error;
    try {
      picked = this.pick(spec);
    } catch (error) {
      picked = error instanceof Error ? error : new Error(String(error));
    }
    return this.replay(spec, picked);
  }

  private pick(spec: SessionSpec): ScenarioSession {
    const key = `${spec.runId ?? ''}\u0000${spec.role}`;
    const counted = this.opened.get(key) ?? 0;
    this.opened.set(key, counted + 1);
    const script = this.scenario.roles[spec.role];
    if (script === undefined) {
      throw new ScenarioError(`시나리오 ${this.scenario.name}에 역할 ${spec.role}의 세션 없음`);
    }
    const index = spec.roleSessionIndex ?? counted;
    if (!Number.isInteger(index) || index < 0) {
      throw new ScenarioError(`세션 순번 오류: ${index}`);
    }
    // 다 쓰면 마지막 세션을 반복한다
    const session = script.sessions[Math.min(index, script.sessions.length - 1)];
    if (session === undefined) throw new ScenarioError(`역할 ${spec.role}의 세션 없음`);
    return session;
  }

  private async *replay(
    spec: SessionSpec,
    picked: ScenarioSession | Error,
  ): AsyncGenerator<SessionEvent> {
    if (picked instanceof Error) throw picked;
    const { signal } = spec;
    signal?.throwIfAborted();
    const vars: Record<string, string> = {
      biveHome: this.biveHome,
      workDir: spec.workDir,
      ...spec.vars,
    };
    // 자리표시자 누락은 첫 이벤트 전에 드러낸다
    const turns = picked.turns.map((turn) => resolveTurn(turn, vars, spec.workDir));

    yield {
      type: 'init',
      sessionId: randomUUID(),
      model: spec.model,
      tools: [...spec.tools.toolNames],
      mcpServers: [...SCRIPTED_MCP_SERVERS],
    };

    let turn = 0;
    for (const item of turns) {
      signal?.throwIfAborted();
      if (item.kind === 'pause') {
        await waitForPause(item.file, item.until, this.pollIntervalMs, signal);
        continue;
      }
      turn += 1;
      yield { type: 'turn_start', turn };
      if (item.kind === 'message') {
        yield { type: 'message', turn, text: item.text };
        continue;
      }
      const callId = `call-${turn}`;
      yield { type: 'tool_call', turn, callId, name: item.tool, args: item.args };
      const result = await executeTool(spec.tools, item.tool, item.args);
      signal?.throwIfAborted();
      yield { type: 'tool_result', turn, callId, name: item.tool, result };
    }
    signal?.throwIfAborted();
    yield applyLimits(picked.result, spec.budget);
  }
}
