// 도메인 열거형 (docs/architecture.md 3장 · 4장, docs/spec/plan.md 3.4).
// 저장 · 전송 값은 영어 식별자, 화면 표시명은 *_LABELS 상수 맵에서만 가져온다.
import { z } from 'zod';

/** 판정 상태 5종 (JDG-01, JDG-02, 기획서 3.4). */
export const JudgmentStatus = z.enum(['pass', 'fail', 'unjudged', 'quarantined', 'needs_recheck']);
export type JudgmentStatus = z.infer<typeof JudgmentStatus>;
export const JUDGMENT_STATUS_LABELS = {
  pass: '통과',
  fail: '실패',
  unjudged: '미판정',
  quarantined: '격리',
  needs_recheck: '재검증 필요',
} as const satisfies Record<JudgmentStatus, string>;

/** 변이 상태 3종 (JDG-04, 기획서 3.4). */
export const MutationStatus = z.enum(['verified', 'unverified', 'survived']);
export type MutationStatus = z.infer<typeof MutationStatus>;
export const MUTATION_STATUS_LABELS = {
  verified: '변이 검증됨',
  unverified: '변이 미검증',
  survived: '변이 생존',
} as const satisfies Record<MutationStatus, string>;

/**
 * 실행 상태 7종 (architecture.md 4장 상태 기계, RUN-01). `queued`(실행 대기)는 승인 단계를 통과했지만 프로젝트에 진행 중 ·
 * 중단된 실행이나 먼저 기다리는 실행이 있어 시작을 기다리는 상태다(프로젝트당 동시 실행 1개, ADR-100 B⑥ · ADR-105).
 */
export const RunStatus = z.enum([
  'waiting_approval',
  'queued',
  'running',
  'merged',
  'failed',
  'budget_exceeded',
  'interrupted',
]);
export type RunStatus = z.infer<typeof RunStatus>;
export const RUN_STATUS_LABELS = {
  waiting_approval: '승인 대기',
  queued: '실행 대기',
  running: '진행 중',
  merged: '병합 완료',
  failed: '실패',
  budget_exceeded: '예산 초과',
  interrupted: '중단',
} as const satisfies Record<RunStatus, string>;

/** 더 이상 전이하지 않는 실행 상태 (architecture.md 4장). */
export const TERMINAL_RUN_STATUSES = [
  'merged',
  'failed',
  'budget_exceeded',
] as const satisfies readonly RunStatus[];

/**
 * 실행 상태 전이 (architecture.md 4장 상태 기계, ADR-061). 키 상태에서 갈 수 있는 상태 목록이고,
 * 종료 상태는 빈 목록이다. 생성 직후 상태는 항상 `waiting_approval`(실행 시작 확인 → 승인 단계). 승인 단계를 통과할 때
 * 프로젝트에 자리가 없으면 `queued`, 자리가 나면 생성 순으로 `running`이다. 시작 때 대상 규칙을 다시 보아 효력이 없으면
 * `failed`(ADR-105). 실행 대기에 선 자동 시작 실행이 시작할 차례에 하루 한도 문에 걸리면 `failed`(한도 비움 · 설정 미비) 또는
 * `budget_exceeded`(오늘 지출이 한도에 이름, ADR-111). 승인 단계는 사람을 기다리지 않는다: 대상 규칙이 하나라도 효력이 없으면 그 자리에서 `failed`(ADR-107).
 * 중단된 실행은 사람의 재개가 복구 불가 사유로 실패하면 그 자리에서 끝난다: 병합 커밋이 기록됐으면 `merged`, 아니면 `failed`(`runEnding`, ADR-105).
 */
export const RUN_STATUS_TRANSITIONS = {
  waiting_approval: ['running', 'queued', 'failed'],
  queued: ['running', 'failed', 'budget_exceeded'],
  running: ['merged', 'failed', 'budget_exceeded', 'interrupted'],
  interrupted: ['running', 'failed', 'merged'],
  merged: [],
  failed: [],
  budget_exceeded: [],
} as const satisfies Record<RunStatus, readonly RunStatus[]>;

/** 종료 상태인지 (`merged` · `failed` · `budget_exceeded`). */
export const isTerminalRunStatus = (status: RunStatus): boolean =>
  (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);

/** `from` → `to` 전이가 상태 기계에 있는지. 같은 상태는 전이가 아니므로 `false`. */
export const canTransitionRun = (from: RunStatus, to: RunStatus): boolean =>
  (RUN_STATUS_TRANSITIONS[from] as readonly RunStatus[]).includes(to);

