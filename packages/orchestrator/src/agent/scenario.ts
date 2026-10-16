// ScriptedAdapter 시나리오 형식 · 로더 (ADR-016 · ADR-049).
// 파일: packages/orchestrator/scenarios/<이름>.yaml. 잘못된 파일은 ScenarioError로 기동을 막는다.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentRole } from '@bive/shared';
import { parse } from 'yaml';
import { z } from 'zod';

import { RESULT_SUBTYPES } from './adapter.js';

/** src · dist 어느 쪽에서 불러도 패키지 루트의 scenarios/ (둘 다 두 단계 아래). */
export const DEFAULT_SCENARIOS_DIR = fileURLToPath(new URL('../../scenarios/', import.meta.url));

export const SCENARIO_FILE_EXTENSION = '.yaml';

/** 시나리오 이름: 소문자 · 숫자 · 하이픈 (경로 문자 금지). */
const SCENARIO_NAME = /^[a-z0-9][a-z0-9-]*$/;

export class ScenarioError extends Error {
  override readonly name = 'ScenarioError';
}

const NonNegativeInt = z.int().nonnegative();
const NonEmptyString = z.string().min(1);

const ModelUsageSchema = z.strictObject({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadInputTokens: NonNegativeInt,
  cacheCreationInputTokens: NonNegativeInt,
  costUSD: z.number().nonnegative(),
});

/** 합계와 모델별 비용 합의 허용 오차 (소수 USD 표기 반올림 흡수) */
const COST_EPSILON = 1e-9;

const ResultSchema = z
  .strictObject({
    subtype: z.enum(RESULT_SUBTYPES),
    total_cost_usd: z.number().nonnegative().nullable(),
    num_turns: NonNegativeInt,
    modelUsage: z.record(NonEmptyString, ModelUsageSchema),
  })
  .superRefine((result, ctx) => {
    const entries = Object.values(result.modelUsage);
    if (result.total_cost_usd === null || entries.length === 0) return;
    const sum = entries.reduce((acc, usage) => acc + usage.costUSD, 0);
    if (Math.abs(sum - result.total_cost_usd) > COST_EPSILON) {
      ctx.addIssue({
        code: 'custom',
        path: ['total_cost_usd'],
        message: `modelUsage의 costUSD 합(${sum})이 total_cost_usd(${result.total_cost_usd})와 다름`,
      });
    }
  });

/** 도구 호출 턴: 주입된 ToolExecutor로 넘어간다. */
const ToolTurnSchema = z.strictObject({
  tool: NonEmptyString,
  args: z.record(z.string(), z.unknown()).default({}),
});

/** 메시지 턴: 에이전트의 텍스트 응답. */
const MessageTurnSchema = z.strictObject({ message: NonEmptyString });

/**
 * 대기 (턴으로 세지 않음). `removed`(기본): 파일이 없으면 만들고 지워질 때까지 기다린다.
 * `created`: 파일이 생길 때까지 기다린다. 상대 경로는 세션 작업 디렉터리 기준.
 */
const PauseTurnSchema = z.strictObject({
  pause: z.strictObject({
    file: NonEmptyString,
    until: z.enum(['removed', 'created']).default('removed'),
  }),
});

const TurnSchema = z.union([ToolTurnSchema, MessageTurnSchema, PauseTurnSchema]);

const SessionSchema = z.strictObject({
  description: z.string().optional(),
  turns: z.array(TurnSchema),
  result: ResultSchema,
});

const RoleScriptSchema = z.strictObject({
  /** 같은 역할 세션이 열릴 때마다 순서대로 쓴다. 다 쓰면 마지막 세션을 반복한다 */
  sessions: z.array(SessionSchema).min(1),
});

export const ScenarioSchema = z.strictObject({
  name: z.string().regex(SCENARIO_NAME),
  description: NonEmptyString,
  roles: z.partialRecord(AgentRole, RoleScriptSchema),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioSession = z.infer<typeof SessionSchema>;
export type ScenarioTurn = z.infer<typeof TurnSchema>;
export type ScenarioResult = z.infer<typeof ResultSchema>;

/** YAML 문자열을 검증한다. `expectedName`이 있으면 파일 안 `name`과 같아야 한다. */
export const parseScenario = (text: string, expectedName?: string): Scenario => {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ScenarioError(`시나리오 YAML 해석 실패${label(expectedName)}: ${detail}`);
  }
  const parsed = ScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ScenarioError(
      `시나리오 형식 오류${label(expectedName)}:\n${z.prettifyError(parsed.error)}`,
    );
  }
  if (expectedName !== undefined && parsed.data.name !== expectedName) {
    throw new ScenarioError(
      `시나리오 이름 불일치: 파일 ${expectedName}${SCENARIO_FILE_EXTENSION} 안의 name은 ${parsed.data.name}`,
    );
  }
  return parsed.data;
};

const label = (name: string | undefined): string => (name === undefined ? '' : ` (${name})`);

/** `scenarios/<name>.yaml`을 읽어 검증한다. 없거나 잘못되면 ScenarioError. */
export const loadScenario = (name: string, dir: string = DEFAULT_SCENARIOS_DIR): Scenario => {
  if (!SCENARIO_NAME.test(name)) {
    throw new ScenarioError(`시나리오 이름 형식 오류: ${JSON.stringify(name)}`);
  }
  const file = path.join(dir, `${name}${SCENARIO_FILE_EXTENSION}`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const known = listScenarios(dir);
      throw new ScenarioError(
        `시나리오 없음: ${name} (있는 시나리오: ${known.length > 0 ? known.join(', ') : '없음'})`,
      );
    }
    throw error;
  }
  return parseScenario(text, name);
};

/** 시나리오 이름 목록 (정렬). 폴더가 없으면 빈 목록. */
export const listScenarios = (dir: string = DEFAULT_SCENARIOS_DIR): string[] => {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return files
    .filter((file) => file.endsWith(SCENARIO_FILE_EXTENSION))
    .map((file) => file.slice(0, -SCENARIO_FILE_EXTENSION.length))
    .filter((name) => SCENARIO_NAME.test(name))
    .sort();
};
