// 실행 · 단계 리포지토리 (RUN-01, RUN-02, NFR-01, ADR-061). 입력 · 출력은 `@bive/shared`의 `Run` · `Step`으로 검증한다.
// - 표시 ID(`EXE-NNN`)는 생성 트랜잭션 안에서 순번 테이블로 정한다. 동시 생성도 쓰기 트랜잭션이 직렬화하므로 겹치지 않는다
// - 생성 직후 상태는 항상 `waiting_approval`이다(architecture.md 4장 상태 기계의 시작)
// - 상태 저장은 `transition` 1회 = 트랜잭션 1회다(RUN-01: 단계 종료마다 저장). 단계 갱신 · 새 시도 추가 · 실행 갱신을
//   한꺼번에 반영하고, 상태 기계에 없는 전이 · 종료된 실행 · 끝난 단계의 변경은 `ConflictError`로 거부한다
// - 실행 · 단계는 지우지 않는다. 생성 정보와 끝난 기록은 DB 트리거도 막는다
import {
  canTransitionRun,
  compareSteps,
  isFinalStepStatus,
  isTerminalRunStatus,
  Run,
  type RunStatus,
  Step,
  type Ulid,
} from '@bive/shared';

import { withTransaction, type SqliteDatabase } from '../database.js';
import { ConflictError, NotFoundError, isUniqueViolation } from '../errors.js';
import { DisplayIdSequences } from './display-id-sequences.js';

/** 새 단계 시도. 비운 필드는 `null`(종료 조건 결과 · 커밋 · 비용 · 턴 · 종료 시각). */
export type StepCreateInput = Pick<
  Step,
  'id' | 'kind' | 'attempt' | 'status' | 'role' | 'startedAt'
> &
  Partial<Pick<Step, 'exitDetail' | 'commit' | 'costUsd' | 'turns' | 'endedAt'>>;

/**
 * 새 실행. 상태(`waiting_approval`) · 표시 ID · 진행 필드(회귀 수 0, 나머지 `null` · 빈 목록)는 리포지토리가 채운다.
 * `steps`는 처음 만들 단계 시도들(유형별 단계 순서는 호출한 쪽이 `RUN_STEP_PLANS`로 정한다).
 */
export interface RunCreateInput extends Pick<
  Run,
  | 'id'
  | 'type'
  | 'targetRuleIds'
  | 'currentStep'
  | 'baseBranch'
  | 'budgetSnapshot'
  | 'modelSnapshot'
  | 'startedBy'
  | 'createdAt'
> {
  readonly steps: readonly StepCreateInput[];
}

/** 실행 1건과 단계 목록(파이프라인 순서 → 시도 번호 순). */
export interface RunDetail {
  readonly run: Run;
  readonly steps: Step[];
}

/** 실행에서 바꿀 수 있는 필드. 없는(`undefined`) 키는 그대로 둔다. */
export type RunPatch = Partial<
  Pick<
    Run,
    | 'status'
    | 'currentStep'
    | 'lastCompletedStep'
    | 'regressionCount'
    | 'failureReason'
    | 'branch'
    | 'worktreePath'
    | 'baseCommit'
    | 'headCommit'
    | 'mergeCommit'
    | 'costUsd'
    | 'turns'
    | 'toolManifest'
    | 'startedAt'
    | 'endedAt'
  >
>;

/** 단계 시도 1개에서 바꿀 필드. 없는(`undefined`) 키는 그대로 둔다. */
export type StepPatch = { readonly id: Ulid } & Partial<
  Pick<Step, 'status' | 'exitDetail' | 'commit' | 'costUsd' | 'turns' | 'startedAt' | 'endedAt'>
>;

/** 상태 저장 1회(= 트랜잭션 1회)에 반영할 변경. */
export interface RunTransition {
  /** 지금 상태가 이것이어야 한다(아니면 `ConflictError`). 다른 쪽이 먼저 바꾼 경우를 막는다 */
  readonly expectedStatus?: RunStatus;
  readonly run?: RunPatch;
  /** 이미 있는 단계 시도의 변경 (끝난 시도는 바꿀 수 없다) */
  readonly steps?: readonly StepPatch[];
  /** 새 단계 시도 (회귀 · 재시도) */
  readonly addSteps?: readonly StepCreateInput[];
}

export interface RunListFilter {
  readonly status?: RunStatus;
}

const ENTITY = '실행';
const STEP_ENTITY = '단계';

