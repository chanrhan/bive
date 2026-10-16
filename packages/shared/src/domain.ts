// 도메인 엔터티 스키마와 타입 (docs/architecture.md 3장).
// M0 · M1에 필요한 엔터티만 스키마를 둔다. 나머지는 EntityName에 이름만 예약한다.
// 파생 값(요구사항 상태 · 결함, 규칙의 최신 판정 등)은 저장 필드가 아니므로 여기에 없다.
import { z } from 'zod';

import {
  AgentRole,
  ApprovalAction,
  AuthorKind,
  CheckKind,
  JudgeRunner,
  JudgmentStatus,
  NormState,
  ProposalKind,
  ProposalSource,
  ProposalState,
  ProvisionalPolicy,
  Risk,
  RuleKind,
  RunStatus,
  RunType,
  SessionEndReason,
  StepKind,
  StepStatus,
  TestCaseStatus,
} from './enums.js';
import { displayIdSchema, Ulid } from './id.js';

/** 엔터티 이름. 스키마가 없는 것은 이후 마일스톤용 예약 이름이다. */
export const EntityName = z.enum([
  // M0 · M1: 아래에 스키마가 있다
  'Project',
  'Settings',
  'Requirement',
  'Rule',
  'Proposal',
  'Run',
  'Step',
  'Session',
  'JudgmentResult',
  'ApprovalLog',
  // 예약 (M1 이후 해당 이슈에서 스키마 추가)
  'Contract',
  'Block',
  'Adr',
  'NormChange',
  'CodeChange',
  'CodeOpenRecord',
  'MutationResult',
  'ReviewItem',
  'ChatThread',
  'ChatMessage',
  'CoverageRecord',
  'RequestPathScan',
]);
export type EntityName = z.infer<typeof EntityName>;

/** 스키마가 아직 없는 예약 엔터티 이름. */
export const RESERVED_ENTITY_NAMES = [
  'Contract',
  'Block',
  'Adr',
  'NormChange',
  'CodeChange',
  'CodeOpenRecord',
  'MutationResult',
  'ReviewItem',
  'ChatThread',
  'ChatMessage',
  'CoverageRecord',
  'RequestPathScan',
] as const satisfies readonly EntityName[];

// ── 공통 값 ──────────────────────────────────────────────

/** ISO 8601 UTC 시각 문자열 (`Z` 접미, 오프셋 금지). */
export const Timestamp = z.iso.datetime();
export type Timestamp = z.infer<typeof Timestamp>;

/** USD 금액. 값이 없으면 `null` → 화면 '없음' (COST-02). */
export const UsdOrNull = z.number().nonnegative().nullable();

/** git 커밋 해시 (SHA-1 40자 또는 SHA-256 64자, 소문자). */
export const CommitSha = z
  .string()
  .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, '커밋 해시가 아닙니다');
export type CommitSha = z.infer<typeof CommitSha>;

const NonEmptyString = z.string().min(1);
const NonNegativeInt = z.int().nonnegative();

/** 공백만 있는 문자열을 받지 않는 본문. 저장은 받은 그대로 한다. */
const NonBlankText = z.string().refine((text) => text.trim().length > 0, '본문이 비어 있습니다');

/** 생성 주체 (NRM-01, NFR-03, ADR-008). */
export const HumanAuthor = z.strictObject({ kind: z.literal(AuthorKind.enum.human) });
export const AgentAuthor = z.strictObject({
  kind: z.literal(AuthorKind.enum.agent),
  role: AgentRole,
});
export const Author = z.discriminatedUnion('kind', [HumanAuthor, AgentAuthor]);
export type HumanAuthor = z.infer<typeof HumanAuthor>;
export type AgentAuthor = z.infer<typeof AgentAuthor>;
export type Author = z.infer<typeof Author>;

/** 다른 엔터티를 가리키는 참조. */
export const EntityRef = z.strictObject({ entity: EntityName, id: NonEmptyString });
export type EntityRef = z.infer<typeof EntityRef>;

// ── 프로젝트 · 설정 ──────────────────────────────────────

/** 프로젝트 (PRJ-01). */
export const Project = z.strictObject({
  id: Ulid,
  name: NonEmptyString,
  rootPath: NonEmptyString,
  baseBranch: NonEmptyString,
  createdAt: Timestamp,
});
export type Project = z.infer<typeof Project>;

