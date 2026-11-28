// 앱 ↔ 오케스트레이터 IPC 프로토콜 (docs/architecture.md 5장).
// 프레임 = UTF-8 JSON 1줄 = JSON-RPC 2.0 메시지 1개. 양쪽이 같은 스키마로 검증하고,
// 파라미터 · 결과가 메서드 스키마와 맞지 않으면 -32602로 처리한다.
import { z } from 'zod';

import {
  ApprovalLogBreakReason,
  ApprovalLogEntry,
  Author,
  BlockDeclarationRecord,
  BudgetSnapshot,
  CodeFilePath,
  CodeLine,
  CodeOpenRecord,
  CommitSha,
  Confirmation,
  ConfirmationTarget,
  Contract,
  DailyBudgetUsd,
  EntityRef,
  IdeSetting,
  JudgmentResult,
  MissingSettingPath,
  NormChangeActor,
  NormChangeBreakReason,
  NormChangeDetail,
  NormJudgmentRuleRef,
  NormTestChangeFile,
  Project,
  Proposal,
  ProposalPayload,
  Requirement,
  ReviewItem,
  RoleSettings,
  Rule,
  Run,
  RunLimits,
  ScreenId,
  SessionNormInput,
  Settings,
  Sha256Hex,
  Step,
  StoredCodeOpenRecord,
  Timestamp,
  ToolCallStatus,
  UsdOrNull,
} from './domain.js';
import {
  AgentRole,
  AutoStartSkipReason,
  ConfirmationItemKind,
  CodeOpenReason,
  ContractKind,
  JudgmentStatus,
  MutationStatus,
  NormChangeKind,
  ProposalKind,
  Risk,
  ProposalState,
  ReviewItemKind,
  ReviewItemState,
  RuleWriterSkipReason,
  RuleWriterState,
  RunStatus,
  RunType,
  SessionEndReason,
  StepKind,
  StepStatus,
} from './enums.js';
import { BLOCK_LIMITS, BlockName } from './blocks.js';
import { displayIdSchema, Ulid } from './id.js';
import { RunUsage } from './usage.js';

export const JSONRPC_VERSION = '2.0';

/** 오류 코드: JSON-RPC 표준 + BIVE 정의 (architecture.md 5장). */
export const ErrorCode = {
  /** JSON 해석 실패 */
  ParseError: -32700,
  /** JSON-RPC 메시지 형식 위반 */
  InvalidRequest: -32600,
  /** 등록되지 않은 메서드 */
  MethodNotFound: -32601,
  /** 파라미터 · 결과의 스키마 불일치 */
  InvalidParams: -32602,
  /** 처리 중 내부 오류 */
  InternalError: -32603,
  /** 도메인 검증 실패 (예: 빈 거절 사유) */
  ValidationFailed: -32001,
  /** 대상 없음 */
  NotFound: -32004,
  /** 상태 충돌 (예: 승인된 제안 재승인) */
  StateConflict: -32009,
  /** 설정 미비 (예산 · 모델 없음, NFR-07) */
  SettingsIncomplete: -32010,
  /** 권한 없음 (토큰 · 출처) */
  Unauthorized: -32020,
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 오류 코드별 기본 메시지. */
export const ERROR_MESSAGES = {
  [ErrorCode.ParseError]: 'JSON 해석 실패',
  [ErrorCode.InvalidRequest]: '요청 형식 위반',
  [ErrorCode.MethodNotFound]: '없는 메서드',
  [ErrorCode.InvalidParams]: '스키마 불일치',
  [ErrorCode.InternalError]: '내부 오류',
  [ErrorCode.ValidationFailed]: '검증 실패',
  [ErrorCode.NotFound]: '대상 없음',
  [ErrorCode.StateConflict]: '상태 충돌',
  [ErrorCode.SettingsIncomplete]: '설정 미비',
  [ErrorCode.Unauthorized]: '권한 없음',
} as const satisfies Record<ErrorCode, string>;

// ── 메시지 스키마 ────────────────────────────────────────

/** 요청 ID. 소수 숫자는 허용하지 않는다 (JSON-RPC 2.0 권고). */
export const JsonRpcId = z.union([z.string(), z.int()]);
export type JsonRpcId = z.infer<typeof JsonRpcId>;

/** 파라미터 자리: 없거나, 객체 · 배열 (JSON-RPC 2.0). 메서드별 형태는 METHODS가 정한다. */
const ParamsSlot = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional();

export const JsonRpcRequest = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: JsonRpcId,
  method: z.string().min(1),
  params: ParamsSlot,
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequest>;

/** 알림: ID 없는 요청. 응답하지 않는다. */
export const JsonRpcNotification = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  method: z.string().min(1),
  params: ParamsSlot,
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotification>;

export const JsonRpcErrorObject = z.strictObject({
  code: z.int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObject>;

/** 성공 응답. `result`는 필수 (`null`도 값). */
export const JsonRpcSuccessResponse = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: JsonRpcId,
  result: z.unknown(),
});
export type JsonRpcSuccessResponse = z.infer<typeof JsonRpcSuccessResponse>;

/** 오류 응답. 요청 ID를 알 수 없으면 `null`. */
export const JsonRpcErrorResponse = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: JsonRpcId.nullable(),
  error: JsonRpcErrorObject,
});
export type JsonRpcErrorResponse = z.infer<typeof JsonRpcErrorResponse>;

/** 응답: 성공 · 오류 중 하나. `result`와 `error`를 함께 가지면 위반. */
export const JsonRpcResponse = z.union([JsonRpcSuccessResponse, JsonRpcErrorResponse]);
export type JsonRpcResponse = z.infer<typeof JsonRpcResponse>;

/** 파이프로 오가는 메시지 전체. */
export const JsonRpcMessage = z.union([JsonRpcRequest, JsonRpcNotification, JsonRpcResponse]);
export type JsonRpcMessage = z.infer<typeof JsonRpcMessage>;

// ── 메서드 레지스트리 ────────────────────────────────────

export interface MethodSpec {
  params: z.ZodType;
  result: z.ZodType;
}

/** `ping`: 파라미터 없음 → `{ pong: true, version }`. 연결 확인용. */
export const PingParams = z.undefined();
export const PingResult = z.strictObject({
  pong: z.literal(true),
  /** 응답한 쪽(오케스트레이터)의 버전 문자열 */
  version: z.string().min(1),
});
export type PingResult = z.infer<typeof PingResult>;

/** 파이프 프로토콜 버전. 메시지 형태가 호환되지 않게 바뀌면 올린다. */
export const PROTOCOL_VERSION = 1;

/**
 * `system.hello`: 연결 후 첫 메시지 (architecture.md 5장, ADR-027).
 * 토큰은 `$BIVE_HOME/run/token` 내용. 버전이 다르면 -32602, 토큰이 다르면 -32020이고 둘 다 연결을 닫는다.
 */
export const SystemHelloParams = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  token: z.string().min(1),
});
export type SystemHelloParams = z.infer<typeof SystemHelloParams>;
export const SystemHelloResult = z.strictObject({
  orchestratorVersion: z.string().min(1),
});
export type SystemHelloResult = z.infer<typeof SystemHelloResult>;

/**
 * `system.status`: 파라미터 없음 → 오케스트레이터 상태 (사이드바 연결 상태, screens.md 1.2, ADR-045).
 * - `connections`: 열린 파이프 연결 수 (인증 여부 무관, 유휴 종료 기준과 같음 · ADR-041)
 * - `runsInProgress`: 진행 중 실행 수 (실행 엔진은 M1, 그 전에는 0)
 */
export const SystemStatusParams = z.undefined();
export const SystemStatusResult = z.strictObject({
  version: z.string().min(1),
  uptimeMs: z.number().int().nonnegative(),
  connections: z.number().int().nonnegative(),
  runsInProgress: z.number().int().nonnegative(),
});
export type SystemStatusResult = z.infer<typeof SystemStatusResult>;

// ── 요구사항 (NRM-01, M1-02, ADR-047) ─────────────────────
// - 모든 요청에 `projectId`가 필수다. 등록되지 않은 프로젝트 · 없는 요구사항은 -32004
// - 바꾸는 요청(create · update · delete)은 주체 `author`를 싣는다. 파이프로는 사람(`human`)의 직접 편집만
//   받고 바로 반영한다(승인 불필요). 에이전트 주체는 -32020 (에이전트 경로는 제안 승인, NRM-04)
// - delete는 소프트 삭제(`deletedAt`)다. 이미 삭제됐거나 삭제된 것을 고치면 -32009
// - list는 삭제되지 않은 것만 표시 ID 순으로, get은 삭제된 것도 돌려준다(`deletedAt`으로 구분)

/** 요구사항 본문. 공백만 있는 본문은 받지 않는다. 저장은 받은 그대로 한다. */
export const RequirementText = z
  .string()
  .refine((text) => text.trim().length > 0, '요구사항 본문이 비어 있습니다');

/** `requirement.create`: 새 요구사항. 표시 ID(`REQ-NNN`)는 저장소가 정한다. */
export const RequirementCreateParams = z.strictObject({
  projectId: Ulid,
  text: RequirementText,
  author: Author,
});
export type RequirementCreateParams = z.infer<typeof RequirementCreateParams>;

/** `requirement.update`: 본문을 바꾼다. `updatedAt` · `updatedBy`가 함께 바뀐다. */
export const RequirementUpdateParams = z.strictObject({
  projectId: Ulid,
  id: Ulid,
  text: RequirementText,
  author: Author,
});
export type RequirementUpdateParams = z.infer<typeof RequirementUpdateParams>;

/** `requirement.delete`: 소프트 삭제. `deletedAt` · `updatedAt` · `updatedBy`가 채워진다. */
export const RequirementDeleteParams = z.strictObject({
  projectId: Ulid,
  id: Ulid,
  author: Author,
});
export type RequirementDeleteParams = z.infer<typeof RequirementDeleteParams>;

/** `requirement.get`: ID로 1건. */
export const RequirementGetParams = z.strictObject({ projectId: Ulid, id: Ulid });
export type RequirementGetParams = z.infer<typeof RequirementGetParams>;

/** `requirement.list`: 삭제되지 않은 요구사항 전부. */
export const RequirementListParams = z.strictObject({ projectId: Ulid });
export type RequirementListParams = z.infer<typeof RequirementListParams>;

/** 규칙화 불가 사유 상한 (UTF-16 코드 단위, 규칙 진술 상한과 같다, ADR-137). */
export const UNRULABLE_REASON_MAX = 4000;

/**
 * `requirement.markUnrulable`: 사람이 요구사항에 '규칙화 불가'를 표시하고 사유를 남긴다 (NRM-08, M3-11 #56, ADR-137).
 * - 사람 주체만 받는다(에이전트 -32020, 저장소를 열기 전). 빈 사유(공백만 포함)는 스키마가 아니라 도메인 검증으로 거부한다
 *   (-32001 `data.reason = UNRULABLE_REASON_REQUIRED`), 상한 초과는 -32001 `UNRULABLE_REASON_INVALID`
 * - 없는 요구사항 -32004. 삭제된 요구사항 · 이미 규칙화 불가 · 효력 있는 자식 규칙이 있음은 -32009
 *   (`data.reason` = {@link UnrulableConflictReason}). 이미 표시한 사유는 바꾸지 않는다(되돌리는 동작도 없다)
 * - 기록은 요구사항 자체의 수정 주체 · 시각이다(승인 기록에 쓰지 않음, 요구사항의 사람 편집과 같다). 같은 트랜잭션에서 확인됨
 * - 규칙 작성 세션 · 재판단을 띄우지 않는다
 */
export const RequirementMarkUnrulableParams = z.strictObject({
  projectId: Ulid,
  id: Ulid,
  reason: z.string(),
  author: Author,
});
export type RequirementMarkUnrulableParams = z.infer<typeof RequirementMarkUnrulableParams>;

/** `requirement.markUnrulable`이 -32009로 거부하는 이유 (`error.data.reason`). */
export const UnrulableConflictReason = z.enum([
  'requirement_deleted',
  'already_unrulable',
  'has_rules',
]);
export type UnrulableConflictReason = z.infer<typeof UnrulableConflictReason>;

/** create · update · delete · get 결과. 이후 이슈가 자식 규칙 등 필드를 더할 수 있게 객체로 감싼다. */
export const RequirementResult = z.strictObject({ requirement: Requirement });
export type RequirementResult = z.infer<typeof RequirementResult>;

export const RequirementListResult = z.strictObject({ requirements: z.array(Requirement) });
export type RequirementListResult = z.infer<typeof RequirementListResult>;

// ── 규칙 (NRM-02, JDG-02, M1-11, ADR-060) ─────────────────
// - 모든 요청에 `projectId`가 필수다. 등록되지 않은 프로젝트 · 없는 규칙은 -32004
// - 규칙 테이블의 규범(승인 · 잠정 승인)만 돌려준다. 승인 전 제안은 규칙이 아니라 `proposal.*`로만 보인다 (NRM-04)
// - 규칙마다 최신 판정을 함께 싣는다. 판정 기록이 없으면 `unjudged`(미판정) · `latest: null` (JDG-02, 기획서 3.4)
// - list는 삭제되지 않은 것만 표시 ID 순으로, get은 삭제된 것도 돌려준다(`rule.deletedAt`으로 구분, ADR-047과 같음)
// - 필터는 렌더러 목록이 한다(screens.md 1.4, ADR-048). 규칙을 바꾸는 RPC는 사람의 직접 편집 `rule.update`뿐이다
//   (아래 절, ADR-100 B②, ADR-109)

/**
 * 규칙의 최신 판정 (파생 값, JDG-02). `latest`는 그 규칙의 가장 최근 판정 결과(커밋 · 시각 · 실행 링크 `runId`).
 * 판정 기록이 없으면 `status = unjudged`, `latest = null`. 기록이 있으면 `status`는 기록의 상태와 같다.
 */
export const RuleJudgment = z
  .strictObject({
    status: JudgmentStatus,
    latest: JudgmentResult.nullable(),
  })
  .refine(
    ({ status, latest }) => (latest === null ? status === 'unjudged' : status === latest.status),
    { message: '판정 상태가 최신 판정 기록과 맞지 않습니다', path: ['status'] },
  );
export type RuleJudgment = z.infer<typeof RuleJudgment>;

/**
 * 폐기된 규칙의 폐기 사실 (M7-15 #227, ADR-112 · ADR-114). `rule.list` · `rule.get` 항목의 `retirement`로만 실린다.
 * - `retiredAt`: 폐기 시각
 * - `supersededBy`: 대체한 새 규칙의 ID · 표시 ID (대체), 폐기만이면 `null`
 * - `normChangeSeq`: 사유 · 근거가 든 규범 변경 기록(`retired` · `superseded`)의 순번 (`normChange.list`로 읽는다)
 * 폐기 기록 행이 있으나 형식이 깨져 읽을 수 없으면 세 칸이 모두 `null`이다(그래도 폐기로 본다: 효력을 잃은 쪽으로 닫음)
 */
export const RuleRetirementView = z.strictObject({
  retiredAt: Timestamp.nullable(),
  supersededBy: NormJudgmentRuleRef.nullable(),
  normChangeSeq: z.int().positive().nullable(),
});
export type RuleRetirementView = z.infer<typeof RuleRetirementView>;

