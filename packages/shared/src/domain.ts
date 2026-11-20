// 도메인 엔터티 스키마와 타입 (docs/architecture.md 3장).
// M0 · M1에 필요한 엔터티만 스키마를 둔다. 나머지는 EntityName에 이름만 예약한다.
// 파생 값(요구사항 상태 · 결함, 규칙의 최신 판정 등)은 저장 필드가 아니므로 여기에 없다.
import { z } from 'zod';

import {
  AgentRole,
  ApprovalAction,
  AuthorKind,
  CheckKind,
  CodeOpenReason,
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
  // 예약 (M1 이후 해당 이슈에서 스키마 추가, 이미 스키마가 생긴 이름은 RESERVED_ENTITY_NAMES에서 뺀다)
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

/** 예산 한도 (USD). 0보다 커야 한다 (NFR-07: 예산 한도 없는 실행 금지). `null` = 미설정. */
export const BudgetLimitUsd = z.number().positive().nullable();
/** 턴 한도 (plan.md 4.5 `maxTurns`). 1 이상 정수. `null` = 미설정. */
export const TurnLimit = z.int().positive().nullable();
/** 모델 ID. 사용자가 입력한 문자열 그대로 저장한다 (공백만 있는 값 금지, 200자 이하). `null` = 미설정. */
export const ModelId = z
  .string()
  .max(200)
  .refine((text) => text.trim().length > 0, '모델 ID가 비어 있습니다');

/** 실행 전체 한도 (COST-01, plan.md 4.5 `maxBudgetUsd` · `maxTurns`). */
export const RunLimits = z.strictObject({
  maxBudgetUsd: BudgetLimitUsd,
  maxTurns: TurnLimit,
});
export type RunLimits = z.infer<typeof RunLimits>;

/** 역할 하나의 모델 · 한도 (COST-01, NFR-07, ADR-024). */
export const RoleSettings = z.strictObject({
  model: ModelId.nullable(),
  maxBudgetUsd: BudgetLimitUsd,
  maxTurns: TurnLimit,
});
export type RoleSettings = z.infer<typeof RoleSettings>;

/**
 * 역할별 설정. 모든 역할 키가 있다(값이 없으면 각 필드 `null`). 어느 역할을 실행 전에 검사하는지는
 * `settings.validateForRun`이 정한다 (M1 필수: rule-writer · test-writer · implementer, ADR-057).
 */
export const RoleSettingsMap = z.record(AgentRole, RoleSettings);
export type RoleSettingsMap = z.infer<typeof RoleSettingsMap>;

// ── 코드 열기 IDE (MET-01, ADR-018 · ADR-087) ───────────────

/**
 * 코드 열기 URL에 쓸 수 있는 스킴과 그 스킴의 고정 호스트 (ADR-087 허용 목록). 내장 선택(VS Code · Cursor)과
 * 사용자 지정 틀 모두 이 목록의 `스킴://호스트`로만 시작할 수 있다. 웹 · 파일 · 스크립트 계열(`http` · `file` ·
 * `javascript` · `data` 등)과 OS 처리기(`ms-*` 등)는 목록에 없으므로 거부된다. 호스트를 고정해 같은 스킴의 다른
 * 처리기(예: VS Code 확장 URI `vscode://<확장>/…`)를 부르지 못하게 한다.
 * 처리기가 `{path}`를 한 번만 디코딩한다고 근거를 댈 수 있는 스킴만 둔다(ADR-087). 값 안에 다시 `file:` URL을 넣는
 * 처리기(`subl` · `txmt` · `mvim`의 `?url=file://…`)는 두 번 디코딩되어 `%2e%2e` 같은 이름이 `..`가 되므로 두지 않는다.
 */
export const IDE_URL_SCHEME_HOSTS = {
  vscode: 'file',
  'vscode-insiders': 'file',
  vscodium: 'file',
  cursor: 'file',
  windsurf: 'file',
  idea: 'open',
} as const satisfies Record<string, string>;
export type IdeUrlScheme = keyof typeof IDE_URL_SCHEME_HOSTS;

/** IDE URL 틀의 자리 표시자. `{path}` = 절대 경로(앞의 `/` 없이, 조각마다 퍼센트 인코딩), `{line}` = 줄 번호. */
export const IDE_URL_PATH_PLACEHOLDER = '{path}';
export const IDE_URL_LINE_PLACEHOLDER = '{line}';

/** 내장 IDE의 URL 틀 (ADR-018). */
export const IDE_URL_TEMPLATES = {
  vscode: 'vscode://file/{path}:{line}',
  cursor: 'cursor://file/{path}:{line}',
} as const;

/** 사용자 지정 URL 틀의 최대 길이 (문자). */
export const IDE_URL_TEMPLATE_MAX_LENGTH = 512;

/** 완성된 IDE URL의 최대 길이 (문자). */
export const IDE_URL_MAX_LENGTH = 8192;

/** URL 앞부분 `스킴://권한` + 나머지(`/` 또는 `?`로 시작). */
const IDE_URL_HEAD = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([/?][\s\S]*)$/;

/** 허용 스킴의 고정 호스트 (목록에 없으면 `undefined`). */
export const ideUrlSchemeHost = (scheme: string): string | undefined =>
  Object.hasOwn(IDE_URL_SCHEME_HOSTS, scheme)
    ? IDE_URL_SCHEME_HOSTS[scheme as IdeUrlScheme]
    : undefined;

/** 출력 가능한 ASCII(0x21 ~ 0x7E)만: 공백 · 줄바꿈 · 제어 문자 · 비ASCII(양방향 제어 문자 포함) 거부. */
const isPrintableAscii = (value: string): boolean => /^[\x21-\x7e]+$/.test(value);

const countOf = (value: string, part: string): number => value.split(part).length - 1;

/**
 * 완성된 IDE URL이 허용 범위인지 (ADR-087): 출력 가능한 ASCII만, `스킴://호스트`가 허용 목록의 쌍과 글자 그대로 같고
 * (소문자 스킴, 사용자 정보 · 포트 없음), `new URL()`로 다시 읽어도 같은 스킴 · 호스트다. 여는 곳 바로 앞(main)과
 * 틀 검사({@link isIdeUrlTemplate})가 함께 쓴다.
 */
export const isAllowedIdeUrl = (url: string, maxLength: number = IDE_URL_MAX_LENGTH): boolean => {
  if (url.length === 0 || url.length > maxLength || !isPrintableAscii(url)) return false;
  const head = IDE_URL_HEAD.exec(url);
  if (head === null) return false;
  const [, scheme = '', authority = ''] = head;
  const host = ideUrlSchemeHost(scheme);
  if (host === undefined || authority !== host) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === `${scheme}:` &&
    parsed.host === host &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === ''
  );
};