/** 프로젝트 폴더의 식별 파일 `.bive.json` (PRJ-01, ADR-005, ADR-025). 이 두 필드 외에는 두지 않는다. */
export const ProjectFile = z.strictObject({
  projectId: Ulid,
  schemaVersion: z.int().positive(),
});
export type ProjectFile = z.infer<typeof ProjectFile>;
export const PROJECT_FILE_NAME = '.bive.json';
export const PROJECT_FILE_SCHEMA_VERSION = 1;

/** 역할별 값 맵. 비어 있는 역할은 미설정. */
const perRole = <T extends z.ZodType>(value: T) => z.partialRecord(AgentRole, value);

/** 승인 대기열 유입 상한 기본값 (TODO-04). */
export const DEFAULT_APPROVAL_QUEUE_LIMIT = 40;

/**
 * 프로젝트 설정 (COST-01, NFR-07, TODO-04, ADR-012, RUN-05, NFR-02).
 * 예산 · 모델은 실행에 필수지만 저장은 미설정(`null` · 빈 맵)을 허용한다.
 * 미설정이면 실행 생성이 `-32010`으로 거부된다 (architecture.md 5장).
 */
export const Settings = z.strictObject({
  projectId: Ulid,
  budget: z.strictObject({
    runTotalUsd: UsdOrNull,
    perRole: z.strictObject({
      testWriter: UsdOrNull,
      implementer: UsdOrNull,
    }),
  }),
  models: z.strictObject({ perRole: perRole(NonEmptyString) }),
  maxTurns: z.strictObject({ perRole: perRole(z.int().positive()) }),
  approvalQueueLimit: z.int().positive(),
  provisionalPolicy: ProvisionalPolicy,
  autoMode: z.boolean(),
  installAllowlist: z.array(NonEmptyString),
  updatedAt: Timestamp,
  updatedBy: Author,
});
export type Settings = z.infer<typeof Settings>;

// ── 규범 ─────────────────────────────────────────────────

/**
 * 요구사항 (NRM-01, NRM-08). `author`는 생성 주체, `updatedBy`는 마지막 수정(소프트 삭제 포함) 주체다 (ADR-047).
 * 생성 직후에는 `updatedAt = createdAt`, `updatedBy = author`.
 */
export const Requirement = z.strictObject({
  id: Ulid,
  displayId: displayIdSchema('REQ'),
  text: NonEmptyString,
  author: Author,
  normState: NormState,
  unrulable: z.strictObject({ reason: NonEmptyString }).nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  updatedBy: Author,
  deletedAt: Timestamp.nullable(),
});
export type Requirement = z.infer<typeof Requirement>;

/** 내장 구조 규칙의 식별자 (기획서 3.4 기타, JDG-05). */
export const BUILTIN_STRUCTURE_RULES = [
  'structure.public-api-only',
  'structure.declared-direction',
] as const;

/**
 * 규칙 (NRM-02, NRM-03, NRM-09). 부모 요구사항이 없는 것은 내장 구조 규칙뿐이다.
 * 예외: 부모 요구사항이 삭제되면 규칙은 남고 `parentRequirementId`가 `null`, `parentDetachedAt`이 삭제 시각이 된다
 * (추적성 결함, 표시는 M3-11 · ADR-050). 대상 블록 · 위험도는 P1(M2)부터 채워진다.
 */
export const Rule = z
  .strictObject({
    id: Ulid,
    displayId: displayIdSchema('RULE'),
    title: NonEmptyString,
    statement: NonEmptyString,
    kind: RuleKind,
    checkKinds: z.array(CheckKind).min(1),
    parentRequirementId: Ulid.nullable(),
    parentDetachedAt: Timestamp.nullable(),
    builtin: z.boolean(),
    targetBlockIds: z.array(Ulid),
    risk: Risk.nullable(),
    contractId: Ulid.nullable(),
    author: Author,
    normState: NormState,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    deletedAt: Timestamp.nullable(),
  })
  .refine(
    (rule) => rule.builtin || rule.parentRequirementId !== null || rule.parentDetachedAt !== null,
    {
      message: '내장 규칙이 아니면 부모 요구사항이 필요합니다 (NRM-02)',
      path: ['parentRequirementId'],
    },
  )
  .refine((rule) => rule.parentDetachedAt === null || rule.parentRequirementId === null, {
    message: '부모가 해제된 규칙에는 부모 요구사항 ID를 둘 수 없습니다',
    path: ['parentDetachedAt'],
  });
