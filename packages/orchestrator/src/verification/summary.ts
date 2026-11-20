// 검증 화면 요약 (JDG-03, COST-02, SCR-05, M1-18, ADR-072).
// 값은 규칙 · 판정 기록 · 실행 · 세션 기록에서만 만든다(NFR-03). 꾸며 낸 값 · 추정 공식 없음.
// - 판정 기준: 가장 나중에 병합된 실행의 기준 브랜치 · 병합 커밋. 없으면 `null`.
//   병합된 실행 = 병합 커밋이 기록된 실행(상태와 무관, ADR-094): 병합 뒤 화면 갱신 도중 종료돼 `interrupted`인 실행도
//   기준 브랜치에는 그 병합 커밋이 있으므로 기준이 된다. 순서: 후보 모두에 병합 순서 값(병합 실행기가 병합 커밋에서 읽어
//   병합 단계 결과에 저장한 첫 부모 커밋 수)이 있고 기준 브랜치가 같으면 그 값, 하나라도 없으면 후보 모두를 시각
//   (병합 단계가 통과로 끝난 시각, 없으면 종료 시각)으로 비교한다. 같으면 생성 시각 → ID. 조회 때 git을 부르지 않는다
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

/** 실행의 병합 단계 기록: 마지막 통과 시도의 끝난 시각과 그 시도가 저장한 병합 순서 값. */
export interface MergeRecord {
  /** 병합 단계가 통과로 끝난 시각 */
  at: string | null;
  /** 기준 브랜치에서 병합 커밋까지의 첫 부모 커밋 수 (ADR-094, 이 값을 저장하기 전의 기록이면 `null`) */
  order: number | null;
}

/**
 * 가장 나중에 병합된 실행의 판정 기준. 병합 커밋이 기록된 실행이 없으면 `null`.
 * 병합 커밋이 기록된 실행은 상태와 무관하게 후보다(ADR-094: 병합은 이미 기준 브랜치의 사실이다. 그 값은 병합 실행기가
 * 기준 브랜치를 확인한 `passed`일 때만 채워진다, ADR-091).
 * 순서(ADR-094): 후보 모두에 병합 순서 값이 있고 기준 브랜치가 모두 같으면 병합 순서 값으로 비교한다. 하나라도 아니면
 * 후보 모두를 시각(병합 단계가 통과로 끝난 시각, 없으면 종료 시각)으로 비교한다. 어느 쪽이든 같으면 생성 시각, 그다음
 * ID(ULID). 비교 기준이 후보 전체에 하나라서 결과가 목록 순서와 무관하다.
 */
export const basisOf = (
  runs: readonly Run[],
  mergeOf: (run: Run) => MergeRecord | null = () => null,
): VerificationBasis | null => {
  const candidates = runs
    .filter((run): run is Run & { mergeCommit: string } => run.mergeCommit !== null)
    .map((run) => ({ run, merge: mergeOf(run) }));
  const first = candidates[0];
  if (first === undefined) return null;
  const byOrder = candidates.every(
    ({ run, merge }) =>
      merge !== null && merge.order !== null && run.baseBranch === first.run.baseBranch,
  );
  const keyOf = ({ run, merge }: (typeof candidates)[number]): [number, number, string] => [
    byOrder ? (merge?.order ?? -Infinity) : timeOf(merge?.at ?? run.endedAt),
    timeOf(run.createdAt),
    run.id,
  ];
  let latest = first;
  for (const candidate of candidates.slice(1)) {
    if (compareKey(keyOf(candidate), keyOf(latest)) > 0) latest = candidate;
  }
  return { branch: latest.run.baseBranch, commit: latest.run.mergeCommit, runId: latest.run.id };
};

const compareKey = (a: [number, number, string], b: [number, number, string]): number =>
  a[0] !== b[0]
    ? a[0] - b[0]
    : a[1] !== b[1]
      ? a[1] - b[1]
      : a[2] < b[2]
        ? -1
        : a[2] > b[2]
          ? 1
          : 0;

/** 병합 단계 결과에 저장된 병합 순서 값 (1 이상의 정수가 아니면 `null`). */
const mergeOrderIn = (exitDetail: unknown): number | null => {
  if (typeof exitDetail !== 'object' || exitDetail === null) return null;
  const value = (exitDetail as { mergeOrder?: unknown }).mergeOrder;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
};

/** 실행의 병합 단계 기록: 통과한 시도 중 마지막(끝난 시각) 것. 통과한 시도가 없으면 `null`. */
const mergeRecordOf = (store: ProjectStore, run: Run): MergeRecord | null => {
  const passed = store.runs
    .steps(run.id)
    .filter((step) => step.kind === 'merge' && step.status === 'passed')
    .reduce<Step | null>(
      (latest, step) =>
        latest === null || timeOf(step.endedAt) > timeOf(latest.endedAt) ? step : latest,
      null,
    );
  return passed === null ? null : { at: passed.endedAt, order: mergeOrderIn(passed.exitDetail) };
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
  const basis = basisOf(runs, (run) => mergeRecordOf(store, run));
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