interface RunRow {
  id: string;
  display_id: string;
  type: string;
  status: string;
  current_step: string | null;
  last_completed_step: string | null;
  regression_count: number;
  failure_reason: string | null;
  branch: string | null;
  worktree_path: string | null;
  base_branch: string;
  base_commit: string | null;
  head_commit: string | null;
  merge_commit: string | null;
  budget_snapshot: string;
  model_snapshot: string;
  cost_usd: number | null;
  turns: number | null;
  tool_manifest: string;
  started_by: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

interface StepRow {
  id: string;
  run_id: string;
  kind: string;
  attempt: number;
  status: string;
  role: string | null;
  exit_detail: string;
  commit_sha: string | null;
  cost_usd: number | null;
  turns: number | null;
  started_at: string | null;
  ended_at: string | null;
}

const RUN_COLUMNS = `id, display_id, type, status, current_step, last_completed_step, regression_count,
  failure_reason, branch, worktree_path, base_branch, base_commit, head_commit, merge_commit,
  budget_snapshot, model_snapshot, cost_usd, turns, tool_manifest, started_by, created_at, started_at,
  ended_at`;

const STEP_COLUMNS = `id, run_id, kind, attempt, status, role, exit_detail, commit_sha, cost_usd, turns,
  started_at, ended_at`;

/** 표시 ID는 접두가 같고 순번에 앞자리 0이 없으므로 길이 → 사전식 순서가 순번 순서다. */
const ORDER = 'ORDER BY length(display_id), display_id';

const toRunRow = (run: Run): RunRow => ({
  id: run.id,
  display_id: run.displayId,
  type: run.type,
  status: run.status,
  current_step: run.currentStep,
  last_completed_step: run.lastCompletedStep,
  regression_count: run.regressionCount,
  failure_reason: run.failureReason,
  branch: run.branch,
  worktree_path: run.worktreePath,
  base_branch: run.baseBranch,
  base_commit: run.baseCommit,
  head_commit: run.headCommit,
  merge_commit: run.mergeCommit,
  budget_snapshot: JSON.stringify(run.budgetSnapshot),
  model_snapshot: JSON.stringify(run.modelSnapshot),
  cost_usd: run.costUsd,
  turns: run.turns,
  tool_manifest: JSON.stringify(run.toolManifest),
  started_by: JSON.stringify(run.startedBy),
  created_at: run.createdAt,
  started_at: run.startedAt,
  ended_at: run.endedAt,
});

const toStepRow = (step: Step): StepRow => ({
  id: step.id,
  run_id: step.runId,
  kind: step.kind,
  attempt: step.attempt,
  status: step.status,
  role: step.role,
  // 종료 조건 결과가 없으면 JSON null로 둔다 (읽으면 `null`)
  exit_detail: JSON.stringify(step.exitDetail ?? null),
  commit_sha: step.commit,
  cost_usd: step.costUsd,
  turns: step.turns,
  started_at: step.startedAt,
  ended_at: step.endedAt,
});

const toStep = (row: StepRow): Step =>
  Step.parse({
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    attempt: row.attempt,
    status: row.status,
    role: row.role,
    exitDetail: JSON.parse(row.exit_detail) as unknown,
    commit: row.commit_sha,
    costUsd: row.cost_usd,
    turns: row.turns,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  });

const RUN_PATCH_KEYS = [
  'status',
  'currentStep',
  'lastCompletedStep',
  'regressionCount',
  'failureReason',
  'branch',
  'worktreePath',
  'baseCommit',
  'headCommit',
  'mergeCommit',
  'costUsd',
  'turns',
  'toolManifest',
  'startedAt',
  'endedAt',
] as const satisfies readonly (keyof RunPatch)[];

const STEP_PATCH_KEYS = [
  'status',
  'exitDetail',
  'commit',
  'costUsd',
  'turns',
  'startedAt',
  'endedAt',
] as const satisfies readonly (keyof StepPatch)[];

/** 바꿀 수 있는 키 중 값이 있는(`undefined`가 아닌) 것만 남긴다. 그 밖의 키(생성 정보 등)는 버린다. */
const pickDefined = <T extends object, K extends keyof T>(
  patch: T,
  keys: readonly K[],
): Partial<Pick<T, K>> => {
  const picked: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (patch[key] !== undefined) picked[key] = patch[key];
  }
  return picked;
};