/**
 * 사용자 지정 IDE URL 틀인지 (ADR-087). `{path}` · `{line}`을 각각 정확히 한 번 담고 그 밖의 중괄호가 없으며,
 * 길이 {@link IDE_URL_TEMPLATE_MAX_LENGTH} 이하, 출력 가능한 ASCII만(공백 · 줄바꿈 · 제어 문자 거부),
 * `스킴://호스트`가 허용 목록({@link IDE_URL_SCHEME_HOSTS})의 쌍이고 자리 표시자를 채운 결과도 같은 스킴 · 호스트다.
 */
export const isIdeUrlTemplate = (template: string): boolean => {
  if (template.length > IDE_URL_TEMPLATE_MAX_LENGTH || !isPrintableAscii(template)) return false;
  if (countOf(template, IDE_URL_PATH_PLACEHOLDER) !== 1) return false;
  if (countOf(template, IDE_URL_LINE_PLACEHOLDER) !== 1) return false;
  const rest = template.replace(IDE_URL_PATH_PLACEHOLDER, '').replace(IDE_URL_LINE_PLACEHOLDER, '');
  if (rest.includes('{') || rest.includes('}')) return false;
  // 중첩 URL 거부: `스킴://호스트` 뒤(경로 · query · fragment)에 다른 스킴 모양(`file:` · `http://` 등)이나 퍼센트
  // 인코딩(`file%3A…`)이 있으면 처리기가 `{path}`를 두 번 디코딩할 수 있다 (ADR-087)
  const tail = template.slice(template.indexOf('://') + 3);
  if (/[A-Za-z][A-Za-z0-9+.-]*:/.test(tail) || tail.includes('//') || tail.includes('%')) {
    return false;
  }
  // 자리 표시자가 `스킴://호스트`에 들어가면 쌍 비교에서 걸린다
  const sample = template
    .replace(IDE_URL_PATH_PLACEHOLDER, 'bive/sample.ts')
    .replace(IDE_URL_LINE_PLACEHOLDER, '1');
  return isAllowedIdeUrl(sample);
};