/**
 * 규칙 1건 + 최신 판정. `rule.get` 결과이자 `rule.list` 목록의 항목이다. 폐기된 규칙에만 `retirement`가 있다(없으면 폐기 아님,
 * M7-15 · ADR-114). 폐기된 규칙의 최신 판정은 폐기 전의 기록이다(폐기 뒤에는 판정하지 않는다, ADR-112)
 */
export const RuleWithJudgment = z.strictObject({
  rule: Rule,
  judgment: RuleJudgment,
  retirement: RuleRetirementView.optional(),
  /**
   * 규칙의 변이 상태 (JDG-04, M3-15 #60, ADR-139 · ADR-143 · ADR-146): 그 규칙의 가장 나중 변이 기록(기록 시각 → ID)의 상태, 기록이
   * 없으면 '변이 미검증'. `rule.list`는 늘 싣는다. 이 칸이 없는 응답(옛 응답)을 읽는 화면은 변이 상태를 모르는 것으로 본다
   */
  mutation: MutationStatus.optional(),
});
export type RuleWithJudgment = z.infer<typeof RuleWithJudgment>;

/**
 * `rule.list`: 삭제되지 않고 폐기되지 않은 규칙 전부(표시 ID 순). `includeRetired: true`면 폐기된 규칙도 함께 돌려준다
 * (규칙 화면의 [폐기 포함], M7-15 · ADR-114). 읽기 전용이다
 */
export const RuleListParams = z.strictObject({
  projectId: Ulid,
  includeRetired: z.boolean().optional(),
});
export type RuleListParams = z.infer<typeof RuleListParams>;
/**
 * 추적성 결함 (NRM-06, M3-11 #56, ADR-137). 서버가 저장소에서 한 번 정하고 화면은 다시 세지 않는다. 목록은 표시 ID 순이다.
 * - `requirementsWithoutRules`: 규칙 없는 요구사항 = 삭제되지 않았고 '규칙화 불가'가 아니며 효력 있는 자식 규칙(삭제 · 폐기 ·
 *   잠정이 아닌 규칙)이 하나도 없는 요구사항. 자식 규칙이 모두 폐기된 요구사항도 든다(ADR-112)
 * - `parentlessRules`: 부모 없는 규칙 = 효력 있고 내장(`builtin`: 구조 규칙 · 계약 검사 규칙)이 아니며 부모 요구사항이 없거나
 *   삭제된 규칙
 */
export const Traceability = z.strictObject({
  requirementsWithoutRules: z.array(
    z.strictObject({ id: Ulid, displayId: displayIdSchema('REQ') }),
  ),
  parentlessRules: z.array(z.strictObject({ id: Ulid, displayId: displayIdSchema('RULE') })),
});
export type Traceability = z.infer<typeof Traceability>;

/**
 * `rule.list` 결과. `traceability`는 같은 저장소 읽기에서 정한 추적성 결함이다(요구사항 · 규칙 화면이 카드 예외에 쓴다, ADR-137).
 * 서버는 늘 싣는다. 이 칸이 없는 응답(옛 응답)을 읽는 화면은 결함을 모르는 것으로 본다
 */
export const RuleListResult = z.strictObject({
  rules: z.array(RuleWithJudgment),
  traceability: Traceability.optional(),
});
export type RuleListResult = z.infer<typeof RuleListResult>;

/** `rule.get`: ID로 1건. 제안 ID는 규칙이 아니므로 -32004. */
export const RuleGetParams = z.strictObject({ projectId: Ulid, id: Ulid });
export type RuleGetParams = z.infer<typeof RuleGetParams>;
/**
 * 규칙의 최신 실행 링크 (COST-02 · SCR-03 "최신 실행 링크", M3-16 #61, ADR-134). 그 규칙을 대상으로 한 실행 중 가장 나중에
 * 만든 실행(표시 ID 순 마지막)의 ID · 표시 ID와 실행 합계 비용 · 턴이다. 합계는 저장된 세션 기록의 실행 합계(`runs.usage`의
 * `run`)이고, 값을 모르는 세션이 하나라도 있으면(진행 중 · 결과 없이 끝남) 그 값은 `null`이다(하한을 확정 값처럼 보이지
 * 않는다). 세션이 없어도 `null`. 0은 기록이 실제로 0일 때만이다
 */
export const RuleLatestRun = z.strictObject({
  id: Ulid,
  displayId: displayIdSchema('EXE'),
  costUsd: UsdOrNull,
  turns: z.int().nonnegative().nullable(),
});
export type RuleLatestRun = z.infer<typeof RuleLatestRun>;

/**
 * `rule.get` 결과: 규칙 1건 + 최신 판정(목록 항목과 같은 칸) + 최신 실행 링크(`latestRun`, 대상으로 한 실행이 없으면 `null`).
 * `latestRun`은 넓힌 칸이라 선택 칸이다(옛 오케스트레이터의 응답에는 없다). 오케스트레이터는 늘 싣는다
 */
export const RuleGetResult = RuleWithJudgment.extend({
  latestRun: RuleLatestRun.nullable().optional(),
});
export type RuleGetResult = z.infer<typeof RuleGetResult>;

// ── 규칙 직접 편집 (NRM-04 · NRM-07, ADR-100 B② · A2 · A8 · C2, M7-03 #215, ADR-109) ─────
// - `rule.update`: 사람이 규칙의 제목 · 진술을 고친다. 사람 주체만 받는다(에이전트 -32020, 저장소를 열기 전에 본다)
// - 편집 · 확인됨(근거 = 그 승인 기록 순번) · 승인 기록 `rule_edit`(before · after diff)을 트랜잭션 1개로 남긴다
// - 오류: 없는 규칙 · 등록되지 않은 프로젝트 -32004, 제목 · 진술 형식(한 줄 · 길이 · EARS) -32001
//   (`data.reason = RULE_EDIT_INVALID`, `data.issues`), 바뀐 것이 없음 -32001(`RULE_EDIT_NO_CHANGE`),
//   삭제된 규칙 · 효력 없는 규칙 · 내장 구조 규칙 · 기대한 수정 시각과 다름 -32009(`data.reason` = {@link RuleEditConflictReason}),
//   제목 · 진술이 둘 다 없음 -32602
// - 진술이 바뀌면 오케스트레이터가 그 규칙 1개로 인수 테스트를 다시 쓰는 실행을 자동 시작한다(`autoStart`, 규범 변경 기록
//   `auto_start`). 제목만 바뀌면 실행이 없다(`autoStart: null`)

/** 규칙 제목 상한 (UTF-16 코드 단위, 규칙 작성 도구와 같다). */
export const RULE_TITLE_MAX = 200;
/** 규칙 진술 상한 (UTF-16 코드 단위, 규칙 작성 도구와 같다). */
export const RULE_STATEMENT_MAX = 4000;

/** `rule.update`가 -32009로 거부하는 이유 (`error.data.reason`). */
export const RuleEditConflictReason = z.enum([
  /** 삭제된 규칙 */
  'rule_deleted',
  /** 효력 없는 규칙 (`normState`가 효력 상태가 아님) */
  'rule_not_effective',
  /** 내장 구조 규칙: 진술이 구조 검사 코드와 짝이라 글만 고칠 수 없다 */
  'builtin_rule',
  /** 화면이 본 수정 시각(`expectedUpdatedAt`)과 저장된 수정 시각이 다르다 (다른 편집 · 변경이 먼저 저장됨) */
  'rule_changed',
]);
export type RuleEditConflictReason = z.infer<typeof RuleEditConflictReason>;

export const RuleUpdateParams = z
  .strictObject({
    projectId: Ulid,
    id: Ulid,
    author: Author,
    /** 새 제목 (생략하면 그대로) */
    title: z.string().optional(),
    /** 새 진술 (생략하면 그대로) */
    statement: z.string().optional(),
    /** 편집을 시작할 때 본 규칙의 `updatedAt`. 주면 저장된 값과 같을 때만 고친다 (낡은 내용 위 덮어쓰기 방지) */
    expectedUpdatedAt: Timestamp.optional(),
  })
  .refine((params) => params.title !== undefined || params.statement !== undefined, {
    message: '제목 · 진술 중 하나는 있어야 합니다',
    path: ['title'],
  });
export type RuleUpdateParams = z.infer<typeof RuleUpdateParams>;

/**
 * 편집 뒤 실행 자동 시작의 결과. `started` = 이 편집으로 실행을 만들었다, `pending` = 그 규칙이 대상인 시작 전 실행
 * (승인 대기 · 실행 대기)이 이미 있어 새로 만들지 않았다(그 실행이 시작할 때 새 진술을 읽는다), `skipped` = 하루 한도 ·
 * 설정 때문에 만들지 않았다(기록 없음, 응답에만 있음). 제목만 바뀌었거나 자동 시작이 실패하면 `null`.
 */
export const RuleEditAutoStart = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('started'),
    runId: Ulid,
    runDisplayId: displayIdSchema('EXE'),
  }),
  z.strictObject({
    state: z.literal('pending'),
    runId: Ulid,
    runDisplayId: displayIdSchema('EXE'),
  }),
  z.strictObject({
    state: z.literal('skipped'),
    reason: AutoStartSkipReason,
    missing: z.array(MissingSettingPath),
  }),
]);
export type RuleEditAutoStart = z.infer<typeof RuleEditAutoStart>;

export const RuleUpdateResult = z.strictObject({
  rule: Rule,
  judgment: RuleJudgment,
  /** 이 편집의 승인 기록 (`rule_edit`) */
  approvalLog: ApprovalLogEntry,
  autoStart: RuleEditAutoStart.nullable(),
});
export type RuleUpdateResult = z.infer<typeof RuleUpdateResult>;

/**
 * `judgment.list`: 규칙의 판정 이력(규칙 상세의 실행 이력, M1-28 · ADR-073). 판정 기록 테이블의 기록만
 * 최신부터 50건까지(같은 시각이면 ID가 큰 것 먼저). 실행 안의 판정이면 그 실행의 표시 ID(`EXE-NNN`)를 함께 싣고,
 * 실행 밖 판정이면 `null`. 삭제된 규칙도 돌려주고, 없는 규칙 · 제안 ID는 -32004.
 */
export const JudgmentListParams = z.strictObject({ projectId: Ulid, ruleId: Ulid });
export type JudgmentListParams = z.infer<typeof JudgmentListParams>;
export const RuleJudgmentEntry = z.strictObject({
  judgment: JudgmentResult,
  runDisplayId: displayIdSchema('EXE').nullable(),
});
export type RuleJudgmentEntry = z.infer<typeof RuleJudgmentEntry>;
export const JudgmentListResult = z.strictObject({ judgments: z.array(RuleJudgmentEntry) });
export type JudgmentListResult = z.infer<typeof JudgmentListResult>;

// ── 제안 · 승인 기록 (NRM-04, TODO-01, NFR-01, M1-09, ADR-050) ──
// - 모든 요청에 `projectId`가 필수다. 등록되지 않은 프로젝트 · 없는 제안은 -32004
// - 처리 요청(approve · amend · reject)은 주체 `author`를 싣고 사람(`human`)만 받는다. 에이전트 주체는 -32020.
//   토큰 인증 전 연결의 요청은 파이프 서버가 -32020으로 거부하고 연결을 닫는다 (ADR-041)
// - 이미 처리된(대기 아님) 제안의 처리는 -32009, 거절 사유가 비면 -32001(`data.reason = REJECT_REASON_REQUIRED`)
// - 수정 본문이 제안 종류의 본문 스키마와 맞지 않으면 -32001(`data.reason = EDITED_PAYLOAD_INVALID`)
// - 승인하면 같은 트랜잭션에서 규범(요구사항 · 규칙)을 만들고 승인 기록을 1건 추가한다
// - 사람이 규칙을 직접 고치는 RPC는 `rule.update`다(ADR-100 B②, ADR-109. 계약 `contract.update`는 M3-10)

/** 도메인 검증 실패(-32001)의 `error.data.reason` 값. */
export const DomainErrorReason = {
  /** 거절 사유가 비었다 (NRM-04) */
  RejectReasonRequired: 'REJECT_REASON_REQUIRED',
  /** 수정 본문이 제안 종류와 맞지 않는다 */
  EditedPayloadInvalid: 'EDITED_PAYLOAD_INVALID',
  /** 규칙 직접 편집의 제목 · 진술 형식 오류 (한 줄 · 길이 · EARS, `data.issues`) */
  RuleEditInvalid: 'RULE_EDIT_INVALID',
  /** 규칙 직접 편집에 바뀐 것이 없다 */
  RuleEditNoChange: 'RULE_EDIT_NO_CHANGE',
  /** 규칙화 불가 사유가 비었다 (공백만 포함, NRM-08 · ADR-137) */
  UnrulableReasonRequired: 'UNRULABLE_REASON_REQUIRED',
  /** 규칙화 불가 사유가 상한을 넘는다 (ADR-137) */
  UnrulableReasonInvalid: 'UNRULABLE_REASON_INVALID',
  /** 판정 격리 사유가 비었다 (공백만 포함, TODO-02 · ADR-145) */
  QuarantineReasonRequired: 'QUARANTINE_REASON_REQUIRED',
  /** 판정 격리 사유가 상한을 넘는다 (ADR-145) */
  QuarantineReasonInvalid: 'QUARANTINE_REASON_INVALID',
  /** 한도 상향 재개의 새 한도가 원 실행의 예산 값과 모양이 다르다 (역할 집합이 다름, M3-56 · ADR-149) */
  BudgetShapeMismatch: 'BUDGET_SHAPE_MISMATCH',
  /** 새 한도의 어느 값이 원 실행의 같은 값보다 작다 (내리기, ADR-147 ④) */
  BudgetLowered: 'BUDGET_LOWERED',
  /** 원 실행(사슬 전체)이 쓴 양이 이미 닿은 값을 새 한도가 쓴 양보다 크게 올리지 않았다 (ADR-147 ④) */
  BudgetNotAboveSpent: 'BUDGET_NOT_ABOVE_SPENT',
  /** 허용 목록 축소 재개의 제외 경로 목록이 비었다 (M3-58 · ADR-155) */
  WriteScopeExcludeRequired: 'WRITE_SCOPE_EXCLUDE_REQUIRED',
  /** 제외 경로의 형식 오류 (패턴 문법 · 길이 · 개수 · 중복, `data.fields`) */
  WriteScopeExcludeInvalid: 'WRITE_SCOPE_EXCLUDE_INVALID',
  /** 처음 목록(대상 블록 포함 경로의 합)이 빈다: 대상 블록이 없는 규칙뿐이거나 블록 선언이 없다 */
  WriteScopeAllowEmpty: 'WRITE_SCOPE_ALLOW_EMPTY',
} as const;
export type DomainErrorReason = (typeof DomainErrorReason)[keyof typeof DomainErrorReason];

/** `proposal.list`: 표시 ID 순. `state` · `kind`로 거른다 (생략하면 전부). */
export const ProposalListParams = z.strictObject({
  projectId: Ulid,
  state: ProposalState.optional(),
  kind: ProposalKind.optional(),
});
export type ProposalListParams = z.infer<typeof ProposalListParams>;
export const ProposalListResult = z.strictObject({ proposals: z.array(Proposal) });
export type ProposalListResult = z.infer<typeof ProposalListResult>;

