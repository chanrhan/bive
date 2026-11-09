// 단계 세션의 한도 · 집계 초과 판정 (COST-01, NFR-07, ADR-024 · ADR-061 · ADR-066 · ADR-067).
// 세션 한도 = min(역할 잔여, 실행 잔여). 기준은 실행 시작 때 복사한 예산 스냅샷이고, 사용량은 저장된 세션 결과의
// 합(나노 달러 정수 합산)이다. 표시 · 기록용 합계(`sumSessionUsage`)는 값 없음을 `null`로 두지만(COST-02), 한도
// 계산에서는 값을 모르는 세션을 0으로 세지 않는다(NFR-07, 중단 · 재개를 되풀이해도 쓴 돈이 예산에서 빠지지 않게):
// - init 보고 없이 끝난 세션: 모델 호출 전에 끝났으므로 0 (SDK는 첫 모델 요청 전에 init을 낸다)
// - 그 밖(init 뒤 결과 없음 · 비정상 종료로 `aborted` · 아직 끝나지 않음): 그 실행에서 값을 아는 세션 중 가장 큰 값
//   (그 세션에 넘긴 한도를 넘지 않게 자름), 아는 세션이 없으면 그 세션에 넘긴 한도(`Session.budget`, 기록이 없으면
//   역할 스냅샷 한도 → 실행 한도)를 다 쓴 것. 턴은 최소 1로 센다: 아는 세션이 모두 0턴이어도 이런 세션이 쌓이면
//   턴 한도가 반드시 소진되어, 중단 · 재개 되풀이가 끝없이 이어지지 않는다
// 남은 USD는 한도를 나노 달러 단위로 내리고 사용량을 올려 계산한다(`remainingUsd`). 엔진은 남은 한도가 0 이하면
// 세션을 열지 않는다: 0을 한도로 넘기면 어댑터가 설정 미비(-32010)처럼 거부해 예산 초과가 설정 문제로 잘못 보이기
// 때문이다. 세션이 끝난 뒤 같은 방식의 합계가 한도를 넘었으면(`budgetOverrun`) 결과 subtype이 성공이어도 실행을
// `budget_exceeded`로 끝낸다.
import {
  type AgentRole,
  type BudgetLimits,
  type BudgetSnapshot,
  remainingUsd,
  type Session,
  sumUsd,
} from '@bive/shared';

import type { SessionBudget } from '../agent/adapter.js';

/** 세션 한도 기록이 없을 때 쓰는 한도: 역할 스냅샷 한도 → 실행 한도. */
const sessionAllotment = (session: Session, snapshot: BudgetSnapshot): BudgetLimits =>
  session.budget ?? snapshot.roles[session.role] ?? snapshot.run;

/** 세션 1개를 한도 계산에서 센 값. `estimated`는 값을 몰라 추정했는지(init 전 0 포함). */
export interface ChargedSession {
  readonly session: Session;
  readonly usd: number;
  readonly turns: number;
  readonly estimated: { readonly usd: boolean; readonly turns: boolean };
}

/**
 * 실행의 세션마다 한도 계산에 쓰는 사용량을 매긴다 (규칙은 파일 머리 주석). 추정은 실행 전체의 세션으로 하므로
 * 역할별로 거를 때도 실행의 세션 전부를 넘기고 결과를 거른다.
 */
export const chargeSessions = (
  snapshot: BudgetSnapshot,
  sessions: readonly Session[],
): ChargedSession[] => {
  const knownUsd = sessions.flatMap((s) => (s.totalCostUsd === null ? [] : [s.totalCostUsd]));
  const knownTurns = sessions.flatMap((s) => (s.numTurns === null ? [] : [s.numTurns]));
  const maxUsd = knownUsd.length === 0 ? null : Math.max(...knownUsd);
  const maxTurns = knownTurns.length === 0 ? null : Math.max(...knownTurns);
  return sessions.map((session) => {
    const beforeModel = session.sdkSessionId === null && session.endReason !== null;
    const allotment = sessionAllotment(session, snapshot);
    const usd =
      session.totalCostUsd ??
      (beforeModel ? 0 : Math.min(maxUsd ?? allotment.maxBudgetUsd, allotment.maxBudgetUsd));
    const turns =
      session.numTurns ??
      (beforeModel ? 0 : Math.min(Math.max(maxTurns ?? allotment.maxTurns, 1), allotment.maxTurns));
    return {
      session,
      usd,
      turns,
      estimated: { usd: session.totalCostUsd === null, turns: session.numTurns === null },
    };
  });
};

/** 한도 계산용 합계. `known`은 보고된 값만, `estimated`는 추정분, `unknownSessions`는 추정한 세션 수. */
interface ChargedTotal {
  readonly value: number;
  readonly known: number;
  readonly estimated: number;
  readonly unknownSessions: number;
}

