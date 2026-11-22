// 역할별 고정 도구 목록과 도구 정의 (NFR-02 · ADR-024 · ADR-052).
// 정의(이름 · 설명 · 입력 스키마)는 한 곳에만 두고, 실행기(FixedToolExecutor)의 인자 검증과
// SDK MCP 서버 노출(M1-26)이 같은 스키마를 쓴다. 승인 · 잠정 승인 · 확인 표시 · 셸 도구는 없다(NFR-01 · NFR-02).
// 규범을 쓰는 도구는 규칙 작성 역할의 규칙 생성 · 폐기 · 대체 도구(`propose_rule` · `retire_rule` · `supersede_rule`)와 이의 판단의
// 유지 도구(`uphold_rule`)뿐이다(M7-02 · M7-09 · M7-11, ADR-100 D1 · D4 · D5 · D6, ADR-103 · ADR-112 · ADR-115). 구현 역할의 이의
// 제기 도구(`raise_objection`)는 이의 기록만 남기고 규범을 바꾸지 않는다(M7-11, ADR-100 D4 · I2, ADR-115).
import { type AgentRole, CheckKind, RuleKind } from '@bive/shared';
import { z } from 'zod';

import { CONTROL_CHARACTERS, EARS_FORMAT, earsStatementProblem } from './ears.js';

/** 고정 도구 MCP 서버 이름. 세션의 MCP 서버는 이것 하나뿐이다(ADR-024). */
export const BIVE_MCP_SERVER = 'bive';

/** 파일 도구 (읽기 · 쓰기 · 목록 · 검색). 경로는 모두 경로 가드를 거친다. */
export const FILE_TOOL_NAMES = ['read_file', 'write_file', 'list_files', 'search_files'] as const;
/** 명령 도구. 허용 argv 템플릿만 실행한다(commands.ts). */
export const COMMAND_TOOL_NAMES = [
  'run_tests',
  'prisma_generate',
  'prisma_migrate',
  'install_package',
] as const;
/**
 * 규범 도구 (규범을 쓰는 에이전트 도구). 규칙 작성 역할에만 둔다(ADR-100 D4: 테스트 작성 · 구현 역할에는 없다).
 * `propose_rule`은 규칙 생성 도구다: 호출하면 주입된 콜백이 규칙을 바로 반영하고 규범 변경 기록을 남긴다(M7-02).
 * 이름은 이 변경 전부터 쓰던 것을 그대로 둔다(시나리오 · 실제 SDK 세션 · 로드맵 M3 행이 이 이름을 쓴다, ADR-103).
 * `retire_rule` · `supersede_rule`은 폐기 · 대체 도구다(M7-09, ADR-100 D5 · D6, ADR-112): 폐기는 규칙의 효력을 끝내고(행 ·
 * 판정 이력은 남음), 대체는 폐기와 새 규칙 반영을 한 트랜잭션으로 한다. 내장 구조 규칙은 폐기 · 대체할 수 없다(B⑨).
 */
export const NORM_TOOL_NAMES = [
  'propose_rule',
  'retire_rule',
  'supersede_rule',
  'uphold_rule',
] as const;
/**
 * 이의 제기 도구 (M7-11 #223, ADR-100 D4 · A4 · A5, ADR-115). 구현 역할에만 둔다: 구현 역할은 자기 채점 기준을 고치지 못하고(I2)
 * 규칙이 잘못됐다고 보면 이 도구로 규범 담당 역할에 넘긴다. 실행기는 주입된 콜백으로 이의 기록 1건만 남기고, 부르면 그 세션이
 * 끝난다(이후 호출은 모두 거부).
 */
export const OBJECTION_TOOL_NAMES = ['raise_objection'] as const;

export type FileToolName = (typeof FILE_TOOL_NAMES)[number];
export type CommandToolName = (typeof COMMAND_TOOL_NAMES)[number];
export type NormToolName = (typeof NORM_TOOL_NAMES)[number];
export type ObjectionToolName = (typeof OBJECTION_TOOL_NAMES)[number];
export type FixedToolName = FileToolName | CommandToolName | NormToolName | ObjectionToolName;

/**
 * 역할별 허용 도구. 세션 init의 도구 목록은 이것과 정확히 같아야 한다(session-guard.ts).
 * planner · chat은 M1에서 도구가 없다(해당 마일스톤에서 추가, ADR-052). 규범 도구는 규칙 작성 역할에만 있다(ADR-100 D4).
 */
