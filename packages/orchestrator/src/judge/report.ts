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

/** vitest JSON reporter 본문을 해석한다. */
export const parseVitestReport = (json: string, worktreeDir: string): ParsedReport => {
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

    // 파일 수준 오류(import 실패 · 문법 오류 · 최상위 예외 · 스위트 훅 실패)는 케이스 실패와 섞지 않는다
    if (fileMessage.length > 0) collectProblems.push({ file, message: fileMessage });
    else if (assertions.length === 0) {
      collectProblems.push({ file, message: '수집된 테스트 0개' });
    }
    assertions.forEach((raw, index) => cases.push(parseCase(raw, file, index)));
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
