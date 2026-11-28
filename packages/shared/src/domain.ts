// 도메인 엔터티 스키마와 타입 (docs/architecture.md 3장).
// M0 · M1에 필요한 엔터티만 스키마를 둔다. 나머지는 EntityName에 이름만 예약한다.
// 파생 값(요구사항 상태 · 결함, 규칙의 최신 판정 등)은 저장 필드가 아니므로 여기에 없다.
import { z } from 'zod';

import { BlockDeclaration, BlockName } from './blocks.js';
import {
  AgentRole,
  ApprovalAction,
  AuthorKind,
  CheckKind,
  CodeOpenReason,
  ConfirmationState,
  ContractKind,
  JudgeRunner,
  JudgmentStatus,
  MutationOutcome,
  mutationStatusOf,
  MutationStatus,
  NormChangeKind,
  NormState,
  ProposalKind,
  ProposalSource,
  ProposalState,
  ProvisionalPolicy,
  REVIEW_ACTIONS_BY_KIND,
  ReviewItemKind,
  Risk,
  RuleBehavior,
  RuleKind,
  RunStatus,
  RunType,
  SESSION_END_REASON_LABELS,
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
  'Adr',
  'CodeChange',
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

// ── 확인 상태 (ADR-100 D2 · C1 · A1, M7-01) ─────────────────

/**
 * 사람이 확인 RPC(`confirmation.set`)로 확인하고 확인할 것 목록(`confirmation.list`)에 오르는 엔터티. 블록 선언 · ADR은 그 이슈가
 * 더한다 (M3-05 · M4-01 · M4-13). 계약은 확인 상태를 저장하지만(아래 {@link ConfirmationRecordEntity}) 사람의 확인 RPC · 확인할 것
 * 목록에는 아직 없다(M3-04 #49, ADR-129: 미확인 계약이 생기는 제품 경로가 없고, 그 항목을 그릴 화면이 M3-05다)
 */
export const ConfirmationEntity = z.enum(['Requirement', 'Rule']);
export type ConfirmationEntity = z.infer<typeof ConfirmationEntity>;

/** 확인 대상: 엔터티 참조(`EntityRef`)를 확인 상태를 두는 엔터티와 ULID로 좁힌 것. */
export const ConfirmationTarget = EntityRef.extend({ entity: ConfirmationEntity, id: Ulid });
export type ConfirmationTarget = z.infer<typeof ConfirmationTarget>;

/** 확인 상태를 저장하는 엔터티 (`confirmations` 표, 0024가 계약을 더함. M3-04 #49, ADR-129). */
export const ConfirmationRecordEntity = z.enum([...ConfirmationEntity.options, 'Contract']);
export type ConfirmationRecordEntity = z.infer<typeof ConfirmationRecordEntity>;

/** 확인 상태 저장의 대상: {@link ConfirmationTarget}에 계약을 더한 것 (저장소 · 확인 서비스 안에서만 쓴다). */
export const ConfirmationRecordTarget = EntityRef.extend({
  entity: ConfirmationRecordEntity,
  id: Ulid,
});
export type ConfirmationRecordTarget = z.infer<typeof ConfirmationRecordTarget>;

/**
 * 확인됨의 근거 (ADR-100 A1).
 * - `approval_log`: 승인 기록의 사람 행동 1건(`seq`). 확인(`confirm`), 제안 승인(`approve` · `approve_edited`),
 *   규칙 직접 편집(`rule_edit`, M7-03)
 * - `requirement_record`: 요구사항 자체의 작성 · 수정 주체(사람)와 그 시각(`createdAt` 또는 `updatedAt`, NRM-01).
 *   사람이 쓰거나 고친 요구사항이고, 승인 기록에는 항목이 없다
 * - `contract_record`: 계약 자체의 작성 주체(사람)와 그 시각(`createdAt`, M3-04 #49 · ADR-129). 사람이 등록한 계약이다(그 등록은
 *   승인 기록 `contract_edit`에도 남는다). 계약에만 쓴다(DB CHECK)
 */
export const ConfirmationBasis = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('approval_log'), seq: z.int().positive() }),
  z.strictObject({ kind: z.literal('requirement_record'), at: Timestamp }),
  z.strictObject({ kind: z.literal('contract_record'), at: Timestamp }),
]);
export type ConfirmationBasis = z.infer<typeof ConfirmationBasis>;

/**
 * 규범 항목의 확인 상태 (ADR-100 D2). 기본은 미확인이고, 확인됨은 확인한 사람 · 시각 · 근거를 함께 갖는다.
 * 사람만 확인됨으로 바꾼다(I1). 아무것도 막지 않는다(실행 · 판정 · 병합의 조건이 아님).
 */
export const Confirmation = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal(ConfirmationState.enum.unconfirmed) }),
  z.strictObject({
    state: z.literal(ConfirmationState.enum.confirmed),
    at: Timestamp,
    by: HumanAuthor,
    basis: ConfirmationBasis,
  }),
]);
export type Confirmation = z.infer<typeof Confirmation>;

/** 기본 확인 상태 (확인 기록이 없는 항목). */
export const UNCONFIRMED = { state: 'unconfirmed' } as const satisfies Confirmation;

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
/**
 * 프로젝트 하루 예산 한도 (USD, COST-01 · NFR-07, ADR-100 B⑤ · A12, M7-04, ADR-104). 0 이상 수.
 * `null`(비움) = 하루 한도 없음: 수동 실행 · 규칙 작성 세션은 막지 않고 자동 시작(M7-05)만 하지 않는다.
 * `0` = 하루 지출이 0 이상이면 이미 한도에 이른 것이라 새 에이전트 세션을 모두 막는다.
 */
