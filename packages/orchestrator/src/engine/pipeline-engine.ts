// 파이프라인 엔진: 상태 기계 · 단계 진행 · 회귀 · 중단 · 재개 · 단계 세션 실행 틀
// (RUN-01 · RUN-02 · RUN-08, PRD 5.1, NFR-01 · NFR-02 · NFR-07, ADR-011 · ADR-026 · ADR-027 · ADR-049 · ADR-058 ·
// ADR-061 · ADR-066).
// - 상태 저장은 단계 종료마다 `ProjectStore.runs`의 트랜잭션 1회다(`completeStep` · `regress` · `transition`).
//   단계 중간에는 실행 상태를 저장하지 않는다(세션 · 도구 호출 기록은 별도 기록, 워크트리 생성 정보는 ADR-061)
// - 승인 단계는 엔진이 판정한다(`evaluateApprovalStep`): 실행 생성 직후 · 규칙 승인 뒤. 대상 규칙이 전부 승인
//   상태가 아니면 아무것도 저장하지 않고 머문다. 그 밖 단계는 주입받은 단계 실행기(`StepExecutors`)가 결과를 낸다
// - 종료 조건 미충족은 다음 단계로 가지 않는다: 테스트 작성 · Red 확인은 테스트 작성부터 다시(상한 2회),
//   구현 · 검사는 구현부터 다시(`regressionCount`, 상한 2회). 상한을 넘으면 실행 `failed`, 브랜치 · 워크트리 보존
// - 재기동(`recoverInterruptedRuns`)은 `running` 실행을 `interrupted`로 바꾸고 자동으로 이어가지 않는다(PRD 5.1)
// - 재개(`resume`)는 사람이 `interrupted` 실행에만: 워크트리를 마지막 완료 단계 커밋으로 hard reset + clean 한 뒤
//   지금 단계의 새 시도 · 새 세션으로 이어간다. `regressionCount`는 그대로 둔다 (ADR-027)
import {
  type Author,
  CommitSha,
  createUlidGenerator,
  ErrorCode,
  isFinalStepStatus,
  MAX_REGRESSION_COUNT,
  type ModelUsage,
  parseDisplayId,
  type Project,
  type Run,
  RUN_STEP_PLANS,
  type Step,
  type StepKind,
  STEP_KIND_LABELS,
  STEP_ROLES,
  type Ulid,
} from '@bive/shared';
import {
  NotFoundError,
  openRegistry,
  type ProjectStore,
  type RunDetail,
  type RunPatch,
} from '@bive/store';

import type { AgentAdapter } from '../agent/adapter.js';
import { runGuardedSession } from '../agent/guarded-session.js';
import { createGitRunner, type GitRunner } from '../git/git-exec.js';
import {
  createWorktreeManager,
  type RunGitRef,
  type WorktreeManager,
} from '../git/worktree-manager.js';
import { resetRunWorktree } from '../git/worktree-reset.js';
import { toRpcError, withRegisteredProjectStore } from '../ipc/project-store-access.js';
import { RpcError } from '../ipc/server.js';
import type { RunTracker } from '../lifecycle.js';
import { completeStep, evaluateApprovalStep } from '../runs/run-service.js';
import { createRedCheckExecutor } from '../steps/red-check.js';
import { createTestWritingExecutor } from '../steps/test-writing.js';
import { createRoleTools, type ToolCallRecord } from '../tools/executor.js';
import { sessionLimits } from './session-budget.js';
import {
  COMMIT_STEP_KINDS,
  type EngineEvent,
  type EngineStepKind,
  type HaltStatus,
  MAX_TEST_RETRY_COUNT,
  type StepContext,
  type StepExecutor,
  type StepExecutors,
  type StepOutcome,
  type StepRunPatch,
  type StepSessionRequest,
  type StepSessionResult,
  UNMET_POLICY,
} from './types.js';

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
  /** 저장 · 알림 이벤트 (#32가 `event.*` 알림으로 잇는다) */
  onEvent?: (event: EngineEvent) => void;
  /** 진행 기록 한 줄 */
  log?: (line: string) => void;
}

/** M1 변이 주입: P1(JDG-04)이라 `skipped`로 기록한다 (RUN-02 P0 범위, roadmap M1-14). */
export const skipMutationStep: StepExecutor = () =>
  Promise.resolve({ status: 'skipped', exitDetail: { reason: 'not_in_scope', scope: 'P1' } });

/** 화면 갱신: 알림만 보내고 통과한다. 판정 결과 저장 뒤 알림 송신 확인은 #32가 이 실행기를 바꿔 넣는다. */
export const notifyScreenUpdateStep: StepExecutor = (context) => {
  context.notify('screen_update', { runId: context.run.id });
  return Promise.resolve({ status: 'passed', exitDetail: { notified: true } });
};

