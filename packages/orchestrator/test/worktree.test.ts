// git 브랜치 · 워크트리 · 병합 관리자 (M1-13, RUN-08 · ADR-017 · ADR-025 · ADR-058).
// 픽스처(fixtures/sample-next-app)의 추적 파일을 임시 폴더에 복사해 실제 git 저장소로 단언한다.
// 의존성 설치는 하지 않는다(git 동작만 본다). 검사 함수는 테스트가 주입하는 가짜다.
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

describe('실행 브랜치 · 워크트리 생성', () => {
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

describe('커밋은 오케스트레이터 함수로만', () => {
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

describe('merge(run)', () => {
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
    expect(fs.existsSync(path.join(biveHome, 'work', projectId, 'merges', 'EXE-001'))).toBe(false);
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
    expect(context?.worktreePath).toBe(path.join(biveHome, 'work', projectId, 'merges', 'EXE-001'));
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
    expect(fs.existsSync(path.join(biveHome, 'work', projectId, 'merges', 'EXE-001'))).toBe(false);
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
    expect(fs.existsSync(path.join(biveHome, 'work', projectId, 'merges', 'EXE-001'))).toBe(false);
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

  it('프로젝트 폴더의 무시된 파일(로컬 DB)을 덮어쓰지 않고 failed', async () => {
    write(repo, 'prisma/dev.db', '사용자 로컬 DB 원본');
    expect(userGit(repo, 'check-ignore', 'prisma/dev.db')).toBe('prisma/dev.db');
    const run = await createRun();
    // 에이전트는 파일 도구로 `.gitignore`를 고칠 수 있다
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

    const result = await manager.merge(run, { check: passCheck });

    expect(result).toMatchObject({ status: 'failed', reason: 'base_update_failed' });
    expect(read(repo, 'prisma/dev.db')).toBe('사용자 로컬 DB 원본');
    expect(tip(repo)).toBe(run.baseCommit);
    expect(runBranches(repo)).toEqual(['bive/run-EXE-001']);
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
});

describe('preserve(run)', () => {
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
});