export type Rule = z.infer<typeof Rule>;

/**
 * 제안 처리 기록 (NRM-04, ADR-050). 처리 주체(사람)와 시각을 남긴다.
 * - 승인: `appliedRef`(반영된 규범)가 필수. 수정 후 승인이면 `editedPayload`(사람이 고친 본문 전체)
 * - 거절: `rejectReason`이 필수, `appliedRef` · `editedPayload` 없음
 */
export const ProposalDecision = z.strictObject({
  at: Timestamp,
  by: HumanAuthor,
  editedPayload: z.unknown().optional(),
  rejectReason: NonEmptyString.optional(),
  appliedRef: EntityRef.optional(),
});
export type ProposalDecision = z.infer<typeof ProposalDecision>;

/** 에이전트 제안 (TODO-01, TODO-03, NRM-04, NRM-05). 작성자는 항상 에이전트 (NFR-03). */
export const Proposal = z
  .strictObject({
    id: Ulid,
    displayId: displayIdSchema('PRP'),
    kind: ProposalKind,
    targetRef: EntityRef.nullable(),
    payload: z.unknown(),
    diff: z.strictObject({ before: z.unknown(), after: z.unknown() }),
    rationale: NonEmptyString,
    author: AgentAuthor,
    source: ProposalSource,
    risk: Risk.nullable(),
    readAt: Timestamp.nullable(),
    state: ProposalState,
    decision: ProposalDecision.nullable(),
    adrId: Ulid.nullable(),
    runId: Ulid.nullable(),
    createdAt: Timestamp,
  })
  .superRefine((proposal, ctx) => {
    const { state, decision } = proposal;
    if (state === 'pending' && decision !== null) {
      ctx.addIssue({
        code: 'custom',
        message: '승인 대기 제안에는 처리 기록이 없어야 합니다',
        path: ['decision'],
      });
    }
    if (state !== 'pending' && decision === null) {
      ctx.addIssue({
        code: 'custom',
        message: '처리된 제안에는 처리 기록이 필요합니다',
        path: ['decision'],
      });
    }
    if (state === 'rejected' && decision !== null && decision.rejectReason === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: '거절에는 사유가 필요합니다 (NRM-04)',
        path: ['decision', 'rejectReason'],
      });
    }
    if (state !== 'rejected' && decision?.rejectReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: '거절이 아닌 제안에는 거절 사유를 둘 수 없습니다',
        path: ['decision', 'rejectReason'],
      });
    }
    if (state === 'approved' && decision !== null && decision.appliedRef === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: '승인된 제안에는 반영된 규범이 필요합니다',
        path: ['decision', 'appliedRef'],
      });
    }
    if (
      state === 'rejected' &&
      decision !== null &&
      (decision.appliedRef !== undefined || decision.editedPayload !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: '거절된 제안에는 반영 규범 · 수정 본문을 둘 수 없습니다',
        path: ['decision'],
      });
    }
  });
export type Proposal = z.infer<typeof Proposal>;

// ── 제안 본문 (ADR-050) ──────────────────────────────────
// 종류별 본문 스키마. 여기 있는 종류만 등록 · 승인할 수 있다. 나머지 종류는 해당 마일스톤 이슈가 더한다
// (설계 변경 DSN-07 · 계약 M3-04 · 규칙 제목 변경 NRM-10 등).

/** `requirement_new` 본문: 새 요구사항 문장. */
export const RequirementNewPayload = z.strictObject({ text: NonBlankText });
export type RequirementNewPayload = z.infer<typeof RequirementNewPayload>;

/** `rule_new` 본문: 제목 + 진술(EARS) + 검사 종류 1개 이상 + 부모 요구사항 1개 (NRM-02, 기획서 3.1). */
export const RuleNewPayload = z.strictObject({
  title: NonBlankText,
  statement: NonBlankText,
  kind: RuleKind,
  checkKinds: z
    .array(CheckKind)
    .min(1)
    .refine((kinds) => new Set(kinds).size === kinds.length, '검사 종류가 중복됐습니다'),
  parentRequirementId: Ulid,
});
export type RuleNewPayload = z.infer<typeof RuleNewPayload>;

