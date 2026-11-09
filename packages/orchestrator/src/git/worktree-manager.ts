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
  /**
   * 기준 브랜치를 갱신하지 못했거나 갱신을 확인하지 못했다
   * (예: 덮어쓸 미추적 · 무시된 파일, 갱신 직전 · 순간의 프로젝트 폴더 체크아웃 변경)
   */
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
      /**
       * 기준 브랜치 대신 병합 커밋으로 옮겨진 브랜치 (`base_update_failed`, 갱신하는 순간 프로젝트 폴더의
       * 체크아웃이 바뀐 경우). BIVE는 되돌리지 않으므로 사람이 `previousCommit`으로 되돌릴 때 쓴다
       */
      movedRef?: { ref: string; previousCommit: string | null; commit: string };
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
  /**
   * 실행 워크트리만 지운다(잠긴 등록 · 폴더가 지워져 남은 등록 포함). 브랜치는 남긴다. 언제 부를지는 실행 엔진이 정한다.
   */
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

const comparable = (value: string): string =>
  process.platform === 'win32' ? value.toLowerCase() : value;

/** 링크를 따라간 실경로로 비교한다. 읽기 판단(체크아웃 위치 등)에만 쓴다. */
const samePath = (a: string, b: string): boolean =>
  comparable(realOrResolved(a)) === comparable(realOrResolved(b));

/**
 * git이 기록한 경로 문자열과 그대로 비교한다(링크를 따라가지 않음). BIVE가 지우거나 잠글 등록을 고를 때 쓴다:
 * BIVE 경로 자리에 놓인 심볼릭 링크가 사용자 워크트리를 가리켜도 그 등록이 골라지지 않게 한다.
 */
const sameRecordedPath = (recorded: string, target: string): boolean =>
  comparable(path.resolve(recorded)) === comparable(path.resolve(target));

/**
 * 실경로로 바꾼다. 아직 없는 끝부분은 존재하는 가장 가까운 상위의 실경로 + 나머지로 만든다
 * (`$BIVE_HOME`이 링크여도 git이 기록하는 실경로와 BIVE가 만드는 경로가 같도록).
 */
const realpathLoose = (target: string): string => {
  const absolute = path.resolve(target);
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
};