/** 사용자 지정 IDE URL 틀 ({@link isIdeUrlTemplate}). */
export const IdeUrlTemplate = z.string().refine(isIdeUrlTemplate, 'IDE URL 틀이 아닙니다');

/**
 * 코드 열기 IDE 선택 (ADR-018 · ADR-087): VS Code · Cursor · 사용자 지정 URL 틀. 설정의 `ide`가 `null`이면 미설정이고,
 * 화면은 처음 열 때 선택을 먼저 요구한다(미리 골라 둔 값은 VS Code). 바꾸는 주체는 사람뿐이다(`settings.update`).
 */
export const IdeSetting = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('vscode') }),
  z.strictObject({ kind: z.literal('cursor') }),
  z.strictObject({ kind: z.literal('custom'), template: IdeUrlTemplate }),
]);
export type IdeSetting = z.infer<typeof IdeSetting>;
export type IdeKind = IdeSetting['kind'];

/**
 * 프로젝트 설정 (COST-01, NFR-07, TODO-04, ADR-012, RUN-05, NFR-02, ADR-057).
 * 예산 · 모델은 실행에 필수지만 저장은 미설정(`null`)을 허용한다 (일부 역할만 먼저 저장하는 흐름, roadmap M1 흐름 2).
 * 미설정이면 실행 생성이 `-32010`으로 거부된다 (architecture.md 5장).
 * 한 번도 저장하지 않은 프로젝트는 기본값이고 `updatedAt` · `updatedBy`가 `null`이다.
 * 변경 주체는 사람뿐이다 (에이전트 주체의 `settings.update`는 -32020).
 */
export const Settings = z.strictObject({
  projectId: Ulid,
  run: RunLimits,
  roles: RoleSettingsMap,
  /** 승인 대기 유입 상한 (TODO-04, 기본 40). 화면 표시 · 변경은 M3-13 */
  approvalQueueLimit: z.int().positive(),
  /** 잠정 승인 정책 (ADR-012 기본 '사용 안 함'). 화면 · 변경은 해당 이슈 */
  provisionalPolicy: ProvisionalPolicy,
  /** 자동 모드 (RUN-05). 화면 · 변경은 해당 이슈 */
  autoMode: z.boolean(),
  /** 에이전트 패키지 설치 허용 목록 (ADR-024 기본 비어 있음) */
  installAllowlist: z.array(NonEmptyString),
  /** 코드 열기 IDE (ADR-018 · ADR-087). `null` = 미설정(처음 열 때 선택 요구) */
  ide: IdeSetting.nullable(),
  updatedAt: Timestamp.nullable(),
  updatedBy: HumanAuthor.nullable(),
});
export type Settings = z.infer<typeof Settings>;

/** 역할 설정 기본값: 전부 미설정. */
export const emptyRoleSettings = (): RoleSettings => ({
  model: null,
  maxBudgetUsd: null,
  maxTurns: null,
});

/** 한 번도 저장하지 않은 프로젝트의 설정. 예산 · 모델은 전부 미설정이다. */
export const defaultSettings = (projectId: Ulid): Settings => ({
  projectId,
  run: { maxBudgetUsd: null, maxTurns: null },
  roles: Object.fromEntries(
    AgentRole.options.map((role) => [role, emptyRoleSettings()]),
  ) as RoleSettingsMap,
  approvalQueueLimit: DEFAULT_APPROVAL_QUEUE_LIMIT,
  provisionalPolicy: 'off',
  autoMode: false,
  installAllowlist: [],
  ide: null,
  updatedAt: null,
  updatedBy: null,
});

/**
 * 실행 전에 반드시 채워야 하는 역할 (M1, ADR-057). planner · chat 등은 그 역할을 쓰는 이슈가
 * `settings.validateForRun`의 `roles`로 넘겨 검사한다 (M4-01 · M5-01).
 */
