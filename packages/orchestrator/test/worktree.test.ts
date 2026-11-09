// git 브랜치 · 워크트리 · 병합 관리자 (M1-13, RUN-08 · ADR-017 · ADR-025 · ADR-058).
// 픽스처(fixtures/sample-next-app)의 추적 파일을 임시 폴더에 복사해 실제 git 저장소로 단언한다.
// 의존성 설치는 하지 않는다(git 동작만 본다). 검사 함수는 테스트가 주입하는 가짜다.
// 제한: git 프로세스를 수십 번 띄우는 묶음은 30초(부하 평균 12 이상에서 동시 병합 5개 테스트가 6초로 기본 5초를 넘었다, #122).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUlidGenerator } from '@bive/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGitRunner, GitCommandError, type GitRunner } from '../src/git/git-exec.js';
import {
  createWorktreeManager,
  GitWorktreeError,
  type MergeCheck,
  type RunGitRef,
  type WorktreeManager,
} from '../src/git/worktree-manager.js';
import { REPO_ROOT } from './helpers/process.js';

const FIXTURE_REL = 'fixtures/sample-next-app';
const USER = ['-c', 'user.name=사용자', '-c', 'user.email=user@example.com'];
const newId = createUlidGenerator();

/** 사람(사용자) 쪽 git. 훅 · fsmonitor는 끈다(그 시험은 BIVE 쪽만 본다). */
const userGit = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [...USER, '-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

const temps: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(
    path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', prefix),
  );
  temps.push(dir);
  return dir;
};

/** 픽스처 추적 파일만 복사하고 `main`에 첫 커밋을 만든다 (scripts/reset-fixture.sh와 같은 내용, 설치 제외). */
const copyFixture = (): string => {
  const repo = path.join(tempDir('fx.'), 'sample-next-app');
  const files = execFileSync('git', ['ls-files', '-z', '--', FIXTURE_REL], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((f) => f !== '');
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const target = path.join(repo, path.relative(FIXTURE_REL, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, file), target);
  }
  userGit(repo, 'init', '-q', '-b', 'main');
  userGit(repo, 'add', '--all');
  userGit(repo, 'commit', '-q', '-m', 'fixture: initial');
  return repo;
};

const write = (dir: string, rel: string, content: string): void => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};
const read = (dir: string, rel: string): string => fs.readFileSync(path.join(dir, rel), 'utf8');

const tip = (repo: string, branch = 'main'): string =>
  userGit(repo, 'rev-parse', `refs/heads/${branch}`);
const runBranches = (repo: string): string[] =>
  userGit(repo, 'branch', '--list', 'bive/run-*', '--format=%(refname:short)')
    .split('\n')
    .filter((b) => b !== '');
const parents = (repo: string, commit: string): string[] =>
  userGit(repo, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);
const countCommits = (repo: string, range: string): number =>
  Number(userGit(repo, 'rev-list', '--count', range));
