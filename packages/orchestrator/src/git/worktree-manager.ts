// 실행 브랜치 · 워크트리 · 커밋 · 병합 관리자 (RUN-08 · ADR-017 · ADR-025 · ADR-058).
// - 실행 1개 = 브랜치 `bive/run-<EXE-ID>` 1개 + 프로젝트 폴더 밖 워크트리 `$BIVE_HOME/work/<projectId>/worktrees/<EXE-ID>`
// - 커밋은 이 모듈의 `commit`만 만든다(에이전트에게는 git 도구가 없다). 주체는 BIVE 고정 값
// - `merge`: 기준 브랜치가 그대로면 `--no-ff` 병합 커밋, 바뀌었으면 병합 결과로 주입된 검사를 다시 돌려 통과할 때만 갱신.
//   충돌 · 더러운 프로젝트 폴더 · 검사 실패는 기준 브랜치를 건드리지 않고 `failed` + 사유, 실행 브랜치는 보존한다
// - 저장소(DB)와 연결하지 않는다. 입력은 실행 · 프로젝트 레코드에서 뽑은 값이고 실행 엔진(#27)이 넘긴다
import fs from 'node:fs';
import path from 'node:path';

import { CommitSha, displayIdSchema, Ulid } from '@bive/shared';

import { createGitRunner, GitCommandError, type GitRunner } from './git-exec.js';

/** 실행 브랜치 이름 접두. 사람이 `git branch --list 'bive/run-*'`로 찾는다. */
export const RUN_BRANCH_PREFIX = 'bive/run-';

const RunDisplayId = displayIdSchema('EXE');

/** 실행 브랜치 이름. `runBranchName('EXE-001')` → `bive/run-EXE-001`. */
export const runBranchName = (runDisplayId: string): string => {
  assertRunDisplayId(runDisplayId);
  return `${RUN_BRANCH_PREFIX}${runDisplayId}`;
};

/** 실행 워크트리 경로 `$BIVE_HOME/work/<projectId>/worktrees/<EXE-ID>`. */
export const runWorktreePath = (
  biveHome: string,
  projectId: string,
  runDisplayId: string,
): string => {
  assertProjectId(projectId);
  assertRunDisplayId(runDisplayId);
  return path.join(path.resolve(biveHome), 'work', projectId, 'worktrees', runDisplayId);
};

/**
 * 병합 검사용 임시 워크트리 경로 `$BIVE_HOME/work/<projectId>/merges/<EXE-ID>`.
 * 병합이 끝나면(성공 · 실패 모두) 지운다.
 */
export const mergeWorktreePath = (
  biveHome: string,
  projectId: string,
  runDisplayId: string,
): string => {
  assertProjectId(projectId);
  assertRunDisplayId(runDisplayId);
  return path.join(path.resolve(biveHome), 'work', projectId, 'merges', runDisplayId);
};

export type GitWorktreeErrorCode =
  | 'invalid_input'
  | 'not_a_repository'
  | 'not_repo_root'
  | 'base_branch_missing'
  | 'branch_exists'
  | 'worktree_exists'
  | 'branch_missing'
  | 'worktree_missing'
  | 'worktree_branch_mismatch';