export const DailyBudgetUsd = z.number().nonnegative().nullable();
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
  /** 프로젝트 하루 예산 한도 (USD, 기기의 로컬 날짜 기준, ADR-104). `null` = 비움(한도 없음 · 자동 시작 없음) */
  dailyBudgetUsd: DailyBudgetUsd,
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
  dailyBudgetUsd: null,
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
 * `settings.validateForRun`의 `roles`로 넘겨 검사한다 (M4-01 · M5-01). 변이 주입 역할(`mutator`)은 M3-07(#52, ADR-139)이 더했다:
 * 기본값이 없어 옛 설정은 그 칸이 비어 있고 채우기 전까지 실행을 만들지 못한다(NFR-07).
 */
export const RUN_REQUIRED_ROLES = [
  'rule-writer',
  'test-writer',
  'implementer',
  'mutator',
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
  /** 확인 상태 (ADR-100 D2, M7-01). 저장 필드가 아니라 확인 기록(`confirmations`)에서 읽는다 */
  confirmation: Confirmation,
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
 * (추적성 결함, 표시는 M3-11 · ADR-050).
 * 대상 블록(`targetBlockIds`, 블록 이름) · 위험도는 규칙 작성 역할이 새로 만드는 규칙에 필수다(M3-01 #46, ADR-122: 도구 · 반영 모듈이
 * 강제). 읽기 스키마는 그 전에 만들어진 행의 빈 목록 · `null`을 그대로 받는다(옛 행을 지어내지 않는다).
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
    /** 대상 블록 이름 (칸 이름은 옛 그대로, 블록의 식별자 = 이름. ADR-122) */
    targetBlockIds: z.array(BlockName),
    risk: Risk.nullable(),
    contractId: Ulid.nullable(),
    author: Author,
    normState: NormState,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    deletedAt: Timestamp.nullable(),
    /** 확인 상태 (ADR-100 D2, M7-01). 저장 필드가 아니라 확인 기록(`confirmations`)에서 읽는다 */
    confirmation: Confirmation,
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
 * 저장된 블록 선언 한 판 (M3-01 #46, ADR-005 · ADR-122). 사람이 `blocks.set`으로 저장할 때마다 판이 1씩 늘고(1부터) 옛 판은
 * 지우거나 고치지 않는다(바꾼 기록 = 판 목록). 지금 선언은 가장 큰 판이다.
 */
export const BlockDeclarationRecord = z.strictObject({
  version: z.int().positive(),
  declaration: BlockDeclaration,
  setAt: Timestamp,
  setBy: HumanAuthor,
});
export type BlockDeclarationRecord = z.infer<typeof BlockDeclarationRecord>;

/**
 * 규칙 폐기 (NRM-02 · NRM-06, ADR-100 D5 · D6, M7-09 #221, ADR-112). 규칙 1개에 많아야 1건이고 되돌릴 수 없다(DB 트리거).
 * 기록이 있는 규칙은 효력이 없다(규칙 행 · 판정 이력은 남는다). 저장 칸이 아니라 폐기 기록(`rule_retirements`)에서 읽는다.
 * - `supersededBy`: 대체한 새 규칙(대체), 폐기만이면 `null`
 * - `normChangeSeq`: 같은 트랜잭션에서 남긴 규범 변경 기록(`retired` · `superseded`)의 순번
 */
export const RuleRetirement = z.strictObject({
  ruleId: Ulid,
  retiredAt: Timestamp,
  supersededBy: Ulid.nullable(),
  normChangeSeq: z.int().positive(),
});
export type RuleRetirement = z.infer<typeof RuleRetirement>;

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
 * 승인 기록의 행동별 상세. 수정 후 승인은 `diff`, 거절은 `reason`, 승인 · 수정 후 승인은 `appliedRef`(그 밖의 행동에는 없다),
 * 실행 시작은 `ruleIds`(사람이 확인한 대상 규칙, 요청 순서 그대로, ADR-061).
 * 확인(`confirm`)은 `seenNormChangeSeq`(그 확인 순간의 규범 변경 기록 마지막 순번 = 사람이 여기까지 봤다, M7-13 · ADR-113).
 * 이 칸이 없는 옛 확인은 규범 변경 기록을 본 적 없음(0)으로 읽는다.
 */
export const ApprovalLogDetail = z.strictObject({
  diff: z.strictObject({ before: z.unknown(), after: z.unknown() }).optional(),
  reason: NonEmptyString.optional(),
  appliedRef: EntityRef.optional(),
  ruleIds: z.array(Ulid).min(1).optional(),
  seenNormChangeSeq: z.int().nonnegative().optional(),
});
export type ApprovalLogDetail = z.infer<typeof ApprovalLogDetail>;

/** 규칙 직접 편집 diff의 한쪽: 사람이 고칠 수 있는 칸 전부 (M7-03 #215, ADR-109). */
export const RuleEditSnapshot = z.strictObject({
  title: NonEmptyString,
  statement: NonEmptyString,
});
export type RuleEditSnapshot = z.infer<typeof RuleEditSnapshot>;

/** 승인 기록 `rule_edit`의 diff: 편집 전 · 뒤의 제목 · 진술. */
export const RuleEditDiff = z.strictObject({ before: RuleEditSnapshot, after: RuleEditSnapshot });
export type RuleEditDiff = z.infer<typeof RuleEditDiff>;

// ── 계약 (NRM-03, ADR-019 · ADR-033 · ADR-100 C2 · K1 · A14, M3-04 #49, ADR-129) ─────

/** 계약 원본 파일 경로의 길이 상한 (UTF-16 코드 단위). */
export const CONTRACT_SOURCE_FILE_MAX = 1024;

/** 계약 원본 파일 (프로젝트 루트 기준 상대 경로, `/` 구분). 형식 규칙은 등록 모듈이 보고 읽기 스키마는 길이만 본다. */
export const ContractSourceFile = z.string().min(1).max(CONTRACT_SOURCE_FILE_MAX);

/**
 * 계약 (NRM-03 · ADR-019). 등록 단위 = 파일이고 요구사항과의 연결 단위도 파일이다(부모 요구사항 0~1개).
 * - `contentHash`: 등록 때 기준 브랜치 커밋(`sourceCommit`)에 든 그 파일 내용의 SHA-256(바이트 그대로). 계약 내용 자체는
 *   저장하지 않는다(원본은 저장소의 파일이다)
 * - `author`: 등록 주체(사람의 CLI 등록 · 에이전트 반영). 확인 상태는 저장 칸이 아니라 확인 기록(`confirmations`)에서 읽는다
 * - 계약은 지금 고치거나 지우지 않는다(변경 반영은 M3-10)
 */
export const Contract = z.strictObject({
  id: Ulid,
  displayId: displayIdSchema('CON'),
  kind: ContractKind,
  sourceFile: ContractSourceFile,
  contentHash: Sha256Hex,
  sourceCommit: CommitSha,
  parentRequirementId: Ulid.nullable(),
  author: Author,
  createdAt: Timestamp,
  confirmation: Confirmation,
});
export type Contract = z.infer<typeof Contract>;

/** 계약 편집 diff의 한쪽: 등록 단위인 파일과 그 내용 해시 · 종류 · 부모 요구사항 (M3-04 #49, ADR-129). */
export const ContractEditSnapshot = z.strictObject({
  kind: ContractKind,
  sourceFile: ContractSourceFile,
  contentHash: Sha256Hex,
  sourceCommit: CommitSha,
  parentRequirementId: Ulid.nullable(),
});
export type ContractEditSnapshot = z.infer<typeof ContractEditSnapshot>;

/**
 * 승인 기록 `contract_edit`의 diff. 사람의 계약 등록은 이전이 없는 편집(`before: null`)이다(ADR-129: 승인 기록 표를 다시 만들어
 * 행동 값을 더하지 않고 계약 편집 값과 diff의 빈 이전으로 구별한다). 계약 변경(M3-10)은 이 모양을 넓힌다.
 */
export const ContractEditDiff = z.strictObject({
  before: ContractEditSnapshot.nullable(),
  after: ContractEditSnapshot,
});
export type ContractEditDiff = z.infer<typeof ContractEditDiff>;

/** 수정 diff를 남기는 행동: 수정 후 승인과 사람의 직접 편집 (ADR-100 A2 · A8). */
const EDIT_ACTIONS: readonly ApprovalAction[] = ['approve_edited', 'rule_edit', 'contract_edit'];

/** 반영 규범(`appliedRef`)을 남기는 행동: 제안 승인 (ADR-120). */
const APPLIED_REF_ACTIONS: readonly ApprovalAction[] = ['approve', 'approve_edited'];

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
    const edits = EDIT_ACTIONS.includes(action);
    if (edits && detail.diff === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: '수정 후 승인 · 직접 편집에는 수정 diff가 필요합니다 (NRM-04, ADR-100 A2)',
        path: ['detail', 'diff'],
      });
    }
    if (!edits && detail.diff !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: '수정 후 승인 · 직접 편집이 아니면 수정 diff를 둘 수 없습니다',
        path: ['detail', 'diff'],
      });
    }
    if (action === 'confirm') {
      if (!ConfirmationTarget.safeParse(entry.targetRef).success) {
        ctx.addIssue({
          code: 'custom',
          message: '확인 대상은 확인 상태를 두는 엔터티(요구사항 · 규칙)여야 합니다 (ADR-100 D2)',
          path: ['targetRef'],
        });
      }
    }
    // 사람의 규칙 직접 편집은 규칙을 대상으로 하고 diff는 제목 · 진술의 전후다 (M7-03, ADR-109). 반영 규범 칸은 제안 승인에만 있다
    if (action === 'rule_edit') {
      if (detail.diff !== undefined && !RuleEditDiff.safeParse(detail.diff).success) {
        ctx.addIssue({
          code: 'custom',
          message: '규칙 직접 편집의 diff는 제목 · 진술의 전후입니다',
          path: ['detail', 'diff'],
        });
      }
      if (entry.targetRef.entity !== 'Rule') {
        ctx.addIssue({
          code: 'custom',
          message: '규칙 직접 편집의 대상은 규칙이어야 합니다',
          path: ['targetRef'],
        });
      }
    }
    // 사람의 계약 등록 · 편집은 계약을 대상으로 하고 diff는 계약 편집 diff다 (M3-04 #49, ADR-129). 이 값을 쓰는 제품 코드는 이 변경이
    // 처음이라 옛 행이 형식 위반이 되지 않는다
    if (action === 'contract_edit') {
      if (detail.diff !== undefined && !ContractEditDiff.safeParse(detail.diff).success) {
        ctx.addIssue({
          code: 'custom',
          message: '계약 편집의 diff는 계약 파일 · 내용 해시 · 종류의 전후입니다',
          path: ['detail', 'diff'],
        });
      }
      if (entry.targetRef.entity !== 'Contract') {
        ctx.addIssue({
          code: 'custom',
          message: '계약 편집의 대상은 계약이어야 합니다',
          path: ['targetRef'],
        });
      }
    }
    // 반영 규범 칸은 제안 승인(승인 · 수정 후 승인)에만 있다 (M3-36 #264, ADR-120). 이 칸을 쓰는 제품 코드는 제안 승인뿐이라
    // 이 변경 전의 행이 형식 위반(체인 검증의 malformed)이 되지 않는다
    if (detail.appliedRef !== undefined && !APPLIED_REF_ACTIONS.includes(action)) {
      ctx.addIssue({
        code: 'custom',
        message: '반영 규범은 제안 승인에만 있습니다',
        path: ['detail', 'appliedRef'],
      });
    }
    if (action !== 'confirm' && detail.seenNormChangeSeq !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: '본 규범 변경 기록 순번은 확인에만 있습니다 (ADR-113)',
        path: ['detail', 'seenNormChangeSeq'],
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

/** 사람의 규칙 진술 편집: 승인 기록 `rule_edit` 가운데 진술이 바뀐 것 (실행 자동 시작의 원인, ADR-109). */
export interface RuleStatementEdit {
  readonly seq: number;
  readonly ruleId: string;
  readonly diff: RuleEditDiff;
}

/** 승인 기록이 진술을 바꾼 규칙 편집이면 그 내용, 아니면(다른 행동 · 제목만 바뀜) `null`. */
export const ruleStatementEditOf = (entry: ApprovalLogEntry): RuleStatementEdit | null => {
  if (entry.action !== 'rule_edit' || entry.targetRef.entity !== 'Rule') return null;
  const diff = RuleEditDiff.safeParse(entry.detail.diff);
  if (!diff.success || diff.data.before.statement === diff.data.after.statement) return null;
  return { seq: entry.seq, ruleId: entry.targetRef.id, diff: diff.data };
};

// ── 규범 변경 기록 (ADR-100 C2 · A2, NRM-07, M7-02 #214, ADR-103) ─────

/** 오케스트레이터 주체 (모델이 아닌 일반 프로그램의 행동: 확인 풀림 · 자동 시작 등, 뒤 이슈가 쓴다). */
export const OrchestratorActor = z.strictObject({ kind: z.literal('orchestrator') });
export type OrchestratorActor = z.infer<typeof OrchestratorActor>;

/** 규범 변경 기록의 주체: 에이전트 역할 또는 오케스트레이터. 사람은 받지 않는다(사람 행동은 승인 기록, C2). */
export const NormChangeActor = z.discriminatedUnion('kind', [AgentAuthor, OrchestratorActor]);
export type NormChangeActor = z.infer<typeof NormChangeActor>;

/** 첫 규범 변경 기록의 `prevHash` (승인 기록과 같은 0 64자, 체인은 접두로 구분한다). */
export const NORM_CHANGE_GENESIS_HASH = APPROVAL_LOG_GENESIS_HASH;

/**
 * 규범 변경 기록 검증 실패 이유. 뜻은 승인 기록의 같은 이름과 같다(`ApprovalLogBreakReason`). 처리된 제안과의 대조
 * (`decision_without_log`)는 없다.
 */
export const NormChangeBreakReason = z.enum([
  'seq_gap',
  'prev_hash_mismatch',
  'hash_mismatch',
  'malformed',
]);
export type NormChangeBreakReason = z.infer<typeof NormChangeBreakReason>;

/** 규범 변경 기록 순번 목록 (원인 기록 ID, 1개 이상 · 중복 없음). 기록 ID는 정수 순번이다(ADR-103). */
const NormChangeSeqList = z
  .array(z.int().positive())
  .min(1)
  .refine((seqs) => new Set(seqs).size === seqs.length, '순번이 중복됐습니다');

/**
 * 판단의 주제 (M7-07 #219, ADR-106). `new_rule` = 규칙 작성 역할이 새 규칙을 만들며 효력 있는 기존 규칙과의 모순을
 * 판단함. `supersede` = 규칙 작성 역할이 기존 규칙을 대체하며 새 규칙이 그 규칙(과 다른 효력 있는 규칙)과 모순이라고 판단함
 * (M7-09 #221, ADR-112: 결과는 늘 모순이고 대체된 규칙이 `contradicts`의 첫 항목). `objection` = 규칙 작성 역할(또는 판단
 * 없이 끝난 경우의 오케스트레이터)이 구현 역할의 이의(종류 `objection` 기록) 대상 규칙 하나를 폐기 · 대체 · 유지로 판단함
 * (M7-11 #223, ADR-115: 결과는 `upheld` · `retired` · `superseded`, 원인 이의 기록 순번 `causeSeq` 필수). `requirement_change` =
 * 사람이 자식 규칙 있는 요구사항을 고치거나 지워 규칙 작성 역할(또는 판단 없이 끝난 경우의 오케스트레이터)이 그 자식 규칙 하나를
 * 폐기 · 대체 · 유지로 다시 판단함(M7-10 #222, ADR-116: 결과는 이의 판단과 같은 세 값, 원인은 `requirementChange` 필수, 삭제에는
 * 대체가 없다). `check_failure` = 검사 단계 · 병합 재검사에서 실행의 대상이 아닌 효력 있는 규칙(판단 대상)이 실패해 규칙 작성
 * 역할(또는 판단 없이 끝난 경우의 오케스트레이터)이 그 규칙과 실행의 대상 규칙이 모순인지 판단함(M7-12 #224, ADR-100 B⑧ · A4 · A5,
 * ADR-118: 결과는 모순 없음 · 모순, 모순이면 `contradicts`가 실행의 대상 규칙, 원인은 `check`). 넓히기만 한다.
 */
export const NormJudgmentSubject = z.enum([
  'new_rule',
  'supersede',
  'objection',
  'requirement_change',
  'check_failure',
]);
export type NormJudgmentSubject = z.infer<typeof NormJudgmentSubject>;

/**
 * 판단 결과. 모순 없음 · 모순(주제 `new_rule` · `supersede`), 이의 판단의 유지 · 폐기 · 대체(주제 `objection`만, M7-11 #223,
 * ADR-115). 넓히기만 한다.
 */
export const NormJudgmentVerdict = z.enum([
  'no_contradiction',
  'contradiction',
  'upheld',
  'retired',
  'superseded',
]);

/** 이의 판단의 결과 (주제 `objection`의 `verdict`. 요구사항 변경 판단 `requirement_change`도 같은 세 값, ADR-116). */
export const OBJECTION_VERDICTS = ['upheld', 'retired', 'superseded'] as const;

/** 규칙 하나를 유지 · 폐기 · 대체로 판단하는 주제 (결과가 {@link OBJECTION_VERDICTS}이고 판단 없음 `undecided`를 받는다). */
export const RULE_DECISION_SUBJECTS = ['objection', 'requirement_change'] as const;

/** 요구사항 변경의 종류 (사람의 수정 · 삭제, M7-10 #222, ADR-116). */
export const NormRequirementChangeKind = z.enum(['updated', 'deleted']);
export type NormRequirementChangeKind = z.infer<typeof NormRequirementChangeKind>;

/**
 * 요구사항 변경 판단의 원인 (M7-10 #222, ADR-116). 사람의 요구사항 편집은 승인 기록 · 규범 변경 기록에 남지 않고 요구사항 자체의
 * 수정 시각에 남으므로(ADR-100) 기록 순번 대신 그 요구사항 · 변경 종류 · 시각(수정이면 `updatedAt`, 삭제면 `deletedAt`) · 판단에
 * 쓴 본문의 SHA-256(UTF-8)을 싣는다.
 */
export const NormJudgmentRequirementChange = z.strictObject({
  requirement: z.strictObject({ id: Ulid, displayId: displayIdSchema('REQ') }),
  change: NormRequirementChangeKind,
  at: Timestamp,
  textHash: Sha256Hex,
});
export type NormJudgmentRequirementChange = z.infer<typeof NormJudgmentRequirementChange>;

/** 판단 주제 표시명 (화면의 변경 이력, 앱이 같은 표를 다시 적고 시험이 대조한다, ADR-115 검토 1회차). */
export const NORM_JUDGMENT_SUBJECT_LABELS = {
  new_rule: '모순 판단',
  supersede: '모순 판단',
  objection: '이의 판단',
  requirement_change: '요구사항 변경 판단',
  check_failure: '검사 실패 판단',
} as const satisfies Record<NormJudgmentSubject, string>;

/** 판단 결과 표시명 (화면의 변경 이력). */
export const NORM_JUDGMENT_VERDICT_LABELS = {
  no_contradiction: '모순 없음',
  contradiction: '모순',
  upheld: '유지',
  retired: '폐기',
  superseded: '대체',
} as const satisfies Record<NormJudgmentVerdict, string>;

/**
 * 판단 없이 끝난 이의 · 검사 실패 판단의 사정 (`undecided.endReason`의 값, M7-11 · ADR-115, M7-12 · ADR-118): 판단 세션의 종료 사유, 세션을 열지 못한 사유, 재기동으로
 * 끊김. 저장 칸은 문자열 그대로 받는다(넓히기만). 화면은 이 표의 표시명으로 그리고 모르는 값은 날 값을 내지 않는다.
 */
export const NormUndecidedReason = z.enum([
  ...SessionEndReason.options,
  'project_daily_budget_exceeded',
  'budget_exhausted',
  'settings_incomplete',
  'start_failed',
  'not_configured',
  'interrupted',
]);
export type NormUndecidedReason = z.infer<typeof NormUndecidedReason>;
export const NORM_UNDECIDED_REASON_LABELS = {
  ...SESSION_END_REASON_LABELS,
  project_daily_budget_exceeded: '프로젝트 하루 예산 초과',
  budget_exhausted: '실행 예산 소진',
  settings_incomplete: '예산 · 모델 미설정',
  start_failed: '시작 실패',
  not_configured: '판단 경로 없음',
  interrupted: '오케스트레이터 재기동',
} as const satisfies Record<NormUndecidedReason, string>;
export type NormJudgmentVerdict = z.infer<typeof NormJudgmentVerdict>;

/** 판단이 가리키는 규칙 (판단 시점의 ID와 표시 ID). */
export const NormJudgmentRuleRef = z.strictObject({ id: Ulid, displayId: displayIdSchema('RULE') });
export type NormJudgmentRuleRef = z.infer<typeof NormJudgmentRuleRef>;

/** 검사 실패 판단에 싣는 케이스 이름 수 상한 (규칙 하나, M7-12 · ADR-118). 규범 입력의 규칙당 케이스 수와 같다. */
export const NORM_CHECK_CASES_MAX = 20;
/** 검사 실패 판단에 싣는 케이스 이름 하나의 상한 (저장 원문 기준 UTF-16 코드 단위). 규범 입력의 케이스 이름 상한과 같다. */
export const NORM_CHECK_CASE_NAME_MAX = 200;

/**
 * 검사 실패 판단의 원인 (주제 `check_failure`에만, M7-12 #224 · ADR-118). 원인은 규범 변경 기록이 아니라 검사 단계 · 병합 재검사의
 * 판정이라 그 단계 시도와 판정 내용 가운데 판단 입력이 된 것만 싣는다(ADR-100 A5: 실패한 규칙 ID와 케이스 이름뿐). 실패한 규칙은
 * 기록의 대상(`targetRef`), 실행은 기록의 연결 실행이다.
 * - `stage`: 검사 단계(`check`) 또는 병합 재검사(`merge_recheck`), `stepId`: 그 단계 시도
 * - `targets`: 그 실행의 대상 규칙 (판단의 다른 쪽, 1개 이상 · 중복 없음)
 * - `cases`: 실패한 케이스 이름 가운데 그 규칙의 인수 테스트 파일에 적힌 이름 (원문을 {@link NORM_CHECK_CASE_NAME_MAX}에서 자른
 *   것, 최대 {@link NORM_CHECK_CASES_MAX}개). 저장은 원문이고 응답은 표시 값이라 칸의 상한은 표시 값 상한까지 받는다
 * - `unknownCases`: 인수 테스트 파일에서 찾지 못한 실패 케이스 수 (이름은 싣지 않는다), `omittedCases`: 상한 때문에 빠진 수
 */
export const NormCheckFailureCause = z.strictObject({
  stage: z.enum(['check', 'merge_recheck']),
  stepId: Ulid,
  targets: z
    .array(NormJudgmentRuleRef)
    .min(1)
    .refine(
      (rules) => new Set(rules.map((rule) => rule.id)).size === rules.length,
      '대상 규칙이 중복됐습니다',
    ),
  cases: z.array(z.string().min(1).max(4000)).max(NORM_CHECK_CASES_MAX),
  unknownCases: NonNegativeInt,
  omittedCases: NonNegativeInt,
});
export type NormCheckFailureCause = z.infer<typeof NormCheckFailureCause>;

/** 판단할 때 받은 규범 입력의 수 (효력 있는 전체 · 실은 것, ADR-100 A15). */
const NormJudgmentInputCount = z
  .strictObject({ total: NonNegativeInt, included: NonNegativeInt })
  .refine((count) => count.included <= count.total, '실은 수가 전체보다 많습니다');

/**
 * 규범 담당 역할의 판단 상세 (종류 `judgment`, M7-07 #219, ADR-106). 근거 글은 기록의 `reason`에 있다.
 * - `contradicts`: 모순 대상 규칙. 결과가 모순이면 1개 이상, 모순 없음이면 빈 목록
 * - `createdSeq`: 주제가 새 규칙이면 같은 트랜잭션에서 남긴 그 규칙의 신규 기록 순번(필수)
 * - `input`: 판단할 때 작업 지시에 실린 규범 수 (잘렸으면 `included < total`)
 */
export const NormJudgmentDetail = z
  .strictObject({
    subject: NormJudgmentSubject,
    verdict: NormJudgmentVerdict,
    contradicts: z.array(NormJudgmentRuleRef),
    createdSeq: z.int().positive().optional(),
    /** 원인 기록 순번 (주제 `objection`이면 그 이의 기록, 필수. M7-11) */
    causeSeq: z.int().positive().optional(),
    /**
     * 판단 세션이 이 규칙을 판단하지 못하고 끝나 오케스트레이터가 유지로 본 사실 (주제 `objection` · 결과 `upheld`, 주제
     * `check_failure` · 결과 `no_contradiction`, 주체 오케스트레이터에만, M7-11 · M7-12). `endReason`은 판단 세션의 종료 사유 또는
     * 세션을 열지 못한 사유
     */
    undecided: z.strictObject({ endReason: z.string().min(1).max(64) }).optional(),
    /** 원인 요구사항 변경 (주제 `requirement_change`이면 필수, 다른 판단에는 없음. M7-10) */
    requirementChange: NormJudgmentRequirementChange.optional(),
    /** 검사 실패 판단의 원인 (주제 `check_failure`에만 · 필수, M7-12) */
    check: NormCheckFailureCause.optional(),
    input: z.strictObject({
      requirements: NormJudgmentInputCount,
      rules: NormJudgmentInputCount,
    }),
  })
  .superRefine((judgment, ctx) => {
    if ((judgment.verdict === 'contradiction') !== judgment.contradicts.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: '모순 판단에는 대상 규칙이 1개 이상, 모순 없음에는 대상 규칙이 없어야 합니다',
        path: ['contradicts'],
      });
    }
    if (new Set(judgment.contradicts.map((rule) => rule.id)).size !== judgment.contradicts.length) {
      ctx.addIssue({ code: 'custom', message: '대상 규칙이 중복됐습니다', path: ['contradicts'] });
    }
    if (
      (judgment.subject === 'new_rule' || judgment.subject === 'supersede') &&
      judgment.createdSeq === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: '새 규칙의 판단에는 그 규칙의 신규 기록 순번이 필요합니다',
        path: ['createdSeq'],
      });
    }
    if (judgment.subject === 'supersede' && judgment.verdict !== 'contradiction') {
      ctx.addIssue({
        code: 'custom',
        message: '대체의 판단은 모순입니다 (대체된 규칙과 동시에 만족될 수 없음)',
        path: ['verdict'],
      });
    }
    // 이의 판단 (M7-11, ADR-115) · 요구사항 변경 판단 (M7-10, ADR-116): 결과는 유지 · 폐기 · 대체만. 그 결과 값 · 판단 없음은
    // 두 주제에만, 원인은 주제마다 하나(이의 기록 순번 · 요구사항 변경)
    const decisionVerdict = (OBJECTION_VERDICTS as readonly string[]).includes(judgment.verdict);
    const decisionSubject = (RULE_DECISION_SUBJECTS as readonly string[]).includes(
      judgment.subject,
    );
    if (decisionSubject !== decisionVerdict) {
      ctx.addIssue({
        code: 'custom',
        message:
          '이의 · 요구사항 변경 판단의 결과는 유지 · 폐기 · 대체이고, 그 결과는 두 판단에만 있습니다',
        path: ['verdict'],
      });
    }
    if (
      (judgment.subject === 'requirement_change') !==
      (judgment.requirementChange !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: '요구사항 변경 판단에는 원인 요구사항 변경이 필요하고, 다른 판단에는 없습니다',
        path: ['requirementChange'],
      });
    }
    if (judgment.requirementChange?.change === 'deleted' && judgment.verdict === 'superseded') {
      ctx.addIssue({
        code: 'custom',
        message: '지운 요구사항의 자식 규칙은 대체할 수 없습니다 (새 규칙의 부모가 없다)',
        path: ['verdict'],
      });
    }
    if (
      judgment.subject === 'requirement_change' &&
      (judgment.verdict === 'superseded') !== (judgment.createdSeq !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          '요구사항 변경 판단의 대체에는 새 규칙의 신규 기록 순번이 필요하고, 유지 · 폐기에는 없습니다',
        path: ['createdSeq'],
      });
    }
    if ((judgment.subject === 'objection') !== (judgment.causeSeq !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: '이의 판단에는 원인 이의 기록 순번이 필요하고, 다른 판단에는 없습니다',
        path: ['causeSeq'],
      });
    }
    // 판단 없음은 이의 · 요구사항 변경 판단의 유지 · 검사 실패 판단의 모순 없음에만 (판단 없음을 폐기 · 모순으로 보지 않는다,
    // M7-10 · M7-12)
    if (
      judgment.undecided !== undefined &&
      !(
        (decisionSubject && judgment.verdict === 'upheld') ||
        (judgment.subject === 'check_failure' && judgment.verdict === 'no_contradiction')
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          '판단 없이 끝난 이의 · 요구사항 변경 판단은 유지로, 검사 실패 판단은 모순 없음으로만 남깁니다 (판단 없음을 폐기 · 모순으로 보지 않는다)',
        path: ['undecided'],
      });
    }
    // 검사 실패 판단 (M7-12, ADR-118): 원인은 필수이고 그 판단에만. 모순이면 대상 규칙(실행의 대상 규칙)이 `contradicts`다
    if ((judgment.subject === 'check_failure') !== (judgment.check !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: '검사 실패 판단에는 원인(check)이 필요하고, 다른 판단에는 없습니다',
        path: ['check'],
      });
    }
    if (judgment.subject === 'check_failure' && judgment.check !== undefined) {
      const targets = judgment.check.targets.map((rule) => rule.id);
      if (
        judgment.verdict === 'contradiction' &&
        (judgment.contradicts.length !== targets.length ||
          judgment.contradicts.some((rule) => !targets.includes(rule.id)))
      ) {
        ctx.addIssue({
          code: 'custom',
          message: '검사 실패 판단의 모순 대상은 그 실행의 대상 규칙입니다',
          path: ['contradicts'],
        });
      }
    }
  });
