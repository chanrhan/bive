// 파이프라인 엔진: 상태 기계 · 단계 진행 · 회귀 · 중단 · 재개 · 단계 세션 실행 틀
// (RUN-01 · RUN-02 · RUN-08, PRD 5.1, NFR-01 · NFR-02 · NFR-07, ADR-011 · ADR-026 · ADR-027 · ADR-049 · ADR-058 ·
// ADR-061 · ADR-066).
// - 상태 저장은 단계 종료마다 `ProjectStore.runs`의 트랜잭션 1회다(`completeStep` · `regress` · `transition`).
//   단계 중간에는 실행 상태를 저장하지 않는다(세션 · 도구 호출 기록은 별도 기록, 워크트리 생성 정보는 ADR-061)
// - 승인 단계는 엔진이 판정한다(`evaluateApprovalStep`): 실행 생성 직후 · 옛 제안 승인 뒤 · 기동 때. 승인 단계 자리는
//   효력 확인이다(ADR-100 A3): 대상 규칙이 전부 효력 상태면 통과, 아니면 그 자리에서 실행을 끝낸다(`runEnding`). 사람을
//   기다리며 머물지 않는다 (ADR-107). 그 밖 단계는 주입받은 단계 실행기(`StepExecutors`)가 결과를 낸다
// - 구동마다 시작 근거를 대조한다(`checkRunStartBasis`): 사람의 승인 기록 `run_start` 1건 또는 규범 변경 기록의 자동 시작
//   항목 1건. 아니면 `run_without_log` (NFR-01, ADR-107)
// - 종료 조건 미충족은 다음 단계로 가지 않는다: 테스트 작성 · Red 확인은 테스트 작성부터 다시(상한 2회),
//   구현 · 검사는 구현부터 다시(`regressionCount`, 상한 2회). 상한을 넘으면 실행 `failed`, 브랜치 · 워크트리 보존
// - 재기동(`recoverInterruptedRuns`)은 `running` 실행을 `interrupted`로 바꾸고 자동으로 이어가지 않는다(PRD 5.1)
// - 재개(`resume`)는 사람이 `interrupted` 실행에만: 워크트리를 마지막 완료 단계 커밋으로 hard reset + clean 한 뒤
//   지금 단계의 새 시도 · 새 세션으로 이어간다. `regressionCount`는 그대로 둔다 (ADR-027)
// - 프로젝트당 동시 실행 1개 (ADR-100 B⑥, ADR-105): 승인 단계 통과 때 자리가 없으면 실행 대기(`queued`). 실행의 구동이
//   끝나면(종료 상태 저장 뒤) · 실행 대기가 생기면 · 기동하면(`startQueuedRuns`) `#advanceQueue`가 저장된 상태에서 다음
//   실행 대기를 생성 순으로 시작한다(메모리 대기열 없음). 다른 실행이 진행 중이면 재개는 -32009. 자동 시작 실행은 시작할 차례에
//   하루 한도를 다시 보아 문에 걸리면 워크트리 없이 끝난다(실행 서비스 `startNextQueuedRun`, ADR-111)
// - 실행 안 판단 세션(M7-11 #223, ADR-115): 단계 실행기가 `judgeNorms`로 청하면 주입받은 배선(`judgeNorms` 옵션, 오케스트레이터가
//   규칙 작성 서비스로 잇는다)을 실행 · 단계 · 실행 잔여 한도 · 중단 신호와 함께 부른다. 엔진은 규칙 작성 서비스를 모른다. 구현
//   세션의 이의 제기 도구가 `ok`를 돌려주면 실행기가 닫히고 세션은 스스로 끝나기를 기다린다(결과 이벤트의 실제 비용). 닫힌 뒤
//   거부된 호출이 {@link OBJECTION_CLOSED_CALL_LIMIT}번 쌓이면 세션을 끝낸다(`SessionEndRequest`). 어느 쪽이든 종료 사유는
//   `objection_raised`이고, 값을 모른 채 끝나면 하루 · 실행 합계에서 그 세션의 한도 전부로 센다(ADR-115 검토 1회차)
import {
  type Author,
  CommitSha,
  createUlidGenerator,
  ErrorCode,
  isFinalStepStatus,
  isRunTypeSkippedStep,
  MAX_REGRESSION_COUNT,
  type ModelUsage,
  parseDisplayId,
  type Project,
  type Run,
  RUN_STEP_PLANS,
  type Step,
  type StepKind,
  STEP_ROLES,
  type Ulid,
} from '@bive/shared';
import {
  ConflictError,
  NotFoundError,
  openRegistry,
  type ProjectStore,
  type RunDetail,
  type RunPatch,
} from '@bive/store';

import type { AgentAdapter } from '../agent/adapter.js';
import { runGuardedSession, SessionEndRequest } from '../agent/guarded-session.js';
import { createGitRunner, type GitRunner } from '../git/git-exec.js';
import {
  createWorktreeManager,
  GitWorktreeError,
  type GitWorktreeErrorCode,
  type RunGitRef,
  type WorktreeManager,
} from '../git/worktree-manager.js';
import { resetRunWorktree } from '../git/worktree-reset.js';
import { toRpcError, withRegisteredProjectStore } from '../ipc/project-store-access.js';
import { RpcError } from '../ipc/server.js';
import type { RunTracker } from '../lifecycle.js';
import { retiredTargetDisplayIds, TARGET_RULE_RETIRED } from '../norms/effective.js';
import {
  type ApprovalStepResult,
  completeStep,
  evaluateApprovalStep,
  QUEUED_TARGET_UNAVAILABLE,
  startNextQueuedRun,
} from '../runs/run-service.js';
import { continuationWorktreeStart, lineageSessions } from '../runs/run-continuation.js';
import { createCheckExecutor } from '../steps/check.js';
import { createGreenCheckExecutor } from '../steps/green-check.js';
import { createImplementationExecutor } from '../steps/implementation.js';
import { createMergeExecutor } from '../steps/merge.js';
import { createMutationExecutor } from '../steps/mutation.js';
import { createRedCheckExecutor } from '../steps/red-check.js';
import { createTestWritingExecutor } from '../steps/test-writing.js';
import { dailyBudgetReached, projectDailyBudget } from '../settings/project-budget.js';
import { createRoleTools, type ToolCallRecord } from '../tools/executor.js';
import { budgetOverrun, runRemaining, sessionLimits } from './session-budget.js';
import { runEnding } from './run-ending.js';
import { checkRunStartBasis } from './start-basis.js';
import {
  COMMIT_STEP_KINDS,
  type EngineEvent,
  type EngineStepKind,
  type HaltStatus,
  MAX_TEST_RETRY_COUNT,
  type NormJudgeLauncher,
  type NormJudgeOutcome,
  type NormJudgeStepRequest,
  type StepContext,
  type StepExecutor,
  type StepExecutors,
  type StepOutcome,
  type StepRunPatch,
  type StepSessionRequest,
  type StepSessionResult,
  stepCommitMessage,
  UNMET_POLICY_BY_TYPE,
} from './types.js';

// 실행의 종료 상태는 `run-ending.ts`의 `runEnding()` 한 곳에서 정한다 (실행 서비스의 실행 대기 시작도 같은 함수를 쓴다)
export { runEnding } from './run-ending.js';

/** 세션 · 실행기가 실행을 끝내야 할 때 던진다 (가드 위반 · 예산 초과 · 설정 없음). */
export class StepHaltError extends Error {
  override readonly name = 'StepHaltError';
  constructor(
    readonly runStatus: HaltStatus,
    readonly reason: string,
    readonly exitDetail?: unknown,
  ) {
    super(`실행 중단 (${runStatus}: ${reason})`);
  }
}

/** 재기동 때 중단으로 바꾼 실행. */
export interface InterruptedRun {
  readonly projectId: Ulid;
  readonly runId: Ulid;
  readonly displayId: string;
}

/** 중단 단계 시도의 종료 조건 결과 (재시도 수에 세지 않는다). */
export const INTERRUPTED_EXIT_DETAIL = {
  interrupted: true,
  reason: 'orchestrator_restart',
} as const;

