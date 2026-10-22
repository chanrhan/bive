// 실행 생성 · 승인 단계 판정 · 단계 종료 저장 (RUN-01, RUN-02, NFR-07, NFR-01, ADR-027 · ADR-057 · ADR-061).
// - 생성(`createRun`)은 실행 시작 확인이다. 사람만 하고(-32020), 설정 검사(-32010)를 통과해야 하며,
//   실행 저장과 승인 기록 `run_start` 추가를 트랜잭션 1개로 한다. 하나라도 실패하면 아무것도 남지 않는다
// - 승인 단계(`evaluateApprovalStep`)는 대상 규칙이 전부 승인(`normState = approved`, 삭제 안 됨)일 때만 끝난다.
//   아니면 아무것도 저장하지 않고 `waiting_approval`에 머문다 (RUN-02: 실행 시작 확인과 별개)
// - 단계 종료(`completeStep`)는 상태 저장 1회 = 트랜잭션 1회다 (RUN-01). 실패 · 회귀 · 중단 · 재개처럼 단계 순서를
//   벗어나는 전이는 엔진(M1-14)이 `store.runs.transition`으로 직접 저장한다
// - 엔진 · 상태 기계 · 세션 실행은 M1-14, 워크트리 · 브랜치는 M1-13이 맡는다
import {
  type ApprovalLogEntry,
  type AgentRole,
  type Author,
  BudgetSnapshot,
  createUlidGenerator,
  ErrorCode,
  isFinalStepStatus,
  M1_RUN_TYPE,
  RUN_STEP_PLANS,
  type RunCreateResult,
  type RunStatus,
  type Settings,
  type Step,
  STEP_ROLES,
  type StepKind,
  stepRoles,
  type Ulid,
} from '@bive/shared';
import {
  ConflictError,
  NotFoundError,
  type ProjectStore,
  type RunDetail,
  type RunPatch,
  type RunTransition,
} from '@bive/store';

import { withRegisteredProjectStore } from '../ipc/project-store-access.js';
import { RpcError } from '../ipc/server.js';
import { requireRunnableSettings } from '../settings/settings-service.js';

export interface RunCreateInput {
  /** 대상 규칙 (요청 순서 그대로 저장) */
  readonly ruleIds: readonly Ulid[];
  /** 실행 시작 확인 주체. 사람만 받는다 */
  readonly author: Author;
}

/** 요청이 들어온 연결 (승인 기록 `clientId`). */
export interface RunRequestContext {
  readonly clientId: string | null;
}

export interface RunClock {
  /** 시각 (ms) */
  readonly now: () => number;
  /** 새 ULID */
  readonly newId: () => Ulid;
}

/** 승인 단계 판정 결과. `approved = false`면 아무것도 저장하지 않았다. */
export interface ApprovalStepResult extends RunDetail {
  readonly approved: boolean;
  /** 승인 상태가 아닌 대상 규칙 (없음 · 삭제됨 · 잠정 승인), 요청 순서 */
  readonly unapprovedRuleIds: Ulid[];
}

/** 단계 종료 입력 (`completeStep`). */
export interface StepCompletion {
  /** 끝난 결과. 순서대로 다음 단계로 넘어가는 경우만 (실패 · 회귀는 엔진이 `transition`으로) */
  readonly status: 'passed' | 'skipped';
  /** 종료 조건 결과 (SCR-16에 표시) */
  readonly exitDetail?: unknown;
  readonly commit?: string | null;
  readonly costUsd?: number | null;
  readonly turns?: number | null;
  /** 같은 트랜잭션에 함께 저장할 실행 변경 (예: 마지막 단계 뒤 `merged` · `endedAt`, 커밋 · 비용 합계) */
  readonly run?: RunPatch;
}

const timestamp = (clock: RunClock): string => new Date(clock.now()).toISOString();

/** 실행 시작 확인 주체는 사람뿐이다 (RUN-02, NFR-01). */
export const assertHumanRunStarter = (author: Author): void => {
  if (author.kind !== 'human') {
    throw new RpcError(ErrorCode.Unauthorized, '에이전트는 실행을 시작할 수 없습니다 (NFR-01)');
  }
};

/** 설정에서 실행이 쓰는 역할의 예산 · 모델을 복사한다 (검사를 통과한 설정만 받는다). */
const snapshotSettings = (
  settings: Settings,
  roles: readonly AgentRole[],
): { budgetSnapshot: BudgetSnapshot; modelSnapshot: Partial<Record<AgentRole, string>> } => {
  const budgetRoles: Partial<Record<AgentRole, unknown>> = {};
  const modelSnapshot: Partial<Record<AgentRole, string>> = {};
  for (const role of roles) {
    const values = settings.roles[role];
    budgetRoles[role] = { maxBudgetUsd: values.maxBudgetUsd, maxTurns: values.maxTurns };
    if (values.model !== null) modelSnapshot[role] = values.model;
  }
  // 미설정(null)이 섞였으면 여기서 스키마 위반이 난다 (requireRunnableSettings가 먼저 거르므로 정상 경로에선 없음)
  const budgetSnapshot = BudgetSnapshot.parse({ run: settings.run, roles: budgetRoles });
  return { budgetSnapshot, modelSnapshot };
};