export const RUN_REQUIRED_ROLES = [
  'rule-writer',
  'test-writer',
  'implementer',
] as const satisfies readonly AgentRole[];

/** 비어 있는 설정 항목의 경로: `run.<필드>` 또는 `roles.<역할>.<필드>`. */
export type MissingSetting = `run.${keyof RunLimits}` | `roles.${AgentRole}.${keyof RoleSettings}`;

const RUN_FIELDS = ['maxBudgetUsd', 'maxTurns'] as const satisfies readonly (keyof RunLimits)[];
const ROLE_FIELDS = [
  'model',
  'maxBudgetUsd',
  'maxTurns',
] as const satisfies readonly (keyof RoleSettings)[];

/** `MissingSetting` 형식의 경로 (`run.maxTurns`, `roles.test-writer.model` 등). */
export const MissingSettingPath = z.union([
  z.enum(RUN_FIELDS.map((field) => `run.${field}` as const)),
  z.templateLiteral(['roles.', AgentRole, '.', z.enum(ROLE_FIELDS)]),
]);

/**
 * 실행 전 설정 검사 (NFR-07): 실행 전체 한도 2개와 `roles`의 모델 · 한도(USD · 턴) 중 비어 있는 항목을
 * 정해진 순서(실행 전체 → 역할 순서 → 필드 순서)로 돌려준다. 빈 배열이면 실행할 수 있다.
 */
export const findMissingSettings = (
  settings: Pick<Settings, 'run' | 'roles'>,
  roles: readonly AgentRole[] = RUN_REQUIRED_ROLES,
): MissingSetting[] => {
  const missing: MissingSetting[] = [];
  for (const field of RUN_FIELDS) {
    if (settings.run[field] === null) missing.push(`run.${field}`);
  }
  const wanted = new Set(roles);
  for (const role of AgentRole.options) {
    if (!wanted.has(role)) continue;
    const values = settings.roles[role];
    for (const field of ROLE_FIELDS) {
      if (values[field] === null) missing.push(`roles.${role}.${field}`);
    }
  }
  return missing;
};

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

/**
 * 승인 기록 검증 실패 이유 (ADR-050).
 * - `seq_gap`: 순번이 1부터 1씩 늘지 않는다 (기록이 빠졌거나 끼어들었다)
 * - `prev_hash_mismatch`: 앞 기록의 해시와 다르다
 * - `hash_mismatch`: 내용이 해시와 맞지 않는다 (기록이 고쳐졌다)
 * - `malformed`: 해시는 맞지만 기록 형식이 깨졌다
 * - `decision_without_log`: 처리된 제안에 맞는 승인 기록이 없다 (끝 기록이 잘려 나갔을 수 있다)
 */
export const ApprovalLogBreakReason = z.enum([
  'seq_gap',
  'prev_hash_mismatch',
  'hash_mismatch',
  'malformed',
  'decision_without_log',
]);
export type ApprovalLogBreakReason = z.infer<typeof ApprovalLogBreakReason>;

/** 첫 승인 기록의 `prevHash`. */
export const APPROVAL_LOG_GENESIS_HASH = '0'.repeat(64);

/**
 * 승인 기록의 행동별 상세. 수정 후 승인은 `diff`, 거절은 `reason`, 승인은 `appliedRef`,
 * 실행 시작은 `ruleIds`(사람이 확인한 대상 규칙, 요청 순서 그대로, ADR-061).
 */
export const ApprovalLogDetail = z.strictObject({
  diff: z.strictObject({ before: z.unknown(), after: z.unknown() }).optional(),
  reason: NonEmptyString.optional(),
  appliedRef: EntityRef.optional(),
  ruleIds: z.array(Ulid).min(1).optional(),
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
    if ((action === 'run_start') !== (detail.ruleIds !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: '실행 시작에만 대상 규칙이 있고, 실행 시작에는 대상 규칙이 필수입니다 (RUN-01)',
        path: ['detail', 'ruleIds'],
      });
    }
  });
export type ApprovalLogEntry = z.infer<typeof ApprovalLogEntry>;

