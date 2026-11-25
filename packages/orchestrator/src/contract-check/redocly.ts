// OpenAPI 문서 유효성: `@redocly/cli lint` (ADR-033, M3-47 #292 · ADR-132 ②).
// - 작업 폴더 = 빈 도구 폴더, 넘기는 문서 = 그 폴더의 계약 사본, 설정 = BIVE가 쓴 설정 파일(`--config`, 규칙 묶음 `spec`: OpenAPI 명세
//   준수만 · 사용 기록 끔). 대상 프로젝트의 `redocly.yaml`(플러그인 JS를 실행한다)은 찾지 않는다(실측: 작업 폴더의 설정만 읽는다)
// - 부르기 전에 문서의 바깥 참조를 막는다(`openapi-document.ts`). 도구에는 원격 참조를 끄는 선택 항목이 없다
// - 결과는 JSON 출력(`--format=json`)만 믿는다: 종료 코드가 0 · 1이 아니거나, 출력이 JSON · 기대한 모양이 아니거나, 오류 수와 종료 코드가
//   맞지 않으면(오류가 있는데 0, 없는데 1) 도구 오류다(통과로 읽지 않는다)
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { ContractToolError, REDOCLY_ENTRY, runTool, toolEnv } from './tool.js';

/** BIVE가 쓰는 redocly 설정 (대상 프로젝트 설정 대신). */
export const REDOCLY_CONFIG = 'extends:\n  - spec\ntelemetry: off\n';

/** 도구 폴더 안의 파일 이름. */
export const REDOCLY_CONFIG_FILE = 'bive-redocly.yaml';

/** lint 제한 시간 (기본). 실측: 픽스처 문서 약 0.3초. */
export const DEFAULT_LINT_TIMEOUT_MS = 60_000;

/** lint 출력 상한 (문제 100건 상한의 JSON). */
const MAX_LINT_OUTPUT_BYTES = 8 * 1024 * 1024;

/** 도구가 보고하는 문제 수 상한 (`--max-problems`). 전체 수는 `totals`에 있다. */
export const MAX_LINT_PROBLEMS = 100;

const LintOutput = z.object({
  totals: z.object({
    errors: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    ignored: z.number().int().nonnegative(),
  }),
  problems: z.array(
    z.object({
      ruleId: z.string(),
      severity: z.string(),
      message: z.string(),
      location: z
        .array(
          z.object({
            pointer: z.string().optional(),
            start: z.object({ line: z.number().int() }).partial().optional(),
          }),
        )
        .optional(),
    }),
  ),
});

export interface LintProblem {
  readonly ruleId: string;
  readonly message: string;
  readonly pointer: string | null;
  readonly line: number | null;
}

export interface LintResult {
  readonly errors: number;
  readonly warnings: number;
  /** 오류 문제 (도구가 보고한 것, 상한 {@link MAX_LINT_PROBLEMS}) */
  readonly problems: readonly LintProblem[];
}

export interface LintOptions {
  /** 빈 도구 폴더 (계약 사본이 있다) */
  readonly toolDir: string;
  /** 도구 폴더 안의 계약 사본 파일 이름 */
  readonly documentFile: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  /** 도구 진입 파일 (시험용 주입, 기본 {@link REDOCLY_ENTRY}) */
  readonly entry?: string;
}

/** lint 인자: BIVE 설정 명시 · 설정 파일 검사 끔 · JSON 출력 · 문제 수 상한. */
export const lintArgs = (documentFile: string, config: string): string[] => [
  'lint',
  documentFile,
  '--config',
  config,
  '--lint-config',
  'off',
  '--format',
  'json',
  '--max-problems',
  String(MAX_LINT_PROBLEMS),
];

/** 도구 폴더의 계약 사본을 lint한다. 도구를 끝까지 못 돌리거나 출력을 믿을 수 없으면 {@link ContractToolError}. */
export const lintOpenApi = async (options: LintOptions): Promise<LintResult> => {
  const config = path.join(options.toolDir, REDOCLY_CONFIG_FILE);
  writeFileSync(config, REDOCLY_CONFIG, { mode: 0o600 });
  const run = await runTool(
    options.entry ?? REDOCLY_ENTRY,
    lintArgs(options.documentFile, config),
    {
      cwd: options.toolDir,
      env: toolEnv(options.toolDir),
      timeoutMs: options.timeoutMs ?? DEFAULT_LINT_TIMEOUT_MS,
      maxOutputBytes: MAX_LINT_OUTPUT_BYTES,
      signal: options.signal,
    },
  );
  if (run.code !== 0 && run.code !== 1) {
    throw new ContractToolError(
      'unexpected_exit',
      `lint 종료 코드가 예상 밖입니다 (${String(run.code)})`,
    );
  }
  let parsed;
  try {
    parsed = LintOutput.safeParse(JSON.parse(run.stdout));
  } catch {
    throw new ContractToolError('output_invalid', 'lint 출력이 JSON이 아닙니다');
  }
  if (!parsed.success) throw new ContractToolError('output_invalid', 'lint 출력 모양이 다릅니다');
  const { totals, problems } = parsed.data;
  // 종료 코드만 믿지 않는다: 오류 수와 종료 코드가 함께 맞아야 한다
  if (totals.errors > 0 !== (run.code === 1)) {
    throw new ContractToolError('output_invalid', 'lint 오류 수와 종료 코드가 맞지 않습니다');
  }
  const errors = problems.filter((problem) => problem.severity === 'error');
  if (totals.errors > 0 && errors.length === 0) {
    throw new ContractToolError('output_invalid', 'lint 오류 수가 있는데 오류 문제가 없습니다');
  }
  return {
    errors: totals.errors,
    warnings: totals.warnings,
    problems: errors.map((problem) => ({
      ruleId: problem.ruleId,
      message: problem.message,
      pointer: problem.location?.[0]?.pointer ?? null,
      line: problem.location?.[0]?.start?.line ?? null,
    })),
  };
};