/** 실행 유형 A~D (RUN-07). M1은 A만. */
export const RunType = z.enum(['A', 'B', 'C', 'D']);
export type RunType = z.infer<typeof RunType>;
export const RUN_TYPE_LABELS = {
  A: '신규 동작',
  B: '정적 검사',
  C: '코드 유지 · 테스트만',
  D: '리팩터링 · 되돌리기',
} as const satisfies Record<RunType, string>;

/** 생성 주체 2종 (NRM-01, NFR-03, ADR-008). */
export const AuthorKind = z.enum(['human', 'agent']);
export type AuthorKind = z.infer<typeof AuthorKind>;
export const AUTHOR_KIND_LABELS = {
  human: '사람',
  agent: '에이전트',
} as const satisfies Record<AuthorKind, string>;

/** 에이전트 역할 (ADR-009). */
export const AgentRole = z.enum(['rule-writer', 'planner', 'test-writer', 'implementer', 'chat']);
export type AgentRole = z.infer<typeof AgentRole>;
export const AGENT_ROLE_LABELS = {
  'rule-writer': '규칙 작성',
  planner: '계획',
  'test-writer': '테스트 작성',
  implementer: '구현',
  chat: '채팅',
} as const satisfies Record<AgentRole, string>;

/** 실행 단계 이름 (architecture.md 3장 Step.kind, 4장 단계표). */
export const StepKind = z.enum([
  'approval',
  'test_writing',
  'red_check',
  'green_check',
  'implementation',
  'check',
  'mutation',
  'merge',
  'screen_update',
]);
export type StepKind = z.infer<typeof StepKind>;
export const STEP_KIND_LABELS = {
  approval: '승인',
  test_writing: '테스트 작성',
  red_check: 'Red 확인',
  green_check: 'Green 확인',
  implementation: '구현',
  check: '검사',
  mutation: '변이 주입',
  merge: '병합',
  screen_update: '화면 갱신',
} as const satisfies Record<StepKind, string>;

/** 단계 상태 (RUN-02, SCR-16). */
export const StepStatus = z.enum(['pending', 'running', 'passed', 'failed', 'skipped']);
export type StepStatus = z.infer<typeof StepStatus>;

/** 끝난 단계 상태. 끝난 단계 행은 다시 바뀌지 않고, 다시 하면 새 시도(`attempt`) 행을 만든다 (ADR-061). */
export const FINAL_STEP_STATUSES = [
  'passed',
  'failed',
  'skipped',
] as const satisfies readonly StepStatus[];

/** 끝난 단계 상태인지. */
export const isFinalStepStatus = (status: StepStatus): boolean =>
  (FINAL_STEP_STATUSES as readonly StepStatus[]).includes(status);
export const STEP_STATUS_LABELS = {
  pending: '대기',
  running: '진행 중',
  passed: '통과',
  failed: '실패',
  skipped: '생략',
} as const satisfies Record<StepStatus, string>;

/** 규범 상태 (NRM-04, NRM-05, ADR-012). 승인 전 제안은 규범이 아니므로 값이 없다. */
export const NormState = z.enum(['approved', 'provisional']);
export type NormState = z.infer<typeof NormState>;
export const NORM_STATE_LABELS = {
  approved: '승인',
  provisional: '잠정 승인',
} as const satisfies Record<NormState, string>;

/** 제안 상태 (NRM-04, NRM-05). */
export const ProposalState = z.enum(['pending', 'approved', 'rejected', 'provisional']);
export type ProposalState = z.infer<typeof ProposalState>;
export const PROPOSAL_STATE_LABELS = {
  pending: '승인 대기',
  approved: '승인',
  rejected: '거절',
  provisional: '잠정 승인',
} as const satisfies Record<ProposalState, string>;

/** 제안 종류 (TODO-01, TODO-03, SCR-17). */
export const ProposalKind = z.enum([
  'requirement_new',
  'requirement_change',
  'rule_new',
  'rule_change',
  'contract_new',
  'design_change',
  'rule_title_change',
  'contract_change',
]);
export type ProposalKind = z.infer<typeof ProposalKind>;
export const PROPOSAL_KIND_LABELS = {
  requirement_new: '요구사항 신규',
  requirement_change: '요구사항 변경',
  rule_new: '규칙 신규',
  rule_change: '규칙 변경',
  contract_new: '계약 신규',
  design_change: '설계 변경',
  rule_title_change: '규칙 제목 변경',
  contract_change: '계약 변경',
} as const satisfies Record<ProposalKind, string>;

