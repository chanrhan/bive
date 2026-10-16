// 명령 도구 (NFR-02 · NFR-04 · ADR-024 · ADR-052). 셸 없이 허용 argv 템플릿만 `execFile`로 실행한다.
// 모델이 정할 수 있는 것은 템플릿의 빈칸(테스트 파일 · 이름 필터 · 허용 목록의 패키지 이름)뿐이고,
// 실행 파일 · 하위 명령 · 옵션은 고정이다. 환경 변수는 허용 목록만 넘기고 타임아웃 · 출력 상한을 둔다.
import { execFile, type ExecFileException } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { ToolResult } from '../agent/adapter.js';
import {
  type CommandToolName,
  InstallPackageInput,
  PrismaGenerateInput,
  PrismaMigrateInput,
  RunTestsInput,
} from './definitions.js';
import type { PathGuard } from './path-guard.js';
import { denied, failed, invalidArgs, type IssueList, ok } from './result.js';

/** 자식 프로세스에 넘기는 환경 변수 허용 목록. 나머지(API 키 · 토큰 등)는 넘기지 않는다. */
export const COMMAND_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'DATABASE_URL',
] as const;

/** 항상 고정하는 환경 변수 (색 코드 · 대화형 프롬프트 끄기). */
const FIXED_ENV = { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' } as const;

export const DEFAULT_COMMAND_TIMEOUT_MS: Record<CommandToolName, number> = {
  run_tests: 10 * 60_000,
  prisma_generate: 2 * 60_000,
  prisma_migrate: 2 * 60_000,
  install_package: 5 * 60_000,
};

/** 모델에게 돌려주는 출력 상한 (끝부분을 남긴다: vitest · prisma 요약이 끝에 있음) */
export const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
/** 이 이상 출력하면 프로세스를 멈춘다 (메모리 보호) */
export const HARD_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

/** npm 패키지 이름(선택적 범위 · 버전). 경로 · URL · git 지정자는 허용하지 않는다. */
const PACKAGE_SPEC =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[0-9A-Za-z][0-9A-Za-z.+~^-]*)?$/u;

export interface CommandContext {
  /** 작업 디렉터리 (세션 루트) */
  cwd: string;
  /** `node_modules`를 찾는 루트. 기본 `cwd` (test-writer는 실행 워크트리를 넘긴다) */
  toolchainRoot?: string;
  /** `run_tests`의 파일 인자 검사 */
  guard: PathGuard;
  /** 설정의 패키지 설치 허용 목록 (기본 빈 목록 = 항상 거부, NFR-02 · C-14) */
  installAllowlist?: readonly string[];
  /** 허용 목록 변수를 고를 원본 (기본 `process.env`) */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** 오케스트레이터가 정하는 값 (예: 실행별 `DATABASE_URL`). 허용 목록 변수 위에 덮는다 */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: Partial<Record<CommandToolName, number>>;
  outputLimitBytes?: number;
  /** 실행 파일 찾기 방식을 고르는 OS (기본 `process.platform`, 시험용) */
  platform?: NodeJS.Platform;
  /** 세션 중단 시 자식 프로세스도 멈춘다 */
  signal?: AbortSignal;
}

/** 실행할 argv. `display`는 도구 호출 기록의 명령 요약. */
export interface CommandPlan {
  file: string;
  args: string[];
  display: string;
}

export type PlanResult = { ok: true; plan: CommandPlan } | { ok: false; result: ToolResult };

export interface CommandOutcome {
  result: ToolResult;
  /** 도구 호출 기록의 명령 요약 (실행했으면 argv, 거부됐으면 요청 요약) */
  summary: string;
}

interface BinarySpec {
  packageName: string;
  bin: string;
}

const BINARIES = {
  vitest: { packageName: 'vitest', bin: 'vitest' },
  prisma: { packageName: 'prisma', bin: 'prisma' },
} as const satisfies Record<string, BinarySpec>;

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

/**
 * 워크트리의 패키지 실행 파일. POSIX는 `node_modules/.bin/<bin>`을 그대로 실행한다.
 * Windows의 `.bin/*.cmd`는 셸 없이 실행할 수 없으므로 패키지 `bin` 항목의 JS를 현재 Node로 실행한다.
 */
const resolveBinary = (
  spec: BinarySpec,
  root: string,
  platform: NodeJS.Platform,
): { file: string; prefix: string[]; display: string } | null => {
  const display = `node_modules/.bin/${spec.bin}`;
  if (platform !== 'win32') {
    const file = path.join(root, 'node_modules', '.bin', spec.bin);
    return fs.existsSync(file) ? { file, prefix: [], display } : null;
  }
  const packageDir = path.join(root, 'node_modules', spec.packageName);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[spec.bin];
    if (entry === undefined) return null;
    const script = path.resolve(packageDir, entry);
    return fs.existsSync(script) ? { file: process.execPath, prefix: [script], display } : null;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
};

const unavailable = (display: string): PlanResult => ({
  ok: false,
  result: failed('command_unavailable', `실행 파일 없음: ${display} (의존성 설치 필요)`),
});

const binaryPlan = (spec: BinarySpec, args: string[], context: CommandContext): PlanResult => {
  const platform = context.platform ?? process.platform;
  const binary = resolveBinary(spec, context.toolchainRoot ?? context.cwd, platform);
  if (binary === null) return unavailable(`node_modules/.bin/${spec.bin}`);
  return {
    ok: true,
    plan: {
      file: binary.file,
      args: [...binary.prefix, ...args],
      display: [binary.display, ...args].join(' '),
    },
  };
};

const invalid = (name: string, error: IssueList): PlanResult => ({
  ok: false,
  result: invalidArgs(name, error),
});