export type NormJudgmentDetail = z.infer<typeof NormJudgmentDetail>;

/**
 * 폐기 · 대체 상세 (종류 `retired` · `superseded`, M7-09 #221, ADR-112). 근거 글은 기록의 `reason`, 폐기 직전 규칙 내용은
 * `before`에 있다.
 * - `supersededBy`: 대체한 새 규칙 (대체면 필수, 폐기만이면 `null`)
 * - `createdSeq` · `judgmentSeq`: 대체면 같은 트랜잭션에서 남긴 새 규칙의 신규 · 판단 기록 순번(필수), 폐기만이면 없음
 */
export const NormRetirementDetail = z.strictObject({
  supersededBy: NormJudgmentRuleRef.nullable(),
  createdSeq: z.int().positive().optional(),
  judgmentSeq: z.int().positive().optional(),
});
export type NormRetirementDetail = z.infer<typeof NormRetirementDetail>;

/**
 * 확인 풀림 상세 (종류 `unconfirmed`, M7-13 #225, ADR-100 D3, ADR-113). 사람이 확인한 규칙을 에이전트가 폐기 · 대체하면
 * 오케스트레이터가 그 변경과 같은 트랜잭션에서 확인을 풀고 이 기록을 남긴다. 풀린 시각은 기록의 `at`이다.
 * - `causeSeq`: 원인 규범 변경 기록(`retired` · `superseded`, 같은 대상)의 순번
 * - `previous`: 풀리기 전의 확인(누가 언제 무엇을 근거로). 확인 행은 미확인이 되어 이 값을 잃으므로 기록에 옮겨 둔다
 */
