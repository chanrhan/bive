// ScriptedAdapter · 시나리오 형식 (이슈 #19 수용 기준 1 · 2, ADR-016 · ADR-049).
// 시나리오 YAML을 재생해 이벤트 순서 · 비용 값이 파일 값과 같고 도구 호출이 주입된 실행기로 넘어감을 확인한다.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import type {
  SessionEvent,
  SessionResultEvent,
  SessionSpec,
  ToolExecutor,
  ToolResult,
} from '../src/agent/adapter.js';
import {
  DEFAULT_SCENARIOS_DIR,
  listScenarios,
  loadScenario,
  parseScenario,
  ScenarioError,
} from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import { waitFor } from './helpers/process.js';

const REQUIRED_SCENARIOS = ['fail-check', 'happy-path', 'pause-implement'];

const tempDirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-scenario-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

/** 테스트용 가짜 실행기: 호출을 기록하고 정해 둔 결과를 돌려준다. */
const fakeExecutor = (
  respond: (name: string, args: Record<string, unknown>) => ToolResult | Promise<ToolResult> = (
    name,
  ) => ({ status: 'ok', content: `${name} 완료` }),
): ToolExecutor & { calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  return {
    toolNames: ['read_file', 'write_file', 'propose_rule'],
    calls,
    execute: async (name, args) => {
      calls.push({ name, args });
      return respond(name, args);
    },
  };
};

const spec = (overrides: Partial<SessionSpec> & Pick<SessionSpec, 'role'>): SessionSpec => ({
  systemPrompt: '역할 지침',
  prompt: '작업 지시',
  workDir: '/tmp/bive-work',
  tools: fakeExecutor(),
  budget: { maxBudgetUsd: 2, maxTurns: 100 },
  model: 'test-model',
  ...overrides,
});