export const ROLE_TOOL_NAMES = {
  'rule-writer': ['propose_rule', 'retire_rule', 'supersede_rule', 'uphold_rule'],
  planner: [],
  'test-writer': ['read_file', 'write_file', 'list_files', 'search_files', 'run_tests'],
  implementer: [
    'read_file',
    'write_file',
    'list_files',
    'search_files',
    'run_tests',
    'prisma_generate',
    'prisma_migrate',
    'install_package',
    'raise_objection',
  ],
  chat: [],
} as const satisfies Record<AgentRole, readonly FixedToolName[]>;

/** 역할의 허용 도구 이름 목록. */
export const roleToolNames = (role: AgentRole): readonly FixedToolName[] => ROLE_TOOL_NAMES[role];

/** 경로 인자. 빈 문자열 · NUL은 스키마에서 거른다. */
const PathArg = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), 'NUL 문자 불가');

/** 파일 내용 상한 (읽기 · 쓰기 공통). */
export const MAX_FILE_BYTES = 1024 * 1024;

export const ReadFileInput = z.strictObject({
  path: PathArg.describe('세션 루트 기준 상대 경로'),
});
export const WriteFileInput = z.strictObject({
  path: PathArg.describe('세션 루트 기준 상대 경로'),
  content: z.string().max(MAX_FILE_BYTES).describe('파일 전체 내용 (UTF-8)'),
});
export const ListFilesInput = z.strictObject({
  path: PathArg.optional().describe('세션 루트 기준 상대 경로 (기본 루트)'),
  recursive: z.boolean().optional().describe('하위 폴더까지 (기본 false)'),
});
export const SearchFilesInput = z.strictObject({
  query: z.string().min(1).max(500).describe('찾을 문자열 (정규식 아님)'),
  path: PathArg.optional().describe('검색 시작 경로 (기본 루트)'),
});

/** 테스트 파일 · 이름 필터는 옵션으로 오인되지 않게 `-`로 시작할 수 없다. */
const NotOption = (schema: z.ZodString) =>
  schema.refine((value) => !value.startsWith('-'), '`-`로 시작할 수 없음');

export const RunTestsInput = z.strictObject({
  files: z
    .array(NotOption(PathArg))
    .max(50)
    .optional()
    .describe('실행할 테스트 파일 (세션 루트 기준, 생략하면 전체)'),
  testNamePattern: NotOption(z.string().min(1).max(200))
    .optional()
    .describe('테스트 이름 필터 (vitest -t)'),
});
export const PrismaGenerateInput = z.strictObject({});
export const PrismaMigrateInput = z.strictObject({});
export const InstallPackageInput = z.strictObject({
  name: z.string().min(1).max(214).describe('설치할 패키지 (허용 목록에 있는 이름만)'),
});

/** 공백만 있는 문자열은 받지 않는다. */
const NonBlank = (schema: z.ZodString) =>
  schema.refine((value) => value.trim().length > 0, '비어 있음');

/** 모순 판단의 대상 규칙 수 상한 (ADR-106). */
export const MAX_CONTRADICTION_RULES = 20;
/** 모순 판단 근거의 길이 상한 (ADR-106). */
export const MAX_CONTRADICTION_GROUNDS = 4000;

/**
 * 새 규칙과 효력 있는 기존 규칙의 모순 판단 (NRM-02, ADR-100 D5 · K1, M7-07, ADR-106). 규칙 생성마다 필수다.
 * - `none`: 모순 없음. 다른 칸을 두면 거부한다(strict)
 * - `contradicts`: 모순 대상 규칙(표시 ID 또는 ID, 1개 이상 · 중복 없음)과 근거(빈 글 불가)
 * 대상 규칙이 지금 효력 있는 규칙인지는 반영 모듈이 저장소에서 확인한다(`norms/agent-rule.ts`).
 */
export const RuleContradictionInput = z
  .discriminatedUnion('verdict', [
    z.strictObject({
      verdict: z.literal('none').describe('모순 없음'),
    }),
    z.strictObject({
      verdict: z.literal('contradicts').describe('모순 있음'),
      ruleIds: z
        .array(z.string().min(1).max(64))
        .min(1)
        .max(MAX_CONTRADICTION_RULES)
        .refine((ids) => new Set(ids).size === ids.length, '대상 규칙이 중복됨')
        .describe(
          '모순 대상 규칙의 표시 ID(RULE-001 형식) 또는 ID. 작업 지시의 효력 있는 규칙 가운데',
        ),
      grounds: NonBlank(z.string().min(1).max(MAX_CONTRADICTION_GROUNDS)).describe(
        '근거: 새 규칙이 대상 규칙의 진술 · 인수 테스트 케이스의 어느 부분과 동시에 만족될 수 없는지',
      ),
    }),
  ])
  .describe(
    '효력 있는 기존 규칙과의 모순 판단. 모순이 없으면 {"verdict":"none"}, 있으면 대상 규칙과 근거',
  );