/** 본문 스키마가 있는(= 지금 등록 · 승인할 수 있는) 제안 종류와 그 스키마. */
export const PROPOSAL_PAYLOAD_SCHEMAS = {
  requirement_new: RequirementNewPayload,
  rule_new: RuleNewPayload,
} as const satisfies Partial<Record<ProposalKind, z.ZodType>>;

export const SupportedProposalKind = z.enum(['requirement_new', 'rule_new']);
export type SupportedProposalKind = z.infer<typeof SupportedProposalKind>;

/** 어떤 종류든 받는 본문 스키마. 종류와 맞는지는 `PROPOSAL_PAYLOAD_SCHEMAS[kind]`로 다시 확인한다. */
export const ProposalPayload = z.union([RequirementNewPayload, RuleNewPayload]);
export type ProposalPayload = z.infer<typeof ProposalPayload>;

// ── 승인 기록 (NFR-01, ADR-027, ADR-050) ─────────────────

/** SHA-256 16진수 64자 (소문자). */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 16진수가 아닙니다');
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/** 첫 승인 기록의 `prevHash`. */
export const APPROVAL_LOG_GENESIS_HASH = '0'.repeat(64);

/** 승인 기록의 행동별 상세. 수정 후 승인은 `diff`, 거절은 `reason`, 승인은 `appliedRef`. */
export const ApprovalLogDetail = z.strictObject({
  diff: z.strictObject({ before: z.unknown(), after: z.unknown() }).optional(),
  reason: NonEmptyString.optional(),
  appliedRef: EntityRef.optional(),
});
export type ApprovalLogDetail = z.infer<typeof ApprovalLogDetail>;

/**
 * 승인 기록 1건 (추가 전용). `hash` = SHA-256(정규 JSON(`hash`를 뺀 나머지 필드)),
 * `prevHash` = 바로 앞 기록의 `hash`(첫 기록은 `APPROVAL_LOG_GENESIS_HASH`). 계산 · 검증은 `@bive/store`.
 * `clientId`는 요청이 들어온 파이프 연결 식별자(증거용, 없으면 `null`).
 */
export const ApprovalLogEntry = z
  .strictObject({
    seq: z.int().positive(),
    at: Timestamp,
    action: ApprovalAction,
    actor: HumanAuthor,
    targetRef: EntityRef,
    clientId: NonEmptyString.nullable(),
    detail: ApprovalLogDetail,
    prevHash: Sha256Hex,
    hash: Sha256Hex,
  })
  .superRefine((entry, ctx) => {
    const { action, detail } = entry;
    if (action === 'approve_edited' && detail.diff === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: '수정 후 승인에는 수정 diff가 필요합니다 (NRM-04)',
        path: ['detail', 'diff'],
      });
    }
    if (action !== 'approve_edited' && detail.diff !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: '수정 후 승인이 아니면 수정 diff를 둘 수 없습니다',
        path: ['detail', 'diff'],
      });
    }
    if ((action === 'reject') !== (detail.reason !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: '거절에만 사유가 있고, 거절에는 사유가 필수입니다 (NRM-04)',
        path: ['detail', 'reason'],
      });
    }
  });
export type ApprovalLogEntry = z.infer<typeof ApprovalLogEntry>;

// ── 실행 ─────────────────────────────────────────────────

/** 검사 실패 → 구현 회귀 상한 (RUN-02 확정). 초과하면 실행 `failed`. */
export const MAX_REGRESSION_COUNT = 2;

/** 실행 시작 시 복사한 예산 (COST-01). 실행은 예산이 모두 설정돼야 생성되므로 `null`이 없다. */
export const BudgetSnapshot = z.strictObject({
  runTotalUsd: z.number().nonnegative(),
  perRole: z.strictObject({
    testWriter: z.number().nonnegative(),
    implementer: z.number().nonnegative(),
  }),
});
export type BudgetSnapshot = z.infer<typeof BudgetSnapshot>;

/** 세션별 도구 목록 · MCP 서버 수 (NFR-02). */
export const ToolManifestEntry = z.strictObject({
  role: AgentRole,
  tools: z.array(NonEmptyString),
  mcpServerCount: NonNegativeInt,
});
export type ToolManifestEntry = z.infer<typeof ToolManifestEntry>;