/** 제안 출처 (SCR-17, PRJ-03). */
export const ProposalSource = z.enum([
  'rule_generation',
  'chat',
  'reverse_extraction',
  'writing_rules',
  'implementation',
]);
export type ProposalSource = z.infer<typeof ProposalSource>;
export const PROPOSAL_SOURCE_LABELS = {
  rule_generation: '규칙 자동 생성',
  chat: '채팅 지시',
  reverse_extraction: '역추출',
  writing_rules: '작성 규칙',
  implementation: '구현',
} as const satisfies Record<ProposalSource, string>;

/** 규칙 종류 (NRM-02, 기획서 3.1). */
export const RuleKind = z.enum(['architecture', 'tech-constraint', 'business']);
export type RuleKind = z.infer<typeof RuleKind>;
export const RULE_KIND_LABELS = {
  architecture: '아키텍처',
  'tech-constraint': '기술 제약',
  business: '비즈니스',
} as const satisfies Record<RuleKind, string>;

/** 규칙에 붙는 검사 종류 (NRM-02, 기획서 4.2). */
export const CheckKind = z.enum(['test', 'pbt', 'contract', 'static', 'structure']);
export type CheckKind = z.infer<typeof CheckKind>;
export const CHECK_KIND_LABELS = {
  test: '인수 테스트',
  pbt: '속성 기반 테스트',
  contract: '계약 검사',
  static: '정적 분석',
  structure: '구조 검사',
} as const satisfies Record<CheckKind, string>;

/** 위험도 (NRM-09, P1). */
export const Risk = z.enum(['low', 'medium', 'high']);
export type Risk = z.infer<typeof Risk>;
export const RISK_LABELS = {
  low: '낮음',
  medium: '보통',
  high: '높음',
} as const satisfies Record<Risk, string>;

/**
 * 에이전트 세션 종료 사유 (기획서 4.5, COST-01). `objection_raised`는 구현 역할이 이의 제기 도구를 불러 오케스트레이터가 그
 * 세션을 끝냈음이다(M7-11 #223, ADR-100 D4, ADR-115).
 */
export const SessionEndReason = z.enum([
  'success',
  'error_max_turns',
  'error_max_budget_usd',
  'error_during_execution',
  'aborted',
  'guard_violation',
  'objection_raised',
]);
export type SessionEndReason = z.infer<typeof SessionEndReason>;
export const SESSION_END_REASON_LABELS = {
  success: '정상 종료',
  error_max_turns: '턴 한도 초과',
  error_max_budget_usd: '예산 한도 초과',
  error_during_execution: '실행 중 오류',
  aborted: '중단',
  guard_violation: '가드 위반',
  objection_raised: '이의 제기',
} as const satisfies Record<SessionEndReason, string>;

/**
 * 규칙 작성 세션을 띄우지 않은 이유 중 저장하는 것 (NRM-02, M3-26, ADR-062 · ADR-099). 중복(이미 세션 · 제안이 있음)은
 * 앞선 시도의 기록이 따로 있으므로 저장하지 않는다.
 */
export const RuleWriterSkipReason = z.enum([
  /** 설정의 rule-writer 모델 · 한도 또는 실행 전체 한도가 비어 있음 (NFR-07) */
  'settings_incomplete',
  /** 오케스트레이터가 종료 중이었거나 비정상 종료로 대기 중인 세션이 사라짐 */
  'closed',
  /** 시작 준비 중 예상하지 못한 오류 */
  'start_failed',
  /** 대기하는 사이 요구사항이 삭제됐거나 읽을 수 없게 됨 */
  'requirement_unavailable',
  /** 프로젝트의 오늘(기기의 로컬 날짜) 지출이 하루 예산 한도에 이름 (COST-01, ADR-100 B⑤ · A12, ADR-104) */
  'project_daily_budget_exceeded',
]);
export type RuleWriterSkipReason = z.infer<typeof RuleWriterSkipReason>;
export const RULE_WRITER_SKIP_REASON_LABELS = {
  settings_incomplete: '예산 · 모델 미설정',
  closed: '오케스트레이터 종료',
  start_failed: '시작 실패',
  requirement_unavailable: '요구사항 없음',
  project_daily_budget_exceeded: '프로젝트 하루 예산 초과',
} as const satisfies Record<RuleWriterSkipReason, string>;

