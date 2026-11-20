// 검증 화면 요약 (JDG-03, COST-02, SCR-05, M1-18, ADR-072).
// 값은 규칙 · 판정 기록 · 실행 · 세션 기록에서만 만든다(NFR-03). 꾸며 낸 값 · 추정 공식 없음.
// - 판정 기준: 가장 최근에 병합된 실행(종료 시각 → 표시 ID 순)의 기준 브랜치 · 병합 커밋. 없으면 `null`
// - 판정: 화면의 모든 판정은 판정 기준 커밋에서 낸 판정이다(screens.md SCR-05 머리줄). 기준 실행의 병합 재검사 판정
//   (병합 커밋)이 있으면 그것, 없으면 기준 실행의 검사 단계 판정(`headCommit`, 기준 브랜치가 움직이지 않아 병합 커밋의
//   트리와 같다, ADR-069). 규칙별로 그중 최신(판정 시각 → ID). 구현 단계 판정 · 다른 실행 · 실행 밖 판정 · 미래 시각
//   기록은 쓰지 않는다. 검사 · 병합 재검사는 승인된 규칙 전체(인수 테스트 폴더가 있는 것)를 판정하므로, 그 커밋에서
//   판정되지 않은 규칙(그 뒤 승인 · 인수 테스트 없음)과 판정 기준이 없을 때는 미판정이다
// - 준수: 분모 = 승인된(잠정 승인 제외, JDG-03) 규칙 중 위 판정이 격리가 아닌 것. 통과 = 분모 중 위 판정이 통과.
//   M1에는 격리 판정이 없어 규칙 화면 필터 `준수 집계: 판정 가능`(rulesView.ts `complianceGroup`)과 같은 목록이다
// - 실행당 비용: 끝난 실행(병합 · 실패 · 예산 초과) 중 세션 비용을 모두 아는 실행(`usage.run.costUsd`가 있고
//   값 모르는 세션 0개)의 비용 평균(1e-9 USD 반올림). 그런 실행이 없으면 `null`
// - 실행 링크: 위 판정의 실행(= 기준 실행)과 그 실행의 비용 합계 · 턴(`runs.usage`, 값 없으면 `null`)
// - 파이프라인: 가장 최근에 만든 실행의 단계 계획(`RUN_STEP_PLANS`) 순서와 단계별 마지막 시도 상태
import {
  isTerminalRunStatus,
  type JudgmentResult,
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

import { toRuleJudgment } from '../judgments/latest-judgment.js';

const NANO_PER_USD = 1e9;

/** 지금보다 이만큼 넘게 미래인 판정 기록은 쓰지 않는다 (판정 기록 저장소의 최신 판정 조회와 같은 기준). */
const FUTURE_LIMIT_MS = 60_000;

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

/**
 * 판정 기준 커밋에서 낸 규칙별 판정: 기준 실행의 병합 재검사(병합 커밋) 판정, 없으면 검사 단계(`headCommit`) 판정.
 * 판정 기준이 없으면 빈 표.
 */
export const basisJudgments = (
  store: ProjectStore,
  basis: VerificationBasis | null,
  now: number,
): Map<Ulid, JudgmentResult> => {
  const latest = new Map<Ulid, JudgmentResult>();
  if (basis === null) return latest;
  const run = store.runs.get(basis.runId);
  if (run === null) return latest;
  const kindOf = new Map(store.runs.steps(run.id).map((step) => [step.id, step.kind]));
  const records = store.judgments
    .listByRun(run.id)
    .filter((record) => Date.parse(record.judgedAt) <= now + FUTURE_LIMIT_MS);
  const from = (kind: StepKind, commit: string | null) =>
    records.filter(
      (record) =>
        record.stepId !== null && kindOf.get(record.stepId) === kind && record.commit === commit,
    );
  const merged = from('merge', basis.commit);
  const chosen = merged.length > 0 ? merged : from('check', run.headCommit);
  // listByRun은 판정 시각 → ID 순이므로 뒤의 기록이 규칙별 최신이다
  for (const record of chosen) latest.set(record.ruleId, record);
  return latest;
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
  now: number = Date.now(),
): VerificationSummaryResult => {
  const runs = store.runs.list();
  const basis = basisOf(runs);
  const judged = basisJudgments(store, basis, now);
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
    const judgment = toRuleJudgment(judged.get(rule.id) ?? null);
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
    basis,
    compliance: { passed, judgeable: judgeable.length },
    denominator: judgeable.map(({ rule }) => rule.id),
    costPerRunUsd: costPerRun(finished),
    rules: rows,
    pipeline:
      latestRun === undefined ? null : pipelineOf(latestRun, store.runs.steps(latestRun.id)),
  };
};