export const NormUnconfirmDetail = z.strictObject({
  causeSeq: z.int().positive(),
  previous: Confirmation.refine(
    (confirmation) => confirmation.state === 'confirmed',
    '풀리기 전 확인은 확인됨이어야 합니다',
  ),
});
export type NormUnconfirmDetail = z.infer<typeof NormUnconfirmDetail>;

/** 테스트 변경 알림의 파일 1개: 실행 시작 때 있던 인수 테스트 파일의 바뀜(내용이 달라짐) · 지움 (M7-13). */
export const NormTestChangeFile = z.strictObject({
  /** 저장소 기준 경로 (`bive-acceptance/<규칙 표시 ID>/…`) */
  path: z.string().min(1).max(1024),
  change: z.enum(['modified', 'removed']),
});
export type NormTestChangeFile = z.infer<typeof NormTestChangeFile>;

/** 테스트 변경 알림에 싣는 파일 수 상한 (넘으면 `fileCount`만 전체 수). */
export const NORM_TEST_CHANGE_FILES_MAX = 100;

/**
 * 테스트 변경 알림 상세 (종류 `test_changed`, M7-13 #225, ADR-100 G, ADR-113). 확인됨 규칙의 기존 인수 테스트 파일을
 * 실행이 바꿔 병합했을 때 오케스트레이터가 남긴다. 확인 상태는 그대로다.
 * - `files`: 바뀐 · 지운 파일 (경로 순, 최대 {@link NORM_TEST_CHANGE_FILES_MAX}), `fileCount`: 전체 수
 * - `baseCommit` · `headCommit`: 비교한 두 커밋 (실행 시작 때 기준 브랜치 · 병합한 실행 브랜치 끝)
 */
