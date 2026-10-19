// 역할별 고정 도구 목록과 도구 정의 (NFR-02 · ADR-024 · ADR-052).
// 정의(이름 · 설명 · 입력 스키마)는 한 곳에만 두고, 실행기(FixedToolExecutor)의 인자 검증과
// SDK MCP 서버 노출(M1-26)이 같은 스키마를 쓴다. 승인 · 잠정 승인 · 규범 쓰기 · 셸 도구는 없다(NFR-01 · NFR-02).
import { type AgentRole, CheckKind, RuleKind } from '@bive/shared';
import { z } from 'zod';

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
/** 제안 도구. 제안 등록은 주입된 콜백이 한다(상태 `pending` 고정, NFR-01). */
export const PROPOSAL_TOOL_NAMES = ['propose_rule'] as const;

export type FileToolName = (typeof FILE_TOOL_NAMES)[number];
export type CommandToolName = (typeof COMMAND_TOOL_NAMES)[number];
export type ProposalToolName = (typeof PROPOSAL_TOOL_NAMES)[number];
export type FixedToolName = FileToolName | CommandToolName | ProposalToolName;

/**
 * 역할별 허용 도구. 세션 init의 도구 목록은 이것과 정확히 같아야 한다(session-guard.ts).
 * planner · chat은 M1에서 도구가 없다(제안 도구는 해당 마일스톤에서 추가, ADR-052).
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

export const ProposeRuleInput = z.strictObject({
  parentRequirementId: z.string().min(1).max(64).describe('부모 요구사항 ID'),
  title: z.string().min(1).max(200),
  statement: z.string().min(1).max(4000).describe('EARS 형식 규칙 문장'),
  kind: RuleKind,
  checkKinds: z.array(CheckKind).min(1),
  rationale: z.string().min(1).max(4000),
});
export type ProposeRuleInput = z.infer<typeof ProposeRuleInput>;

/** 도구 정의. M1-26이 SDK MCP 도구로 그대로 감싼다(`inputSchema.shape`). */
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
    description:
      '요구사항에서 도출한 규칙을 제안으로 등록한다. 제안은 사람이 승인해야 규칙이 된다.',
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