/**
 * 실행을 만든다(실행 시작 확인): 유형 A · `waiting_approval` · 현재 단계 승인(진행 중) · 나머지 단계 대기.
 * 실행 저장과 승인 기록 `run_start`(대상 규칙 포함)를 한 트랜잭션으로.
 * 판단 순서: 주체(-32020) → 설정(-32010) → 대상 규칙(없음 -32004 · 삭제됨 -32009).
 * @throws {RpcError} -32020 에이전트 주체 · -32010 설정 미비
 * @throws {NotFoundError} 대상 규칙이 없음
 * @throws {ConflictError} 대상 규칙이 삭제됨
 */
export const createRun = (
  store: ProjectStore,
  input: RunCreateInput,
  context: RunRequestContext,
  clock: RunClock,
): RunCreateResult => {
  assertHumanRunStarter(input.author);
  return store.transaction(() => {
    // 설정 검사(M1 필수 역할, ADR-057)와 스냅샷을 같은 트랜잭션에서 읽는다
    const settings = requireRunnableSettings(store);
    const project = store.getProject();
    if (project === null) throw new NotFoundError('프로젝트', store.projectId);
    const type = M1_RUN_TYPE;
    const plan: readonly StepKind[] = RUN_STEP_PLANS[type];
    const at = timestamp(clock);
    const runId = clock.newId();
    const { budgetSnapshot, modelSnapshot } = snapshotSettings(settings, stepRoles(plan));
    const detail = store.runs.create({
      id: runId,
      type,
      targetRuleIds: [...input.ruleIds],
      currentStep: plan[0] ?? null,
      baseBranch: project.baseBranch,
      budgetSnapshot,
      modelSnapshot,
      startedBy: { kind: 'human' },
      createdAt: at,
      // 승인 단계는 생성과 함께 시작한다(승인 대기 = 승인 단계 진행 중). 나머지는 대기
      steps: plan.map((kind, index) => ({
        id: clock.newId(),
        kind,
        attempt: 1,
        status: index === 0 ? 'running' : 'pending',
        role: STEP_ROLES[kind],
        startedAt: index === 0 ? at : null,
      })),
    });
    const approvalLog: ApprovalLogEntry = store.approvalLog.append({
      at,
      action: 'run_start',
      actor: { kind: 'human' },
      targetRef: { entity: 'Run', id: runId },
      clientId: context.clientId,
      detail: { ruleIds: [...detail.run.targetRuleIds] },
    });
    return { run: detail.run, steps: detail.steps, approvalLog };
  });
};

/** 단계 목록에서 지금 단계의 아직 끝나지 않은 마지막 시도. */
const openAttempt = (steps: readonly Step[], kind: StepKind): Step | undefined =>
  steps.filter((step) => step.kind === kind && !isFinalStepStatus(step.status)).at(-1);

/**
 * 지금 단계를 끝내고(통과 · 생략) 다음 대기 단계를 시작하는 변경을 만든다.
 * 다음 단계 = 단계 정렬(파이프라인 순서 → 시도)에서 지금 시도 뒤의 첫 대기 시도. 없으면 `currentStep = null`.
 */
const completionTransition = (
  detail: RunDetail,
  input: StepCompletion,
  at: string,
  expectedStatus: RunStatus,
): RunTransition => {
  const { run, steps } = detail;
  if (run.currentStep === null) {
    throw new ConflictError('실행', run.displayId, '진행 중인 단계가 없습니다');
  }
  const current = openAttempt(steps, run.currentStep);
  if (current === undefined) {
    throw new ConflictError(
      '실행',
      run.displayId,
      `끝나지 않은 ${run.currentStep} 단계가 없습니다`,
    );
  }
  const index = steps.findIndex((step) => step.id === current.id);
  const next = steps.slice(index + 1).find((step) => step.status === 'pending');
  return {
    expectedStatus,
    steps: [
      {
        id: current.id,
        status: input.status,
        exitDetail: input.exitDetail ?? null,
        commit: input.commit ?? null,
        costUsd: input.costUsd ?? null,
        turns: input.turns ?? null,
        startedAt: current.startedAt ?? at,
        endedAt: at,
      },
      ...(next === undefined ? [] : [{ id: next.id, status: 'running' as const, startedAt: at }]),
    ],
    run: {
      currentStep: next?.kind ?? null,
      lastCompletedStep: current.kind,
      ...input.run,
    },
  };
};

