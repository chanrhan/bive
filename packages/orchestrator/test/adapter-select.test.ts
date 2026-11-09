// 어댑터 선택 (이슈 #19 수용 기준 2 · 3, ADR-016 · ADR-049).
// BIVE_AGENT(`scripted` | `claude`, 기본 claude)로 고르고 다른 값이면 기동 실패(종료 코드 2).
// BIVE_SCENARIO(기본 happy-path)는 scripted일 때만 읽고 없는 이름이면 기동 실패.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SessionSpec, ToolExecutor } from '../src/agent/adapter.js';
import {
  AGENT_NOT_CONFIGURED_MESSAGE,
  AgentNotConfiguredError,
  ClaudeSdkAdapter,
} from '../src/agent/claude-sdk-adapter.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import { AgentConfigError, selectAgent } from '../src/agent/select.js';
import { startOrchestrator } from '../src/orchestrator.js';
import { cleanup, makeBiveHome, spawnCli, waitFor } from './helpers/process.js';

const BIVE_HOME = '/tmp/bive-select';

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanup();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const noTools: ToolExecutor = {
  toolNames: [],
  execute: () => Promise.resolve({ status: 'ok', content: '' }),
};

const sessionSpec: SessionSpec = {
  role: 'implementer',
  systemPrompt: '역할 지침',
  prompt: '작업 지시',
  workDir: '/tmp/bive-work',
  tools: noTools,
  budget: { maxBudgetUsd: 1, maxTurns: 10 },
  model: 'test-model',
};

