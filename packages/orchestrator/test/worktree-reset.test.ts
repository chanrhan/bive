// 실행 워크트리 되돌리기 (M1-14 리뷰 반영, PRD 5.1 · NFR-01 · ADR-027 · ADR-066). 픽스처 복사본 · 실제 git.
// `reset --hard` · `clean -ffd`가 BIVE 실행 워크트리 밖(프로젝트 폴더 등)에서 돌지 않게 막는 검사를 단언한다.
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorktreeManager,
  GitWorktreeError,
  type RunGitRef,
} from '../src/git/worktree-manager.js';
import { resetRunWorktree } from '../src/git/worktree-reset.js';
import { copyFixture, newId, userGit } from './helpers/engine-harness.js';
import { cleanup, makeBiveHome } from './helpers/process.js';

const temps: string[] = [];
let biveHome: string;
let repo: string;
let run: RunGitRef;

/** 프로젝트 폴더의 작업 트리 · 색인 · HEAD 상태 (되돌리기 뒤 그대로인지 비교한다). */
const projectState = (): unknown => ({
  head: userGit(repo, 'rev-parse', 'HEAD'),
  status: userGit(repo, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'),
  staged: userGit(repo, 'diff', '--cached'),
  unstaged: userGit(repo, 'diff'),
  page: fs.readFileSync(path.join(repo, 'src/app/page.tsx'), 'utf8'),
  untracked: fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8'),
});

beforeEach(async () => {
  biveHome = makeBiveHome();
  repo = copyFixture(temps);
  run = await createWorktreeManager({ biveHome }).create({
    projectId: newId(),
    runDisplayId: 'EXE-001',
    repoPath: repo,
    baseBranch: 'main',
  });
  // 사용자의 작업 중인 상태: 추적 파일 수정 · 스테이지 · 미추적 파일
  fs.appendFileSync(path.join(repo, 'src/app/page.tsx'), '\n// 사용자 작업 중\n');
  fs.writeFileSync(path.join(repo, 'README.local.md'), '스테이지한 새 파일\n');
  userGit(repo, 'add', 'README.local.md');
  fs.writeFileSync(path.join(repo, 'notes.txt'), '미추적 메모\n');
});

afterEach(async () => {
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const rejects = async (
  ref: RunGitRef,
  commit: string,
  code: GitWorktreeError['code'],
): Promise<void> => {
  const before = projectState();
  const error: unknown = await resetRunWorktree(ref, commit, { biveHome }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GitWorktreeError);
  expect((error as GitWorktreeError).code).toBe(code);
  expect(projectState()).toEqual(before);
};

describe('resetRunWorktree', () => {
  it('실행 워크트리의 추적 변경을 되돌리고 미추적 파일을 지우며 무시된 파일은 남긴다', async () => {
    const before = projectState();
    const wt = run.worktreePath;
    fs.appendFileSync(path.join(wt, 'src/app/page.tsx'), '\n// 에이전트 변경\n');
    fs.writeFileSync(path.join(wt, 'junk.txt'), '남은 파일\n');
    fs.mkdirSync(path.join(wt, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'node_modules', 'keep.txt'), '무시된 파일\n');

    const result = await resetRunWorktree(run, run.baseCommit, { biveHome });
    expect(result).toEqual({ commit: run.baseCommit, previousHead: run.baseCommit });
    expect(userGit(wt, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('');
    expect(fs.existsSync(path.join(wt, 'junk.txt'))).toBe(false);
    expect(fs.existsSync(path.join(wt, 'node_modules', 'keep.txt'))).toBe(true);
    expect(projectState()).toEqual(before);
  });

  it('워크트리가 실행 브랜치가 아닌 다른 브랜치에 있으면 worktree_branch_mismatch', async () => {
    userGit(run.worktreePath, 'checkout', '-q', '-b', 'other');
    fs.writeFileSync(path.join(run.worktreePath, 'junk.txt'), '남은 파일\n');
    await rejects(run, run.baseCommit, 'worktree_branch_mismatch');
    expect(fs.existsSync(path.join(run.worktreePath, 'junk.txt'))).toBe(true);
  });

  it('실행 브랜치에 없는 커밋 · 커밋 해시가 아닌 값은 invalid_input', async () => {
    // 실행을 시작한 뒤 기준 브랜치에 생긴 커밋 (실행 브랜치에는 없음)
    const other = path.join(path.dirname(repo), 'other-wt');
    userGit(repo, 'worktree', 'add', '-q', '-b', 'side', other, run.baseCommit);
    fs.writeFileSync(path.join(other, 'side.txt'), '옆 브랜치\n');
    userGit(other, 'add', 'side.txt');
    userGit(other, 'commit', '-q', '-m', 'side');
    const outside = userGit(other, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(run.worktreePath, 'junk.txt'), '남은 파일\n');

    await rejects(run, outside, 'invalid_input');
    await rejects(run, 'not-a-sha', 'invalid_input');
    expect(fs.existsSync(path.join(run.worktreePath, 'junk.txt'))).toBe(true);
  });

  it('워크트리 경로가 프로젝트 폴더 · 이름 규칙과 다른 브랜치면 invalid_input (프로젝트 폴더에서 reset · clean 안 함)', async () => {
    await rejects({ ...run, worktreePath: repo }, run.baseCommit, 'invalid_input');
    await rejects({ ...run, branch: 'main' }, run.baseCommit, 'invalid_input');
    await rejects({ ...run, runDisplayId: 'EXE-002' }, run.baseCommit, 'invalid_input');
  });

  it('워크트리가 지워졌으면 worktree_missing', async () => {
    fs.rmSync(run.worktreePath, { recursive: true, force: true });
    await rejects(run, run.baseCommit, 'worktree_missing');
  });

  it('워크트리 자리가 프로젝트 폴더를 가리키는 심볼릭 링크면 따라가지 않고 invalid_input', async () => {
    userGit(repo, 'worktree', 'remove', '--force', run.worktreePath);
    fs.symlinkSync(repo, run.worktreePath, 'dir');
    await rejects(run, run.baseCommit, 'invalid_input');
    expect(fs.lstatSync(run.worktreePath).isSymbolicLink()).toBe(true);
  });
});
