// vitest JSON reporter 결과 해석 (JDG-01, ADR-026).
// 케이스 단위 결과(JudgmentCase)와 파일 단위 문제(로드 오류 · 테스트 0개)를 나눈다.
import path from 'node:path';

import { type JudgmentCase, TestCaseStatus } from '@bive/shared';

import { ACCEPTANCE_DIR } from './config.js';

/** 케이스가 아닌 파일 · 실행 수준 문제. `file`은 워크트리 기준 상대 경로(없으면 전체 실행 문제). */
export interface JudgeProblem {
  file: string | null;
  message: string;
}

export interface JudgeSummary {
  /** 실행기가 보고한 테스트 파일 수 */
  files: number;
  total: number;
  passed: number;
  failed: number;
  /** skipped · pending · todo · disabled */
  skipped: number;
}

export interface ParsedReport {
  /** vitest가 보고한 전체 성공 여부 (참고용, 판정에는 cases를 쓴다) */
  success: boolean;
  cases: JudgmentCase[];
  /** 파일 로드 오류 · 테스트 0개 파일 · 0개 수집 (collect_error 원인) */
  collectProblems: JudgeProblem[];
  /** 보고된 파일 (워크트리 기준 상대 경로) */
  files: string[];
  summary: JudgeSummary;
}

/** JSON 모양이 예상과 다름. 러너가 `runner_error`로 바꾼다. */
export class ReportFormatError extends Error {
  constructor(message: string) {
    super(`실행기 결과 형식 오류: ${message}`);
    this.name = 'ReportFormatError';
  }
}

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

/** 색 제어 문자를 지운다. */
export const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, '');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** 워크트리 기준 상대 경로 (구분자 `/`). */
export const toRelativePath = (worktreeDir: string, file: string): string =>
  path.relative(worktreeDir, path.resolve(worktreeDir, file)).split(path.sep).join('/');

/** 인수 테스트 파일 경로의 규칙 ID (`bive-acceptance/<RULE-ID>/...`). 해당하지 않으면 `null`. */
export const ruleIdOfAcceptanceFile = (relativeFile: string): string | null => {
  const parts = relativeFile.split('/');
  return parts.length >= 3 && parts[0] === ACCEPTANCE_DIR && parts[1] ? parts[1] : null;
};

const parseCase = (raw: unknown, file: string, index: number): JudgmentCase => {
  if (!isRecord(raw)) throw new ReportFormatError(`${file}의 ${String(index)}번째 케이스`);
  const { ancestorTitles, title, status, failureMessages, location } = raw;
  if (typeof title !== 'string' || !isStringArray(ancestorTitles)) {
    throw new ReportFormatError(`${file}의 케이스 이름`);
  }
  const parsedStatus = TestCaseStatus.safeParse(status);
  if (!parsedStatus.success) {
    throw new ReportFormatError(`${file}의 케이스 상태 ${JSON.stringify(status)}`);
  }
  const messages = isStringArray(failureMessages) ? failureMessages : [];
  const line =
    isRecord(location) && typeof location.line === 'number' && location.line > 0
      ? Math.trunc(location.line)
      : null;
  const name = [...ancestorTitles, title].filter((part) => part.length > 0).join(' > ');
  const message = stripAnsi(messages.join('\n\n')).trim();
  return {
    name: name.length > 0 ? name : '(이름 없음)',
    file,
    line,
    status: parsedStatus.data,
    message: message.length > 0 ? message : null,
  };
};

/** 메시지 없이 실패한 파일(스위트 훅 실패 등)의 원인 안내 앞부분. */
export const SUITE_FAILURE_MESSAGE = '스위트 훅 실패 등 파일 수준 오류 (stderr.log 참고)';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** vitest 기본 reporter의 실패 머리줄 하나: ` FAIL  <file>[:줄] [> <스위트 · 케이스 이름>]`과 그 다음 첫 오류 줄. */
export interface FailHeader {
  /** ` > ` 뒤의 이름 (스위트 또는 케이스, 상위 이름을 ` > `로 이은 것). 없으면 `null` */
  name: string | null;
  /** 머리줄 다음의 첫 비어 있지 않은 줄 (오류 요약). 없으면 `null` */
  detail: string | null;
}