export interface PipelineEngineOptions {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  /** 세션을 여는 에이전트 어댑터 (`BIVE_AGENT`로 고른 것) */
  agent: AgentAdapter;
  /** 단계 실행기 (승인 단계 제외). 기본값(`DEFAULT_STEP_EXECUTORS`)에 덮어쓴다 */
  executors?: StepExecutors;
  /** git 워크트리 관리자 (기본 `createWorktreeManager({ biveHome })`) */
  worktrees?: WorktreeManager;
  /** 워크트리 되돌리기용 git 실행기 */
  git?: GitRunner;
  /** 진행 중 실행 수 (유휴 종료 미루기, `Lifecycle`) */
  runs?: RunTracker;
  /** 시계 (ms) */
  now?: () => number;
  /**
   * 저장 · 알림 이벤트 (`event.run.updated` · `event.step.updated` 알림, ADR-076). 약속을 돌려주면 저장 이벤트는
   * 기다리지 않고(실패는 기록만), 화면 갱신 단계의 `notify`는 그 약속이 풀릴 때까지 단계를 끝내지 않는다
   */
  onEvent?: (event: EngineEvent) => void | Promise<void>;
  /** 진행 기록 한 줄 */
  log?: (line: string) => void;
  /**
   * 실행 안 판단 세션을 띄우는 배선 (M7-11 #223, ADR-115). 오케스트레이터가 규칙 작성 서비스로 주입한다. 없으면 단계 실행기의
   * 판단 요청이 `not_opened`(`not_configured`)로 끝난다
   */
  judgeNorms?: NormJudgeLauncher;
}

/**
 * 이의를 제기해 닫힌 구현 세션이 계속 도구를 부를 때 세션을 끝내는 거부 수 (`session_closed`, ADR-115 검토 1회차). 모델이 고정
 * 문장을 따르지 않아도 세 번째 거부에서 끝난다(비용을 모르면 한도 전부로 센다).
 */
export const OBJECTION_CLOSED_CALL_LIMIT = 3;

/**
 * 변이 주입을 하지 않는 실행기 (M1 · M3-07까지의 기본값, RUN-02 P0 범위). M3-54(#311, ADR-143)부터 기본 실행기는
 * `createMutationExecutor`이고 이것은 시험이 변이 주입을 빼고 싶을 때만 쓴다.
 */
export const skipMutationStep: StepExecutor = () =>
  Promise.resolve({ status: 'skipped', exitDetail: { reason: 'not_in_scope', scope: 'P1' } });

/**
 * 화면 갱신 (RUN-02 8단계 "판정 결과 저장 + `event.*` 알림 전송", ADR-076). 판정 결과는 검사 · 병합 재검사가 판정마다
 * 바로 저장했으므로(ADR-069) 그 기록을 읽은 뒤 `event.run.updated`를 보내고, 송신이 끝나야 통과를 돌려준다. 그래서
 * 이 단계가 완료로 저장되기 전에 화면은 저장된 판정을 다시 조회할 수 있다. 송신이 실패하면 예외 → 이 단계 시도 `failed`,
 * 실행은 이미 병합됐으므로 `merged`(ADR-091, 엔진 `#halt`). 송신 대기는 연결마다 상한이 있고(넘기면 그 연결을 끊음,
 * `PipeServer.notify`), 종료 신호가 오면 저장 없이 끝난다.
 */
export const screenUpdateStep: StepExecutor = async (context) => {
  const judgments = context.read((store) => store.judgments.listByRun(context.run.id).length);
  await context.notify('screen_update', { runId: context.run.id });
  return { status: 'passed', exitDetail: { notified: true, judgments } };
};

/**
 * 기본 실행기: 유형 A 전체. 테스트 작성 · Red 확인(#28, ADR-068) · 구현 · 검사 · 병합(#29, ADR-069) · 변이 주입 `skipped` ·
 * 화면 갱신(#32, ADR-076). 제품 오케스트레이터의 실행은 이 목록으로 유형 A 끝(병합 · 화면 갱신)까지 간다. 유형 C · D의 Green 확인
 * (C: 새 테스트 전부 통과, D: 기준 커밋의 기존 검사 전부 통과)은 M3-06(ADR-136)이 더했다.
 */
export const DEFAULT_STEP_EXECUTORS: StepExecutors = {
  test_writing: createTestWritingExecutor(),
  red_check: createRedCheckExecutor(),
  green_check: createGreenCheckExecutor(),
  implementation: createImplementationExecutor(),
  check: createCheckExecutor(),
  mutation: createMutationExecutor(),
  merge: createMergeExecutor(),
  screen_update: screenUpdateStep,
};

