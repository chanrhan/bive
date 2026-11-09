// 파이프라인 엔진의 단계 실행기 계약 (RUN-01 · RUN-02 · RUN-08, ADR-026 · ADR-061 · ADR-066).
// 엔진은 상태 기계 · 단계 진행 · 회귀 · 중단 · 재개 · 세션 실행 틀을 맡고, 단계별 종료 조건 판단은 주입받은
// 단계 실행기(단계 종류 → 함수)가 맡는다: 테스트 작성 · Red 확인(#28), 구현 · 검사 · 병합(#29), 화면 갱신(#32).
// 실행기는 상태를 직접 저장하지 않고 결과(`StepOutcome`)만 돌려준다. 저장은 엔진이 단계 종료마다 트랜잭션 1회로 한다.
import type { AgentRole, Project, Run, RunStatus, Step, StepKind, Ulid } from '@bive/shared';
import type { ProjectStore, RunDetail, RunPatch } from '@bive/store';

import type { SessionResultEvent } from '../agent/adapter.js';
import type { RunGitRef, WorktreeManager } from '../git/worktree-manager.js';
import type { CommandContext } from '../tools/commands.js';
import type { RoleToolsHooks } from '../tools/executor.js';

/** 엔진이 실행기를 부르는 단계 (승인 단계는 엔진이 `evaluateApprovalStep`으로 판정한다). */
export type EngineStepKind = Exclude<StepKind, 'approval'>;

/**
 * 오케스트레이터가 단계 종료 커밋을 만드는 단계 (architecture.md 4장: 2 · 4단계). 실행기가 `passed`를 돌려주면
 * 엔진이 실행 워크트리의 변경을 `WorktreeManager.commit`으로 커밋하고 단계 · 실행(`headCommit`)에 저장한다.
 */
export const COMMIT_STEP_KINDS: readonly StepKind[] = ['test_writing', 'implementation'];

/** 테스트 작성 · Red 확인 재시도 상한 (ADR-026: 2회, 초과 시 `failed`). */
export const MAX_TEST_RETRY_COUNT = 2;

/**
 * 종료 조건 미충족(`unmet`) 때 돌아갈 단계와 세는 수 (RUN-02, ADR-026). 없는 단계의 미충족은 실행 `failed`.
 * - 테스트 작성 미충족 → 새 세션으로 재시도, Red 미충족 → 테스트 작성으로 회귀 (테스트 재시도 수, 상한 2)
 * - 구현 미충족 → 구현 재시도, 검사 미충족 → 구현으로 회귀 (`regressionCount`, 상한 2)
 */
export const UNMET_POLICY: Partial<
  Record<EngineStepKind, { readonly to: StepKind; readonly counter: 'test_retry' | 'regression' }>
> = {
  test_writing: { to: 'test_writing', counter: 'test_retry' },
  red_check: { to: 'test_writing', counter: 'test_retry' },
  implementation: { to: 'implementation', counter: 'regression' },
  check: { to: 'implementation', counter: 'regression' },
};

/**
 * 실행 실패 · 예산 초과 사유 (`Run.failureReason`). 단계 실행기는 그 밖의 사유(예: 병합 실패 사유 ADR-058)를 쓸 수 있다.
 */
export const ENGINE_FAILURE_REASONS = [
  /** 세션 init의 도구 · MCP 서버 · 플러그인 · 권한 모드가 허용 목록과 다름 (NFR-02) */
  'guard_violation',
  /** 검사 실패 → 구현 회귀가 상한(2회)을 넘음 (RUN-02) */
  'regression_limit',
  /** 테스트 작성 · Red 확인 재시도가 상한(2회)을 넘음 (ADR-026) */
  'test_retry_limit',
  /** 회귀 규칙이 없는 단계의 종료 조건 미충족 */
  'step_unmet',
  /** 그 단계의 실행기가 주입되지 않음 */
  'step_executor_missing',
  /** 단계 실행기가 예상하지 못한 예외를 던짐 */
  'step_error',
  /** 실행 워크트리 생성 · 되돌리기 · 단계 커밋 실패 */
  'worktree_error',
  /** 실행에 대응하는 승인 기록 `run_start`가 없거나 대상 규칙이 다름 (NFR-01) */
  'run_without_log',
  /** 실행이 쓰는 역할의 모델 · 예산 스냅샷이 없음 */
  'settings_missing',
  /** 마지막 단계까지 끝났는데 병합 커밋이 없음 */
  'merge_missing',
  /** 저장된 상태가 엔진 규칙과 맞지 않음 (진행 중인데 현재 단계 · 진행 중 시도 없음) */
  'state_inconsistent',
  /** 세션을 열기 전 남은 예산이 0 이하 (COST-01, `budget_exceeded`) */
  'budget_exhausted',
  /** 세션 결과 subtype (`budget_exceeded`) */
  'error_max_budget_usd',
  'error_max_turns',
  /** 세션이 끝난 뒤 역할 · 실행 사용량 합계가 한도를 넘음 (COST-01, `budget_exceeded`, ADR-067) */
  'budget_aggregate_exceeded',
] as const;
export type EngineFailureReason = (typeof ENGINE_FAILURE_REASONS)[number];