/** 도구 이름과 인자로 argv를 만든다. 허용 템플릿에 맞지 않으면 실행 전에 거부한다. */
export const planCommand = (
  name: CommandToolName,
  rawArgs: Record<string, unknown>,
  context: CommandContext,
): PlanResult => {
  switch (name) {
    case 'run_tests': {
      const parsed = RunTestsInput.safeParse(rawArgs);
      if (!parsed.success) return invalid(name, parsed.error);
      const files: string[] = [];
      for (const file of parsed.data.files ?? []) {
        const checked = context.guard.check(file, 'read');
        if (!checked.ok) return { ok: false, result: denied('path_denied', checked.detail) };
        // 정규화 결과가 `-`로 시작하면 옵션으로 읽히지 않게 `./`를 붙인다
        files.push(checked.relPath.startsWith('-') ? `./${checked.relPath}` : checked.relPath);
      }
      const pattern = parsed.data.testNamePattern;
      const args = ['run', ...(pattern === undefined ? [] : ['-t', pattern]), ...files];
      return binaryPlan(BINARIES.vitest, args, context);
    }
    case 'prisma_generate': {
      const parsed = PrismaGenerateInput.safeParse(rawArgs);
      if (!parsed.success) return invalid(name, parsed.error);
      return binaryPlan(BINARIES.prisma, ['generate'], context);
    }
    case 'prisma_migrate': {
      const parsed = PrismaMigrateInput.safeParse(rawArgs);
      if (!parsed.success) return invalid(name, parsed.error);
      return binaryPlan(BINARIES.prisma, ['migrate', 'deploy'], context);
    }
    case 'install_package': {
      const parsed = InstallPackageInput.safeParse(rawArgs);
      if (!parsed.success) return invalid(name, parsed.error);
      const spec = parsed.data.name;
      if (!(context.installAllowlist ?? []).includes(spec)) {
        return {
          ok: false,
          result: denied('not_allowed', `설치 허용 목록에 없는 패키지: ${spec}`),
        };
      }
      if (!PACKAGE_SPEC.test(spec)) {
        return { ok: false, result: denied('invalid_args', `패키지 이름 형식 오류: ${spec}`) };
      }
      if ((context.platform ?? process.platform) === 'win32') {
        return {
          ok: false,
          result: failed('unsupported_platform', 'Windows에서는 패키지 설치 도구를 지원하지 않음'),
        };
      }
      // 설치 스크립트(postinstall 등)는 임의 코드 실행이므로 끈다
      const args = ['add', '--save-exact', '--ignore-scripts', spec];
      return { ok: true, plan: { file: 'pnpm', args, display: ['pnpm', ...args].join(' ') } };
    }
  }
};

/** 허용 목록 변수만 고른 자식 프로세스 환경. */
export const commandEnv = (context: CommandContext): Record<string, string> => {
  const base = context.baseEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const key of COMMAND_ENV_ALLOWLIST) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...context.env, ...FIXED_ENV };
};

/** 출력의 끝부분만 남긴다. */
const tail = (text: string, limit: number): string => {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit) return text;
  return `… 출력이 길어 마지막 ${limit}바이트만 표시\n${bytes.subarray(bytes.length - limit).toString('utf8')}`;
};

/** 계획한 argv를 실행한다. 셸을 쓰지 않는다. */
export const execPlan = (plan: CommandPlan, name: CommandToolName, context: CommandContext) =>
  new Promise<ToolResult>((resolve) => {
    const timeoutMs = context.timeoutMs?.[name] ?? DEFAULT_COMMAND_TIMEOUT_MS[name];
    const limit = context.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => controller.abort();
    context.signal?.addEventListener('abort', onAbort, { once: true });
    if (context.signal?.aborted) controller.abort();

    execFile(
      plan.file,
      plan.args,
      {
        cwd: context.cwd,
        env: commandEnv(context),
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: HARD_OUTPUT_LIMIT_BYTES,
        signal: controller.signal,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onAbort);
        const output = tail([stdout, stderr].filter((s) => s.length > 0).join('\n'), limit);
        const body = (head: string): string => (output.length > 0 ? `${head}\n${output}` : head);
        if (error === null) {
          resolve(ok(body(`${plan.display}: 종료 코드 0`)));
          return;
        }
        if (timedOut) {
          resolve(failed('timeout', body(`${plan.display}: ${timeoutMs}ms 안에 끝나지 않아 중단`)));
        } else if (error.code === 'ENOENT') {
          resolve(failed('command_unavailable', `실행 파일 없음: ${plan.display}`));
        } else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve(failed('output_limit', body(`${plan.display}: 출력이 상한을 넘어 중단`)));
        } else if (typeof error.code === 'number') {
          resolve(failed('nonzero_exit', body(`${plan.display}: 종료 코드 ${error.code}`)));
        } else {
          resolve(failed('tool_failed', body(`${plan.display}: ${error.message}`)));
        }
      },
    );
  });

/** 명령 도구 실행: 템플릿 확인 → `execFile`. */
export const runCommand = async (
  name: CommandToolName,
  rawArgs: Record<string, unknown>,
  context: CommandContext,
): Promise<CommandOutcome> => {
  const planned = planCommand(name, rawArgs, context);
  if (!planned.ok) return { result: planned.result, summary: requestSummary(name, rawArgs) };
  return { result: await execPlan(planned.plan, name, context), summary: planned.plan.display };
};

/** 실행 전에 거부된 명령의 기록 요약: 도구 이름 + 요청 인자. */
const requestSummary = (name: string, rawArgs: Record<string, unknown>): string => {
  const args = JSON.stringify(rawArgs);
  return args === '{}' ? name : `${name} ${truncate(args, 200)}`;
};

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;