// ── 실행 ─────────────────────────────────────────────────

/** 검사 실패 → 구현 회귀 상한 (RUN-02 확정). 초과하면 실행 `failed`. */
export const MAX_REGRESSION_COUNT = 2;

/**
 * 실행 유형별 단계 순서 (RUN-02, architecture.md 4장, ADR-061). M1은 유형 A만 만든다.
 * 변이 주입은 P1(JDG-04)이라 M1 엔진이 `skipped`로 기록한다(roadmap M1-14). B · C · D는 RUN-07(M3)이 더한다.
 */
export const RUN_STEP_PLANS = {
  A: [
    'approval',
    'test_writing',
    'red_check',
    'implementation',
    'check',
    'mutation',
    'merge',
    'screen_update',
  ],
} as const satisfies Partial<Record<RunType, readonly StepKind[]>>;

/** M1에서 만드는 실행 유형 (ADR-020: B · C · D는 enum만). */
export const M1_RUN_TYPE = 'A' as const satisfies RunType;

/** 단계를 수행하는 에이전트 역할. 사람 · 판정기 · 오케스트레이터 단계는 `null` (architecture.md 4장 단계표). */
export const STEP_ROLES = {
  approval: null,
  test_writing: 'test-writer',
  red_check: null,
  green_check: null,
  implementation: 'implementer',
  check: null,
  mutation: null,
  merge: null,
  screen_update: null,
} as const satisfies Record<StepKind, AgentRole | null>;

/** 단계 목록의 역할(중복 없이, 단계 순서대로). 실행의 예산 · 모델 스냅샷 대상이다. */
export const stepRoles = (plan: readonly StepKind[]): AgentRole[] => {
  const roles: AgentRole[] = [];
  for (const kind of plan) {
    const role = STEP_ROLES[kind];
    if (role !== null && !roles.includes(role)) roles.push(role);
  }
  return roles;
};

/**
 * 단계 정렬: 파이프라인 순서(`StepKind` 정의 순서 = 모든 유형의 공통 순서) → 시도 번호.
 * `Array.prototype.sort`용. 회귀로 생긴 새 시도는 같은 단계의 이전 시도 바로 뒤에 온다.
 */
export const compareSteps = (
  a: { kind: StepKind; attempt: number },
  b: { kind: StepKind; attempt: number },
): number =>
  StepKind.options.indexOf(a.kind) - StepKind.options.indexOf(b.kind) || a.attempt - b.attempt;

/** 실행 시작 시 복사한 한도 1개 (USD · 턴). 실행은 설정이 모두 채워져야 생성되므로 `null`이 없다. */
export const BudgetLimits = z.strictObject({
  maxBudgetUsd: z.number().positive(),
  maxTurns: z.int().positive(),
});
export type BudgetLimits = z.infer<typeof BudgetLimits>;

/**
 * 실행 시작 시 복사한 예산 (COST-01, NFR-07, ADR-057 · ADR-061): 실행 전체 한도와 실행이 쓰는 역할(유형 A는
 * test-writer · implementer)의 한도. 시작 뒤 설정을 바꿔도 이 실행에는 반영되지 않는다.
 */
export const BudgetSnapshot = z.strictObject({
  run: BudgetLimits,
  roles: perRole(BudgetLimits),
});
export type BudgetSnapshot = z.infer<typeof BudgetSnapshot>;

/** 세션별 도구 목록 · MCP 서버 수 (NFR-02). */
export const ToolManifestEntry = z.strictObject({
  role: AgentRole,
  tools: z.array(NonEmptyString),
  mcpServerCount: NonNegativeInt,
});
export type ToolManifestEntry = z.infer<typeof ToolManifestEntry>;

/**
 * 실행 (RUN-01, RUN-02, RUN-07, RUN-08, COST-01, NFR-07, ADR-061).
 * - `targetRuleIds`: 요청 순서 그대로, 중복 없음
 * - `currentStep`: 진행 중(또는 승인 대기 중)인 단계. 모든 단계가 끝나면 `null`
 * - `branch` · `worktreePath` · `baseCommit`: 워크트리를 만들 때(M1-13) 채운다. 그 전에는 `null`
 * - `startedAt`: 승인 단계가 끝나 `running`이 된 시각. 승인 대기 중에는 `null`
 */