const newStep = (runId: Ulid, input: StepCreateInput): Step =>
  Step.parse({
    id: input.id,
    runId,
    kind: input.kind,
    attempt: input.attempt,
    status: input.status,
    role: input.role,
    exitDetail: input.exitDetail ?? null,
    commit: input.commit ?? null,
    costUsd: input.costUsd ?? null,
    turns: input.turns ?? null,
    startedAt: input.startedAt,
    endedAt: input.endedAt ?? null,
  });

/** 단계 시도의 ID · (단계, 시도 번호)가 겹치지 않는지. 겹치면 `ConflictError` (DB 트리거보다 먼저 알린다). */
const assertDistinctSteps = (steps: readonly Step[]): void => {
  const ids = new Set<string>();
  const slots = new Set<string>();
  for (const step of steps) {
    const slot = `${step.kind}#${String(step.attempt)}`;
    if (ids.has(step.id) || slots.has(slot)) {
      throw new ConflictError(STEP_ENTITY, step.id, `같은 단계 시도가 이미 있습니다 (${slot})`);
    }
    ids.add(step.id);
    slots.add(slot);
  }
};

export class RunRepository {
  readonly #db: SqliteDatabase;
  readonly #projectId: Ulid;
  readonly #sequences: DisplayIdSequences;
  readonly #insertRun;
  readonly #updateRun;
  readonly #insertTarget;
  readonly #insertStep;
  readonly #updateStep;
  readonly #selectRun;
  readonly #selectRunByDisplayId;
  readonly #selectRuns;
  readonly #selectRunsByStatus;
  readonly #selectTargets;
  readonly #selectSteps;
  readonly #ruleState;