export const NormTestChangeDetail = z
  .strictObject({
    files: z.array(NormTestChangeFile).min(1).max(NORM_TEST_CHANGE_FILES_MAX),
    fileCount: z.int().positive(),
    baseCommit: CommitSha,
    headCommit: CommitSha,
  })
  .refine((detail) => detail.fileCount >= detail.files.length, '전체 수가 실은 수보다 작습니다');
export type NormTestChangeDetail = z.infer<typeof NormTestChangeDetail>;

/** 이의 기록에 싣는 대상 규칙 수 상한 (M7-11, ADR-115). */
export const NORM_OBJECTION_RULES_MAX = 5;

/**
 * 이의 상세 (종류 `objection`, M7-11 #223, ADR-100 D4 · A4 · A5, ADR-115). 구현 역할이 실행 안에서 규칙이 잘못됐다고 본 사실이다.
 * 사유 글은 기록의 `reason`(원문)에 있다.
 * - `rules`: 이의 대상 규칙 (이의를 남긴 시점의 ID와 표시 ID, 1 ~ {@link NORM_OBJECTION_RULES_MAX}개 · 중복 없음)
 * - `stepId`: 이의를 남긴 구현 단계 시도
 */
export const NormObjectionDetail = z.strictObject({
  rules: z
    .array(NormJudgmentRuleRef)
    .min(1)
    .max(NORM_OBJECTION_RULES_MAX)
    .refine(
      (rules) => new Set(rules.map((rule) => rule.id)).size === rules.length,
      '대상 규칙이 중복됐습니다',
    ),
  stepId: Ulid,
});
export type NormObjectionDetail = z.infer<typeof NormObjectionDetail>;

/**
 * 종류별 상세. 신규는 `after`(만든 규범의 내용)만, 자동 시작은 원인 하나와 `ruleIds`(대상 규칙, 같은 순서)다. 원인은
 * `causeSeqs`(대상 규칙의 신규 기록 순번, M7-05 #217 · ADR-107) 또는 `ruleEditSeqs`(사람의 규칙 진술 편집 = 승인 기록
 * `rule_edit`의 순번, M7-03 #215 · ADR-109) 가운데 정확히 하나다. 두 순번은 다른 기록의 번호라 칸을 나눴다(같은 수가 서로를
 * 가리키지 않게). 그 밖의 종류가 쓰는 칸은 그 이슈가 더한다(넓히기만 한다).
 * 값은 에이전트가 쓴 글을 담을 수 있어 화면 · 응답에는 표시 값으로만 내보낸다(ADR-089).
 */
export const NormChangeDetail = z.strictObject({
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  /**
   * 동작 선언 (종류 `created`에만, 규칙 작성 역할이 만든 규칙, M3-30 #245 · ADR-151). 선언을 읽는 자리는 이 칸 하나다(다른 곳에
   * 복사하지 않는다). 이 칸이 없는 신규 기록(이 변경 전의 기록 · 사람 · 오케스트레이터가 만든 규칙)은 "모름"이다
   */
  behavior: RuleBehavior.optional(),
  causeSeqs: NormChangeSeqList.optional(),
  /** 원인 승인 기록(사람의 규칙 진술 편집 `rule_edit`)의 순번 (종류 `auto_start`에만, M7-03) */
  ruleEditSeqs: NormChangeSeqList.optional(),
  /**
   * 원인 변이 판정 기록(병합된 유형 A 실행의 '변이 생존' 기록)의 ID (종류 `auto_start`에만, 변이 생존의 자동 테스트 보강, M3-54 #311 ·
   * ADR-141 ② · ADR-143)
   */
  mutationResultIds: z
    .array(Ulid)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, '원인 변이 기록이 중복됐습니다')
    .optional(),
  ruleIds: z
    .array(Ulid)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, '대상 규칙이 중복됐습니다')
    .optional(),
  /** 판단 (종류 `judgment`에만, M7-07) */
  judgment: NormJudgmentDetail.optional(),
  /** 폐기 · 대체 (종류 `retired` · `superseded`에만, M7-09) */
  retirement: NormRetirementDetail.optional(),
  /** 확인 풀림 (종류 `unconfirmed`에만, M7-13) */
  unconfirm: NormUnconfirmDetail.optional(),
  /** 테스트 변경 알림 (종류 `test_changed`에만, M7-13) */
  testChange: NormTestChangeDetail.optional(),
  /** 이의 (종류 `objection`에만, M7-11) */
  objection: NormObjectionDetail.optional(),
});
export type NormChangeDetail = z.infer<typeof NormChangeDetail>;

/**
 * 규범 변경 기록 1건 (추가 전용). `hash` = SHA-256("bive-norm-change-v1\n" + 정규 JSON(`hash`를 뺀 나머지 필드)),
 * `prevHash` = 바로 앞 기록의 `hash`(첫 기록은 {@link NORM_CHANGE_GENESIS_HASH}). 계산 · 검증은 `@bive/store`.
 * - `sessionId`: 그 행동을 한 에이전트 세션(BIVE 세션 기록 ID). 에이전트 주체면 필수
 * - `runId`: 연결된 실행 (NRM-07 "연결 실행"). 없으면 `null`
 * - `reason`: 사유 · 근거. 에이전트 주체면 필수 (ADR-100 명세 변경 NRM-07 "에이전트 변경마다 사유 · 근거 필수")
 */