const collect = async (events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> => {
  const out: SessionEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};

const resultOf = (events: SessionEvent[]): SessionResultEvent => {
  const last = events.at(-1);
  if (last?.type !== 'result') throw new Error('마지막 이벤트가 결과가 아님');
  return last;
};

/** 시나리오 파일의 결과 값을 어댑터와 무관하게 직접 읽는다. */
const fileResult = (name: string, role: string, index: number): Record<string, unknown> => {
  const raw = parse(readFileSync(path.join(DEFAULT_SCENARIOS_DIR, `${name}.yaml`), 'utf8')) as {
    roles: Record<string, { sessions: { result: Record<string, unknown> }[] }>;
  };
  const session = raw.roles[role]?.sessions[index];
  if (session === undefined) throw new Error(`${name} ${role}[${index}] 없음`);
  return session.result;
};

const adapterFor = (name: string, biveHome = '/tmp/bive-home'): ScriptedAdapter =>
  new ScriptedAdapter({ scenario: loadScenario(name), biveHome, pollIntervalMs: 10 });

describe('시나리오 파일 스키마', () => {
  it('필수 시나리오 3개가 scenarios/에 있고 모두 스키마 검증을 통과한다', () => {
    const names = listScenarios();
    for (const name of REQUIRED_SCENARIOS) {
      expect(names).toContain(name);
      const scenario = loadScenario(name);
      expect(scenario.name).toBe(name);
      expect(Object.keys(scenario.roles).sort()).toEqual([
        'implementer',
        'rule-writer',
        'test-writer',
      ]);
    }
  });

  it('happy-path의 rule-writer는 propose_rule 2개를 제안한다', () => {
    const turns = loadScenario('happy-path').roles['rule-writer']?.sessions[0]?.turns ?? [];
    const proposals = turns.filter((turn) => 'tool' in turn && turn.tool === 'propose_rule');
    expect(proposals).toHaveLength(2);
  });

  it('fail-check의 구현 세션 3개는 서로 다른 잘못된 변경이다', () => {
    const sessions = loadScenario('fail-check').roles.implementer?.sessions ?? [];
    expect(sessions).toHaveLength(3);
    const contents = sessions.map((session) => {
      const write = session.turns.find((turn) => 'tool' in turn && turn.tool === 'write_file');
      return write !== undefined && 'args' in write ? String(write.args.content) : '';
    });
    expect(new Set(contents).size).toBe(3);
    for (const content of contents) expect(content).not.toMatch(/version: '\d+\.\d+\.\d+'/);
  });

  it('pause-implement는 첫 구현 세션만 pause 대기가 있다', () => {
    const sessions = loadScenario('pause-implement').roles.implementer?.sessions ?? [];
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.turns[0]).toEqual({
      pause: { file: '{{biveHome}}/run/pause', until: 'removed' },
    });
    expect(sessions[1]?.turns.some((turn) => 'pause' in turn)).toBe(false);
  });

  const valid = {
    name: 'sample',
    description: '예시',
    roles: {
      implementer: {
        sessions: [
          {
            turns: [{ message: '완료' }],
            result: {
              subtype: 'success',
              total_cost_usd: 0.03,
              num_turns: 1,
              modelUsage: {
                'model-a': {
                  inputTokens: 1,
                  outputTokens: 1,
                  cacheReadInputTokens: 0,
                  cacheCreationInputTokens: 0,
                  costUSD: 0.01,
                },
                'model-b': {
                  inputTokens: 1,
                  outputTokens: 1,
                  cacheReadInputTokens: 0,
                  cacheCreationInputTokens: 0,
                  costUSD: 0.02,
                },
              },
            },
          },
        ],
      },
    },
  };
  const withSession = (patch: (session: Record<string, unknown>) => void): string => {
    const copy = structuredClone(valid) as unknown as {
      roles: { implementer: { sessions: Record<string, unknown>[] } };
    };
    const session = copy.roles.implementer.sessions[0];
    if (session === undefined) throw new Error('세션 없음');
    patch(session);
    return JSON.stringify(copy);
  };

  it('올바른 최소 시나리오는 통과한다 (JSON도 YAML이다)', () => {
    expect(parseScenario(JSON.stringify(valid), 'sample').name).toBe('sample');
  });

  it.each([
    ['YAML 문법 오류', 'name: [열림'],
    ['모르는 최상위 키', JSON.stringify({ ...valid, extra: 1 })],
    ['모르는 역할', JSON.stringify({ ...valid, roles: { reviewer: valid.roles.implementer } })],
    ['역할에 세션 0개', JSON.stringify({ ...valid, roles: { implementer: { sessions: [] } } })],
    [
      '모르는 subtype',
      withSession((s) => ((s.result as Record<string, unknown>).subtype = 'error')),
    ],
    ['음수 비용', withSession((s) => ((s.result as Record<string, unknown>).total_cost_usd = -1))],
    [
      '모델별 비용 합과 total_cost_usd 불일치',
      withSession((s) => ((s.result as Record<string, unknown>).total_cost_usd = 0.05)),
    ],
    ['턴 종류가 둘 섞임', withSession((s) => (s.turns = [{ message: '가', tool: 'read_file' }]))],
    [
      'pause의 모르는 until',
      withSession((s) => (s.turns = [{ pause: { file: 'p', until: 'x' } }])),
    ],
    ['결과 없음', withSession((s) => delete s.result)],
  ])('%s → ScenarioError', (_label, text) => {
    expect(() => parseScenario(text, 'sample')).toThrow(ScenarioError);
  });

  it('비용을 모르면 total_cost_usd null을 허용한다 (COST-02)', () => {
    const text = withSession((s) => {
      s.result = { subtype: 'success', total_cost_usd: null, num_turns: 1, modelUsage: {} };
    });
    expect(parseScenario(text).roles.implementer?.sessions[0]?.result.total_cost_usd).toBeNull();
  });

  it('파일 이름과 name이 다르면 ScenarioError', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'other.yaml'), JSON.stringify(valid));
    expect(() => loadScenario('other', dir)).toThrow(/이름 불일치/);
  });

  it('없는 시나리오 · 경로 문자가 든 이름은 ScenarioError', () => {
    expect(() => loadScenario('no-such-scenario')).toThrow(/시나리오 없음: no-such-scenario/);
    expect(() => loadScenario('../happy-path')).toThrow(ScenarioError);
  });
});