/** `proposal.count`: 승인 대기 건수와 종류별 건수 (할 일 배지 · 툴팁, SCR-17). 모든 종류 키가 있다. */
export const ProposalCountParams = z.strictObject({ projectId: Ulid });
export type ProposalCountParams = z.infer<typeof ProposalCountParams>;
export const ProposalCountResult = z.strictObject({
  pending: z.int().nonnegative(),
  pendingByKind: z.record(ProposalKind, z.int().nonnegative()),
});
export type ProposalCountResult = z.infer<typeof ProposalCountResult>;

/** `proposal.get` · `proposal.markRead`: ID로 1건. markRead는 처음 읽은 시각만 남긴다. */
export const ProposalGetParams = z.strictObject({ projectId: Ulid, id: Ulid });
export type ProposalGetParams = z.infer<typeof ProposalGetParams>;
export const ProposalMarkReadParams = ProposalGetParams;
export type ProposalMarkReadParams = ProposalGetParams;
export const ProposalResult = z.strictObject({ proposal: Proposal });
export type ProposalResult = z.infer<typeof ProposalResult>;

/** `proposal.approve`: 그대로 승인, `edited`가 있으면 수정 후 승인 (본문 전체를 사람이 고친 값으로). */
export const ProposalApproveParams = z.strictObject({
  projectId: Ulid,
  id: Ulid,
  author: Author,
  edited: ProposalPayload.optional(),
});
export type ProposalApproveParams = z.infer<typeof ProposalApproveParams>;

/** `proposal.amend`: 수정 후 승인. `proposal.approve`에 `edited`를 실은 것과 같다. */
export const ProposalAmendParams = z.strictObject({
  projectId: Ulid,
  id: Ulid,
  author: Author,
  edited: ProposalPayload,
});
export type ProposalAmendParams = z.infer<typeof ProposalAmendParams>;

/** 승인으로 반영된 규범. */
export const AppliedNorm = z.discriminatedUnion('entity', [
  z.strictObject({ entity: z.literal('Requirement'), requirement: Requirement }),
  z.strictObject({ entity: z.literal('Rule'), rule: Rule }),
]);
export type AppliedNorm = z.infer<typeof AppliedNorm>;

export const ProposalApproveResult = z.strictObject({
  proposal: Proposal,
  applied: AppliedNorm,
  approvalLog: ApprovalLogEntry,
});
export type ProposalApproveResult = z.infer<typeof ProposalApproveResult>;

/** `proposal.reject`: 사유 필수. 빈 사유는 스키마가 아니라 도메인 검증(-32001)으로 거부한다. */
export const ProposalRejectParams = z.strictObject({
  projectId: Ulid,
  id: Ulid,
  author: Author,
  reason: z.string(),
});
export type ProposalRejectParams = z.infer<typeof ProposalRejectParams>;
export const ProposalRejectResult = z.strictObject({
  proposal: Proposal,
  approvalLog: ApprovalLogEntry,
});
export type ProposalRejectResult = z.infer<typeof ProposalRejectResult>;

/**
 * `approvalLog.list`: 승인 기록을 순번 순으로. `targetRef`로 거른다. 형식이 깨진 기록은 `entries`에서 빠진다.
 * `chain`은 거르기 전 전체 기록의 검증 결과다: 해시 체인 + 형식 + 처리된 제안마다 승인 기록이 있는지.
 * `brokenAtSeq` = 처음 어긋난 순번(기록이 없는 경우인 `decision_without_log`면 `null`), `reason` = 이유.
 */
export const ApprovalLogListParams = z.strictObject({
  projectId: Ulid,
  targetRef: EntityRef.optional(),
});
export type ApprovalLogListParams = z.infer<typeof ApprovalLogListParams>;
export const ApprovalLogListResult = z.strictObject({
  entries: z.array(ApprovalLogEntry),
  chain: z.strictObject({
    valid: z.boolean(),
    brokenAtSeq: z.int().positive().nullable(),
    reason: ApprovalLogBreakReason.nullable(),
  }),
});
export type ApprovalLogListResult = z.infer<typeof ApprovalLogListResult>;

// ── 규범 변경 기록 (ADR-100 C2 · A2, NRM-07, M7-02 #214, ADR-103) ─────
// - `normChange.list`: 에이전트 · 오케스트레이터 행동의 추가 전용 기록을 순번 순으로. `targetRef`로 거른다(대상 규범).
//   형식이 깨진 기록은 `entries`에서 빠지고, `chain`은 거르기 전 전체 기록의 해시 체인 · 형식 검증 결과다
// - 사유 · 상세의 글은 에이전트가 쓴 것이라 표시용 표기(제어 · 서식 문자 이스케이프)와 길이 상한을 거친 표시 값으로
//   내보낸다(ADR-089). 저장은 원문이고 `hash`는 원문 기준이다. 하나라도 잘렸으면 `textTruncated`가 `true`
// - 쓰기 RPC는 없다. 기록은 오케스트레이터가 규범 변경과 같은 트랜잭션에서 남긴다

/** 규범 변경 기록의 사유 · 상세 문자열 하나의 표시 상한 (UTF-16 코드 단위). */
export const NORM_CHANGE_TEXT_DISPLAY_MAX = 4000;

export const NormChangeListParams = z.strictObject({
  projectId: Ulid,
  targetRef: EntityRef.optional(),
});
export type NormChangeListParams = z.infer<typeof NormChangeListParams>;

/** 응답의 기록 1건: 저장된 기록과 같은 칸이되 사유 · 상세의 문자열은 표시 값이다. */
export const NormChangeView = z.strictObject({
  seq: z.int().positive(),
  at: Timestamp,
  kind: NormChangeKind,
  actor: NormChangeActor,
  targetRef: EntityRef,
  sessionId: Ulid.nullable(),
  runId: Ulid.nullable(),
  reason: z.string().max(NORM_CHANGE_TEXT_DISPLAY_MAX).nullable(),
  detail: NormChangeDetail,
  /** 사유 · 상세 문자열 가운데 상한 때문에 잘린 것이 있는지 */
  textTruncated: z.boolean(),
  prevHash: Sha256Hex,
  hash: Sha256Hex,
});
export type NormChangeView = z.infer<typeof NormChangeView>;

export const NormChangeListResult = z.strictObject({
  entries: z.array(NormChangeView),
  chain: z.strictObject({
    valid: z.boolean(),
    brokenAtSeq: z.int().positive().nullable(),
    reason: NormChangeBreakReason.nullable(),
  }),
});
export type NormChangeListResult = z.infer<typeof NormChangeListResult>;

// ── 확인 상태 (ADR-100 D2 · C1 · C2 · A2, NFR-01, M7-01) ─────
// - `confirmation.set`: 사람이 규범 항목(요구사항 · 규칙)을 보고 OK했다는 표시. 사람 주체만 받는다(에이전트 -32020).
//   없는 대상 -32004, 삭제된 대상 · 이미 확인됨 -32009. 확인은 승인 기록에 행동 `confirm`으로 남고(사람 행동만, C2)
//   확인 상태의 근거는 그 승인 기록 순번이다. 승인 기록 추가와 확인 상태 저장은 트랜잭션 1개다. 이미 확인됨이어도 사람이
//   아직 보지 않은 폐기 · 대체 · 테스트 변경 기록이 있는 규칙은 다시 확인한다("이 알림을 봤다", 폐기된 규칙도, M7-13 · ADR-113)
// - 확인을 푸는 RPC는 없다(확인 풀림은 에이전트 변경에 따라 오케스트레이터가 남긴다, M7-13). 역할 세션 도구에도 없다
// - 확인 상태는 요구사항 · 규칙 응답(`requirement.*` · `rule.*`)의 `confirmation`으로도 보인다

export const ConfirmationSetParams = z.strictObject({
  projectId: Ulid,
  target: ConfirmationTarget,
  author: Author,
});
export type ConfirmationSetParams = z.infer<typeof ConfirmationSetParams>;
export const ConfirmationSetResult = z.strictObject({
  target: ConfirmationTarget,
  confirmation: Confirmation,
  approvalLog: ApprovalLogEntry,
});
export type ConfirmationSetResult = z.infer<typeof ConfirmationSetResult>;

// ── 확인할 것 목록 (ADR-100 D3 · B⑦ · G · A7, NRM-07, M7-13 #225, ADR-113) ─────
// - `confirmation.list`: 사람이 볼 항목을 세 묶음 순서로 돌려준다. ① 에이전트의 폐기 · 대체(확인 여부와 무관, 확인 풀림은 그
//   항목의 `released`) ② 확인됨 규칙의 테스트 변경 알림 ③ 미확인 요구사항 · 규칙. ① · ②는 각각 시각 최신순(같으면 기록 순번
//   큰 것 먼저), ③은 마지막 수정 시각 최신순(같으면 표시 ID 순)
// - 항목은 사람이 그 대상을 [확인](`confirmation.set`)했을 때만 내려간다: ① · ②는 그 규칙의 승인 기록 `confirm` 가운데
//   `detail.seenNormChangeSeq`(확인 순간의 규범 변경 기록 마지막 순번)가 그 기록의 순번 이상인 것이 있으면, ③은 확인됨이면
//   빠진다. 사람의 편집 · 확인 행의 시각으로는 내려가지 않는다. 삭제된 대상은 빠진다. 폐기된 규칙은 ③에 오지 않는다(①에만)
// - 에이전트가 쓴 글(근거 · 사유 · 규칙 제목 · 진술 · 파일 경로)은 표시 값(ADR-089, 문자열마다 상한
//   {@link NORM_CHANGE_TEXT_DISPLAY_MAX})이고, 항목 수는 {@link CONFIRMATION_LIST_MAX_ITEMS}까지다(넘으면 `truncated`).
//   `total`은 자르기 전 항목 수이고 확인할 것 배지의 수다(항목마다 사람의 확인 1건을 기다린다)

/** `confirmation.list`가 돌려주는 항목 수 상한. */
export const CONFIRMATION_LIST_MAX_ITEMS = 200;

export const ConfirmationListParams = z.strictObject({ projectId: Ulid });
export type ConfirmationListParams = z.infer<typeof ConfirmationListParams>;

/** 항목이 가리키는 규칙 (지금의 ID · 표시 ID). */
const ConfirmationRuleRef = z.strictObject({ id: Ulid, displayId: displayIdSchema('RULE') });

/** 규칙 내용의 표시 값 (제목 · 진술). */
export const ConfirmationRuleText = z.strictObject({
  title: z.string().max(NORM_CHANGE_TEXT_DISPLAY_MAX),
  statement: z.string().max(NORM_CHANGE_TEXT_DISPLAY_MAX),
});
export type ConfirmationRuleText = z.infer<typeof ConfirmationRuleText>;

/**
 * 에이전트의 폐기 · 대체 1건 (규범 변경 기록 `retired` · `superseded` 1건).
 * - `before`: 폐기 직전 규칙 내용, `after`: 대체한 새 규칙(폐기만이면 `null`). 기록의 모양이 깨졌으면 `null`
 * - `grounds`: 근거(폐기 · 대체 기록의 사유), `rationale`: 새 규칙의 사유(대체의 신규 기록 사유, 폐기만이면 `null`)
 * - `released`: 사람이 확인한 규칙이었으면 같은 트랜잭션의 확인 풀림 기록(순번 · 시각), 아니면 `null`
 */
export const ConfirmationRetirementItem = z.strictObject({
  kind: ConfirmationItemKind.extract(['retired', 'superseded']),
  seq: z.int().positive(),
  at: Timestamp,
  actor: NormChangeActor,
  sessionId: Ulid.nullable(),
  rule: ConfirmationRuleRef,
  before: ConfirmationRuleText.nullable(),
  after: ConfirmationRuleText.extend({ rule: ConfirmationRuleRef }).nullable(),
  grounds: z.string().max(NORM_CHANGE_TEXT_DISPLAY_MAX).nullable(),
  rationale: z.string().max(NORM_CHANGE_TEXT_DISPLAY_MAX).nullable(),
  released: z.strictObject({ seq: z.int().positive(), at: Timestamp }).nullable(),
  /** 대상 규칙의 위험도 (선택 칸, M3-01 #46. 값이 없는 규칙이면 칸이 없다) */
  risk: Risk.optional(),
  textTruncated: z.boolean(),
});
export type ConfirmationRetirementItem = z.infer<typeof ConfirmationRetirementItem>;

/** 테스트 변경 알림 1건 (규범 변경 기록 `test_changed` 1건). 파일 경로는 표시 값이다. */
export const ConfirmationTestChangeItem = z.strictObject({
  kind: z.literal(ConfirmationItemKind.enum.test_changed),
  seq: z.int().positive(),
  at: Timestamp,
  rule: ConfirmationRuleRef,
  title: z.string().max(NORM_CHANGE_TEXT_DISPLAY_MAX),
  runId: Ulid,
  runDisplayId: displayIdSchema('EXE').nullable(),
  sessionId: Ulid.nullable(),
  files: z.array(
    z.strictObject({
      path: z.string().max(NORM_CHANGE_TEXT_DISPLAY_MAX),
      change: NormTestChangeFile.shape.change,
    }),
  ),
  fileCount: z.int().positive(),
  /** 대상 규칙의 위험도 (선택 칸, M3-01 #46. 값이 없는 규칙이면 칸이 없다) */
  risk: Risk.optional(),
  textTruncated: z.boolean(),
});
export type ConfirmationTestChangeItem = z.infer<typeof ConfirmationTestChangeItem>;

/** 미확인 요구사항 · 규칙 1건. `text`는 요구사항 본문 · 규칙 제목의 표시 값, `at`은 마지막 수정 시각이다. */
export const ConfirmationNormItem = z.strictObject({
  kind: z.literal(ConfirmationItemKind.enum.unconfirmed_norm),
  at: Timestamp,
  target: ConfirmationTarget,
  displayId: z.string().min(1),
  text: z.string().max(NORM_CHANGE_TEXT_DISPLAY_MAX),
  author: Author,
  /** 규칙의 위험도 (선택 칸, M3-01 #46. 요구사항 · 값이 없는 규칙이면 칸이 없다) */
  risk: Risk.optional(),
  textTruncated: z.boolean(),
});
export type ConfirmationNormItem = z.infer<typeof ConfirmationNormItem>;

export const ConfirmationItem = z.union([
  ConfirmationRetirementItem,
  ConfirmationTestChangeItem,
  ConfirmationNormItem,
]);
export type ConfirmationItem = z.infer<typeof ConfirmationItem>;

/** 자르기 전 항목 수의 종류별 내역 (M7-14 #226, ADR-119: 항목이 잘려도 할 일 툴팁의 종류별 건수 합이 `total`과 같게). */
export const ConfirmationKindCounts = z.strictObject({
  retired: z.int().nonnegative(),
  superseded: z.int().nonnegative(),
  test_changed: z.int().nonnegative(),
  unconfirmed_norm: z.int().nonnegative(),
}) satisfies z.ZodType<Record<ConfirmationItemKind, number>>;
export type ConfirmationKindCounts = z.infer<typeof ConfirmationKindCounts>;