export const NormChangeEntry = z
  .strictObject({
    seq: z.int().positive(),
    at: Timestamp,
    kind: NormChangeKind,
    actor: NormChangeActor,
    targetRef: EntityRef,
    sessionId: Ulid.nullable(),
    runId: Ulid.nullable(),
    reason: NonBlankText.nullable(),
    detail: NormChangeDetail,
    prevHash: Sha256Hex,
    hash: Sha256Hex,
  })
  .superRefine((entry, ctx) => {
    if (entry.actor.kind === 'agent') {
      if (entry.sessionId === null) {
        ctx.addIssue({
          code: 'custom',
          message: '에이전트의 규범 변경에는 세션 ID가 필요합니다',
          path: ['sessionId'],
        });
      }
      if (entry.reason === null) {
        ctx.addIssue({
          code: 'custom',
          message: '에이전트의 규범 변경에는 사유가 필요합니다 (NRM-07, ADR-100)',
          path: ['reason'],
        });
      }
    }
    // 동작 선언은 규칙의 신규 기록에만 (M3-30, ADR-151)
    if (
      entry.detail.behavior !== undefined &&
      (entry.kind !== 'created' || entry.targetRef.entity !== 'Rule')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: '동작 선언(behavior)은 규칙의 신규 기록에만 있습니다',
        path: ['detail', 'behavior'],
      });
    }
    if (entry.kind === 'created') {
      if (entry.detail.after === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: '신규에는 만든 내용(after)이 필요합니다',
          path: ['detail', 'after'],
        });
      }
      if (entry.detail.before !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: '신규에는 이전 내용(before)이 없습니다',
          path: ['detail', 'before'],
        });
      }
    }
    if (entry.kind === 'auto_start') {
      // 실행 자동 시작 (M7-05, ADR-107): 주체는 오케스트레이터, 대상은 그 실행, 원인 기록과 대상 규칙이 한 쌍씩 있다
      if (entry.actor.kind !== 'orchestrator') {
        ctx.addIssue({
          code: 'custom',
          message: '자동 시작의 주체는 오케스트레이터입니다',
          path: ['actor'],
        });
      }
      if (entry.targetRef.entity !== 'Run' || entry.runId !== entry.targetRef.id) {
        ctx.addIssue({
          code: 'custom',
          message: '자동 시작의 대상은 그 실행이고 연결 실행과 같아야 합니다',
          path: ['targetRef'],
        });
      }
      const { causeSeqs, ruleEditSeqs, mutationResultIds, ruleIds } = entry.detail;
      // 원인은 신규 기록 순번 · 규칙 편집 승인 기록 순번 · 변이 판정 기록 ID 가운데 하나만 (M7-03 · ADR-109, M3-54 · ADR-143)
      const kinds = [causeSeqs, ruleEditSeqs, mutationResultIds].filter((c) => c !== undefined);
      const causes = causeSeqs ?? ruleEditSeqs ?? mutationResultIds;
      if (kinds.length > 1) {
        ctx.addIssue({
          code: 'custom',
          message:
            '자동 시작의 원인은 신규 기록 순번 · 규칙 편집 순번 · 변이 기록 가운데 하나만 둡니다',
          path: ['detail', ruleEditSeqs === undefined ? 'mutationResultIds' : 'ruleEditSeqs'],
        });
      } else if (
        causes === undefined ||
        ruleIds === undefined ||
        causes.length !== ruleIds.length
      ) {
        ctx.addIssue({
          code: 'custom',
          message: '자동 시작에는 원인 기록 순번과 대상 규칙이 같은 수만큼 필요합니다',
          path: ['detail', 'causeSeqs'],
        });
      }
    } else if (entry.detail.ruleEditSeqs !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: '규칙 편집 순번은 자동 시작에만 있습니다',
        path: ['detail', 'ruleEditSeqs'],
      });
    } else if (entry.detail.mutationResultIds !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: '원인 변이 기록은 자동 시작에만 있습니다',
        path: ['detail', 'mutationResultIds'],
      });
    }
    // 판단 상세는 판단 기록에만, 판단 기록에는 판단 상세만 (M7-07)
    if ((entry.kind === 'judgment') !== (entry.detail.judgment !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: '판단 상세(judgment)는 판단 기록에만 있고 판단 기록에는 반드시 있습니다',
        path: ['detail', 'judgment'],
      });
    }
    if (
      entry.kind === 'judgment' &&
      (entry.detail.before !== undefined || entry.detail.after !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: '판단 기록에는 이전 · 이후 내용이 없습니다',
        path: ['detail'],
      });
    }
    // 폐기 · 대체 상세는 폐기 · 대체 기록에만, 그 기록에는 반드시 (M7-09, ADR-112)
    const retiring = entry.kind === 'retired' || entry.kind === 'superseded';
    const retirement = entry.detail.retirement;
    if (retiring !== (retirement !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message:
          '폐기 · 대체 상세(retirement)는 폐기 · 대체 기록에만 있고 그 기록에는 반드시 있습니다',
        path: ['detail', 'retirement'],
      });
    }
    if (retiring) {
      if (entry.targetRef.entity !== 'Rule') {
        ctx.addIssue({
          code: 'custom',
          message: '폐기 · 대체의 대상은 규칙입니다',
          path: ['targetRef'],
        });
      }
      if (entry.detail.before === undefined || entry.detail.after !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: '폐기 · 대체에는 폐기 직전 내용(before)만 있습니다',
          path: ['detail'],
        });
      }
    }
    if (retirement !== undefined) {
      const superseding = entry.kind === 'superseded';
      const complete =
        retirement.supersededBy !== null &&
        retirement.createdSeq !== undefined &&
        retirement.judgmentSeq !== undefined;
      const bare =
        retirement.supersededBy === null &&
        retirement.createdSeq === undefined &&
        retirement.judgmentSeq === undefined;
      if (superseding ? !complete : !bare) {
        ctx.addIssue({
          code: 'custom',
          message:
            '대체에는 새 규칙과 그 신규 · 판단 기록 순번이 필요하고, 폐기에는 그 칸이 없습니다',
          path: ['detail', 'retirement'],
        });
      }
    }
    // 확인 풀림 · 테스트 변경 알림 (M7-13, ADR-113): 상세는 그 종류에만, 그 종류에는 반드시. 주체는 오케스트레이터, 대상은 규칙
    const notices = [
      ['unconfirmed', entry.detail.unconfirm, 'unconfirm'],
      ['test_changed', entry.detail.testChange, 'testChange'],
    ] as const;
    for (const [kind, detail, key] of notices) {
      if ((entry.kind === kind) !== (detail !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          message: `${key} 상세는 ${kind} 기록에만 있고 그 기록에는 반드시 있습니다`,
          path: ['detail', key],
        });
      }
      if (entry.kind !== kind) continue;
      if (entry.actor.kind !== 'orchestrator') {
        ctx.addIssue({
          code: 'custom',
          message: '확인 풀림 · 테스트 변경 알림의 주체는 오케스트레이터입니다',
          path: ['actor'],
        });
      }
      if (entry.targetRef.entity !== 'Rule' || !Ulid.safeParse(entry.targetRef.id).success) {
        ctx.addIssue({
          code: 'custom',
          message: '확인 풀림 · 테스트 변경 알림의 대상은 규칙입니다',
          path: ['targetRef'],
        });
      }
      if (entry.detail.before !== undefined || entry.detail.after !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: '확인 풀림 · 테스트 변경 알림에는 이전 · 이후 내용이 없습니다',
          path: ['detail'],
        });
      }
    }
    if (entry.kind === 'test_changed' && entry.runId === null) {
      ctx.addIssue({
        code: 'custom',
        message: '테스트 변경 알림에는 그 테스트를 바꾼 실행이 필요합니다',
        path: ['runId'],
      });
    }
    // 이의 (M7-11, ADR-115): 상세는 이의 기록에만, 이의 기록에는 반드시. 주체는 구현 역할, 대상은 그 실행
    if ((entry.kind === 'objection') !== (entry.detail.objection !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'objection 상세는 이의 기록에만 있고 그 기록에는 반드시 있습니다',
        path: ['detail', 'objection'],
      });
    }
    if (entry.kind === 'objection') {
      if (entry.actor.kind !== 'agent' || entry.actor.role !== 'implementer') {
        ctx.addIssue({
          code: 'custom',
          message: '이의의 주체는 구현 역할입니다',
          path: ['actor'],
        });
      }
      if (entry.targetRef.entity !== 'Run' || entry.runId !== entry.targetRef.id) {
        ctx.addIssue({
          code: 'custom',
          message: '이의의 대상은 그 실행이고 연결 실행과 같아야 합니다',
          path: ['targetRef'],
        });
      }
      if (entry.detail.before !== undefined || entry.detail.after !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: '이의에는 이전 · 이후 내용이 없습니다',
          path: ['detail'],
        });
      }
    }
    // 이의 판단 · 검사 실패 판단 (실행 안 판단, M7-11 · M7-12): 대상은 판단한 규칙, 연결 실행 필수. 판단 없음은 오케스트레이터만,
    // 판단은 규칙 작성 역할만
    const judged = entry.detail.judgment;
    if (
      entry.kind === 'judgment' &&
      (judged?.subject === 'objection' || judged?.subject === 'check_failure')
    ) {
      if (entry.targetRef.entity !== 'Rule' || entry.runId === null) {
        ctx.addIssue({
          code: 'custom',
          message: '실행 안 판단의 대상은 규칙이고 연결 실행이 필요합니다',
          path: ['targetRef'],
        });
      }
    }
    // 이의 · 요구사항 변경 · 검사 실패 판단의 주체: 판단 없음은 오케스트레이터만, 판단은 규칙 작성 역할만
    if (
      entry.kind === 'judgment' &&
      judged !== undefined &&
      ((RULE_DECISION_SUBJECTS as readonly string[]).includes(judged.subject) ||
        judged.subject === 'check_failure')
    ) {
      const fallback = judged.undecided !== undefined;
      const actorOk = fallback
        ? entry.actor.kind === 'orchestrator'
        : entry.actor.kind === 'agent' && entry.actor.role === 'rule-writer';
      if (!actorOk) {
        ctx.addIssue({
          code: 'custom',
          message:
            '이의 · 요구사항 변경 · 검사 실패 판단의 주체는 규칙 작성 역할이고, 판단 없이 끝난 판단은 오케스트레이터입니다',
          path: ['actor'],
        });
      }
    }
    // 요구사항 변경 판단 (M7-10, ADR-116): 대상은 판단한 규칙, 실행 밖 세션이라 연결 실행이 없다
    if (entry.kind === 'judgment' && judged?.subject === 'requirement_change') {
      if (entry.targetRef.entity !== 'Rule' || entry.runId !== null) {
        ctx.addIssue({
          code: 'custom',
          message: '요구사항 변경 판단의 대상은 규칙이고 연결 실행이 없습니다',
          path: ['targetRef'],
        });
      }
    }
  });
export type NormChangeEntry = z.infer<typeof NormChangeEntry>;

// ── 실행 ─────────────────────────────────────────────────

/** 검사 실패 → 구현 회귀 상한 (RUN-02 확정). 초과하면 실행 `failed`. */
export const MAX_REGRESSION_COUNT = 2;

