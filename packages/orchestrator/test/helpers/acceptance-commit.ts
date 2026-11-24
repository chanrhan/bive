// 테스트 전용: 판정 기록의 커밋으로 쓸 인수 테스트 파일 커밋을 만든다 (M3-37 #265, ADR-121).
// 케이스 이름의 대조는 규칙마다 최근 판정 커밋의 인수 테스트 파일을 git 객체에서 읽으므로, 판정 기록을 심는 시험은 그 커밋이
// 실제로 있어야 한다. 브랜치 · 작업 트리 · 색인을 바꾸지 않는 커밋 객체 하나만 만든다(실행 워크트리의 기준이 바뀌지 않는다).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GIT_FLAGS = [
  '-c',
  'user.name=BIVE 시험',
  '-c',
  'user.email=test@bive.invalid',
  '-c',
  'commit.gpgsign=false',
];

const git = (cwd: string, args: readonly string[], input?: string, env?: NodeJS.ProcessEnv) =>
  execFileSync('git', [...GIT_FLAGS, ...args], {
    cwd,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  }).trim();

/** 빈 git 저장소를 만든다 (프로젝트 폴더로 쓴다). `parent`(시험이 정리하는 임시 폴더) 아래 `repo`에 만든다. */
export const initAcceptanceRepo = (parent: string): string => {
  const dir = path.join(parent, 'repo');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
};

/**
 * 저장소에 파일들(저장소 상대 경로 → 글)만 담은 커밋 객체를 만들고 그 SHA를 돌려준다. 브랜치 · 작업 트리 · 저장소 색인은 그대로다.
 */
export const commitAcceptanceFiles = (repo: string, files: Readonly<Record<string, string>>) => {
  // 저장소 색인 대신 따로 쓰는 색인 (저장소의 git 폴더 안, 끝나면 지운다)
  const gitDir = path.resolve(repo, git(repo, ['rev-parse', '--git-dir']));
  const index = path.join(gitDir, `bive-test-index-${String(process.pid)}-${String(Date.now())}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    for (const [file, text] of Object.entries(files)) {
      const blob = git(repo, ['hash-object', '-w', '--stdin'], text);
      git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], undefined, env);
    }
    const tree = git(repo, ['write-tree'], undefined, env);
    return git(repo, ['commit-tree', tree, '-m', '시험: 인수 테스트 파일'], undefined, env);
  } finally {
    fs.rmSync(index, { force: true });
  }
};

/** 케이스 이름마다 `it(<이름>)` 한 줄인 인수 테스트 파일 글 (이름은 문자열 리터럴로 적는다). */
export const caseFileText = (names: readonly string[]): string =>
  [
    "import { it } from 'vitest';",
    ...names.map((name) => `it(${JSON.stringify(name)}, () => undefined);`),
    '',
  ].join('\n');