describe('ScriptedAdapter 재생', () => {
  it('rule-writer 세션: 이벤트 순서 · 도구 호출 전달 · 결과 값이 파일과 같다', async () => {
    const tools = fakeExecutor();
    const events = await collect(
      adapterFor('happy-path').startSession(
        spec({ role: 'rule-writer', tools, vars: { requirementId: 'REQ-001' } }),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      'init',
      'turn_start',
      'tool_call',
      'tool_result',
      'turn_start',
      'tool_call',
      'tool_result',
      'turn_start',
      'message',
      'result',
    ]);
    expect(events[0]).toMatchObject({
      type: 'init',
      model: 'test-model',
      tools: ['read_file', 'write_file', 'propose_rule'],
      mcpServers: ['bive'],
    });
    expect(events.filter((e) => e.type === 'turn_start').map((e) => e.turn)).toEqual([1, 2, 3]);

    // 도구 호출은 주입된 실행기로 넘어가고, 자리표시자가 채워진다
    expect(tools.calls.map((call) => call.name)).toEqual(['propose_rule', 'propose_rule']);
    for (const call of tools.calls) {
      expect(call.args.parentRequirementId).toBe('REQ-001');
      expect(String(call.args.statement)).toMatch(/^WHEN .+ THE SYSTEM SHALL .+/);
      expect(call.args.checkKinds).toEqual(['test']);
    }
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults.map((e) => e.result)).toEqual([
      { status: 'ok', content: 'propose_rule 완료' },
      { status: 'ok', content: 'propose_rule 완료' },
    ]);

    const result = resultOf(events);
    const expected = fileResult('happy-path', 'rule-writer', 0);
    expect(result).toEqual({ type: 'result', ...expected });
    expect(result.total_cost_usd).toBe(0.0312);
    expect(result.num_turns).toBe(3);
    expect(result.subtype).toBe('success');
  });

  it('happy-path의 실행 세션(테스트 작성 · 구현) 결과가 파일 값과 같고 파일 내용이 전달된다', async () => {
    const adapter = adapterFor('happy-path');
    const writer = fakeExecutor();
    const writerEvents = await collect(
      adapter.startSession(
        spec({ role: 'test-writer', tools: writer, runId: 'r1', vars: { ruleId: 'RULE-001' } }),
      ),
    );
    expect(resultOf(writerEvents)).toEqual({
      type: 'result',
      ...fileResult('happy-path', 'test-writer', 0),
    });
    expect(writer.calls).toHaveLength(1);
    const testFile = writer.calls[0];
    expect(testFile?.name).toBe('write_file');
    expect(testFile?.args.path).toBe('bive-acceptance/RULE-001/health-time.acc.ts');
    const testSource = String(testFile?.args.content);
    expect(testSource).toContain("inject('baseUrl')");
    expect(testSource).toContain('fetch(');
    // 인수 테스트는 HTTP로만: vitest 외 모듈 import 없음 (JDG-01)
    expect(testSource.match(/^import .+ from '([^']+)';$/gm)).toEqual([
      "import { describe, expect, inject, it } from 'vitest';",
    ]);

    const implementer = fakeExecutor();
    const implEvents = await collect(
      adapter.startSession(spec({ role: 'implementer', tools: implementer, runId: 'r1' })),
    );
    expect(resultOf(implEvents)).toEqual({
      type: 'result',
      ...fileResult('happy-path', 'implementer', 0),
    });
    expect(implementer.calls.map((call) => [call.name, call.args.path])).toEqual([
      ['read_file', 'src/app/api/health/route.ts'],
      ['write_file', 'src/app/api/health/route.ts'],
    ]);
    expect(String(implementer.calls[1]?.args.content)).toContain(
      'Response.json({ ok: true, time: new Date().toISOString() })',
    );
  });

  it('실행기 결과(거부 포함)가 tool_result로 그대로 나오고, 실행기 예외는 오류 결과가 되어 세션이 이어진다', async () => {
    let count = 0;
    const tools = fakeExecutor(() => {
      count += 1;
      if (count === 1) return { status: 'denied', content: '거부', reason: 'path_outside_root' };
      throw new Error('실행기 고장');
    });
    const events = await collect(
      adapterFor('happy-path').startSession(spec({ role: 'implementer', tools })),
    );
    const results = events.flatMap((e) => (e.type === 'tool_result' ? [e.result] : []));
    expect(results).toEqual([
      { status: 'denied', content: '거부', reason: 'path_outside_root' },
      { status: 'error', content: '실행기 고장', reason: 'executor_error' },
    ]);
    expect(resultOf(events).subtype).toBe('success');
  });

  it('같은 역할 세션은 실행마다 순서대로 소비하고, 다 쓰면 마지막 세션을 반복한다', async () => {
    const adapter = adapterFor('fail-check');
    const costs = async (runId: string, times: number): Promise<(number | null)[]> => {
      const out: (number | null)[] = [];
      for (let i = 0; i < times; i += 1) {
        const events = await collect(adapter.startSession(spec({ role: 'implementer', runId })));
        out.push(resultOf(events).total_cost_usd);
      }
      return out;
    };
    expect(await costs('r1', 4)).toEqual([0.0563, 0.0571, 0.0549, 0.0549]);
    // 다른 실행은 처음부터
    expect(await costs('r2', 1)).toEqual([0.0563]);
  });

  it('roleSessionIndex가 있으면 프로세스 안 순번 대신 그 순번의 세션을 쓴다', async () => {
    const adapter = adapterFor('fail-check');
    const events = await collect(
      adapter.startSession(spec({ role: 'implementer', runId: 'r1', roleSessionIndex: 1 })),
    );
    expect(resultOf(events).total_cost_usd).toBe(0.0571);
  });

  it('세션 한도를 넘는 성공 결과는 SDK처럼 한도 subtype으로 끝나고 값은 파일 그대로다', async () => {
    const adapter = adapterFor('happy-path');
    const overBudget = resultOf(
      await collect(
        adapter.startSession(
          spec({ role: 'implementer', budget: { maxBudgetUsd: 0.01, maxTurns: 100 } }),
        ),
      ),
    );
    expect(overBudget).toMatchObject({
      subtype: 'error_max_budget_usd',
      total_cost_usd: 0.0587,
      num_turns: 3,
    });
    const overTurns = resultOf(
      await collect(
        adapter.startSession(
          spec({ role: 'implementer', budget: { maxBudgetUsd: 2, maxTurns: 2 } }),
        ),
      ),
    );
    expect(overTurns).toMatchObject({ subtype: 'error_max_turns', total_cost_usd: 0.0587 });
  });

  it('자리표시자 값이 없으면 첫 이벤트 전에 ScenarioError로 끝나고 도구를 부르지 않는다', async () => {
    const tools = fakeExecutor();
    const iterator = adapterFor('happy-path').startSession(spec({ role: 'rule-writer', tools }));
    await expect(collect(iterator)).rejects.toThrow(/\{\{requirementId\}\}/);
    expect(tools.calls).toHaveLength(0);
  });

  it('시나리오에 없는 역할의 세션은 순회에서 ScenarioError', async () => {
    await expect(
      collect(adapterFor('happy-path').startSession(spec({ role: 'chat' }))),
    ).rejects.toThrow(ScenarioError);
  });

  it('중단 신호가 오면 순회가 AbortError로 끝난다', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(
        adapterFor('happy-path').startSession(
          spec({ role: 'implementer', signal: controller.signal }),
        ),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('ScriptedAdapter pause 대기 (pause-implement)', () => {
  it('실행의 첫 구현 세션이 $BIVE_HOME/run/pause를 만들고 지워질 때까지 기다린 뒤 happy-path와 같이 끝난다', async () => {
    const biveHome = tempDir();
    const pauseFile = path.join(biveHome, 'run', 'pause');
    const adapter = adapterFor('pause-implement', biveHome);
    const tools = fakeExecutor();

    let finished = false;
    const first = collect(
      adapter.startSession(spec({ role: 'implementer', runId: 'r1', tools })),
    ).then((events) => {
      finished = true;
      return events;
    });

    await waitFor(() => existsSync(pauseFile), 2000, 'pause 파일 생성');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(finished).toBe(false);
    expect(tools.calls).toHaveLength(0);

    rmSync(pauseFile);
    const events = await first;
    expect(events.map((e) => e.type)).toEqual([
      'init',
      'turn_start',
      'tool_call',
      'tool_result',
      'turn_start',
      'tool_call',
      'tool_result',
      'turn_start',
      'message',
      'result',
    ]);
    expect(resultOf(events)).toEqual({
      type: 'result',
      ...fileResult('happy-path', 'implementer', 0),
    });
    // happy-path와 같은 구현
    const happy = loadScenario('happy-path').roles.implementer?.sessions[0]?.turns;
    expect(tools.calls.map((call) => ({ tool: call.name, args: call.args }))).toEqual(
      happy?.filter((turn) => 'tool' in turn),
    );

    // 같은 실행의 다음 구현 세션은 기다리지 않는다
    const second = await collect(adapter.startSession(spec({ role: 'implementer', runId: 'r1' })));
    expect(resultOf(second).subtype).toBe('success');
    expect(existsSync(pauseFile)).toBe(false);

    // 다른 실행의 첫 구현 세션은 다시 기다린다
    const controller = new AbortController();
    const other = collect(
      adapter.startSession(spec({ role: 'implementer', runId: 'r2', signal: controller.signal })),
    );
    await waitFor(() => existsSync(pauseFile), 2000, '다른 실행의 pause 파일 생성');
    controller.abort();
    await expect(other).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('pause 파일이 이미 있으면 새로 만들지 않고 지워질 때까지 기다린다', async () => {
    const biveHome = tempDir();
    const pauseFile = path.join(biveHome, 'run', 'pause');
    const adapter = adapterFor('pause-implement', biveHome);
    const pending = collect(adapter.startSession(spec({ role: 'implementer', runId: 'r1' })));
    await waitFor(() => existsSync(pauseFile), 2000, 'pause 파일 생성');
    rmSync(pauseFile);
    expect(resultOf(await pending).subtype).toBe('success');
  });

  it('until: created는 파일이 생길 때까지 기다리고 상대 경로는 작업 디렉터리 기준이다', async () => {
    const workDir = tempDir();
    const scenario = parseScenario(
      JSON.stringify({
        name: 'wait-created',
        description: '생성 대기',
        roles: {
          planner: {
            sessions: [
              {
                turns: [{ pause: { file: 'go', until: 'created' } }, { message: '진행' }],
                result: { subtype: 'success', total_cost_usd: null, num_turns: 1, modelUsage: {} },
              },
            ],
          },
        },
      }),
    );
    const adapter = new ScriptedAdapter({ scenario, biveHome: '/unused', pollIntervalMs: 10 });
    let finished = false;
    const pending = collect(adapter.startSession(spec({ role: 'planner', workDir }))).then(
      (events) => {
        finished = true;
        return events;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(finished).toBe(false);
    expect(existsSync(path.join(workDir, 'go'))).toBe(false);
    writeFileSync(path.join(workDir, 'go'), '');
    const events = await pending;
    expect(events.map((e) => e.type)).toEqual(['init', 'turn_start', 'message', 'result']);
    expect(resultOf(events).total_cost_usd).toBeNull();
  });
});