/**
 * 실행 유형별 단계 순서 (RUN-02 · RUN-07, architecture.md 4장, ADR-061 · ADR-020 · ADR-136).
 * 변이 주입은 변이 주입 실행기가 유형 A(새 변이) · 보강 실행인 유형 C(재주입)에서만 돌리고, 대상이 없거나 그 밖의 유형이면
 * `skipped`로 기록한다(M3-54 #311, ADR-143). 유형이 생략하는 단계도 계획에 두고 엔진이 `skipped`로
 * 기록한다(`RUN_TYPE_SKIPPED_STEPS`, 화면의 파이프라인이 "생략"으로 보인다). 순서는 모든 유형이 `StepKind` 정의 순서를 따른다.
 * - B 정적 검사: 테스트 작성 · Red 확인 생략
 * - C 코드 유지 · 테스트만: Red 확인 대신 Green 확인, 구현 생략
 * - D 리팩터링 · 되돌리기: 테스트 작성 · Red 확인 생략, 구현 앞 Green 확인이 기준 검사(기준 커밋의 기존 검사 전부 통과)
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
  B: [
    'approval',
    'test_writing',
    'red_check',
    'implementation',
    'check',
    'mutation',
    'merge',
    'screen_update',
  ],
  C: [
    'approval',
    'test_writing',
    'green_check',
    'implementation',
    'check',
    'mutation',
    'merge',
    'screen_update',
  ],
  D: [
    'approval',
    'test_writing',
    'red_check',
    'green_check',
    'implementation',
    'check',
    'merge',
    'screen_update',
  ],
} as const satisfies Record<RunType, readonly StepKind[]>;

/**
 * 유형이 생략하는 단계 (RUN-07, ADR-020 · ADR-136): 엔진이 실행기를 부르지 않고 `skipped`로 기록한다. 변이 주입은 유형 A · C(보강)만
 * 하므로(ADR-020) 유형 B도 생략한다(M3-07 #52, ADR-139: 그 유형의 예산 · 모델 스냅샷에 변이 주입 역할이 들지 않는다). 유형 A · C의
 * 변이 주입 단계를 실제로 돌릴지는 변이 주입 실행기가 정한다.
 */
export const RUN_TYPE_SKIPPED_STEPS = {
  A: [],
  B: ['test_writing', 'red_check', 'mutation'],
  C: ['implementation'],
  D: ['test_writing', 'red_check'],
} as const satisfies Record<RunType, readonly StepKind[]>;

/** 그 유형이 생략하는 단계인지. */
export const isRunTypeSkippedStep = (type: RunType, kind: StepKind): boolean =>
  (RUN_TYPE_SKIPPED_STEPS[type] as readonly StepKind[]).includes(kind);

/** 유형별 실제로 도는 단계의 역할 (생략 단계의 역할은 스냅샷에 넣지 않는다). */
export const runTypeRoles = (type: RunType): AgentRole[] =>
  stepRoles(RUN_STEP_PLANS[type].filter((kind) => !isRunTypeSkippedStep(type, kind)));

/**
 * 자동 시작 · 다시 시작 · 편집 뒤 시작이 만드는 실행 유형 (ADR-020 · ADR-136: B · C · D는 사람의 [실행]으로만). 예외는 변이 생존의
 * 자동 테스트 보강으로, 오케스트레이터가 유형 C 실행을 만든다(M3-54 #311, ADR-141 · ADR-143).
 */
export const M1_RUN_TYPE = 'A' as const satisfies RunType;

