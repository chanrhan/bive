// 감시자: 기준 브랜치의 사람 커밋 → 재검증 필요 (JDG-02, 기획서 감시자, M3-14 #59, ADR-156).
// 오케스트레이터 프로세스 안의 주기 작업이다. 기동 때 한 번, 그 뒤 앞 회차가 끝나고 5초마다 등록된 프로젝트를 차례로 본다.
// - 비교 기준: 기준 브랜치 머리(`refs/heads/<기준 브랜치>`, git 객체만 읽고 작업 트리를 읽지 않는다)와 판정 기준 커밋(검증 요약의
//   `basisOf`: 가장 나중에 병합된 실행의 병합 커밋). 같으면 아무것도 하지 않는다. BIVE 자신의 병합은 그 병합 커밋이 판정 기준이
//   되므로 여기서 끝난다. 판정 기준이 없거나(병합된 실행 없음) 블록 선언이 없으면 보지 않는다
// - 다르면 블록 대상 규칙(효력 · 내장 아님 · 대상 블록 있음)마다 최신 판정이 표시할 수 있는 판정(재검증 필요 · 격리 아님)이면 본다:
//   - 그 판정의 커밋이 머리를 포함하면(머리 = 판정 커밋이거나 머리가 그 조상) 낡지 않았다. 병합 재검사 판정 · 머리 뒤에 만든 실행의 판정
//   - 판정 기준 커밋이 머리의 조상이 아니면(기준 브랜치를 되감음 · 다시 씀) 닫힌 쪽: 표시한다
//   - 아니면 그 판정 커밋과 머리의 공통 조상에서 머리까지 바뀐 파일(`git diff --name-only`) 가운데 그 규칙의 대상 블록 include에
//     걸리는 파일이 있으면 표시한다. 공통 조상이 없거나 판정 커밋이 저장소에 없으면 닫힌 쪽(표시)
// - 표시 = 실행 밖 재검증 필요 기록 1건(커밋 = 그때의 머리, `judgments/judgment-marks.ts`). 같은 판정을 두 번 표시하지 않는다: 표시된
//   규칙의 최신 판정은 재검증 필요라 다음 회차의 대상이 아니다(저장된 기록이 "어디까지 봤는지"다. 재기동해도 같은 결과). 메모리에는
//   같은 입력(판정 기준 · 머리 · 선언 판 · 대상 규칙과 최신 판정)을 다시 계산하지 않도록 프로젝트마다 마지막 입력만 둔다
// - 자동으로 실행을 만들거나 다시 판정하지 않는다. 재검증 필요는 무엇도 통과시키지 않고 무엇도 막지 않는다
// - 실패해도 죽지 않는다: 프로젝트 하나의 오류(git 오류 · 저장소 없음 · 선언을 못 읽음)는 로그 한 줄(같은 오류는 한 번)이고 다음
//   프로젝트 · 다음 회차로 넘어간다. git 명령마다 제한 시간이 있고, 회차는 겹쳐 돌지 않는다(다음 회차는 앞 회차가 끝난 뒤에 잡는다)
// - 저장소는 다른 처리기와 같은 창구(`withRegisteredProjectStore`)로 열고, 쓰기는 트랜잭션 1개다(쓰기 직전에 최신 판정이 그대로인지
//   다시 본다)
import {
  type Block,
  type BlockDeclaration,
  createUlidGenerator,
  matchesBlockPattern,
} from '@bive/shared';
import { NotFoundError, openRegistry } from '@bive/store';

import { createGitRunner, GitCommandError, type GitRunner } from '../git/git-exec.js';
import { withRegisteredProjectStore } from '../ipc/project-store-access.js';
import {
  blockTargetedCandidates,
  type RecheckMark,
  recordNeedsRecheck,
} from '../judgments/judgment-marks.js';
import { basisOf, mergeRecordOf } from '../verification/summary.js';

/** 감시 주기 (ms). */
export const WATCH_INTERVAL_MS = 5_000;

/** git 명령 하나의 제한 시간 (ms). 넘기면 그 프로젝트의 이번 회차를 건너뛴다. */
export const WATCH_GIT_TIMEOUT_MS = 30_000;

/** 다음 회차를 잡는 함수. 취소 함수를 돌려준다. */
export type WatchScheduler = (run: () => void, ms: number) => () => void;

const defaultScheduler: WatchScheduler = (run, ms) => {
  const timer = setTimeout(run, ms);
  // 감시자만 남았다고 프로세스가 살아 있지 않게 한다 (수명 감시가 종료를 정한다)
  timer.unref();
  return () => clearTimeout(timer);
};

