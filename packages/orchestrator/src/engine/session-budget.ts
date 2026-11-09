// 단계 세션의 한도 (COST-01, NFR-07, ADR-024 · ADR-061 · ADR-066).
// 세션 한도 = min(역할 잔여, 실행 잔여). 기준은 실행 시작 때 복사한 예산 스냅샷이고, 사용량은 저장된 세션 결과의
// 합이다. 비용 · 턴 집계 · 기록의 세부(값 없음의 처리, 단계 · 역할 · 실행 합계 저장)는 #30(M1-17)이 맡는다.
// 엔진은 남은 한도가 0 이하면 세션을 열지 않는다: 0을 한도로 넘기면 어댑터가 설정 미비(-32010)처럼 거부해
// 예산 초과가 설정 문제로 잘못 보이기 때문이다.
import type { AgentRole, BudgetSnapshot, Session } from '@bive/shared';

import type { SessionBudget } from '../agent/adapter.js';

/** 사용량. 값을 모르는 세션(`null`)은 0으로 더하지 않고 건너뛴다(아는 사용량만 뺀다, 집계 세부는 #30). */
const spent = (sessions: readonly Session[]): { usd: number; turns: number } => ({
  usd: sessions.reduce((sum, session) => sum + (session.totalCostUsd ?? 0), 0),
  turns: sessions.reduce((sum, session) => sum + (session.numTurns ?? 0), 0),
});

/** 부동소수 오차로 0.0000000001 같은 잔여가 남지 않게 USD는 1e-9 단위로 자른다. */
const roundUsd = (value: number): number => Math.round(value * 1e9) / 1e9;

/**
 * 다음 세션의 한도. 역할 스냅샷이 없으면 `undefined`(설정 미비), 남은 USD · 턴 중 하나라도 0 이하면 `null`(예산 소진).
 */
export const sessionLimits = (
  snapshot: BudgetSnapshot,
  role: AgentRole,
  sessions: readonly Session[],
): SessionBudget | null | undefined => {
  const roleLimits = snapshot.roles[role];
  if (roleLimits === undefined) return undefined;
  const all = spent(sessions);
  const own = spent(sessions.filter((session) => session.role === role));
  const maxBudgetUsd = roundUsd(
    Math.min(roleLimits.maxBudgetUsd - own.usd, snapshot.run.maxBudgetUsd - all.usd),
  );
  const maxTurns = Math.min(roleLimits.maxTurns - own.turns, snapshot.run.maxTurns - all.turns);
  if (!(maxBudgetUsd > 0) || !(maxTurns > 0)) return null;
  return { maxBudgetUsd, maxTurns };
};