/**
 * 실행 자동 시작을 하지 않은 이유 (M7-05 #217, ADR-100 B⑤ · A12, ADR-107). 규칙 작성 세션이 규칙을 만들고 정상 종료했는데
 * 실행을 만들지 않았을 때만 남는다.
 */
export const AutoStartSkipReason = z.enum([
  /** 프로젝트 하루 예산 한도가 비어 있음 (B⑤: 비어 있으면 자동 시작을 하지 않는다) */
  'project_daily_budget_unset',
  /** 프로젝트의 오늘 지출이 하루 예산 한도에 이름 (A12) */
  'project_daily_budget_exceeded',
  /** 실행이 쓰는 역할의 예산 · 모델 또는 실행 전체 한도가 비어 있음 (NFR-07) */
  'settings_incomplete',
]);
export type AutoStartSkipReason = z.infer<typeof AutoStartSkipReason>;
export const AUTO_START_SKIP_REASON_LABELS = {
  project_daily_budget_unset: '프로젝트 하루 한도 없음',
  project_daily_budget_exceeded: '프로젝트 하루 예산 초과',
  settings_incomplete: '예산 · 모델 미설정',
} as const satisfies Record<AutoStartSkipReason, string>;

/**
 * 실행 종료 사유 (`Run.failureReason`의 값, M3-35 #263, ADR-123): 오케스트레이터가 실행을 실패 · 예산 초과로 끝낼 때 남기는
 * 값 전부. 엔진 사유(`engine/types.ts` `ENGINE_FAILURE_REASONS`), 단계 실행기 사유(대상 규칙 폐기 · 효력 없음, 판정 실행기 오류,
 * 의존성 설치 실패, 인수 테스트 무시 규칙), 병합 실패 사유(`git/worktree-manager.ts` `MergeFailureReason`), 실행 대기 시작의
 * 하루 한도 문 사유(`AutoStartSkipReason`)를 모은다. 저장 스키마(`Run.failureReason`)는 옛 행 때문에 넓은 글 그대로이고, 이 목록은
 * 화면 표시명의 키다. 오케스트레이터 소스와 같은 집합인지는 앱 시험(`app/test/run-history-view.test.ts`)이 대조한다.
 */
export const RunFailureReason = z.enum([
  'guard_violation',
  'regression_limit',
  'test_retry_limit',
  'step_unmet',
  'step_executor_missing',
  'step_error',
  'worktree_error',
  'run_without_log',
  'settings_missing',
  'merge_missing',
  'state_inconsistent',
  'budget_exhausted',
  'project_daily_budget_exceeded',
  'error_max_budget_usd',
  'error_max_turns',
  'budget_aggregate_exceeded',
  'objection_applied',
  'existing_rule_contradiction',
  'target_rule_retired',
  'target_rule_unavailable',
  'judge_runner_error',
  'block_declaration_overlap',
  'dependency_install_failed',
  'acceptance_ignored',
  'project_daily_budget_unset',
  'settings_incomplete',
  'branch_missing',
  'run_worktree_dirty',
  'project_dirty',
  'base_branch_missing',
  'base_checked_out_elsewhere',
  'no_changes',
  'conflict',
  'ignored_path_tracked',
  'unchecked_tree_mismatch',
  'check_failed',
  'check_error',
  'check_timeout',
  'aborted',
  'base_changed',
  'vetoed',
  'base_update_failed',
  'git_error',
]);
export type RunFailureReason = z.infer<typeof RunFailureReason>;
/** 실행 종료 사유 표시명 (screens.md 1.1 명사형, 문서 기호 없음). 표에 없는 옛 값은 화면이 "알 수 없는 사유"로 보인다. */
export const RUN_FAILURE_REASON_LABELS = {
  guard_violation: '가드 위반',
  regression_limit: '회귀 상한 초과',
  test_retry_limit: '테스트 작성 재시도 상한 초과',
  step_unmet: '단계 종료 조건 미충족',
  step_executor_missing: '단계 실행기 없음',
  step_error: '단계 실행 오류',
  worktree_error: '작업 트리 오류',
  run_without_log: '실행 시작 기록 없음',
  settings_missing: '예산 · 모델 기록 없음',
  merge_missing: '병합 커밋 없음',
  state_inconsistent: '실행 상태 불일치',
  budget_exhausted: '실행 예산 소진',
  project_daily_budget_exceeded: '프로젝트 하루 예산 초과',
  error_max_budget_usd: '세션 예산 한도 초과',
  error_max_turns: '세션 턴 한도 초과',
  budget_aggregate_exceeded: '사용량 합계 한도 초과',
  objection_applied: '이의 반영',
  existing_rule_contradiction: '기존 규칙 모순',
  target_rule_retired: '대상 규칙 폐기',
  target_rule_unavailable: '대상 규칙 효력 없음',
  judge_runner_error: '판정 실행기 오류',
  block_declaration_overlap: '블록 선언 겹침',
  dependency_install_failed: '의존성 설치 실패',
  acceptance_ignored: '인수 테스트 무시 규칙 걸림',
  project_daily_budget_unset: '프로젝트 하루 한도 없음',
  settings_incomplete: '예산 · 모델 미설정',
  branch_missing: '실행 브랜치 없음',
  run_worktree_dirty: '실행 작업 트리 미커밋 변경',
  project_dirty: '프로젝트 폴더 미커밋 변경',
  base_branch_missing: '기준 브랜치 없음',
  base_checked_out_elsewhere: '기준 브랜치 다른 작업 트리 사용 중',
  no_changes: '병합할 변경 없음',
  conflict: '병합 충돌',
  ignored_path_tracked: '무시 규칙 경로 추적',
  unchecked_tree_mismatch: '병합 트리 불일치',
  check_failed: '병합 재검사 실패',
  check_error: '병합 재검사 오류',
  check_timeout: '병합 재검사 시간 초과',
  aborted: '병합 중단',
  base_changed: '병합 중 기준 브랜치 변경',
  vetoed: '병합 직전 거부',
  base_update_failed: '기준 브랜치 갱신 실패',
  git_error: 'git 오류',
} as const satisfies Record<RunFailureReason, string>;