export interface RecheckWatcherOptions {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  log: (line: string) => void;
  /** 주기 (기본 {@link WATCH_INTERVAL_MS}) */
  intervalMs?: number;
  /** 다음 회차를 잡는 함수 (기본 `setTimeout`, 시험이 바꿔 끼운다) */
  schedule?: WatchScheduler;
  /** 시계 (ms, 기본 `Date.now`) */
  now?: () => number;
  newId?: () => string;
  /** git 실행 함수 (기본 셸 없는 `execFile`) */
  git?: GitRunner;
  /** git 명령 하나의 제한 시간 (기본 {@link WATCH_GIT_TIMEOUT_MS}) */
  gitTimeoutMs?: number;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 등록된 프로젝트 ID들. 등록부가 아직 없으면 빈 목록. */
const registeredProjectIds = (biveHome: string): string[] => {
  let registry;
  try {
    registry = openRegistry({ home: biveHome, create: false });
  } catch (error) {
    if (error instanceof NotFoundError) return [];
    throw error;
  }
  try {
    return registry.entries.list().map((entry) => entry.projectId);
  } finally {
    registry.close();
  }
};

/** 파일이 규칙의 대상 블록 include에 걸리는지 (지금 선언에 있는 대상 블록만). */
export const touchesTargetBlocks = (
  targetBlockIds: readonly string[],
  declaration: BlockDeclaration,
  files: readonly string[],
): string[] => {
  const blocks: Block[] = declaration.blocks.filter((block) => targetBlockIds.includes(block.name));
  return files.filter((file) =>
    blocks.some((block) => block.include.some((pattern) => matchesBlockPattern(pattern, file))),
  );
};

/** 한 프로젝트의 저장소에서 읽은 입력. */
interface ProjectSnapshot {
  readonly repoPath: string;
  readonly branch: string;
  readonly basisCommit: string;
  readonly declaration: BlockDeclaration;
  readonly declarationVersion: number;
  readonly candidates: ReturnType<typeof blockTargetedCandidates>;
}

export class RecheckWatcher {
  readonly #biveHome: string;
  readonly #log: (line: string) => void;
  readonly #intervalMs: number;
  readonly #schedule: WatchScheduler;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #git: GitRunner;
  readonly #gitTimeoutMs: number;
  /** 프로젝트 → 마지막으로 끝까지 본 입력 */
  readonly #seen = new Map<string, string>();
  /** 프로젝트 → 마지막으로 남긴 오류 글 (같은 오류는 한 번만 남긴다) */
  readonly #lastError = new Map<string, string>();
  #cancel: (() => void) | null = null;
  #running: Promise<void> | null = null;
  #stopped = false;

  constructor(options: RecheckWatcherOptions) {
    this.#biveHome = options.biveHome;
    this.#log = options.log;
    this.#intervalMs = options.intervalMs ?? WATCH_INTERVAL_MS;
    this.#schedule = options.schedule ?? defaultScheduler;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? createUlidGenerator();
    this.#git = options.git ?? createGitRunner();
    this.#gitTimeoutMs = options.gitTimeoutMs ?? WATCH_GIT_TIMEOUT_MS;
  }

