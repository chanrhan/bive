// AsyncAPI 계약 검사 실행기: 문서 유효성만 (NRM-03 · JDG-01, ADR-033 · ADR-130 ③, M3-49 #294 · ADR-148).
// - 도구: `@asyncapi/parser`(공식 라이브러리)의 `parse`. `@asyncapi/cli`는 쓰지 않는다(ADR-130 실측). 구현 일치 검사는 하지 않는다(ADR-033)
// - 라이브러리를 오케스트레이터 프로세스 안에서 부르지 않는다: OpenAPI 실행기와 같은 도구 자식 프로세스(`tool.ts`: 대상 프로젝트 밖 빈 도구
//   폴더 · 부모 환경 변수 넘기지 않음 · 시간 · 출력 상한 · 중단 신호)에서 BIVE의 진입 스크립트(`runner/asyncapi-validate.mjs`)가 부른다
// - 부르기 전에 문서를 데이터로 읽어 바깥 참조 · 도구가 검사하지 못하는 스키마 형식을 막는다(`asyncapi-document.ts`). 진입 스크립트도
//   바깥 읽기를 가로채 센다(둘째 겹): 그 수가 0이 아니면 판정하지 않는다
// - 결과는 진입 스크립트의 JSON 출력만 믿는다: 종료 코드가 0이 아님, JSON이 아님 · 다른 모양, 오류 수와 오류 문제가 맞지 않음, 오류가
//   없는데 문서를 만들지 못함, 라이브러리가 내부 오류를 보고함은 도구 오류다(통과로 읽지 않는다)
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { type DocumentFinding, readAsyncApiDocument } from './asyncapi-document.js';
import {
  ASYNCAPI_ENTRY,
  ContractToolError,
  createToolDir,
  removeToolDir,
  runTool,
  toolEnv,
} from './tool.js';

/** 검사 제한 시간 (기본). 실측: 작은 문서 약 0.8초(프로세스 기동 · 라이브러리 읽기 포함). */
export const DEFAULT_ASYNCAPI_TIMEOUT_MS = 60_000;

/** 검사 출력 상한 (문제 100건 상한의 JSON). */
const MAX_ASYNCAPI_OUTPUT_BYTES = 8 * 1024 * 1024;

/** 진입 스크립트가 싣는 오류 문제 상한 (`runner/asyncapi-validate.mjs`와 같다). */
export const MAX_ASYNCAPI_PROBLEMS = 100;

const ValidateOutput = z
  .object({
    tool: z.literal('asyncapi-parser'),
    parsed: z.boolean(),
    errors: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    uncaught: z.boolean(),
    externalReads: z.number().int().nonnegative(),
    problems: z
      .array(
        z
          .object({
            code: z.string(),
            message: z.string(),
            path: z.array(z.string()),
            line: z.number().int().positive().nullable(),
          })
          .strict(),
      )
      .max(MAX_ASYNCAPI_PROBLEMS),
  })
  .strict();

export interface AsyncApiProblem {
  readonly code: string;
  readonly message: string;
  /** 문서 안 위치 (JSON 포인터, 문서 글이 실린다: 기록 전에 표시 값으로 바꾼다) */
  readonly pointer: string;
  readonly line: number | null;
}

export type AsyncApiResult =
  /** 문서를 읽지 못함 · 유효성 오류: 문서가 형식에 맞지 않는다 */
  | {
      readonly kind: 'document_invalid';
      readonly reason: 'unreadable' | 'invalid';
      readonly message: string;
      readonly problems: readonly AsyncApiProblem[];
      readonly errors: number;
    }
  /** 계약 파일 밖을 가리키는 값이 있어 판정하지 않는다 (도구를 부르지 않았거나 도구가 바깥을 읽으려 했다) */
  | {
      readonly kind: 'external';
      readonly references: readonly DocumentFinding[];
      readonly total: number;
    }
  /** 도구가 검사하지 못하는 스키마 형식이 있어 판정하지 않는다 */
  | {
      readonly kind: 'unsupported_schema_format';
      readonly formats: readonly DocumentFinding[];
      readonly total: number;
    }
  /** 유효한 문서 */
  | { readonly kind: 'valid'; readonly warnings: number };

export interface AsyncApiOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  /** 도구 폴더의 상위 (기본 시스템 임시 폴더) */
  readonly tempDir?: string;
  /** 도구 진입 파일 (시험용 주입, 기본 {@link ASYNCAPI_ENTRY}) */
  readonly entry?: string;
}