const totalOf = (charged: readonly ChargedSession[], measure: 'usd' | 'turns'): ChargedTotal => {
  const pick = (c: ChargedSession): number => (measure === 'usd' ? c.usd : c.turns);
  const add = (values: number[]): number =>
    measure === 'usd' ? (sumUsd(values) ?? 0) : values.reduce((sum, v) => sum + v, 0);
  const known = charged.filter((c) => !c.estimated[measure]);
  const guessed = charged.filter((c) => c.estimated[measure]);
  return {
    value: add(charged.map(pick)),
    known: add(known.map(pick)),
    estimated: add(guessed.map(pick)),
    unknownSessions: guessed.length,
  };
};

interface ScopeTotals {
  readonly usd: ChargedTotal;
  readonly turns: ChargedTotal;
}

/** 실행 전체와 역할의 한도 계산용 사용량. */
const chargedUsage = (
  snapshot: BudgetSnapshot,
  role: AgentRole,
  sessions: readonly Session[],
): { all: ScopeTotals; own: ScopeTotals } => {
  const charged = chargeSessions(snapshot, sessions);
  const own = charged.filter((c) => c.session.role === role);
  return {
    all: { usd: totalOf(charged, 'usd'), turns: totalOf(charged, 'turns') },
    own: { usd: totalOf(own, 'usd'), turns: totalOf(own, 'turns') },
  };
};

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
  const { all, own } = chargedUsage(snapshot, role, sessions);
  const maxBudgetUsd = Math.min(
    remainingUsd(roleLimits.maxBudgetUsd, own.usd.value),
    remainingUsd(snapshot.run.maxBudgetUsd, all.usd.value),
  );
  const maxTurns = Math.min(
    roleLimits.maxTurns - own.turns.value,
    snapshot.run.maxTurns - all.turns.value,
  );
  if (!(maxBudgetUsd > 0) || !(maxTurns > 0)) return null;
  return { maxBudgetUsd, maxTurns };
};

/**
 * 한도를 넘은 합계 1건 (`budget_aggregate_exceeded`의 종료 조건 결과). `spent` = `known`(보고된 값의 합) +
 * `estimated`(값을 모르는 세션 `unknownSessions`개의 추정분). 추정분이 있으면 화면이 그 사실을 함께 보일 수 있다(NFR-03).
 */
export interface BudgetOverrun {
  /** 넘은 한도: 역할(`role`) 또는 실행 전체(`run`) */
  readonly scope: 'role' | 'run';
  readonly measure: 'usd' | 'turns';
  readonly role: AgentRole;
  readonly limit: number;
  readonly spent: number;
  readonly known: number;
  readonly estimated: number;
  readonly unknownSessions: number;
}

const overrunOf = (
  scope: BudgetOverrun['scope'],
  measure: BudgetOverrun['measure'],
  role: AgentRole,
  limit: number,
  total: ChargedTotal,
): BudgetOverrun => ({
  scope,
  measure,
  role,
  limit,
  spent: total.value,
  known: total.known,
  estimated: total.estimated,
  unknownSessions: total.unknownSessions,
});

/**
 * 역할 · 실행 사용량 합계(`chargeSessions`, 값을 모르는 세션은 추정값)가 스냅샷 한도를 넘었는지 (같으면 넘은 것이
 * 아니다). 넘었으면 역할 → 실행, USD → 턴 순으로 첫 1건, 아니면 `null`. 역할 스냅샷이 없으면 실행 한도만 본다.
 * 추정은 지금까지 아는 최댓값을 쓰므로, 더 큰 값을 아는 세션이 뒤에 오면 앞선 추정분이 소급해 커질 수 있다
 * (ADR-067 한계: 재개 세션이 받은 한도 안에서 끝나도 초과로 판정될 수 있음).
 */
export const budgetOverrun = (
  snapshot: BudgetSnapshot,
  role: AgentRole,
  sessions: readonly Session[],
): BudgetOverrun | null => {
  const { all, own } = chargedUsage(snapshot, role, sessions);
  const roleLimits = snapshot.roles[role];
  const checks: BudgetOverrun[] = [];
  if (roleLimits !== undefined) {
    checks.push(
      overrunOf('role', 'usd', role, roleLimits.maxBudgetUsd, own.usd),
      overrunOf('role', 'turns', role, roleLimits.maxTurns, own.turns),
    );
  }
  checks.push(
    overrunOf('run', 'usd', role, snapshot.run.maxBudgetUsd, all.usd),
    overrunOf('run', 'turns', role, snapshot.run.maxTurns, all.turns),
  );
  // USD는 나노 달러 단위로 비교한다 (부동소수 표기 차이로 같은 값이 넘은 것으로 보이지 않게)
  const exceeds = (check: BudgetOverrun): boolean =>
    check.measure === 'usd'
      ? remainingUsd(check.limit, check.spent) < 0
      : check.spent > check.limit;
  return checks.find(exceeds) ?? null;
};