/** 실행 브랜치 · 워크트리를 만들거나 다룰 수 없을 때. `code`로 원인을 가른다. */
export class GitWorktreeError extends Error {
  override readonly name = 'GitWorktreeError';
  constructor(
    readonly code: GitWorktreeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const assertProjectId = (projectId: string): void => {
  if (!Ulid.safeParse(projectId).success) {
    throw new GitWorktreeError('invalid_input', `프로젝트 ID가 ULID가 아닙니다: ${projectId}`);
  }
};

const assertRunDisplayId = (runDisplayId: string): void => {
  if (!RunDisplayId.safeParse(runDisplayId).success) {
    throw new GitWorktreeError(
      'invalid_input',
      `실행 표시 ID가 EXE-NNN 형식이 아닙니다: ${runDisplayId}`,
    );
  }
};

/** 실행 브랜치 · 워크트리를 만들 때의 입력 (실행 · 프로젝트 레코드에서 뽑는다). */
export interface CreateRunInput {
  projectId: string;
  /** 실행 표시 ID (`EXE-001`, ADR-025) */
  runDisplayId: string;
  /** 프로젝트 폴더 (`Project.rootPath`). git 저장소의 최상위 폴더여야 한다 */
  repoPath: string;
  /** 기준 브랜치 이름 (`Project.baseBranch`, ADR-054). `refs/heads/` 없이 */
  baseBranch: string;
}

/** 실행의 git 참조. `create`가 돌려주고, 실행 엔진은 같은 값을 `Run`에 저장했다가 다시 넘긴다. */
export interface RunGitRef {
  projectId: string;
  runDisplayId: string;
  /** 프로젝트 폴더의 실경로 */
  repoPath: string;
  baseBranch: string;
  /** `bive/run-<EXE-ID>` */
  branch: string;
  /** `$BIVE_HOME/work/<projectId>/worktrees/<EXE-ID>` */
  worktreePath: string;
  /** 실행을 시작한 기준 브랜치 커밋. 병합 때 기준 브랜치가 바뀌었는지 이 값과 비교한다 */
  baseCommit: string;
}

export interface CommitResult {
  /** 실행 브랜치의 현재 커밋 */
  commit: string;
  /** 이번 호출이 커밋을 만들었는지. 바뀐 파일이 없으면 만들지 않는다 */
  created: boolean;
}

/** 병합 결과로 다시 돌리는 검사(4장 5단계)에 넘기는 값. */
export interface MergeCheckContext {
  run: RunGitRef;
  /** 병합 커밋이 체크아웃된 임시 워크트리. 검사가 끝나면 지운다 */
  worktreePath: string;
  mergeCommit: string;
  /** 병합 대상이 된 기준 브랜치 커밋 (실행 시작 뒤 바뀐 값) */
  baseCommit: string;
  /** 실행 브랜치 커밋 */
  headCommit: string;
}

export interface MergeCheckResult {
  passed: boolean;
  /** 실패 사유 등 기록용 문장 */
  detail?: string;
}

/** 검사 함수. 실행 엔진이 판정 러너를 감싸 넘긴다(M1-16). */
export type MergeCheck = (context: MergeCheckContext) => Promise<MergeCheckResult>;

export interface MergeOptions {
  /** 기준 브랜치가 바뀐 경우에만 병합 결과로 실행한다 (ADR-017) */
  check: MergeCheck;
}

export type MergeFailureReason =
  /** 실행 브랜치가 없다 */
  | 'branch_missing'
  /** 실행 워크트리에 커밋되지 않은 추적 파일 변경이 있다 (판정한 코드와 병합할 코드가 다를 수 있음) */
  | 'run_worktree_dirty'
  /** 프로젝트 폴더에 커밋되지 않은 추적 파일 변경이 있다 */
  | 'project_dirty'
  /** 기준 브랜치가 없다 */
  | 'base_branch_missing'
  /** 기준 브랜치가 프로젝트 폴더가 아닌 다른 워크트리에 체크아웃돼 있다 */
  | 'base_checked_out_elsewhere'
  /** 실행 브랜치에 기준 브랜치에 없는 커밋이 없다 */
  | 'no_changes'
  /** 병합 충돌 */
  | 'conflict'
  /** 병합 결과로 다시 돌린 검사가 실패했다 */
  | 'check_failed'
  /** 검사 함수가 예외를 던졌다 */
  | 'check_error'
  /** 병합하는 동안 기준 브랜치가 다시 바뀌었다 */
  | 'base_changed'
  /** 기준 브랜치 갱신을 git이 거부했다 (예: 덮어쓸 미추적 파일) */
  | 'base_update_failed'
  /** 그 밖의 git 실패 */
  | 'git_error';

export type MergeResult =
  | {
      status: 'merged';
      mergeCommit: string;
      /** 갱신 전 기준 브랜치 커밋 (병합 커밋의 첫 부모) */
      previousBaseCommit: string;
      /** 병합한 실행 브랜치 커밋 (병합 커밋의 둘째 부모) */
      headCommit: string;
      /** 기준 브랜치가 바뀌어 검사를 다시 돌렸는지 */
      rechecked: boolean;
      /** 기준 브랜치를 갱신한 방법: 프로젝트 폴더 fast-forward(작업 트리 함께 갱신) · 참조만 갱신 */
      baseUpdate: 'checkout_fast_forward' | 'update_ref';
    }
  | {
      status: 'failed';
      reason: MergeFailureReason;
      message: string;
      /** 보존된 실행 브랜치 */
      branch: string;
      headCommit: string | null;
      /** 충돌 파일 (`conflict`) 또는 더러운 파일 (`project_dirty` · `run_worktree_dirty`) */
      files?: string[];
      /** 검사 결과의 사유 (`check_failed` · `check_error`) */
      checkDetail?: string;
    };

export interface PreserveResult {
  branch: string;
  headCommit: string;
  /** 남아 있는 실행 워크트리 (없으면 `null`). 잠가서 `git worktree prune` · `remove`로 지워지지 않게 한다 */
  worktreePath: string | null;
  /** 기준 브랜치의 현재 커밋 (손대지 않음) */
  baseCommit: string | null;
}

export interface WorktreeManager {
  /** 실행 브랜치 · 워크트리를 만든다. 커밋은 만들지 않는다. */
  create(input: CreateRunInput): Promise<RunGitRef>;
  /** 실행 워크트리의 변경을 모두 스테이지해 BIVE 주체로 커밋한다(단계 종료 시, 4장). */
  commit(run: RunGitRef, message: string): Promise<CommitResult>;
  /** 판정 통과 뒤 기준 브랜치에 병합한다 (ADR-017). 실패해도 예외 대신 `failed`를 돌려준다. */
  merge(run: RunGitRef, options: MergeOptions): Promise<MergeResult>;
  /** 실패 · 예산 초과 종료: 병합하지 않고 브랜치 · 워크트리를 남긴다. */
  preserve(run: RunGitRef): Promise<PreserveResult>;
  /** 실행 워크트리만 지운다. 브랜치는 남긴다. 언제 부를지는 실행 엔진이 정한다. */
  removeWorktree(run: RunGitRef): Promise<void>;
}

export interface WorktreeManagerOptions {
  /** `$BIVE_HOME` */
  biveHome: string;
  /** git 실행 함수 (기본 셸 없는 `execFile`, 허용 목록 환경 변수) */
  git?: GitRunner;
}

/** 프로젝트 폴더 · 실행 워크트리에 커밋되지 않은 추적 파일 변경 (미추적 파일은 보지 않는다, `.bive.json` 포함). */
const STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--untracked-files=no'] as const;

const existsPath = (target: string): boolean => {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
};

const realOrResolved = (target: string): string => {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
};

const samePath = (a: string, b: string): boolean => {
  const left = realOrResolved(a);
  const right = realOrResolved(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};

/** `status --porcelain=v1 -z` 출력의 파일 이름들 (이름 바꾸기의 원래 이름은 뺀다). */
const parseStatusFiles = (stdout: string): string[] => {
  const fields = stdout.split('\0');
  const files: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i] ?? '';
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    // R · C 항목은 다음 필드에 원래 이름이 온다
    if (entry[0] === 'R' || entry[0] === 'C') i += 1;
  }
  return files;
};

interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  locked: boolean;
}

