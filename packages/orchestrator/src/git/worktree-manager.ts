// 실행 브랜치 · 워크트리 · 커밋 · 병합 관리자 (RUN-08 · ADR-017 · ADR-025 · ADR-058).
// - 실행 1개 = 브랜치 `bive/run-<EXE-ID>` 1개 + 프로젝트 폴더 밖 워크트리 `$BIVE_HOME/work/<projectId>/worktrees/<EXE-ID>`
// - 커밋은 이 모듈의 `commit`만 만든다(에이전트에게는 git 도구가 없다). 주체는 BIVE 고정 값
// - `merge`: 기준 브랜치가 그대로면 `--no-ff` 병합 커밋, 바뀌었으면 병합 결과로 주입된 검사를 다시 돌려 통과할 때만 갱신.
//   충돌 · 더러운 프로젝트 폴더 · 검사 실패는 기준 브랜치를 건드리지 않고 `failed` + 사유, 실행 브랜치는 보존한다
// - 저장소(DB)와 연결하지 않는다. 입력은 실행 · 프로젝트 레코드에서 뽑은 값이고 실행 엔진(#27)이 넘긴다
// - 잠금 3종(ADR-065): 저장소 병합 대기열(`merge`), 실행 대기열(같은 실행의 `merge` · `preserve` · `removeWorktree`),
//   `git worktree` 하위 명령의 짧은 저장소 잠금. 키는 git 공통 폴더의 `dev:ino`다
import { AsyncLocalStorage } from 'node:async_hooks';
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
  | 'worktree_branch_mismatch'
  /** 병합 검사 함수 안에서 같은 대기열을 다시 잡는 호출(교착)을 막았다 (ADR-065) */
  | 'reentrant_call';

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
  /**
   * 제한 시간(`checkTimeoutMs`)이 지나거나 호출자가 `signal`로 중단하면 중단된다. 검사 함수는 이 신호를 받으면
   * 러너를 멈춰야 한다: 관리자는 결과를 기다리지 않고 임시 워크트리를 지운 뒤 대기열을 넘긴다
   */
  signal: AbortSignal;
}

export interface MergeCheckResult {
  passed: boolean;
  /** 실패 사유 등 기록용 문장 */
  detail?: string;
}

/**
 * 검사 함수. 실행 엔진이 판정 러너를 감싸 넘긴다(M1-16).
 * 같은 저장소의 병합 대기열을 잡은 채 불리므로, 안에서 같은 관리자(다른 인스턴스 포함)의 `merge`나 같은 실행의
 * `preserve` · `removeWorktree`를 부르면 교착이 된다. 그런 호출은 `reentrant_call`로 거부된다(ADR-065).
 */
export type MergeCheck = (context: MergeCheckContext) => Promise<MergeCheckResult>;

