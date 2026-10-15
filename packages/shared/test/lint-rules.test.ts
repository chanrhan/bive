// 루트 eslint.config.js의 import 금지 규칙 검증 (M0-01, NFR-03, architecture.md 2장).
// lint-fixtures/의 예제 파일을 머리말 `// lint-path: <경로>`에 적힌 가상 경로로 검사한다.
// 줄 끝 표시: `// 위반` 줄에는 import 금지 오류가 있어야 하고, `// 허용` 줄에는 없어야 한다.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixturesDir = fileURLToPath(new URL('./lint-fixtures/', import.meta.url));

/** import 금지를 담당하는 규칙. 그 밖의 규칙(미사용 변수 등) 오류는 세지 않는다. */
const RESTRICTION_RULES = new Set([
  '@typescript-eslint/no-restricted-imports',
  'no-restricted-syntax',
]);

interface Fixture {
  file: string;
  code: string;
  lintPaths: string[];
  violationLines: number[];
  allowedLines: number[];
}

const linesWith = (code: string, marker: string): number[] =>
  code.split('\n').flatMap((line, i) => (line.trimEnd().endsWith(`// ${marker}`) ? [i + 1] : []));

const fixtures: Fixture[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map((file) => {
    const code = readFileSync(`${fixturesDir}${file}`, 'utf8');
    const lintPaths = [...code.matchAll(/^\/\/ lint-path: (.+)$/gm)].map((m) =>
      (m[1] ?? '').trim(),
    );
    return {
      file,
      code,
      lintPaths,
      violationLines: linesWith(code, '위반'),
      allowedLines: linesWith(code, '허용'),
    };
  });

const eslint = new ESLint({ cwd: repoRoot });

const restrictionErrorLines = async (code: string, filePath: string): Promise<number[]> => {
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: true });
  expect(result, `${filePath} 검사 결과`).toBeDefined();
  const messages = result?.messages ?? [];
  // 파일이 무시되거나 파싱에 실패하면 규칙 검증이 무의미하므로 실패로 본다
  expect(
    messages.filter((m) => m.fatal === true || m.ruleId === null),
    `${filePath}: 파싱 오류 또는 무시된 파일`,
  ).toEqual([]);
  return messages
    .filter((m) => m.severity === 2 && m.ruleId !== null && RESTRICTION_RULES.has(m.ruleId))
    .map((m) => m.line);
};

describe('ESLint import 금지 규칙', () => {
  it('위반 · 허용 예제 파일이 있다', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
    for (const f of fixtures) {
      expect(f.lintPaths.length, `${f.file}: lint-path 머리말`).toBeGreaterThan(0);
      expect(f.violationLines.length + f.allowedLines.length, `${f.file}: 표시 줄`).toBeGreaterThan(
        0,
      );
    }
  });

  const cases = fixtures.flatMap((f) => f.lintPaths.map((lintPath) => ({ ...f, lintPath })));

  it.each(cases)('$file → $lintPath', async ({ code, lintPath, violationLines, allowedLines }) => {
    const errorLines = new Set(await restrictionErrorLines(code, lintPath));

    if (violationLines.length > 0) {
      // 위반 예제 파일마다 오류 1건 이상 (수용 기준)
      expect(errorLines.size).toBeGreaterThanOrEqual(1);
    }
    for (const line of violationLines) {
      expect(errorLines.has(line), `${line}번째 줄은 오류여야 함`).toBe(true);
    }
    for (const line of allowedLines) {
      expect(errorLines.has(line), `${line}번째 줄은 허용이어야 함`).toBe(false);
    }
  });

  it('위반 예제는 일반 lint 대상에서 제외된다', async () => {
    expect(await eslint.isPathIgnored(`${fixturesDir}shared-boundaries.ts`)).toBe(true);
  });
});