export const ConfirmationListResult = z
  .strictObject({
    items: z.array(ConfirmationItem).max(CONFIRMATION_LIST_MAX_ITEMS),
    /** 자르기 전 항목 수 (확인할 것 배지의 수) */
    total: z.int().nonnegative(),
    truncated: z.boolean(),
    /** 자르기 전 종류별 항목 수 (선택 칸, M7-14. 오케스트레이터는 늘 채운다). 있으면 합이 `total`이다 */
    totalByKind: ConfirmationKindCounts.optional(),
  })
  .refine(
    (result) =>
      result.totalByKind === undefined ||
      Object.values(result.totalByKind).reduce((sum, n) => sum + n, 0) === result.total,
    { message: '종류별 항목 수의 합이 전체 항목 수와 다릅니다', path: ['totalByKind'] },
  );
export type ConfirmationListResult = z.infer<typeof ConfirmationListResult>;

// ── 프로젝트 (PRJ-01, M1-01, ADR-025 · ADR-036 · ADR-040 · ADR-054) ─────────
// - `project.open`: 폴더를 연다. 루트 `.bive.json`이 없으면 새 프로젝트 ID로 등록하고 파일을 만든다
//   (`created: true`). 있으면 그 ID로 진입하고 파일은 다시 쓰지 않는다. `empty`는 `.bive.json` 외 항목이 없는 폴더
// - 경로가 절대 경로가 아니면 -32602, 없는 경로는 -32004, 폴더가 아니거나 설정 파일 형식이 틀리면 -32001,
//   다른 경로에 등록된 프로젝트 ID면 -32009
// - `project.current`: 이 오케스트레이터가 마지막으로 연 프로젝트(없으면 null). `project.list`: 등록된 프로젝트 전부

/** OS와 무관한 절대 경로 판별 (`/…`, `C:\…`, `\\서버\…`). 렌더러 · main · 오케스트레이터가 같은 기준을 쓴다. */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/** 프로젝트 폴더 경로. 절대 경로만 받는다(상대 경로의 기준 폴더는 프로세스마다 다르다). */
export const ProjectPath = z
  .string()
  .min(1)
  .refine((value) => ABSOLUTE_PATH.test(value), '절대 경로가 아닙니다')
  .refine((value) => !value.includes('\0'), '경로에 NUL 문자가 있습니다');

export const ProjectOpenParams = z.strictObject({ path: ProjectPath });
export type ProjectOpenParams = z.infer<typeof ProjectOpenParams>;

export const ProjectOpenResult = z.strictObject({
  project: Project,
  /** 이번 호출이 `.bive.json`을 만들었는지 (미연결 폴더) */
  created: z.boolean(),
  /** `.bive.json` 말고는 아무 항목도 없는 폴더인지 (빈 폴더, SCR-01 · ADR-036) */
  empty: z.boolean(),
});
export type ProjectOpenResult = z.infer<typeof ProjectOpenResult>;

export const ProjectCurrentParams = z.undefined();
export const ProjectCurrentResult = z.strictObject({ project: Project.nullable() });
export type ProjectCurrentResult = z.infer<typeof ProjectCurrentResult>;

export const ProjectListParams = z.undefined();
export const ProjectListResult = z.strictObject({ projects: z.array(Project) });
export type ProjectListResult = z.infer<typeof ProjectListResult>;

// ── 설정 (COST-01, NFR-07, SCR-21, M1-05, ADR-057) ───────────
// - 모든 요청에 `projectId`가 필수다. 등록되지 않은 프로젝트는 -32004
// - `settings.update`는 주체 `author`를 싣고 사람(`human`)만 받는다. 에이전트 주체는 -32020
// - 저장은 미설정(`null`)을 허용하고, 실행 전 검사는 `settings.validateForRun`이 한다.
//   실행 생성 등 설정이 필요한 요청은 미설정이면 -32010(`data.reason = SETTINGS_INCOMPLETE`)으로 거부한다

/** 설정 미비(-32010)의 `error.data.reason` 값과 사람이 읽는 메시지. */
export const SETTINGS_INCOMPLETE_REASON = 'SETTINGS_INCOMPLETE';
export const SETTINGS_INCOMPLETE_MESSAGE = '예산 · 모델 미설정';

/** -32010 오류의 `data`: 이유 + 비어 있는 항목 경로. */
export const SettingsIncompleteData = z.strictObject({
  reason: z.literal(SETTINGS_INCOMPLETE_REASON),
  missing: z.array(MissingSettingPath).min(1),
});
export type SettingsIncompleteData = z.infer<typeof SettingsIncompleteData>;

/** `settings.get`: 프로젝트 설정. 한 번도 저장하지 않았으면 기본값(전부 미설정, 변경 주체 · 시각 `null`). */
export const SettingsGetParams = z.strictObject({ projectId: Ulid });
export type SettingsGetParams = z.infer<typeof SettingsGetParams>;
export const SettingsResult = z.strictObject({ settings: Settings });
export type SettingsResult = z.infer<typeof SettingsResult>;

/** 역할 하나의 바꿀 값. 없는 키는 그대로, `null`은 미설정으로 되돌린다. */
export const RoleSettingsPatch = RoleSettings.partial();
export type RoleSettingsPatch = z.infer<typeof RoleSettingsPatch>;

/**
 * `settings.update`의 `patch`: 예산 · 모델 (M1, ADR-010 · ADR-035)과 코드 열기 IDE (M2-03, ADR-087). 없는 키는 그대로 둔다.
 * IDE는 고를 수만 있고 미설정(`null`)으로 되돌리지 않는다. 사용자 지정 틀은 저장할 때 허용 범위를 검사한다(`IdeUrlTemplate`).
 * 프로젝트 하루 예산 한도(M7-04, ADR-104)는 `null`이면 비움(한도 없음)으로 되돌린다.
 * 승인 대기 상한 · 잠정 승인 · 자동 모드 · 설치 허용 목록은 그 화면을 여는 이슈가 키를 더한다.
 */
export const SettingsPatch = z.strictObject({
  run: RunLimits.partial().optional(),
  roles: z.partialRecord(AgentRole, RoleSettingsPatch).optional(),
  dailyBudgetUsd: DailyBudgetUsd.optional(),
  ide: IdeSetting.optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** `settings.update`: 사람만. 바꾼 뒤 `updatedAt` · `updatedBy`가 요청 시각 · 주체가 된다. */
export const SettingsUpdateParams = z.strictObject({
  projectId: Ulid,
  patch: SettingsPatch,
  author: Author,
});
export type SettingsUpdateParams = z.infer<typeof SettingsUpdateParams>;

/**
 * `settings.validateForRun`: 실행 전 설정 검사 (NFR-07). `roles`를 생략하면 M1 필수 역할
 * (rule-writer · test-writer · implementer). 실행 전체 한도(USD · 턴)는 항상 검사한다.
 */
export const SettingsValidateParams = z.strictObject({
  projectId: Ulid,
  roles: z.array(AgentRole).min(1).optional(),
});
export type SettingsValidateParams = z.infer<typeof SettingsValidateParams>;

/**
 * 검사 결과. 통과면 `{ ok: true }`, 아니면 -32010 오류와 같은 코드 · 이유 · 메시지와 비어 있는 항목.
 * 화면은 이 결과로 검증 상태를 보이고, 실행 생성(`run.create`) 등은 같은 내용을 -32010 오류로 돌려준다.
 */
export const SettingsValidateResult = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    code: z.literal(ErrorCode.SettingsIncomplete),
    reason: z.literal(SETTINGS_INCOMPLETE_REASON),
    message: z.literal(SETTINGS_INCOMPLETE_MESSAGE),
    missing: z.array(MissingSettingPath).min(1),
  }),
]);
export type SettingsValidateResult = z.infer<typeof SettingsValidateResult>;

// ── 실행 (RUN-01, RUN-02, NFR-07, M1-12, ADR-061) ─────────────
// - 모든 요청에 `projectId`가 필수다. 등록되지 않은 프로젝트 · 없는 실행은 -32004
// - `run.create`는 실행 시작 확인이다. 주체 `author`를 싣고 사람(`human`)만 받는다(에이전트 주체 -32020).
//   설정(실행 전체 한도 · M1 필수 역할의 모델 · 한도)이 비면 -32010(`data.reason = SETTINGS_INCOMPLETE`)이고
//   실행을 만들지 않는다. 없는 규칙 -32004, 삭제된 규칙 -32009, 대상 규칙 중복 -32602
// - 만든 실행은 유형 A · 상태 `waiting_approval` · 현재 단계 승인이고, 같은 트랜잭션에서 승인 기록
//   `run_start`(대상 규칙 포함)를 1건 추가한다. 승인 단계의 판정과 이후 단계 진행은 오케스트레이터 엔진이 한다
// - `run.get`의 `id`는 ULID 또는 표시 ID(`EXE-001`)
// - `run.resume`은 `interrupted` 실행만 받는다(사람 주체, ADR-066). 다른 실행이 `running`이면 -32009(ADR-105)
// - 프로젝트당 진행 중 실행은 1개다(ADR-100 B⑥, ADR-105): 승인 단계를 통과할 때 진행 중 · 중단된 실행이나 실행 대기가
//   있으면 `queued`(실행 대기)가 되고, 자리가 나면 생성 순으로 시작한다. 생성 응답의 상태는 생성 직후의 `waiting_approval`

/** 대상 규칙 ID 목록: 1개 이상, 중복 없음. 순서는 요청 그대로 저장한다. */
export const RunTargetRuleIds = z
  .array(Ulid)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, '대상 규칙이 중복됐습니다');

/**
 * `run.create`: 실행 시작 확인 (RUN-01, RUN-02, RUN-07). `type`을 주지 않으면 대상 규칙으로 정한다(인수 테스트 검사 규칙만이면 A,
 * 정적 검사 규칙(구조 · 계약)만이면 B, 섞이면 거부). C · D는 줄 때만 만든다 (ADR-136).
 */
export const RunCreateParams = z.strictObject({
  projectId: Ulid,
  ruleIds: RunTargetRuleIds,
  author: Author,
  type: RunType.optional(),
});
export type RunCreateParams = z.infer<typeof RunCreateParams>;

/** 실행 1건과 단계 목록(파이프라인 순서 → 시도 번호 순). 비용 · 턴 집계는 `run.get`의 `usage`(ADR-067). */
export const RunDetailResult = z.strictObject({ run: Run, steps: z.array(Step) });
export type RunDetailResult = z.infer<typeof RunDetailResult>;

export const RunCreateResult = z.strictObject({
  run: Run,
  steps: z.array(Step),
  approvalLog: ApprovalLogEntry,
});
export type RunCreateResult = z.infer<typeof RunCreateResult>;

/** 실행을 가리키는 값: ULID 또는 표시 ID(`EXE-NNN`). */
export const RunRef = z.union([Ulid, displayIdSchema('EXE')]);
export type RunRef = z.infer<typeof RunRef>;

export const RunGetParams = z.strictObject({ projectId: Ulid, id: RunRef });
export type RunGetParams = z.infer<typeof RunGetParams>;

/**
 * `run.get`의 세션 항목 (RUN-04 · RUN-08, ADR-100 A15, ADR-108): 실행의 에이전트 세션을 시작 순으로. `normInput`은 그 세션이
 * 작업 지시로 받은 규범 입력의 기록(수 · 잘린 사실 · 실은 표시 ID)이고, 규범 입력을 받지 않은 세션(이 기록이 생기기 전
 * 세션 포함)은 `null`. 비용 · 턴은 `usage`가 맡는다.
 */
export const RunSessionEntry = z.strictObject({
  id: Ulid,
  stepId: Ulid,
  role: AgentRole,
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  endReason: SessionEndReason.nullable(),
  normInput: SessionNormInput.nullable(),
});
export type RunSessionEntry = z.infer<typeof RunSessionEntry>;

/**
 * `run.get` 결과: 실행 · 단계 + 비용 · 턴 집계 `usage` (COST-02, ADR-067). `usage`는 조회 시점의 세션 기록으로 만든다
 * (진행 중 세션은 값이 없어 합계에 들어가지 않는다). 값이 없으면 `null`이고 화면은 '없음'으로 보인다. `sessions`는 세션 항목
 * ({@link RunSessionEntry}).
 */
export const RunGetResult = z.strictObject({
  run: Run,
  steps: z.array(Step),
  usage: RunUsage,
  sessions: z.array(RunSessionEntry),
});
export type RunGetResult = z.infer<typeof RunGetResult>;

/**
 * `run.list`: 표시 ID 순(= 생성 순). `status`로 거른다 (생략하면 전부). `ruleId`를 주면 그 규칙의 실행 이력에 드는 실행만
 * (그 규칙이 대상인 실행 + 그 규칙의 판정 기록이 있는 실행, 규칙 상세의 실행 이력, M3-42 #283 · ADR-135). 없는 규칙 ID는 -32004.
 * 결과 형식은 같다. 결과의 `failureNotes`(선택 칸)는 목록 안 실행의 종료 사유 보조 표시다({@link RunFailureNote}).
 */
export const RunListParams = z.strictObject({
  projectId: Ulid,
  status: RunStatus.optional(),
  ruleId: Ulid.optional(),
});
export type RunListParams = z.infer<typeof RunListParams>;
/**
 * 블록 선언 겹침으로 끝난 실행의 겹친 파일 목록 상한 (M3-51 #296, ADR-144). 구조 위반 판정 기록 케이스의 상한(오케스트레이터
 * `MAX_STRUCTURE_CASES`)과 같은 값이다(시험이 대조한다). 넘는 수는 `total`로 드러난다.
 */
export const RUN_OVERLAP_FILES_LIMIT = 20;

/** 겹친 파일 한 개: 경로(판정 기록의 케이스 위치와 같은 표시 값) · 그 파일의 포함 경로에 맞은 블록 이름(선언 순서, 둘 이상). */
export const RunOverlapFile = z.strictObject({
  file: z.string().min(1),
  blocks: z.array(BlockName).min(2).max(BLOCK_LIMITS.blocks),
});
export type RunOverlapFile = z.infer<typeof RunOverlapFile>;

/**
 * 실행 종료 사유의 보조 표시 (`run.list`의 선택 칸, M3-51 #296, ADR-144). 그 실행을 끝낸 단계 시도의 결과(`exitDetail`)에서
 * 오케스트레이터가 만든다. 에이전트 · 실행기의 글은 싣지 않는다.
 * - `block_declaration_overlap`: 블록 선언 겹침으로 끝난 실행의 겹친 파일(앞 {@link RUN_OVERLAP_FILES_LIMIT}개)과 전체 수
 * - `builtin_rules_missing`: 블록 선언은 있는데 내장 구조 규칙 행이 없어 실행 상태 불일치로 끝난 실행 (블록 선언을 다시 저장하면
 *   없는 규칙이 생긴다, ADR-127 ①)
 */
export const RunFailureNote = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('block_declaration_overlap'),
    runId: Ulid,
    files: z.array(RunOverlapFile).max(RUN_OVERLAP_FILES_LIMIT),
    total: z.int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal('builtin_rules_missing'), runId: Ulid }),
]);
export type RunFailureNote = z.infer<typeof RunFailureNote>;

/** `run.list` 결과. `failureNotes`는 선택 칸이다(옛 오케스트레이터의 응답에는 없다, ADR-144). */
export const RunListResult = z.strictObject({
  runs: z.array(Run),
  failureNotes: z.array(RunFailureNote).optional(),
});
export type RunListResult = z.infer<typeof RunListResult>;

