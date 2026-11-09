// 실행 워크트리를 마지막 완료 단계 커밋으로 되돌린다 (PRD 5.1 끊김 복구, ADR-027 · ADR-058 · ADR-066).
// 재개(`run.resume`)와 회귀 · 재시도 전에 실행 엔진이 부른다. 워크트리 관리자(ADR-058)의 이름 규칙 · git 실행기를
// 그대로 쓰고, 관리자 내부는 바꾸지 않는다.
// - 대상은 BIVE가 만든 실행 워크트리뿐이다: 경로가 `$BIVE_HOME/work/<projectId>/worktrees/<EXE-ID>`이고 링크가 아닌
//   폴더이며, 실행 브랜치(`bive/run-<EXE-ID>`)에 있어야 한다
// - 되돌릴 커밋은 실행 브랜치에 들어 있어야 한다(기준 커밋이나 그 뒤 단계 커밋). 아니면 거부한다
// - `reset --hard <커밋>` 뒤 `clean -ffd`(무시 규칙에 걸리지 않은 미추적 파일 · 폴더 삭제). 무시된 파일(`node_modules` ·
//   빌드 산출물)은 남긴다: 커밋 · 병합에 들어가지 않고(ADR-058) 판정은 커밋의 깨끗한 체크아웃에서 돌기 때문이다
import fs from 'node:fs';
import path from 'node:path';

import { CommitSha } from '@bive/shared';

import { createGitRunner, type GitRunner } from './git-exec.js';
import {
  GitWorktreeError,
  type RunGitRef,
  runBranchName,
  runWorktreePath,
} from './worktree-manager.js';

const realOrResolved = (target: string): string => {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
};

const comparable = (value: string): string =>
  process.platform === 'win32' ? value.toLowerCase() : value;

export interface ResetWorktreeOptions {
  /** `$BIVE_HOME` */
  biveHome: string;
  /** git 실행 함수 (기본 셸 없는 `execFile`) */
  git?: GitRunner;
}

export interface ResetWorktreeResult {
  /** 되돌린 뒤 실행 워크트리의 HEAD (= 요청한 커밋) */
  commit: string;
  /** 되돌리기 전 HEAD */
  previousHead: string;
}

/**
 * 실행 워크트리를 `commit`으로 hard reset하고 clean한다. 실행 브랜치도 그 커밋을 가리키게 된다.
 * @throws {GitWorktreeError} 경로 · 브랜치 · 커밋이 규칙과 다르거나 워크트리가 없을 때
 * @throws {GitCommandError} git 실패
 */
export const resetRunWorktree = async (
  run: RunGitRef,
  commit: string,
  options: ResetWorktreeOptions,
): Promise<ResetWorktreeResult> => {
  const git = options.git ?? createGitRunner();
  if (!CommitSha.safeParse(commit).success) {
    throw new GitWorktreeError('invalid_input', `되돌릴 커밋이 커밋 해시가 아닙니다: ${commit}`);
  }
  const branch = runBranchName(run.runDisplayId);
  const expected = runWorktreePath(
    realOrResolved(options.biveHome),
    run.projectId,
    run.runDisplayId,
  );
  const given = path.join(
    realOrResolved(path.dirname(run.worktreePath)),
    path.basename(run.worktreePath),
  );
  if (run.branch !== branch || comparable(given) !== comparable(expected)) {
    throw new GitWorktreeError(
      'invalid_input',
      `실행 참조의 브랜치 · 워크트리가 규칙과 다릅니다: ${run.branch} · ${run.worktreePath}`,
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(expected);
  } catch {
    throw new GitWorktreeError('worktree_missing', `실행 워크트리가 없습니다: ${expected}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new GitWorktreeError('invalid_input', `실행 워크트리가 폴더가 아닙니다: ${expected}`);
  }
  const cwd = expected;
  const head = (await git(['symbolic-ref', '-q', 'HEAD'], { cwd, okCodes: [0, 1] })).stdout.trim();
  if (head !== `refs/heads/${branch}`) {
    throw new GitWorktreeError(
      'worktree_branch_mismatch',
      `실행 워크트리가 실행 브랜치에 있지 않습니다: ${head || '분리된 HEAD'}`,
    );
  }
  const previousHead = (
    await git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd })
  ).stdout.trim();
  const contained = await git(['merge-base', '--is-ancestor', commit, previousHead], {
    cwd,
    okCodes: [0, 1, 128],
  });
  if (contained.code !== 0) {
    throw new GitWorktreeError('invalid_input', `되돌릴 커밋이 실행 브랜치에 없습니다: ${commit}`);
  }
  await git(['reset', '--hard', '--quiet', commit], { cwd });
  await git(['clean', '-ffd', '--quiet'], { cwd });
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd });
  if (status.stdout !== '') {
    throw new GitWorktreeError('invalid_input', '되돌린 뒤에도 실행 워크트리에 변경이 남았습니다');
  }
  return { commit, previousHead };
};