/** 규칙 작성 시도 하나의 상태: 대기 · 진행 중 · 끝남(종료 사유는 세션 기록) · 생략. */
export const RuleWriterState = z.enum(['queued', 'running', 'ended', 'skipped']);
export type RuleWriterState = z.infer<typeof RuleWriterState>;

/**
 * 판정 실행기 (JDG-01). 인수 테스트는 vitest, 내장 구조 규칙(구조 검사, JDG-05)은 dependency-cruiser(파서, M3-03 #48 · ADR-127).
 * 넓히기만 한다(옛 판정 기록 행이 있다).
 */
export const JudgeRunner = z.enum(['vitest', 'dependency-cruiser']);
export type JudgeRunner = z.infer<typeof JudgeRunner>;

/** 판정 결과의 테스트 케이스 상태 (vitest JSON 리포터의 assertion status). */
export const TestCaseStatus = z.enum([
  'passed',
  'failed',
  'skipped',
  'pending',
  'todo',
  'disabled',
]);
export type TestCaseStatus = z.infer<typeof TestCaseStatus>;

/** 잠정 승인 정책 (ADR-012 기본 off, ADR-031 위험도 기준). */
export const ProvisionalPolicy = z.enum(['off', 'risk_based']);
export type ProvisionalPolicy = z.infer<typeof ProvisionalPolicy>;
export const PROVISIONAL_POLICY_LABELS = {
  off: '사용 안 함',
  risk_based: '위험도 기준',
} as const satisfies Record<ProvisionalPolicy, string>;

// 아래는 P1 이후 엔터티의 열거형. 엔터티 스키마는 아직 없고 값만 고정한다.

/** 계약 종류 (NRM-03, SCR-04). */
export const ContractKind = z.enum([
  'openapi',
  'db-schema',
  'asyncapi',
  'external-api',
  'cache',
  'json-schema',
]);
export type ContractKind = z.infer<typeof ContractKind>;

/** 블록 종류 (기획서 3.3). */
export const BlockKind = z.enum(['domain', 'shared']);
export type BlockKind = z.infer<typeof BlockKind>;

/** ADR 상태 (SCR-15, DSN-07). */
export const AdrStatus = z.enum(['proposed', 'accepted']);
export type AdrStatus = z.infer<typeof AdrStatus>;

/**
 * 승인 기록 행동 (NFR-01, ADR-031의 provisional_grant 포함). 승인 기록은 사람 행동만 담는다 (ADR-100 C2).
 * 사후 확인 전환(ADR-100 A2)으로 사람의 확인(`confirm`, M7-01) · 규칙 직접 편집(`rule_edit`, M7-03) ·
 * 계약 직접 편집(`contract_edit`, M3-10)이 더해졌다. 편집 두 값은 그 이슈가 쓴다 (M7-01은 DB CHECK와 값만 연다)
 */
