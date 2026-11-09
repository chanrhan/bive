// 비용 · 턴 집계 (COST-01, COST-02, NFR-03, ADR-067).
// - 근거는 세션 결과(`total_cost_usd` · `num_turns` · `modelUsage`)뿐이다. 세션 → 단계 시도 → 역할 → 실행 순으로 더한다
// - 값이 없는 세션(`null`)은 0으로 더하지 않고 건너뛴다. 묶음 안의 값이 모두 없으면 합계도 `null`이다(COST-02 '없음')
// - USD는 1e-9 USD(나노 달러) 정수로 바꿔 더한 뒤 USD로 되돌린다: 더하는 순서와 무관하게 같은 값이 나오고
//   0.1 + 0.2 같은 부동소수 오차가 합계 · 잔여 한도에 남지 않는다
import { z } from 'zod';

import { ModelUsage, Session, Step, UsdOrNull } from './domain.js';
import { AgentRole, StepKind } from './enums.js';
import { Ulid } from './id.js';

const NonNegativeInt = z.int().nonnegative();
const NonEmptyString = z.string().min(1);

/** USD 합산 단위 (1e-9 USD). */
const NANO_PER_USD = 1e9;

const toNanoUsd = (usd: number): number => Math.round(usd * NANO_PER_USD);
const fromNanoUsd = (nano: number): number => nano / NANO_PER_USD;

/** USD 값들의 합. `null`은 건너뛰고, 모두 `null`(또는 빈 목록)이면 `null`. */
export const sumUsd = (values: readonly (number | null)[]): number | null => {
  let nano: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    nano = (nano ?? 0) + toNanoUsd(value);
  }
  return nano === null ? null : fromNanoUsd(nano);
};

/** USD 차 `a - b` (나노 달러 단위로 계산해 부동소수 오차를 남기지 않는다). */
export const subtractUsd = (a: number, b: number): number =>
  fromNanoUsd(toNanoUsd(a) - toNanoUsd(b));

/** 정수(턴 · 토큰) 합. `null`은 건너뛰고, 모두 `null`이면 `null`. */
const sumInt = (values: readonly (number | null)[]): number | null => {
  let sum: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    sum = (sum ?? 0) + value;
  }
  return sum;
};

/**
 * 세션 묶음의 사용량 합계 (COST-02).
 * - `costUsd` · `turns`: 값이 있는 세션만 더한다. 모두 없으면 `null`
 * - `modelUsage`: 모델 이름별로 토큰 · 비용을 더한다(비용은 위와 같은 `null` 규칙). 모델별 사용량을 보고한 세션이
 *   하나도 없으면 `null`
 * - `sessionCount`: 묶음의 세션 수(진행 중 · 결과 없이 끝난 세션 포함)
 * - `costUnknownCount` · `turnsUnknownCount`: 값이 없어 합계에 들어가지 않은 세션 수. 0이 아니면 합계는 하한이다
 */
export const UsageTotals = z.strictObject({
  costUsd: UsdOrNull,
  turns: NonNegativeInt.nullable(),
  modelUsage: z.record(NonEmptyString, ModelUsage).nullable(),
  sessionCount: NonNegativeInt,
  costUnknownCount: NonNegativeInt,
  turnsUnknownCount: NonNegativeInt,
});
export type UsageTotals = z.infer<typeof UsageTotals>;

/** 에이전트 단계 시도 1개의 사용량 (그 시도에서 연 세션의 합). */
export const StepUsage = UsageTotals.extend({
  stepId: Ulid,
  kind: StepKind,
  attempt: z.int().positive(),
  role: AgentRole,
});
export type StepUsage = z.infer<typeof StepUsage>;

/**
 * 실행 1건의 사용량 (COST-02, ADR-067): 실행 합계 · 역할별 합계 · 에이전트 단계 시도별 합계.
 * 역할은 실행이 쓰는 역할(예산 스냅샷의 역할)과 세션이 있는 역할 전부이고, 단계는 역할이 있는 시도만 단계 순서대로다.
 */
export const RunUsage = z.strictObject({
  run: UsageTotals,
  roles: z.partialRecord(AgentRole, UsageTotals),
  steps: z.array(StepUsage),
});
export type RunUsage = z.infer<typeof RunUsage>;

/** 합산에 쓰는 세션 필드. */
export type SessionUsageInput = Pick<
  Session,
  'role' | 'stepId' | 'totalCostUsd' | 'numTurns' | 'modelUsage'
>;

const mergeModelUsage = (
  sessions: readonly SessionUsageInput[],
): Record<string, ModelUsage> | null => {
  const byModel = new Map<string, ModelUsage[]>();
  for (const session of sessions) {
    for (const [model, usage] of Object.entries(session.modelUsage)) {
      byModel.set(model, [...(byModel.get(model) ?? []), usage]);
    }
  }
  if (byModel.size === 0) return null;
  const merged: Record<string, ModelUsage> = {};
  for (const [model, usages] of byModel) {
    const tokens = (pick: (usage: ModelUsage) => number): number =>
      usages.reduce((sum, usage) => sum + pick(usage), 0);
    merged[model] = {
      inputTokens: tokens((usage) => usage.inputTokens),
      outputTokens: tokens((usage) => usage.outputTokens),
      cacheReadInputTokens: tokens((usage) => usage.cacheReadInputTokens),
      cacheCreationInputTokens: tokens((usage) => usage.cacheCreationInputTokens),
      costUsd: sumUsd(usages.map((usage) => usage.costUsd)),
    };
  }
  return merged;
};

/** 세션 묶음의 합계 (`UsageTotals`). */
export const sumSessionUsage = (sessions: readonly SessionUsageInput[]): UsageTotals => ({
  costUsd: sumUsd(sessions.map((session) => session.totalCostUsd)),
  turns: sumInt(sessions.map((session) => session.numTurns)),
  modelUsage: mergeModelUsage(sessions),
  sessionCount: sessions.length,
  costUnknownCount: sessions.filter((session) => session.totalCostUsd === null).length,
  turnsUnknownCount: sessions.filter((session) => session.numTurns === null).length,
});

/**
 * 실행의 사용량을 세션에서 단계 시도 → 역할 → 실행 순으로 모은다.
 * @param roles 실행이 쓰는 역할 (예산 스냅샷의 역할). 세션이 없어도 합계(`null`)를 둔다
 * @param steps 실행의 단계 시도 (단계 순서). 역할이 있는 시도만 단계 합계를 둔다
 * @param sessions 실행의 세션
 */
export const summarizeRunUsage = (
  roles: readonly AgentRole[],
  steps: readonly Pick<Step, 'id' | 'kind' | 'attempt' | 'role'>[],
  sessions: readonly SessionUsageInput[],
): RunUsage => {
  const stepUsages: StepUsage[] = [];
  for (const step of steps) {
    if (step.role === null) continue;
    stepUsages.push({
      stepId: step.id,
      kind: step.kind,
      attempt: step.attempt,
      role: step.role,
      ...sumSessionUsage(sessions.filter((session) => session.stepId === step.id)),
    });
  }
  const roleNames = [...roles];
  for (const session of sessions) {
    if (!roleNames.includes(session.role)) roleNames.push(session.role);
  }
  const roleUsages: Partial<Record<AgentRole, UsageTotals>> = {};
  for (const role of roleNames) {
    roleUsages[role] = sumSessionUsage(sessions.filter((session) => session.role === role));
  }
  return { run: sumSessionUsage(sessions), roles: roleUsages, steps: stepUsages };
};