/** `worktree list --porcelain -z` 출력 해석. 항목은 빈 필드로 끝난다. */
const parseWorktreeList = (stdout: string): WorktreeEntry[] => {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const field of stdout.split('\0')) {
    if (field === '') {
      if (current !== null) entries.push(current);
      current = null;
      continue;
    }
    const space = field.indexOf(' ');
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? '' : field.slice(space + 1);
    if (key === 'worktree') {
      if (current !== null) entries.push(current);
      current = { path: value, head: null, branch: null, locked: false };
    } else if (current !== null) {
      if (key === 'HEAD') current.head = value;
      else if (key === 'branch') current.branch = value;
      else if (key === 'locked') current.locked = true;
    }
  }
  if (current !== null) entries.push(current);
  return entries;
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 실행 브랜치 · 워크트리 · 병합 관리자를 만든다.
 */
export const createWorktreeManager = (options: WorktreeManagerOptions): WorktreeManager => {
  const biveHome = path.resolve(options.biveHome);
  const git = options.git ?? createGitRunner();

  const out = async (cwd: string, args: readonly string[]): Promise<string> =>
    (await git(args, { cwd })).stdout.trim();

  /** 참조가 가리키는 커밋. 없으면 `null`. */
  const resolveCommit = async (cwd: string, ref: string): Promise<string | null> => {
    const result = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd,
      okCodes: [0, 1, 128],
    });
    const sha = result.stdout.trim();
    return result.code === 0 && CommitSha.safeParse(sha).success ? sha : null;
  };

  const dirtyFiles = async (cwd: string): Promise<string[]> =>
    parseStatusFiles((await git(STATUS_ARGS, { cwd })).stdout);

  const listWorktrees = async (repoPath: string): Promise<WorktreeEntry[]> =>
    parseWorktreeList(
      (await git(['worktree', 'list', '--porcelain', '-z'], { cwd: repoPath })).stdout,
    );

  const isAncestor = async (cwd: string, ancestor: string, descendant: string): Promise<boolean> =>
    (await git(['merge-base', '--is-ancestor', ancestor, descendant], { cwd, okCodes: [0, 1] }))
      .code === 0;

  /** 기준 브랜치 이름 검사. 옵션으로 읽히지 않고 올바른 브랜치 참조여야 한다. */
  const assertBaseBranch = async (repoPath: string, baseBranch: string): Promise<void> => {
    const malformed =
      baseBranch === '' || baseBranch.startsWith('-') || baseBranch.startsWith('refs/');
    const valid =
      !malformed &&
      (
        await git(['check-ref-format', `refs/heads/${baseBranch}`], {
          cwd: repoPath,
          okCodes: [0, 1],
        })
      ).code === 0;
    if (!valid) {
      throw new GitWorktreeError(
        'invalid_input',
        `기준 브랜치 이름이 올바르지 않습니다: ${baseBranch}`,
      );
    }
  };

  /** 프로젝트 폴더가 git 저장소의 최상위 폴더인지 확인하고 실경로를 돌려준다. */
  const resolveRepoRoot = async (repoPath: string): Promise<string> => {
    let real: string;
    try {
      real = fs.realpathSync.native(repoPath);
    } catch {
      throw new GitWorktreeError('not_a_repository', `프로젝트 폴더가 없습니다: ${repoPath}`);
    }
    let top: string;
    try {
      top = await out(real, ['rev-parse', '--show-toplevel']);
    } catch (error) {
      if (error instanceof GitCommandError) {
        throw new GitWorktreeError('not_a_repository', `git 저장소가 아닙니다: ${real}`);
      }
      throw error;
    }
    if (top === '' || !samePath(top, real)) {
      throw new GitWorktreeError(
        'not_repo_root',
        `프로젝트 폴더가 git 저장소의 최상위 폴더가 아닙니다: ${real} (저장소 최상위 ${top})`,
      );
    }
    return real;
  };

  /**
   * 넘겨받은 참조가 표시 ID · 프로젝트 ID에서 만든 이름 · 경로와 같은지, 프로젝트 폴더가 저장소 최상위인지 확인하고
   * 프로젝트 폴더를 실경로로 바꾼 참조를 돌려준다.
   */
  const prepareRef = async (run: RunGitRef): Promise<RunGitRef> => {
    const branch = runBranchName(run.runDisplayId);
    const worktreePath = runWorktreePath(biveHome, run.projectId, run.runDisplayId);
    if (run.branch !== branch || path.resolve(run.worktreePath) !== worktreePath) {
      throw new GitWorktreeError(
        'invalid_input',
        `실행 참조의 브랜치 · 워크트리가 규칙과 다릅니다: ${run.branch} · ${run.worktreePath}`,
      );
    }
    if (!CommitSha.safeParse(run.baseCommit).success) {
      throw new GitWorktreeError(
        'invalid_input',
        `기준 커밋이 커밋 해시가 아닙니다: ${run.baseCommit}`,
      );
    }
    const repoPath = await resolveRepoRoot(run.repoPath);
    await assertBaseBranch(repoPath, run.baseBranch);
    return { ...run, repoPath, worktreePath };
  };

  /** 병합용 임시 워크트리를 지운다. 등록만 남았거나 폴더만 남은 경우도 정리한다. */
  const removeMergeWorktree = async (run: RunGitRef): Promise<void> => {
    const target = mergeWorktreePath(biveHome, run.projectId, run.runDisplayId);
    const registered = (await listWorktrees(run.repoPath)).some((entry) =>
      samePath(entry.path, target),
    );
    if (registered && existsPath(target)) {
      await git(['worktree', 'remove', '--force', '--force', target], { cwd: run.repoPath });
    }
    // 폴더만 남은 경우 (등록이 없으면 git이 지우지 않는다). 등록만 남은 경우는 다음 `add -f`가 덮어쓴다
    fs.rmSync(target, { recursive: true, force: true });
  };

  const create = async (input: CreateRunInput): Promise<RunGitRef> => {
    const branch = runBranchName(input.runDisplayId);
    const worktreePath = runWorktreePath(biveHome, input.projectId, input.runDisplayId);
    const repoPath = await resolveRepoRoot(input.repoPath);
    await assertBaseBranch(repoPath, input.baseBranch);

    const baseCommit = await resolveCommit(repoPath, `refs/heads/${input.baseBranch}`);
    if (baseCommit === null) {
      throw new GitWorktreeError(
        'base_branch_missing',
        `기준 브랜치가 없거나 커밋이 없습니다: ${input.baseBranch}`,
      );
    }
    if ((await resolveCommit(repoPath, `refs/heads/${branch}`)) !== null) {
      throw new GitWorktreeError('branch_exists', `실행 브랜치가 이미 있습니다: ${branch}`);
    }
    if (existsPath(worktreePath)) {
      throw new GitWorktreeError(
        'worktree_exists',
        `실행 워크트리 폴더가 이미 있습니다: ${worktreePath}`,
      );
    }

    fs.mkdirSync(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
    // 기준 브랜치 이름이 아니라 방금 읽은 커밋에서 만든다(그 사이 기준 브랜치가 움직여도 baseCommit과 일치)
    await git(['worktree', 'add', '-b', branch, worktreePath, baseCommit], { cwd: repoPath });

    return {
      projectId: input.projectId,
      runDisplayId: input.runDisplayId,
      repoPath,
      baseBranch: input.baseBranch,
      branch,
      worktreePath,
      baseCommit,
    };
  };

  /** 실행 워크트리가 있고 실행 브랜치에 있는지 확인한다. */
  const assertRunWorktree = async (run: RunGitRef): Promise<void> => {
    if (!existsPath(run.worktreePath)) {
      throw new GitWorktreeError(
        'worktree_missing',
        `실행 워크트리가 없습니다: ${run.worktreePath}`,
      );
    }
    const head = await git(['symbolic-ref', '-q', 'HEAD'], {
      cwd: run.worktreePath,
      okCodes: [0, 1],
    });
    if (head.stdout.trim() !== `refs/heads/${run.branch}`) {
      throw new GitWorktreeError(
        'worktree_branch_mismatch',
        `실행 워크트리가 실행 브랜치에 있지 않습니다: ${head.stdout.trim() || '분리된 HEAD'}`,
      );
    }
  };

  const commit = async (input: RunGitRef, message: string): Promise<CommitResult> => {
    const run = await prepareRef(input);
    if (message.trim() === '' || message.includes('\0')) {
      throw new GitWorktreeError('invalid_input', '커밋 메시지가 비었거나 NUL을 포함합니다');
    }
    await assertRunWorktree(run);
    const cwd = run.worktreePath;
    // 무시 규칙(.gitignore)에 걸리지 않는 모든 변경 · 추가 · 삭제
    await git(['add', '--all', '--', '.'], { cwd });
    const staged = await git(['diff', '--cached', '--quiet'], { cwd, okCodes: [0, 1] });
    if (staged.code === 0) {
      return { commit: await out(cwd, ['rev-parse', 'HEAD']), created: false };
    }
    await git(['commit', '--quiet', '--no-verify', '-m', message], { cwd });
    return { commit: await out(cwd, ['rev-parse', 'HEAD']), created: true };
  };

  const mergeMessage = (run: RunGitRef): string =>
    [
      `BIVE 실행 ${run.runDisplayId} 병합`,
      '',
      `Bive-Run: ${run.runDisplayId}`,
      `Bive-Project: ${run.projectId}`,
      `Bive-Branch: ${run.branch}`,
    ].join('\n');

  const merge = async (input: RunGitRef, mergeOptions: MergeOptions): Promise<MergeResult> => {
    const run = await prepareRef(input);
    let headCommit: string | null = null;
    const fail = (
      reason: MergeFailureReason,
      message: string,
      extra: { files?: string[]; checkDetail?: string } = {},
    ): MergeResult => ({
      status: 'failed',
      reason,
      message,
      branch: run.branch,
      headCommit,
      ...extra,
    });

    let mergeWorktreeCreated = false;
    try {
      headCommit = await resolveCommit(run.repoPath, `refs/heads/${run.branch}`);
      if (headCommit === null)
        return fail('branch_missing', `실행 브랜치가 없습니다: ${run.branch}`);

      if (existsPath(run.worktreePath)) {
        const runDirty = await dirtyFiles(run.worktreePath);
        if (runDirty.length > 0) {
          return fail('run_worktree_dirty', '실행 워크트리에 커밋되지 않은 변경이 있습니다', {
            files: runDirty,
          });
        }
      }

      const projectDirty = await dirtyFiles(run.repoPath);
      if (projectDirty.length > 0) {
        return fail('project_dirty', '프로젝트 폴더에 커밋되지 않은 변경이 있습니다', {
          files: projectDirty,
        });
      }

      const baseRef = `refs/heads/${run.baseBranch}`;
      const baseTip = await resolveCommit(run.repoPath, baseRef);
      if (baseTip === null) {
        return fail('base_branch_missing', `기준 브랜치가 없습니다: ${run.baseBranch}`);
      }

      const checkouts = (await listWorktrees(run.repoPath)).filter(
        (entry) => entry.branch === baseRef,
      );
      const elsewhere = checkouts.find((entry) => !samePath(entry.path, run.repoPath));
      if (elsewhere !== undefined) {
        return fail(
          'base_checked_out_elsewhere',
          `기준 브랜치가 다른 워크트리에 체크아웃돼 있습니다: ${elsewhere.path}`,
        );
      }
      const checkedOutInProject = checkouts.length > 0;

      if (await isAncestor(run.repoPath, headCommit, baseTip)) {
        return fail('no_changes', '실행 브랜치에 병합할 커밋이 없습니다');
      }

      const baseChanged = baseTip !== run.baseCommit;

      // 충돌은 파일을 건드리지 않고 먼저 확인한다 (git ≥ 2.38)
      const preview = await git(
        ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', baseTip, headCommit],
        { cwd: run.repoPath, okCodes: [0, 1] },
      );
      if (preview.code === 1) {
        const files = [
          ...new Set(
            preview.stdout
              .split('\0')
              .slice(1)
              .filter((f) => f !== ''),
          ),
        ];
        return fail('conflict', '기준 브랜치와 충돌합니다', { files });
      }

      // 병합 커밋은 기준 브랜치 커밋에서 분리된 임시 워크트리에서 `--no-ff`로 만든다
      const mergePath = mergeWorktreePath(biveHome, run.projectId, run.runDisplayId);
      await removeMergeWorktree(run);
      fs.mkdirSync(path.dirname(mergePath), { recursive: true, mode: 0o700 });
      mergeWorktreeCreated = true;
      await git(['worktree', 'add', '--detach', '-f', mergePath, baseTip], { cwd: run.repoPath });
      await git(
        ['merge', '--no-ff', '--no-edit', '--no-verify', '-m', mergeMessage(run), headCommit],
        {
          cwd: mergePath,
        },
      );
      const mergeCommit = await out(mergePath, ['rev-parse', 'HEAD']);

      if (baseChanged) {
        let result: MergeCheckResult;
        try {
          result = await mergeOptions.check({
            run,
            worktreePath: mergePath,
            mergeCommit,
            baseCommit: baseTip,
            headCommit,
          });
        } catch (error) {
          return fail('check_error', '병합 결과 검사 중 오류가 났습니다', {
            checkDetail: errorText(error),
          });
        }
        if (!result.passed) {
          return fail(
            'check_failed',
            '병합 결과 검사가 실패했습니다',
            result.detail === undefined ? {} : { checkDetail: result.detail },
          );
        }
      }

      // 갱신 직전 다시 확인한다: 검사하는 동안 사용자가 커밋하거나 파일을 고쳤을 수 있다
      if ((await resolveCommit(run.repoPath, baseRef)) !== baseTip) {
        return fail('base_changed', '병합하는 동안 기준 브랜치가 바뀌었습니다');
      }
      const dirtyNow = await dirtyFiles(run.repoPath);
      if (dirtyNow.length > 0) {
        return fail('project_dirty', '프로젝트 폴더에 커밋되지 않은 변경이 있습니다', {
          files: dirtyNow,
        });
      }

      try {
        if (checkedOutInProject) {
          // 작업 트리 · 색인 · 참조를 함께 옮긴다. 병합 커밋이 HEAD의 자손이 아니면 git이 거부한다
          await git(['merge', '--ff-only', '--quiet', mergeCommit], { cwd: run.repoPath });
        } else {
          // 이전 값이 baseTip일 때만 바꾼다 (비교 후 교체)
          await git(
            ['update-ref', '-m', `bive: ${run.runDisplayId} 병합`, baseRef, mergeCommit, baseTip],
            { cwd: run.repoPath },
          );
        }
      } catch (error) {
        if (!(error instanceof GitCommandError)) throw error;
        const moved = (await resolveCommit(run.repoPath, baseRef)) !== baseTip;
        return moved
          ? fail('base_changed', '병합하는 동안 기준 브랜치가 바뀌었습니다')
          : fail('base_update_failed', `기준 브랜치를 갱신하지 못했습니다: ${error.message}`);
      }

      return {
        status: 'merged',
        mergeCommit,
        previousBaseCommit: baseTip,
        headCommit,
        rechecked: baseChanged,
        baseUpdate: checkedOutInProject ? 'checkout_fast_forward' : 'update_ref',
      };
    } catch (error) {
      if (error instanceof GitCommandError) return fail('git_error', error.message);
      throw error;
    } finally {
      if (mergeWorktreeCreated) {
        // 정리 실패는 결과를 바꾸지 않는다 (다음 병합 · 보존 때 다시 지운다)
        await removeMergeWorktree(run).catch(() => undefined);
      }
    }
  };

  const preserve = async (input: RunGitRef): Promise<PreserveResult> => {
    const run = await prepareRef(input);
    const headCommit = await resolveCommit(run.repoPath, `refs/heads/${run.branch}`);
    if (headCommit === null) {
      throw new GitWorktreeError('branch_missing', `실행 브랜치가 없습니다: ${run.branch}`);
    }
    await removeMergeWorktree(run);
    const entry = (await listWorktrees(run.repoPath)).find((item) =>
      samePath(item.path, run.worktreePath),
    );
    const present = entry !== undefined && existsPath(run.worktreePath);
    if (present && !entry.locked) {
      await git(
        ['worktree', 'lock', '--reason', `BIVE 실행 ${run.runDisplayId} 보존`, run.worktreePath],
        {
          cwd: run.repoPath,
        },
      );
    }
    return {
      branch: run.branch,
      headCommit,
      worktreePath: present ? run.worktreePath : null,
      baseCommit: await resolveCommit(run.repoPath, `refs/heads/${run.baseBranch}`),
    };
  };

  const removeWorktree = async (input: RunGitRef): Promise<void> => {
    const run = await prepareRef(input);
    await removeMergeWorktree(run);
    const registered = (await listWorktrees(run.repoPath)).some((entry) =>
      samePath(entry.path, run.worktreePath),
    );
    if (registered && existsPath(run.worktreePath)) {
      // 잠금(`preserve`) · 미추적 파일(node_modules 등)이 있어도 지운다. 브랜치는 남는다
      await git(['worktree', 'remove', '--force', '--force', run.worktreePath], {
        cwd: run.repoPath,
      });
    }
    fs.rmSync(run.worktreePath, { recursive: true, force: true });
  };

  return { create, commit, merge, preserve, removeWorktree };
};