/** 출력에서 `file`의 실패 머리줄을 모두 찾는다. */
export const failHeadersFor = (output: string, file: string): FailHeader[] => {
  const lines = stripAnsi(output).split(/\r?\n/);
  const header = new RegExp(`^\\s*FAIL\\s+${escapeRegExp(file)}(?::\\d+)*(?=\\s|$)(.*)$`);
  const found: FailHeader[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = header.exec(lines[i] ?? '');
    if (match === null) continue;
    let detail: string | null = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = (lines[j] ?? '').trim();
      if (line.length > 0) {
        detail = line;
        break;
      }
    }
    const name = /^\s+>\s+(.+?)\s*$/.exec(match[1] ?? '')?.[1] ?? null;
    found.push({ name, detail });
  }
  return found;
};

/**
 * vitest 기본 reporter 출력에서 `file`의 첫 실패 줄을 찾는다.
 * ` FAIL  <file>[:줄] > <스위트>` 머리줄 다음의 첫 비어 있지 않은 줄(오류 요약)을 돌려준다. 없으면 `null`.
 */
export const firstErrorLineFor = (output: string, file: string): string | null =>
  failHeadersFor(output, file).find((header) => header.detail !== null)?.detail ?? null;

export interface ParseOptions {
  /** 같은 실행의 reporter 출력(stderr). 메시지 없는 파일 실패의 원인 줄을 찾는 데 쓴다 */
  output?: string;
}

/** vitest JSON reporter 본문을 해석한다. */
export const parseVitestReport = (
  json: string,
  worktreeDir: string,
  options: ParseOptions = {},
): ParsedReport => {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new ReportFormatError(`JSON 해석 실패 (${(err as Error).message})`);
  }
  if (!isRecord(data) || !Array.isArray(data.testResults)) {
    throw new ReportFormatError('testResults 없음');
  }

  const cases: JudgmentCase[] = [];
  const collectProblems: JudgeProblem[] = [];
  const files: string[] = [];

  for (const rawFile of data.testResults) {
    if (!isRecord(rawFile) || typeof rawFile.name !== 'string') {
      throw new ReportFormatError('파일 이름 없음');
    }
    const file = toRelativePath(worktreeDir, rawFile.name);
    files.push(file);
    const assertions = Array.isArray(rawFile.assertionResults) ? rawFile.assertionResults : [];
    const fileMessage =
      typeof rawFile.message === 'string' ? stripAnsi(rawFile.message).trim() : '';

    const fileCases = assertions.map((raw, index) => parseCase(raw, file, index));
    cases.push(...fileCases);

    // 파일 수준 오류(import 실패 · 문법 오류 · 최상위 예외 · 스위트 훅 실패)는 케이스 실패와 섞지 않는다
    if (fileMessage.length > 0) collectProblems.push({ file, message: fileMessage });
    else if (assertions.length === 0) {
      collectProblems.push({ file, message: '수집된 테스트 0개' });
    } else if (rawFile.status === 'failed' && !fileCases.some((c) => c.status === 'failed')) {
      // describe 안 beforeAll · afterAll 실패는 JSON에 메시지 없이 파일 실패로만 남고 케이스는 건너뜀이 된다
      const detail = options.output === undefined ? null : firstErrorLineFor(options.output, file);
      collectProblems.push({
        file,
        message: detail === null ? SUITE_FAILURE_MESSAGE : `${SUITE_FAILURE_MESSAGE}: ${detail}`,
      });
    } else if (rawFile.status === 'failed' && options.output !== undefined) {
      // 실패 케이스와 스위트 훅 실패가 한 파일에 섞인 경우: 훅 실패는 JSON에 남지 않고(그 스위트 케이스는 건너뜀)
      // 출력의 ` FAIL  <file> > <스위트>` 머리줄로만 드러난다. 실패 케이스가 아닌 이름의 머리줄을 파일 수준 오류로
      // 올린다 (ADR-051 "훅 실패는 위치와 무관하게 파일 수준 오류", ADR-068)
      const failedNames = new Set(
        fileCases.filter((c) => c.status === 'failed').map((c) => c.name),
      );
      for (const header of failHeadersFor(options.output, file)) {
        if (header.name === null || failedNames.has(header.name)) continue;
        collectProblems.push({
          file,
          message: `${SUITE_FAILURE_MESSAGE}: ${header.name}${header.detail === null ? '' : ` - ${header.detail}`}`,
        });
      }
    }
  }

  if (cases.length === 0 && collectProblems.length === 0) {
    collectProblems.push({ file: null, message: '수집된 테스트 0개' });
  }

  const count = (status: TestCaseStatus): number => cases.filter((c) => c.status === status).length;
  const passed = count('passed');
  const failed = count('failed');
  return {
    success: data.success === true,
    cases,
    collectProblems,
    files,
    summary: {
      files: files.length,
      total: cases.length,
      passed,
      failed,
      skipped: cases.length - passed - failed,
    },
  };
};
