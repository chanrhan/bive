// 파일 도구 경로 가드 (이슈 #20 수용 기준 2 · 3, NFR-01 · NFR-02 · ADR-024 · ADR-052).
// 읽기 · 쓰기 · 목록 · 검색 네 도구 모두에서 세션 루트 밖 · `$BIVE_HOME/projects` · `$BIVE_HOME/run` ·
// `.git` · `.bive.json` · 심볼릭 링크 우회를 거부하고, 역할별 쓰기 금지 경로를 지키는지 확인한다.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRoleTools, type FixedToolExecutor } from '../src/tools/executor.js';
import { PathGuard } from '../src/tools/path-guard.js';

const SECRET = 'SECRET-OUTSIDE-CONTENT';
const DB_MARK = 'NORM-STORE-CONTENT';
const TOKEN_MARK = 'PIPE-TOKEN-CONTENT';
const GIT_MARK = 'GIT-INTERNAL-CONTENT';

let home: string;
let outside: string;
let worktree: string;
let session: string;
const tempDirs: string[] = [];

const makeTemp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};

const put = (file: string, content: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};

const link = (target: string, at: string, type: 'file' | 'dir' = 'file'): void => {
  mkdirSync(path.dirname(at), { recursive: true });
  symlinkSync(target, at, type === 'dir' ? 'junction' : 'file');
};