export type RuleContradictionInput = z.infer<typeof RuleContradictionInput>;

/**
 * 규칙 생성 입력 (NRM-02, ADR-062, M7-02). 제목(한 줄) · EARS 진술 · 종류 · 검사 종류(1개 이상, 중복 없음) ·
 * 부모 요구사항 · 근거 · 모순 판단(M7-07, 필수). 부모 요구사항이 세션의 요구사항인지 · 살아 있는지는 등록 콜백이 확인한다.
 */
export const ProposeRuleInput = z.strictObject({
  parentRequirementId: z
    .string()
    .min(1)
    .max(64)
    .describe('부모 요구사항 ID (작업 지시에 적힌 요구사항 ID 그대로)'),
  title: NonBlank(z.string().min(1).max(200))
    .refine((value) => !CONTROL_CHARACTERS.test(value), '한 줄이어야 함 (줄바꿈 · 제어 문자 불가)')
    .describe('사람이 읽는 한 줄 요약'),
  statement: z
    .string()
    .min(1)
    .max(4000)
    .superRefine((value, ctx) => {
      const problem = earsStatementProblem(value);
      if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
    })
    .describe(`EARS 진술 한 줄: ${EARS_FORMAT}`),
  kind: RuleKind.describe('규칙 종류'),
  checkKinds: z
    .array(CheckKind)
    .min(1)
    .refine((kinds) => new Set(kinds).size === kinds.length, '검사 종류가 중복됨')
    .describe('검사 종류 1개 이상 (중복 없이)'),
  rationale: NonBlank(z.string().min(1).max(4000)).describe('요구사항의 어느 부분을 옮겼는지'),
  contradiction: RuleContradictionInput,
});
export type ProposeRuleInput = z.infer<typeof ProposeRuleInput>;

/** 폐기 · 대체 근거의 길이 상한 (ADR-112, 모순 판단 근거와 같다). */
export const MAX_RETIREMENT_GROUNDS = MAX_CONTRADICTION_GROUNDS;

/** 폐기 · 대체 대상 규칙 (표시 ID 또는 ID, `contradiction.ruleIds`와 같은 방식). */
const TargetRuleArg = z
  .string()
  .min(1)
  .max(64)
  .describe('폐기할 규칙의 표시 ID(RULE-001 형식) 또는 ID. 작업 지시의 효력 있는 규칙 가운데');

/**
 * 폐기 · 대체 근거 (NRM-07, ADR-100 A6 · R3, ADR-112). 대상 규칙의 진술이나 최근 판정의 인수 테스트 케이스 이름 가운데 하나
 * 이상을 글자 그대로 옮긴 부분(공백 정리 뒤 연속 {@link MIN_QUOTE_LENGTH}자 이상)이 있어야 한다. 인용 대조는 반영 모듈이 저장소의
 * 진술 · 케이스 이름으로 한다(`norms/agent-rule.ts`).
 */
const RetirementGrounds = NonBlank(z.string().min(1).max(MAX_RETIREMENT_GROUNDS)).describe(
  '근거: 대상 규칙의 진술이나 최근 판정의 인수 테스트 케이스 이름의 일부를 글자 그대로(연속 10자 이상) 옮기고, 왜 그 규칙이 더는 효력을 가지면 안 되는지',
);

/** 근거 인용의 최소 길이 (공백 정리 뒤 코드 포인트 수, ADR-112). */
export const MIN_QUOTE_LENGTH = 10;

/** 규칙 폐기 입력 (M7-09, ADR-112): 대상 규칙과 근거. */
export const RetireRuleInput = z.strictObject({
  ruleId: TargetRuleArg,
  grounds: RetirementGrounds,
});
export type RetireRuleInput = z.infer<typeof RetireRuleInput>;

/**
 * 규칙 대체 입력 (M7-09, ADR-100 D6, ADR-112): 대상 규칙 · 근거와 새 규칙(규칙 생성 입력과 같은 칸). `contradiction`은 새 규칙과
 * 대상 밖의 효력 있는 규칙의 모순 판단이다(대상은 넣지 않는다. 대체 자체가 대상과 모순이라는 판단이다).
 */