const isSymbolicLink = (target: string): boolean => {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * 저장소(프로젝트 폴더 실경로)별 작업 대기열. 같은 저장소의 `merge` · `preserve` · `removeWorktree`를 차례로 실행한다.
 * `git merge`는 색인을 쓴 뒤에야 참조를 비교 후 교체하므로, 겹친 병합이 늦은 쪽의 참조 갱신 실패와 상관없이
 * 프로젝트 폴더 색인 · 작업 트리를 덮어쓸 수 있다. 오케스트레이터는 사용자당 프로세스 1개(pid 잠금, ADR-041)라
 * 프로세스 안 대기열로 충분하고, 관리자 인스턴스가 여럿이어도 같은 대기열을 쓰도록 모듈에 둔다.
 */
const repoQueues = new Map<string, Promise<void>>();

const serializeByRepo = async <T>(repoPath: string, task: () => Promise<T>): Promise<T> => {
  const key = comparable(repoPath);
  const previous = repoQueues.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => done);
  repoQueues.set(key, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (repoQueues.get(key) === tail) repoQueues.delete(key);
  }
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
  // 실경로로 정규화한다: git은 워크트리 경로를 실경로로 기록하므로, `$BIVE_HOME`이 링크면 폴더가 지워진 뒤
  // 기록된 경로와 BIVE가 만든 경로가 달라 등록을 찾지 못한다
  const biveHome = realpathLoose(options.biveHome);
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
    // 상위 폴더만 실경로로 바꿔 비교한다(링크인 `$BIVE_HOME`으로 적은 경로는 받되, 마지막 구성 요소의 링크는 따라가지 않음)
    const given = path.join(
      realpathLoose(path.dirname(run.worktreePath)),
      path.basename(run.worktreePath),
    );
    if (run.branch !== branch || comparable(given) !== comparable(worktreePath)) {
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

  /**
   * BIVE가 만든 워크트리 하나를 지운다. 잠긴 등록 · 폴더가 이미 지워진 등록(`--force --force`는 둘 다 지운다)과
   * 등록 없이 폴더만 남은 경우도 정리한다. 사용자의 다른 워크트리 정보를 지우는 `git worktree prune`은 쓰지 않는다.
   * 그 자리가 심볼릭 링크면 git에 넘기지 않고 링크만 지운다(git은 링크를 따라가 가리키는 워크트리를 지운다).
   * 등록은 git이 기록한 경로 문자열과 정확히 같은 것만 지운다.
   */
  const removeOwnWorktree = async (repoPath: string, target: string): Promise<void> => {
    if (isSymbolicLink(target)) {
      fs.unlinkSync(target);
    }
    const registered = (await listWorktrees(repoPath)).some((entry) =>
      sameRecordedPath(entry.path, target),
    );
    if (registered) {
      await git(['worktree', 'remove', '--force', '--force', target], { cwd: repoPath });
    }
    fs.rmSync(target, { recursive: true, force: true });
  };

  /** 병합용 임시 워크트리를 지운다. */
  const removeMergeWorktree = (run: RunGitRef): Promise<void> =>
    removeOwnWorktree(run.repoPath, mergeWorktreePath(biveHome, run.projectId, run.runDisplayId));

  /** 기준 브랜치가 체크아웃된 곳: 프로젝트 폴더 · 다른 워크트리 · 없음 (`worktree list`로 매번 새로 읽는다). */
  const locateBase = async (
    run: RunGitRef,
    baseRef: string,
  ): Promise<{ kind: 'project' } | { kind: 'elsewhere'; path: string } | { kind: 'none' }> => {
    const holders = (await listWorktrees(run.repoPath)).filter((entry) => entry.branch === baseRef);
    const elsewhere = holders.find((entry) => !samePath(entry.path, run.repoPath));
    if (elsewhere !== undefined) return { kind: 'elsewhere', path: elsewhere.path };
    return holders.length > 0 ? { kind: 'project' } : { kind: 'none' };
  };

  /** 프로젝트 폴더의 HEAD가 가리키는 참조 (분리된 HEAD면 빈 문자열). */
  const projectHead = async (repoPath: string): Promise<string> =>
    (await git(['symbolic-ref', '-q', 'HEAD'], { cwd: repoPath, okCodes: [0, 1] })).stdout.trim();

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

  /** 같은 저장소의 다른 병합 · 보존 · 제거가 끝난 뒤에 실행한다 (`serializeByRepo`). */
  const merge = async (input: RunGitRef, mergeOptions: MergeOptions): Promise<MergeResult> => {
    const run = await prepareRef(input);
    return serializeByRepo(run.repoPath, () => mergeSerialized(run, mergeOptions));
  };

  const mergeSerialized = async (
    run: RunGitRef,
    mergeOptions: MergeOptions,
  ): Promise<MergeResult> => {
    let headCommit: string | null = null;
    const fail = (
      reason: MergeFailureReason,
      message: string,
      extra: Pick<
        Extract<MergeResult, { status: 'failed' }>,
        'files' | 'checkDetail' | 'movedRef'
      > = {},
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

      // 먼저 한 번 보고(검사 전에 빨리 실패), 갱신 직전에 다시 본다(검사하는 동안 체크아웃이 바뀔 수 있다)
      const initialLocation = await locateBase(run, baseRef);
      if (initialLocation.kind === 'elsewhere') {
        return fail(
          'base_checked_out_elsewhere',
          `기준 브랜치가 다른 워크트리에 체크아웃돼 있습니다: ${initialLocation.path}`,
        );
      }

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
      await git(['worktree', 'add', '--detach', mergePath, baseTip], { cwd: run.repoPath });
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

      // 갱신 직전 다시 확인한다: 검사하는 동안 사용자가 커밋하거나 파일을 고치거나 브랜치를 바꿨을 수 있다
      if ((await resolveCommit(run.repoPath, baseRef)) !== baseTip) {
        return fail('base_changed', '병합하는 동안 기준 브랜치가 바뀌었습니다');
      }
      const dirtyNow = await dirtyFiles(run.repoPath);
      if (dirtyNow.length > 0) {
        return fail('project_dirty', '프로젝트 폴더에 커밋되지 않은 변경이 있습니다', {
          files: dirtyNow,
        });
      }
      const location = await locateBase(run, baseRef);
      if (location.kind === 'elsewhere') {
        return fail(
          'base_checked_out_elsewhere',
          `기준 브랜치가 다른 워크트리에 체크아웃돼 있습니다: ${location.path}`,
        );
      }
      const fastForward = location.kind === 'project';
      // fast-forward는 HEAD에 적용되므로 HEAD가 기준 브랜치인지 직접 확인한다
      if (fastForward && (await projectHead(run.repoPath)) !== baseRef) {
        return fail(
          'base_update_failed',
          '프로젝트 폴더의 체크아웃이 바뀌는 중이라 기준 브랜치를 갱신하지 않았습니다',
        );
      }

      try {
        if (fastForward) {
          // 작업 트리 · 색인 · 참조를 함께 옮긴다. 병합 커밋이 HEAD의 자손이 아니면 git이 거부하고,
          // 덮어쓸 미추적 파일이나 무시된 파일(예: 로컬 DB)이 있어도 거부한다(`merge` 기본값은 무시된 파일 덮어쓰기)
          await git(['merge', '--ff-only', '--no-overwrite-ignore', '--quiet', mergeCommit], {
            cwd: run.repoPath,
          });
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

      // 기준 브랜치가 실제로 병합 커밋을 가리킬 때만 성공이다
      // (fast-forward가 그 순간 바뀐 다른 브랜치에 적용됐다면 기준 브랜치는 그대로라 여기서 드러난다)
      if ((await resolveCommit(run.repoPath, baseRef)) !== mergeCommit) {
        // 지금 HEAD 브랜치가 병합 커밋을 가리키면 BIVE가 그 브랜치를 옮긴 것이다. 되돌리지 않고 복구 정보를 남긴다
        const head = fastForward ? await projectHead(run.repoPath) : '';
        const headNow = head === '' ? null : await resolveCommit(run.repoPath, head);
        if (head !== '' && headNow === mergeCommit) {
          const previousCommit = await resolveCommit(run.repoPath, `${head}@{1}`);
          return fail(
            'base_update_failed',
            `기준 브랜치 대신 ${head}가 병합 커밋으로 옮겨졌습니다 (이전 커밋 ${previousCommit ?? '알 수 없음'}). 되돌리지 않았습니다`,
            { movedRef: { ref: head, previousCommit, commit: mergeCommit } },
          );
        }
        return fail(
          'base_update_failed',
          '기준 브랜치 갱신을 확인하지 못했습니다 (갱신하는 순간 프로젝트 폴더의 체크아웃이 바뀌었을 수 있음)',
        );
      }

      return {
        status: 'merged',
        mergeCommit,
        previousBaseCommit: baseTip,
        headCommit,
        rechecked: baseChanged,
        baseUpdate: fastForward ? 'checkout_fast_forward' : 'update_ref',
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

  // 보존 · 제거는 병합용 임시 워크트리를 지우므로 같은 저장소의 병합과 겹치지 않게 같은 대기열을 쓴다.
  // `create` · `commit`은 프로젝트 폴더 색인 · 작업 트리와 다른 실행의 워크트리를 건드리지 않으므로 대기열에 넣지 않는다
  // (병합 검사가 오래 걸리는 동안 새 실행 시작을 막지 않으려고)
  const preserve = async (input: RunGitRef): Promise<PreserveResult> => {
    const run = await prepareRef(input);
    return serializeByRepo(run.repoPath, () => preserveSerialized(run));
  };

  const preserveSerialized = async (run: RunGitRef): Promise<PreserveResult> => {
    const headCommit = await resolveCommit(run.repoPath, `refs/heads/${run.branch}`);
    if (headCommit === null) {
      throw new GitWorktreeError('branch_missing', `실행 브랜치가 없습니다: ${run.branch}`);
    }
    await removeMergeWorktree(run);
    const entry = (await listWorktrees(run.repoPath)).find((item) =>
      sameRecordedPath(item.path, run.worktreePath),
    );
    // 그 자리가 링크면 BIVE 워크트리가 아니다(링크를 따라가 다른 워크트리를 잠그지 않는다)
    const present =
      entry !== undefined && existsPath(run.worktreePath) && !isSymbolicLink(run.worktreePath);
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
    await serializeByRepo(run.repoPath, async () => {
      await removeMergeWorktree(run);
      // 잠금(`preserve`) · 미추적 파일(node_modules 등)이 있어도, 폴더가 이미 지워져 등록만 남았어도 지운다.
      // 브랜치는 남는다(등록이 사라져야 사람이 그 브랜치를 체크아웃할 수 있다)
      await removeOwnWorktree(run.repoPath, run.worktreePath);
    });
  };

  return { create, commit, merge, preserve, removeWorktree };
};
