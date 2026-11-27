// 이어받는 실행 (TODO-02 · COST-01 · NFR-01, M3-56 #319 · M3-60 #325, ADR-147 ② ③ ④, ADR-149, ADR-150 ③, ADR-152).
// 예산 초과로 끝난 원 실행은 종료 상태 그대로 두고(ADR-147 ①), 그 실행을 이어받는 새 실행이 원 실행이 멈춘 단계부터 돈다. 연결은 저장소
// `runContinuations`(0030)에 있고, 쓰는 곳은 검토 대기열 모듈 하나다(구조 시험). 이 모듈은 사슬을 읽는 함수만 둔다:
// - 멈춘 자리(`continuationStartOf`): 시작 단계 = 원 실행의 지금 단계(예산 초과를 낸 시도의 단계, 재개 `resume`과 같은 자리). 파이프라인
//   순서에서 그보다 앞인 단계만 이어받는다(새 실행에 `skipped` · 사유 이어받음, 그 단계를 실제로 돈 실행의 시도를 가리킴). 시작 단계와 그
//   뒤 단계는 원 실행의 앞 시도가 통과였어도 다시 돈다(ADR-150 ③ⓐ)
// - 작업 가지(`continuationWorktreeStart`): 원 실행의 마지막 산출 커밋(`headCommit`, 없으면 기준 커밋)에서, 기준 커밋은 원 실행과 같다
// - 판정 근거(`basisSteps`): 이 실행이 이어받은 단계가 가리키는 시도 다음에 이 실행의 단계 시도. 원 실행의 시작 단계 이후 시도는 들지 않는다
// - 한도 계산의 세션(`lineageSessions`) · 회귀 상한(`lineageCounts`): 사슬 전체
// 이어받는 실행이 아니면 모두 그 실행의 것 그대로다.
import {
  INHERITED_STEP_REASON,
  InheritedStepDetail,
  isRunTypeSkippedStep,
  type Run,
  RUN_STEP_PLANS,
  type Session,
  type Step,
  type StepKind,
} from '@bive/shared';
import type { ProjectStore, RunDetail } from '@bive/store';

/** 이어받은 단계 하나: 단계 종류와 새 실행의 `skipped` 시도에 남길 종료 조건 결과. */
export interface InheritedStep {
  readonly kind: StepKind;
  readonly detail: InheritedStepDetail;
}

/** 이어받은 단계 시도의 종료 조건 결과 (이어받은 시도가 아니면 `null`). */
export const inheritedDetailOf = (
  step: Pick<Step, 'status' | 'exitDetail'>,
): InheritedStepDetail | null => {
  if (step.status !== 'skipped') return null;
  const parsed = InheritedStepDetail.safeParse(step.exitDetail);
  return parsed.success ? parsed.data : null;
};

const isRunTypeSkip = (step: Pick<Step, 'status' | 'exitDetail'>): boolean =>
  step.status === 'skipped' &&
  typeof step.exitDetail === 'object' &&
  step.exitDetail !== null &&
  (step.exitDetail as { reason?: unknown }).reason === 'run_type';

/**
 * 원 실행이 멈춘 자리에서 새 실행이 이어받을 단계 (ADR-150 ③ⓐ, ADR-152). 시작 단계 = 원 실행의 지금 단계(`currentStep`). 계획에서 승인 뒤 ~
 * 시작 단계 앞의 단계마다 원 실행의 그 단계 마지막 시도를 본다:
 * - 이어받은 시도(원 실행도 이어받는 실행): 그 시도가 가리키는 시도를 그대로 가리킨다(사슬을 거슬러 실제로 그 단계를 돈 실행의 시도)
 * - 통과 · 실행기의 생략(대상 없음 등): 그 시도를 가리킨다
 * - 유형이 생략하는 단계(`run_type`): 이어받지 않는다(새 실행에서도 엔진이 유형 생략으로 기록한다)
 * - 시도가 없거나 끝나지 않았거나 실패(있을 수 없는 기록): 거기서 멈춘다(그 단계부터 다시 돈다, 닫힌 쪽)
 * 지금 단계가 없거나 승인이거나 계획에 없으면 이어받지 않는다(첫 단계부터).
 */
export const continuationStartOf = (origin: RunDetail): InheritedStep[] => {
  const { run, steps } = origin;
  const plan: readonly StepKind[] = RUN_STEP_PLANS[run.type];
  const index = run.currentStep === null ? -1 : plan.indexOf(run.currentStep);
  const inherited: InheritedStep[] = [];
  if (index < 1) return inherited;
  for (const kind of plan.slice(1, index)) {
    if (isRunTypeSkippedStep(run.type, kind)) continue;
    const last = steps.filter((step) => step.kind === kind).at(-1);
    if (last === undefined) break;
    const pointed = inheritedDetailOf(last);
    if (pointed !== null) {
      inherited.push({ kind, detail: pointed });
      continue;
    }
    if ((last.status !== 'passed' && last.status !== 'skipped') || isRunTypeSkip(last)) break;
    inherited.push({
      kind,
      detail: {
        reason: INHERITED_STEP_REASON,
        fromRunId: run.id,
        fromStepId: last.id,
        fromStatus: last.status,
      },
    });
  }
  return inherited;
};

/**
 * 판정 근거를 읽는 단계 기록 (ADR-147 ③, ADR-150 ③ⓒ, ADR-152): 이 실행의 이어받은 시도가 가리키는 시도(실제로 그 단계를 돈 실행의 것) 다음에
 * 이 실행의 단계 시도. 단계 실행기는 Red · Green 확인의 인수 테스트 해시와 단계 산출 커밋(`lastPassed` · `acceptanceBaselineOf`)을 이 목록에서
 * 읽는다(복사하지 않는다). 원 실행의 시작 단계 이후 시도(새 실행이 다시 도는 단계)는 들지 않는다. 마지막 통과 시도를 찾을 때 뒤에 오는 이
 * 실행의 시도가 먼저다. 이어받은 시도가 없는 실행(이어받는 실행이 아닌 실행)은 이 실행의 단계 시도 그대로다(저장소를 읽지 않는다).
 */