/**
 * `run.resume`: 중단(`interrupted`)된 실행을 사람이 재개한다 (PRD 5.1, ADR-011 · ADR-027 · ADR-066).
 * 주체는 사람만(에이전트 -32020), `interrupted`가 아니면 -32009, 없는 실행 -32004. 결과는 재개 직후(`running`)의
 * 실행과 단계. 워크트리를 마지막 완료 단계 커밋으로 되돌린 뒤 지금 단계를 새 시도 · 새 세션으로 이어간다.
 */
export const RunResumeParams = z.strictObject({ projectId: Ulid, id: RunRef, author: Author });
export type RunResumeParams = z.infer<typeof RunResumeParams>;

// ── 도구 호출 기록 (NFR-01 · NFR-02 · RUN-08, M1-38, ADR-052 · ADR-083) ──
// - 사람(앱 · CLI)이 실행의 도구 호출 기록을 읽는 조회 전용 RPC다. 이 이름 공간에는 `list`만 둔다(기록은 도구 실행기만 쓴다)
// - 역할 세션의 도구(MCP)에는 없다. 인증된 파이프 연결에서만 처리된다
// - 인자 · 결과 원문은 싣지 않는다. 파일 도구(읽기 · 쓰기 · 목록 · 검색)의 대상 경로만 `path`로 싣는다
// - 없는 실행 · 다른 프로젝트의 실행 · 등록되지 않은 프로젝트는 -32004

/** 한 번에 돌려주는 도구 호출 기록 상한. 넘으면 앞에서부터 이만큼과 `truncated: true`. */
export const TOOL_CALL_LIST_LIMIT = 500;

/**
 * `toolCall.list` 항목의 도구 이름 · 경로 길이 상한 (UTF-16 코드 단위, M2-06, ADR-089). 값은 제어 문자(Cc) · 서식 문자(Cf:
 * 양방향 제어 · 영폭 문자 · 태그 문자 등) · 줄 · 문단 구분(Zl · Zp) · 짝 없는 서로게이트 · 한글 채움 문자를 `\n` · `\uXXXX`
 * 표기로(BMP 밖은 서로게이트 쌍 두 표기), 역슬래시를 `\\`로 바꾼 표시용 문자열이다. 변형 선택자 · 결합 문자는 그대로다.
 * 바꾼 결과가 상한을 넘으면 도구 이름은 앞을 남기고 끝에 `…`, 경로는 앞 1/3과 뒤 2/3를 남기고 가운데에 `…`를 넣는다
 * (`nameTruncated` · `pathTruncated`가 `true`).
 */
export const TOOL_CALL_NAME_DISPLAY_MAX = 128;
export const TOOL_CALL_PATH_DISPLAY_MAX = 1024;

/** `toolCall.list`: 실행(ULID 또는 표시 ID `EXE-NNN`)의 도구 호출 기록. */
export const ToolCallListParams = z.strictObject({ projectId: Ulid, runId: RunRef });
export type ToolCallListParams = z.infer<typeof ToolCallListParams>;

/** 도구 호출 1건의 조회 결과. 세션 안 순번 `seq`는 0부터. 단계 시도가 없는 세션이면 `step`이 `null`. */
export const ToolCallEntry = z.strictObject({
  sessionId: Ulid,
  seq: z.int().nonnegative(),
  at: Timestamp,
  role: AgentRole,
  step: z.strictObject({ kind: StepKind, attempt: z.int().positive() }).nullable(),
  /**
   * 도구 이름(모르는 도구면 에이전트가 부른 그대로, 빈 문자열이면 빈 문자열 그대로, ADR-094). 표시용 표기 · 상한은
   * {@link TOOL_CALL_NAME_DISPLAY_MAX}
   */
  name: z.string().max(TOOL_CALL_NAME_DISPLAY_MAX),
  /** `name`이 상한 때문에 잘렸는지 (목록 상한의 `truncated`와 다르다) */
  nameTruncated: z.boolean(),
  status: ToolCallStatus,
  reason: z.string().min(1).nullable(),
  /**
   * 파일 도구의 대상 경로(에이전트가 넘긴 값의 표시용 표기, 상한 {@link TOOL_CALL_PATH_DISPLAY_MAX}). 그 밖의 도구 ·
   * 경로가 없거나 경로로 읽을 수 없는 기록은 `null`
   */
  path: z.string().min(1).max(TOOL_CALL_PATH_DISPLAY_MAX).nullable(),
  /** `path`가 상한 때문에 잘렸는지. `path`가 `null`이면 `false` */
  pathTruncated: z.boolean(),
});
export type ToolCallEntry = z.infer<typeof ToolCallEntry>;

/** 시각 → 세션 → 순번 순. 상한을 넘으면 `truncated`가 `true`. */
export const ToolCallListResult = z.strictObject({
  runId: Ulid,
  displayId: displayIdSchema('EXE'),
  calls: z.array(ToolCallEntry).max(TOOL_CALL_LIST_LIMIT),
  truncated: z.boolean(),
});
export type ToolCallListResult = z.infer<typeof ToolCallListResult>;

// ── 규칙 작성 세션 기록 (NRM-02, NFR-03, SCR-02, M3-26, ADR-062 · ADR-099) ──
// - 요구사항별로 가장 최근 규칙 작성 시도 하나의 상태를 읽는 조회 전용 RPC. 값은 저장된 시도 기록
//   (`rule_writer_requests`)과 세션 기록(`sessions`)에서만 만든다(NFR-03). 오케스트레이터 메모리는 읽지 않는다
// - 오류 문장은 어댑터 · 외부에서 온 문자열일 수 있어 표시용 표기(제어 · 서식 문자 이스케이프, ADR-089)와 길이 상한을 거친다

/** 오류 문장 표시 상한 (UTF-16 코드 단위). 넘으면 앞을 남기고 끝에 `…`, `errorTruncated`가 `true`. */
export const RULE_WRITER_ERROR_DISPLAY_MAX = 500;

/** `ruleWriter.status`: 프로젝트(또는 요구사항 하나)의 요구사항별 최근 규칙 작성 시도. */
export const RuleWriterStatusParams = z.strictObject({
  projectId: Ulid,
  requirementId: Ulid.optional(),
});
export type RuleWriterStatusParams = z.infer<typeof RuleWriterStatusParams>;

/**
 * 규칙 작성 세션 뒤의 실행 자동 시작 결과 (M7-05 #217, ADR-107). 시작했으면 그 실행(규범 변경 기록의 자동 시작 항목에서),
 * 하지 않았으면 저장된 생략 사유. 세션이 규칙을 만들지 못했거나 정상 종료가 아니면 결과가 없다(`null`).
 */
export const RuleWriterAutoStart = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('started'),
    runId: Ulid,
    runDisplayId: displayIdSchema('EXE'),
  }),
  z.strictObject({
    state: z.literal('skipped'),
    reason: AutoStartSkipReason,
    /** `settings_incomplete`일 때 비어 있던 설정 항목 */
    missing: z.array(MissingSettingPath),
  }),
]);
export type RuleWriterAutoStart = z.infer<typeof RuleWriterAutoStart>;

/** 요구사항 하나의 가장 최근 규칙 작성 시도. */
export const RuleWriterStatusEntry = z.strictObject({
  requirementId: Ulid,
  /** 시도 ID (세션을 열었으면 세션 ID와 같다) */
  attemptId: Ulid,
  state: RuleWriterState,
  /** `skipped`일 때만 */
  skipReason: RuleWriterSkipReason.nullable(),
  /** `settings_incomplete`일 때 비어 있던 설정 항목 */
  missing: z.array(MissingSettingPath),
  /** `ended`일 때만 */
  endReason: SessionEndReason.nullable(),
  /** 생략 · 실패 설명의 표시용 표기 (상한 {@link RULE_WRITER_ERROR_DISPLAY_MAX}). 없으면 `null` */
  error: z.string().min(1).max(RULE_WRITER_ERROR_DISPLAY_MAX).nullable(),
  /** `error`가 상한 때문에 잘렸는지. `error`가 `null`이면 `false` */
  errorTruncated: z.boolean(),
  /** 시도를 받은 시각 */
  requestedAt: Timestamp,
  /** 끝난(생략된) 시각. 대기 · 진행 중이면 `null` */
  endedAt: Timestamp.nullable(),
  /** 이 시도 뒤의 실행 자동 시작 결과. 없으면 `null` */
  autoStart: RuleWriterAutoStart.nullable(),
});
export type RuleWriterStatusEntry = z.infer<typeof RuleWriterStatusEntry>;

/** 시도 기록이 있는 요구사항만, 요구사항 ID 순. */
export const RuleWriterStatusResult = z.strictObject({
  entries: z.array(RuleWriterStatusEntry),
});
export type RuleWriterStatusResult = z.infer<typeof RuleWriterStatusResult>;

// ── 검증 (JDG-03, COST-02, SCR-05, M1-18, ADR-072) ───────────
// - 화면 하나(검증)가 한 번에 읽는 값을 저장소 한 번 열기로 모은다. 값은 규칙 · 판정 기록 · 실행 · 세션 기록에서만 만든다(NFR-03)
// - 판정 기준 = 가장 최근에 병합된 실행의 기준 브랜치 · 병합 커밋. 병합된 실행이 없으면 `null`
// - 판정 = 판정 기준 커밋에서 낸 규칙별 판정(기준 실행의 병합 재검사, 없으면 검사 단계). 그 커밋에서 판정되지 않은
//   규칙과 판정 기준이 없을 때는 미판정 (screens.md SCR-05 "화면의 모든 판정이 이 커밋 기준")
// - 준수 = 판정 가능(분모) 규칙 중 위 판정이 통과인 수 / 분모 수. 분모 = 효력 있는(폐기 제외) 규칙 중 위 판정이
//   격리가 아닌 것 (JDG-03). 사람 확인 기준 = 같은 계산을 확인됨 규칙으로 좁힌 것, 효력 있는 확인됨 규칙이 없으면 `null`
//   (ADR-100 D7, ADR-117). 확인 상태는 표시용 집계일 뿐 판정 · 병합의 조건이 아니다
// - 에이전트 폐기 수 = 규범 변경 기록의 에이전트 폐기 · 대체 대상 규칙 수, 전체 누적 (ADR-100 B⑦, ADR-117)
// - 실행당 비용 = 끝난 실행 중 세션 비용을 모두 아는 실행의 비용 평균. 그런 실행이 없으면 `null` ('없음', COST-02)
// - 규칙 목록의 실행 링크 = 위 판정의 실행(판정 기준 실행)과 그 실행의 비용 합계 · 턴(값 없으면 `null`)
// - 파이프라인 = 가장 최근에 만든 실행의 단계 순서(유형의 단계 계획)와 단계별 마지막 시도 상태. 실행이 없으면 `null`

/** 판정 기준: 병합된 실행이 병합한 기준 브랜치와 병합 커밋. */
export const VerificationBasis = z.strictObject({
  branch: z.string().min(1),
  commit: CommitSha,
  runId: Ulid,
});
export type VerificationBasis = z.infer<typeof VerificationBasis>;

/** 실행 링크: 실행 표시 ID와 비용 합계 · 턴 (ADR-067 `usage.run`, 값 없으면 `null`). */
export const VerificationRunLink = z.strictObject({
  id: Ulid,
  displayId: displayIdSchema('EXE'),
  costUsd: UsdOrNull,
  turns: z.int().nonnegative().nullable(),
});
export type VerificationRunLink = z.infer<typeof VerificationRunLink>;

/** 규칙 목록의 한 줄: 규칙 · 판정 기준 커밋에서의 최신 판정 · 그 판정의 실행 링크(미판정이면 `null`). */
export const VerificationRuleRow = z.strictObject({
  rule: Rule,
  judgment: RuleJudgment,
  run: VerificationRunLink.nullable(),
});
export type VerificationRuleRow = z.infer<typeof VerificationRuleRow>;

/** 파이프라인 단계 하나: 단계 계획의 단계와 그 단계의 마지막 시도 상태 (시도가 없으면 `pending`). */
export const VerificationStage = z.strictObject({
  kind: StepKind,
  status: StepStatus,
  attempt: z.int().nonnegative(),
});
export type VerificationStage = z.infer<typeof VerificationStage>;

/**
 * 파이프라인: 보일 실행과 단계 계획 순서의 단계 (현재 단계는 `run.currentStep`). 보일 실행은 프로젝트의 자리를 차지한
 * 실행(진행 중, 없으면 가장 먼저 만든 중단)이고, 없으면 가장 최근에 만든 실행이다(ADR-105). `queued`는 그 실행 밖의
 * 실행 대기 건수다.
 */
export const VerificationPipeline = z.strictObject({
  run: Run,
  stages: z.array(VerificationStage).min(1),
  queued: z.int().nonnegative(),
});
export type VerificationPipeline = z.infer<typeof VerificationPipeline>;

/** 변이 검증됨 집계 (ADR-146): 변이 기록이 있는 효력 규칙 수와 그 가운데 가장 나중 기록이 '변이 검증됨'인 수. */
export const VerificationMutationTally = z
  .strictObject({ verified: z.int().nonnegative(), tested: z.int().nonnegative() })
  .refine(
    ({ verified, tested }) => verified <= tested,
    '변이 검증됨 수가 변이 기록 규칙 수보다 큽니다',
  );
export type VerificationMutationTally = z.infer<typeof VerificationMutationTally>;

/** 준수 통과 수 · 판정 가능 수 (`verification.summary`의 `compliance`와 같은 모양). */
const ComplianceTally = z
  .strictObject({ passed: z.int().nonnegative(), judgeable: z.int().nonnegative() })
  .refine(({ passed, judgeable }) => passed <= judgeable, '통과 수가 판정 가능 수보다 큽니다');

export const VerificationSummaryParams = z.strictObject({ projectId: Ulid });
export type VerificationSummaryParams = z.infer<typeof VerificationSummaryParams>;

