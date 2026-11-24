// 최근 판정 커밋의 인수 테스트 파일 읽기 (M3-37 #265, ADR-121). 대조 자체는 `check-regression.test.ts`, 세션 길은 역할별 시험이 본다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_TEXT_MAX_BYTES,
  judgedCaseFilter,
  readJudgedAcceptanceTexts,
} from '../src/norms/case-names.js';
import {
  caseFileText,
  commitAcceptanceFiles,
  initAcceptanceRepo,
} from './helpers/acceptance-commit.js';
import { cleanup, makeBiveHome } from './helpers/process.js';

afterEach(cleanup);

/** 기호 링크 하나를 담은 커밋 (링크 대상 글 = `target`). */
const commitWithLink = (repo: string, file: string, target: string): string => {
  const gitDir = path.join(repo, '.git');
  const index = path.join(gitDir, 'link-index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (args: string[], input?: string) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@bive.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: repo, encoding: 'utf8', env, ...(input === undefined ? {} : { input }) },
    ).trim();
  const blob = run(['hash-object', '-w', '--stdin'], target);
  run(['update-index', '--add', '--cacheinfo', `120000,${blob},${file}`]);
  const tree = run(['write-tree']);
  const commit = run(['commit-tree', tree, '-m', 'link']);
  fs.rmSync(index, { force: true });
  return commit;
};

describe('최근 판정 커밋의 인수 테스트 파일 읽기 (ADR-121)', () => {
  it('규칙마다 그 판정 커밋의 그 규칙 폴더 일반 파일만 읽는다: 다른 규칙 폴더 · 기호 링크 · 읽지 못한 커밋 · 커밋 형식이 아닌 값은 글이 없다', async () => {
    const repo = initAcceptanceRepo(makeBiveHome());
    const first = commitAcceptanceFiles(repo, {
      'bive-acceptance/RULE-001/a.acc.ts': caseFileText(['첫 커밋의 이름']),
      'bive-acceptance/RULE-002/old.acc.ts': caseFileText(['다른 규칙 폴더의 이름']),
    });
    const second = commitAcceptanceFiles(repo, {
      'bive-acceptance/RULE-002/b.acc.ts': caseFileText(['둘째 커밋의 이름']),
    });
    const linked = commitWithLink(
      repo,
      'bive-acceptance/RULE-003/link.acc.ts',
      caseFileText(['링크 글의 이름']),
    );
    const texts = await readJudgedAcceptanceTexts(repo, [
      { ruleDisplayId: 'RULE-001', commit: first },
      { ruleDisplayId: 'RULE-002', commit: second },
      { ruleDisplayId: 'RULE-003', commit: linked },
      { ruleDisplayId: 'RULE-004', commit: 'f'.repeat(40) },
      { ruleDisplayId: 'RULE-005', commit: '--all' },
    ]);
    expect(Object.keys(texts).sort()).toEqual([
      'bive-acceptance/RULE-001/a.acc.ts',
      'bive-acceptance/RULE-002/b.acc.ts',
    ]);
    expect(texts['bive-acceptance/RULE-002/b.acc.ts']).toContain('둘째 커밋의 이름');
    const known = await judgedCaseFilter(repo, [
      { ruleDisplayId: 'RULE-001', commit: first },
      { ruleDisplayId: 'RULE-002', commit: second },
      { ruleDisplayId: 'RULE-003', commit: linked },
    ]);
    expect(known('RULE-001', '첫 커밋의 이름')).toBe(true);
    // RULE-001의 커밋에 있는 다른 규칙 폴더의 글은 RULE-002의 기준이 아니다 (RULE-002는 둘째 커밋만)
    expect(known('RULE-002', '다른 규칙 폴더의 이름')).toBe(false);
    expect(known('RULE-002', '둘째 커밋의 이름')).toBe(true);
    expect(known('RULE-003', '링크 글의 이름')).toBe(false);
  });

  it(`파일당 앞 ${String(ACCEPTANCE_TEXT_MAX_BYTES)}바이트만 쓴다: 그 뒤에 적힌 이름은 모른다`, async () => {
    const repo = initAcceptanceRepo(makeBiveHome());
    const head = caseFileText(['앞쪽 이름']);
    const padding = `// ${'x'.repeat(ACCEPTANCE_TEXT_MAX_BYTES)}\n`;
    const commit = commitAcceptanceFiles(repo, {
      'bive-acceptance/RULE-001/big.acc.ts': `${head}${padding}it('뒤쪽 이름', () => undefined);\n`,
    });
    const texts = await readJudgedAcceptanceTexts(repo, [{ ruleDisplayId: 'RULE-001', commit }]);
    const text = texts['bive-acceptance/RULE-001/big.acc.ts'] ?? '';
    expect(Buffer.byteLength(text, 'utf8')).toBe(ACCEPTANCE_TEXT_MAX_BYTES);
    expect(text).not.toContain('뒤쪽 이름');
  });
});