export const basisSteps = (context: {
  readonly steps: readonly Step[];
  read<T>(fn: (store: ProjectStore) => T): T;
}): Step[] => {
  const pointers = context.steps.flatMap((step) => {
    const detail = inheritedDetailOf(step);
    return detail === null ? [] : [detail];
  });
  if (pointers.length === 0) return [...context.steps];
  const inherited = context.read((store) =>
    pointers.flatMap((pointer) => {
      const step = store.runs
        .steps(pointer.fromRunId)
        .find((item) => item.id === pointer.fromStepId);
      return step === undefined ? [] : [step];
    }),
  );
  return [...inherited, ...context.steps];
};

/** 이 실행이 이어받은 원 실행들 (사슬의 뿌리부터 바로 앞 원 실행까지). 이어받는 실행이 아니면 빈 목록. */
export const lineageRuns = (store: ProjectStore, runId: string): Run[] =>
  store.runContinuations.ancestorsOf(runId).flatMap((id) => {
    const run = store.runs.get(id);
    return run === null ? [] : [run];
  });

/**
 * 한도 계산에 쓰는 세션 기록 (COST-01, ADR-147 ④): 사슬의 원 실행들(뿌리부터)의 세션 다음에 이 실행의 세션. 이어받는 실행이 아니면 이
 * 실행의 세션 그대로다.
 */
export const lineageSessions = (store: ProjectStore, runId: string): Session[] => {
  const ancestors = store.runContinuations.ancestorsOf(runId);
  const own = store.sessions.listByRun(runId);
  return ancestors.length === 0
    ? own
    : [...ancestors.flatMap((id) => store.sessions.listByRun(id)), ...own];
};

const isInterrupted = (step: Step): boolean =>
  typeof step.exitDetail === 'object' &&
  step.exitDetail !== null &&
  (step.exitDetail as { interrupted?: unknown }).interrupted === true;

/**
 * 재시도 수에 세는 테스트 작성 시도: 재기동으로 중단된 시도와 이어받은 시도는 세지 않는다. 엔진의 재시도 상한이 이 실행의 시도에 쓴다
 * (이어받는 실행이 아니면 이어받은 시도가 없어 지금까지와 같다).
 */
export const countedTestWritingAttempts = (steps: readonly Step[]): Step[] =>
  steps.filter(
    (step) =>
      step.kind === 'test_writing' && !isInterrupted(step) && inheritedDetailOf(step) === null,
  );

/** 사슬의 원 실행들이 이미 쓴 회귀 · 재시도 수 (이 실행의 수는 들지 않는다). */
export interface LineageCounts {
  /** 원 실행들의 `regressionCount` 합 */
  readonly regressions: number;
  /**
   * 원 실행들의 테스트 작성 시도 가운데 센 것: 재기동 중단 시도 · 이어받은 시도와, 원 실행이 테스트 작성에서 멈췄으면 그 마지막 시도(이어받는
   * 실행의 첫 시도가 다시 한다: 재개가 중단 시도를 세지 않는 것과 같다)는 세지 않는다
   */
  readonly testWritingAttempts: number;
}

/** 사슬의 원 실행들이 쓴 회귀 · 재시도 수 (ADR-150 ③ⓓ, ADR-152). 이어받는 실행이 아니면 0 · 0. */
export const lineageCounts = (store: ProjectStore, runId: string): LineageCounts => {
  let regressions = 0;
  let testWritingAttempts = 0;
  for (const run of lineageRuns(store, runId)) {
    regressions += run.regressionCount;
    const counted = countedTestWritingAttempts(store.runs.steps(run.id));
    testWritingAttempts += Math.max(
      0,
      counted.length - (run.currentStep === 'test_writing' && counted.length > 0 ? 1 : 0),
    );
  }
  return { regressions, testWritingAttempts };
};

/** 이어받는 실행의 작업 가지 시작 자리 (`WorktreeManager.create`의 `start`)와 새 실행의 마지막 완료 단계 커밋 초기값. */
export interface ContinuationWorktreeStart {
  readonly baseCommit: string;
  readonly commit: string;
  readonly fromBranch: string;
  /** 원 실행의 `headCommit` (없으면 `null`: 새 실행의 `headCommit`도 비운다) */
  readonly headCommit: string | null;
}

/**
 * 이어받는 실행의 작업 가지를 만들 자리 (ADR-147 ②, ADR-150 ③ⓑ). 기준 커밋은 원 실행과 같고 가지는 원 실행의 마지막 산출 커밋(`headCommit`,
 * 없으면 기준 커밋)에서 시작한다. 원 실행의 끝나지 않은 시도가 작업 폴더에 남긴 커밋되지 않은 변경은 이어받지 않는다(커밋에서 만든다).
 * 이어받는 실행이 아니거나 원 실행이 워크트리를 만들기 전에 끝났으면 `null`(보통 실행처럼 기준 브랜치의 지금 커밋에서).
 */
export const continuationWorktreeStart = (
  store: ProjectStore,
  runId: string,
): ContinuationWorktreeStart | null => {
  const link = store.runContinuations.originOf(runId);
  const origin = link === null ? null : store.runs.get(link.originRunId);
  if (origin?.baseCommit == null || origin.branch === null) return null;
  return {
    baseCommit: origin.baseCommit,
    commit: origin.headCommit ?? origin.baseCommit,
    fromBranch: origin.branch,
    headCommit: origin.headCommit,
  };
};