export const VerificationSummaryResult = z
  .strictObject({
    basis: VerificationBasis.nullable(),
    compliance: z.strictObject({
      passed: z.int().nonnegative(),
      judgeable: z.int().nonnegative(),
    }),
    /** 분모 목록: 판정 가능 규칙 ID (표시 ID 순) */
    denominator: z.array(Ulid),
    /**
     * 사람 확인 기준 준수 (ADR-100 D7, ADR-117): 전체 기준의 분모를 확인됨 규칙으로 좁힌 통과 수 · 판정 가능 수와, 효력 있는
     * 확인됨 규칙 수(`confirmed`, 격리 포함). 효력 있는 확인됨 규칙이 없으면 `null`(0 / 0이 아니다). 확인됨 규칙은 있는데
     * 판정 가능한 것이 없으면 `judgeable: 0`이고 `confirmed`는 1 이상이다
     */
    confirmedCompliance: z
      .strictObject({
        passed: z.int().nonnegative(),
        judgeable: z.int().nonnegative(),
        confirmed: z.int().positive(),
      })
      .nullable(),
    /** 사람 확인 기준 분모 목록: 판정 가능하고 확인됨인 규칙 ID (표시 ID 순, 전체 기준 분모의 부분 집합) */
    confirmedDenominator: z.array(Ulid),
    /**
     * 에이전트가 폐기한 규칙 수 (ADR-100 B⑦, ADR-117): 규범 변경 기록의 에이전트 폐기(`retired`) · 대체(`superseded`)
     * 대상 규칙 수(전체 누적, 규칙마다 1)
     */
    agentRetiredRules: z.int().nonnegative(),
    /** 추적성 결함 (NRM-06, ADR-137): `rule.list`의 `traceability`와 같은 함수로 정한다 */
    traceability: Traceability,
    /**
     * 규칙화 불가 비율 (NRM-08, ADR-137): '규칙화 불가' 요구사항 수 / 삭제되지 않은 요구사항 수. 화면은 `total`이 0이면 '없음'이다
     */
    unrulable: z
      .strictObject({ count: z.int().nonnegative(), total: z.int().nonnegative() })
      .refine(({ count, total }) => count <= total, '규칙화 불가 수가 요구사항 수보다 큽니다'),
    costPerRunUsd: UsdOrNull,
    /**
     * 변이 검증됨 (JDG-04 · JDG-06, M3-15 #60, ADR-146): 병합된 실행의 변이 기록 가운데 규칙마다 가장 나중 기록을 보고, 효력 있는
     * 규칙 중 그 기록이 있는 규칙 수(`tested`)와 그 기록이 '변이 검증됨'인 규칙 수(`verified`). 준수 추이의 마지막 점과 같은 값이다
     */
    mutation: VerificationMutationTally,
    rules: z.array(VerificationRuleRow),
    pipeline: VerificationPipeline.nullable(),
  })
  .refine(({ compliance }) => compliance.passed <= compliance.judgeable, {
    message: '통과 수가 판정 가능 수보다 큽니다',
    path: ['compliance'],
  })
  .refine(({ compliance, denominator }) => compliance.judgeable === denominator.length, {
    message: '판정 가능 수가 분모 목록과 다릅니다',
    path: ['denominator'],
  })
  .refine(
    ({ confirmedCompliance: c }) =>
      c === null || (c.passed <= c.judgeable && c.judgeable <= c.confirmed),
    { message: '사람 확인 기준의 수가 맞지 않습니다', path: ['confirmedCompliance'] },
  )
  .refine(
    ({ confirmedCompliance, confirmedDenominator }) =>
      confirmedDenominator.length === (confirmedCompliance?.judgeable ?? 0),
    {
      message: '사람 확인 기준 판정 가능 수가 분모 목록과 다릅니다',
      path: ['confirmedDenominator'],
    },
  )
  .refine(
    ({ denominator, confirmedDenominator }) =>
      confirmedDenominator.every((id) => denominator.includes(id)),
    {
      message: '사람 확인 기준 분모가 전체 기준 분모에 없는 규칙을 담았습니다',
      path: ['confirmedDenominator'],
    },
  );
export type VerificationSummaryResult = z.infer<typeof VerificationSummaryResult>;

// ── 준수 추이 (JDG-06, SCR-05 그래프, M3-15 #60, ADR-146) ───────
// - 점 하나 = 병합 커밋이 기록된 실행 하나(판정 기준이 될 수 있었던 실행). 병합되지 않은 실행은 점이 아니다
// - 순서 = 판정 기준을 고르는 순서(`verification.summary`의 판정 기준과 같은 열쇠)의 오름차순. 마지막 점이 지금의 판정 기준이다
// - 점의 값 = 그 실행이 판정 기준이던 동안의 마지막 순간(다음 점의 병합 시각 바로 앞, 마지막 점은 지금)에 검증 요약이 보였을
//   준수와 변이 검증됨. 그래서 마지막 점의 두 값은 `verification.summary`의 `compliance` · `mutation`과 같다
// - 값은 저장된 판정 · 변이 · 단계 기록과 규칙의 생성 · 삭제 · 폐기 시각에서만 만든다(새 표 없음, 추정 · 보간 없음)

/** 준수 추이가 한 번에 돌려주는 점 상한. 넘으면 최근 점부터 이만큼과 `truncated: true`. */
export const VERIFICATION_TREND_LIMIT = 30;

export const VerificationTrendPoint = z.strictObject({
  runId: Ulid,
  runDisplayId: displayIdSchema('EXE'),
  branch: z.string().min(1),
  commit: CommitSha,
  /** 병합 단계가 통과로 끝난 시각 (그 기록이 없으면 `null`) */
  mergedAt: Timestamp.nullable(),
  compliance: ComplianceTally,
  mutation: VerificationMutationTally,
});
export type VerificationTrendPoint = z.infer<typeof VerificationTrendPoint>;

export const VerificationTrendParams = z.strictObject({ projectId: Ulid });
export type VerificationTrendParams = z.infer<typeof VerificationTrendParams>;

/** 오래된 점부터. 점은 상한(`VERIFICATION_TREND_LIMIT`)까지, 더 있으면 `truncated: true`(앞쪽 점이 빠짐). */
export const VerificationTrendResult = z
  .strictObject({
    points: z.array(VerificationTrendPoint).max(VERIFICATION_TREND_LIMIT),
    truncated: z.boolean(),
  })
  .refine(({ points, truncated }) => !truncated || points.length === VERIFICATION_TREND_LIMIT, {
    message: '잘린 추이의 점 수가 상한과 다릅니다',
    path: ['truncated'],
  })
  .refine(({ points }) => new Set(points.map((point) => point.runId)).size === points.length, {
    message: '같은 실행의 점이 둘 있습니다',
    path: ['points'],
  });
export type VerificationTrendResult = z.infer<typeof VerificationTrendResult>;

// ── 코드 열람 기록 (MET-01, M2-01, ADR-084) ─────────────────
// - 모든 요청에 `projectId`가 필수다. 등록되지 않은 프로젝트는 -32004
// - `codeOpen.record`는 사람이 `file:line` 링크에서 사유를 골라 열 때 앱(main)이 IDE를 열기 전에 1건 남긴다. 주체 `author`를
//   싣고 사람(`human`)만 받는다(에이전트 주체 -32020). 역할 세션의 도구(MCP)에는 없고, 토큰 인증된 파이프 연결에서만 처리된다
// - 시각은 오케스트레이터 시계로 정한다(요청에 싣지 않는다). 파일은 프로젝트 루트 기준 상대 경로만(`CodeFilePath`)
// - 기록은 추가만 한다(수정 · 삭제 RPC 없음, DB 트리거로도 막음). `codeOpen.list`는 조회 전용으로 최신부터 상한까지,
//   `codeOpen.summary`는 조회 전용으로 전체 기록의 사유별 건수 (M2-02, ADR-088)

/** `codeOpen.list`가 한 번에 돌려주는 기록 상한. 넘으면 최신부터 이만큼과 `truncated: true`. */
export const CODE_OPEN_LIST_LIMIT = 500;

/** 코드 열기 대상: 사유 · 출발 화면 · 항목 · 파일 · 줄. 앱 main의 `app.openInIde`도 같은 값을 받는다. */
export const CodeOpenTarget = z.strictObject({
  projectId: Ulid,
  reason: CodeOpenReason,
  sourceScreen: ScreenId,
  itemRef: EntityRef,
  file: CodeFilePath,
  line: CodeLine,
});
export type CodeOpenTarget = z.infer<typeof CodeOpenTarget>;

/** `codeOpen.record`: 열람 1건을 남긴다 (사람만). */
export const CodeOpenRecordParams = CodeOpenTarget.extend({ author: Author });
export type CodeOpenRecordParams = z.infer<typeof CodeOpenRecordParams>;
export const CodeOpenRecordResult = z.strictObject({ record: CodeOpenRecord });
export type CodeOpenRecordResult = z.infer<typeof CodeOpenRecordResult>;

/**
 * `codeOpen.list`: 열람 기록을 최신부터(시각 → ID 내림차순) 상한까지. 저장된 기록은 읽기 형식(`StoredCodeOpenRecord`)으로
 * 읽고, `file`은 표시용 표기(제어 · 서식 문자 이스케이프, ADR-089 · ADR-094)다. 정상 경로는 글자 그대로다.
 */
export const CodeOpenListParams = z.strictObject({ projectId: Ulid });
export type CodeOpenListParams = z.infer<typeof CodeOpenListParams>;
export const CodeOpenListResult = z.strictObject({
  records: z.array(StoredCodeOpenRecord).max(CODE_OPEN_LIST_LIMIT),
  truncated: z.boolean(),
});
export type CodeOpenListResult = z.infer<typeof CodeOpenListResult>;

/**
 * `codeOpen.summary`: 프로젝트의 열람 기록 전체를 사유별로 센다 (M2-02, ADR-088). 조회 전용.
 * `reasons`는 사유 3종을 고정 순서(`CodeOpenReason` 순서 = 사유 선택 모달 순서)로 모두 싣고(0건 포함),
 * `total`은 그 합이다. 목록 상한(`CODE_OPEN_LIST_LIMIT`)과 무관하게 전체를 센다.
 */
export const CodeOpenSummaryParams = z.strictObject({ projectId: Ulid });
export type CodeOpenSummaryParams = z.infer<typeof CodeOpenSummaryParams>;
export const CodeOpenReasonCount = z.strictObject({
  reason: CodeOpenReason,
  count: z.number().int().nonnegative(),
});
export type CodeOpenReasonCount = z.infer<typeof CodeOpenReasonCount>;
export const CodeOpenSummaryResult = z
  .strictObject({
    reasons: z.array(CodeOpenReasonCount),
    total: z.number().int().nonnegative(),
  })
  .refine(
    ({ reasons }) =>
      reasons.length === CodeOpenReason.options.length &&
      reasons.every(({ reason }, i) => reason === CodeOpenReason.options[i]),
    { message: '사유 3종을 고정 순서로 모두 실어야 합니다', path: ['reasons'] },
  )
  .refine(({ reasons, total }) => reasons.reduce((sum, { count }) => sum + count, 0) === total, {
    message: '합계가 사유별 건수의 합과 다릅니다',
    path: ['total'],
  });
export type CodeOpenSummaryResult = z.infer<typeof CodeOpenSummaryResult>;

// ── 블록 선언 (NRM-09 · JDG-05 · DSN-01, ADR-005, M3-01 #46, ADR-122) ─────
// - `blocks.get`: 지금 블록 선언(가장 큰 판)과 판 · 저장 시각 · 저장 주체. 한 번도 저장하지 않았으면 `current: null`(블록 선언 없음)
// - `blocks.set`: 사람(`human`)만. 에이전트 · 오케스트레이터 주체는 -32020(저장소를 열기 전). 선언 전체를 새 판으로 저장한다(고치기 ·
//   지우기 없음, 옛 판은 남는다). 선언이 스키마 · 저장 규칙(이름 중복, 없는 블록 · 자기 자신을 가리키는 허용 의존, 순환, 두 블록의
//   같은 포함 경로, 프로젝트 폴더 밖 · 형식이 틀린 패턴)을 어기면 -32001(`data.reason = BLOCKS_INVALID`, `data.issues`)
// - 에이전트 역할에는 블록 선언을 쓰는 도구가 없다(ADR-005: 선언을 고쳐 구조 검사를 우회하는 길을 막는다)

/** 블록 선언 검증 실패(-32001)의 `error.data.reason` 값. */
export const BLOCKS_INVALID_REASON = 'BLOCKS_INVALID';

/** -32001 오류의 `data`: 이유 + 어긴 곳(경로 · 메시지). */
export const BlocksInvalidData = z.strictObject({
  reason: z.literal(BLOCKS_INVALID_REASON),
  issues: z
    .array(
      z.strictObject({
        path: z.array(z.union([z.string(), z.int().nonnegative()])),
        message: z.string(),
      }),
    )
    .min(1),
});
export type BlocksInvalidData = z.infer<typeof BlocksInvalidData>;

export const BlocksGetParams = z.strictObject({ projectId: Ulid });
export type BlocksGetParams = z.infer<typeof BlocksGetParams>;
export const BlocksResult = z.strictObject({ current: BlockDeclarationRecord.nullable() });
export type BlocksResult = z.infer<typeof BlocksResult>;

/** `blocks.set`: 선언은 처리기가 검사한다(어긴 곳을 -32001로 돌려주려고 여기서는 모양을 묻지 않는다). */
export const BlocksSetParams = z.strictObject({
  projectId: Ulid,
  author: Author,
  declaration: z.unknown(),
});
export type BlocksSetParams = z.infer<typeof BlocksSetParams>;
export const BlocksSetResult = z.strictObject({ current: BlockDeclarationRecord });
export type BlocksSetResult = z.infer<typeof BlocksSetResult>;

// ── 계약 (NRM-03, ADR-019 · ADR-033 · ADR-100 C2 · K1 · A14, M3-04 #49, ADR-129) ─────
// - `contract.register`: 사람(`human`)만. 에이전트 · 오케스트레이터 주체는 -32020(저장소를 열기 전). `file`은 프로젝트 루트 기준 상대
//   경로(`/` 구분)이고 내용은 기준 브랜치 커밋의 그 파일에서 읽는다(작업 트리가 아니다). 승인 대기 제안 없이 트랜잭션 1개로 계약(확인됨,
//   근거 = 계약의 작성 기록) · `contract` 검사 규칙(내장, 미확인) · 승인 기록 `contract_edit`(이전 없는 diff) · 규범 변경 기록
//   `created`(규칙, 주체 오케스트레이터)를 남긴다. 실행을 자동으로 만들지 않는다
// - 형식 · 파일 문제는 -32001(`data.reason = CONTRACT_INVALID`, `data.code`), 같은 파일이 이미 등록됨 -32009, 부모 요구사항 없음
//   -32004 · 삭제됨 · 효력 없음 -32009
// - `contract.list`: 계약(표시 ID 순)과 그 검사 규칙, 지금 기준 브랜치의 그 파일이 등록 때 내용과 같은지(`source`)

/** 계약 등록 형식 · 파일 문제(-32001)의 `error.data.reason`. */
export const CONTRACT_INVALID_REASON = 'CONTRACT_INVALID';

/**
 * 계약 등록을 받지 않은 까닭.
 * - `kind_not_supported`: 지금 등록을 받지 않는 종류(OpenAPI · DB 스키마 · AsyncAPI만 받는다)
 * - `path_invalid`: 절대 경로 · `..` · 빈 구간 · `.git` · 허용 밖 글자 · 길이 초과
 * - `extension_mismatch`: 종류와 맞지 않는 확장자
 * - `base_unreadable`: 기준 브랜치 커밋을 읽지 못함(git 저장소가 아님 · 브랜치 없음)
 * - `file_missing`: 기준 브랜치 커밋에 그 파일이 없음
 * - `not_regular_file`: 디렉터리 · 기호 링크 · 하위 모듈
 * - `too_large`: 크기 상한 초과
 * - `not_text`: UTF-8 글이 아님(또는 대체 문자 U+FFFD가 있음)
 */
export const ContractInvalidCode = z.enum([
  'kind_not_supported',
  'path_invalid',
  'extension_mismatch',
  'base_unreadable',
  'file_missing',
  'not_regular_file',
  'too_large',
  'not_text',
]);
export type ContractInvalidCode = z.infer<typeof ContractInvalidCode>;

export const ContractInvalidData = z.strictObject({
  reason: z.literal(CONTRACT_INVALID_REASON),
  code: ContractInvalidCode,
});
export type ContractInvalidData = z.infer<typeof ContractInvalidData>;