beforeEach(() => {
  home = makeTemp('bive-guard-home-');
  outside = makeTemp('bive-guard-outside-');
  put(path.join(outside, 'secret.txt'), `${SECRET}\n`);
  put(path.join(home, 'projects', 'p1', 'bive.db'), `${DB_MARK}\n`);
  put(path.join(home, 'run', 'token'), `${TOKEN_MARK}\n`);

  worktree = path.join(home, 'work', 'p1', 'worktrees', 'r1');
  put(path.join(worktree, 'src', 'a.ts'), 'export const a = 1;\n');
  put(path.join(worktree, '.git', 'config'), `${GIT_MARK}\n`);
  put(path.join(worktree, 'packages', 'sub', '.git'), `gitdir: ${GIT_MARK}\n`);
  put(path.join(worktree, '.bive.json'), '{"projectId":"p1","schemaVersion":1}\n');
  put(path.join(worktree, 'bive-acceptance', 'RULE-001', 'time.acc.ts'), '// 인수 테스트\n');
  // 링크: 루트 밖 파일 · 루트 밖 폴더(중간 경로) · 저장소 · .git · 대상 없음 · 인수 테스트 · 루트 안
  link(path.join(outside, 'secret.txt'), path.join(worktree, 'src', 'link-out.ts'));
  link(outside, path.join(worktree, 'src', 'dir-out'), 'dir');
  link(path.join(home, 'projects'), path.join(worktree, 'src', 'to-projects'), 'dir');
  link(path.join(home, 'run'), path.join(worktree, 'to-run'), 'dir');
  link(path.join(worktree, '.git'), path.join(worktree, 'src', 'to-git'), 'dir');
  link(path.join(outside, 'new.txt'), path.join(worktree, 'src', 'dangling.ts'));
  link(path.join(worktree, 'bive-acceptance'), path.join(worktree, 'src', 'to-acceptance'), 'dir');
  link(path.join(worktree, 'src', 'a.ts'), path.join(worktree, 'src', 'link-in.ts'));

  session = path.join(home, 'work', 'p1', 'sessions', 's1');
  put(path.join(session, 'input', 'rule.md'), '# 규칙\n');
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const implementer = (): FixedToolExecutor =>
  createRoleTools({
    role: 'implementer',
    sessionRoot: worktree,
    biveHome: home,
    sessionId: 's-impl',
  });
const testWriter = (): FixedToolExecutor =>
  createRoleTools({ role: 'test-writer', sessionRoot: session, biveHome: home, sessionId: 's-tw' });

/** 루트 밖 · 저장소 · .git · .bive.json · 링크 우회 경로 (모든 파일 도구 공통). */
/** `<outside>` · `<home>`은 실행 시점의 임시 경로로 바꾼다(`it.each`는 수집 시점에 평가됨). */
const FORBIDDEN_PATHS: [string, string][] = [
  ['상위 폴더', '../../../../../../etc/passwd'],
  ['상위 폴더 섞인 경로', 'src/../../r2/src/a.ts'],
  ['루트 밖 절대 경로', '<outside>/secret.txt'],
  ['$BIVE_HOME/projects', '<home>/projects/p1/bive.db'],
  ['$BIVE_HOME/projects 상대 경로', '../../../../projects/p1/bive.db'],
  ['$BIVE_HOME/run', '<home>/run/token'],
  ['.git 폴더', '.git'],
  ['.git 안 파일', '.git/config'],
  ['하위 패키지 .git', 'packages/sub/.git'],
  ['대문자 .GIT', '.GIT/config'],
  ['.bive.json', '.bive.json'],
  ['루트 밖 파일 링크', 'src/link-out.ts'],
  ['루트 밖 폴더 링크(중간 경로)', 'src/dir-out/secret.txt'],
  ['루트 밖 폴더 링크', 'src/dir-out'],
  ['저장소 링크', 'src/to-projects/p1/bive.db'],
  ['run 링크', 'to-run/token'],
  ['.git 링크', 'src/to-git/config'],
];

const resolveTarget = (template: string): string =>
  template.replace('<outside>', outside).replace('<home>', home);

/** 결과 본문에 루트 밖 · 저장소 내용이 새지 않았는지. */
const expectNoLeak = (content: string): void => {
  for (const mark of [SECRET, DB_MARK, TOKEN_MARK, GIT_MARK]) expect(content).not.toContain(mark);
};

describe('파일 도구 공통 금지 경로', () => {
  for (const tool of ['read_file', 'list_files', 'search_files'] as const) {
    it.each(FORBIDDEN_PATHS)(`${tool}: %s 거부`, async (_label, template) => {
      const target = resolveTarget(template);
      const tools = implementer();
      const args = tool === 'search_files' ? { query: 'S', path: target } : { path: target };

      const result = await tools.execute(tool, args);

      expect(result).toMatchObject({ status: 'denied', reason: 'path_denied' });
      expectNoLeak(result.content);
      expect(tools.records).toEqual([
        expect.objectContaining({
          name: tool,
          argsSummary: target,
          status: 'denied',
          reason: 'path_denied',
        }),
      ]);
    });
  }

  it.each(FORBIDDEN_PATHS)('write_file: %s 거부 (아무것도 쓰지 않음)', async (_label, template) => {
    const target = resolveTarget(template);
    const tools = implementer();

    const result = await tools.execute('write_file', { path: target, content: 'PWNED' });

    expect(result).toMatchObject({ status: 'denied', reason: 'path_denied' });
    expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe(`${SECRET}\n`);
    expect(readFileSync(path.join(home, 'projects', 'p1', 'bive.db'), 'utf8')).toBe(`${DB_MARK}\n`);
    expect(readFileSync(path.join(home, 'run', 'token'), 'utf8')).toBe(`${TOKEN_MARK}\n`);
    expect(readFileSync(path.join(worktree, '.git', 'config'), 'utf8')).toBe(`${GIT_MARK}\n`);
    expect(tools.records[0]).toMatchObject({
      name: 'write_file',
      argsSummary: target,
      status: 'denied',
    });
  });

  it('대상이 없는 링크로는 쓸 수 없다 (루트 밖에 파일이 생기지 않음)', async () => {
    const result = await implementer().execute('write_file', {
      path: 'src/dangling.ts',
      content: 'x',
    });

    expect(result).toMatchObject({ status: 'denied', reason: 'path_denied' });
    expect(existsSync(path.join(outside, 'new.txt'))).toBe(false);
  });

  it('루트 밖 폴더 링크 아래 새 파일도 쓸 수 없다', async () => {
    const result = await implementer().execute('write_file', {
      path: 'src/dir-out/created/new.ts',
      content: 'x',
    });

    expect(result).toMatchObject({ status: 'denied', reason: 'path_denied' });
    expect(existsSync(path.join(outside, 'created'))).toBe(false);
  });

  it('세션 루트가 저장소 안이면 그 안의 파일도 거부한다', async () => {
    const tools = createRoleTools({
      role: 'implementer',
      sessionRoot: path.join(home, 'projects', 'p1'),
      biveHome: home,
    });

    const result = await tools.execute('read_file', { path: 'bive.db' });

    expect(result).toMatchObject({ status: 'denied', reason: 'path_denied' });
    expectNoLeak(result.content);
  });

  it('$BIVE_HOME 자체가 링크여도 실경로 기준으로 거부한다', async () => {
    const alias = path.join(makeTemp('bive-guard-alias-'), 'home');
    link(home, alias, 'dir');
    const tools = createRoleTools({ role: 'implementer', sessionRoot: worktree, biveHome: alias });

    const result = await tools.execute('read_file', { path: path.join(home, 'run', 'token') });

    expect(result).toMatchObject({ status: 'denied', reason: 'path_denied' });
  });
});

describe('목록 · 검색은 금지 항목을 드러내지 않는다', () => {
  it('list_files는 .git · .bive.json을 빼고, 링크는 따라가지 않고 표시만 한다', async () => {
    const result = await implementer().execute('list_files', { recursive: true });

    expect(result.status).toBe('ok');
    const lines = result.content.split('\n');
    expect(lines).toContain('src/a.ts');
    expect(lines).toContain('bive-acceptance/RULE-001/time.acc.ts');
    expect(lines).toContain('src/dir-out (링크)');
    expect(lines.some((line) => line.includes('.git'))).toBe(false);
    expect(lines.some((line) => line.includes('.bive.json'))).toBe(false);
    expect(lines.some((line) => line.includes('secret.txt'))).toBe(false);
    expect(lines.some((line) => line.includes('bive.db'))).toBe(false);
  });

  it('search_files는 링크 너머 · .git · 저장소 내용을 찾지 않는다', async () => {
    const tools = implementer();
    for (const query of [SECRET, DB_MARK, TOKEN_MARK, GIT_MARK, 'projectId']) {
      const result = await tools.execute('search_files', { query });
      expect(result).toEqual({ status: 'ok', content: '(일치 없음)' });
    }
    const found = await tools.execute('search_files', { query: 'export const a' });
    expect(found.content).toBe('src/a.ts:1: export const a = 1;');
  });
});

describe('허용 경로', () => {
  it('implementer는 워크트리 파일을 읽고 쓰고, 루트 안 링크는 실경로로 읽는다', async () => {
    const tools = implementer();

    expect(await tools.execute('read_file', { path: 'src/a.ts' })).toEqual({
      status: 'ok',
      content: 'export const a = 1;\n',
    });
    expect((await tools.execute('read_file', { path: 'src/link-in.ts' })).content).toBe(
      'export const a = 1;\n',
    );
    const written = await tools.execute('write_file', {
      path: 'src/app/api/health/route.ts',
      content: 'export {};\n',
    });
    expect(written.status).toBe('ok');
    expect(
      readFileSync(path.join(worktree, 'src', 'app', 'api', 'health', 'route.ts'), 'utf8'),
    ).toBe('export {};\n');
    expect((await tools.execute('list_files', { path: 'src/app' })).content).toBe('src/app/api/');
  });

  it('implementer는 인수 테스트를 읽을 수 있다', async () => {
    const result = await implementer().execute('read_file', {
      path: 'bive-acceptance/RULE-001/time.acc.ts',
    });
    expect(result).toEqual({ status: 'ok', content: '// 인수 테스트\n' });
  });
});

describe('역할별 쓰기 금지', () => {
  it.each([
    ['bive-acceptance/RULE-001/time.acc.ts'],
    ['bive-acceptance/RULE-002/new.acc.ts'],
    ['BIVE-ACCEPTANCE/RULE-001/time.acc.ts'],
    ['src/to-acceptance/RULE-001/time.acc.ts'],
    ['src/../bive-acceptance/x.ts'],
  ])('implementer는 인수 테스트 %s를 쓸 수 없다', async (target) => {
    const tools = implementer();

    const result = await tools.execute('write_file', { path: target, content: 'PWNED' });

    expect(result).toMatchObject({ status: 'denied', reason: 'path_denied' });
    expect(
      readFileSync(path.join(worktree, 'bive-acceptance', 'RULE-001', 'time.acc.ts'), 'utf8'),
    ).toBe('// 인수 테스트\n');
    expect(existsSync(path.join(worktree, 'bive-acceptance', 'RULE-002'))).toBe(false);
  });

  it('test-writer는 세션 디렉터리의 bive-acceptance 아래만 쓸 수 있다', async () => {
    const tools = testWriter();

    const ok = await tools.execute('write_file', {
      path: 'bive-acceptance/RULE-001/time.acc.ts',
      content: '// 새 인수 테스트\n',
    });
    expect(ok.status).toBe('ok');
    expect(
      readFileSync(path.join(session, 'bive-acceptance', 'RULE-001', 'time.acc.ts'), 'utf8'),
    ).toBe('// 새 인수 테스트\n');

    for (const target of [
      'src/app/api/health/route.ts',
      'input/rule.md',
      'bive-acceptance',
      'notes.txt',
      path.join(worktree, 'bive-acceptance', 'RULE-001', 'time.acc.ts'),
      path.join(worktree, 'src', 'a.ts'),
      '../s2/bive-acceptance/RULE-001/x.acc.ts',
    ]) {
      const result = await tools.execute('write_file', { path: target, content: 'PWNED' });
      expect(result, target).toMatchObject({ status: 'denied', reason: 'path_denied' });
    }
    expect(readFileSync(path.join(worktree, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('test-writer는 자기 세션 디렉터리 밖(워크트리 포함)을 읽을 수 없다', async () => {
    const tools = testWriter();

    expect((await tools.execute('read_file', { path: 'input/rule.md' })).status).toBe('ok');
    for (const target of [path.join(worktree, 'src', 'a.ts'), '../../worktrees/r1/src/a.ts']) {
      const result = await tools.execute('read_file', { path: target });
      expect(result).toMatchObject({ status: 'denied', reason: 'path_denied' });
    }
  });

  it('rule-writer에는 파일 도구가 없다', async () => {
    const tools = createRoleTools({ role: 'rule-writer', sessionRoot: session, biveHome: home });
    for (const name of ['read_file', 'write_file', 'list_files', 'search_files']) {
      const result = await tools.execute(name, { path: 'input/rule.md', content: 'x' });
      expect(result).toMatchObject({ status: 'denied', reason: 'unknown_tool' });
    }
  });
});

describe('PathGuard 단위', () => {
  it('정상 경로는 루트 기준 상대 경로와 실경로를 돌려준다', () => {
    const guard = new PathGuard({ role: 'implementer', sessionRoot: worktree, biveHome: home });

    expect(guard.check('./src//a.ts', 'read')).toEqual({
      ok: true,
      realPath: path.join(worktree, 'src', 'a.ts'),
      relPath: 'src/a.ts',
    });
    expect(guard.check('src/link-in.ts', 'read')).toMatchObject({ ok: true, relPath: 'src/a.ts' });
    expect(guard.check('.', 'read')).toMatchObject({ ok: true, relPath: '.' });
    expect(guard.check('new/dir/file.ts', 'write')).toMatchObject({
      ok: true,
      relPath: 'new/dir/file.ts',
    });
  });

  it('빈 경로 · NUL 문자는 거부한다', () => {
    const guard = new PathGuard({ role: 'implementer', sessionRoot: worktree, biveHome: home });
    expect(guard.check('', 'read').ok).toBe(false);
    expect(guard.check('src/a.ts\0.png', 'read').ok).toBe(false);
  });

  it('세션 루트가 없으면 만들 수 없다', () => {
    expect(
      () =>
        new PathGuard({
          role: 'implementer',
          sessionRoot: path.join(home, 'nope'),
          biveHome: home,
        }),
    ).toThrow(/세션 루트/u);
  });
});