/** `promise`가 풀리거나, 그 전에 `signal`이 중단되면 중단 사유로 거부된다. */
const untilAborted = (promise: Promise<unknown>, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isInterruptedAttempt = (step: Step): boolean =>
  typeof step.exitDetail === 'object' &&
  step.exitDetail !== null &&
  (step.exitDetail as { interrupted?: unknown }).interrupted === true;

/** 구동 중인 실행 · 단계 시도 · git 참조. */
interface DriveState {
  run: Run;
  step: Step | null;
  git: RunGitRef | null;
}

/** 실행기가 함께 저장하려는 실행 필드의 형식 오류 (없으면 `null`). */
const invalidStepRunPatch = (patch: StepRunPatch | undefined): string | null => {
  if (patch === undefined) return null;
  for (const key of ['mergeCommit', 'headCommit'] as const) {
    const value = patch[key];
    if (value !== undefined && value !== null && !CommitSha.safeParse(value).success) {
      return `${key}가 커밋 해시가 아닙니다: ${String(value)}`;
    }
  }
  // 비용 · 턴은 실행기가 넣지 않는다: 저장소가 세션 기록에서 채운다 (ADR-067)
  return null;
};

/** 실행 레코드의 git 참조. 워크트리를 만들기 전이면 `null`. */
const gitRefOf = (project: Project, run: Run): RunGitRef | null =>
  run.branch === null || run.worktreePath === null || run.baseCommit === null
    ? null
    : {
        projectId: project.id,
        runDisplayId: run.displayId,
        repoPath: project.rootPath,
        baseBranch: run.baseBranch,
        branch: run.branch,
        worktreePath: run.worktreePath,
        baseCommit: run.baseCommit,
      };

/**
 * 재개의 워크트리 되돌리기가 이 사유로 실패하면 다시 눌러도 같은 결과다(ADR-105): 워크트리 폴더가 없음
 * (`worktree_missing`), 워크트리가 실행 브랜치에 있지 않음(`worktree_branch_mismatch`), 실행 참조 · 되돌릴 커밋이
 * 규칙과 다름 · 폴더가 아님 · 되돌릴 커밋이 브랜치에 없음 · 되돌린 뒤에도 변경이 남음(`invalid_input`). 이때 재개는 그
 * 호출 안에서 실행을 `failed`(`worktree_error`)로 끝내 프로젝트의 자리를 비운다. git 명령 실패(`GitCommandError`)와
 * 다른 실행이 진행 중인 경우는 일시적일 수 있어 상태를 바꾸지 않는다.
 */
export const UNRECOVERABLE_RESUME_CODES = [
  'worktree_missing',
  'worktree_branch_mismatch',
  'invalid_input',
] as const satisfies readonly GitWorktreeErrorCode[];

/** 재개할 수 없어 실행을 실패로 끝냈을 때 `run.resume` 오류의 `data.reason` (ADR-105). */
export const RESUME_UNRECOVERABLE = 'resume_unrecoverable';

const isUnrecoverableResume = (error: unknown): error is GitWorktreeError =>
  error instanceof GitWorktreeError &&
  (UNRECOVERABLE_RESUME_CODES as readonly string[]).includes(error.code);

interface ActiveRun {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

export class PipelineEngine {
  readonly #biveHome: string;
  readonly #agent: AgentAdapter;
  readonly #executors: StepExecutors;
  readonly #worktrees: WorktreeManager;
  readonly #git: GitRunner;
  readonly #tracker: RunTracker | undefined;
  readonly #now: () => number;
  readonly #newId: () => Ulid;
  readonly #onEvent: ((event: EngineEvent) => void | Promise<void>) | undefined;
  readonly #log: (line: string) => void;
  readonly #judgeNorms: NormJudgeLauncher | undefined;
  readonly #active = new Map<string, ActiveRun>();
  readonly #pending = new Set<Promise<void>>();
  #closed = false;

  constructor(options: PipelineEngineOptions) {
    this.#biveHome = options.biveHome;
    this.#agent = options.agent;
    this.#executors = { ...DEFAULT_STEP_EXECUTORS, ...options.executors };
    this.#worktrees = options.worktrees ?? createWorktreeManager({ biveHome: options.biveHome });
    this.#git = options.git ?? createGitRunner();
    this.#tracker = options.runs;
    this.#now = options.now ?? Date.now;
    this.#newId = createUlidGenerator(this.#now);
    this.#onEvent = options.onEvent;
    this.#log = options.log ?? (() => undefined);
    this.#judgeNorms = options.judgeNorms;
  }

  /** 지금 구동 중인 실행 ID. */
  get activeRunIds(): string[] {
    return [...this.#active.keys()];
  }

  // ── 재기동 ────────────────────────────────────────────

  /**
   * 등록된 모든 프로젝트의 `running` 실행을 `interrupted`로 바꾼다 (PRD 5.1). 오케스트레이터가 연결을 받기 전에
   * 한 번 부른다. 진행 중이던 단계 시도는 `failed`(`INTERRUPTED_EXIT_DETAIL`)로 끝내고 같은 단계의 새 시도를
   * `pending`으로 더하며, 끝나지 않은 세션은 `aborted`로 닫는다. 자동으로 이어가지 않는다.
   */
  recoverInterruptedRuns(): InterruptedRun[] {
    const interrupted: InterruptedRun[] = [];
    for (const projectId of this.#registeredProjectIds()) {
      try {
        const details = this.#store(projectId, (store) => {
          this.#closeRunlessSessions(store);
          return store.runs.list({ status: 'running' }).map((run) => this.#interrupt(store, run));
        });
        for (const detail of details) {
          interrupted.push({ projectId, runId: detail.run.id, displayId: detail.run.displayId });
          this.#emit({ type: 'run.saved', projectId, detail });
          this.#log(`실행 중단으로 표시 (${detail.run.displayId}, 재기동)`);
        }
      } catch (error) {
        this.#log(`재기동 복구 실패 (프로젝트 ${projectId}): ${errorMessage(error)}`);
      }
    }
    return interrupted;
  }

  /**
   * 기동 뒤 (연결을 받기 시작한 다음 한 번): 등록된 프로젝트마다 승인 대기로 남은 실행의 승인 단계를 판정하고(생성 순),
   * 실행 대기를 저장된 상태에서 이어간다(`#advanceQueue`).
   * 자리를 차지한 실행(진행 중 · 중단)이 없는 프로젝트에서만 가장 먼저 만든 실행 대기가 시작된다. 재기동으로 중단된 실행이
   * 있는 프로젝트는 사람이 재개하거나 그 실행이 끝날 때까지 그대로다 (ADR-105).
   */
  startQueuedRuns(): void {
    for (const projectId of this.#registeredProjectIds()) {
      // 생성 뒤 승인 단계 판정 전에 앞 프로세스가 끝난 실행(사람의 [실행] · 자동 시작)은 승인 대기로 남아 있다. 승인 단계는
      // 사람을 기다리지 않으므로 여기서 판정한다 (ADR-107: 승인 대기에 머무는 경로를 두지 않는다)
      this.#quietly(`승인 단계 판정 (프로젝트 ${projectId})`, () => {
        const waiting = this.#store(projectId, (store) =>
          store.runs.list({ status: 'waiting_approval' }).map((run) => run.id),
        );
        for (const runId of waiting) {
          this.#quietly(`승인 단계 판정 (${runId})`, () => {
            this.evaluateApproval(projectId, runId);
          });
        }
      });
      this.#quietly(`실행 대기 시작 (프로젝트 ${projectId})`, () => {
        this.#advanceQueue(projectId);
      });
    }
  }

  /** 등록된 프로젝트 ID들. 등록부가 아직 없으면 빈 목록. */
  #registeredProjectIds(): string[] {
    try {
      const registry = openRegistry({ home: this.#biveHome, create: false });
      try {
        return registry.entries.list().map((entry) => entry.projectId);
      } finally {
        registry.close();
      }
    } catch (error) {
      if (error instanceof NotFoundError) return [];
      throw error;
    }
  }

  /**
   * 실행 밖 세션(규칙 작성, ADR-062) 중 끝나지 않은 것: 앞 프로세스가 죽은 것이므로 `aborted`로 닫는다. 세션을 열기 전
   * 대기열에 남아 있던 규칙 작성 시도도 생략(`closed`)으로 끝낸다(다시 띄우지 않는다, ADR-099).
   */
  #closeRunlessSessions(store: ProjectStore): void {
    const at = this.#timestamp();
    for (const session of store.sessions.listUnended()) {
      if (session.runId !== null) continue;
      store.sessions.end(session.id, {
        endReason: 'aborted',
        error: '오케스트레이터가 비정상 종료됨',
        endedAt: at,
      });
    }
    store.ruleWriterRequests.closePending('오케스트레이터가 비정상 종료됨', at);
  }

  #interrupt(store: ProjectStore, run: Run): RunDetail {
    const at = this.#timestamp();
    return store.transaction(() => {
      for (const session of store.sessions.listByRun(run.id)) {
        if (session.endReason === null) {
          store.sessions.end(session.id, {
            endReason: 'aborted',
            error: '오케스트레이터가 비정상 종료됨',
            endedAt: at,
          });
        }
      }
      const toolManifest = store.sessions.manifest(run.id);
      const steps = store.runs.steps(run.id);
      const open =
        run.currentStep === null
          ? undefined
          : steps.find((step) => step.kind === run.currentStep && step.status === 'running');
      if (run.currentStep === null || open === undefined) {
        return store.runs.transition(run.id, {
          expectedStatus: 'running',
          run: { status: 'interrupted', toolManifest },
        });
      }
      return store.runs.regress(run.id, {
        toKind: run.currentStep,
        at,
        newId: this.#newId,
        expectedStatus: 'running',
        exitDetail: INTERRUPTED_EXIT_DETAIL,
        startStatus: 'pending',
        run: { status: 'interrupted', toolManifest },
      });
    });
  }

  // ── 승인 단계 ─────────────────────────────────────────

  /**
   * 실행 생성(`run.create`) 뒤: 응답을 보낸 다음 생성 저장을 알리고(`run.saved`, 승인 대기 실행도 화면에 보이게,
   * ADR-076) 승인 단계를 판정한다.
   */
  onRunCreated(projectId: string, runId: string): void {
    this.#defer(() => {
      const created = this.#store(projectId, (store) => store.runs.getDetail(runId));
      if (created !== null) this.#emit({ type: 'run.saved', projectId, detail: created });
      this.evaluateApproval(projectId, runId);
    });
  }

  /** 규칙 승인(`proposal.approve` · `amend`) 뒤: 그 프로젝트의 승인 대기 실행을 모두 다시 판정한다. */
  onNormsApproved(projectId: string): void {
    this.#defer(() => {
      const waiting = this.#store(projectId, (store) =>
        store.runs.list({ status: 'waiting_approval' }).map((run) => run.id),
      );
      // 한 실행의 판정 예외가 나머지 실행의 판정을 막지 않게 한다
      for (const runId of waiting) {
        this.#quietly(`승인 단계 판정 (${runId})`, () => {
          this.evaluateApproval(projectId, runId);
        });
      }
    });
  }

  /**
   * 승인 단계를 판정한다 (RUN-02, ADR-100 A3: 승인 단계 자리 = 효력 확인). 사람을 기다리지 않는다:
   * - 대상 규칙이 전부 효력 상태면 `running`으로 저장하고 구동을 시작한다. 프로젝트에 자리가 없으면 `queued`(실행 대기)로
   *   저장하고 대기열을 한 번 살핀다(자리가 나 있으면 생성 순으로 시작, ADR-105)
   * - 효력이 없는 규칙(없음 · 삭제됨 · 효력 아님)이 하나라도 있으면 그 자리에서 실행을 끝낸다: 승인 단계 시도 `failed`
   *   (`exitDetail.unavailableRuleIds`), 실행의 종료 상태는 `runEnding`이 정한다(병합 커밋이 없으므로 `failed`,
   *   `target_rule_unavailable`). 워크트리 · 브랜치를 만들기 전이라 보존할 것이 없다 (ADR-107)
   * 종료 중이면 아무것도 하지 않는다(승인 대기는 다음 기동의 `startQueuedRuns`가 판정한다).
   * @returns 승인 단계를 통과했는지
   */
  evaluateApproval(projectId: string, runId: string): boolean {
    if (this.#closed) return false;
    const { judged, ended } = this.#store(projectId, (store) =>
      store.transaction(() => {
        const approval = evaluateApprovalStep(store, runId, { now: this.#now });
        return {
          judged: approval,
          ended: approval.approved ? null : this.#endWithoutEffect(store, approval),
        };
      }),
    );
    if (ended !== null) {
      this.#emit({ type: 'run.saved', projectId, detail: ended });
      this.#logEnding(
        ended.run,
        ended.run.status === 'merged',
        'failed',
        QUEUED_TARGET_UNAVAILABLE,
      );
      return false;
    }
    this.#emit({ type: 'run.saved', projectId, detail: { run: judged.run, steps: judged.steps } });
    if (judged.run.status === 'queued') {
      this.#log(`실행 대기 (${judged.run.displayId})`);
      this.#advanceQueue(projectId);
      return true;
    }
    this.#launch(projectId, runId);
    return true;
  }

  /**
   * 승인 단계에서 대상 규칙의 효력이 없을 때 실행을 끝낸다 (열린 저장소, 부른 쪽 트랜잭션 안). 승인 단계 시도를 실패로 닫고
   * 실행의 종료 상태는 `runEnding` 한 곳에서 정한다(ADR-091 · ADR-094 · ADR-107).
   */
  #endWithoutEffect(store: ProjectStore, judged: ApprovalStepResult): RunDetail {
    const at = this.#timestamp();
    const approval = judged.steps.find(
      (step) => step.kind === 'approval' && !isFinalStepStatus(step.status),
    );
    const ending = runEnding(judged.run, 'failed', QUEUED_TARGET_UNAVAILABLE);
    return store.runs.transition(judged.run.id, {
      expectedStatus: 'waiting_approval',
      run: { ...ending.run, endedAt: at },
      steps:
        approval === undefined
          ? []
          : [
              {
                id: approval.id,
                status: 'failed',
                exitDetail: {
                  reason: QUEUED_TARGET_UNAVAILABLE,
                  unavailableRuleIds: judged.unapprovedRuleIds,
                },
                endedAt: at,
              },
            ],
    });
  }

  /**
   * 자리가 났으면 다음 실행 대기를 시작하고 구동한다 (`startNextQueuedRun`, 트랜잭션 1회 · 저장된 상태 기준, ADR-105).
   * 시작 전에 끝난 실행 대기(대상 규칙 재검사 · 자동 시작 실행의 하루 한도 재확인, ADR-111)는 저장 알림 · 기록만 남긴다.
   * 끝난 것들은 같은 호출 안에서 처리되었으므로 대기열을 다시 살피지 않는다. 종료 중이면 아무것도 하지 않는다.
   */
  #advanceQueue(projectId: string): void {
    if (this.#closed) return;
    const advance = this.#store(projectId, (store) =>
      startNextQueuedRun(store, { now: this.#now }),
    );
    for (const detail of advance.failed) {
      this.#emit({ type: 'run.saved', projectId, detail });
      this.#log(`실행 대기 종료 (${detail.run.displayId}, ${String(detail.run.failureReason)})`);
    }
    if (advance.started === null) return;
    this.#emit({ type: 'run.saved', projectId, detail: advance.started });
    this.#log(`실행 대기에서 시작 (${advance.started.run.displayId})`);
    this.#launch(projectId, advance.started.run.id);
  }

  // ── 재개 ──────────────────────────────────────────────

  /**
   * 중단된 실행을 재개한다 (`run.resume`, PRD 5.1 · ADR-011 · ADR-027). 사람만, `interrupted`만 받는다.
   * 워크트리를 마지막 완료 단계 커밋(`headCommit`, 없으면 `baseCommit`)으로 hard reset + clean 하고, 지금 단계의
   * 대기 시도를 시작해 `running`으로 저장한 뒤 구동한다(새 세션). `regressionCount`는 바꾸지 않는다.
   * 프로젝트에 다른 진행 중 실행이 있으면 재개하지 않는다(-32009, 프로젝트당 진행 중 1개, ADR-105). 실행 대기가 있어도
   * 재개는 된다(중단된 실행은 자리를 비우지 않았으므로 먼저다).
   * @throws {RpcError} -32020 사람 아님 · -32004 없음 · -32009 `interrupted` 아님 · 이미 구동 중 · 다른 실행이 진행 중 ·
   *   되돌리기 실패
   */
  async resume(projectId: string, ref: string, author: Author): Promise<RunDetail> {
    if (author.kind !== 'human') {
      throw new RpcError(ErrorCode.Unauthorized, '에이전트는 실행을 재개할 수 없습니다 (NFR-01)');
    }
    if (this.#closed) throw new RpcError(ErrorCode.StateConflict, '오케스트레이터가 종료 중입니다');
    const loaded = this.#rpcStore(projectId, (store) => ({
      detail:
        parseDisplayId(ref) === null
          ? store.runs.getDetail(ref)
          : store.runs.getDetailByDisplayId(ref),
      project: store.getProject(),
      running: store.runs.list({ status: 'running' }),
    }));
    if (loaded.detail === null || loaded.project === null) {
      throw new RpcError(ErrorCode.NotFound, `실행을 찾을 수 없습니다: ${ref}`);
    }
    const { run, steps } = loaded.detail;
    if (run.status !== 'interrupted') {
      throw new RpcError(
        ErrorCode.StateConflict,
        `중단된 실행만 재개할 수 있습니다 (${run.displayId}, ${run.status})`,
      );
    }
    if (this.#active.has(run.id)) {
      throw new RpcError(ErrorCode.StateConflict, `이미 진행 중인 실행입니다: ${run.displayId}`);
    }
    // 프로젝트당 진행 중 1개 (ADR-105): 워크트리를 되돌리기 전에 거른다. 저장 트랜잭션에서 한 번 더 본다
    const other = loaded.running.find((r) => r.id !== run.id);
    if (other !== undefined) {
      throw new RpcError(
        ErrorCode.StateConflict,
        `다른 실행이 진행 중입니다 (${other.displayId}). 그 실행이 끝난 뒤 재개할 수 있습니다`,
      );
    }
    const reservation = this.#reserve(run.id);
    let saved: RunDetail;
    try {
      const git = gitRefOf(loaded.project, run);
      if (git !== null) {
        const target = run.headCommit ?? git.baseCommit;
        try {
          await resetRunWorktree(git, target, { biveHome: this.#biveHome, git: this.#git });
        } catch (error) {
          if (isUnrecoverableResume(error)) {
            throw this.#failUnresumable(projectId, run, steps, error);
          }
          throw new RpcError(
            ErrorCode.StateConflict,
            `워크트리를 마지막 완료 단계 커밋으로 되돌리지 못했습니다: ${errorMessage(error)}`,
          );
        }
      }
      const pending =
        run.currentStep === null
          ? undefined
          : steps
              .filter((step) => step.kind === run.currentStep && step.status === 'pending')
              .at(-1);
      const at = this.#timestamp();
      saved = this.#rpcStore(projectId, (store) =>
        store.transaction(() => {
          // 프로젝트당 진행 중 1개 (ADR-105): 다른 실행이 진행 중이면 재개하지 않는다(-32009, 사람이 그 실행이 끝난 뒤 다시)
          const other = store.runs.list({ status: 'running' }).find((r) => r.id !== run.id);
          if (other !== undefined) {
            throw new ConflictError(
              '실행',
              run.displayId,
              `다른 실행이 진행 중입니다 (${other.displayId})`,
            );
          }
          return store.runs.transition(run.id, {
            expectedStatus: 'interrupted',
            run: { status: 'running' },
            steps:
              pending === undefined ? [] : [{ id: pending.id, status: 'running', startedAt: at }],
          });
        }),
      );
    } catch (error) {
      reservation.release();
      // 재개할 수 없어 실패로 끝냈으면 자리가 났다: 다음 실행 대기를 시작한다 (ADR-105)
      if (
        error instanceof RpcError &&
        isRecord(error.data) &&
        error.data.reason === RESUME_UNRECOVERABLE
      ) {
        this.#defer(() => this.#advanceQueue(projectId));
      }
      throw error;
    }
    this.#emit({ type: 'run.saved', projectId, detail: saved });
    this.#log(`실행 재개 (${run.displayId}, ${String(run.currentStep)})`);
    reservation.start(projectId);
    return saved;
  }

  /**
   * 재개할 수 없는 중단 실행을 끝낸다 (사람의 재개 행동의 결과, ADR-105). 실행의 종료 상태는 다른 실패 쪽 종료와 같이
   * `runEnding` 한 곳에서 정한다(ADR-091 · ADR-094): 병합 커밋이 기록된 실행은 `interrupted → merged`(실패 사유 없음,
   * `currentStep = null`), 아니면 `interrupted → failed`(`worktree_error`). 어느 쪽이든 재개 불가라는 실패는 지금 단계의
   * 대기 시도에 남긴다(사유 · git 오류 코드 · 메시지). 워크트리가 없거나 어긋나 보존(잠금)은 하지 않는다(브랜치는
   * 지우지 않으므로 남는다). 저장 뒤 돌려줄 RPC 오류(-32009, `data.reason = resume_unrecoverable`)를 만든다. 저장이 실패하면
   * (다른 쪽이 먼저 바꿈) 그 오류를 돌려준다.
   */
  #failUnresumable(
    projectId: string,
    run: Run,
    steps: readonly Step[],
    error: GitWorktreeError,
  ): RpcError {
    const at = this.#timestamp();
    const pending =
      run.currentStep === null
        ? undefined
        : steps.filter((s) => s.kind === run.currentStep && s.status === 'pending').at(-1);
    const detail = {
      reason: 'worktree_error',
      detail: { code: error.code, message: error.message },
    };
    const ending = runEnding(run, 'failed', 'worktree_error');
    let saved: RunDetail;
    try {
      saved = this.#rpcStore(projectId, (store) =>
        store.runs.transition(run.id, {
          expectedStatus: 'interrupted',
          run: { ...ending.run, endedAt: at },
          steps:
            pending === undefined
              ? []
              : [
                  {
                    id: pending.id,
                    status: 'failed',
                    exitDetail: detail,
                    startedAt: at,
                    endedAt: at,
                  },
                ],
        }),
      );
    } catch (failure) {
      return failure instanceof RpcError
        ? failure
        : new RpcError(ErrorCode.StateConflict, errorMessage(failure));
    }
    this.#emit({ type: 'run.saved', projectId, detail: saved });
    this.#logEnding(run, ending.merged, 'failed', `재개 불가 ${error.code}`);
    const message = ending.merged
      ? `재개할 수 없어 남은 단계를 끝내지 못했습니다. 실행은 이미 병합돼 병합 완료로 끝냈습니다`
      : `재개할 수 없어 실행을 실패로 끝냈습니다`;
    return new RpcError(
      ErrorCode.StateConflict,
      `${message} (${run.displayId}, ${error.code}): ${error.message}`,
      {
        reason: RESUME_UNRECOVERABLE,
        runId: run.id,
        displayId: run.displayId,
        code: error.code,
        runStatus: saved.run.status,
      },
    );
  }

  // ── 수명 ──────────────────────────────────────────────

  /** 구동 중인 실행(과 대기 중인 판정)이 모두 끝날 때까지 기다린다. `runId`를 주면 그 실행만. */
  async settled(runId?: string): Promise<void> {
    for (;;) {
      const waits =
        runId === undefined
          ? [...this.#pending, ...[...this.#active.values()].map((active) => active.done)]
          : [this.#active.get(runId)?.done].filter((done) => done !== undefined);
      if (waits.length === 0) return;
      await Promise.all(waits);
    }
  }

  /** 종료: 새 구동을 받지 않고 진행 중 실행을 중단한다. 중단된 실행은 저장하지 않으므로 다음 기동 때 `interrupted`. */
  async stop(): Promise<void> {
    this.#closed = true;
    for (const active of this.#active.values()) {
      active.controller.abort(new Error('오케스트레이터 종료'));
    }
    await this.settled();
  }

  // ── 구동 ──────────────────────────────────────────────

  #defer(fn: () => void): void {
    const task = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      if (this.#closed) return;
      try {
        fn();
      } catch (error) {
        this.#log(`실행 엔진 판정 오류: ${errorMessage(error)}`);
      }
    });
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
  }

  #reserve(runId: string): { release: () => void; start: (projectId: string) => void } {
    const controller = new AbortController();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#active.set(runId, { controller, done });
    const finish = (): void => {
      this.#active.delete(runId);
      release();
    };
    return {
      release: finish,
      start: (projectId) => {
        void this.#drive(projectId, runId, controller.signal).finally(() => {
          finish();
          // 구동이 끝났다(종료 상태 저장 뒤): 자리가 났으면 다음 실행 대기를 시작한다 (ADR-105). 중단 · 종료 중이면 하지 않는다
          this.#defer(() => this.#advanceQueue(projectId));
        });
      },
    };
  }

  #launch(projectId: string, runId: string): void {
    if (this.#closed || this.#active.has(runId)) return;
    this.#reserve(runId).start(projectId);
  }

  async #drive(projectId: string, runId: string, signal: AbortSignal): Promise<void> {
    const handle = this.#tracker?.beginRun();
    /** 지금 다루는 실행 · 단계 시도 · git 참조 (저장 실패 시 실패로 끝내는 데 쓴다) */
    let current: DriveState | null = null;
    try {
      while (!signal.aborted) {
        current = null;
        const loaded = this.#store(projectId, (store) => ({
          detail: store.runs.getDetail(runId),
          project: store.getProject(),
        }));
        if (loaded.detail === null || loaded.project === null) return;
        const { run, steps } = loaded.detail;
        if (run.status !== 'running') return;
        current = { run, step: null, git: null };
        const step =
          run.currentStep === null
            ? undefined
            : steps.filter((s) => s.kind === run.currentStep && s.status === 'running').at(-1);
        if (step === undefined || step.kind === 'approval') {
          // 열린 시도가 없다: 실행만 끝낸다 (병합 커밋이 기록된 실행이면 merged, runEnding)
          const ending = runEnding(run, 'failed', 'state_inconsistent');
          this.#save(projectId, (store) =>
            store.runs.transition(runId, {
              expectedStatus: 'running',
              run: { ...ending.run, endedAt: this.#timestamp() },
            }),
          );
          this.#logEnding(run, ending.merged, 'failed', 'state_inconsistent');
          return;
        }
        current = { run, step, git: null };
        const prepared = await this.#prepare(projectId, loaded.project, run);
        if (signal.aborted) return;
        if ('git' in prepared) current = { run, step, git: prepared.git };
        const outcome =
          'halt' in prepared
            ? prepared.halt
            : await this.#execute(
                projectId,
                loaded.project,
                loaded.detail,
                step,
                prepared.git,
                signal,
              );
        if (outcome === null || signal.aborted) return;
        const git = 'git' in prepared ? prepared.git : null;
        await this.#apply(projectId, loaded.detail, step, outcome, git);
      }
    } catch (error) {
      if (!signal.aborted) {
        this.#log(`실행 엔진 오류 (${runId}): ${errorMessage(error)}`);
        // 결과 저장 · 커밋 등에서 예외가 나면 실행이 running에 고아로 남지 않게 실패로 끝낸다 (ADR-066)
        if (current !== null) await this.#failAfterError(projectId, current, error);
      }
    } finally {
      handle?.end();
    }
  }

  /**
   * 구동 중 예외 뒤: 실행이 아직 `running`이면 `failed`(`step_error`)로 끝낸다. 지금 시도가 아직 열려 있으면 그
   * 시도를 실패로(`#halt`), 아니면 실행만 바꾼다. 어느 쪽이든 병합 커밋이 기록된 뒤면 실행은 `merged`다(`runEnding`,
   * ADR-091 · ADR-094). 그것도 실패하면 로그만 남긴다(다음 기동 때 `interrupted`).
   */
  async #failAfterError(projectId: string, current: DriveState, error: unknown): Promise<void> {
    const exitDetail = { message: errorMessage(error) };
    try {
      const latest = this.#store(projectId, (store) => store.runs.getDetail(current.run.id));
      if (latest?.run.status !== 'running') return;
      const stepId = current.step?.id;
      const open = latest.steps.find((s) => s.id === stepId && !isFinalStepStatus(s.status));
      if (open !== undefined) {
        await this.#halt(
          projectId,
          latest.run,
          open,
          'failed',
          'step_error',
          exitDetail,
          current.git,
        );
        return;
      }
      // 시도가 이미 끝났다: 실행만 끝낸다 (병합 커밋이 기록된 실행이면 merged · 보존 없음, runEnding)
      const ending = runEnding(latest.run, 'failed', 'step_error');
      const at = this.#timestamp();
      this.#save(projectId, (store) =>
        store.runs.transition(current.run.id, {
          expectedStatus: 'running',
          run: { ...ending.run, endedAt: at },
        }),
      );
      this.#logEnding(latest.run, ending.merged, 'failed', 'step_error');
      if (!ending.merged && current.git !== null) await this.#worktrees.preserve(current.git);
    } catch (failure) {
      this.#log(`실행을 실패로 끝내지 못함 (${current.run.displayId}): ${errorMessage(failure)}`);
    }
  }

  /** 승인 기록 대조 · 실행 워크트리 준비. 문제가 있으면 지금 단계를 끝낼 `halt` 결과. */
  async #prepare(
    projectId: string,
    project: Project,
    run: Run,
  ): Promise<{ git: RunGitRef } | { halt: StepOutcome }> {
    // 실행마다 시작 근거가 정확히 1건이어야 한다: 사람의 실행 시작 확인(승인 기록 run_start) 또는 실행 자동 시작(규범 변경
    // 기록 auto_start, 원인 = 대상 규칙의 신규 기록). 같은 대상 규칙이어야 한다 (NFR-01, ADR-107)
    const basis = this.#store(projectId, (store) => checkRunStartBasis(store, run));
    if (basis.mismatch !== null) {
      return {
        halt: {
          status: 'halt',
          runStatus: 'failed',
          reason: 'run_without_log',
          exitDetail: {
            runStartEntries: basis.runStartEntries,
            autoStartEntries: basis.autoStartEntries,
            mismatch: basis.mismatch,
          },
        },
      };
    }
    // 단계 사이에 대상 규칙이 폐기됐으면 다음 단계를 열지 않고 끝낸다 (ADR-100 A3 · A4, ADR-112): 폐기된 규칙의 테스트 작성 ·
    // 구현 · 병합으로 예산을 쓰지 않고, 폐기 · 대체가 만든 새 실행이 그 자리를 잇는다. 병합 커밋이 기록된 뒤(화면 갱신)에는
    // 보지 않는다(이미 병합된 실행이다)
    const retired =
      run.mergeCommit === null
        ? this.#store(projectId, (store) => retiredTargetDisplayIds(store, run.targetRuleIds))
        : [];
    if (retired.length > 0) {
      return {
        halt: {
          status: 'halt',
          runStatus: 'failed',
          reason: TARGET_RULE_RETIRED,
          exitDetail: {
            message: '실행 도중 대상 규칙이 폐기되어 다음 단계를 진행하지 않았습니다',
            retiredRuleIds: retired,
          },
        },
      };
    }
    // 남은 단계의 실행기가 하나라도 없으면 워크트리 · 브랜치를 만들기 전에 끝낸다
    const plan: readonly StepKind[] =
      (RUN_STEP_PLANS as Partial<Record<string, readonly StepKind[]>>)[run.type] ?? [];
    // 유형이 생략하는 단계는 실행기를 부르지 않는다 (RUN-07, ADR-136)
    const missing = plan.filter(
      (kind) =>
        kind !== 'approval' &&
        !isRunTypeSkippedStep(run.type, kind) &&
        this.#executors[kind as EngineStepKind] === undefined,
    );
    if (missing.length > 0) {
      return {
        halt: {
          status: 'halt',
          runStatus: 'failed',
          reason: 'step_executor_missing',
          exitDetail: { missing },
        },
      };
    }
    const existing = gitRefOf(project, run);
    if (existing !== null) return { git: existing };
    if (run.branch !== null || run.worktreePath !== null || run.baseCommit !== null) {
      return {
        halt: {
          status: 'halt',
          runStatus: 'failed',
          reason: 'worktree_error',
          exitDetail: { message: '실행의 브랜치 · 워크트리 · 기준 커밋 중 일부만 저장됨' },
        },
      };
    }
    // 이어받는 실행 (ADR-147 ②, ADR-149): 기준 커밋은 원 실행과 같고 가지는 원 실행 브랜치에 있는 커밋에서 만든다. 원 실행이 워크트리를
    // 만들기 전에 끝났으면 보통 실행처럼 기준 브랜치의 지금 커밋에서
    const start =
      this.#store(projectId, (store) => continuationWorktreeStart(store, run.id)) ?? undefined;
    let git: RunGitRef;
    try {
      git = await this.#worktrees.create({
        projectId: project.id,
        runDisplayId: run.displayId,
        repoPath: project.rootPath,
        baseBranch: run.baseBranch,
        ...(start === undefined ? {} : { start }),
      });
    } catch (error) {
      return {
        halt: {
          status: 'halt',
          runStatus: 'failed',
          reason: 'worktree_error',
          exitDetail: { message: errorMessage(error) },
        },
      };
    }
    this.#save(projectId, (store) =>
      store.runs.transition(run.id, {
        expectedStatus: 'running',
        run: { branch: git.branch, worktreePath: git.worktreePath, baseCommit: git.baseCommit },
      }),
    );
    return { git };
  }

  async #execute(
    projectId: string,
    project: Project,
    detail: RunDetail,
    step: Step,
    git: RunGitRef,
    signal: AbortSignal,
  ): Promise<StepOutcome | null> {
    // 유형이 생략하는 단계: 실행기를 부르지 않고 생략으로 기록한다 (RUN-07, ADR-020 · ADR-136)
    if (isRunTypeSkippedStep(detail.run.type, step.kind)) {
      return { status: 'skipped', exitDetail: { reason: 'run_type', runType: detail.run.type } };
    }
    const executor = this.#executors[step.kind as EngineStepKind];
    if (executor === undefined) {
      return {
        status: 'halt',
        runStatus: 'failed',
        reason: 'step_executor_missing',
        exitDetail: { kind: step.kind },
      };
    }
    const context: StepContext = {
      biveHome: this.#biveHome,
      project,
      run: detail.run,
      step,
      steps: detail.steps,
      git,
      worktrees: this.#worktrees,
      signal,
      read: (fn) => this.#store(projectId, fn),
      runSession: (request) => this.#runSession(projectId, detail.run, step, request, signal),
      judgeNorms: (request) => this.#judge(projectId, detail.run, step, request, signal),
      // 송신을 기다리는 동안 종료 · 중단 신호가 오면 바로 거부한다(엔진은 저장하지 않고 끝남 → 다음 기동 때 중단)
      notify: (topic, data) =>
        untilAborted(
          Promise.resolve(
            this.#onEvent?.({ type: 'notify', projectId, runId: detail.run.id, topic, data }),
          ),
          signal,
        ),
    };
    try {
      return await executor(context);
    } catch (error) {
      if (signal.aborted) return null;
      if (error instanceof StepHaltError) {
        return {
          status: 'halt',
          runStatus: error.runStatus,
          reason: error.reason,
          exitDetail: error.exitDetail ?? null,
        };
      }
      return {
        status: 'halt',
        runStatus: 'failed',
        reason: 'step_error',
        exitDetail: { message: errorMessage(error) },
      };
    }
  }

  /** 단계 결과를 저장한다 (단계 종료 = 트랜잭션 1회). */
  async #apply(
    projectId: string,
    detail: RunDetail,
    step: Step,
    outcome: StepOutcome,
    git: RunGitRef | null,
  ): Promise<void> {
    const { run, steps } = detail;
    if (outcome.status === 'halt') {
      await this.#halt(
        projectId,
        run,
        step,
        outcome.runStatus,
        outcome.reason,
        outcome.exitDetail,
        git,
      );
      return;
    }
    if (outcome.status === 'unmet') {
      await this.#unmet(projectId, detail, step, outcome.exitDetail, git);
      return;
    }
    let commit: string | null = null;
    if (outcome.status === 'passed' && COMMIT_STEP_KINDS.includes(step.kind) && git !== null) {
      try {
        commit = (await this.#worktrees.commit(git, this.#commitMessage(run, step))).commit;
      } catch (error) {
        await this.#halt(
          projectId,
          run,
          step,
          'failed',
          'worktree_error',
          { message: errorMessage(error) },
          git,
        );
        return;
      }
    }
    const stepRun = outcome.status === 'passed' ? outcome.run : undefined;
    const invalid = invalidStepRunPatch(stepRun);
    if (invalid !== null) {
      // 실행기가 형식이 틀린 값(커밋 해시 아님 등)을 내면 저장 전에 실패로 끝낸다
      await this.#halt(projectId, run, step, 'failed', 'step_error', { message: invalid }, git);
      return;
    }
    const index = steps.findIndex((s) => s.id === step.id);
    const last = !steps.slice(index + 1).some((s) => s.status === 'pending');
    const mergeCommit = stepRun?.mergeCommit ?? run.mergeCommit;
    if (last && mergeCommit === null) {
      await this.#halt(projectId, run, step, 'failed', 'merge_missing', outcome.exitDetail, git);
      return;
    }
    const at = this.#timestamp();
    this.#save(projectId, (store) =>
      completeStep(
        store,
        run.id,
        {
          status: outcome.status,
          exitDetail: outcome.exitDetail ?? null,
          commit,
          run: {
            ...stepRun,
            ...(commit === null ? {} : { headCommit: commit }),
            toolManifest: store.sessions.manifest(run.id),
            ...(last ? { status: 'merged', endedAt: at } : {}),
          },
        },
        { now: () => Date.parse(at) },
      ),
    );
    if (last) this.#log(`실행 병합 완료 (${run.displayId})`);
  }

  /** 종료 조건 미충족: 재시도 · 회귀 (상한을 넘으면 실패). */
  async #unmet(
    projectId: string,
    detail: RunDetail,
    step: Step,
    exitDetail: unknown,
    git: RunGitRef | null,
  ): Promise<void> {
    const { run, steps } = detail;
    // 유형별 미충족 정책 (회귀 상한은 모든 유형 공통, ADR-020 · ADR-136)
    const policy = UNMET_POLICY_BY_TYPE[run.type][step.kind as EngineStepKind];
    if (policy === undefined) {
      await this.#halt(projectId, run, step, 'failed', 'step_unmet', exitDetail, git);
      return;
    }
    const patch: RunPatch = {};
    if (policy.counter === 'regression') {
      const next = run.regressionCount + 1;
      if (next > MAX_REGRESSION_COUNT) {
        await this.#halt(projectId, run, step, 'failed', 'regression_limit', exitDetail, git);
        return;
      }
      patch.regressionCount = next;
    } else {
      const used =
        steps.filter((s) => s.kind === 'test_writing' && !isInterruptedAttempt(s)).length - 1;
      if (used >= MAX_TEST_RETRY_COUNT) {
        await this.#halt(projectId, run, step, 'failed', 'test_retry_limit', exitDetail, git);
        return;
      }
    }
    // 다시 하는 시도는 마지막 완료 단계 커밋에서 시작한다 (재개와 같은 규칙, ADR-066)
    if (git !== null) {
      try {
        await resetRunWorktree(git, run.headCommit ?? git.baseCommit, {
          biveHome: this.#biveHome,
          git: this.#git,
        });
      } catch (error) {
        await this.#halt(
          projectId,
          run,
          step,
          'failed',
          'worktree_error',
          { message: errorMessage(error) },
          git,
        );
        return;
      }
    }
    const at = this.#timestamp();
    this.#save(projectId, (store) =>
      store.runs.regress(run.id, {
        toKind: policy.to,
        at,
        newId: this.#newId,
        expectedStatus: 'running',
        exitDetail: exitDetail ?? null,
        run: { ...patch, toolManifest: store.sessions.manifest(run.id) },
      }),
    );
    this.#log(
      `단계 종료 조건 미충족 (${run.displayId}, ${step.kind} → ${policy.to}, 회귀 ${String(
        patch.regressionCount ?? run.regressionCount,
      )})`,
    );
  }

  /**
   * 실행을 끝낸다(`failed` · `budget_exceeded`): 지금 시도 실패 · 사유 저장 뒤 브랜치 · 워크트리 보존 (RUN-08).
   * 병합 커밋이 이미 기록된 실행(병합 단계 뒤의 화면 갱신 단계)이면 기준 브랜치에 병합 커밋이 있으므로 실행은 `merged`로
   * 끝내고(실패 사유 없음, 마지막 완료 단계는 병합 그대로) 지금 시도만 `failed` + 사유로 남긴다. 보존은 하지 않는다(ADR-091).
   */
  async #halt(
    projectId: string,
    run: Run,
    step: Step,
    runStatus: HaltStatus,
    reason: string,
    exitDetail: unknown,
    git: RunGitRef | null,
  ): Promise<void> {
    const at = this.#timestamp();
    const ending = runEnding(run, runStatus, reason);
    this.#save(projectId, (store) =>
      store.runs.transition(run.id, {
        expectedStatus: 'running',
        steps: [
          {
            id: step.id,
            status: 'failed',
            exitDetail: { reason, detail: exitDetail ?? null },
            startedAt: step.startedAt ?? at,
            endedAt: at,
          },
        ],
        run: {
          ...ending.run,
          endedAt: at,
          toolManifest: store.sessions.manifest(run.id),
        },
      }),
    );
    this.#logEnding(run, ending.merged, runStatus, reason, step.kind);
    // 병합된 실행은 보존(워크트리 잠금)하지 않는다 (ADR-091)
    if (ending.merged || git === null) return;
    try {
      await this.#worktrees.preserve(git);
    } catch (error) {
      this.#log(`실행 브랜치 보존 실패 (${run.displayId}): ${errorMessage(error)}`);
    }
  }

  /** 실행 종료 진행 기록 한 줄 (`runEnding`의 결과대로). */
  #logEnding(
    run: Run,
    merged: boolean,
    runStatus: HaltStatus,
    reason: string,
    stepKind?: StepKind,
  ): void {
    if (merged) {
      const what = stepKind === undefined ? reason : `${stepKind} 단계 실패: ${reason}`;
      this.#log(`실행 병합 완료 (${run.displayId}, ${what})`);
      return;
    }
    this.#log(`실행 종료 (${run.displayId}, ${runStatus}: ${reason})`);
  }

  // ── 세션 ──────────────────────────────────────────────

  /**
   * 단계 역할의 세션 1개 (ADR-024 · ADR-049 · ADR-052 · ADR-066): 모델 · 한도는 실행 스냅샷과 남은 예산, 세션 순번은
   * 저장된 (실행, 역할) 세션 수, 도구 호출 · init 보고는 바로 저장한다. 가드 위반 → 실행 `failed`(`guard_violation`),
   * 예산 소진 · 한도 subtype · 집계 초과 → `budget_exceeded`(StepHaltError).
   */
  async #runSession(
    projectId: string,
    run: Run,
    step: Step,
    request: StepSessionRequest,
    signal: AbortSignal,
  ): Promise<StepSessionResult> {
    const role = STEP_ROLES[step.kind];
    if (role === null) throw new Error(`에이전트 역할이 없는 단계입니다: ${step.kind}`);
    const model = run.modelSnapshot[role];
    // 프로젝트 하루 한도(ADR-104)는 실행 스냅샷이 아니라 지금 설정과 저장된 오늘의 세션 기록에서 읽는다
    // 사용량은 이어받는 실행이면 사슬 전체(원 실행들의 세션부터)를 센다 (ADR-147 ④, 이어받는 실행이 아니면 이 실행의 세션 그대로)
    const { limits, index, daily } = this.#store(projectId, (store) => {
      const sessions = store.sessions.listByRun(run.id);
      const daily = projectDailyBudget(store, store.settings.get(), this.#now());
      return {
        limits: sessionLimits(
          run.budgetSnapshot,
          role,
          lineageSessions(store, run.id),
          daily?.remaining,
        ),
        index: sessions.filter((session) => session.role === role).length,
        daily,
      };
    });
    if (model === undefined || limits === undefined) {
      throw new StepHaltError('failed', 'settings_missing', { role });
    }
    if (daily !== null && dailyBudgetReached(daily)) {
      throw new StepHaltError('budget_exceeded', 'project_daily_budget_exceeded', {
        role,
        day: daily.day,
        limit: daily.limit,
        ...daily.spend,
      });
    }
    if (limits === null) throw new StepHaltError('budget_exceeded', 'budget_exhausted', { role });
    signal.throwIfAborted();

    const sessionId = this.#newId();
    this.#store(projectId, (store) =>
      store.sessions.start({
        id: sessionId,
        runId: run.id,
        stepId: step.id,
        role,
        model,
        workDir: request.workDir,
        budget: limits,
        normInput: request.normInput ?? null,
        startedAt: this.#timestamp(),
      }),
    );
    const controller = new AbortController();
    let closedCalls = 0;
    const tools = createRoleTools({
      role,
      sessionRoot: request.workDir,
      biveHome: this.#biveHome,
      sessionId,
      now: () => new Date(this.#now()),
      ...(request.commands === undefined ? {} : { commands: request.commands }),
      ...(request.writableRuleDirs === undefined
        ? {}
        : { writableRuleDirs: request.writableRuleDirs }),
      hooks: {
        ...request.hooks,
        onToolCall: (record) => {
          this.#recordToolCall(projectId, run.id, sessionId, record);
          // 이의를 제기해 닫힌 세션은 스스로 끝나기를 기다리고, 거부가 쌓이면 끝낸다 (ADR-115 검토 1회차)
          if (record.reason === 'session_closed' && tools.closed === 'objection_raised') {
            closedCalls += 1;
            if (closedCalls >= OBJECTION_CLOSED_CALL_LIMIT) {
              controller.abort(new SessionEndRequest('objection_raised'));
            }
          }
          // 변이를 받아 닫힌 변이 주입 세션도 같은 수의 거부 뒤 끝낸다 (M3-54 #311, ADR-143): 받은 변이는 판정한다(단계 실행기가 쥐고
          // 있다). 종료 사유는 `aborted`이고 비용을 모르면 기존 추정(ADR-067)으로 센다
          if (record.reason === 'session_closed' && tools.closed === 'mutant_proposed') {
            closedCalls += 1;
            if (closedCalls >= OBJECTION_CLOSED_CALL_LIMIT) {
              controller.abort(new Error('변이를 받은 뒤에도 세션이 도구를 계속 부름'));
            }
          }
        },
      },
    });
    const forward = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', forward, { once: true });
    let outcome;
    try {
      outcome = await runGuardedSession({
        adapter: this.#agent,
        controller,
        spec: {
          role,
          systemPrompt: request.systemPrompt,
          prompt: request.prompt,
          workDir: request.workDir,
          tools,
          budget: limits,
          model,
          runId: run.id,
          roleSessionIndex: index,
          ...(request.vars === undefined ? {} : { vars: request.vars }),
        },
        onInit: (_manifest, init) => {
          this.#quietly(`세션 init 기록 (${sessionId})`, () =>
            this.#store(projectId, (store) =>
              store.sessions.recordInit(sessionId, {
                sdkSessionId: init.sessionId,
                tools: init.tools,
                mcpServers: init.mcpServers,
              }),
            ),
          );
        },
      });
    } finally {
      signal.removeEventListener('abort', forward);
    }
    const { result } = outcome;
    // 이의를 제기해 실행기가 닫혔으면 세션이 스스로 결과로 끝났어도(주 경로) 이의 제기로 본다. 가드 위반 · 한도 subtype은 그대로
    // (한도로 끝났으면 실행이 예산 초과로 끝난다)
    const endReason = signal.aborted
      ? 'aborted'
      : tools.closed === 'objection_raised' &&
          (outcome.endReason === 'success' || outcome.endReason === 'error_during_execution')
        ? 'objection_raised'
        : outcome.endReason;
    this.#store(projectId, (store) =>
      store.sessions.end(sessionId, {
        endReason,
        error: outcome.detail,
        totalCostUsd: result?.total_cost_usd ?? null,
        numTurns: result?.num_turns ?? null,
        modelUsage: Object.fromEntries(
          Object.entries(result?.modelUsage ?? {}).map(([name, usage]): [string, ModelUsage] => [
            name,
            {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadInputTokens: usage.cacheReadInputTokens,
              cacheCreationInputTokens: usage.cacheCreationInputTokens,
              costUsd: usage.costUSD,
            },
          ]),
        ),
        endedAt: this.#timestamp(),
      }),
    );
    signal.throwIfAborted();
    if (endReason === 'guard_violation') {
      throw new StepHaltError('failed', 'guard_violation', { sessionId, message: outcome.detail });
    }
    if (endReason === 'error_max_budget_usd' || endReason === 'error_max_turns') {
      throw new StepHaltError('budget_exceeded', endReason, { sessionId });
    }
    // 집계 초과 (ADR-067): 한도 subtype이 아니어도 끝난 세션까지의 역할 · 실행 합계가 한도를 넘었으면 실행을 끝낸다
    const overrun = this.#store(projectId, (store) =>
      budgetOverrun(run.budgetSnapshot, role, lineageSessions(store, run.id)),
    );
    if (overrun !== null) {
      throw new StepHaltError('budget_exceeded', 'budget_aggregate_exceeded', {
        sessionId,
        ...overrun,
      });
    }
    return {
      sessionId,
      role,
      endReason:
        endReason === 'success' || endReason === 'objection_raised'
          ? endReason
          : 'error_during_execution',
      result,
      detail: outcome.detail,
    };
  }

  /**
   * 실행 안 판단 세션 1개 (M7-11 #223, ADR-115): 주입받은 배선에 실행 · 단계 · 실행 잔여 한도 · 중단 신호를 넘기고 끝날 때까지
   * 기다린다. 배선이 없거나 실행 예산이 남지 않았으면 세션을 열지 않는다(`not_opened`). 판단 세션의 한도는 실행 잔여 안이고, 세션
   * 행은 이 실행 · 단계 시도에 묶여 하루 한도 합계와 실행 합계 모두에 든다(M7-12 #224, ADR-118. 쓴 돈이 실행 잔여에서 빠진다).
   */
  async #judge(
    projectId: string,
    run: Run,
    step: Step,
    request: NormJudgeStepRequest,
    signal: AbortSignal,
  ): Promise<NormJudgeOutcome> {
    signal.throwIfAborted();
    const launch = this.#judgeNorms;
    if (launch === undefined) {
      return { status: 'not_opened', reason: 'not_configured', detail: '판단 세션 배선 없음' };
    }
    const runBudget = this.#store(projectId, (store) =>
      runRemaining(run.budgetSnapshot, lineageSessions(store, run.id)),
    );
    if (runBudget === null) {
      return { status: 'not_opened', reason: 'budget_exhausted', detail: '실행 예산 소진' };
    }
    this.#log(
      `판단 세션 요청 (${run.displayId}, 원인 ${request.cause.kind}${
        request.cause.kind === 'objection'
          ? ` ${String(request.cause.seq)}`
          : ` ${request.cause.stage}`
      })`,
    );
    const outcome = await launch({
      ...request,
      projectId,
      run: { id: run.id, displayId: run.displayId },
      stepId: step.id,
      runBudget,
      signal,
    });
    signal.throwIfAborted();
    return outcome;
  }

  #recordToolCall(projectId: string, runId: string, sessionId: Ulid, record: ToolCallRecord): void {
    this.#quietly(`도구 호출 기록 (${sessionId})`, () =>
      this.#store(projectId, (store) =>
        store.sessions.appendToolCall({
          id: this.#newId(),
          runId,
          sessionId,
          at: record.at,
          role: record.role,
          name: record.name,
          argsSummary: record.argsSummary,
          status: record.status,
          reason: record.reason ?? null,
          durationMs: Math.max(0, Math.round(record.durationMs)),
        }),
      ),
    );
  }

  // ── 도우미 ────────────────────────────────────────────

  #commitMessage(run: Run, step: Step): string {
    return stepCommitMessage(run, step);
  }

  #timestamp(): string {
    return new Date(this.#now()).toISOString();
  }

  #store<T>(projectId: string, fn: (store: ProjectStore) => T): T {
    return withRegisteredProjectStore(this.#biveHome, projectId, fn);
  }

  /** RPC 경로: 저장소 오류를 IPC 오류로 바꾼다. */
  #rpcStore<T>(projectId: string, fn: (store: ProjectStore) => T): T {
    try {
      return this.#store(projectId, fn);
    } catch (error) {
      throw toRpcError(error);
    }
  }

  #save(projectId: string, fn: (store: ProjectStore) => RunDetail): RunDetail {
    const detail = this.#store(projectId, fn);
    this.#emit({ type: 'run.saved', projectId, detail });
    return detail;
  }

  /** 저장 이벤트: 기다리지 않는다. 전달 실패는 실행 상태에 영향이 없고 기록만 남긴다. */
  #emit(event: EngineEvent): void {
    this.#quietly('실행 이벤트 전달', () => {
      const delivered = this.#onEvent?.(event);
      if (delivered !== undefined) {
        delivered.catch((error: unknown) => {
          this.#log(`실행 이벤트 전달 실패: ${errorMessage(error)}`);
        });
      }
    });
  }

  #quietly(what: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.#log(`${what} 실패: ${errorMessage(error)}`);
    }
  }
}