export const Run = z.strictObject({
  id: Ulid,
  displayId: displayIdSchema('EXE'),
  projectId: Ulid,
  type: RunType,
  targetRuleIds: z
    .array(Ulid)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, '대상 규칙이 중복됐습니다'),
  status: RunStatus,
  currentStep: StepKind.nullable(),
  lastCompletedStep: StepKind.nullable(),
  regressionCount: NonNegativeInt,
  failureReason: NonEmptyString.nullable(),
  branch: NonEmptyString.nullable(),
  worktreePath: NonEmptyString.nullable(),
  baseBranch: NonEmptyString,
  baseCommit: CommitSha.nullable(),
  headCommit: CommitSha.nullable(),
  mergeCommit: CommitSha.nullable(),
  budgetSnapshot: BudgetSnapshot,
  modelSnapshot: perRole(ModelId),
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

/**
 * 에이전트 세션 = SDK `query()` 1회 (기획서 3.2, RUN-04). 진행 중이면 종료 사유 · 비용 · 종료 시각이 `null`.
 * 실행 엔진(M1-14, ADR-066)이 세션을 열 때 행을 만들고 끝날 때 결과를 채운다(재기동 뒤 역할별 세션 순번의 근거).
 * 실행 밖 세션(규칙 작성, ADR-062)은 `runId` · `stepId`가 `null`이고 `requirementId`로 대상 요구사항을 가리킨다.
 * `error`는 결과 없이 끝난 세션의 사유 문장(어댑터 오류 · 가드 위반 등).
 * `budget`은 세션을 열 때 어댑터에 넘긴 한도(min(역할 잔여, 실행 잔여), ADR-067). 결과 없이 끝나 비용 · 턴을 모르는
 * 세션은 잔여 한도 계산에서 이 한도를 다 쓴 것으로 본다. 한도 없이 연 세션(실행 밖 세션)은 `null`.
 */
export const Session = z
  .strictObject({
    id: Ulid,
    runId: Ulid.nullable(),
    stepId: Ulid.nullable(),
    requirementId: Ulid.nullable(),
    role: AgentRole,
    model: NonEmptyString,
    sdkSessionId: NonEmptyString.nullable(),
    workDir: NonEmptyString,
    endReason: SessionEndReason.nullable(),
    error: NonEmptyString.nullable(),
    totalCostUsd: UsdOrNull,
    numTurns: NonNegativeInt.nullable(),
    modelUsage: z.record(NonEmptyString, ModelUsage),
    firstTurnCacheWrite: NonNegativeInt.nullable(),
    budget: BudgetLimits.nullable(),
    tools: z.array(NonEmptyString),
    mcpServers: z.array(NonEmptyString),
    startedAt: Timestamp,
    endedAt: Timestamp.nullable(),
  })
  .refine(
    (session) => (session.runId === null) === (session.stepId === null),
    '실행 세션은 실행 · 단계 시도가 둘 다 있고, 실행 밖 세션은 둘 다 없다',
  );
export type Session = z.infer<typeof Session>;

/** 도구 호출 결과 (ADR-052: `ok` · `denied` · `error`). */
export const ToolCallStatus = z.enum(['ok', 'denied', 'error']);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

/**
 * 세션의 도구 호출 기록 1건 (NFR-02, ADR-052 `ToolCallRecord`, ADR-066). 거부 · 오류를 포함한 모든 호출을
 * 호출 순서(`seq`, 세션 안 0부터)대로 추가만 한다.
 */
export const ToolCall = z.strictObject({
  id: Ulid,
  /** 실행 밖 세션의 호출이면 `null` */
  runId: Ulid.nullable(),
  sessionId: Ulid,
  seq: NonNegativeInt,
  at: Timestamp,
  role: AgentRole,
  /** 에이전트가 부른 이름 그대로. 빈 문자열도 받는다(실행기가 `unknown_tool`로 거부한 호출도 기록, ADR-094) */
  name: z.string(),
  argsSummary: z.string(),
  status: ToolCallStatus,
  reason: NonEmptyString.nullable(),
  durationMs: NonNegativeInt,
});
export type ToolCall = z.infer<typeof ToolCall>;

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

// ── 코드 열람 기록 (MET-01, M2-01, ADR-084) ─────────────────

/** 화면 ID (`SCR-01` ~ `SCR-21`, screens.md 1.3). 저장 값이며 화면에는 보이지 않는다 (screens.md 1.1). */
export const ScreenId = z.string().regex(/^SCR-(?:0[1-9]|1\d|2[01])$/, '화면 ID가 아닙니다');
export type ScreenId = z.infer<typeof ScreenId>;

/** 코드 파일 경로의 최대 길이 (문자). */
export const CODE_FILE_PATH_MAX_LENGTH = 1024;

/**
 * 양방향 제어 문자인지 (U+061C, U+200E · U+200F, U+202A ~ U+202E, U+2066 ~ U+2069). 파일 이름에 있으면 링크 글자가
 * 뒤집혀 보일 수 있어 코드 열기 경로에서 거부한다 (ADR-087).
 */
export const isBidiControl = (code: number): boolean =>
  code === 0x061c ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/**
 * 프로젝트 루트 기준 상대 경로인지 (코드 열기의 `file`, ADR-084). 렌더러가 넘긴 값으로 루트 밖 파일이나 임의 URL을
 * 열지 못하게 좁게 받는다. 거부: 빈 값 · 너무 긴 값 · 제어 문자 · 양방향 제어 문자(ADR-087) · 절대 경로(`/` · `C:` 등 드라이브 · `\\`) ·
 * 역슬래시 · 콜론(`file:line` 구분자, 드라이브 상대 경로, 대체 데이터 스트림) · `%`(중첩 디코딩, ADR-087) · 빈 경로 조각(`a//b`, 앞뒤 `/`) ·
 * `.` · `..` 조각. 구분자는 `/`만 쓴다(판정 기록의 `file`이 이 모양, judge/report.ts `toRelativePath`).
 */
export const isProjectRelativePath = (value: string): boolean => {
  if (value.length === 0 || value.length > CODE_FILE_PATH_MAX_LENGTH) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || isBidiControl(code)) return false;
  }
  // `%`는 거부: 중첩 디코딩에서 `%2e%2e`가 `..`가 되지 않게 (ADR-087)
  if (value.includes('\\') || value.includes(':') || value.includes('%')) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
};

