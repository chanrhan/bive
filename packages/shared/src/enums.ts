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

/** 실행 상태 6종 (architecture.md 4장 상태 기계, RUN-01). */
export const RunStatus = z.enum([
  'waiting_approval',
  'running',
  'merged',
  'failed',
  'budget_exceeded',
  'interrupted',
]);
export type RunStatus = z.infer<typeof RunStatus>;
export const RUN_STATUS_LABELS = {
  waiting_approval: '승인 대기',
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
 * 종료 상태는 빈 목록이다. 생성 직후 상태는 항상 `waiting_approval`(실행 시작 확인 → 승인 단계).
 */
export const RUN_STATUS_TRANSITIONS = {
  waiting_approval: ['running'],
  running: ['merged', 'failed', 'budget_exceeded', 'interrupted'],
  interrupted: ['running'],
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

/** 에이전트 세션 종료 사유 (기획서 4.5, COST-01). */
export const SessionEndReason = z.enum([
  'success',
  'error_max_turns',
  'error_max_budget_usd',
  'error_during_execution',
  'aborted',
  'guard_violation',
]);
export type SessionEndReason = z.infer<typeof SessionEndReason>;
export const SESSION_END_REASON_LABELS = {
  success: '정상 종료',
  error_max_turns: '턴 한도 초과',
  error_max_budget_usd: '예산 한도 초과',
  error_during_execution: '실행 중 오류',
  aborted: '중단',
  guard_violation: '가드 위반',
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
]);
export type RuleWriterSkipReason = z.infer<typeof RuleWriterSkipReason>;
export const RULE_WRITER_SKIP_REASON_LABELS = {
  settings_incomplete: '예산 · 모델 미설정',
  closed: '오케스트레이터 종료',
  start_failed: '시작 실패',
  requirement_unavailable: '요구사항 없음',
} as const satisfies Record<RuleWriterSkipReason, string>;

/** 규칙 작성 시도 하나의 상태: 대기 · 진행 중 · 끝남(종료 사유는 세션 기록) · 생략. */
export const RuleWriterState = z.enum(['queued', 'running', 'ended', 'skipped']);
export type RuleWriterState = z.infer<typeof RuleWriterState>;

/** 판정 실행기 (JDG-01). M1은 vitest만. */
export const JudgeRunner = z.enum(['vitest']);
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
 * 확인 상태 (ADR-100 D2 · C1, M7-01): 규범 항목마다 "사람이 보고 OK했는가". 두 값뿐이고 기본은 미확인이다.
 * 사람만 확인됨으로 바꾸며(I1) 실행 생성 · 단계 진행 · 판정 · 병합의 어느 조건에도 쓰이지 않는다.
 */
export const ConfirmationState = z.enum(['unconfirmed', 'confirmed']);
export type ConfirmationState = z.infer<typeof ConfirmationState>;
export const CONFIRMATION_STATE_LABELS = {
  unconfirmed: '미확인',
  confirmed: '확인됨',
} as const satisfies Record<ConfirmationState, string>;

/** 코드 열기 사유 (MET-01). */
export const CodeOpenReason = z.enum(['screen_error', 'info_lacking', 'debugging']);
export type CodeOpenReason = z.infer<typeof CodeOpenReason>;

/** 코드 열기 사유 표시명 (MET-01, screens.md 1.4 코드 열기). 순서가 사유 선택 모달의 순서다. */
export const CODE_OPEN_REASON_LABELS = {
  screen_error: '화면 오류',
  info_lacking: '정보 부족',
  debugging: '디버깅',
} as const satisfies Record<CodeOpenReason, string>;