  /** 기동 때 한 번 보고, 끝나면 다음 회차를 잡는다 (기다리지 않는다). 여러 번 불러도 한 번만 시작한다. */
  start(): void {
    if (this.#stopped || this.#cancel !== null || this.#running !== null) return;
    void this.#cycle();
  }

  /** 다음 회차를 잡지 않고, 돌고 있는 회차가 끝나기를 기다린다. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#cancel?.();
    this.#cancel = null;
    await this.#running;
  }

  /**
   * 등록된 프로젝트를 한 번 본다. 회차가 이미 돌고 있으면 새로 시작하지 않고 그 회차를 기다린다(겹쳐 돌지 않는다). 던지지 않는다.
   */
  tick(): Promise<void> {
    this.#running ??= this.#scanAll().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #cycle(): Promise<void> {
    this.#cancel = null;
    await this.tick();
    if (this.#stopped) return;
    this.#cancel = this.#schedule(() => void this.#cycle(), this.#intervalMs);
  }

  async #scanAll(): Promise<void> {
    let projectIds: string[];
    try {
      projectIds = registeredProjectIds(this.#biveHome);
    } catch (error) {
      this.#report('*', `감시자: 등록부를 읽지 못함: ${errorText(error)}`);
      return;
    }
    for (const projectId of projectIds) {
      if (this.#stopped) return;
      try {
        await this.#scanProject(projectId);
        this.#lastError.delete(projectId);
      } catch (error) {
        this.#report(projectId, `감시자: 프로젝트 ${projectId} 건너뜀: ${errorText(error)}`);
      }
    }
  }

  #report(key: string, line: string): void {
    if (this.#lastError.get(key) === line) return;
    this.#lastError.set(key, line);
    this.#log(line);
  }

  #snapshot(projectId: string): ProjectSnapshot | null {
    return withRegisteredProjectStore(this.#biveHome, projectId, (store) => {
      const project = store.getProject();
      if (project === null) return null;
      const declaration = store.blockDeclarations.current();
      if (declaration === null) return null;
      const steps = store.runs.stepsOfMergedRuns();
      const basis = basisOf(store.runs.list(), {
        mergeOf: (run) => mergeRecordOf(run, steps.get(run.id) ?? []),
        branch: project.baseBranch,
      });
      if (basis === null) return null;
      return {
        repoPath: project.rootPath,
        branch: project.baseBranch,
        basisCommit: basis.commit,
        declaration: declaration.declaration,
        declarationVersion: declaration.version,
        candidates: blockTargetedCandidates(store),
      };
    });
  }

  async #scanProject(projectId: string): Promise<void> {
    const snapshot = this.#snapshot(projectId);
    if (snapshot === null || snapshot.candidates.length === 0) return;
    const head = await this.#head(snapshot.repoPath, snapshot.branch);
    if (head === snapshot.basisCommit) return;
    const input = [
      snapshot.basisCommit,
      head,
      String(snapshot.declarationVersion),
      ...snapshot.candidates.map(({ rule, latest }) => `${rule.id}:${latest.id}`),
    ].join('|');
    if (this.#seen.get(projectId) === input) return;

    const repo = snapshot.repoPath;
    const rewound = !(await this.#isAncestor(repo, snapshot.basisCommit, head));
    const changedSince = new Map<string, string[]>();
    const marks: RecheckMark[] = [];
    for (const { rule, latest } of snapshot.candidates) {
      if (latest.commit === head || (await this.#isAncestor(repo, head, latest.commit))) continue;
      if (rewound) {
        marks.push({ rule, latest, commit: head });
        continue;
      }
      const base = await this.#mergeBase(repo, latest.commit, head);
      if (base === null) {
        marks.push({ rule, latest, commit: head });
        continue;
      }
      let files = changedSince.get(base);
      if (files === undefined) {
        files = await this.#changedFiles(repo, base, head);
        changedSince.set(base, files);
      }
      if (touchesTargetBlocks(rule.targetBlockIds, snapshot.declaration, files).length > 0) {
        marks.push({ rule, latest, commit: head });
      }
    }
    if (marks.length > 0) {
      // 쓰기는 트랜잭션 1개이고, 쓰기 직전에 규칙마다 최신 판정이 그대로인지 다시 본다(그 사이 새 판정이 생긴 규칙은 표시하지 않는다)
      const recorded = withRegisteredProjectStore(this.#biveHome, projectId, (store) =>
        store.transaction(() =>
          recordNeedsRecheck(store, marks, { now: this.#now(), newId: this.#newId }),
        ),
      );
      if (recorded.length > 0) {
        this.#log(
          `감시자: 재검증 필요 ${String(recorded.length)}건 (프로젝트 ${projectId}, 머리 ${head.slice(0, 12)})`,
        );
      }
    }
    this.#seen.set(projectId, input);
  }

  async #run(repo: string, args: readonly string[], okCodes: readonly number[] = [0]) {
    return this.#git(args, { cwd: repo, okCodes, timeoutMs: this.#gitTimeoutMs });
  }

  /** 기준 브랜치 머리 커밋. 브랜치가 없으면 오류(이번 회차를 건너뛴다). */
  async #head(repo: string, branch: string): Promise<string> {
    const result = await this.#run(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}^{commit}`,
    ]);
    return result.stdout.trim();
  }

  /** `ancestor`가 `commit`의 조상(또는 같음)인지. 커밋이 저장소에 없으면 `false`(닫힌 쪽). */
  async #isAncestor(repo: string, ancestor: string, commit: string): Promise<boolean> {
    try {
      const result = await this.#run(
        repo,
        ['merge-base', '--is-ancestor', ancestor, commit],
        [0, 1],
      );
      return result.code === 0;
    } catch (error) {
      if (error instanceof GitCommandError && error.result.code === 128) return false;
      throw error;
    }
  }

  /** 두 커밋의 공통 조상. 없거나 커밋이 저장소에 없으면 `null`. */
  async #mergeBase(repo: string, a: string, b: string): Promise<string | null> {
    try {
      const result = await this.#run(repo, ['merge-base', a, b], [0, 1]);
      const base = result.stdout.trim();
      return result.code === 0 && base !== '' ? base : null;
    } catch (error) {
      if (error instanceof GitCommandError && error.result.code === 128) return null;
      throw error;
    }
  }

  /** 두 커밋 사이에 바뀐 파일 (지운 · 새 파일 포함, 이름 바꿈은 두 경로). */
  async #changedFiles(repo: string, from: string, to: string): Promise<string[]> {
    const result = await this.#run(repo, [
      '--no-replace-objects',
      'diff',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--name-only',
      '-z',
      from,
      to,
    ]);
    return result.stdout.split('\0').filter((file) => file !== '');
  }
}