/** 단계를 수행하는 에이전트 역할. 사람 · 판정기 · 오케스트레이터 단계는 `null` (architecture.md 4장 단계표). */
export const STEP_ROLES = {
  approval: null,
  test_writing: 'test-writer',
  red_check: null,
  green_check: null,
  implementation: 'implementer',
  check: null,
  mutation: 'mutator',
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
 * 실행 자동 시작의 시작 주체 (M7-05 #217, ADR-100 A2 · C2, ADR-107): 오케스트레이터. 원인 기록의 순번이 1개 이상 있어야 한다.
 * - `causeLog` 없음: 원인은 규범 변경 기록(대상 규칙을 만든 신규 기록)의 순번
 * - `causeLog: 'approval_log'`: 원인은 승인 기록(사람의 규칙 진술 편집 `rule_edit`)의 순번 1개 (M7-03 #215, ADR-109).
 *   `runs.started_by`의 DB CHECK(0016)가 `causeSeqs`를 요구하므로 표를 다시 만들지 않고 어느 기록의 순번인지만 더했다
 * - `causeLog: 'mutation_reinforcements'`: 원인은 변이 보강 연결(`mutation_reinforcements`, 실행 ↔ 원인 변이 기록)의 순번 1개
 *   (M3-54 #311, ADR-143). 자동 시작 항목의 원인은 그 연결이 가리키는 변이 기록 ID(`mutationResultIds`)다
 * 엔진은 시작마다 이 순번이 규범 변경 기록의 자동 시작 항목 1건(`causeSeqs` · `ruleEditSeqs` · `mutationResultIds`)과 맞는지 본다.
 */
export const AutoStartRunStarter = z
  .strictObject({
    kind: z.literal('orchestrator'),
    causeSeqs: NormChangeSeqList,
    causeLog: z.enum(['approval_log', 'mutation_reinforcements']).optional(),
  })
  .refine((starter) => starter.causeLog === undefined || starter.causeSeqs.length === 1, {
    message: '규칙 편집 · 변이 보강으로 시작한 실행의 원인은 기록 1건입니다',
    path: ['causeSeqs'],
  });
export type AutoStartRunStarter = z.infer<typeof AutoStartRunStarter>;

/** 실행의 시작 주체: 사람(실행 시작 확인, 승인 기록 `run_start`) 또는 오케스트레이터(자동 시작, 규범 변경 기록 `auto_start`). */
export const RunStarter = z.discriminatedUnion('kind', [HumanAuthor, AutoStartRunStarter]);
export type RunStarter = z.infer<typeof RunStarter>;

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
  startedBy: RunStarter,
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

/** 이어받은 단계 시도의 생략 사유 (`exitDetail.reason`, M3-60 #325, ADR-152). 화면은 단계의 종료 조건 결과를 보이지 않아 표시명이 없다. */
export const INHERITED_STEP_REASON = 'inherited';

/**
 * 이어받은 단계 시도의 종료 조건 결과 (`skipped`, M3-60 #325, ADR-147 ③, ADR-150 ③ⓐ, ADR-152). 이어받는 실행은 원 실행이 끝낸 앞 단계를 다시
 * 돌지 않고 `passed` 행도 만들지 않는다. 이 기록은 그 단계를 실제로 돈 실행의 시도(`fromRunId` · `fromStepId`, 그 시도의 상태 `fromStatus`)를
 * 가리킨다(사슬이면 거슬러 올라간 시도). 판정 근거는 복사하지 않고 그 시도에서 읽는다.
 */
export const InheritedStepDetail = z.strictObject({
  reason: z.literal(INHERITED_STEP_REASON),
  fromRunId: Ulid,
  fromStepId: Ulid,
  fromStatus: z.enum(['passed', 'skipped']),
});
export type InheritedStepDetail = z.infer<typeof InheritedStepDetail>;

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
 * 규범 입력의 한 종류 수: 효력 있는 전체 · 실은 것 · 상한으로 빠진 것 (ADR-106 · ADR-108). 대상 블록으로 골랐으면 블록 밖이라 뺀
 * 수(`outOfBlock`)가 따로 있다(M3-29 #231, ADR-140. 고르지 않은 기록은 옛 모양 그대로).
 */
export const SessionNormInputCount = z
  .strictObject({
    total: NonNegativeInt,
    included: NonNegativeInt,
    omitted: NonNegativeInt,
    outOfBlock: NonNegativeInt.optional(),
  })
  .refine(
    (count) => count.total === count.included + count.omitted + (count.outOfBlock ?? 0),
    '전체 = 실은 것 + 빠진 것 + 블록 밖',
  );
export type SessionNormInputCount = z.infer<typeof SessionNormInputCount>;

/**
 * 세션이 작업 지시로 받은 규범 입력의 기록 (ADR-100 K1 · A15, ADR-106 · ADR-108): 수 · 잘린 사실과 실은 항목의 표시 ID
 * (자료에 실린 순서 = 표시 ID 순). 세션을 열 때 정해지고 바뀌지 않는다. 표시 ID는 형식이 정해진 값이라 그대로 표시 값이다.
 * 계약(M3-04 #49, ADR-129)의 수 · 표시 ID는 효력 있는 계약이 있을 때만 두 칸이 함께 있다(계약이 없는 세션의 기록은 옛 모양 그대로).
 */
export const SessionNormInput = z
  .strictObject({
    summary: z.strictObject({
      requirements: SessionNormInputCount,
      rules: SessionNormInputCount,
      contracts: SessionNormInputCount.optional(),
      truncated: z.boolean(),
      /** 대상 블록으로 골랐을 때만: 기준 블록 이름 (M3-29, ADR-140) */
      blocks: z.array(BlockName).min(1).optional(),
    }),
    requirementDisplayIds: z.array(displayIdSchema('REQ')),
    ruleDisplayIds: z.array(displayIdSchema('RULE')),
    contractDisplayIds: z.array(displayIdSchema('CON')).optional(),
  })
  .refine(
    (input) =>
      input.summary.requirements.included === input.requirementDisplayIds.length &&
      input.summary.rules.included === input.ruleDisplayIds.length &&
      (input.summary.contracts?.included ?? 0) === (input.contractDisplayIds?.length ?? 0) &&
      (input.summary.contracts === undefined) === (input.contractDisplayIds === undefined),
    '실은 수와 표시 ID 수가 같다',
  )
  .refine(
    (input) =>
      input.summary.truncated ===
      (input.summary.requirements.omitted > 0 ||
        input.summary.rules.omitted > 0 ||
        (input.summary.contracts?.omitted ?? 0) > 0),
    '잘림은 빠진 항목이 있을 때만',
  )
  .refine(
    (input) =>
      [input.summary.requirements, input.summary.rules, input.summary.contracts].every(
        (count) =>
          count === undefined ||
          (count.outOfBlock === undefined) === (input.summary.blocks === undefined),
      ),
    '블록 밖 수는 대상 블록으로 골랐을 때만',
  );
export type SessionNormInput = z.infer<typeof SessionNormInput>;

/**
 * 에이전트 세션 = SDK `query()` 1회 (기획서 3.2, RUN-04). 진행 중이면 종료 사유 · 비용 · 종료 시각이 `null`.
 * 실행 엔진(M1-14, ADR-066)이 세션을 열 때 행을 만들고 끝날 때 결과를 채운다(재기동 뒤 역할별 세션 순번의 근거).
 * 실행 밖 세션(규칙 작성, ADR-062)은 `runId` · `stepId`가 `null`이고 `requirementId`로 대상 요구사항을 가리킨다. 실행 안 판단
 * 세션(규칙 작성 역할, ADR-115 · ADR-118)은 판단을 청한 단계 시도에 묶인다(단계 역할과 다르다).
 * `error`는 결과 없이 끝난 세션의 사유 문장(어댑터 오류 · 가드 위반 등).
 * `budget`은 세션을 열 때 어댑터에 넘긴 한도(min(역할 잔여, 실행 잔여), ADR-067). 결과 없이 끝나 비용 · 턴을 모르는
 * 세션은 잔여 한도 계산에서 이 한도를 다 쓴 것으로 본다. 한도 없이 연 세션(실행 밖 세션)은 `null`.
 * `normInput`은 작업 지시에 실은 규범 입력의 기록(규칙 작성 · 테스트 작성 · 구현 역할, ADR-108). 규범 입력이 없는 세션
 * (이 기록이 생기기 전 세션 포함)은 `null`.
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
    normInput: SessionNormInput.nullable(),
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

// ── 변이 결과 (JDG-04, M3-07 #52, ADR-033 · ADR-139) ──────────

/** 변이 패치의 상한 (ADR-139): 바꿀 글 · 바꾼 글 각각 코드 단위 수, 대상 파일 경로 길이. */
export const MUTANT_LIMITS = { search: 2000, replace: 2000, path: 1024 } as const;

/**
 * 변이 주입 역할이 낸 변이 1개 (`propose_mutant`, ADR-033): 대상 블록 파일 하나(`path`) 안에서 정확히 한 군데 나오는 글
 * (`search`)을 다른 글(`replace`)로 바꾼다. 에이전트가 쓴 글이라 저장은 원문, 화면 · 세션 입력에는 표시 값으로만 싣는다.
 */
export const MutantPatch = z
  .strictObject({
    path: z.string().min(1).max(MUTANT_LIMITS.path),
    search: z.string().min(1).max(MUTANT_LIMITS.search),
    replace: z.string().max(MUTANT_LIMITS.replace),
  })
  .refine((patch) => patch.search !== patch.replace, '바꾼 글이 바꿀 글과 같습니다');
export type MutantPatch = z.infer<typeof MutantPatch>;

/**
 * 규칙 하나의 변이 판정 기록 (JDG-04, ADR-139). 실행의 변이 주입 단계가 규칙마다 남긴다(추가 전용). 규칙의 변이 상태는 가장 최근
 * 기록의 `status`이고, 기록이 없으면 '변이 미검증'이다. `status`는 `outcome`에서만 정해진다(`mutationStatusOf`).
 * `commit`은 변이를 적용한 판정 커밋(실행의 마지막 완료 단계 커밋), `mutant`는 세션이 낸 변이(내지 않았으면 `null`).
 */
export const MutationResult = z
  .strictObject({
    id: Ulid,
    ruleId: Ulid,
    runId: Ulid,
    stepId: Ulid,
    sessionId: Ulid.nullable(),
    commit: CommitSha,
    status: MutationStatus,
    outcome: MutationOutcome,
    mutant: MutantPatch.nullable(),
    recordedAt: Timestamp,
  })
  .superRefine((result, ctx) => {
    if (result.status !== mutationStatusOf(result.outcome)) {
      ctx.addIssue({
        code: 'custom',
        message: '변이 상태가 판정 결과와 맞지 않습니다',
        path: ['status'],
      });
    }
    if ((result.outcome === 'no_mutant') !== (result.mutant === null)) {
      ctx.addIssue({
        code: 'custom',
        message: '변이를 내지 않은 기록만 변이가 비어 있습니다',
        path: ['mutant'],
      });
    }
  });
export type MutationResult = z.infer<typeof MutationResult>;

/**
 * 변이 보강 연결 (M3-54 #311, ADR-141 ③ · ADR-143): 변이 생존의 자동 테스트 보강 실행(유형 C)과 그 원인 변이 기록 1건. 실행마다
 * 하나 · 변이 기록마다 하나(같은 변이로 보강 실행이 둘 생기지 않고, 끝난 뒤 다시 만들지 않는다). `seq`는 그 실행 시작 주체의 원인 순번이다.
 * 이 연결이 있는 유형 C 실행이 "보강"이고 변이 주입 단계는 그 변이의 재주입이다.
 */
export const MutationReinforcement = z.strictObject({
  seq: z.int().positive(),
  runId: Ulid,
  mutationResultId: Ulid,
  createdAt: Timestamp,
});
export type MutationReinforcement = z.infer<typeof MutationReinforcement>;

// ── 검토 대기열 (TODO-02 · COST-01 · JDG-04, M3-08 #53, ADR-100 B④ · A17, ADR-145) ──────────

/** 판정 격리 사유 상한 (UTF-16 코드 단위, 규칙화 불가 사유와 같다). */
export const QUARANTINE_REASON_MAX = 4000;

/**
 * 검토 대기열 항목의 처리 기록 (사람만, 한 번만). 액션마다 결과가 다르다.
 * - `reinforce`: 사람이 시작한 유형 C 테스트 보강 실행(`runId`). 사유 없음
 * - `quarantine`: 그 규칙의 판정 격리 기록(`judgmentId`, 판정 상태 '격리'). 사유 필수
 * - `raise_limit_resume`: 예산 초과 항목의 한도 상향 재개. 그 항목의 실행을 이어받는 새 실행(`runId`, M3-56 #319, ADR-149). 사유 없음
 */
export const ReviewResolution = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('reinforce'),
    by: HumanAuthor,
    at: Timestamp,
    reason: z.null(),
    runId: Ulid,
  }),
  z.strictObject({
    action: z.literal('quarantine'),
    by: HumanAuthor,
    at: Timestamp,
    reason: NonEmptyString.max(QUARANTINE_REASON_MAX),
    judgmentId: Ulid,
  }),
  z.strictObject({
    action: z.literal('raise_limit_resume'),
    by: HumanAuthor,
    at: Timestamp,
    reason: z.null(),
    runId: Ulid,
  }),
  // 허용 목록 축소 재개: 쓰기 허용 범위가 붙은 이어받는 실행(`runId`, M3-58 #321, ADR-155). 사유 없음
  z.strictObject({
    action: z.literal('narrow_allowlist_resume'),
    by: HumanAuthor,
    at: Timestamp,
    reason: z.null(),
    runId: Ulid,
  }),
]);
export type ReviewResolution = z.infer<typeof ReviewResolution>;

/**
 * 검토 대기열 항목 1건 (ADR-145). 실행의 종료 상태를 저장하는 같은 쓰기에서 DB가 등록한다(코드가 넣지 않는다):
 * - `budget_exceeded`: 실행이 예산 초과로 끝남 (유형 무관)
 * - `mutant_survived`: 변이 보강 실행(유형 C)이 실패로 끝났고 원인 변이 기록(`mutationResultId`)의 규칙이 지금도 '변이 생존'
 * 열린 항목은 실행마다 많아야 하나다. 처리(`resolution`)는 열림 → 처리됨 한 번이고 지우거나 되돌릴 수 없다.
 */
export const ReviewItem = z
  .strictObject({
    seq: z.int().positive(),
    kind: ReviewItemKind,
    runId: Ulid,
    mutationResultId: Ulid.nullable(),
    createdAt: Timestamp,
    resolution: ReviewResolution.nullable(),
  })
  .superRefine((item, ctx) => {
    if ((item.kind === 'mutant_survived') !== (item.mutationResultId !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: '변이 생존 항목만 원인 변이 기록을 가집니다',
        path: ['mutationResultId'],
      });
    }
    const allowed: readonly string[] = REVIEW_ACTIONS_BY_KIND[item.kind];
    if (item.resolution !== null && !allowed.includes(item.resolution.action)) {
      ctx.addIssue({
        code: 'custom',
        message: '항목 종류가 받지 않는 액션입니다',
        path: ['resolution', 'action'],
      });
    }
  });
export type ReviewItem = z.infer<typeof ReviewItem>;

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