/** 등록된 워크트리 수 (폴더가 지워진 등록 포함). */
const worktreeCount = (repo: string): number =>
  userGit(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree ')).length;
const registeredWorktrees = (repo: string): string[] =>
  userGit(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => fs.realpathSync(line.slice('worktree '.length)));

/** 양쪽이 같은 줄을 다르게 고치는 기존 파일 (충돌 시험용). */
const SHARED_FILE = 'src/lib/db.ts';

let biveHome: string;
let repo: string;
let projectId: string;
let manager: WorktreeManager;

beforeEach(() => {
  biveHome = tempDir('bh.');
  repo = copyFixture();
  projectId = newId();
  manager = createWorktreeManager({ biveHome });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** git 명령을 여러 번 띄우는 테스트의 제한 (#122). */
const GIT_TEST_OPTIONS = { timeout: 30_000 };

const createRun = (runDisplayId = 'EXE-001'): Promise<RunGitRef> =>
  manager.create({ projectId, runDisplayId, repoPath: repo, baseBranch: 'main' });

/** 실행 워크트리에 파일을 쓰고(에이전트 대신) 오케스트레이터 커밋을 만든다. */
const agentChange = async (run: RunGitRef, rel: string, content: string): Promise<string> => {
  write(run.worktreePath, rel, content);
  const result = await manager.commit(run, `구현 단계 ${rel}`);
  expect(result.created).toBe(true);
  return result.commit;
};

/** 사용자가 프로젝트 폴더의 현재 브랜치에 커밋한다. 새 커밋을 돌려준다. */
const userCommit = (rel: string, content: string): string => {
  write(repo, rel, content);
  userGit(repo, 'add', '--all');
  userGit(repo, 'commit', '-q', '-m', `사용자 변경 ${rel}`);
  return userGit(repo, 'rev-parse', 'HEAD');
};

const passCheck: MergeCheck = () => Promise.resolve({ passed: true });

/** 남은 병합 검사용 임시 워크트리 폴더 (`merges/` 아래, 없으면 빈 목록). */
const mergeLeftovers = (): string[] => {
  const dir = path.join(biveHome, 'work', projectId, 'merges');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** `ms` 안에 끝나면 `true`. 끝나지 않은 약속은 그대로 둔다. */
const settlesWithin = (promise: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    sleep(ms).then(() => false),
  ]);

/** 실제 git을 쓰되, `match`에 맞는 첫 호출의 앞 · 뒤에 사용자 동작을 끼운다(경합 순간을 결정적으로 만든다). */
const hookGit = (
  match: (args: readonly string[]) => boolean,
  hooks: { before?: () => unknown; after?: () => unknown },
): GitRunner => {
  const real = createGitRunner();
  let fired = false;
  return async (args, options) => {
    if (fired || !match(args)) return real(args, options);
    fired = true;
    hooks.before?.();
    const result = await real(args, options);
    hooks.after?.();
    return result;
  };
};

/**
 * `git worktree add`가 관리 폴더를 만든 뒤 `commondir`을 쓰기 전의 상태(빈 `commondir`)를 만든다. 이 상태에서는 같은
 * 저장소의 `worktree list` · `add` · `lock`이 종료 코드 128로 실패한다(git 2.43 확인).
 */
const plantHalfCreatedWorktree = (name: string): string => {
  const admin = path.join(repo, '.git', 'worktrees', name);
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(admin, 'locked'), 'initializing');
  fs.writeFileSync(path.join(admin, 'gitdir'), `${path.join(tempDir('half.'), name, '.git')}\n`);
  fs.writeFileSync(path.join(admin, 'commondir'), '');
  return admin;
};

describe('실행 브랜치 · 워크트리 생성', GIT_TEST_OPTIONS, () => {
  it('실행마다 bive/run-<EXE-ID> 브랜치와 $BIVE_HOME/work/<projectId>/worktrees/<EXE-ID> 워크트리를 만든다', async () => {
    const base = tip(repo);
    const first = await createRun('EXE-001');
    const second = await createRun('EXE-002');

    expect(first.branch).toBe('bive/run-EXE-001');
    expect(second.branch).toBe('bive/run-EXE-002');
    expect(first.worktreePath).toBe(path.join(biveHome, 'work', projectId, 'worktrees', 'EXE-001'));
    expect(second.worktreePath).toBe(
      path.join(biveHome, 'work', projectId, 'worktrees', 'EXE-002'),
    );
    expect(first.baseCommit).toBe(base);
    expect(first.repoPath).toBe(fs.realpathSync(repo));
    expect(runBranches(repo)).toEqual(['bive/run-EXE-001', 'bive/run-EXE-002']);

    for (const run of [first, second]) {
      expect(userGit(run.worktreePath, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${run.branch}`);
      expect(read(run.worktreePath, 'package.json')).toBe(read(repo, 'package.json'));
      expect(registeredWorktrees(repo)).toContain(fs.realpathSync(run.worktreePath));
      // 생성은 커밋을 만들지 않는다
      expect(tip(repo, run.branch)).toBe(base);
    }
    // 프로젝트 폴더 · 기준 브랜치는 그대로
    expect(tip(repo)).toBe(base);
    expect(userGit(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(userGit(repo, 'status', '--porcelain')).toBe('');
  });

  it('같은 실행 ID를 다시 만들거나 형식이 틀린 입력은 거부한다', async () => {
    await createRun('EXE-001');
    await expect(createRun('EXE-001')).rejects.toMatchObject({ code: 'branch_exists' });
    await expect(createRun('RUN-001')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(createRun('EXE-1')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      manager.create({
        projectId: '../x',
        runDisplayId: 'EXE-003',
        repoPath: repo,
        baseBranch: 'main',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      manager.create({
        projectId,
        runDisplayId: 'EXE-003',
        repoPath: repo,
        baseBranch: '--orphan',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      manager.create({ projectId, runDisplayId: 'EXE-003', repoPath: repo, baseBranch: 'develop' }),
    ).rejects.toMatchObject({ code: 'base_branch_missing' });
    // 거부된 시도는 브랜치를 남기지 않는다
    expect(runBranches(repo)).toEqual(['bive/run-EXE-001']);
  });

  it('워크트리 폴더가 이미 있으면 브랜치를 만들지 않는다', async () => {
    fs.mkdirSync(path.join(biveHome, 'work', projectId, 'worktrees', 'EXE-001'), {
      recursive: true,
    });
    await expect(createRun('EXE-001')).rejects.toMatchObject({ code: 'worktree_exists' });
    expect(runBranches(repo)).toEqual([]);
  });

  it('git 저장소가 아니거나 저장소 최상위가 아닌 폴더는 거부한다', async () => {
    const plain = tempDir('plain.');
    await expect(
      manager.create({ projectId, runDisplayId: 'EXE-001', repoPath: plain, baseBranch: 'main' }),
    ).rejects.toMatchObject({ code: 'not_a_repository' });
    await expect(
      manager.create({
        projectId,
        runDisplayId: 'EXE-001',
        repoPath: path.join(repo, 'src'),
        baseBranch: 'main',
      }),
    ).rejects.toBeInstanceOf(GitWorktreeError);
    await expect(
      manager.create({
        projectId,
        runDisplayId: 'EXE-001',
        repoPath: path.join(repo, 'src'),
        baseBranch: 'main',
      }),
    ).rejects.toMatchObject({ code: 'not_repo_root' });
    expect(runBranches(repo)).toEqual([]);
  });
});

describe('커밋은 오케스트레이터 함수로만', GIT_TEST_OPTIONS, () => {
  it('워크트리 파일 변경만으로는 커밋이 생기지 않고 commit()이 BIVE 주체로 만든다', async () => {
    const run = await createRun();
    write(run.worktreePath, 'src/lib/added.ts', 'export const added = 1;\n');
    fs.rmSync(path.join(run.worktreePath, 'src/app/page.tsx'));
    expect(countCommits(repo, `${run.baseCommit}..${run.branch}`)).toBe(0);

    const result = await manager.commit(run, '테스트 작성 단계');
    expect(result.created).toBe(true);
    expect(countCommits(repo, `${run.baseCommit}..${run.branch}`)).toBe(1);
    expect(tip(repo, run.branch)).toBe(result.commit);
    expect(userGit(repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', run.branch)).toBe(
      'BIVE <bive@bive.invalid>|BIVE <bive@bive.invalid>|테스트 작성 단계',
    );
    expect(userGit(repo, 'show', '--name-status', '--format=', run.branch).split('\n')).toEqual([
      'D\tsrc/app/page.tsx',
      'A\tsrc/lib/added.ts',
    ]);
    expect(userGit(run.worktreePath, 'status', '--porcelain')).toBe('');

    // 바뀐 것이 없으면 커밋하지 않는다
    const again = await manager.commit(run, '구현 단계');
    expect(again).toEqual({ commit: result.commit, created: false });
    expect(countCommits(repo, `${run.baseCommit}..${run.branch}`)).toBe(1);
    // 기준 브랜치는 그대로
    expect(tip(repo)).toBe(run.baseCommit);
  });

  it('부모 환경의 git 변수 · 프로젝트 훅 · fsmonitor 스크립트가 커밋 주체 · 결과를 바꾸지 못한다', async () => {
    const hooks = path.join(repo, '.git', 'hooks');
    const marker = path.join(tempDir('hook.'), 'ran');
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout', 'post-merge']) {
      fs.writeFileSync(path.join(hooks, hook), `#!/bin/sh\necho ${hook} >> "${marker}"\nexit 1\n`, {
        mode: 0o755,
      });
    }
    const fsmonitor = path.join(repo, '.git', 'fsmonitor.sh');
    fs.writeFileSync(fsmonitor, `#!/bin/sh\necho fsmonitor >> "${marker}"\nexit 1\n`, {
      mode: 0o755,
    });
    userGit(repo, 'config', 'core.fsmonitor', fsmonitor);
    manager = createWorktreeManager({
      biveHome,
      git: createGitRunner({
        baseEnv: {
          ...process.env,
          GIT_AUTHOR_NAME: '침입자',
          GIT_AUTHOR_EMAIL: 'x@example.com',
          GIT_COMMITTER_NAME: '침입자',
          GIT_DIR: path.join(tempDir('gd.'), 'nope'),
          ANTHROPIC_API_KEY: 'secret',
        },
      }),
    });
    const run = await createRun();
    await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    const result = await manager.merge(run, { check: passCheck });

    expect(result.status).toBe('merged');
    expect(fs.existsSync(marker)).toBe(false);
    for (const ref of ['main', run.branch]) {
      expect(userGit(repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', ref)).toBe(
        'BIVE <bive@bive.invalid>|BIVE <bive@bive.invalid>',
      );
    }
  });

  it('참조가 규칙과 다르거나 메시지가 비면 거부한다', async () => {
    const run = await createRun();
    await expect(manager.commit(run, '  ')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(manager.commit({ ...run, branch: 'main' }, '단계')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(manager.commit({ ...run, worktreePath: repo }, '단계')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(tip(repo)).toBe(run.baseCommit);
  });
});

describe('merge(run)', GIT_TEST_OPTIONS, () => {
  it('기준 브랜치가 그대로면 검사 없이 --no-ff 병합 커밋을 만들고 프로젝트 폴더를 갱신한다', async () => {
    const run = await createRun();
    const head = await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    const check = vi.fn(passCheck);

    const result = await manager.merge(run, { check });

    expect(check).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'merged',
      previousBaseCommit: run.baseCommit,
      headCommit: head,
      rechecked: false,
      baseUpdate: 'checkout_fast_forward',
    });
    if (result.status !== 'merged') throw new Error('merged가 아님');
    expect(tip(repo)).toBe(result.mergeCommit);
    // fast-forward가 아니라 부모 2개인 병합 커밋
    expect(parents(repo, result.mergeCommit)).toEqual([run.baseCommit, head]);
    expect(userGit(repo, 'log', '-1', '--format=%s', 'main')).toBe('BIVE 실행 EXE-001 병합');
    expect(userGit(repo, 'log', '-1', '--format=%(trailers:key=Bive-Run,valueonly)', 'main')).toBe(
      'EXE-001',
    );
    // 프로젝트 폴더 작업 트리도 따라왔다
    expect(read(repo, 'src/lib/added.ts')).toBe('export const added = 1;\n');
    expect(userGit(repo, 'status', '--porcelain')).toBe('');
    // 실행 브랜치는 남고, 병합용 임시 워크트리는 지워졌다
    expect(runBranches(repo)).toEqual(['bive/run-EXE-001']);
    expect(mergeLeftovers()).toEqual([]);
    expect(registeredWorktrees(repo)).toHaveLength(2);
  });

  it('기준 브랜치가 바뀌었으면 병합 결과로 검사를 다시 돌려 통과할 때만 갱신한다', async () => {
    const run = await createRun();
    const head = await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    write(repo, 'src/lib/user-change.ts', 'export const user = 1;\n');
    userGit(repo, 'add', '--all');
    userGit(repo, 'commit', '-q', '-m', '사용자 변경');
    const userTip = tip(repo);

    const seen: { files: string[]; head: string }[] = [];
    const check = vi.fn<MergeCheck>((context) => {
      seen.push({
        files: ['src/lib/added.ts', 'src/lib/user-change.ts'].filter((f) =>
          fs.existsSync(path.join(context.worktreePath, f)),
        ),
        head: userGit(context.worktreePath, 'rev-parse', 'HEAD'),
      });
      return Promise.resolve({ passed: true });
    });
    const result = await manager.merge(run, { check });

    expect(check).toHaveBeenCalledTimes(1);
    const context = check.mock.calls[0]?.[0];
    expect(context).toMatchObject({ baseCommit: userTip, headCommit: head });
    // 시도마다 다른 임시 워크트리 `merges/<EXE-ID>.<시도 ID>`
    expect(path.dirname(context?.worktreePath ?? '')).toBe(
      path.join(biveHome, 'work', projectId, 'merges'),
    );
    expect(path.basename(context?.worktreePath ?? '')).toMatch(/^EXE-001\.[0-9a-z]+$/u);
    // 검사는 두 변경이 모두 든 병합 커밋에서 돌았다
    expect(seen).toEqual([
      { files: ['src/lib/added.ts', 'src/lib/user-change.ts'], head: context?.mergeCommit },
    ]);
    expect(result).toMatchObject({
      status: 'merged',
      rechecked: true,
      previousBaseCommit: userTip,
    });
    if (result.status !== 'merged') throw new Error('merged가 아님');
    expect(result.mergeCommit).toBe(context?.mergeCommit);
    expect(tip(repo)).toBe(result.mergeCommit);
    expect(parents(repo, result.mergeCommit)).toEqual([userTip, head]);
    expect(read(repo, 'src/lib/added.ts')).toBe('export const added = 1;\n');
    expect(fs.existsSync(context?.worktreePath ?? '')).toBe(false);
  });

  it('바뀐 기준 브랜치에서 검사가 실패하거나 오류면 갱신하지 않고 failed와 사유를 돌려준다', async () => {
    const run = await createRun();
    const head = await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    write(repo, 'src/lib/user-change.ts', 'export const user = 1;\n');
    userGit(repo, 'add', '--all');
    userGit(repo, 'commit', '-q', '-m', '사용자 변경');
    const userTip = tip(repo);

    const failed = await manager.merge(run, {
      check: () => Promise.resolve({ passed: false, detail: '인수 테스트 1개 실패' }),
    });
    expect(failed).toEqual({
      status: 'failed',
      reason: 'check_failed',
      message: '병합 결과 검사가 실패했습니다',
      branch: 'bive/run-EXE-001',
      headCommit: head,
      checkDetail: '인수 테스트 1개 실패',
    });
    expect(tip(repo)).toBe(userTip);

    const errored = await manager.merge(run, {
      check: () => Promise.reject(new Error('러너 기동 실패')),
    });
    expect(errored).toMatchObject({
      status: 'failed',
      reason: 'check_error',
      checkDetail: '러너 기동 실패',
    });
    expect(tip(repo)).toBe(userTip);
    expect(fs.existsSync(path.join(repo, 'src/lib/added.ts'))).toBe(false);
    expect(runBranches(repo)).toEqual(['bive/run-EXE-001']);
    expect(tip(repo, run.branch)).toBe(head);
    expect(mergeLeftovers()).toEqual([]);
  });

  it('충돌이면 병합 없이 사유 · 충돌 파일과 함께 failed를 돌려주고 브랜치를 보존한다', async () => {
    const run = await createRun();
    const head = await agentChange(run, SHARED_FILE, 'export const note = "에이전트";\n');
    write(repo, SHARED_FILE, 'export const note = "사용자";\n');
    userGit(repo, 'add', '--all');
    userGit(repo, 'commit', '-q', '-m', '사용자 변경');
    const userTip = tip(repo);
    const check = vi.fn(passCheck);

    const result = await manager.merge(run, { check });

    expect(result).toEqual({
      status: 'failed',
      reason: 'conflict',
      message: '기준 브랜치와 충돌합니다',
      branch: 'bive/run-EXE-001',
      headCommit: head,
      files: [SHARED_FILE],
    });
    expect(check).not.toHaveBeenCalled();
    expect(tip(repo)).toBe(userTip);
    expect(read(repo, SHARED_FILE)).toBe('export const note = "사용자";\n');
    expect(userGit(repo, 'status', '--porcelain')).toBe('');
    expect(runBranches(repo)).toEqual(['bive/run-EXE-001']);
    expect(tip(repo, run.branch)).toBe(head);
    expect(mergeLeftovers()).toEqual([]);
  });

  it('프로젝트 폴더 추적 파일에 커밋되지 않은 변경이 있으면 병합 없이 failed, 변경은 그대로 둔다', async () => {
    const run = await createRun();
    const head = await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    const original = read(repo, 'package.json');
    write(repo, 'package.json', `${original}\n`);

    const result = await manager.merge(run, { check: passCheck });

    expect(result).toEqual({
      status: 'failed',
      reason: 'project_dirty',
      message: '프로젝트 폴더에 커밋되지 않은 변경이 있습니다',
      branch: 'bive/run-EXE-001',
      headCommit: head,
      files: ['package.json'],
    });
    expect(tip(repo)).toBe(run.baseCommit);
    expect(read(repo, 'package.json')).toBe(`${original}\n`);
    expect(fs.existsSync(path.join(repo, 'src/lib/added.ts'))).toBe(false);
    expect(runBranches(repo)).toEqual(['bive/run-EXE-001']);

    // 스테이지만 한 변경도 더러운 것으로 본다
    userGit(repo, 'add', 'package.json');
    expect(await manager.merge(run, { check: passCheck })).toMatchObject({
      reason: 'project_dirty',
    });
    expect(tip(repo)).toBe(run.baseCommit);
  });

  it('미추적 파일(.bive.json 포함)은 더러운 것으로 보지 않는다', async () => {
    const run = await createRun();
    await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    write(repo, '.bive.json', `${JSON.stringify({ projectId, schemaVersion: 1 }, null, 2)}\n`);
    write(repo, 'notes/memo.txt', '메모\n');

    const result = await manager.merge(run, { check: passCheck });

    expect(result.status).toBe('merged');
    expect(read(repo, '.bive.json')).toContain(projectId);
    expect(read(repo, 'notes/memo.txt')).toBe('메모\n');
    expect(read(repo, 'src/lib/added.ts')).toBe('export const added = 1;\n');
  });

  it('검사 도중 기준 브랜치가 다시 바뀌면 갱신하지 않는다', async () => {
    const run = await createRun();
    await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    write(repo, 'src/lib/user-change.ts', 'export const user = 1;\n');
    userGit(repo, 'add', '--all');
    userGit(repo, 'commit', '-q', '-m', '사용자 변경 1');

    let during = '';
    const result = await manager.merge(run, {
      check: () => {
        write(repo, 'src/lib/user-change-2.ts', 'export const user2 = 1;\n');
        userGit(repo, 'add', '--all');
        userGit(repo, 'commit', '-q', '-m', '사용자 변경 2');
        during = tip(repo);
        return Promise.resolve({ passed: true });
      },
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'base_changed' });
    expect(tip(repo)).toBe(during);
    expect(runBranches(repo)).toEqual(['bive/run-EXE-001']);
  });

  it('기준 브랜치가 프로젝트 폴더에 체크아웃돼 있지 않으면 참조만 갱신하고 작업 트리는 건드리지 않는다', async () => {
    const run = await createRun();
    const head = await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    userGit(repo, 'checkout', '-q', '-b', 'feature/user');

    const result = await manager.merge(run, { check: passCheck });

    expect(result).toMatchObject({ status: 'merged', baseUpdate: 'update_ref', rechecked: false });
    if (result.status !== 'merged') throw new Error('merged가 아님');
    expect(tip(repo)).toBe(result.mergeCommit);
    expect(parents(repo, result.mergeCommit)).toEqual([run.baseCommit, head]);
    expect(userGit(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature/user');
    expect(fs.existsSync(path.join(repo, 'src/lib/added.ts'))).toBe(false);
  });

  it('기준 브랜치가 다른 워크트리에 체크아웃돼 있으면 failed', async () => {
    const run = await createRun();
    await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    userGit(repo, 'checkout', '-q', '-b', 'feature/user');
    const other = path.join(tempDir('ow.'), 'main-wt');
    userGit(repo, 'worktree', 'add', '-q', other, 'main');

    const result = await manager.merge(run, { check: passCheck });

    expect(result).toMatchObject({ status: 'failed', reason: 'base_checked_out_elsewhere' });
    expect(tip(repo)).toBe(run.baseCommit);
  });

  it('병합할 커밋이 없거나 실행 워크트리에 커밋되지 않은 변경이 있으면 failed', async () => {
    const run = await createRun();
    expect(await manager.merge(run, { check: passCheck })).toMatchObject({
      status: 'failed',
      reason: 'no_changes',
      headCommit: run.baseCommit,
    });

    await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    write(run.worktreePath, 'src/lib/added.ts', 'export const added = 2;\n');
    expect(await manager.merge(run, { check: passCheck })).toMatchObject({
      status: 'failed',
      reason: 'run_worktree_dirty',
      files: ['src/lib/added.ts'],
    });
    expect(tip(repo)).toBe(run.baseCommit);
  });

  it('검사 도중 사용자가 기준 브랜치에서 다른 브랜치로 옮기면 참조만 갱신하고 그 브랜치는 건드리지 않는다', async () => {
    const run = await createRun();
    const head = await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    const userTip = userCommit('src/lib/user-change.ts', 'export const user = 1;\n');

    const result = await manager.merge(run, {
      check: () => {
        userGit(repo, 'checkout', '-q', '-b', 'feature/x');
        return Promise.resolve({ passed: true });
      },
    });

    expect(result).toMatchObject({ status: 'merged', rechecked: true, baseUpdate: 'update_ref' });
    if (result.status !== 'merged') throw new Error('merged가 아님');
    expect(tip(repo)).toBe(result.mergeCommit);
    expect(parents(repo, result.mergeCommit)).toEqual([userTip, head]);
    // 사용자가 옮겨 간 브랜치 · 작업 트리는 그대로
    expect(tip(repo, 'feature/x')).toBe(userTip);
    expect(userGit(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature/x');
    expect(fs.existsSync(path.join(repo, 'src/lib/added.ts'))).toBe(false);
    expect(userGit(repo, 'status', '--porcelain')).toBe('');
  });

  it('검사 도중 사용자가 기준 브랜치를 체크아웃하면 fast-forward로 작업 트리까지 갱신한다', async () => {
    const run = await createRun();
    const head = await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    const userTip = userCommit('src/lib/user-change.ts', 'export const user = 1;\n');
    userGit(repo, 'checkout', '-q', '-b', 'feature/y');

    const result = await manager.merge(run, {
      check: () => {
        userGit(repo, 'checkout', '-q', 'main');
        return Promise.resolve({ passed: true });
      },
    });

    expect(result).toMatchObject({
      status: 'merged',
      rechecked: true,
      baseUpdate: 'checkout_fast_forward',
    });
    if (result.status !== 'merged') throw new Error('merged가 아님');
    expect(tip(repo)).toBe(result.mergeCommit);
    expect(parents(repo, result.mergeCommit)).toEqual([userTip, head]);
    expect(userGit(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    // 참조만 옮겨 작업 트리 · 색인이 낡는 일이 없다
    expect(read(repo, 'src/lib/added.ts')).toBe('export const added = 1;\n');
    expect(userGit(repo, 'status', '--porcelain')).toBe('');
  });

  it('검사 도중 기준 브랜치가 다른 워크트리에 체크아웃되면 failed', async () => {
    const run = await createRun();
    await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    const userTip = userCommit('src/lib/user-change.ts', 'export const user = 1;\n');
    userGit(repo, 'checkout', '-q', '-b', 'feature/z');
    const other = path.join(tempDir('ow.'), 'main-wt');

    const result = await manager.merge(run, {
      check: () => {
        userGit(repo, 'worktree', 'add', '-q', other, 'main');
        return Promise.resolve({ passed: true });
      },
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'base_checked_out_elsewhere' });
    expect(tip(repo)).toBe(userTip);
    expect(userGit(other, 'status', '--porcelain')).toBe('');
  });

  /** 에이전트가 `.gitignore`의 `*.db`를 지우고 로컬 DB 자리에 파일을 추적시킨다 (파일 도구로 가능하다). */
  const trackIgnoredDb = async (run: RunGitRef): Promise<void> => {
    write(
      run.worktreePath,
      '.gitignore',
      read(run.worktreePath, '.gitignore').replace(/^\*\.db\n/mu, ''),
    );
    write(run.worktreePath, 'prisma/dev.db', '에이전트가 만든 DB');
    const head = await manager.commit(run, '구현 단계');
    expect(userGit(repo, 'show', '--name-only', '--format=', head.commit).split('\n')).toContain(
      'prisma/dev.db',
    );
  };

  it('기준 브랜치에서 무시되던 경로(로컬 DB)를 새로 추적하면 병합하지 않고 사유 · 파일과 함께 failed', async () => {
    write(repo, 'prisma/dev.db', '사용자 로컬 DB 원본');
    expect(userGit(repo, 'check-ignore', 'prisma/dev.db')).toBe('prisma/dev.db');
    const run = await createRun();
    await trackIgnoredDb(run);
    const check = vi.fn(passCheck);

    const result = await manager.merge(run, { check });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'ignored_path_tracked',
      files: ['prisma/dev.db'],
    });
    expect(check).not.toHaveBeenCalled();
    expect(read(repo, 'prisma/dev.db')).toBe('사용자 로컬 DB 원본');
    expect(tip(repo)).toBe(run.baseCommit);
    expect(runBranches(repo)).toEqual(['bive/run-EXE-001']);
    expect(mergeLeftovers()).toEqual([]);
  });

  it('기준 브랜치가 체크아웃돼 있지 않아도(참조 갱신 경로) 무시되던 경로의 새 추적은 병합하지 않아 나중 체크아웃이 로컬 파일을 바꾸지 않는다', async () => {
    write(repo, 'prisma/dev.db', '사용자 로컬 DB 원본');
    const run = await createRun();
    await trackIgnoredDb(run);
    userGit(repo, 'checkout', '-q', '-b', 'feature/user');

    const result = await manager.merge(run, { check: passCheck });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'ignored_path_tracked',
      files: ['prisma/dev.db'],
    });
    expect(tip(repo)).toBe(run.baseCommit);
    userGit(repo, 'checkout', '-q', 'main');
    expect(read(repo, 'prisma/dev.db')).toBe('사용자 로컬 DB 원본');
  });

  it('프로젝트 폴더가 그 경로를 무시하지 않는 브랜치에 있어도 기준 브랜치 끝의 무시 규칙으로 막는다', async () => {
    const run = await createRun();
    await trackIgnoredDb(run);
    // 사용자는 `*.db`를 무시하지 않는 브랜치에 있다: 프로젝트 폴더 규칙으로는 걸리지 않는다
    userGit(repo, 'checkout', '-q', '-b', 'feature/no-db-ignore');
    write(repo, '.gitignore', read(repo, '.gitignore').replace(/^\*\.db\n/mu, ''));
    userGit(repo, 'commit', '-q', '-am', '사용자: *.db 무시 해제');
    expect(() => userGit(repo, 'check-ignore', '--no-index', 'prisma/dev.db')).toThrow();

    const result = await manager.merge(run, { check: passCheck });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'ignored_path_tracked',
      files: ['prisma/dev.db'],
    });
    expect(tip(repo)).toBe(run.baseCommit);
    expect(mergeLeftovers()).toEqual([]);
  });

  it('프로젝트 폴더의 미추적 .gitignore가 무시하는 경로를 새로 추적해도 failed (지금 작업 트리 규칙도 본다)', async () => {
    write(repo, 'local/.gitignore', 'secret.txt\n');
    write(repo, 'local/secret.txt', '사용자 비밀\n');
    const run = await createRun();
    await agentChange(run, 'local/secret.txt', '에이전트 파일\n');

    const result = await manager.merge(run, { check: passCheck });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'ignored_path_tracked',
      files: ['local/secret.txt'],
    });
    expect(read(repo, 'local/secret.txt')).toBe('사용자 비밀\n');
    expect(tip(repo)).toBe(run.baseCommit);
  });

  it('덮어쓸 미추적 파일이 있으면 failed (base_update_failed)', async () => {
    write(repo, 'notes/memo.txt', '사용자 메모\n');
    const run = await createRun();
    await agentChange(run, 'notes/memo.txt', '에이전트 메모\n');

    const result = await manager.merge(run, { check: passCheck });

    expect(result).toMatchObject({ status: 'failed', reason: 'base_update_failed' });
    expect(read(repo, 'notes/memo.txt')).toBe('사용자 메모\n');
    expect(tip(repo)).toBe(run.baseCommit);
  });

  it('기준 브랜치가 체크아웃돼 있지 않아도 프로젝트 폴더가 더러우면 failed', async () => {
    const run = await createRun();
    await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    userGit(repo, 'checkout', '-q', '-b', 'feature/user');
    write(repo, 'package.json', `${read(repo, 'package.json')}\n`);

    const result = await manager.merge(run, { check: passCheck });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'project_dirty',
      files: ['package.json'],
    });
    expect(tip(repo)).toBe(run.baseCommit);
  });

  it('git 명령이 실패하면 git_error로 돌려주고 기준 브랜치 · 실행 브랜치는 그대로', async () => {
    const real = createGitRunner();
    const failing: GitRunner = (args, options) =>
      args[0] === 'merge-tree'
        ? Promise.reject(new GitCommandError(args, { stdout: '', stderr: '손상', code: 128 }))
        : real(args, options);
    const run = await createRun();
    const head = await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');

    const result = await createWorktreeManager({ biveHome, git: failing }).merge(run, {
      check: passCheck,
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'git_error', headCommit: head });
    expect(tip(repo)).toBe(run.baseCommit);
    expect(tip(repo, run.branch)).toBe(head);
  });

  it('지난 병합이 남긴 임시 워크트리 등록(잠김 · 폴더 삭제)이 있어도 병합한다', async () => {
    const run = await createRun();
    await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    const leftover = path.join(biveHome, 'work', projectId, 'merges', 'EXE-001');
    fs.mkdirSync(path.dirname(leftover), { recursive: true });
    userGit(repo, 'worktree', 'add', '-q', '--detach', leftover, 'main');
    userGit(repo, 'worktree', 'lock', '--reason', 'initializing', leftover);
    fs.rmSync(leftover, { recursive: true, force: true });

    const result = await manager.merge(run, { check: passCheck });

    expect(result.status).toBe('merged');
    expect(worktreeCount(repo)).toBe(2);
  });

  it('같은 저장소의 병합 5개를 동시에 불러도 차례로 처리해 프로젝트 폴더 색인 · 작업 트리가 깨끗하다', async () => {
    const runs: RunGitRef[] = [];
    for (let i = 0; i < 5; i += 1) {
      const run = await createRun(`EXE-00${String(i + 1)}`);
      await agentChange(
        run,
        `src/lib/f${String(i)}.ts`,
        `export const v${String(i)} = ${String(i)};\n`,
      );
      runs.push(run);
    }
    const check = vi.fn(passCheck);
    // 관리자 인스턴스가 달라도 같은 대기열을 쓴다
    const managers = [manager, createWorktreeManager({ biveHome })];

    const results = await Promise.all(
      runs.map((run, i) => (managers[i % 2] ?? manager).merge(run, { check })),
    );

    // 첫 병합 뒤 나머지는 기준 브랜치가 바뀐 경로(ADR-017 재검사)로 병합된다
    expect(results.map((r) => r.status)).toEqual(Array(5).fill('merged'));
    expect(results.filter((r) => r.status === 'merged' && r.rechecked)).toHaveLength(4);
    expect(check).toHaveBeenCalledTimes(4);
    expect(userGit(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    const inTip = userGit(repo, 'ls-tree', '-r', '--name-only', 'main', 'src/lib').split('\n');
    for (let i = 0; i < 5; i += 1) {
      const file = `src/lib/f${String(i)}.ts`;
      expect(inTip).toContain(file);
      expect(read(repo, file)).toBe(`export const v${String(i)} = ${String(i)};\n`);
    }
    expect(worktreeCount(repo)).toBe(6);
  });

  it('HEAD 확인과 fast-forward 사이에 브랜치가 바뀌면 옮겨진 브랜치와 이전 커밋을 결과에 담는다', async () => {
    const run = await createRun();
    await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    const real = createGitRunner();
    let fired = false;
    // 확인 뒤 · fast-forward 직전에 사용자가 다른 브랜치로 옮기는 순간을 결정적으로 만든다
    const racing: GitRunner = (args, options) => {
      if (!fired && args[0] === 'merge' && args.includes('--ff-only')) {
        fired = true;
        userGit(repo, 'checkout', '-q', '-b', 'feature/other');
      }
      return real(args, options);
    };

    const result = await createWorktreeManager({ biveHome, git: racing }).merge(run, {
      check: passCheck,
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'base_update_failed' });
    if (result.status !== 'failed') throw new Error('failed가 아님');
    const moved = tip(repo, 'feature/other');
    expect(result.movedRef).toEqual({
      ref: 'refs/heads/feature/other',
      previousCommit: run.baseCommit,
      commit: moved,
    });
    expect(result.message).toContain('refs/heads/feature/other');
    expect(tip(repo)).toBe(run.baseCommit);
  });

  it('참조 갱신 직전에 사용자가 기준 브랜치를 체크아웃하면(색인이 낡음) 갱신을 되돌리고 base_update_failed', async () => {
    const run = await createRun();
    await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    userGit(repo, 'checkout', '-q', '-b', 'feature/user');
    // 재확인(worktree list: 체크아웃 없음) 뒤 · update-ref 직전에 사용자가 기준 브랜치를 체크아웃하는 순간을 결정적으로 만든다
    const racing = hookGit((args) => args[0] === 'update-ref', {
      before: () => userGit(repo, 'checkout', '-q', 'main'),
    });

    const result = await createWorktreeManager({ biveHome, git: racing }).merge(run, {
      check: passCheck,
    });

    expect(result).toMatchObject({ status: 'failed', reason: 'base_update_failed' });
    if (result.status !== 'failed') throw new Error('failed가 아님');
    expect(result.message).toContain('되돌렸습니다');
    expect(tip(repo)).toBe(run.baseCommit);
    expect(userGit(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    // 되돌렸으므로 색인 · 작업 트리 · 참조가 다시 같다 (병합 파일이 삭제 스테이지로 보이지 않는다)
    expect(userGit(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(fs.existsSync(path.join(repo, 'src/lib/added.ts'))).toBe(false);
    expect(userGit(repo, 'reflog', '-1', '--format=%gs', 'refs/heads/main')).toBe(
      'bive: EXE-001 병합 되돌림',
    );
  });

  it('참조 갱신 직후에 체크아웃했으면 색인이 병합 커밋과 같아 그대로 merged', async () => {
    const run = await createRun();
    await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    userGit(repo, 'checkout', '-q', '-b', 'feature/user');
    const racing = hookGit((args) => args[0] === 'update-ref', {
      after: () => userGit(repo, 'checkout', '-q', 'main'),
    });

    const result = await createWorktreeManager({ biveHome, git: racing }).merge(run, {
      check: passCheck,
    });

    expect(result).toMatchObject({ status: 'merged', baseUpdate: 'update_ref' });
    if (result.status !== 'merged') throw new Error('merged가 아님');
    expect(tip(repo)).toBe(result.mergeCommit);
    expect(userGit(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(read(repo, 'src/lib/added.ts')).toBe('export const added = 1;\n');
  });

  it('동시 병합 중 하나의 검사가 예외여도 나머지는 merged이고 프로젝트 폴더가 깨끗하다', async () => {
    const runs: RunGitRef[] = [];
    for (let i = 0; i < 4; i += 1) {
      const run = await createRun(`EXE-00${String(i + 1)}`);
      await agentChange(run, `src/lib/f${String(i)}.ts`, `export const v${String(i)} = 1;\n`);
      runs.push(run);
    }
    // 모두 재검사 경로를 타게 기준 브랜치를 바꾼다
    userCommit('src/lib/user-change.ts', 'export const user = 1;\n');
    const failing = 1;

    const results = await Promise.all(
      runs.map((run, i) =>
        manager.merge(run, {
          check: i === failing ? () => Promise.reject(new Error('러너 기동 실패')) : passCheck,
        }),
      ),
    );

    expect(results.map((r) => (r.status === 'merged' ? 'merged' : r.reason))).toEqual([
      'merged',
      'check_error',
      'merged',
      'merged',
    ]);
    expect(userGit(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    const inTip = userGit(repo, 'ls-tree', '-r', '--name-only', 'main', 'src/lib').split('\n');
    for (let i = 0; i < 4; i += 1) {
      const file = `src/lib/f${String(i)}.ts`;
      expect(inTip.includes(file)).toBe(i !== failing);
      expect(fs.existsSync(path.join(repo, file))).toBe(i !== failing);
    }
    expect(fs.readdirSync(path.join(biveHome, 'work', projectId, 'merges'))).toEqual([]);
    expect(worktreeCount(repo)).toBe(5);
  });
});

describe('preserve(run)', GIT_TEST_OPTIONS, () => {
  it('브랜치 · 워크트리를 남기고 기준 브랜치는 그대로 둔다', async () => {
    const run = await createRun();
    const head = await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    // 커밋되지 않은 작업도 워크트리에 그대로 남는다
    write(run.worktreePath, 'src/lib/partial.ts', 'export const partial = 1;\n');

    const result = await manager.preserve(run);

    expect(result).toEqual({
      branch: 'bive/run-EXE-001',
      headCommit: head,
      worktreePath: run.worktreePath,
      baseCommit: run.baseCommit,
    });
    expect(runBranches(repo)).toEqual(['bive/run-EXE-001']);
    expect(tip(repo, run.branch)).toBe(head);
    expect(tip(repo)).toBe(run.baseCommit);
    expect(fs.existsSync(path.join(repo, 'src/lib/added.ts'))).toBe(false);
    expect(read(run.worktreePath, 'src/lib/partial.ts')).toBe('export const partial = 1;\n');
    // 잠가서 사람이 실수로 지우지 못한다
    expect(userGit(repo, 'worktree', 'list', '--porcelain', '-z').split('\0')).toContain(
      'locked BIVE 실행 EXE-001 보존',
    );
    // 두 번 불러도 같다
    expect(await manager.preserve(run)).toEqual(result);
  });

  it('removeWorktree는 잠긴 워크트리도 지우지만 브랜치는 남긴다', async () => {
    const run = await createRun();
    const head = await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    await manager.preserve(run);

    await manager.removeWorktree(run);

    expect(fs.existsSync(run.worktreePath)).toBe(false);
    expect(registeredWorktrees(repo)).toEqual([fs.realpathSync(repo)]);
    expect(runBranches(repo)).toEqual(['bive/run-EXE-001']);
    expect(tip(repo, run.branch)).toBe(head);
    expect(await manager.preserve(run)).toMatchObject({ worktreePath: null, headCommit: head });
  });

  it('보존 뒤 $BIVE_HOME 폴더가 지워져도 removeWorktree가 잠긴 등록을 지워 브랜치를 체크아웃할 수 있다', async () => {
    const run = await createRun();
    const head = await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    await manager.preserve(run);
    fs.rmSync(path.join(biveHome, 'work'), { recursive: true, force: true });
    expect(worktreeCount(repo)).toBe(2);
    // 잠긴 등록이 남아 있으면 git이 그 브랜치를 '사용 중'으로 본다
    expect(() => userGit(repo, 'checkout', '-q', run.branch)).toThrow();
    expect(await manager.preserve(run)).toMatchObject({ worktreePath: null, headCommit: head });

    await manager.removeWorktree(run);

    expect(worktreeCount(repo)).toBe(1);
    expect(runBranches(repo)).toEqual(['bive/run-EXE-001']);
    userGit(repo, 'checkout', '-q', run.branch);
    expect(read(repo, 'src/lib/added.ts')).toBe('export const added = 1;\n');
  });

  it('$BIVE_HOME이 심볼릭 링크여도 실경로로 다뤄 폴더가 지워진 뒤 등록을 지운다', async () => {
    const link = path.join(tempDir('ln.'), 'bive-home-link');
    fs.symlinkSync(biveHome, link);
    manager = createWorktreeManager({ biveHome: link });
    const run = await createRun();
    // git이 기록하는 실경로와 같다
    expect(run.worktreePath).toBe(
      path.join(fs.realpathSync(biveHome), 'work', projectId, 'worktrees', 'EXE-001'),
    );
    await agentChange(run, 'src/lib/added.ts', 'export const added = 1;\n');
    // 링크 경로로 적은 참조도 받는다
    const viaLink = {
      ...run,
      worktreePath: path.join(link, 'work', projectId, 'worktrees', 'EXE-001'),
    };
    await manager.preserve(viaLink);
    fs.rmSync(path.join(biveHome, 'work'), { recursive: true, force: true });

    await manager.removeWorktree(viaLink);

    expect(worktreeCount(repo)).toBe(1);
    userGit(repo, 'checkout', '-q', run.branch);
  });

  it('BIVE 경로 자리에 놓인 심볼릭 링크를 따라가 사용자 워크트리를 지우거나 잠그지 않는다', async () => {
    const run1 = await createRun('EXE-001');
    const run2 = await createRun('EXE-002');
    await agentChange(run1, 'src/lib/added.ts', 'export const added = 1;\n');
    const userWorktree = path.join(tempDir('uw.'), 'user-wt');
    userGit(repo, 'worktree', 'add', '-q', '-b', 'user/feature', userWorktree);
    write(userWorktree, 'src/lib/user-wip.ts', '사용자 미커밋 작업\n');
    const slot = path.join(biveHome, 'work', projectId, 'merges', 'EXE-002');
    fs.mkdirSync(path.dirname(slot), { recursive: true });
    fs.symlinkSync(userWorktree, slot);
    const before = worktreeCount(repo);

    // preserve는 남은 임시 병합 워크트리를 먼저 지운다
    await manager.preserve(run2);

    expect(read(userWorktree, 'src/lib/user-wip.ts')).toBe('사용자 미커밋 작업\n');
    expect(worktreeCount(repo)).toBe(before);
    const userRecord = userGit(repo, 'worktree', 'list', '--porcelain', '-z')
      .split('\0\0')
      .find((record) => record.startsWith(`worktree ${fs.realpathSync(userWorktree)}\0`));
    expect(userRecord).toBeDefined();
    expect(userRecord?.split('\0').some((field) => field.startsWith('locked'))).toBe(false);
    // 링크만 지웠다
    expect(fs.existsSync(slot)).toBe(false);
    expect(fs.existsSync(run1.worktreePath)).toBe(true);
  });
});

describe('git worktree 명령 잠금 · create 실패 정리 (ADR-065)', GIT_TEST_OPTIONS, () => {
  it('worktree add가 관리 폴더를 반쯤 만든 동안 같은 저장소의 병합 · 보존은 기다렸다가 성공한다', async () => {
    const a = await createRun('EXE-001');
    await agentChange(a, 'src/lib/a.ts', 'export const a = 1;\n');
    const b = await createRun('EXE-002');
    await agentChange(b, 'src/lib/b.ts', 'export const b = 1;\n');
    const real = createGitRunner();
    let entered = (): void => undefined;
    const inAdd = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // `worktree add -b`가 도는 동안(400ms) 관리 폴더가 반쯤 만들어진 상태를 흉내 낸다
    const slowAdd: GitRunner = async (args, options) => {
      if (args[0] === 'worktree' && args[1] === 'add' && args.includes('-b')) {
        const admin = plantHalfCreatedWorktree('HALF');
        entered();
        await sleep(400);
        fs.rmSync(admin, { recursive: true, force: true });
      }
      return real(args, options);
    };
    const racing = createWorktreeManager({ biveHome, git: slowAdd });

    const creating = racing.create({
      projectId,
      runDisplayId: 'EXE-003',
      repoPath: repo,
      baseBranch: 'main',
    });
    await inAdd;
    const [merged, preserved, created] = await Promise.all([
      racing.merge(a, { check: passCheck }),
      racing.preserve(b),
      creating,
    ]);

    expect(merged).toMatchObject({ status: 'merged' });
    expect(preserved.worktreePath).toBe(b.worktreePath);
    expect(created.branch).toBe('bive/run-EXE-003');
    expect(runBranches(repo)).toEqual(['bive/run-EXE-001', 'bive/run-EXE-002', 'bive/run-EXE-003']);
    expect(userGit(repo, 'status', '--porcelain')).toBe('');
  });

  it('worktree add가 실패하면 방금 만든 브랜치를 지워 같은 실행 ID로 다시 만들 수 있다', async () => {
    // 사용자 git의 `worktree add`가 반쯤 만든 관리 폴더가 남아 있는 동안
    const admin = plantHalfCreatedWorktree('USER');

    await expect(createRun('EXE-001')).rejects.toBeInstanceOf(GitCommandError);

    expect(runBranches(repo)).toEqual([]);
    expect(fs.existsSync(path.join(biveHome, 'work', projectId, 'worktrees', 'EXE-001'))).toBe(
      false,
    );
    fs.rmSync(admin, { recursive: true, force: true });
    const run = await createRun('EXE-001');
    expect(run.branch).toBe('bive/run-EXE-001');
    expect(worktreeCount(repo)).toBe(2);
  });

  it('같은 실행 ID를 동시에 만들면 하나만 만들고 다른 하나는 branch_exists (앞선 쪽 브랜치를 지우지 않는다)', async () => {
    const results = await Promise.allSettled([createRun('EXE-001'), createRun('EXE-001')]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({
      code: 'branch_exists',
    });
    expect(runBranches(repo)).toEqual(['bive/run-EXE-001']);
    const worktree = path.join(biveHome, 'work', projectId, 'worktrees', 'EXE-001');
    expect(userGit(worktree, 'symbolic-ref', 'HEAD')).toBe('refs/heads/bive/run-EXE-001');
  });
});

describe(
  '병합 대기열: 제한 시간 · 중단 · 실행별 보존 · 재진입 · 키 (ADR-065)',
  GIT_TEST_OPTIONS,
  () => {
    /** 실행 n개를 만들고 각각 다른 파일을 커밋한 뒤, 모두 재검사 경로를 타게 기준 브랜치를 바꾼다. */
    const runsOnChangedBase = async (count: number): Promise<RunGitRef[]> => {
      const runs: RunGitRef[] = [];
      for (let i = 1; i <= count; i += 1) {
        const run = await createRun(`EXE-00${String(i)}`);
        await agentChange(run, `src/lib/f${String(i)}.ts`, `export const v${String(i)} = 1;\n`);
        runs.push(run);
      }
      userCommit('src/lib/user-change.ts', 'export const user = 1;\n');
      return runs;
    };

    /** 풀어 줄 때까지 끝나지 않는 검사. 받은 신호를 기록한다. */
    const hangingCheck = (): {
      check: MergeCheck;
      release: () => void;
      signals: AbortSignal[];
    } => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const signals: AbortSignal[] = [];
      return {
        check: async (context) => {
          signals.push(context.signal);
          await gate;
          return { passed: true };
        },
        release,
        signals,
      };
    };

    it('검사가 제한 시간을 넘으면 신호를 중단하고 check_timeout, 기다리던 병합은 이어서 진행한다', async () => {
      const [a, b] = await runsOnChangedBase(2);
      if (a === undefined || b === undefined) throw new Error('실행 없음');
      const baseTip = tip(repo);
      const hung = hangingCheck();

      const [timedOut, next] = await Promise.all([
        manager.merge(a, { check: hung.check, checkTimeoutMs: 300 }),
        manager.merge(b, { check: passCheck }),
      ]);

      expect(timedOut).toMatchObject({ status: 'failed', reason: 'check_timeout' });
      expect(hung.signals).toHaveLength(1);
      expect(hung.signals[0]?.aborted).toBe(true);
      expect(next).toMatchObject({ status: 'merged', previousBaseCommit: baseTip });
      expect(fs.existsSync(path.join(repo, 'src/lib/f1.ts'))).toBe(false);
      expect(read(repo, 'src/lib/f2.ts')).toBe('export const v2 = 1;\n');
      expect(mergeLeftovers()).toEqual([]);
      expect(userGit(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
      hung.release();
    });

    it('대기열에서 기다리거나 검사 중에 중단 신호가 오면 aborted로 끝내고 기준 브랜치를 건드리지 않는다', async () => {
      const [a, b] = await runsOnChangedBase(2);
      if (a === undefined || b === undefined) throw new Error('실행 없음');
      const baseTip = tip(repo);
      const hung = hangingCheck();
      const controllerA = new AbortController();
      const controllerB = new AbortController();

      const first = manager.merge(a, { check: hung.check, signal: controllerA.signal });
      await vi.waitFor(() => {
        expect(hung.signals).toHaveLength(1);
      });
      const queued = manager.merge(b, { check: passCheck, signal: controllerB.signal });
      controllerB.abort();
      // 앞선 병합 검사가 멈춰 있어도 기다리던 쪽은 바로 끝난다
      expect(await settlesWithin(queued, 2000)).toBe(true);
      expect(await queued).toMatchObject({ status: 'failed', reason: 'aborted', headCommit: null });

      controllerA.abort();
      expect(await first).toMatchObject({ status: 'failed', reason: 'aborted' });
      expect(hung.signals[0]?.aborted).toBe(true);
      expect(tip(repo)).toBe(baseTip);
      await expect(manager.merge(b, { check: passCheck, checkTimeoutMs: 0 })).rejects.toMatchObject(
        {
          code: 'invalid_input',
        },
      );
      hung.release();
    });

    it('다른 실행의 병합 검사가 멈춰도 보존 · 워크트리 제거는 기다리지 않고, 같은 저장소 병합은 기다린다', async () => {
      const [a, b, c] = await runsOnChangedBase(3);
      if (a === undefined || b === undefined || c === undefined) throw new Error('실행 없음');
      const hung = hangingCheck();

      const first = manager.merge(a, { check: hung.check });
      await vi.waitFor(() => {
        expect(hung.signals).toHaveLength(1);
      });
      const preserved = manager.preserve(b);
      const merging = manager.merge(c, { check: passCheck });

      expect(await settlesWithin(preserved, 5000)).toBe(true);
      expect((await preserved).worktreePath).toBe(b.worktreePath);
      expect(await settlesWithin(createWorktreeManager({ biveHome }).removeWorktree(b), 5000)).toBe(
        true,
      );
      expect(fs.existsSync(b.worktreePath)).toBe(false);
      expect(await settlesWithin(merging, 300)).toBe(false);

      hung.release();
      expect(await first).toMatchObject({ status: 'merged' });
      expect(await merging).toMatchObject({ status: 'merged' });
      expect(userGit(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    });

    it('검사 함수 안에서 같은 대기열을 잡는 호출은 교착 대신 reentrant_call로 거부된다', async () => {
      const [a, b] = await runsOnChangedBase(2);
      if (a === undefined || b === undefined) throw new Error('실행 없음');
      const inner: unknown[] = [];

      const result = await manager.merge(a, {
        check: async () => {
          // 같은 저장소의 병합 · 같은 실행의 보존 · 제거는 교착이 된다(다른 관리자 인스턴스도 같은 대기열)
          for (const call of [
            () => createWorktreeManager({ biveHome }).merge(b, { check: passCheck }),
            () => manager.preserve(a),
            () => manager.removeWorktree(a),
          ]) {
            inner.push(await call().catch((error: unknown) => error));
          }
          // 다른 실행의 보존은 대기열이 달라 바로 끝난다
          inner.push(await manager.preserve(b));
          return { passed: true };
        },
      });

      expect(inner.slice(0, 3)).toEqual([
        expect.objectContaining({ code: 'reentrant_call' }),
        expect.objectContaining({ code: 'reentrant_call' }),
        expect.objectContaining({ code: 'reentrant_call' }),
      ]);
      expect(inner[3]).toMatchObject({ worktreePath: b.worktreePath });
      expect(result).toMatchObject({ status: 'merged' });
      // 잠금을 푼 뒤에는 같은 호출이 정상이다
      expect(await manager.preserve(a)).toMatchObject({ branch: a.branch });
    });

    it('B의 병합이 대기열에서 기다리는 동안 A의 검사 함수가 preserve(B) · removeWorktree(B)를 불러도 교착하지 않는다', async () => {
      const [a, b] = await runsOnChangedBase(2);
      if (a === undefined || b === undefined) throw new Error('실행 없음');
      let entered = (): void => undefined;
      const inCheck = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let proceed = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      const inner: { preserved: boolean; removed: boolean } = { preserved: false, removed: false };

      const first = manager.merge(a, {
        check: async () => {
          entered();
          await gate;
          // B의 병합은 저장소 병합 잠금을 기다릴 뿐 B의 실행 잠금은 쥐지 않는다
          inner.preserved = await settlesWithin(manager.preserve(b), 5000);
          inner.removed = await settlesWithin(manager.removeWorktree(b), 5000);
          return { passed: true };
        },
      });
      await inCheck;
      const second = manager.merge(b, { check: passCheck });
      await sleep(100);
      proceed();

      expect(await settlesWithin(first, 15000)).toBe(true);
      expect(inner).toEqual({ preserved: true, removed: true });
      expect(await first).toMatchObject({ status: 'merged' });
      expect(await second).toMatchObject({ status: 'merged' });
      expect(fs.existsSync(b.worktreePath)).toBe(false);
      expect(userGit(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    });

    it('제한 시간 뒤에도 도는 이전 검사는 같은 실행의 다음 병합 시도의 임시 워크트리를 건드리지 않는다', async () => {
      const [a] = await runsOnChangedBase(1);
      if (a === undefined) throw new Error('실행 없음');
      let zombieDone = (): void => undefined;
      const zombieFinished = new Promise<void>((resolve) => {
        zombieDone = resolve;
      });
      const first = await manager.merge(a, {
        checkTimeoutMs: 100,
        // 신호를 무시하고 계속 돌다가 자기 임시 워크트리 경로에 쓴다
        check: async (context) => {
          await sleep(600);
          fs.mkdirSync(context.worktreePath, { recursive: true });
          fs.writeFileSync(path.join(context.worktreePath, 'ZOMBIE'), '이전 검사');
          zombieDone();
          return { passed: false };
        },
      });
      expect(first).toMatchObject({ status: 'failed', reason: 'check_timeout' });

      let seen: boolean | null = null;
      const second = await manager.merge(a, {
        check: async (context) => {
          await zombieFinished;
          seen = fs.existsSync(path.join(context.worktreePath, 'ZOMBIE'));
          return { passed: true };
        },
      });

      expect(seen).toBe(false);
      expect(second).toMatchObject({ status: 'merged' });
      expect(fs.existsSync(path.join(repo, 'ZOMBIE'))).toBe(false);
      // 이전 검사가 다시 만든 폴더(등록 없음)는 다음 병합 · 보존이 지운다
      await manager.preserve(a);
      expect(mergeLeftovers()).toEqual([]);
    });

    it('같은 저장소를 다른 경로(같은 저장소의 다른 워크트리)로 연 병합도 같은 대기열을 쓴다', async () => {
      const [a] = await runsOnChangedBase(1);
      if (a === undefined) throw new Error('실행 없음');
      // 같은 저장소의 사용자 워크트리를 다른 프로젝트 폴더로 연다(공통 git 폴더가 같다)
      const other = path.join(tempDir('ow.'), 'other-wt');
      userGit(repo, 'worktree', 'add', '-q', '-b', 'release', other, 'main');
      const otherProject = newId();
      const otherRun = await manager.create({
        projectId: otherProject,
        runDisplayId: 'EXE-101',
        repoPath: other,
        baseBranch: 'release',
      });
      await agentChange(otherRun, 'src/lib/release.ts', 'export const r = 1;\n');
      userGit(other, 'commit', '-q', '--allow-empty', '-m', '릴리스 변경');
      const hung = hangingCheck();

      const first = manager.merge(a, { check: hung.check });
      await vi.waitFor(() => {
        expect(hung.signals).toHaveLength(1);
      });
      const second = manager.merge(otherRun, { check: passCheck });

      expect(await settlesWithin(second, 500)).toBe(false);
      hung.release();
      expect(await first).toMatchObject({ status: 'merged' });
      expect(await second).toMatchObject({ status: 'merged' });
      expect(userGit(other, 'status', '--porcelain')).toBe('');
    });
  },
);
