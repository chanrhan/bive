// 검증 화면 요약 (JDG-03, COST-02, SCR-05, M1-18, ADR-072).
// 값은 규칙 · 판정 기록 · 실행 · 세션 기록에서만 만든다(NFR-03). 꾸며 낸 값 · 추정 공식 없음.
// - 판정 기준: 가장 최근에 병합된 실행(종료 시각 → 표시 ID 순)의 기준 브랜치 · 병합 커밋. 없으면 `null`
// - 준수: 분모 = 승인된(잠정 승인 제외, JDG-03) 규칙 중 최신 판정이 격리가 아닌 것. 통과 = 분모 중 최신 판정이 통과.
//   규칙 화면 필터 `준수 집계: 판정 가능`(renderer rulesView.ts `complianceGroup`, ADR-060)과 같은 기준이다
// - 최신 판정은 규칙 조회 RPC와 같은 결합 지점(`storedLatestJudgments`, 미래 시각 기록 제외)에서 읽는다
// - 실행당 비용: 끝난 실행(병합 · 실패 · 예산 초과) 중 세션 비용을 모두 아는 실행(`usage.run.costUsd`가 있고
//   값 모르는 세션 0개)의 비용 평균(1e-9 USD 반올림). 그런 실행이 없으면 `null`
// - 실행 링크: 최신 판정의 실행과 그 실행의 비용 합계 · 턴(`runs.usage`, 값 없으면 `null`)
// - 파이프라인: 가장 최근에 만든 실행의 단계 계획(`RUN_STEP_PLANS`) 순서와 단계별 마지막 시도 상태
import {
  isTerminalRunStatus,
  RUN_STEP_PLANS,
  type Rule,
  type RuleJudgment,
  type Run,
  type Step,
  type StepKind,
  type Ulid,
  type UsageTotals,
  type VerificationBasis,
  type VerificationPipeline,
  type VerificationRunLink,
  type VerificationSummaryResult,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import {
  type LatestJudgmentSource,
  storedLatestJudgments,
  toRuleJudgment,
} from '../judgments/latest-judgment.js';

const NANO_PER_USD = 1e9;

/** 규칙이 준수 분모(판정 가능)에 드는지 (ADR-060 · ADR-072). */
export const isJudgeable = (rule: Rule, judgment: RuleJudgment): boolean =>
  rule.normState === 'approved' && judgment.status !== 'quarantined';

/** 시각 → 정렬 값. 없으면 가장 앞. */
const timeOf = (iso: string | null): number => (iso === null ? -Infinity : Date.parse(iso));

/** 가장 최근에 병합된 실행의 판정 기준. 병합된 실행이 없으면 `null`. */
export const basisOf = (runs: readonly Run[]): VerificationBasis | null => {
  let latest: (Run & { mergeCommit: string }) | null = null;
  for (const run of runs) {
    if (run.status !== 'merged' || run.mergeCommit === null) continue;
    if (latest === null || timeOf(run.endedAt) >= timeOf(latest.endedAt)) {
      latest = { ...run, mergeCommit: run.mergeCommit };
    }
  }
  return latest === null
    ? null
    : { branch: latest.baseBranch, commit: latest.mergeCommit, runId: latest.id };
};

/** 실행당 비용: 비용을 모두 아는 끝난 실행의 평균. 없으면 `null`. */
export const costPerRun = (finished: readonly UsageTotals[]): number | null => {
  const known = finished.filter((usage) => usage.costUsd !== null && usage.costUnknownCount === 0);
  if (known.length === 0) return null;
  const nano = known.reduce(
    (sum, usage) => sum + Math.round((usage.costUsd ?? 0) * NANO_PER_USD),
    0,
  );
  return Math.round(nano / known.length) / NANO_PER_USD;
};

/** 단계 계획 순서의 단계와 단계별 마지막 시도 상태 (시도가 없으면 `pending` · 시도 0). */
export const pipelineOf = (run: Run, steps: readonly Step[]): VerificationPipeline => {
  const plan: readonly StepKind[] =
    run.type in RUN_STEP_PLANS ? RUN_STEP_PLANS[run.type as keyof typeof RUN_STEP_PLANS] : [];
  // 계획에 없는 단계 시도가 있으면(유형이 더해진 경우) 시도 순서대로 뒤에 붙인다
  const kinds = [...plan];
  for (const step of steps) if (!kinds.includes(step.kind)) kinds.push(step.kind);
  const stages = kinds.map((kind) => {
    const last = steps
      .filter((step) => step.kind === kind)
      .reduce<Step | null>((a, b) => (a === null || b.attempt > a.attempt ? b : a), null);
    return last === null
      ? { kind, status: 'pending' as const, attempt: 0 }
      : { kind, status: last.status, attempt: last.attempt };
  });
  return { run, stages };
};

/** 열린 프로젝트 저장소에서 검증 화면 요약을 만든다. */
export const verificationSummary = (
  store: ProjectStore,
  latestJudgments: LatestJudgmentSource = storedLatestJudgments,
): VerificationSummaryResult => {
  const lookup = latestJudgments(store);
  const runs = store.runs.list();
  const runsById = new Map(runs.map((run) => [run.id, run]));

  const usageCache = new Map<Ulid, UsageTotals | null>();
  const usageOf = (runId: Ulid): UsageTotals | null => {
    if (!usageCache.has(runId)) usageCache.set(runId, store.runs.usage(runId)?.run ?? null);
    return usageCache.get(runId) ?? null;
  };
  const linkOf = (runId: Ulid | null): VerificationRunLink | null => {
    if (runId === null) return null;
    const run = runsById.get(runId);
    if (run === undefined) return null;
    const usage = usageOf(run.id);
    return {
      id: run.id,
      displayId: run.displayId,
      costUsd: usage?.costUsd ?? null,
      turns: usage?.turns ?? null,
    };
  };

  const rows = store.rules.list().map((rule) => {
    const judgment = toRuleJudgment(lookup(rule.id));
    return { rule, judgment, run: linkOf(judgment.latest?.runId ?? null) };
  });
  const judgeable = rows.filter(({ rule, judgment }) => isJudgeable(rule, judgment));
  const passed = judgeable.filter(({ judgment }) => judgment.status === 'pass').length;

  const finished = runs
    .filter((run) => isTerminalRunStatus(run.status))
    .map((run) => usageOf(run.id))
    .filter((usage): usage is UsageTotals => usage !== null);

  const latestRun = runs.at(-1);
  return {
    basis: basisOf(runs),
    compliance: { passed, judgeable: judgeable.length },
    denominator: judgeable.map(({ rule }) => rule.id),
    costPerRunUsd: costPerRun(finished),
    rules: rows,
    pipeline:
      latestRun === undefined ? null : pipelineOf(latestRun, store.runs.steps(latestRun.id)),
  };
};