/** `contract.register`: 파일 · 경로 형식은 처리기가 검사한다(까닭을 -32001로 돌려주려고 여기서는 문자열만 묻는다). */
export const ContractRegisterParams = z.strictObject({
  projectId: Ulid,
  file: z.string(),
  kind: ContractKind,
  author: Author,
  /** 부모 요구사항 (연결 단위 = 파일, ADR-019). 없으면 부모 없는 계약 */
  requirementId: Ulid.optional(),
});
export type ContractRegisterParams = z.infer<typeof ContractRegisterParams>;
export const ContractRegisterResult = z.strictObject({
  contract: Contract,
  rule: Rule,
  approvalLog: ApprovalLogEntry,
});
export type ContractRegisterResult = z.infer<typeof ContractRegisterResult>;

/**
 * 지금 기준 브랜치의 계약 파일이 등록 때 내용과 같은지. `same` · `changed`(내용 해시가 다름, `contentHash` = 지금 해시) ·
 * `missing`(파일이 없거나 일반 파일이 아님) · `unreadable`(기준 브랜치 · 파일을 읽지 못함 · 상한 초과 · 글이 아님).
 */
export const ContractSourceState = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('same') }),
  z.strictObject({ status: z.literal('changed'), contentHash: Sha256Hex }),
  z.strictObject({ status: z.literal('missing') }),
  z.strictObject({ status: z.literal('unreadable') }),
]);
export type ContractSourceState = z.infer<typeof ContractSourceState>;

export const ContractListParams = z.strictObject({ projectId: Ulid });
export type ContractListParams = z.infer<typeof ContractListParams>;
export const ContractListResult = z.strictObject({
  contracts: z.array(
    z.strictObject({
      contract: Contract,
      /** 그 계약의 `contract` 검사 규칙 (없으면 `null`) */
      rule: z.strictObject({ id: Ulid, displayId: displayIdSchema('RULE') }).nullable(),
      source: ContractSourceState,
    }),
  ),
});
export type ContractListResult = z.infer<typeof ContractListResult>;

// ── 검토 대기열 (TODO-02 · COST-01 · JDG-04, SCR-18, M3-08 #53, ADR-100 B④ · A17, ADR-145) ──────────
// - 항목은 실행의 종료 상태를 저장하는 같은 쓰기에서 DB가 등록한다(이 이름 공간에 항목을 만드는 메서드는 없다)
// - 조회는 사람 · 앱 누구나, 처리 액션은 사람 주체만(에이전트 -32020, 저장소를 열기 전). 없는 항목 -32004, 이미 처리됨 ·
//   그 종류가 받지 않는 액션은 -32009(`data.reason` = {@link ReviewConflictReason}). 처리는 항목마다 한 번이다
// - 변이 생존의 이의 제기는 정의 전이라(PRD 미결 #7) 메서드가 없다(부르면 -32601)
// - 값은 저장된 항목 · 실행 · 규칙에서만 만든다(NFR-03). 규칙 제목은 원문이라 화면은 표시 값으로 바꿔 그린다

/** 항목이 가리키는 실행 (요약). */
export const ReviewQueueRun = z.strictObject({
  id: Ulid,
  displayId: displayIdSchema('EXE'),
  type: RunType,
  status: RunStatus,
  failureReason: z.string().nullable(),
});
export type ReviewQueueRun = z.infer<typeof ReviewQueueRun>;

/** 항목의 대상 규칙 (변이 생존 = 원인 변이 기록의 규칙, 예산 초과 = 실행의 대상 규칙들, 표시 ID 순이 아니라 실행의 순서). */
export const ReviewQueueRule = z.strictObject({
  id: Ulid,
  displayId: displayIdSchema('RULE'),
  title: z.string(),
});
export type ReviewQueueRule = z.infer<typeof ReviewQueueRule>;

export const ReviewQueueEntry = z.strictObject({
  item: ReviewItem,
  run: ReviewQueueRun,
  rules: z.array(ReviewQueueRule),
});
export type ReviewQueueEntry = z.infer<typeof ReviewQueueEntry>;

/** `reviewQueue.list`: 등록 순(오래된 것 먼저). `kind` · `state`로 거른다(생략하면 전부). */
export const ReviewQueueListParams = z.strictObject({
  projectId: Ulid,
  kind: ReviewItemKind.optional(),
  state: ReviewItemState.optional(),
});
export type ReviewQueueListParams = z.infer<typeof ReviewQueueListParams>;
export const ReviewQueueListResult = z.strictObject({ entries: z.array(ReviewQueueEntry) });
export type ReviewQueueListResult = z.infer<typeof ReviewQueueListResult>;

export const ReviewQueueGetParams = z.strictObject({ projectId: Ulid, seq: z.int().positive() });
export type ReviewQueueGetParams = z.infer<typeof ReviewQueueGetParams>;
export const ReviewQueueEntryResult = z.strictObject({ entry: ReviewQueueEntry });
export type ReviewQueueEntryResult = z.infer<typeof ReviewQueueEntryResult>;

/**
 * `reviewQueue.reinforce`: 변이 생존 항목의 테스트 보강. 사람이 시작한 유형 C 실행 1개를 사람의 `run.create`와 같은 문(설정 ·
 * 유형 · 대상 규칙 · 승인 기록 `run_start`)으로 만들고, 원인 변이 기록과 잇는다(그 실행의 변이 주입 단계 = 같은 변이의 재주입).
 */
export const ReviewQueueReinforceParams = z.strictObject({
  projectId: Ulid,
  seq: z.int().positive(),
  author: Author,
});
export type ReviewQueueReinforceParams = z.infer<typeof ReviewQueueReinforceParams>;
export const ReviewQueueReinforceResult = z.strictObject({
  entry: ReviewQueueEntry,
  run: Run,
  steps: z.array(Step),
  approvalLog: ApprovalLogEntry,
});
export type ReviewQueueReinforceResult = z.infer<typeof ReviewQueueReinforceResult>;

/**
 * `reviewQueue.quarantine`: 변이 생존 항목의 판정 격리. 공백만인 사유는 -32001(`QUARANTINE_REASON_REQUIRED`), 상한 초과는
 * -32001(`QUARANTINE_REASON_INVALID`). 그 규칙에 판정 상태 '격리' 기록 1건을 남긴다(그 뒤 실제 판정이 나오면 그것이 최신이다).
 */
export const ReviewQueueQuarantineParams = z.strictObject({
  projectId: Ulid,
  seq: z.int().positive(),
  reason: z.string(),
  author: Author,
});
export type ReviewQueueQuarantineParams = z.infer<typeof ReviewQueueQuarantineParams>;
export const ReviewQueueQuarantineResult = z.strictObject({
  entry: ReviewQueueEntry,
  judgment: JudgmentResult,
});
export type ReviewQueueQuarantineResult = z.infer<typeof ReviewQueueQuarantineResult>;

/**
 * `reviewQueue.resumeWithBudget`: 예산 초과 항목의 한도 상향 재개 (M3-56 #319, ADR-147 ② ④ ⑤ ⑦, ADR-149). 원 실행은 '예산 초과'
 * 그대로 두고, 원 실행과 같은 유형 · 대상 규칙 · 기준 커밋을 가진 이어받는 새 실행 1개를 사람의 `run.create`와 같은 문(설정 · 유형 ·
 * 대상 규칙 · 승인 기록 `run_start`)으로 만든다. `budget`은 새 실행의 예산 값(`Run.budgetSnapshot`과 같은 모양)이다: 역할 집합이 원
 * 실행과 다르면 -32001 `BUDGET_SHAPE_MISMATCH`, 어느 값이든 원 실행의 같은 값보다 작으면 -32001 `BUDGET_LOWERED`, 원 실행(사슬 전체)이
 * 쓴 양이 이미 닿은 값은 쓴 양보다 커야 한다(아니면 -32001 `BUDGET_NOT_ABOVE_SPENT`). 새 실행의 사용량은 원 실행(사슬 전체)의
 * 사용량부터 이어 센다.
 */
export const ReviewQueueResumeWithBudgetParams = z.strictObject({
  projectId: Ulid,
  seq: z.int().positive(),
  budget: BudgetSnapshot,
  author: Author,
});
export type ReviewQueueResumeWithBudgetParams = z.infer<typeof ReviewQueueResumeWithBudgetParams>;
export const ReviewQueueResumeWithBudgetResult = z.strictObject({
  entry: ReviewQueueEntry,
  run: Run,
  steps: z.array(Step),
  approvalLog: ApprovalLogEntry,
});
export type ReviewQueueResumeWithBudgetResult = z.infer<typeof ReviewQueueResumeWithBudgetResult>;

/**
 * `reviewQueue.resumeNarrowed`: 예산 초과 항목의 허용 목록 축소 재개 (M3-58 #321, ADR-147 ⑥, ADR-155). `reviewQueue.resumeWithBudget`과
 * 같은 길(같은 새 한도 검증)로 이어받는 실행을 만들고 그 실행에만 쓰기 허용 범위를 붙인다: 구현 세션은 처음 목록(원 실행 대상 규칙들의
 * 대상 블록 포함 경로의 합)에 들고 `exclude`에 들지 않는 경로에만 쓸 수 있다. `exclude`는 블록 선언의 포함 경로와 같은 패턴 문법이다:
 * 비면 -32001 `WRITE_SCOPE_EXCLUDE_REQUIRED`, 형식이 틀리면 -32001 `WRITE_SCOPE_EXCLUDE_INVALID`(`data.fields`), 처음 목록이 비면 -32001
 * `WRITE_SCOPE_ALLOW_EMPTY`. 형식 검사는 저장소를 열기 전에 하므로 요청 스키마는 글자 배열만 본다.
 */
export const ReviewQueueResumeNarrowedParams = z.strictObject({
  projectId: Ulid,
  seq: z.int().positive(),
  budget: BudgetSnapshot,
  exclude: z.array(z.string()),
  author: Author,
});
export type ReviewQueueResumeNarrowedParams = z.infer<typeof ReviewQueueResumeNarrowedParams>;

/** 처리 액션이 -32009로 거부하는 이유 (`error.data.reason`). */
export const ReviewConflictReason = z.enum(['already_resolved', 'action_not_allowed']);
export type ReviewConflictReason = z.infer<typeof ReviewConflictReason>;

/**
 * 메서드 이름 → 파라미터 · 결과 스키마. architecture.md 5장 표의 메서드는 해당 이슈에서 여기에 추가한다.
 * 파라미터가 없는 메서드는 `z.undefined()`로 둔다 (요청에 `params`를 넣으면 -32602).
 */
export const METHODS = {
  ping: { params: PingParams, result: PingResult },
  'system.hello': { params: SystemHelloParams, result: SystemHelloResult },
  'system.status': { params: SystemStatusParams, result: SystemStatusResult },
  'requirement.create': { params: RequirementCreateParams, result: RequirementResult },
  'requirement.update': { params: RequirementUpdateParams, result: RequirementResult },
  'requirement.delete': { params: RequirementDeleteParams, result: RequirementResult },
  'requirement.get': { params: RequirementGetParams, result: RequirementResult },
  'requirement.list': { params: RequirementListParams, result: RequirementListResult },
  'requirement.markUnrulable': {
    params: RequirementMarkUnrulableParams,
    result: RequirementResult,
  },
  'rule.list': { params: RuleListParams, result: RuleListResult },
  'rule.get': { params: RuleGetParams, result: RuleGetResult },
  'rule.update': { params: RuleUpdateParams, result: RuleUpdateResult },
  'judgment.list': { params: JudgmentListParams, result: JudgmentListResult },
  'proposal.list': { params: ProposalListParams, result: ProposalListResult },
  'proposal.count': { params: ProposalCountParams, result: ProposalCountResult },
  'proposal.get': { params: ProposalGetParams, result: ProposalResult },
  'proposal.markRead': { params: ProposalMarkReadParams, result: ProposalResult },
  'proposal.approve': { params: ProposalApproveParams, result: ProposalApproveResult },
  'proposal.amend': { params: ProposalAmendParams, result: ProposalApproveResult },
  'proposal.reject': { params: ProposalRejectParams, result: ProposalRejectResult },
  'approvalLog.list': { params: ApprovalLogListParams, result: ApprovalLogListResult },
  'confirmation.set': { params: ConfirmationSetParams, result: ConfirmationSetResult },
  'confirmation.list': { params: ConfirmationListParams, result: ConfirmationListResult },
  'normChange.list': { params: NormChangeListParams, result: NormChangeListResult },
  'project.open': { params: ProjectOpenParams, result: ProjectOpenResult },
  'project.current': { params: ProjectCurrentParams, result: ProjectCurrentResult },
  'project.list': { params: ProjectListParams, result: ProjectListResult },
  'blocks.get': { params: BlocksGetParams, result: BlocksResult },
  'blocks.set': { params: BlocksSetParams, result: BlocksSetResult },
  'contract.register': { params: ContractRegisterParams, result: ContractRegisterResult },
  'contract.list': { params: ContractListParams, result: ContractListResult },
  'reviewQueue.list': { params: ReviewQueueListParams, result: ReviewQueueListResult },
  'reviewQueue.get': { params: ReviewQueueGetParams, result: ReviewQueueEntryResult },
  'reviewQueue.reinforce': {
    params: ReviewQueueReinforceParams,
    result: ReviewQueueReinforceResult,
  },
  'reviewQueue.quarantine': {
    params: ReviewQueueQuarantineParams,
    result: ReviewQueueQuarantineResult,
  },
  'reviewQueue.resumeWithBudget': {
    params: ReviewQueueResumeWithBudgetParams,
    result: ReviewQueueResumeWithBudgetResult,
  },
  'reviewQueue.resumeNarrowed': {
    params: ReviewQueueResumeNarrowedParams,
    result: ReviewQueueResumeWithBudgetResult,
  },
  'settings.get': { params: SettingsGetParams, result: SettingsResult },
  'settings.update': { params: SettingsUpdateParams, result: SettingsResult },
  'settings.validateForRun': { params: SettingsValidateParams, result: SettingsValidateResult },
  'run.create': { params: RunCreateParams, result: RunCreateResult },
  'run.get': { params: RunGetParams, result: RunGetResult },
  'run.list': { params: RunListParams, result: RunListResult },
  'run.resume': { params: RunResumeParams, result: RunDetailResult },
  'toolCall.list': { params: ToolCallListParams, result: ToolCallListResult },
  'ruleWriter.status': { params: RuleWriterStatusParams, result: RuleWriterStatusResult },
  'verification.summary': {
    params: VerificationSummaryParams,
    result: VerificationSummaryResult,
  },
  'verification.trend': { params: VerificationTrendParams, result: VerificationTrendResult },
  'codeOpen.record': { params: CodeOpenRecordParams, result: CodeOpenRecordResult },
  'codeOpen.list': { params: CodeOpenListParams, result: CodeOpenListResult },
  'codeOpen.summary': { params: CodeOpenSummaryParams, result: CodeOpenSummaryResult },
} as const satisfies Record<string, MethodSpec>;

export type MethodName = keyof typeof METHODS;
export type MethodParams<M extends MethodName> = z.infer<(typeof METHODS)[M]['params']>;
export type MethodResult<M extends MethodName> = z.infer<(typeof METHODS)[M]['result']>;

export const METHOD_NAMES = Object.keys(METHODS) as MethodName[];

export const isMethodName = (name: string): name is MethodName => Object.hasOwn(METHODS, name);