/** 코드 파일 경로: 프로젝트 루트 기준 상대 경로만 ({@link isProjectRelativePath}). */
export const CodeFilePath = z
  .string()
  .refine(isProjectRelativePath, '프로젝트 루트 기준 상대 경로가 아닙니다');
export type CodeFilePath = z.infer<typeof CodeFilePath>;

/** 코드 줄 번호: 1 이상의 정수. */
export const CodeLine = z.int().positive();

/**
 * 코드 열람 기록 1건 (MET-01, architecture.md 3장 CodeOpenRecord). 사람이 `file:line` 링크에서 사유를 고르고 연 때마다
 * 1건, 추가만 한다. 시각 `at`은 오케스트레이터 시계, `sourceScreen`은 출발 화면, `itemRef`는 링크가 달린 항목.
 */
export const CodeOpenRecord = z.strictObject({
  id: Ulid,
  at: Timestamp,
  reason: CodeOpenReason,
  sourceScreen: ScreenId,
  itemRef: EntityRef,
  file: CodeFilePath,
  line: CodeLine,
});
export type CodeOpenRecord = z.infer<typeof CodeOpenRecord>;

/**
 * 저장된 열람 기록을 읽을 때의 형식 (ADR-094: 쓰기는 엄격하게, 읽기는 느슨하게). 경로(`file`)의 세부 규칙
 * ({@link isProjectRelativePath}, 나중에 조여질 수 있다: PR #184가 `%` · 양방향 제어 문자를 더함)은 다시 적용하지 않고
 * 빈 값이 아닌 문자열인지만 본다. 나머지 칸은 {@link CodeOpenRecord}와 같다(타입 · 열거형 · DB CHECK와 같은 모양).
 */
export const StoredCodeOpenRecord = CodeOpenRecord.extend({ file: z.string().min(1) });
export type StoredCodeOpenRecord = z.infer<typeof StoredCodeOpenRecord>;