describe('selectAgent', () => {
  it('BIVE_AGENT가 없거나 비어 있으면 claude (BIVE_SCENARIO는 읽지 않는다)', () => {
    for (const env of [{}, { BIVE_AGENT: '' }, { BIVE_SCENARIO: 'no-such-scenario' }]) {
      const selection = selectAgent(env, { biveHome: BIVE_HOME });
      expect(selection.kind).toBe('claude');
      expect(selection.scenario).toBeNull();
      expect(selection.adapter).toBeInstanceOf(ClaudeSdkAdapter);
    }
  });

  it('scripted는 기본 시나리오 happy-path를 쓴다', () => {
    const selection = selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome: BIVE_HOME });
    expect(selection.kind).toBe('scripted');
    expect(selection.scenario).toBe('happy-path');
    expect(selection.adapter).toBeInstanceOf(ScriptedAdapter);
    expect((selection.adapter as ScriptedAdapter).scenario.name).toBe('happy-path');
  });

  it.each(['happy-path', 'fail-check', 'pause-implement'])('BIVE_SCENARIO=%s를 고른다', (name) => {
    const selection = selectAgent(
      { BIVE_AGENT: 'scripted', BIVE_SCENARIO: name },
      { biveHome: BIVE_HOME },
    );
    expect(selection.scenario).toBe(name);
    expect((selection.adapter as ScriptedAdapter).scenario.name).toBe(name);
  });

  it.each(['Scripted', 'fake', 'claude-sdk', ' scripted'])(
    'BIVE_AGENT=%j는 AgentConfigError',
    (value) => {
      expect(() => selectAgent({ BIVE_AGENT: value }, { biveHome: BIVE_HOME })).toThrow(
        AgentConfigError,
      );
    },
  );

  it('없는 시나리오 · 형식이 틀린 시나리오는 AgentConfigError', () => {
    expect(() =>
      selectAgent({ BIVE_AGENT: 'scripted', BIVE_SCENARIO: 'nope' }, { biveHome: BIVE_HOME }),
    ).toThrow(/BIVE_SCENARIO 오류: 시나리오 없음: nope/);

    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-scenarios-'));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, 'broken.yaml'), 'name: broken\ndescription: 틀림\nroles: 1\n');
    expect(() =>
      selectAgent(
        { BIVE_AGENT: 'scripted', BIVE_SCENARIO: 'broken' },
        { biveHome: BIVE_HOME, scenariosDir: dir },
      ),
    ).toThrow(AgentConfigError);
  });

  it('claude 어댑터는 API 키가 없으면 세션을 순회할 때 not_configured로 끝난다', async () => {
    for (const env of [{ BIVE_AGENT: 'claude' }, { BIVE_AGENT: 'claude', ANTHROPIC_API_KEY: '' }]) {
      const adapter = selectAgent(env, { biveHome: BIVE_HOME }).adapter;
      expect(adapter.kind).toBe('claude');
      expect((adapter as ClaudeSdkAdapter).configured).toBe(false);
      const iterator = adapter.startSession(sessionSpec)[Symbol.asyncIterator]();
      const error: unknown = await iterator.next().then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(AgentNotConfiguredError);
      expect(error).toMatchObject({
        code: 'not_configured',
        message: AGENT_NOT_CONFIGURED_MESSAGE,
      });
      // 화면 문구에 로드맵 키 · 모델 이름 · 코드 표기가 없다 (라틴 문자 · 숫자 · 백틱 없음)
      expect(AGENT_NOT_CONFIGURED_MESSAGE).not.toMatch(/[A-Za-z0-9`]/);
    }
  });

  it('claude 어댑터는 API 키가 있으면 설정됨으로 본다 (실제 호출은 하지 않음)', () => {
    const adapter = selectAgent(
      { BIVE_AGENT: 'claude', ANTHROPIC_API_KEY: 'test-key' },
      { biveHome: BIVE_HOME },
    ).adapter as ClaudeSdkAdapter;
    expect(adapter.configured).toBe(true);
    expect(adapter.configDir).toBe(path.join(BIVE_HOME, 'agent', 'claude'));
  });
});

describe('기동 경로', () => {
  it('startOrchestrator가 고른 어댑터를 보관한다', async () => {
    const home = makeBiveHome();
    const agent = selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome: home });
    const started = await startOrchestrator({ biveHome: home, agent });
    if (started.status !== 'started') throw new Error('기동 실패');
    try {
      expect(started.orchestrator.agent).toBe(agent);
    } finally {
      await started.orchestrator.stop();
    }
  });

  it('잘못된 BIVE_AGENT는 종료 코드 2이고 잠금 · 토큰 파일을 만들지 않는다', async () => {
    const home = makeBiveHome();
    const exit = await spawnCli({ BIVE_HOME: home, BIVE_AGENT: 'fake' }).exited;
    expect(exit.code).toBe(2);
    expect(exit.stderr).toContain('BIVE_AGENT는 scripted 또는 claude여야 함: "fake"');
    expect(existsSync(path.join(home, 'run'))).toBe(false);
  });

  it('scripted의 없는 BIVE_SCENARIO는 종료 코드 2', async () => {
    const home = makeBiveHome();
    const exit = await spawnCli({
      BIVE_HOME: home,
      BIVE_AGENT: 'scripted',
      BIVE_SCENARIO: 'no-such-scenario',
    }).exited;
    expect(exit.code).toBe(2);
    expect(exit.stderr).toContain('시나리오 없음: no-such-scenario');
  });

  it.each([
    [
      { BIVE_AGENT: 'scripted', BIVE_SCENARIO: 'pause-implement' },
      '에이전트 scripted · 시나리오 pause-implement',
    ],
    [{}, '에이전트 claude)'],
  ])('올바른 값이면 기동하고 선택을 기록한다 (%j)', async (env, expected) => {
    const home = makeBiveHome();
    const proc = spawnCli({ BIVE_HOME: home, BIVE_IDLE_SHUTDOWN_MS: '60000', ...env });
    await waitFor(() => proc.stdout.includes('오케스트레이터 기동'), 10_000, '기동 로그');
    expect(proc.stdout).toContain(expected);
    proc.child.kill('SIGTERM');
    expect((await proc.exited).code).toBe(0);
  });
});