export interface NotificationSpec {
  params: z.ZodType;
}

// ── 실행 알림 (RUN-01 · RUN-02 · COST-02, M1-19, ADR-076) ─────
// - 오케스트레이터 → 인증된 모든 연결. 실행 상태 저장(단계 전이)마다 바뀐 단계 시도마다 `event.step.updated`, 그다음
//   `event.run.updated` 1개. 화면 갱신 단계는 판정 결과 저장 뒤 `event.run.updated`를 보내고 송신이 끝나야 완료된다
// - 값은 저장된 실행 · 단계 시도 그대로의 요약이다. 받는 쪽은 알림만으로 화면을 그리지 않고 다시 조회한다
// - 종료 조건 결과 원문(`exitDetail`)은 크기가 정해지지 않아 싣지 않는다(프레임 상한 1 MiB). 단계 상태가 결과다

/** `event.run.updated`: 실행 상태 · 현재 단계 · 회귀 수 · 비용 (architecture.md 5장 알림 표). */
export const RunUpdatedEvent = z.strictObject({
  projectId: Ulid,
  runId: Ulid,
  displayId: displayIdSchema('EXE'),
  status: RunStatus,
  currentStep: StepKind.nullable(),
  regressionCount: z.int().nonnegative(),
  costUsd: UsdOrNull,
});
export type RunUpdatedEvent = z.infer<typeof RunUpdatedEvent>;

/** `event.step.updated`: 단계 시도 하나의 상태 (종료 조건 결과 = `passed` · `skipped` · `failed`). */
export const StepUpdatedEvent = z.strictObject({
  projectId: Ulid,
  runId: Ulid,
  stepId: Ulid,
  kind: StepKind,
  attempt: z.int().positive(),
  status: StepStatus,
});
export type StepUpdatedEvent = z.infer<typeof StepUpdatedEvent>;

/** 실행 알림 이름. 렌더러는 둘 중 하나를 받으면 실행 · 판정을 보이는 화면을 다시 조회한다. */
export const RUN_EVENT_NAMES = ['event.run.updated', 'event.step.updated'] as const;

// ── 제안 알림 (TODO-01 · NRM-02, M1-36, ADR-076) ─────────────
// - 오케스트레이터 → 인증된 모든 연결. 제안 등록(rule-writer `propose_rule`) · 처리(승인 · 수정 후 승인 · 거절)를
//   저장한 뒤 제안마다 1개. 실행 알림과 같이 기다리지 않는다
// - 식별자와 상태만 싣는다. 제안 본문(진술 · 근거 · diff)은 싣지 않고 받는 쪽이 다시 조회한다(`proposal.count` 등)

/** `event.proposal.changed`: 제안 1건이 생기거나 처리됨 (architecture.md 5장 알림 표). */
export const ProposalChangedEvent = z.strictObject({
  projectId: Ulid,
  proposalId: Ulid,
  displayId: displayIdSchema('PRP'),
  kind: ProposalKind,
  state: ProposalState,
});
export type ProposalChangedEvent = z.infer<typeof ProposalChangedEvent>;

/** 제안 알림 이름. 렌더러는 받으면 할 일 배지 · 할 일 목록을 다시 조회한다. */
export const PROPOSAL_EVENT_NAMES = ['event.proposal.changed'] as const;

// ── 규칙 작성 알림 (NRM-02, SCR-02, M3-26, ADR-099) ──────────
// - 규칙 작성 시도의 기록이 바뀔 때(대기 · 시작 · 끝 · 생략 저장 뒤) 1개. 제안 알림과 같이 기다리지 않는다
// - 식별자만 싣는다. 받는 쪽은 `ruleWriter.status`를 다시 조회한다

/** `event.ruleWriter.changed`: 요구사항 하나의 규칙 작성 시도 기록이 바뀜. */
export const RuleWriterChangedEvent = z.strictObject({
  projectId: Ulid,
  requirementId: Ulid,
});
export type RuleWriterChangedEvent = z.infer<typeof RuleWriterChangedEvent>;

/** 규칙 작성 알림 이름. 렌더러는 받으면 요구사항 상세의 규칙 작성 상태를 다시 조회한다. */
export const RULE_WRITER_EVENT_NAMES = ['event.ruleWriter.changed'] as const;

// ── 규범 변경 알림 (NRM-07 · TODO-01, M7-14 #226, ADR-119) ──────────
// - 규범 변경 기록이 하나 이상 추가된 저장소 사용이 끝난 뒤(커밋 뒤) 1개. 쓰는 곳마다 보내지 않고 저장소를 여닫는 한 곳에서
//   그 사이 마지막 순번이 늘었는지 보고 보낸다. 기다리지 않는다
// - 내용 없이 프로젝트 ID와 마지막 순번만 싣는다. 받는 쪽은 확인할 것 · 규칙 · 검증 화면을 다시 조회한다

/** `event.normChange.appended`: 프로젝트의 규범 변경 기록이 늘어남. */
export const NormChangeAppendedEvent = z.strictObject({
  projectId: Ulid,
  lastSeq: z.int().positive(),
});
export type NormChangeAppendedEvent = z.infer<typeof NormChangeAppendedEvent>;

/** 규범 변경 알림 이름. 렌더러는 받으면 할 일 배지 · 확인할 것 · 규칙 · 검증 화면을 다시 조회한다. */
export const NORM_CHANGE_EVENT_NAMES = ['event.normChange.appended'] as const;

// ── 블록 선언 알림 (NRM-09, SCR-02 · SCR-03 · SCR-06, M3-42 #283, ADR-135) ──────────
// - 사람의 `blocks.set`이 새 판을 저장한 뒤(커밋 뒤) 1개. 블록 선언을 쓰는 곳은 그 처리기 하나다. 기다리지 않는다
// - 내용 없이 프로젝트 ID와 새 판 번호만 싣는다. 받는 쪽은 `blocks.get`을 다시 조회한다

/** `event.blocks.changed`: 프로젝트의 블록 선언이 새 판으로 바뀜. */
export const BlocksChangedEvent = z.strictObject({
  projectId: Ulid,
  version: z.int().positive(),
});
export type BlocksChangedEvent = z.infer<typeof BlocksChangedEvent>;

/** 블록 선언 알림 이름. 렌더러는 받으면 열린 규칙 · 요구사항 상세의 블록 선언을 다시 조회한다. */
export const BLOCK_EVENT_NAMES = ['event.blocks.changed'] as const;

// ── 검토 대기열 알림 (TODO-02, SCR-18, M3-08 #53, ADR-145) ──────────
// - 검토 대기열 항목이 생기거나(실행 종료 저장) 처리된 저장소 사용이 끝난 뒤(커밋 뒤) 1개. 규범 변경 알림처럼 저장소를 여닫는
//   한 곳에서 사용 전후의 항목 수 · 처리된 수를 비교한다. 기다리지 않는다
// - 내용 없이 프로젝트 ID만 싣는다. 받는 쪽은 `reviewQueue.list`를 다시 조회한다

/** `event.reviewQueue.changed`: 프로젝트의 검토 대기열 항목이 생기거나 처리됨. */
export const ReviewQueueChangedEvent = z.strictObject({ projectId: Ulid });
export type ReviewQueueChangedEvent = z.infer<typeof ReviewQueueChangedEvent>;

/** 검토 대기열 알림 이름. */
export const REVIEW_QUEUE_EVENT_NAMES = ['event.reviewQueue.changed'] as const;

/** 알림 이름 → 파라미터 스키마. `event.*` 알림은 해당 이슈에서 추가한다. */
export const NOTIFICATIONS = {
  'event.run.updated': { params: RunUpdatedEvent },
  'event.step.updated': { params: StepUpdatedEvent },
  'event.proposal.changed': { params: ProposalChangedEvent },
  'event.ruleWriter.changed': { params: RuleWriterChangedEvent },
  'event.normChange.appended': { params: NormChangeAppendedEvent },
  'event.blocks.changed': { params: BlocksChangedEvent },
  'event.reviewQueue.changed': { params: ReviewQueueChangedEvent },
} as const satisfies Record<string, NotificationSpec>;

export type NotificationParams<N extends NotificationName> = z.infer<
  (typeof NOTIFICATIONS)[N]['params']
>;

export type NotificationName = keyof typeof NOTIFICATIONS;

export const isNotificationName = (name: string): name is NotificationName =>
  Object.hasOwn(NOTIFICATIONS, name);

// ── 생성 · 해석 ──────────────────────────────────────────

/** 오류 객체를 만든다. 메시지를 생략하면 코드별 기본 메시지. */
export const rpcError = (code: ErrorCode, message?: string, data?: unknown): JsonRpcErrorObject =>
  data === undefined
    ? { code, message: message ?? ERROR_MESSAGES[code] }
    : { code, message: message ?? ERROR_MESSAGES[code], data };

export interface SchemaIssue {
  path: string;
  message: string;
}

/** zod 오류를 `error.data.issues`로 실을 수 있는 평평한 목록으로 바꾼다. */
export const toSchemaIssues = (error: z.ZodError): SchemaIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));

const schemaMismatch = (what: string, error: z.ZodError): JsonRpcErrorObject =>
  rpcError(ErrorCode.InvalidParams, `${ERROR_MESSAGES[ErrorCode.InvalidParams]}: ${what}`, {
    issues: toSchemaIssues(error),
  });

type ParamsArg<M extends MethodName> =
  undefined extends MethodParams<M> ? [params?: MethodParams<M>] : [params: MethodParams<M>];

/** 요청을 만든다. 파라미터가 메서드 스키마와 맞지 않으면 예외 (보내는 쪽 검증). */
export const createRequest = <M extends MethodName>(
  id: JsonRpcId,
  method: M,
  ...[params]: ParamsArg<M>
): JsonRpcRequest => {
  const checked: unknown = METHODS[method].params.parse(params);
  return checked === undefined
    ? { jsonrpc: JSONRPC_VERSION, id, method }
    : { jsonrpc: JSONRPC_VERSION, id, method, params: checked as JsonRpcRequest['params'] };
};

/** 성공 응답을 만든다. 결과가 메서드 스키마와 맞지 않으면 예외 (보내는 쪽 검증). */
export const createSuccessResponse = <M extends MethodName>(
  id: JsonRpcId,
  method: M,
  result: MethodResult<M>,
): JsonRpcSuccessResponse => ({
  jsonrpc: JSONRPC_VERSION,
  id,
  result: METHODS[method].result.parse(result),
});

/** 알림을 만든다. 파라미터가 알림 스키마와 맞지 않으면 예외 (보내는 쪽 검증). */
export const createNotification = <N extends NotificationName>(
  method: N,
  params: NotificationParams<N>,
): JsonRpcNotification => ({
  jsonrpc: JSONRPC_VERSION,
  method,
  params: (NOTIFICATIONS[method].params as z.ZodType).parse(
    params,
  ) as JsonRpcNotification['params'],
});

export const createErrorResponse = (
  id: JsonRpcId | null,
  error: JsonRpcErrorObject,
): JsonRpcErrorResponse => ({ jsonrpc: JSONRPC_VERSION, id, error });

/** 줄 프레임 1개를 JSON으로 해석한다. 실패하면 -32700. */
export const parseJsonFrame = (
  line: string,
): { ok: true; value: unknown } | { ok: false; error: JsonRpcErrorObject } => {
  try {
    return { ok: true, value: JSON.parse(line) as unknown };
  } catch {
    return { ok: false, error: rpcError(ErrorCode.ParseError) };
  }
};

/** 해석된 요청. 메서드 이름으로 파라미터 타입이 좁혀진다. */
export type ParsedRequest = {
  [M in MethodName]: { id: JsonRpcId; method: M; params: MethodParams<M> };
}[MethodName];

export type ParseRequestResult =
  | { ok: true; request: ParsedRequest }
  | { ok: false; id: JsonRpcId | null; error: JsonRpcErrorObject };

/**
 * 받은 요청을 검증한다 (받는 쪽). 실패하면 응답에 쓸 ID와 오류를 돌려준다.
 * 형식 위반 -32600 → 없는 메서드 -32601 → 파라미터 스키마 불일치 -32602 순으로 판단한다.
 */
export const parseRequest = (value: unknown): ParseRequestResult => {
  const envelope = JsonRpcRequest.safeParse(value);
  if (!envelope.success) {
    const rawId = typeof value === 'object' && value !== null ? Reflect.get(value, 'id') : null;
    const id = JsonRpcId.safeParse(rawId);
    return {
      ok: false,
      id: id.success ? id.data : null,
      error: rpcError(ErrorCode.InvalidRequest, undefined, {
        issues: toSchemaIssues(envelope.error),
      }),
    };
  }
  const { id, method, params } = envelope.data;
  if (!isMethodName(method)) {
    return { ok: false, id, error: rpcError(ErrorCode.MethodNotFound, `없는 메서드: ${method}`) };
  }
  const checked = METHODS[method].params.safeParse(params);
  if (!checked.success) {
    return { ok: false, id, error: schemaMismatch(`${method} 파라미터`, checked.error) };
  }
  return { ok: true, request: { id, method, params: checked.data } as ParsedRequest };
};

export type ParseResponseResult<M extends MethodName> =
  | { ok: true; id: JsonRpcId; result: MethodResult<M> }
  | { ok: false; id: JsonRpcId | null; error: JsonRpcErrorObject };

/**
 * 받은 응답을 보낸 요청의 메서드 기준으로 검증한다 (요청한 쪽).
 * 오류 응답은 그 오류를, 형식 · 결과 스키마 위반은 -32602 오류를 돌려준다.
 */
export const parseResponse = <M extends MethodName>(
  method: M,
  value: unknown,
): ParseResponseResult<M> => {
  const envelope = JsonRpcResponse.safeParse(value);
  if (!envelope.success) {
    return { ok: false, id: null, error: schemaMismatch(`${method} 응답 형식`, envelope.error) };
  }
  const response = envelope.data;
  if ('error' in response) {
    return { ok: false, id: response.id, error: response.error };
  }
  const checked = METHODS[method].result.safeParse(response.result);
  if (!checked.success) {
    return { ok: false, id: response.id, error: schemaMismatch(`${method} 결과`, checked.error) };
  }
  return { ok: true, id: response.id, result: checked.data as MethodResult<M> };
};

export type ParseNotificationResult =
  | { ok: true; method: NotificationName; params: unknown }
  | { ok: false; error: JsonRpcErrorObject };

/** 받은 알림을 검증한다. 알림은 응답하지 않으므로 실패는 받는 쪽 기록용이다. */
export const parseNotification = (value: unknown): ParseNotificationResult => {
  const envelope = JsonRpcNotification.safeParse(value);
  if (!envelope.success) {
    return {
      ok: false,
      error: rpcError(ErrorCode.InvalidRequest, undefined, {
        issues: toSchemaIssues(envelope.error),
      }),
    };
  }
  const { method, params } = envelope.data;
  if (!isNotificationName(method)) {
    return { ok: false, error: rpcError(ErrorCode.MethodNotFound, `없는 알림: ${method}`) };
  }
  const spec: NotificationSpec = NOTIFICATIONS[method];
  const checked = spec.params.safeParse(params);
  if (!checked.success) {
    return { ok: false, error: schemaMismatch(`${method} 파라미터`, checked.error) };
  }
  return { ok: true, method, params: checked.data };
};
