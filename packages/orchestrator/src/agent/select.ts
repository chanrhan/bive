// 어댑터 선택 (ADR-016 · ADR-049 · ADR-059).
// BIVE_AGENT: `scripted` | `claude` (기본 `claude`). 빈 값은 미설정과 같다.
// `claude`는 API 키가 없어도 선택되고, 세션을 열면 not_configured로 끝난다.
// BIVE_SCENARIO: 시나리오 이름 (기본 `happy-path`). `scripted`일 때만 읽는다.
// 잘못된 값 · 없는 시나리오 · 형식이 틀린 시나리오는 AgentConfigError → CLI 종료 코드 2.
import { AGENT_KINDS, type AgentAdapter, type AgentKind } from './adapter.js';
import { ClaudeSdkAdapter } from './claude-sdk-adapter.js';
import { DEFAULT_SCENARIOS_DIR, loadScenario, ScenarioError } from './scenario.js';
import { ScriptedAdapter } from './scripted-adapter.js';

export const DEFAULT_AGENT_KIND: AgentKind = 'claude';
export const DEFAULT_SCENARIO = 'happy-path';

export class AgentConfigError extends Error {
  override readonly name = 'AgentConfigError';
}

export interface AgentSelection {
  kind: AgentKind;
  adapter: AgentAdapter;
  /** scripted일 때 시나리오 이름, 아니면 null */
  scenario: string | null;
}

export interface SelectAgentOptions {
  biveHome: string;
  scenariosDir?: string;
  /** ScriptedAdapter pause 확인 간격 */
  pollIntervalMs?: number;
}

const isAgentKind = (value: string): value is AgentKind =>
  (AGENT_KINDS as readonly string[]).includes(value);

const envValue = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value.length === 0 ? undefined : value;
};

/** 환경 변수로 어댑터를 고른다. 기동 시 한 번 부른다. */
export const selectAgent = (
  env: NodeJS.ProcessEnv,
  options: SelectAgentOptions,
): AgentSelection => {
  const kind = envValue(env, 'BIVE_AGENT') ?? DEFAULT_AGENT_KIND;
  if (!isAgentKind(kind)) {
    throw new AgentConfigError(
      `BIVE_AGENT는 ${AGENT_KINDS.join(' 또는 ')}여야 함: ${JSON.stringify(kind)}`,
    );
  }
  if (kind === 'claude') {
    // API 키가 없어도 선택 · 기동은 되고, 세션을 열면 not_configured로 끝난다 (ADR-059)
    return {
      kind,
      adapter: new ClaudeSdkAdapter({ biveHome: options.biveHome, env }),
      scenario: null,
    };
  }
  const name = envValue(env, 'BIVE_SCENARIO') ?? DEFAULT_SCENARIO;
  try {
    const scenario = loadScenario(name, options.scenariosDir ?? DEFAULT_SCENARIOS_DIR);
    const adapter = new ScriptedAdapter({
      scenario,
      biveHome: options.biveHome,
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    });
    return { kind, adapter, scenario: name };
  } catch (error) {
    if (error instanceof ScenarioError) {
      throw new AgentConfigError(`BIVE_SCENARIO 오류: ${error.message}`);
    }
    throw error;
  }
};