/**
 * 기본 실행기: 테스트 작성 · Red 확인(#28, ADR-068) · 변이 주입 `skipped` · 화면 갱신 알림. 구현 · 검사 · 병합은 #29가
 * 넣는다. 유형 A 실행기가 다 있어야 구동하므로 그 전까지 실행은 `step_executor_missing`으로 끝난다 (ADR-066).
 */
export const DEFAULT_STEP_EXECUTORS: StepExecutors = {
  test_writing: createTestWritingExecutor(),
  red_check: createRedCheckExecutor(),
  mutation: skipMutationStep,
  screen_update: notifyScreenUpdateStep,
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isInterruptedAttempt = (step: Step): boolean =>
  typeof step.exitDetail === 'object' &&
  step.exitDetail !== null &&
  (step.exitDetail as { interrupted?: unknown }).interrupted === true;

const sameIds = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  a !== undefined && a.length === b.length && a.every((id, index) => id === b[index]);

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
  const { costUsd, turns } = patch;
  if (costUsd !== undefined && costUsd !== null && !(Number.isFinite(costUsd) && costUsd >= 0)) {
    return `costUsd가 0 이상의 수가 아닙니다: ${String(costUsd)}`;
  }
  if (turns !== undefined && turns !== null && !(Number.isSafeInteger(turns) && turns >= 0)) {
    return `turns가 0 이상의 정수가 아닙니다: ${String(turns)}`;
  }
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
  readonly #onEvent: ((event: EngineEvent) => void) | undefined;
  readonly #log: (line: string) => void;
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
    let projectIds: string[];
    try {
      const registry = openRegistry({ home: this.#biveHome, create: false });
      try {
        projectIds = registry.entries.list().map((entry) => entry.projectId);
      } finally {
        registry.close();
      }
    } catch (error) {
      if (error instanceof NotFoundError) return [];
      throw error;
    }
    const interrupted: InterruptedRun[] = [];
    for (const projectId of projectIds) {
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

  /** 실행 밖 세션(규칙 작성, ADR-062) 중 끝나지 않은 것: 앞 프로세스가 죽은 것이므로 `aborted`로 닫는다. */
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

  /** 실행 생성(`run.create`) 뒤: 응답을 보낸 다음 승인 단계를 판정한다. */
  onRunCreated(projectId: string, runId: string): void {
    this.#defer(() => {
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
   * 승인 단계를 판정한다 (RUN-02). 대상 규칙이 전부 승인 상태면 `running`으로 저장하고 구동을 시작한다.
   * @returns 승인 단계가 끝났는지
   */
  evaluateApproval(projectId: string, runId: string): boolean {
    if (this.#closed) return false;
    const result = this.#store(projectId, (store) =>
      evaluateApprovalStep(store, runId, { now: this.#now }),
    );
    if (!result.approved) return false;
    this.#emit({ type: 'run.saved', projectId, detail: { run: result.run, steps: result.steps } });
    this.#launch(projectId, runId);
    return true;
  }

  // ── 재개 ──────────────────────────────────────────────

  /**
   * 중단된 실행을 재개한다 (`run.resume`, PRD 5.1 · ADR-011 · ADR-027). 사람만, `interrupted`만 받는다.
   * 워크트리를 마지막 완료 단계 커밋(`headCommit`, 없으면 `baseCommit`)으로 hard reset + clean 하고, 지금 단계의
   * 대기 시도를 시작해 `running`으로 저장한 뒤 구동한다(새 세션). `regressionCount`는 바꾸지 않는다.
   * @throws {RpcError} -32020 사람 아님 · -32004 없음 · -32009 `interrupted` 아님 · 이미 구동 중 · 되돌리기 실패
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
    const reservation = this.#reserve(run.id);
    let saved: RunDetail;
    try {
      const git = gitRefOf(loaded.project, run);
      if (git !== null) {
        const target = run.headCommit ?? git.baseCommit;
        try {
          await resetRunWorktree(git, target, { biveHome: this.#biveHome, git: this.#git });
        } catch (error) {
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
        store.runs.transition(run.id, {
          expectedStatus: 'interrupted',
          run: { status: 'running' },
          steps:
            pending === undefined ? [] : [{ id: pending.id, status: 'running', startedAt: at }],
        }),
      );
    } catch (error) {
      reservation.release();
      throw error;
    }
    this.#emit({ type: 'run.saved', projectId, detail: saved });
    this.#log(`실행 재개 (${run.displayId}, ${String(run.currentStep)})`);
    reservation.start(projectId);
    return saved;
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
        void this.#drive(projectId, runId, controller.signal).finally(finish);
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
          this.#save(projectId, (store) =>
            store.runs.transition(runId, {
              expectedStatus: 'running',
              run: {
                status: 'failed',
                failureReason: 'state_inconsistent',
                endedAt: this.#timestamp(),
              },
            }),
          );
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
   * 시도를 실패로, 아니면 실행만 바꾼다. 그것도 실패하면 로그만 남긴다(다음 기동 때 `interrupted`).
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
      const at = this.#timestamp();
      this.#save(projectId, (store) =>
        store.runs.transition(current.run.id, {
          expectedStatus: 'running',
          run: { status: 'failed', failureReason: 'step_error', endedAt: at },
        }),
      );
      if (current.git !== null) await this.#worktrees.preserve(current.git);
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
    // 실행마다 사람의 실행 시작 확인(승인 기록 run_start, 같은 대상 규칙)이 있어야 한다 (NFR-01)
    const logged = this.#store(projectId, (store) =>
      store.approvalLog
        .list({ entity: 'Run', id: run.id })
        .filter((entry) => entry.action === 'run_start'),
    );
    if (logged.length !== 1 || !sameIds(logged[0]?.detail.ruleIds, run.targetRuleIds)) {
      return {
        halt: {
          status: 'halt',
          runStatus: 'failed',
          reason: 'run_without_log',
          exitDetail: { runStartEntries: logged.length },
        },
      };
    }
    // 남은 단계의 실행기가 하나라도 없으면 워크트리 · 브랜치를 만들기 전에 끝낸다
    const plan: readonly StepKind[] =
      (RUN_STEP_PLANS as Partial<Record<string, readonly StepKind[]>>)[run.type] ?? [];
    const missing = plan.filter(
      (kind) => kind !== 'approval' && this.#executors[kind as EngineStepKind] === undefined,
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
    let git: RunGitRef;
    try {
      git = await this.#worktrees.create({
        projectId: project.id,
        runDisplayId: run.displayId,
        repoPath: project.rootPath,
        baseBranch: run.baseBranch,
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
      notify: (topic, data) => {
        this.#emit({ type: 'notify', projectId, runId: detail.run.id, topic, data });
      },
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
    const policy = UNMET_POLICY[step.kind as EngineStepKind];
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

  /** 실행을 끝낸다(`failed` · `budget_exceeded`): 지금 시도 실패 · 사유 저장 뒤 브랜치 · 워크트리 보존 (RUN-08). */
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
          status: runStatus,
          failureReason: reason,
          endedAt: at,
          toolManifest: store.sessions.manifest(run.id),
        },
      }),
    );
    this.#log(`실행 종료 (${run.displayId}, ${runStatus}: ${reason})`);
    if (git === null) return;
    try {
      await this.#worktrees.preserve(git);
    } catch (error) {
      this.#log(`실행 브랜치 보존 실패 (${run.displayId}): ${errorMessage(error)}`);
    }
  }

  // ── 세션 ──────────────────────────────────────────────

  /**
   * 단계 역할의 세션 1개 (ADR-024 · ADR-049 · ADR-052 · ADR-066): 모델 · 한도는 실행 스냅샷과 남은 예산, 세션 순번은
   * 저장된 (실행, 역할) 세션 수, 도구 호출 · init 보고는 바로 저장한다. 가드 위반 → 실행 `failed`(`guard_violation`),
   * 예산 소진 · 한도 subtype → `budget_exceeded`(StepHaltError).
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
    const { limits, index } = this.#store(projectId, (store) => {
      const sessions = store.sessions.listByRun(run.id);
      return {
        limits: sessionLimits(run.budgetSnapshot, role, sessions),
        index: sessions.filter((session) => session.role === role).length,
      };
    });
    if (model === undefined || limits === undefined) {
      throw new StepHaltError('failed', 'settings_missing', { role });
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
        startedAt: this.#timestamp(),
      }),
    );
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
        onToolCall: (record) => this.#recordToolCall(projectId, run.id, sessionId, record),
      },
    });
    const controller = new AbortController();
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
    const endReason = signal.aborted ? 'aborted' : outcome.endReason;
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
    return {
      sessionId,
      role,
      endReason: endReason === 'success' ? 'success' : 'error_during_execution',
      result,
      detail: outcome.detail,
    };
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
    return `BIVE 실행 ${run.displayId} ${STEP_KIND_LABELS[step.kind]} (시도 ${String(step.attempt)})\n\nBive-Run: ${run.displayId}\nBive-Step: ${step.kind}#${String(step.attempt)}`;
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

  #emit(event: EngineEvent): void {
    this.#quietly('실행 이벤트 전달', () => this.#onEvent?.(event));
  }

  #quietly(what: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.#log(`${what} 실패: ${errorMessage(error)}`);
    }
  }
}