export const ApprovalAction = z.enum([
  'approve',
  'approve_edited',
  'reject',
  'run_start',
  'provisional_grant',
  'confirm',
  'rule_edit',
  'contract_edit',
]);
export type ApprovalAction = z.infer<typeof ApprovalAction>;

/**
 * 규범 변경 기록의 종류 (ADR-100 C2 · A2, NRM-07, M7-02 #214, ADR-103). 에이전트 · 오케스트레이터 행동 1건이 1항목이다
 * (사람 행동은 승인 기록). 대상 규범의 엔터티는 항목의 `targetRef`가 정한다(규칙 신규 = `created` + 규칙 대상).
 * M7-02가 쓰는 값은 `created`뿐이고, 나머지는 뒤 이슈가 쓴다: 수정(`updated`, 제목 재생성 등) · 폐기(`retired`) ·
 * 대체(`superseded`, M7-09) · 규범 담당 역할의 판단(`judgment`, M7-07 · M7-11 · M7-12) · 구현 역할의 이의(`objection`,
 * M7-11) · 확인 풀림(`unconfirmed`, M7-13) · 실행 자동 시작(`auto_start`, M7-05) · 테스트 변경 알림(`test_changed`, M7-13).
 * 값을 미리 연 것은 DB CHECK를 뒤 이슈마다 표 재구성으로 넓히지 않기 위해서다(0012의 승인 기록 행동과 같은 방식)
 */
export const NormChangeKind = z.enum([
  'created',
  'updated',
  'retired',
  'superseded',
  'judgment',
  'objection',
  'unconfirmed',
  'auto_start',
  'test_changed',
]);
export type NormChangeKind = z.infer<typeof NormChangeKind>;
export const NORM_CHANGE_KIND_LABELS = {
  created: '신규',
  updated: '수정',
  retired: '폐기',
  superseded: '대체',
  judgment: '판단',
  objection: '이의',
  unconfirmed: '확인 풀림',
  auto_start: '자동 시작',
  test_changed: '테스트 변경',
} as const satisfies Record<NormChangeKind, string>;

/**
 * 확인 상태 (ADR-100 D2 · C1, M7-01): 규범 항목마다 "사람이 보고 OK했는가". 두 값뿐이고 기본은 미확인이다.
 * 사람만 확인됨으로 바꾸며(I1) 실행 생성 · 단계 진행 · 판정 · 병합의 어느 조건에도 쓰이지 않는다.
 */
export const ConfirmationState = z.enum(['unconfirmed', 'confirmed']);
export type ConfirmationState = z.infer<typeof ConfirmationState>;
export const CONFIRMATION_STATE_LABELS = {
  unconfirmed: '미확인',
  confirmed: '확인됨',
} as const satisfies Record<ConfirmationState, string>;

/**
 * 확인할 것 목록(`confirmation.list`)의 항목 종류 (M7-13 #225, ADR-100 D3 · B⑦ · G · A7, ADR-113).
 * - `retired` · `superseded`: 에이전트의 폐기 · 대체 (확인 여부와 무관하게 맨 위). 사람이 확인한 규칙이었으면 확인 풀림을
 *   같은 항목에 싣는다(확인 풀림을 따로 세우지 않는다: 지금 확인 풀림의 원인은 폐기 · 대체뿐이다)
 * - `test_changed`: 확인됨 규칙의 기존 인수 테스트를 실행이 바꿔 병합함 (확인은 그대로, 알림만)
 * - `unconfirmed_norm`: 미확인 요구사항 · 규칙
 */
export const ConfirmationItemKind = z.enum([
  'retired',
  'superseded',
  'test_changed',
  'unconfirmed_norm',
]);
export type ConfirmationItemKind = z.infer<typeof ConfirmationItemKind>;
export const CONFIRMATION_ITEM_KIND_LABELS = {
  retired: '폐기',
  superseded: '대체',
  test_changed: '테스트 변경',
  unconfirmed_norm: '미확인',
} as const satisfies Record<ConfirmationItemKind, string>;

/** 코드 열기 사유 (MET-01). */
export const CodeOpenReason = z.enum(['screen_error', 'info_lacking', 'debugging']);
export type CodeOpenReason = z.infer<typeof CodeOpenReason>;

/** 코드 열기 사유 표시명 (MET-01, screens.md 1.4 코드 열기). 순서가 사유 선택 모달의 순서다. */
export const CODE_OPEN_REASON_LABELS = {
  screen_error: '화면 오류',
  info_lacking: '정보 부족',
  debugging: '디버깅',
} as const satisfies Record<CodeOpenReason, string>;