export interface MergeOptions {
  /** 기준 브랜치가 바뀐 경우에만 병합 결과로 실행한다 (ADR-017) */
  check: MergeCheck;
  /**
   * 검사 제한 시간(ms, 양의 정수). 지나면 검사 신호를 중단하고 `check_timeout`으로 끝낸다.
   * 없으면 제한하지 않는다: 멈춘 검사는 같은 저장소의 다른 병합을 막으므로 호출자(#27 · #29)가 정한다(ADR-065)
   */
  checkTimeoutMs?: number;
  /** 호출자의 중단 신호. 기준 브랜치를 갱신하기 전에 중단되면 `aborted`로 끝낸다(대기열에서 기다리는 중 포함) */
  signal?: AbortSignal;
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
  /**
   * 실행 브랜치가 기준 브랜치 끝(또는 프로젝트 폴더)의 무시 규칙에 걸리는 경로를 새로 추적한다. 병합하면 사용자가
   * 기준 브랜치를 체크아웃할 때 그 자리의 로컬 파일(예: 로컬 DB)이 말없이 바뀐다 (`files`, ADR-065)
   */
  | 'ignored_path_tracked'
  /** 병합 결과로 다시 돌린 검사가 실패했다 */
  | 'check_failed'
  /** 검사 함수가 예외를 던졌다 */
  | 'check_error'
  /** 검사가 제한 시간(`checkTimeoutMs`) 안에 끝나지 않았다 */
  | 'check_timeout'
  /** 호출자가 기준 브랜치 갱신 전에 중단했다 (`signal`) */
  | 'aborted'
  /** 병합하는 동안 기준 브랜치가 다시 바뀌었다 */
  | 'base_changed'
  /**
   * 기준 브랜치를 갱신하지 못했거나 갱신을 확인하지 못했다
   * (예: 덮어쓸 미추적 · 무시된 파일, 갱신 직전 · 순간의 프로젝트 폴더 체크아웃 변경. 참조만 갱신한 순간 기준 브랜치가
   * 체크아웃돼 색인이 병합 커밋과 다르면 갱신을 되돌린 뒤 이 사유로 끝낸다, ADR-065)
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
      /**
       * 충돌 파일 (`conflict`), 더러운 파일 (`project_dirty` · `run_worktree_dirty`) 또는
       * 무시 규칙에 걸리는 새 추적 파일 (`ignored_path_tracked`)
       */
      files?: string[];
      /** 검사 결과의 사유 (`check_failed` · `check_error` · `check_timeout`) */
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
 * 프로세스 안 잠금(Promise 체인). 오케스트레이터는 사용자당 프로세스 1개(pid 잠금, ADR-041)라 프로세스 안 잠금으로
 * 충분하고, 관리자 인스턴스가 여럿이어도 같은 잠금을 쓰도록 모듈에 둔다. 키 공간은 셋이다(ADR-065).
 * - `merge:<저장소>`: 같은 저장소의 병합을 하나씩. `git merge`는 색인을 쓴 뒤에야 참조를 비교 후 교체하므로, 겹친 병합은
 *   늦은 쪽의 참조 갱신 실패와 상관없이 프로젝트 폴더 색인 · 작업 트리를 덮어쓸 수 있다. 검사가 오래 걸려도 잡고 있다
 * - `run:<저장소>:<EXE-ID>`: 같은 실행의 `merge` · `preserve` · `removeWorktree`(같은 임시 병합 워크트리 · 실행 워크트리를
 *   지우거나 잠근다). 다른 실행의 보존 · 제거는 병합 검사가 멈춰도 기다리지 않는다
 * - `worktree:<저장소>`: `git worktree` 하위 명령(add · list · remove · lock). `worktree add`가 관리 폴더를 만든 뒤
 *   `commondir`을 쓰기 전에 같은 저장소의 다른 `worktree` 명령이 돌면 그 폴더를 읽지 못해 실패한다(종료 코드 128).
 *   `worktree` 명령과 그 앞뒤 확인(등록 찾기 · 존재 확인) 동안만 잡는 짧은 잠금이고, 잡은 채 다른 잠금을 기다리지 않는다
 */
const lockQueues = new Map<string, Promise<void>>();

interface HeldLock {
  key: string;
  active: boolean;
}

/** 지금 비동기 문맥이 잡고 있는 잠금들. 검사 함수 안의 재진입(교착)을 알아낸다. */
const heldLocks = new AsyncLocalStorage<readonly HeldLock[]>();

const holds = (key: string): boolean =>
  (heldLocks.getStore() ?? []).some((held) => held.active && held.key === key);

class LockWaitAborted extends Error {
  override readonly name = 'LockWaitAborted';
}

/** 앞선 작업이 끝나기를 기다린다. 신호가 중단되면 기다리기를 그만두고 `LockWaitAborted`를 던진다. */
const waitTurn = (previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> => {
  if (signal === undefined) return previous;
  if (signal.aborted) return Promise.reject(new LockWaitAborted());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new LockWaitAborted());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
};

const withLock = async <T>(
  key: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  const previous = lockQueues.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 기다리다 중단해도 뒤 작업은 앞선 작업이 끝난 뒤에 시작한다
  const tail = previous.then(() => done);
  lockQueues.set(key, tail);
  const held: HeldLock = { key, active: true };
  try {
    await waitTurn(previous, signal);
    return await heldLocks.run([...(heldLocks.getStore() ?? []), held], task);
  } finally {
    // 잠금을 푼 뒤에 남은 비동기 작업(검사 함수가 띄운 일)은 재진입으로 보지 않는다
    held.active = false;
    release();
    if (lockQueues.get(key) === tail) lockQueues.delete(key);
  }
};

/** `git worktree` 하위 명령 잠금. 이미 잡고 있으면 다시 잡지 않는다(관리자 내부 호출의 겹침). */
const withWorktreeLock = <T>(repoKey: string, task: () => Promise<T>): Promise<T> => {
  const key = `worktree:${repoKey}`;
  return holds(key) ? task() : withLock(key, task);
};

/** 같은 실행 · 같은 저장소의 병합 대기열을 이미 잡은 문맥(검사 함수 안)에서 다시 잡으려 하면 교착이므로 거부한다. */
const assertNotReentrant = (keys: readonly string[], operation: string): void => {
  if (keys.some(holds)) {
    throw new GitWorktreeError(
      'reentrant_call',
      `병합 검사 함수 안에서 같은 대기열을 잡는 ${operation}을(를) 부를 수 없습니다 (교착)`,
    );
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

/** 검사를 마친 실행 참조(프로젝트 폴더 실경로)와 그 저장소의 잠금 키. */
interface Prepared {
  run: RunGitRef;
  repoKey: string;
}

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

/** NUL로 나뉜 git 출력의 빈 값이 아닌 필드. */
const nulFields = (stdout: string): string[] => stdout.split('\0').filter((f) => f !== '');

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/** 다른 git의 `worktree add`가 관리 폴더를 반쯤 만든 순간에 `worktree list`가 실패한 경우. */
const isHalfCreatedWorktreeError = (error: unknown): boolean =>
  error instanceof GitCommandError && /failed to read .*commondir/u.test(error.result.stderr);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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

  /**
   * 등록된 워크트리 목록. BIVE끼리의 겹침은 `git worktree` 잠금이 막고, 사용자 git의 `worktree add`가 관리 폴더를
   * 반쯤 만든 순간에 걸리면 잠깐 뒤 다시 읽는다(읽기라 다시 해도 안전하다).
   */
  const listWorktrees = (repoPath: string, repoKey: string): Promise<WorktreeEntry[]> =>
    withWorktreeLock(repoKey, async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return parseWorktreeList(
            (await git(['worktree', 'list', '--porcelain', '-z'], { cwd: repoPath })).stdout,
          );
        } catch (error) {
          if (attempt >= 2 || !isHalfCreatedWorktreeError(error)) throw error;
          await sleep(100 * (attempt + 1));
        }
      }
    });

  /**
   * 대기열 · 잠금 키: git 공통 폴더(`rev-parse --git-common-dir`)의 `dev:ino`. 심볼릭 링크 · 바인드 마운트 등 다른 경로로
   * 연 같은 저장소도 같은 키가 된다(같은 저장소의 다른 워크트리를 프로젝트로 연 경우도). 파일 시스템이 inode를
   * 주지 않으면(0) 공통 폴더 실경로 문자열을 쓴다.
   */
  const repoKeyOf = async (repoPath: string): Promise<string> => {
    const commonDir = path.resolve(
      repoPath,
      await out(repoPath, ['rev-parse', '--git-common-dir']),
    );
    const stat = fs.statSync(commonDir, { bigint: true });
    return stat.ino === 0n
      ? `path:${comparable(realOrResolved(commonDir))}`
      : `${String(stat.dev)}:${String(stat.ino)}`;
  };

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
  const prepareRef = async (run: RunGitRef): Promise<Prepared> => {
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
    return { run: { ...run, repoPath, worktreePath }, repoKey: await repoKeyOf(repoPath) };
  };

  /**
   * BIVE가 만든 워크트리 하나를 지운다. 잠긴 등록 · 폴더가 이미 지워진 등록(`--force --force`는 둘 다 지운다)과
   * 등록 없이 폴더만 남은 경우도 정리한다. 사용자의 다른 워크트리 정보를 지우는 `git worktree prune`은 쓰지 않는다.
   * 그 자리가 심볼릭 링크면 git에 넘기지 않고 링크만 지운다(git은 링크를 따라가 가리키는 워크트리를 지운다).
   * 등록은 git이 기록한 경로 문자열과 정확히 같은 것만 지운다.
   */
  const removeOwnWorktree = (repoPath: string, repoKey: string, target: string): Promise<void> =>
    withWorktreeLock(repoKey, async () => {
      if (isSymbolicLink(target)) {
        fs.unlinkSync(target);
      }
      const registered = (await listWorktrees(repoPath, repoKey)).some((entry) =>
        sameRecordedPath(entry.path, target),
      );
      if (registered) {
        await git(['worktree', 'remove', '--force', '--force', target], { cwd: repoPath });
      }
      fs.rmSync(target, { recursive: true, force: true });
    });

  /** 병합용 임시 워크트리를 지운다. */
  const removeMergeWorktree = ({ run, repoKey }: Prepared): Promise<void> =>
    removeOwnWorktree(
      run.repoPath,
      repoKey,
      mergeWorktreePath(biveHome, run.projectId, run.runDisplayId),
    );

  /** 기준 브랜치가 체크아웃된 곳: 프로젝트 폴더 · 다른 워크트리 · 없음 (`worktree list`로 매번 새로 읽는다). */
  const locateBase = async (
    { run, repoKey }: Prepared,
    baseRef: string,
  ): Promise<{ kind: 'project' } | { kind: 'elsewhere'; path: string } | { kind: 'none' }> => {
    const holders = (await listWorktrees(run.repoPath, repoKey)).filter(
      (entry) => entry.branch === baseRef,
    );
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
    const repoKey = await repoKeyOf(repoPath);

    // 확인부터 생성까지 `git worktree` 잠금 안에서 한다: 같은 저장소의 다른 `worktree` 명령이 반쯤 만든 관리 폴더를
    // 읽지 않게 하고, 같은 실행 ID를 동시에 만들 때 늦은 쪽이 앞선 쪽의 브랜치를 지우지 않게 한다(ADR-065)
    const baseCommit = await withWorktreeLock(repoKey, async () => {
      const tipCommit = await resolveCommit(repoPath, `refs/heads/${input.baseBranch}`);
      if (tipCommit === null) {
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
      try {
        // 기준 브랜치 이름이 아니라 방금 읽은 커밋에서 만든다(그 사이 기준 브랜치가 움직여도 baseCommit과 일치)
        await git(['worktree', 'add', '-b', branch, worktreePath, tipCommit], { cwd: repoPath });
      } catch (error) {
        // `worktree add -b`는 브랜치를 먼저 만들고 실패할 수 있다(사용자 git의 `worktree` 명령과 겹친 경우 등).
        // 남은 등록 · 폴더와 방금 만든 브랜치를 지워 같은 실행 ID로 다시 만들 수 있게 한다. 정리 실패는 원래 오류를 가리지 않는다
        await removeOwnWorktree(repoPath, repoKey, worktreePath).catch(() => undefined);
        // 비교 후 삭제(아직 기준 커밋을 가리킬 때만). `branch -D`와 달리 다른 워크트리 관리 폴더를 읽지 않는다
        await git(['update-ref', '-d', `refs/heads/${branch}`, tipCommit], {
          cwd: repoPath,
          okCodes: [0, 1, 128],
        }).catch(() => undefined);
        throw error;
      }
      return tipCommit;
    });

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
    const { run } = await prepareRef(input);
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

  const runLockKey = ({ run, repoKey }: Prepared): string => `run:${repoKey}:${run.runDisplayId}`;
  const mergeLockKey = ({ repoKey }: Prepared): string => `merge:${repoKey}`;

  /**
   * 같은 실행의 보존 · 제거, 같은 저장소의 다른 병합이 끝난 뒤에 실행한다(ADR-065). 대기열에서 기다리는 동안
   * `signal`이 중단되면 아무것도 하지 않고 `aborted`를 돌려준다.
   */
  const merge = async (input: RunGitRef, mergeOptions: MergeOptions): Promise<MergeResult> => {
    const timeoutMs = mergeOptions.checkTimeoutMs;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new GitWorktreeError(
        'invalid_input',
        `검사 제한 시간은 양의 정수(ms)여야 합니다: ${String(timeoutMs)}`,
      );
    }
    const prepared = await prepareRef(input);
    const runKey = runLockKey(prepared);
    const mergeKey = mergeLockKey(prepared);
    assertNotReentrant([runKey, mergeKey], 'merge');
    const { signal } = mergeOptions;
    try {
      return await withLock(
        runKey,
        () => withLock(mergeKey, () => mergeSerialized(prepared, mergeOptions), signal),
        signal,
      );
    } catch (error) {
      if (!(error instanceof LockWaitAborted)) throw error;
      return {
        status: 'failed',
        reason: 'aborted',
        message: '병합을 시작하기 전에 중단됐습니다',
        branch: prepared.run.branch,
        headCommit: null,
      };
    }
  };

  /** 검사 함수를 제한 시간 · 중단 신호와 함께 돌린다. 끝나기를 기다리지 않고 돌아오는 경우 검사 신호를 중단한다. */
  const runCheck = async (
    check: MergeCheck,
    context: Omit<MergeCheckContext, 'signal'>,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<
    | { kind: 'result'; result: MergeCheckResult }
    | { kind: 'error'; error: unknown }
    | { kind: 'timeout' }
    | { kind: 'aborted' }
  > => {
    const controller = new AbortController();
    let stop = (): void => undefined;
    const stopped = new Promise<{ kind: 'timeout' } | { kind: 'aborted' }>((resolve) => {
      const onAbort = (): void => {
        controller.abort(signal?.reason);
        resolve({ kind: 'aborted' });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              controller.abort(new Error(`검사 제한 시간 초과 (${String(timeoutMs)}ms)`));
              resolve({ kind: 'timeout' });
            }, timeoutMs);
      stop = (): void => {
        signal?.removeEventListener('abort', onAbort);
        if (timer !== undefined) clearTimeout(timer);
      };
      if (signal?.aborted === true) onAbort();
    });
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => check({ ...context, signal: controller.signal }))
          .then(
            (result) => ({ kind: 'result' as const, result }),
            (error: unknown) => ({ kind: 'error' as const, error }),
          ),
        stopped,
      ]);
    } finally {
      stop();
      // 결과를 기다리지 않고 돌아가는 경우(제한 시간 · 중단) 검사 함수가 러너를 멈추게 한다
      if (!controller.signal.aborted) controller.abort(new Error('병합 검사 종료'));
    }
  };

  /**
   * 참조만 갱신한 직후, 그 순간 기준 브랜치를 체크아웃한 작업 트리가 있는지 본다. 갱신 전에 체크아웃했다면 그 색인 · 작업
   * 트리는 이전 끝에 머물러(병합 파일이 삭제 스테이지로 보임) 다음 커밋이 병합을 말없이 되돌린다. 색인이 병합 커밋과
   * 같으면 갱신 뒤에 체크아웃한 것이라 괜찮다. 확인할 수 없으면 낡은 것으로 본다.
   */
  const staleBaseCheckouts = async (
    prepared: Prepared,
    baseRef: string,
    mergeCommit: string,
  ): Promise<string[]> => {
    const holders = (await listWorktrees(prepared.run.repoPath, prepared.repoKey)).filter(
      (entry) => entry.branch === baseRef && existsPath(entry.path),
    );
    const stale: string[] = [];
    for (const holder of holders) {
      const same = await git(['diff', '--cached', '--quiet', mergeCommit, '--'], {
        cwd: holder.path,
        okCodes: [0, 1],
      }).then(
        (result) => result.code === 0,
        () => false,
      );
      if (!same) stale.push(holder.path);
    }
    return stale;
  };

  /**
   * 병합 결과가 기준 브랜치 끝에 없던 경로 중 무시 규칙에 걸리는 것. 규칙은 기준 브랜치 끝을 체크아웃한 임시 워크트리
   * (추적된 `.gitignore`)와 프로젝트 폴더(지금 작업 트리의 `.gitignore` · 미추적 `.gitignore`)에서 각각 읽고 합친다.
   * 둘 다 `.git/info/exclude` · 사용자 전역 `core.excludesFile`도 본다. `--no-index`라 추적 여부와 상관없이 규칙만 본다.
   */
  const newlyTrackedIgnored = async (
    run: RunGitRef,
    basePath: string,
    baseTip: string,
    mergeTree: string,
  ): Promise<string[]> => {
    const added = nulFields(
      (
        await git(
          [
            'diff-tree',
            '-r',
            '--name-only',
            '--no-renames',
            '--diff-filter=A',
            '-z',
            baseTip,
            mergeTree,
          ],
          { cwd: run.repoPath },
        )
      ).stdout,
    );
    if (added.length === 0) return [];
    const input = `${added.join('\0')}\0`;
    const ignored = new Set<string>();
    for (const cwd of [basePath, run.repoPath]) {
      const result = await git(['check-ignore', '--no-index', '--stdin', '-z'], {
        cwd,
        okCodes: [0, 1],
        input,
      });
      for (const file of nulFields(result.stdout)) ignored.add(file);
    }
    return added.filter((file) => ignored.has(file));
  };

  const mergeSerialized = async (
    prepared: Prepared,
    mergeOptions: MergeOptions,
  ): Promise<MergeResult> => {
    const { run } = prepared;
    const { signal } = mergeOptions;
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
    const abortedResult = (): MergeResult =>
      fail('aborted', '기준 브랜치를 갱신하기 전에 병합이 중단됐습니다');
    const isAborted = (): boolean => signal?.aborted === true;

    let mergeWorktreeCreated = false;
    try {
      if (isAborted()) return abortedResult();
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
      const initialLocation = await locateBase(prepared, baseRef);
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
        const files = [...new Set(nulFields(preview.stdout).slice(1))];
        return fail('conflict', '기준 브랜치와 충돌합니다', { files });
      }
      // 충돌이 없으면 출력은 병합 결과 트리 하나다
      const mergeTree = preview.stdout.split('\0')[0] ?? '';
      if (!OBJECT_ID.test(mergeTree)) {
        return fail('git_error', `병합 결과 트리를 읽지 못했습니다: ${mergeTree}`);
      }

      if (isAborted()) return abortedResult();
      // 병합 커밋은 기준 브랜치 커밋에서 분리된 임시 워크트리에서 `--no-ff`로 만든다
      const mergePath = mergeWorktreePath(biveHome, run.projectId, run.runDisplayId);
      await removeMergeWorktree(prepared);
      fs.mkdirSync(path.dirname(mergePath), { recursive: true, mode: 0o700 });
      mergeWorktreeCreated = true;
      await withWorktreeLock(prepared.repoKey, () =>
        git(['worktree', 'add', '--detach', mergePath, baseTip], { cwd: run.repoPath }),
      );

      // 병합하기 전(임시 워크트리가 기준 브랜치 끝일 때) 무시 규칙을 본다
      const ignoredFiles = await newlyTrackedIgnored(run, mergePath, baseTip, mergeTree);
      if (ignoredFiles.length > 0) {
        return fail(
          'ignored_path_tracked',
          '실행 브랜치가 기준 브랜치에서 무시되던 경로를 새로 추적합니다 (병합하면 그 자리의 로컬 파일이 바뀔 수 있음)',
          { files: ignoredFiles },
        );
      }

      await git(
        ['merge', '--no-ff', '--no-edit', '--no-verify', '-m', mergeMessage(run), headCommit],
        {
          cwd: mergePath,
        },
      );
      const mergeCommit = await out(mergePath, ['rev-parse', 'HEAD']);

      if (baseChanged) {
        const outcome = await runCheck(
          mergeOptions.check,
          { run, worktreePath: mergePath, mergeCommit, baseCommit: baseTip, headCommit },
          mergeOptions.checkTimeoutMs,
          signal,
        );
        if (outcome.kind === 'aborted') return abortedResult();
        if (outcome.kind === 'timeout') {
          return fail('check_timeout', '병합 결과 검사가 제한 시간 안에 끝나지 않았습니다', {
            checkDetail: `제한 시간 ${String(mergeOptions.checkTimeoutMs)}ms`,
          });
        }
        if (outcome.kind === 'error') {
          return fail('check_error', '병합 결과 검사 중 오류가 났습니다', {
            checkDetail: errorText(outcome.error),
          });
        }
        if (!outcome.result.passed) {
          return fail(
            'check_failed',
            '병합 결과 검사가 실패했습니다',
            outcome.result.detail === undefined ? {} : { checkDetail: outcome.result.detail },
          );
        }
      }

      if (isAborted()) return abortedResult();
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
      const location = await locateBase(prepared, baseRef);
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

      // 참조만 갱신했는데 그 순간 누군가 기준 브랜치를 체크아웃했으면(갱신 전 내용으로) 갱신을 되돌린다(ADR-065)
      if (!fastForward) {
        const stale = await staleBaseCheckouts(prepared, baseRef, mergeCommit);
        if (stale.length > 0) {
          // 비교 후 교체: 아직 병합 커밋을 가리킬 때만 이전 끝으로 돌린다
          const reverted = await git(
            [
              'update-ref',
              '-m',
              `bive: ${run.runDisplayId} 병합 되돌림`,
              baseRef,
              baseTip,
              mergeCommit,
            ],
            { cwd: run.repoPath, okCodes: [0, 1, 128] },
          );
          const where = stale.join(', ');
          return fail(
            'base_update_failed',
            reverted.code === 0
              ? `기준 브랜치를 갱신하는 순간 ${where}에 체크아웃되어(색인이 병합 커밋과 다름) 갱신을 되돌렸습니다`
              : `기준 브랜치를 갱신하는 순간 ${where}에 체크아웃되었고, 기준 브랜치가 다시 바뀌어 갱신을 되돌리지 못했습니다 (병합 커밋 ${mergeCommit}, 이전 커밋 ${baseTip})`,
          );
        }
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
        await removeMergeWorktree(prepared).catch(() => undefined);
      }
    }
  };

  // 보존 · 제거는 그 실행의 임시 병합 워크트리 · 실행 워크트리만 다루므로 같은 실행의 대기열만 쓴다. 다른 실행의 병합
  // 검사가 오래 걸리거나 멈춰도 기다리지 않는다(`git worktree` 명령은 짧은 저장소 잠금으로 겹치지 않는다, ADR-065).
  // `create` · `commit`은 프로젝트 폴더 색인 · 작업 트리를 건드리지 않으므로 대기열에 넣지 않는다
  const preserve = async (input: RunGitRef): Promise<PreserveResult> => {
    const prepared = await prepareRef(input);
    const runKey = runLockKey(prepared);
    assertNotReentrant([runKey], 'preserve');
    return withLock(runKey, () => preserveSerialized(prepared));
  };

  const preserveSerialized = async (prepared: Prepared): Promise<PreserveResult> => {
    const { run, repoKey } = prepared;
    const headCommit = await resolveCommit(run.repoPath, `refs/heads/${run.branch}`);
    if (headCommit === null) {
      throw new GitWorktreeError('branch_missing', `실행 브랜치가 없습니다: ${run.branch}`);
    }
    await removeMergeWorktree(prepared);
    const present = await withWorktreeLock(repoKey, async () => {
      const entry = (await listWorktrees(run.repoPath, repoKey)).find((item) =>
        sameRecordedPath(item.path, run.worktreePath),
      );
      // 그 자리가 링크면 BIVE 워크트리가 아니다(링크를 따라가 다른 워크트리를 잠그지 않는다)
      const found =
        entry !== undefined && existsPath(run.worktreePath) && !isSymbolicLink(run.worktreePath);
      if (found && !entry.locked) {
        await git(
          ['worktree', 'lock', '--reason', `BIVE 실행 ${run.runDisplayId} 보존`, run.worktreePath],
          {
            cwd: run.repoPath,
          },
        );
      }
      return found;
    });
    return {
      branch: run.branch,
      headCommit,
      worktreePath: present ? run.worktreePath : null,
      baseCommit: await resolveCommit(run.repoPath, `refs/heads/${run.baseBranch}`),
    };
  };

  const removeWorktree = async (input: RunGitRef): Promise<void> => {
    const prepared = await prepareRef(input);
    const runKey = runLockKey(prepared);
    assertNotReentrant([runKey], 'removeWorktree');
    await withLock(runKey, async () => {
      await removeMergeWorktree(prepared);
      // 잠금(`preserve`) · 미추적 파일(node_modules 등)이 있어도, 폴더가 이미 지워져 등록만 남았어도 지운다.
      // 브랜치는 남는다(등록이 사라져야 사람이 그 브랜치를 체크아웃할 수 있다)
      await removeOwnWorktree(prepared.run.repoPath, prepared.repoKey, prepared.run.worktreePath);
    });
  };

  return { create, commit, merge, preserve, removeWorktree };
};