  constructor(
    db: SqliteDatabase,
    projectId: Ulid,
    sequences: DisplayIdSequences = new DisplayIdSequences(db),
  ) {
    this.#db = db;
    this.#projectId = projectId;
    this.#sequences = sequences;
    this.#insertRun = db.prepare<[RunRow]>(
      `INSERT INTO runs (${RUN_COLUMNS}) VALUES (@id, @display_id, @type, @status, @current_step,
       @last_completed_step, @regression_count, @failure_reason, @branch, @worktree_path, @base_branch,
       @base_commit, @head_commit, @merge_commit, @budget_snapshot, @model_snapshot, @cost_usd, @turns,
       @tool_manifest, @started_by, @created_at, @started_at, @ended_at)`,
    );
    // 생성 정보 열은 쓰지 않는다 (트리거도 막는다)
    this.#updateRun = db.prepare<[RunRow]>(
      `UPDATE runs SET status = @status, current_step = @current_step,
       last_completed_step = @last_completed_step, regression_count = @regression_count,
       failure_reason = @failure_reason, branch = @branch, worktree_path = @worktree_path,
       base_commit = @base_commit, head_commit = @head_commit, merge_commit = @merge_commit,
       cost_usd = @cost_usd, turns = @turns, tool_manifest = @tool_manifest, started_at = @started_at,
       ended_at = @ended_at
       WHERE id = @id`,
    );
    this.#insertTarget = db.prepare<[{ run_id: string; rule_id: string; position: number }]>(
      'INSERT INTO run_target_rules (run_id, rule_id, position) VALUES (@run_id, @rule_id, @position)',
    );
    this.#insertStep = db.prepare<[StepRow]>(
      `INSERT INTO steps (${STEP_COLUMNS}) VALUES (@id, @run_id, @kind, @attempt, @status, @role,
       @exit_detail, @commit_sha, @cost_usd, @turns, @started_at, @ended_at)`,
    );
    this.#updateStep = db.prepare<[StepRow]>(
      `UPDATE steps SET status = @status, exit_detail = @exit_detail, commit_sha = @commit_sha,
       cost_usd = @cost_usd, turns = @turns, started_at = @started_at, ended_at = @ended_at
       WHERE id = @id`,
    );
    this.#selectRun = db.prepare<[string], RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`);
    this.#selectRunByDisplayId = db.prepare<[string], RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE display_id = ?`,
    );
    this.#selectRuns = db.prepare<[], RunRow>(`SELECT ${RUN_COLUMNS} FROM runs ${ORDER}`);
    this.#selectRunsByStatus = db.prepare<[string], RunRow>(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE status = ? ${ORDER}`,
    );
    this.#selectTargets = db.prepare<[string], { rule_id: string }>(
      'SELECT rule_id FROM run_target_rules WHERE run_id = ? ORDER BY position',
    );
    this.#selectSteps = db.prepare<[string], StepRow>(
      `SELECT ${STEP_COLUMNS} FROM steps WHERE run_id = ?`,
    );
    this.#ruleState = db.prepare<[string], { deleted_at: string | null }>(
      'SELECT deleted_at FROM rules WHERE id = ?',
    );
  }

  /**
   * 실행 · 대상 규칙 · 첫 단계 시도들을 저장하고 표시 ID를 붙인다. 상태는 `waiting_approval`.
   * 호출한 쪽의 트랜잭션 안에서 부르면 승인 기록 추가 등과 함께 커밋되거나 함께 되돌려진다.
   * @throws {ZodError} 스키마 위반 (대상 규칙 0개 · 중복, 예산 스냅샷 미설정, 주체가 사람 아님 등)
   * @throws {NotFoundError} 대상 규칙이 없을 때
   * @throws {ConflictError} 대상 규칙이 삭제됐거나 같은 ID가 이미 있을 때 (순번은 소비하지 않는다)
   */
  create(input: RunCreateInput): RunDetail {
    return withTransaction(this.#db, () => {
      const base = {
        id: input.id,
        projectId: this.#projectId,
        type: input.type,
        targetRuleIds: input.targetRuleIds,
        status: 'waiting_approval',
        currentStep: input.currentStep,
        lastCompletedStep: null,
        regressionCount: 0,
        failureReason: null,
        branch: null,
        worktreePath: null,
        baseBranch: input.baseBranch,
        baseCommit: null,
        headCommit: null,
        mergeCommit: null,
        budgetSnapshot: input.budgetSnapshot,
        modelSnapshot: input.modelSnapshot,
        costUsd: null,
        turns: null,
        toolManifest: [],
        startedBy: input.startedBy,
        createdAt: input.createdAt,
        startedAt: null,
        endedAt: null,
      } as const;
      // 순번을 쓰기 전에 형식부터 검증한다
      Run.parse({ ...base, displayId: 'EXE-001' });
      const steps = input.steps.map((step) => newStep(input.id, step));
      assertDistinctSteps(steps);
      if (this.#selectRun.get(input.id) !== undefined) {
        throw new ConflictError(ENTITY, input.id, '이미 있습니다');
      }
      for (const ruleId of input.targetRuleIds) this.#assertLiveRule(ruleId);
      const run = Run.parse({ ...base, displayId: this.#sequences.nextDisplayId('EXE') });
      try {
        this.#insertRun.run(toRunRow(run));
        run.targetRuleIds.forEach((ruleId, position) =>
          this.#insertTarget.run({ run_id: run.id, rule_id: ruleId, position }),
        );
        for (const step of steps) this.#insertStep.run(toStepRow(step));
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(ENTITY, input.id, '이미 있습니다', { cause: error });
        }
        throw error;
      }
      return { run, steps: [...steps].sort(compareSteps) };
    });
  }

  /** ID로 찾는다. 없으면 `null`. */
  get(id: string): Run | null {
    const row = this.#selectRun.get(id);
    return row === undefined ? null : this.#toRun(row);
  }

  /** 표시 ID(`EXE-001`)로 찾는다. 없으면 `null`. */
  getByDisplayId(displayId: string): Run | null {
    const row = this.#selectRunByDisplayId.get(displayId);
    return row === undefined ? null : this.#toRun(row);
  }

  /** 실행과 단계 목록. 없으면 `null`. */
  getDetail(id: string): RunDetail | null {
    const run = this.get(id);
    return run === null ? null : { run, steps: this.steps(run.id) };
  }

  /** 표시 ID로 실행과 단계 목록. 없으면 `null`. */
  getDetailByDisplayId(displayId: string): RunDetail | null {
    const run = this.getByDisplayId(displayId);
    return run === null ? null : { run, steps: this.steps(run.id) };
  }

  /** 실행을 표시 ID 순(= 생성 순)으로. `status`를 주면 그 상태만. */
  list(filter: RunListFilter = {}): Run[] {
    const rows =
      filter.status === undefined
        ? this.#selectRuns.all()
        : this.#selectRunsByStatus.all(filter.status);
    return rows.map((row) => this.#toRun(row));
  }

  /** 실행의 단계 시도를 파이프라인 순서 → 시도 번호 순으로. */
  steps(runId: string): Step[] {
    return this.#selectSteps.all(runId).map(toStep).sort(compareSteps);
  }

  /**
   * 상태를 저장한다: 단계 갱신 · 새 시도 추가 · 실행 갱신을 트랜잭션 1회로 반영하고 결과를 돌려준다.
   * 하나라도 실패하면 아무것도 바뀌지 않는다.
   * @throws {NotFoundError} 실행 · 단계 시도가 없을 때
   * @throws {ConflictError} 기대 상태와 다름 · 종료된 실행 · 상태 기계에 없는 전이 · 끝난 단계 시도의 변경 ·
   *   다른 실행의 단계 · 같은 단계 시도의 중복
   * @throws {ZodError} 바뀐 실행 · 단계가 스키마 위반
   */
  transition(runId: string, change: RunTransition): RunDetail {
    return withTransaction(this.#db, () => {
      const current = this.get(runId);
      if (current === null) throw new NotFoundError(ENTITY, runId);
      if (change.expectedStatus !== undefined && current.status !== change.expectedStatus) {
        throw new ConflictError(
          ENTITY,
          current.displayId,
          `상태가 ${change.expectedStatus}가 아닙니다 (${current.status})`,
        );
      }
      if (isTerminalRunStatus(current.status)) {
        throw new ConflictError(ENTITY, current.displayId, `종료된 실행입니다 (${current.status})`);
      }
      const patch = pickDefined(change.run ?? {}, RUN_PATCH_KEYS);
      if (
        patch.status !== undefined &&
        patch.status !== current.status &&
        !canTransitionRun(current.status, patch.status)
      ) {
        throw new ConflictError(
          ENTITY,
          current.displayId,
          `상태 기계에 없는 전이입니다 (${current.status} → ${patch.status})`,
        );
      }
      const next = Run.parse({ ...current, ...patch });

      const existing = new Map(this.steps(runId).map((step) => [step.id, step]));
      const seen = new Set<string>();
      const updated = (change.steps ?? []).map((stepPatch) => {
        const step = existing.get(stepPatch.id);
        if (step === undefined) throw new NotFoundError(STEP_ENTITY, stepPatch.id);
        if (seen.has(step.id)) {
          throw new ConflictError(STEP_ENTITY, step.id, '같은 단계 시도를 두 번 바꿀 수 없습니다');
        }
        seen.add(step.id);
        if (isFinalStepStatus(step.status)) {
          throw new ConflictError(STEP_ENTITY, step.id, `끝난 단계 시도입니다 (${step.status})`);
        }
        return Step.parse({ ...step, ...pickDefined(stepPatch, STEP_PATCH_KEYS) });
      });
      const added = (change.addSteps ?? []).map((input) => newStep(runId, input));
      assertDistinctSteps([...existing.values(), ...added]);

      try {
        // 단계를 먼저 쓴다: 실행이 종료 상태가 되면 그 실행의 단계는 바꿀 수 없다 (트리거)
        for (const step of updated) this.#updateStep.run(toStepRow(step));
        for (const step of added) this.#insertStep.run(toStepRow(step));
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(STEP_ENTITY, runId, '같은 단계 시도가 이미 있습니다', {
            cause: error,
          });
        }
        throw error;
      }
      this.#updateRun.run(toRunRow(next));
      return { run: next, steps: this.steps(runId) };
    });
  }

  #toRun(row: RunRow): Run {
    return Run.parse({
      id: row.id,
      displayId: row.display_id,
      projectId: this.#projectId,
      type: row.type,
      targetRuleIds: this.#selectTargets.all(row.id).map((target) => target.rule_id),
      status: row.status,
      currentStep: row.current_step,
      lastCompletedStep: row.last_completed_step,
      regressionCount: row.regression_count,
      failureReason: row.failure_reason,
      branch: row.branch,
      worktreePath: row.worktree_path,
      baseBranch: row.base_branch,
      baseCommit: row.base_commit,
      headCommit: row.head_commit,
      mergeCommit: row.merge_commit,
      budgetSnapshot: JSON.parse(row.budget_snapshot) as unknown,
      modelSnapshot: JSON.parse(row.model_snapshot) as unknown,
      costUsd: row.cost_usd,
      turns: row.turns,
      toolManifest: JSON.parse(row.tool_manifest) as unknown,
      startedBy: JSON.parse(row.started_by) as unknown,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    });
  }

  #assertLiveRule(ruleId: string): void {
    const rule = this.#ruleState.get(ruleId);
    if (rule === undefined) throw new NotFoundError('대상 규칙', ruleId);
    if (rule.deleted_at !== null) {
      throw new ConflictError('대상 규칙', ruleId, `삭제됐습니다 (${rule.deleted_at})`);
    }
  }
}