export const SupersedeRuleInput = ProposeRuleInput.extend({
  ruleId: TargetRuleArg.describe('대체할(폐기할) 규칙의 표시 ID(RULE-001 형식) 또는 ID'),
  grounds: RetirementGrounds,
  contradiction: RuleContradictionInput.describe(
    '새 규칙과 대상 밖의 효력 있는 규칙의 모순 판단. 없으면 {"verdict":"none"} (대상 규칙은 넣지 않는다)',
  ),
});
export type SupersedeRuleInput = z.infer<typeof SupersedeRuleInput>;

/** 판단 근거의 길이 상한 (유지, ADR-115. 폐기 · 대체 근거와 같다). */
export const MAX_UPHOLD_GROUNDS = MAX_CONTRADICTION_GROUNDS;

/**
 * 이의 판단 · 요구사항 변경 재판단의 유지 입력 (M7-11 #223 · ADR-115, M7-10 #222 · ADR-116): 판단 세션의 대상 규칙 하나와 근거. 규칙 작성
 * 역할의 판단 세션(실행 안의 이의 판단 · 요구사항 변경의 재판단)에서만 받는다(새 요구사항의 규칙 작성
 * 세션에서는 거부). 규칙 · 인수 테스트는 바뀌지 않고 판단 기록만 남는다.
 */
export const UpholdRuleInput = z.strictObject({
  ruleId: TargetRuleArg.describe(
    '유지할 규칙의 표시 ID(RULE-001 형식) 또는 ID. 판단 대상 규칙 가운데',
  ),
  grounds: NonBlank(z.string().min(1).max(MAX_UPHOLD_GROUNDS)).describe(
    '근거: 이의 · 요구사항 변경에도 불구하고 그 규칙이 요구사항에 맞고 효력을 유지해야 하는 이유 (이의 판단이면 구현 역할에게 전해진다)',
  ),
});
export type UpholdRuleInput = z.infer<typeof UpholdRuleInput>;

/** 이의 대상 규칙 수 상한 (ADR-115). */
export const MAX_OBJECTION_RULES = 5;
/** 이의 사유의 길이 상한 (ADR-100 A5, ADR-115. UTF-16 코드 단위). */
export const MAX_OBJECTION_REASON = 2000;

/**
 * 이의 제기 입력 (M7-11 #223, ADR-100 D4 · A5, ADR-115): 잘못됐다고 보는 효력 있는 규칙(1 ~ {@link MAX_OBJECTION_RULES}개,
 * 중복 없음, 이 실행의 대상 규칙이 아니어도 된다)과 사유(빈 글 불가, {@link MAX_OBJECTION_REASON}자 이하). 대상이 지금 효력 있는
 * 규칙인지는 이의 기록 모듈이 저장소에서 확인한다.
 */
export const RaiseObjectionInput = z.strictObject({
  ruleIds: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(MAX_OBJECTION_RULES)
    .refine((ids) => new Set(ids).size === ids.length, '대상 규칙이 중복됨')
    .describe(
      '잘못됐다고 보는 규칙의 표시 ID(RULE-001 형식) 또는 ID. 작업 지시의 효력 있는 규칙 가운데',
    ),
  reason: NonBlank(z.string().min(1).max(MAX_OBJECTION_REASON)).describe(
    '사유: 그 규칙의 진술 · 인수 테스트가 왜 잘못됐는지(요구사항 · 다른 규칙과 어떻게 부딪히는지)',
  ),
});
export type RaiseObjectionInput = z.infer<typeof RaiseObjectionInput>;

/** 도구 정의. SDK MCP 서버(M1-26)는 strict 스키마에서 만든 JSON 스키마로 노출하고 인자 검증은 실행기에 맡긴다. */
export interface ToolDefinition {
  name: FixedToolName;
  description: string;
  inputSchema: z.ZodObject;
}