/** 실행을 끝내는 상태 (`halt`). */
export type HaltStatus = Extract<RunStatus, 'failed' | 'budget_exceeded'>;

/** 단계 실행기가 함께 저장할 실행 필드 (진행 상태 · 회귀 수 · 시각은 엔진만, 비용 · 턴은 저장소가 세션 기록에서). */
export type StepRunPatch = Pick<RunPatch, 'mergeCommit' | 'headCommit'>;

/**
 * 단계 실행 결과.
 * - `passed`: 종료 조건 충족 → (커밋 단계면 엔진이 커밋) 다음 단계
 * - `skipped`: 이 실행에서 하지 않는 단계 (M1의 변이 주입) → 다음 단계
 * - `unmet`: 종료 조건 미충족 → `UNMET_POLICY`대로 재시도 · 회귀, 상한을 넘거나 규칙이 없으면 실행 `failed`
 * - `halt`: 실행을 끝낸다 (`failed` · `budget_exceeded`, 예: 병합 충돌 · 가드 위반). 브랜치 · 워크트리는 보존한다
 */
export type StepOutcome =
  | { readonly status: 'passed'; readonly exitDetail?: unknown; readonly run?: StepRunPatch }
  | { readonly status: 'skipped'; readonly exitDetail?: unknown }
  | { readonly status: 'unmet'; readonly exitDetail?: unknown }
  | {
      readonly status: 'halt';
      readonly runStatus: HaltStatus;
      readonly reason: string;
      readonly exitDetail?: unknown;
    };

/** 단계 세션 요청 (`StepContext.runSession`). 역할 · 모델 · 한도는 단계와 실행 스냅샷으로 엔진이 정한다. */
export interface StepSessionRequest {
  /** 세션 루트(작업 폴더): implementer = 실행 워크트리, test-writer = 세션 폴더 (ADR-024) */
  readonly workDir: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  /** 시나리오 자리표시자 (ScriptedAdapter, 예: `ruleId`) */
  readonly vars?: Readonly<Record<string, string>>;
  /** 명령 도구 설정 (`toolchainRoot` · `env` · `installAllowlist`) */
  readonly commands?: Omit<CommandContext, 'cwd' | 'guard'>;
  /** 제안 도구 훅 (도구 호출 기록은 엔진이 저장한다) */
  readonly hooks?: Pick<RoleToolsHooks, 'proposeRule'>;
}

/** 단계 세션 결과. 가드 위반 · 예산 초과는 엔진이 실행을 끝내므로 여기로 오지 않는다. */
export interface StepSessionResult {
  /** 저장된 세션 ID (`sessions.id`) */
  readonly sessionId: Ulid;
  readonly role: AgentRole;
  /** `success` 또는 `error_during_execution` (결과 없음 · 어댑터 오류 · 시작 실패 포함) */
  readonly endReason: 'success' | 'error_during_execution';
  readonly result: SessionResultEvent | null;
  /** 결과 없이 끝난 사유 문장 */
  readonly detail: string | null;
}

/** 단계 실행기에 넘기는 문맥. 실행 · 단계는 단계 시작 시점의 값이다. */
export interface StepContext {
  readonly biveHome: string;
  readonly project: Project;
  readonly run: Run;
  /** 진행 중인 단계 시도 */
  readonly step: Step;
  readonly steps: readonly Step[];
  /** 실행 브랜치 · 워크트리 (승인 단계 뒤 엔진이 만든다, ADR-058) */
  readonly git: RunGitRef;
  readonly worktrees: WorktreeManager;
  /** 오케스트레이터 종료 · 실행 중단 신호. 중단되면 실행기는 빨리 끝나야 하고 엔진은 아무것도 저장하지 않는다 */
  readonly signal: AbortSignal;
  /** 프로젝트 저장소를 열어 읽고 닫는다 (규칙 · 판정 기록 조회 등) */
  read<T>(fn: (store: ProjectStore) => T): T;
  /** 이 단계 역할의 에이전트 세션을 연다 (세션 가드 · 예산 · 도구 호출 기록 · 세션 순번은 엔진이 맡는다) */
  runSession(request: StepSessionRequest): Promise<StepSessionResult>;
  /** 화면 갱신 알림 (`EngineEvent`의 `notify`, #32가 `event.*` 알림으로 잇는다) */
  notify(topic: string, data?: unknown): void;
}

export type StepExecutor = (context: StepContext) => Promise<StepOutcome>;
export type StepExecutors = Partial<Record<EngineStepKind, StepExecutor>>;

/** 엔진 이벤트 (#32가 `event.run.updated` · `event.step.updated` 알림으로 잇는다). */
export type EngineEvent =
  | { readonly type: 'run.saved'; readonly projectId: Ulid; readonly detail: RunDetail }
  | {
      readonly type: 'notify';
      readonly projectId: Ulid;
      readonly runId: Ulid;
      readonly topic: string;
      readonly data?: unknown;
    };