const requireDetail = (store: ProjectStore, runId: string): RunDetail => {
  const detail = store.runs.getDetail(runId);
  if (detail === null) throw new NotFoundError('실행', runId);
  return detail;
};

/**
 * 승인 단계를 판정한다 (RUN-02). 대상 규칙이 전부 승인 상태면 승인 단계 통과 · 다음 단계 시작 · 실행 `running`
 * (`startedAt` = 지금)을 트랜잭션 1회로 저장한다. 아니면 아무것도 저장하지 않고 `approved = false`.
 * @throws {NotFoundError} 실행이 없음
 * @throws {ConflictError} 실행이 `waiting_approval`이 아니거나 현재 단계가 승인이 아님
 */
export const evaluateApprovalStep = (
  store: ProjectStore,
  runId: string,
  clock: Pick<RunClock, 'now'>,
): ApprovalStepResult =>
  store.transaction(() => {
    const detail = requireDetail(store, runId);
    const { run } = detail;
    if (run.status !== 'waiting_approval' || run.currentStep !== 'approval') {
      throw new ConflictError(
        '실행',
        run.displayId,
        `승인 단계가 아닙니다 (${run.status}, ${String(run.currentStep)})`,
      );
    }
    const unapprovedRuleIds = run.targetRuleIds.filter((ruleId) => {
      const rule = store.rules.get(ruleId);
      return rule === null || rule.deletedAt !== null || rule.normState !== 'approved';
    });
    if (unapprovedRuleIds.length > 0) return { ...detail, approved: false, unapprovedRuleIds };
    const at = new Date(clock.now()).toISOString();
    const saved = store.runs.transition(
      runId,
      completionTransition(
        detail,
        {
          status: 'passed',
          exitDetail: { approvedRuleIds: [...run.targetRuleIds] },
          run: { status: 'running', startedAt: at },
        },
        at,
        'waiting_approval',
      ),
    );
    return { ...saved, approved: true, unapprovedRuleIds: [] };
  });

/**
 * 진행 중 실행의 지금 단계를 끝내고(통과 · 생략) 다음 대기 단계를 시작한다. 트랜잭션 1회 (RUN-01).
 * 마지막 단계면 `currentStep = null`이고, 실행 상태(`merged` 등)는 `input.run`으로 함께 저장한다.
 * @throws {NotFoundError} 실행이 없음
 * @throws {ConflictError} 실행이 `running`이 아님 · 진행 중인 단계가 없음 · 상태 기계에 없는 전이
 */
export const completeStep = (
  store: ProjectStore,
  runId: string,
  input: StepCompletion,
  clock: Pick<RunClock, 'now'>,
): RunDetail =>
  store.transaction(() => {
    const detail = requireDetail(store, runId);
    const at = new Date(clock.now()).toISOString();
    return store.runs.transition(runId, completionTransition(detail, input, at, 'running'));
  });

export interface RunServiceDeps {
  /** `$BIVE_HOME` 절대 경로 */
  readonly biveHome: string;
  /** 시계 (ms, 기본 `Date.now`) */
  readonly now?: () => number;
}

/**
 * 오케스트레이터 내부의 실행 상태 저장 창구 (엔진 M1-14가 쓴다, 파이프 RPC 없음).
 * 프로젝트 저장소를 호출마다 열고 닫는다. 등록되지 않은 프로젝트는 -32004 `RpcError`.
 */
export class RunService {
  readonly #biveHome: string;
  readonly #clock: RunClock;

  constructor({ biveHome, now = Date.now }: RunServiceDeps) {
    this.#biveHome = biveHome;
    this.#clock = { now, newId: createUlidGenerator(now) };
  }

  /** 실행과 단계 목록. 없으면 `null`. */
  get(projectId: string, runId: string): RunDetail | null {
    return withRegisteredProjectStore(this.#biveHome, projectId, (store) =>
      store.runs.getDetail(runId),
    );
  }

  /** 승인 단계 판정 (`evaluateApprovalStep`). */
  evaluateApproval(projectId: string, runId: string): ApprovalStepResult {
    return withRegisteredProjectStore(this.#biveHome, projectId, (store) =>
      evaluateApprovalStep(store, runId, this.#clock),
    );
  }

  /** 지금 단계 종료 → 다음 단계 시작 (`completeStep`). */
  completeStep(projectId: string, runId: string, input: StepCompletion): RunDetail {
    return withRegisteredProjectStore(this.#biveHome, projectId, (store) =>
      completeStep(store, runId, input, this.#clock),
    );
  }

  /** 임의 전이 저장 (`store.runs.transition`, 트랜잭션 1회): 실패 · 회귀 · 중단 · 재개 · 워크트리 정보 등. */
  transition(projectId: string, runId: string, change: RunTransition): RunDetail {
    return withRegisteredProjectStore(this.#biveHome, projectId, (store) =>
      store.runs.transition(runId, change),
    );
  }
}