/** 실행 (RUN-01, RUN-02, RUN-07, RUN-08, COST-01, NFR-07). */
export const Run = z.strictObject({
  id: Ulid,
  displayId: displayIdSchema('EXE'),
  projectId: Ulid,
  type: RunType,
  targetRuleIds: z.array(Ulid).min(1),
  status: RunStatus,
  currentStep: StepKind.nullable(),
  lastCompletedStep: StepKind.nullable(),
  regressionCount: NonNegativeInt,
  failureReason: NonEmptyString.nullable(),
  branch: NonEmptyString,
  worktreePath: NonEmptyString,
  baseBranch: NonEmptyString,
  baseCommit: CommitSha,
  headCommit: CommitSha.nullable(),
  mergeCommit: CommitSha.nullable(),
  budgetSnapshot: BudgetSnapshot,
  modelSnapshot: perRole(NonEmptyString),
  costUsd: UsdOrNull,
  turns: NonNegativeInt.nullable(),
  toolManifest: z.array(ToolManifestEntry),
  startedBy: HumanAuthor,
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
});
export type Run = z.infer<typeof Run>;

/** 실행 단계 (RUN-02, RUN-07, SCR-16). `exitDetail`은 종료 조건 결과 JSON. */
export const Step = z.strictObject({
  id: Ulid,
  runId: Ulid,
  kind: StepKind,
  attempt: z.int().positive(),
  status: StepStatus,
  role: AgentRole.nullable(),
  exitDetail: z.unknown(),
  commit: CommitSha.nullable(),
  costUsd: UsdOrNull,
  turns: NonNegativeInt.nullable(),
  startedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
});
export type Step = z.infer<typeof Step>;

/** 모델별 사용량 (SDK `modelUsage`, 기획서 4.5). */
export const ModelUsage = z.strictObject({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadInputTokens: NonNegativeInt,
  cacheCreationInputTokens: NonNegativeInt,
  costUsd: UsdOrNull,
});
export type ModelUsage = z.infer<typeof ModelUsage>;

/** 에이전트 세션 = SDK `query()` 1회 (기획서 3.2, RUN-04). 진행 중이면 종료 사유 · 비용이 `null`. */
export const Session = z.strictObject({
  id: Ulid,
  stepId: Ulid,
  role: AgentRole,
  model: NonEmptyString,
  sdkSessionId: NonEmptyString.nullable(),
  workDir: NonEmptyString,
  endReason: SessionEndReason.nullable(),
  totalCostUsd: UsdOrNull,
  numTurns: NonNegativeInt.nullable(),
  modelUsage: z.record(NonEmptyString, ModelUsage),
  firstTurnCacheWrite: NonNegativeInt.nullable(),
  tools: z.array(NonEmptyString),
  mcpServers: z.array(NonEmptyString),
});
export type Session = z.infer<typeof Session>;

// ── 판정 ─────────────────────────────────────────────────

/** 판정에 쓰인 테스트 케이스 1건 (SCR-16). */
export const JudgmentCase = z.strictObject({
  name: NonEmptyString,
  file: NonEmptyString,
  line: z.int().positive().nullable(),
  status: TestCaseStatus,
  message: z.string().nullable(),
});
export type JudgmentCase = z.infer<typeof JudgmentCase>;

/**
 * 규칙 판정 결과 (JDG-01, JDG-02). 근거는 실행기 결과(exit code · 케이스)뿐이다.
 * 격리 상태면 격리 사유가 필수 (TODO-02, NFR-05).
 */
export const JudgmentResult = z
  .strictObject({
    id: Ulid,
    ruleId: Ulid,
    runId: Ulid.nullable(),
    stepId: Ulid.nullable(),
    commit: CommitSha,
    judgedAt: Timestamp,
    status: JudgmentStatus,
    runner: JudgeRunner,
    exitCode: z.int().nullable(),
    reporterPath: NonEmptyString.nullable(),
    cases: z.array(JudgmentCase),
    quarantineReason: NonEmptyString.nullable(),
  })
  .superRefine((result, ctx) => {
    if (result.status === 'quarantined' && result.quarantineReason === null) {
      ctx.addIssue({
        code: 'custom',
        message: '격리에는 사유가 필요합니다 (TODO-02)',
        path: ['quarantineReason'],
      });
    }
    if (result.status !== 'quarantined' && result.quarantineReason !== null) {
      ctx.addIssue({
        code: 'custom',
        message: '격리가 아닌 판정에는 격리 사유를 둘 수 없습니다',
        path: ['quarantineReason'],
      });
    }
  });
export type JudgmentResult = z.infer<typeof JudgmentResult>;
