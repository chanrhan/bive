// 판정용 깨끗한 체크아웃 (JDG-01 · RUN-03 · RUN-08, ADR-058 · ADR-066 · ADR-068).
// 판정은 실행 워크트리가 아니라 판정할 커밋의 깨끗한 체크아웃에서 돈다. 실행 워크트리의 되돌리기(`clean -ffd`, `-x` 없음)는
// 무시된 파일(`node_modules` · 빌드 산출물)과 에이전트가 심은 `.gitignore`로 숨긴 소스(예: `src/planted/.gitignore`에
// `*` + `evil.ts`)를 남기므로, 그 위에서 판정하면 커밋에 없는 코드가 결과를 바꿀 수 있다(무시된 파일은 커밋 · 병합에
// 들어가지 않는다). 그래서:
// - 커밋에서 분리된 임시 워크트리를 만든다 (`$BIVE_HOME/work/<projectId>/judge/<EXE-ID>/<ID>`, 추적 파일만)
// - 만든 직후 HEAD가 그 커밋이고 미추적 · 무시된 파일이 하나도 없는지 확인한다
// - 의존성은 실행 워크트리와 공유하지 않고 체크아웃 안에 lockfile 기준으로 새로 설치한다(ADR-024: 설치는 오케스트레이터)
// - 판정이 끝나면 임시 워크트리를 지운다 (판정 결과 원본은 판정 폴더 `projects/<id>/judge/…`에 남는다)
// - `worktree add` · `remove`는 워크트리 관리자와 같은 짧은 저장소 잠금(ADR-065 `worktree:<저장소>`) 안에서 돈다.
//   `worktree add`가 공용 관리 폴더 `.git/worktrees/<이름>/`을 만든 뒤 `commondir`을 쓰기 전에 관리자의
//   `worktree list` · `add` · `lock`이 돌면 그 폴더를 읽지 못해 실패하기 때문이다(분리된 HEAD라도 관리 폴더는 공용이다)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CommitSha, createUlidGenerator } from '@bive/shared';

import { createGitRunner, type GitRunner } from '../git/git-exec.js';
import { withGitWorktreeLock } from '../git/worktree-manager.js';
import { ACCEPTANCE_DIR } from './config.js';
import { baseChildEnv, describeExit, runCommand } from './process.js';

/** 의존성 설치 제한 시간 (기본). */
export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;

/** 판정용 체크아웃 준비 실패. 단계 실행기가 실행 실패 사유로 옮긴다. */
export class JudgeCheckoutError extends Error {
  override readonly name = 'JudgeCheckoutError';
  constructor(
    /** 실패한 단계 */
    readonly stage: 'checkout' | 'install',
    message: string,
  ) {
    super(message);
  }
}

/** 판정용 체크아웃 경로의 부모 `$BIVE_HOME/work/<projectId>/judge/<EXE-ID>`. */
export const judgeCheckoutRoot = (
  biveHome: string,
  projectId: string,
  runDisplayId: string,
): string => path.join(path.resolve(biveHome), 'work', projectId, 'judge', runDisplayId);

export interface JudgeCheckout {
  /** 체크아웃 폴더 (실경로) */
  readonly dir: string;
  readonly commit: string;
  /** 임시 워크트리 등록 · 폴더를 지운다. 여러 번 불러도 된다 */
  dispose(): Promise<void>;
}

export interface CreateJudgeCheckoutInput {
  /** 프로젝트 폴더 (저장소 최상위, ADR-058) */
  repoPath: string;
  biveHome: string;
  projectId: string;
  runDisplayId: string;
  /** 판정할 커밋 */
  commit: string;
  git?: GitRunner;
}

const newId = createUlidGenerator();

/**
 * 커밋의 깨끗한 체크아웃을 만든다 (`git worktree add --detach`). 만든 뒤 HEAD · 깨끗함을 확인하고, 아니면 지우고 던진다.
 * @throws {JudgeCheckoutError} (`checkout`)
 */
