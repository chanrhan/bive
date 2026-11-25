// OpenAPI 계약 검사 실행기 (NRM-03 · JDG-01, ADR-033, M3-47 #292 · ADR-132).
// 두 단계다. ① 준비(판정 서버를 띄우기 전): 문서를 데이터로 읽어 바깥 참조를 막고(`openapi-document.ts`), `@redocly/cli lint`로 문서
// 유효성을 본다(`redocly.ts`). ② 트래픽 검증(판정이 끝난 뒤): 판정 서버 앞 기록 프록시가 남긴 교환을 `@stoplight/prism-cli proxy
// --errors`로 대조한다(`prism.ts`). 두 도구 모두 대상 프로젝트 밖의 빈 도구 폴더에서 계약 사본 하나만 받는다.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { readOpenApiDocument, type ExternalReference } from './openapi-document.js';
import { type PrismResult, validateWithPrism } from './prism.js';
import type { RecordedExchange } from './recorder.js';
import { type LintProblem, lintOpenApi } from './redocly.js';
import { createToolDir, removeToolDir } from './tool.js';

/** 도구 폴더 안의 계약 사본 이름 (원본 확장자를 따른다: 도구가 확장자로 형식을 고르지 않게 YAML · JSON 둘 다 그대로). */
const documentFileName = (sourceFile: string): string =>
  sourceFile.endsWith('.json') ? 'contract.json' : 'contract.yaml';

export type OpenApiPrepared =
  /** 문서를 읽지 못함 · lint 오류: 문서가 형식에 맞지 않는다 (트래픽을 검증하지 않는다) */
  | {
      readonly kind: 'document_invalid';
      readonly reason: 'unreadable' | 'lint';
      readonly message: string;
      readonly problems: readonly LintProblem[];
      readonly errors: number;
    }
  /** 계약 파일 밖을 가리키는 값이 있어 도구를 부르지 않았다 */
  | {
      readonly kind: 'external';
      readonly references: readonly ExternalReference[];
      readonly total: number;
    }
  /** 문서에 경로가 없어 대조할 작업이 없다 */
  | { readonly kind: 'no_operations'; readonly warnings: number }
  /** 트래픽 검증을 기다린다 (도구 폴더는 {@link disposePrepared}로 지운다) */
  | {
      readonly kind: 'ready';
      readonly toolDir: string;
      readonly documentFile: string;
      readonly warnings: number;
    };

export interface PrepareOptions {
  readonly sourceFile: string;
  readonly signal: AbortSignal;
  readonly lintTimeoutMs?: number;
  /** 도구 폴더의 상위 (기본 시스템 임시 폴더) */
  readonly tempDir?: string;
}

/**
 * ① 준비: 등록된 계약 글 `text`(git 객체에서 읽은 것)를 검사한다. 도구를 끝까지 못 돌리면 `ContractToolError`, 중단이면 신호의 사유로
 * 던진다(도구 폴더는 지운다).
 */
export const prepareOpenApiContract = async (
  text: string,
  options: PrepareOptions,
): Promise<OpenApiPrepared> => {
  const read = readOpenApiDocument(text);
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
  const toolDir = createToolDir(options.tempDir);
  let keep = false;
  try {
    const documentFile = documentFileName(options.sourceFile);
    writeFileSync(path.join(toolDir, documentFile), text, { mode: 0o600 });
    const lint = await lintOpenApi({
      toolDir,
      documentFile,
      signal: options.signal,
      ...(options.lintTimeoutMs === undefined ? {} : { timeoutMs: options.lintTimeoutMs }),
    });
    if (lint.errors > 0) {
      return {
        kind: 'document_invalid',
        reason: 'lint',
        message: `문서 형식 오류 ${String(lint.errors)}건`,
        problems: lint.problems,
        errors: lint.errors,
      };
    }
    if (!read.hasPaths) return { kind: 'no_operations', warnings: lint.warnings };
    keep = true;
    return { kind: 'ready', toolDir, documentFile, warnings: lint.warnings };
  } finally {
    if (!keep) removeToolDir(toolDir);
  }
};

/** 준비 결과의 도구 폴더를 지운다 (없으면 아무것도 하지 않는다). */
export const disposePrepared = (prepared: OpenApiPrepared): void => {
  if (prepared.kind === 'ready') removeToolDir(prepared.toolDir);
};

/** ② 트래픽 검증: 기록된 교환을 prism으로 대조한다. */
export const verifyOpenApiTraffic = (
  prepared: Extract<OpenApiPrepared, { kind: 'ready' }>,
  exchanges: readonly RecordedExchange[],
  options: { readonly signal: AbortSignal; readonly timeoutMs?: number },
): Promise<PrismResult> =>
  validateWithPrism({
    toolDir: prepared.toolDir,
    documentFile: prepared.documentFile,
    exchanges,
    signal: options.signal,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