const DEFINITIONS: Record<FixedToolName, ToolDefinition> = {
  read_file: {
    name: 'read_file',
    description: '세션 루트 안의 텍스트 파일을 읽는다 (최대 1 MiB).',
    inputSchema: ReadFileInput,
  },
  write_file: {
    name: 'write_file',
    description: '세션 루트 안의 파일을 새로 쓰거나 덮어쓴다. 상위 폴더는 자동으로 만든다.',
    inputSchema: WriteFileInput,
  },
  list_files: {
    name: 'list_files',
    description: '세션 루트 안의 폴더 내용을 나열한다. 폴더는 끝에 `/`를 붙인다.',
    inputSchema: ListFilesInput,
  },
  search_files: {
    name: 'search_files',
    description: '세션 루트 안의 텍스트 파일에서 문자열을 찾아 `경로:줄: 내용`으로 돌려준다.',
    inputSchema: SearchFilesInput,
  },
  run_tests: {
    name: 'run_tests',
    description: 'vitest run으로 테스트를 실행한다. 파일과 이름 필터만 지정할 수 있다.',
    inputSchema: RunTestsInput,
  },
  prisma_generate: {
    name: 'prisma_generate',
    description: 'prisma generate로 Prisma 클라이언트를 다시 만든다.',
    inputSchema: PrismaGenerateInput,
  },
  prisma_migrate: {
    name: 'prisma_migrate',
    description: 'prisma migrate deploy로 마이그레이션 파일을 데이터베이스에 적용한다.',
    inputSchema: PrismaMigrateInput,
  },
  install_package: {
    name: 'install_package',
    description:
      '설정의 패키지 설치 허용 목록에 있는 패키지만 설치한다 (기본 허용 목록은 비어 있음).',
    inputSchema: InstallPackageInput,
  },
  propose_rule: {
    name: 'propose_rule',
    description: `요구사항에서 도출한 규칙을 만든다. 만든 규칙은 바로 효력을 갖고 근거와 함께 규범 변경 기록에 남으며, 사람은 나중에 확인한다. 진술은 ${EARS_FORMAT} 형식 한 줄. 효력 있는 기존 규칙과의 모순 판단(contradiction)이 필수이고 그 판단도 규범 변경 기록에 남는다. 모순이어도 규칙은 만들어지고 기존 규칙은 그대로 효력을 갖는다.`,
    inputSchema: ProposeRuleInput,
  },
  retire_rule: {
    name: 'retire_rule',
    description:
      '효력 있는 기존 규칙을 폐기한다. 폐기된 규칙은 판정 · 실행의 기준에서 빠지고(규칙과 판정 이력은 남는다) 근거와 함께 규범 변경 기록에 남으며, 사람은 나중에 확인한다. 근거에 대상 규칙의 진술이나 최근 판정의 인수 테스트 케이스 이름의 일부를 글자 그대로(연속 10자 이상) 옮겨야 한다. 내장 구조 규칙은 폐기할 수 없다. 새 실행은 생기지 않는다.',
    inputSchema: RetireRuleInput,
  },
  supersede_rule: {
    name: 'supersede_rule',
    description: `효력 있는 기존 규칙을 폐기하고 그 자리를 새 규칙으로 바꾼다(폐기와 새 규칙 반영이 한 번에 일어난다). 새 규칙의 칸은 propose_rule과 같고 진술은 ${EARS_FORMAT} 형식 한 줄. 근거에 대상 규칙의 진술이나 최근 판정의 인수 테스트 케이스 이름의 일부를 글자 그대로(연속 10자 이상) 옮겨야 한다. contradiction은 새 규칙과 대상 밖의 효력 있는 규칙의 모순 판단이다. 내장 구조 규칙은 대체할 수 없다.`,
    inputSchema: SupersedeRuleInput,
  },
  uphold_rule: {
    name: 'uphold_rule',
    description:
      '판단 세션(실행 안의 이의 판단 · 요구사항 변경의 재판단)에서만 쓴다. 판단 대상 규칙을 바꾸지 않고 유지한다고 판단해 근거와 함께 규범 변경 기록에 남긴다. 규칙과 인수 테스트는 그대로다. 이의 판단이면 그 실행은 근거를 받아 구현을 다시 한다.',
    inputSchema: UpholdRuleInput,
  },
  raise_objection: {
    name: 'raise_objection',
    description:
      '규칙이 잘못됐다고 볼 때 규칙을 맡는 역할에 이의를 제기한다. 규칙 · 인수 테스트는 바뀌지 않고 이의 기록만 남는다. 부르면 이 세션은 바로 끝나고(이후 도구 호출은 모두 거부) 규칙을 맡는 역할이 폐기 · 대체 · 유지를 판단한다. 유지면 판단의 근거를 받아 구현을 다시 하고(검사 회귀와 같은 상한), 폐기 · 대체면 이 실행은 병합 없이 끝난다.',
    inputSchema: RaiseObjectionInput,
  },
};

/** 이름의 도구 정의. */
export const toolDefinition = (name: FixedToolName): ToolDefinition => DEFINITIONS[name];

/** 역할의 도구 정의 목록 (ROLE_TOOL_NAMES 순서). */
export const toolDefinitions = (role: AgentRole): ToolDefinition[] =>
  roleToolNames(role).map((name) => DEFINITIONS[name]);

/** 고정 도구 이름인지. */
export const isFixedToolName = (name: string): name is FixedToolName =>
  Object.hasOwn(DEFINITIONS, name);