export const createJudgeCheckout = async (
  input: CreateJudgeCheckoutInput,
): Promise<JudgeCheckout> => {
  const git = input.git ?? createGitRunner();
  if (!CommitSha.safeParse(input.commit).success) {
    throw new JudgeCheckoutError('checkout', `판정할 커밋이 커밋 해시가 아닙니다: ${input.commit}`);
  }
  const parent = judgeCheckoutRoot(input.biveHome, input.projectId, input.runDisplayId);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const target = path.join(fs.realpathSync.native(parent), newId());
  let registered = false;
  const dispose = async (): Promise<void> => {
    if (registered) {
      registered = false;
      try {
        await withGitWorktreeLock(
          input.repoPath,
          () => git(['worktree', 'remove', '--force', '--force', target], { cwd: input.repoPath }),
          { git },
        );
      } catch {
        // 등록이 이미 없으면 폴더만 지운다 (사용자의 다른 워크트리 정보를 지우는 prune은 쓰지 않는다)
      }
    }
    fs.rmSync(target, { recursive: true, force: true });
  };
  try {
    registered = true;
    await withGitWorktreeLock(
      input.repoPath,
      () =>
        git(['worktree', 'add', '--detach', '--quiet', target, input.commit], {
          cwd: input.repoPath,
        }),
      { git },
    );
    const head = (
      await git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: target })
    ).stdout.trim();
    if (head !== input.commit) {
      throw new Error(`체크아웃 HEAD가 판정할 커밋과 다릅니다: ${head}`);
    }
    // 추적 파일만 있어야 한다: 미추적 · 무시된 파일 · 변경이 하나라도 있으면 거부
    const status = await git(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
      { cwd: target },
    );
    if (status.stdout !== '') {
      throw new Error(
        `체크아웃이 깨끗하지 않습니다: ${status.stdout.split('\0').join(' ').trim()}`,
      );
    }
  } catch (error) {
    await dispose();
    throw new JudgeCheckoutError(
      'checkout',
      `판정용 체크아웃을 만들지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { dir: target, commit: input.commit, dispose };
};

/** 의존성 설치 함수 (`dir`에 설치, 출력은 `logFile`). 시험에서 바꿔 끼운다. */
export type InstallDependencies = (
  dir: string,
  options: { logFile: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<void>;

/**
 * lockfile 기준 의존성 설치. M1은 pnpm(`pnpm-lock.yaml`)만 지원한다: `pnpm install --frozen-lockfile --prefer-offline`.
 * 셸 없이 PATH의 `pnpm`을 실행하고 환경 변수는 판정 러너와 같은 허용 목록 + `CI=1`만 넘긴다.
 * @throws {JudgeCheckoutError} (`install`) lockfile 없음 · 설치 실패 · 시간 초과
 */
export const installDependencies: InstallDependencies = async (dir, options) => {
  if (!fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) {
    throw new JudgeCheckoutError(
      'install',
      '지원하는 lockfile이 없습니다 (M1은 pnpm-lock.yaml만 지원)',
    );
  }
  const result = await runCommand(
    'pnpm',
    ['install', '--frozen-lockfile', '--prefer-offline', '--reporter=append-only'],
    {
      cwd: dir,
      env: { ...baseChildEnv(options.env), CI: '1', NO_COLOR: '1' },
      stdoutFile: options.logFile,
      timeoutMs: options.timeoutMs,
    },
  );
  if (result.timedOut) throw new JudgeCheckoutError('install', '의존성 설치 시간 초과');
  if (result.code !== 0 || result.error !== null) {
    throw new JudgeCheckoutError(
      'install',
      `의존성 설치 실패 (${describeExit(result)}, ${options.logFile})`,
    );
  }
};

/**
 * `bive-acceptance/` 아래 일반 파일(링크 · `node_modules` 제외)의 SHA-256 (상대 경로 `/` 구분 → 16진수).
 * Red 확인 통과 때 기록하고, 검사 단계(#29)가 판정 직전 같은 값인지 대조한다(architecture.md 4장 인수 테스트 보호).
 */
export const hashAcceptanceFiles = (dir: string): Record<string, string> => {
  const root = path.join(dir, ACCEPTANCE_DIR);
  const hashes: Record<string, string> = {};
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(dir, full).split(path.sep).join('/');
        hashes[rel] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(root);
  return hashes;
};