/** 도구 폴더 안의 계약 사본 이름 (원본 확장자를 따른다). */
const documentFileName = (sourceFile: string): string =>
  sourceFile.endsWith('.json') ? 'contract.json' : 'contract.yaml';

const escapePointer = (key: string): string => key.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * 도구 폴더의 계약 사본을 검사한다. 도구를 끝까지 못 돌리거나 출력을 믿을 수 없으면 {@link ContractToolError}, 중단이면 신호의 사유로
 * 던진다.
 */
export const runAsyncApiValidate = async (options: {
  readonly toolDir: string;
  readonly documentFile: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly entry?: string;
}): Promise<z.infer<typeof ValidateOutput>> => {
  const run = await runTool(options.entry ?? ASYNCAPI_ENTRY, [options.documentFile], {
    cwd: options.toolDir,
    env: toolEnv(options.toolDir),
    timeoutMs: options.timeoutMs ?? DEFAULT_ASYNCAPI_TIMEOUT_MS,
    maxOutputBytes: MAX_ASYNCAPI_OUTPUT_BYTES,
    signal: options.signal,
  });
  if (run.code !== 0) {
    throw new ContractToolError(
      'unexpected_exit',
      `검사 종료 코드가 예상 밖입니다 (${String(run.code)})`,
    );
  }
  let parsed;
  try {
    parsed = ValidateOutput.safeParse(JSON.parse(run.stdout));
  } catch {
    throw new ContractToolError('output_invalid', '검사 출력이 JSON이 아닙니다');
  }
  if (!parsed.success) throw new ContractToolError('output_invalid', '검사 출력 모양이 다릅니다');
  const output = parsed.data;
  if (output.uncaught) {
    throw new ContractToolError('output_invalid', '검사 도구가 내부 오류를 보고했습니다');
  }
  // 오류 수 · 오류 문제 · 문서 생성이 서로 맞아야 한다 (하나만 믿지 않는다)
  if (output.errors > 0 !== output.problems.length > 0) {
    throw new ContractToolError('output_invalid', '검사 오류 수와 오류 문제가 맞지 않습니다');
  }
  if (output.errors === 0 && !output.parsed) {
    throw new ContractToolError('output_invalid', '검사 오류가 없는데 문서를 만들지 못했습니다');
  }
  if (output.errors > 0 && output.parsed) {
    throw new ContractToolError('output_invalid', '검사 오류가 있는데 문서를 만들었습니다');
  }
  return output;
};

/**
 * 등록된 계약 글 `text`(git 객체에서 읽은 것)를 검사한다. 도구 폴더는 어떤 경우에도 지운다. 도구를 끝까지 못 돌리면
 * `ContractToolError`, 중단이면 신호의 사유로 던진다.
 */
export const validateAsyncApiContract = async (
  text: string,
  options: AsyncApiOptions & { readonly sourceFile: string },
): Promise<AsyncApiResult> => {
  const read = readAsyncApiDocument(text);
  if (read.kind === 'unreadable') {
    return {
      kind: 'document_invalid',
      reason: 'unreadable',
      message: read.message,
      problems: [],
      errors: 1,
    };
  }
  if (read.kind === 'external') {
    return { kind: 'external', references: read.references, total: read.total };
  }
  if (read.kind === 'unsupported_schema_format') {
    return { kind: 'unsupported_schema_format', formats: read.formats, total: read.total };
  }
  const toolDir = createToolDir(options.tempDir);
  try {
    const documentFile = documentFileName(options.sourceFile);
    writeFileSync(path.join(toolDir, documentFile), text, { mode: 0o600 });
    const output = await runAsyncApiValidate({
      toolDir,
      documentFile,
      signal: options.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.entry === undefined ? {} : { entry: options.entry }),
    });
    // 둘째 겹: 사전 검사를 지났는데 도구가 바깥을 읽으려 했다 (읽지 않고 빈 글을 받았다). 판정하지 않는다
    if (output.externalReads > 0) {
      return { kind: 'external', references: [], total: output.externalReads };
    }
    if (output.errors > 0) {
      return {
        kind: 'document_invalid',
        reason: 'invalid',
        message: `문서 형식 오류 ${String(output.errors)}건`,
        problems: output.problems.map((problem) => ({
          code: problem.code,
          message: problem.message,
          pointer: problem.path.map((part) => `/${escapePointer(part)}`).join(''),
          line: problem.line,
        })),
        errors: output.errors,
      };
    }
    return { kind: 'valid', warnings: output.warnings };
  } finally {
    removeToolDir(toolDir);
  }
};
