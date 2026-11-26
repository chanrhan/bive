// 검증 화면 요약 (JDG-03, COST-02, SCR-05, M1-18, ADR-072).
// 값은 규칙 · 판정 기록 · 실행 · 세션 기록에서만 만든다(NFR-03). 꾸며 낸 값 · 추정 공식 없음.
// - 판정 기준: 가장 나중에 병합된 실행의 기준 브랜치 · 병합 커밋. 없으면 `null` (ADR-096)
//   후보 = 병합 커밋이 기록된 실행(상태와 무관: 병합 뒤 화면 갱신 도중 종료돼 `interrupted`인 실행 포함). 순서는 후보마다
//   혼자 정해지는 열쇠 하나의 사전식 비교(후보 전체에 하나의 전순서, 입력 순서와 무관): ① 기준 브랜치가 프로젝트의 지금
//   기준 브랜치인 후보 먼저 ② 병합 순서 값(병합 실행기가 병합 커밋의 전체 조상 수를 읽어 병합 단계 통과 시도의 결과에 저장한
//   값)이 있는 후보 먼저, 있으면 그 값 ③ 병합 단계가 통과로 끝난 시각 ④ 생성 시각 ⑤ ID. 조회 때 git을 부르지 않는다
// - 판정: 화면의 모든 판정은 판정 기준 커밋에서 낸 판정이다(screens.md SCR-05 머리줄). 기준 실행의 병합 재검사 판정
//   (병합 커밋)이 있으면 그것, 없으면 기준 실행의 검사 단계 판정(`headCommit`, 기준 브랜치가 움직이지 않아 병합 커밋의
//   트리와 같다, ADR-069). 규칙별로 그중 최신(판정 시각 → ID). 구현 단계 판정 · 다른 실행 · 실행 밖 판정 · 미래 시각
//   기록은 쓰지 않는다. 검사 · 병합 재검사는 승인된 규칙 전체(인수 테스트 폴더가 있는 것)를 판정하므로, 그 커밋에서
//   판정되지 않은 규칙(그 뒤 승인 · 인수 테스트 없음)과 판정 기준이 없을 때는 미판정이다
// - 준수: 분모 = 효력 있는(잠정 승인 · 폐기 제외, JDG-03 · M7-09) 규칙 중 위 판정이 격리가 아닌 것. 통과 = 분모 중 위 판정이 통과.
//   폐기된 규칙은 규칙 목록(`rules`)에서도 빠진다(판정 이력은 지우지 않는다, ADR-112).
//   M1에는 격리 판정이 없어 규칙 화면 필터 `준수 집계: 판정 가능`(rulesView.ts `complianceGroup`)과 같은 목록이다
// - 사람 확인 기준 준수(ADR-100 D7, ADR-117): 위 분모를 지금 확인됨인 규칙으로 좁힌 것. 효력 있는 확인됨 규칙이 없으면 `null`.
//   규칙 화면 필터 `준수 집계: 판정 가능` + `확인: 확인됨`(= "사람 확인" 값, rulesView.ts `complianceValues`)과 같은 정의다
// - 에이전트 폐기 수(ADR-100 B⑦, ADR-117): 규범 변경 기록의 에이전트 폐기 · 대체 대상 규칙 수(전체 누적)
// - 추적성 결함 · 규칙화 불가 비율(NRM-06 · NRM-08, M3-11 #56 · ADR-137): 규칙 없는 요구사항 · 부모 없는 규칙의 목록과 '규칙화
//   불가' 요구사항 수 / 삭제되지 않은 요구사항 수. 같은 함수(`traceabilityOf`)를 `rule.list`도 쓴다
// - 실행당 비용: 끝난 실행(병합 · 실패 · 예산 초과) 중 세션 비용을 모두 아는 실행(`usage.run.costUsd`가 있고
//   값 모르는 세션 0개)의 비용 평균(1e-9 USD 반올림). 그런 실행이 없으면 `null`
// - 실행 링크: 위 판정의 실행(= 기준 실행)과 그 실행의 비용 합계 · 턴(`runs.usage`, 값 없으면 `null`)
// - 파이프라인: 보일 실행(`pipelineRunOf`)의 단계 계획(`RUN_STEP_PLANS`) 순서와 단계별 마지막 시도 상태, 그 밖의 실행 대기
//   건수. 보일 실행은 자리를 차지한 실행(진행 중, 없으면 가장 먼저 만든 중단)이고 없으면 가장 최근에 만든 실행이다
//   (ADR-105: 실행 대기는 아직 시작하지 않은 실행이라 "최근 실행"을 가장 최근에 시작된 실행으로 읽는다. 중단된 실행이 자리를
//   지키는 동안 그 [재개]가 화면에서 가려지지 않게)
import {
  isTerminalRunStatus,
  type JudgmentResult,
  type NormChangeEntry,
  type NormChangeKind,
  RUN_STEP_PLANS,
  type Rule,
  type Requirement,
  type RuleJudgment,
  type Run,
  type Step,
  type StepKind,
  type Traceability,
  type Ulid,
  type UsageTotals,
  type VerificationBasis,
  type VerificationPipeline,
  type VerificationRunLink,
  type VerificationSummaryResult,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import { toRuleJudgment } from '../judgments/latest-judgment.js';
import { isEffectiveRule, retiredRuleSet, unretiredRules } from '../norms/effective.js';

const NANO_PER_USD = 1e9;

/** 에이전트가 규칙을 폐기한 규범 변경 기록 종류: 폐기 · 대체 (ADR-100 B⑦, ADR-112). 이 모듈은 기록을 읽기만 한다. */
const AGENT_RETIREMENT_KINDS: ReadonlySet<NormChangeKind> = new Set<NormChangeKind>([
  'retired',
  'superseded',
]);

/**
 * 에이전트가 폐기한 규칙 수 (ADR-100 B⑦, ADR-117): 규범 변경 기록 가운데 에이전트 주체의 폐기 · 대체 기록이 가리키는 규칙의
 * 수(전체 누적, 같은 규칙은 한 번). 그 뒤 사람이 규칙을 지웠어도 센다(에이전트의 폐기는 기록에서 사라지지 않는다).
 */
export const agentRetiredRuleCount = (entries: readonly NormChangeEntry[]): number =>
  new Set(
    entries
      .filter(
        (entry) =>
          AGENT_RETIREMENT_KINDS.has(entry.kind) &&
          entry.actor.kind === 'agent' &&
          entry.targetRef.entity === 'Rule',
      )
      .map((entry) => entry.targetRef.id),
  ).size;

/** 사람 확인 기준 준수와 그 분모 목록 (ADR-100 D7, ADR-117). */
export interface ConfirmedCompliance {
  compliance: VerificationSummaryResult['confirmedCompliance'];
  denominator: Ulid[];
}

/**
 * 사람 확인 기준 준수: 효력 있는(폐기 제외, `norms/effective.ts`) 규칙 중 지금 확인됨인 것만 센다. 폐기된 규칙은 확인됨일 수
 * 있으므로(사람이 폐기를 봤다고 확인, ADR-113) 확인 상태만 보지 않고 효력을 먼저 본다. 효력 있는 확인됨 규칙이 없으면 `null`.
 * 확인 상태는 응답에 실린 규칙의 `confirmation`만 읽는다(표시용 집계, 판정 · 병합의 조건이 아니다).
 */
export const humanConfirmedCompliance = (
  rows: readonly { rule: Rule; judgment: RuleJudgment }[],
  retired: ReadonlySet<string>,
): ConfirmedCompliance => {
  const confirmed = rows.filter(
    ({ rule }) => isEffectiveRule(rule, retired) && rule.confirmation.state === 'confirmed',
  );
  if (confirmed.length === 0) return { compliance: null, denominator: [] };
  const judgeable = confirmed.filter(({ rule, judgment }) => isJudgeable(rule, judgment, retired));
  return {
    compliance: {
      passed: judgeable.filter(({ judgment }) => judgment.status === 'pass').length,
      judgeable: judgeable.length,
      confirmed: confirmed.length,
    },
    denominator: judgeable.map(({ rule }) => rule.id),
  };
};

/** 지금보다 이만큼 넘게 미래인 판정 기록은 쓰지 않는다 (판정 기록 저장소의 최신 판정 조회와 같은 기준). */
const FUTURE_LIMIT_MS = 60_000;

/**
 * 규칙이 준수 분모(판정 가능)에 드는지 (ADR-060 · ADR-072): 효력 있는 규칙(`norms/effective.ts`, 폐기된 규칙 제외 · M7-09)이고
 * 판정이 격리가 아님. `retired` = 폐기된 규칙 ID.
 */
export const isJudgeable = (
  rule: Rule,
  judgment: RuleJudgment,
  retired: ReadonlySet<string>,
): boolean => isEffectiveRule(rule, retired) && judgment.status !== 'quarantined';

/**
 * 추적성 결함 가운데 부모 없는 규칙 (NRM-06, 기획서 4.1): 효력 있는 규칙 가운데 부모 요구사항이 없는 것(부모가 지워져 해제된 규칙).
 * 내장 규칙(`builtin`: 구조 규칙 · 계약 검사 규칙)은 부모가 없는 것이 정상이라 결함에서 뺀다(NRM-02 · NRM-06, ADR-127 · ADR-129).
 * 폐기된 규칙도 뺀다(ADR-100 NRM-06). `liveRequirementIds`(삭제되지 않은 요구사항 ID)를 주면 부모 ID는 있으나 그 요구사항이
 * 삭제됐거나 없는 규칙도 부모 없는 규칙이다(ADR-137). 내장 구조 규칙은 준수 분모(`isJudgeable`)에는 든다.
 */
export const parentlessRuleDefects = (
  rules: readonly Rule[],
  retired: ReadonlySet<string>,
  liveRequirementIds?: ReadonlySet<string>,
): Rule[] =>
  rules.filter(
    (rule) =>
      isEffectiveRule(rule, retired) &&
      !rule.builtin &&
      (rule.parentRequirementId === null ||
        (liveRequirementIds !== undefined && !liveRequirementIds.has(rule.parentRequirementId))),
  );

/**
 * 추적성 결함 가운데 규칙 없는 요구사항 (NRM-06 · NRM-08, ADR-137): 삭제되지 않았고 '규칙화 불가'가 아니며 효력 있는 자식 규칙이
 * 하나도 없는 요구사항(받은 순서). 효력 없는 규칙(삭제 · 폐기 · 잠정)은 자식으로 세지 않는다: 자식 규칙이 모두 폐기된 요구사항은
 * 규칙 없는 요구사항이다(ADR-112 "폐기 규칙만 자식으로 남은 요구사항", ADR-100 NRM-06 "폐기된 규칙은 결함 계산에서 뺀다").
 */
export const requirementsWithoutRules = (
  requirements: readonly Requirement[],
  rules: readonly Rule[],
  retired: ReadonlySet<string>,
): Requirement[] => {
  const covered = new Set(
    rules
      .filter((rule) => isEffectiveRule(rule, retired))
      .flatMap((rule) => (rule.parentRequirementId === null ? [] : [rule.parentRequirementId])),
  );
  return requirements.filter(
    (requirement) =>
      requirement.deletedAt === null &&
      requirement.unrulable === null &&
      !covered.has(requirement.id),
  );
};

/** 추적성 결함 (NRM-06, ADR-137): 두 목록을 저장소의 삭제되지 않은 요구사항 · 규칙에서 정한다(표시 ID 순). */
export const traceabilityOf = (store: ProjectStore): Traceability => {
  const requirements = store.requirements.list();
  const rules = store.rules.list();
  const retired = retiredRuleSet(store);
  const live = new Set(
    requirements.filter((item) => item.deletedAt === null).map((item) => item.id),
  );
  return {
    requirementsWithoutRules: requirementsWithoutRules(requirements, rules, retired).map(
      ({ id, displayId }) => ({ id, displayId }),
    ),
    parentlessRules: parentlessRuleDefects(rules, retired, live).map(({ id, displayId }) => ({
      id,
      displayId,
    })),
  };
};

/** 규칙화 불가 비율의 수 (NRM-08, ADR-137): 삭제되지 않은 요구사항 가운데 '규칙화 불가' 수와 전체 수. */
export const unrulableCountOf = (
  requirements: readonly Requirement[],
): VerificationSummaryResult['unrulable'] => {
  const live = requirements.filter((item) => item.deletedAt === null);
  return { count: live.filter((item) => item.unrulable !== null).length, total: live.length };
};

/** 시각 → 정렬 값. 없거나 읽을 수 없으면 가장 앞. */
const timeOf = (iso: string | null): number => {
  const ms = iso === null ? NaN : Date.parse(iso);
  return Number.isNaN(ms) ? -Infinity : ms;
};

/** 판정 기준 후보의 병합 단계 기록: 병합 단계 통과 시도의 끝난 시각과 그 시도가 저장한 병합 순서 값. */
export interface MergeRecord {
  /** 병합 단계가 통과로 끝난 시각 (통과 시도가 없으면 `null`) */
  at: string | null;
  /** 병합 커밋의 전체 조상 수 (ADR-096. 이 값을 저장하기 전의 기록 · 읽기 실패면 `null`) */
  order: number | null;
}

export interface BasisOptions {
  /** 실행의 병합 단계 기록 (기본: 기록 없음) */
  mergeOf?: (run: Run) => MergeRecord | null;
  /** 프로젝트의 지금 기준 브랜치 (모르면 `null`: 브랜치로 먼저 가르지 않는다) */
  branch?: string | null;
}

/** 후보의 순서 열쇠: 앞 칸부터 비교해 큰 쪽이 나중이다 (ADR-096). */
type BasisKey = readonly [
  onBranch: number,
  hasOrder: number,
  order: number,
  at: number,
  createdAt: number,
];

const compareBasis = (
  a: { key: BasisKey; id: string },
  b: { key: BasisKey; id: string },
): number => {
  // 뺄셈을 쓰지 않는다: 두 칸이 모두 -Infinity(시각 없음)면 차가 NaN이라 순서가 입력 순서를 따르게 된다
  for (let i = 0; i < a.key.length; i += 1) {
    const x = a.key[i] as number;
    const y = b.key[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * 가장 나중에 병합된 실행의 판정 기준. 병합 커밋이 기록된 실행이 없으면 `null`.
 * 병합 커밋이 기록된 실행은 상태와 무관하게 후보다: 그 값은 병합 실행기가 기준 브랜치 갱신을 확인한 통과일 때만 채워진다
 * (ADR-091 · ADR-094 · ADR-096). 순서는 후보마다 혼자 정해지는 열쇠의 사전식 비교라 결과가 목록 순서와 무관하다.
 */
export const basisOf = (
  runs: readonly Run[],
  options: BasisOptions = {},
): VerificationBasis | null => {
  let latest: { run: Run & { mergeCommit: string }; key: BasisKey; id: string } | null = null;
  for (const run of runs) {
    if (run.mergeCommit === null) continue;
    const merge = options.mergeOf?.(run) ?? null;
    const order = merge?.order ?? null;
    const candidate = {
      run: { ...run, mergeCommit: run.mergeCommit },
      key: [
        options.branch != null && run.baseBranch === options.branch ? 1 : 0,
        order === null ? 0 : 1,
        order ?? 0,
        timeOf(merge?.at ?? null),
        timeOf(run.createdAt),
      ] as const,
      id: run.id,
    };
    if (latest === null || compareBasis(candidate, latest) > 0) latest = candidate;
  }
  return latest === null
    ? null
    : { branch: latest.run.baseBranch, commit: latest.run.mergeCommit, runId: latest.run.id };
};

/** 병합 단계 결과에 저장된 병합 순서 값 (1 이상의 안전한 정수가 아니면 `null`). */
const mergeOrderIn = (exitDetail: unknown): number | null => {
  if (typeof exitDetail !== 'object' || exitDetail === null) return null;
  const value = (exitDetail as { mergeOrder?: unknown }).mergeOrder;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
};

/**
 * 실행의 병합 단계 기록: 병합 단계 통과 시도 중 시도 번호가 가장 큰 것. 통과 시도가 없으면 `null`.
 * 순서 값은 그 시도의 결과가 실행의 병합 커밋을 가리킬 때만 쓴다(다른 커밋의 값이면 `null`).
 */
export const mergeRecordOf = (run: Run, steps: readonly Step[]): MergeRecord | null => {
  const passed = steps
    .filter((step) => step.kind === 'merge' && step.status === 'passed')
    .reduce<Step | null>((a, b) => (a === null || b.attempt > a.attempt ? b : a), null);
  if (passed === null) return null;
  const detail = passed.exitDetail as { mergeCommit?: unknown } | null;
  const sameCommit =
    typeof detail === 'object' && detail !== null && detail.mergeCommit === run.mergeCommit;
  return { at: passed.endedAt, order: sameCommit ? mergeOrderIn(passed.exitDetail) : null };
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
/**
 * 검증 화면 파이프라인에 보일 실행 (ADR-105). 진행 중인 실행이 있으면 그것(여럿이면 표시 ID가 가장 큰 것), 없으면 가장 먼저
 * 만든 중단 실행(사람이 재개해야 자리가 나는 실행), 둘 다 없으면 가장 최근에 만든 실행. 실행이 없으면 `undefined`.
 * `runs`는 표시 ID 순(= 생성 순).
 */
export const pipelineRunOf = (runs: readonly Run[]): Run | undefined =>
  runs.filter((run) => run.status === 'running').at(-1) ??
  runs.find((run) => run.status === 'interrupted') ??
  runs.at(-1);

export const pipelineOf = (run: Run, steps: readonly Step[], queued = 0): VerificationPipeline => {
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
  return { run, stages, queued };
};

/** 열린 프로젝트 저장소에서 검증 화면 요약을 만든다. */
export const verificationSummary = (
  store: ProjectStore,
  now: number = Date.now(),
): VerificationSummaryResult => {
  const runs = store.runs.list();
  const basis = basisOf(runs, {
    mergeOf: (run) => mergeRecordOf(run, store.runs.steps(run.id)),
    branch: store.getProject()?.baseBranch ?? null,
  });
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

  // 폐기된 규칙은 목록 · 분모에서 뺀다 (판정 이력은 남는다, M7-09 · ADR-112. 폐기 표시는 M7-15)
  const retired = retiredRuleSet(store);
  const rows = unretiredRules(store).map((rule) => {
    const judgment = toRuleJudgment(judged.get(rule.id) ?? null);
    return { rule, judgment, run: linkOf(judgment.latest?.runId ?? null) };
  });
  const judgeable = rows.filter(({ rule, judgment }) => isJudgeable(rule, judgment, retired));
  const passed = judgeable.filter(({ judgment }) => judgment.status === 'pass').length;
  const confirmed = humanConfirmedCompliance(rows, retired);

  const finished = runs
    .filter((run) => isTerminalRunStatus(run.status))
    .map((run) => usageOf(run.id))
    .filter((usage): usage is UsageTotals => usage !== null);

  const shown = pipelineRunOf(runs);
  const queued = runs.filter((run) => run.status === 'queued' && run.id !== shown?.id).length;
  return {
    basis,
    compliance: { passed, judgeable: judgeable.length },
    denominator: judgeable.map(({ rule }) => rule.id),
    confirmedCompliance: confirmed.compliance,
    confirmedDenominator: confirmed.denominator,
    agentRetiredRules: agentRetiredRuleCount(store.normChanges.list()),
    traceability: traceabilityOf(store),
    unrulable: unrulableCountOf(store.requirements.list()),
    costPerRunUsd: costPerRun(finished),
    rules: rows,
    pipeline: shown === undefined ? null : pipelineOf(shown, store.runs.steps(shown.id), queued),
  };
};
