// 역할별 고정 도구 목록과 도구 정의 (NFR-02 · ADR-024 · ADR-052).
// 정의(이름 · 설명 · 입력 스키마)는 한 곳에만 두고, 실행기(FixedToolExecutor)의 인자 검증과
// SDK MCP 서버 노출(M1-26)이 같은 스키마를 쓴다. 승인 · 잠정 승인 · 확인 표시 · 셸 도구는 없다(NFR-01 · NFR-02).
// 규범을 쓰는 도구는 규칙 작성 역할의 규칙 생성 도구(`propose_rule`) 하나뿐이다(M7-02, ADR-100 D1 · D4, ADR-103).
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
 */
export const NORM_TOOL_NAMES = ['propose_rule'] as const;

export type FileToolName = (typeof FILE_TOOL_NAMES)[number];
export type CommandToolName = (typeof COMMAND_TOOL_NAMES)[number];
export type NormToolName = (typeof NORM_TOOL_NAMES)[number];
export type FixedToolName = FileToolName | CommandToolName | NormToolName;

/**
 * 역할별 허용 도구. 세션 init의 도구 목록은 이것과 정확히 같아야 한다(session-guard.ts).
 * planner · chat은 M1에서 도구가 없다(해당 마일스톤에서 추가, ADR-052). 규범 도구는 규칙 작성 역할에만 있다(ADR-100 D4).
 */
export const ROLE_TOOL_NAMES = {
  'rule-writer': ['propose_rule'],
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
};

/** 이름의 도구 정의. */
export const toolDefinition = (name: FixedToolName): ToolDefinition => DEFINITIONS[name];

/** 역할의 도구 정의 목록 (ROLE_TOOL_NAMES 순서). */
export const toolDefinitions = (role: AgentRole): ToolDefinition[] =>
  roleToolNames(role).map((name) => DEFINITIONS[name]);

/** 고정 도구 이름인지. */
export const isFixedToolName = (name: string): name is FixedToolName =>
  Object.hasOwn(DEFINITIONS, name);
