// 테스트 변경 알림 (ADR-100 G, NRM-07, M7-13 #225, ADR-113).
// - 사람이 확인한 규칙의 인수 테스트를 에이전트(테스트 작성 역할)가 다시 써도 확인은 풀지 않는다. 대신 확인할 것 목록에 올릴
//   규범 변경 기록 `test_changed`(주체 오케스트레이터, 대상 규칙, 바뀐 파일, 실행 · 테스트 작성 세션)를 남긴다
// - 쓰는 시점: 실행이 병합으로 끝났을 때(`run.saved`에서 상태 `merged`를 처음 본 때). 비교는 실행 시작 때 기준 브랜치 커밋
//   (`baseCommit`)과 병합한 실행 브랜치 끝(`headCommit`)의 대상 규칙 폴더(`bive-acceptance/<규칙 표시 ID>/`)다. 실행 브랜치에서
//   그 폴더를 쓰는 것은 테스트 작성 단계뿐이다(구현 역할은 인수 테스트 쓰기 거부). 바뀜 = 기준 커밋에 있던 파일의 내용이 달라짐
//   (`M` · `T`, 내용 해시가 같은 파일 모드만의 바뀜은 뺀다) · 지움(`D`). 새 파일(`A`)은 처음 쓰는 것이라 넣지 않고, 이름 바꿈은
//   지움 + 새 파일로 본다(`--no-renames`)
//   병합되지 않은 실행(실패 · 예산 초과)의 테스트는 기준 브랜치에 들어가지 않으므로 알림이 없다. 재시도마다 다시 쓴 테스트도
//   병합된 최종 내용 한 번만 본다
// - 실행 1개 · 규칙 1개에 기록 1건이다(같은 실행 · 규칙의 기록이 있으면 남기지 않는다). 기록할 때 규칙이 확인됨이 아니면 남기지
//   않는다(미확인 규칙은 미확인 항목으로 이미 목록에 있다). 사람의 진술 편집으로 시작된 실행(ADR-109)도 대상이다
// - 확인 상태는 실행 생성 · 단계 진행 · 판정 · 병합의 조건이 아니다: 이 모듈은 엔진 · 단계가 아니라 오케스트레이터 배선이 엔진의
//   저장 이벤트를 받아 부르고(엔진은 기다리지 않는다), 실패해도 로그 한 줄만 남긴다
// - 병합 저장 뒤 알림 확인 전에 프로세스가 끝나도 빠지지 않는다 (M3-36 #264, ADR-120): 실행이 `merged`로 저장되는 같은 문장에서
//   DB 트리거가 "확인 전" 표시(`run_test_change_checks`)를 남기고, 알림 기록(없으면 확인만)과 같은 트랜잭션에서 확인을 채운다.
//   기동 때(`recoverPending`) 확인 전 표시가 남은 실행만 같은 방법으로 다시 본다. 실행마다 한 번이다(채운 표시는 다시 보지
//   않고, 기록 함수도 같은 실행 · 규칙의 알림이 있으면 남기지 않는다). git 비교가 실패하면 표시를 채우지 않아 다음 기동에 다시 본다
import {
  type NormChangeEntry,
  NORM_TEST_CHANGE_FILES_MAX,
  type NormTestChangeFile,
  type Run,
  type Step,
  Ulid,
} from '@bive/shared';
import { NotFoundError, openRegistry, type ProjectStore } from '@bive/store';

import type { EngineEvent } from '../engine/types.js';
import { createGitRunner, type GitRunner } from '../git/git-exec.js';
import { withRegisteredProjectStore } from '../ipc/project-store-access.js';
import { ACCEPTANCE_DIR } from '../judge/config.js';

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 규칙 하나의 바뀐 인수 테스트 파일 (경로 순). */
export interface RuleTestChange {
  readonly ruleId: string;
  readonly files: readonly NormTestChangeFile[];
}

const CHANGE_OF: Readonly<Record<string, NormTestChangeFile['change']>> = {
  M: 'modified',
  T: 'modified',
  D: 'removed',
};

/**
 * 두 커밋 사이에 규칙 폴더 안에서 바뀌거나 지워진 파일 (`git diff --raw -z --no-renames`). 새 파일 · 모드만 바뀐 파일(전후 내용
 * 해시가 같음)은 넣지 않는다.
 * @throws {GitCommandError} 커밋이 없음 등
 */
export const changedAcceptanceFiles = async (
  git: GitRunner,
  repoPath: string,
  range: { readonly baseCommit: string; readonly headCommit: string },
  ruleDisplayId: string,
): Promise<NormTestChangeFile[]> => {
  const result = await git(
    [
      '--no-replace-objects',
      'diff',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--raw',
      '--no-abbrev',
      '-z',
      range.baseCommit,
      range.headCommit,
      '--',
      `:(literal)${ACCEPTANCE_DIR}/${ruleDisplayId}/`,
    ],
    { cwd: repoPath },
  );
  const parts = result.stdout.split('\0');
  const files: NormTestChangeFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    // `:<옛 모드> <새 모드> <옛 해시> <새 해시> <상태>` 다음 칸이 경로
    const [, , before, after, status] = (parts[i] ?? '').split(' ');
    const change = CHANGE_OF[status ?? ''];
    const file = parts[i + 1] ?? '';
    if (change === undefined || file === '') continue;
    if (change === 'modified' && before === after) continue;
    files.push({ path: file, change });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

/** 병합한 실행의 테스트 작성 세션: 마지막으로 통과한 테스트 작성 시도의 세션 ID (없으면 `null`). */
export const testWriterSessionOf = (steps: readonly Step[]): string | null => {
  const passed = steps.filter((step) => step.kind === 'test_writing' && step.status === 'passed');
  const last = passed.at(-1);
  const detail = last?.exitDetail;
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return null;
  const sessionId = (detail as Record<string, unknown>).sessionId;
  return Ulid.safeParse(sessionId).success ? (sessionId as string) : null;
};

/**
 * 테스트 변경 알림을 남긴다 (열린 저장소, 트랜잭션 1개). 규칙마다: 바뀐 파일이 있고, 규칙이 있고 삭제되지 않았으며 확인됨이고,
 * 같은 실행 · 규칙의 알림이 아직 없을 때만 1건. 같은 트랜잭션에서 그 실행의 알림 확인을 채운다(확인 전 표시가 있을 때만).
 * @returns 남긴 기록 (규칙 순)
 */
export const recordTestChanges = (
  store: ProjectStore,
  input: {
    readonly run: Pick<Run, 'id'>;
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly sessionId: string | null;
    readonly at: string;
    readonly changes: readonly RuleTestChange[];
  },
): NormChangeEntry[] =>
  store.transaction(() => {
    const recorded: NormChangeEntry[] = [];
    for (const { ruleId, files } of input.changes) {
      if (files.length === 0) continue;
      const rule = store.rules.get(ruleId);
      if (rule === null || rule.deletedAt !== null) continue;
      if (rule.confirmation.state !== 'confirmed') continue;
      const exists = store.normChanges
        .list({ entity: 'Rule', id: ruleId })
        .some((entry) => entry.kind === 'test_changed' && entry.runId === input.run.id);
      if (exists) continue;
      recorded.push(
        store.normChanges.append({
          at: input.at,
          kind: 'test_changed',
          actor: { kind: 'orchestrator' },
          targetRef: { entity: 'Rule', id: ruleId },
          sessionId: input.sessionId,
          runId: input.run.id,
          reason: null,
          detail: {
            testChange: {
              files: files.slice(0, NORM_TEST_CHANGE_FILES_MAX),
              fileCount: files.length,
              baseCommit: input.baseCommit,
              headCommit: input.headCommit,
            },
          },
        }),
      );
    }
    store.runs.markTestChangeChecked(input.run.id, input.at);
    return recorded;
  });

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

export interface TestChangeNotifierOptions {
  /** `$BIVE_HOME` 절대 경로 */
  biveHome: string;
  log: (line: string) => void;
  /** 시계 (ms, 기본 `Date.now`) */
  now?: () => number;
  /** git 실행 함수 (기본 셸 없는 `execFile`) */
  git?: GitRunner;
}

/**
 * 엔진 이벤트 하나를 관찰자에게 넘기고 실행 알림을 발행한다. 관찰자가 동기 예외를 던져도 로그만 남기고 발행은 그대로 한다
 * (테스트 변경 알림은 실행 알림 · 상태에 영향을 주지 않는다).
 */
export const observeThenPublish = (
  observe: (event: EngineEvent) => void,
  publish: (event: EngineEvent) => Promise<void>,
  log: (line: string) => void,
): ((event: EngineEvent) => Promise<void>) => {
  return (event) => {
    try {
      observe(event);
    } catch (error) {
      log(`테스트 변경 알림 관찰 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
    return publish(event);
  };
};

/**
 * 엔진의 저장 이벤트를 받아 병합으로 끝난 실행마다 한 번 테스트 변경 알림을 남긴다. 엔진은 기다리지 않고, 실패는 로그만 남긴다
 * (실행 상태에 영향이 없다). 같은 실행은 이 프로세스에서 한 번만 보고, 기록 함수가 저장소에서도 실행 · 규칙마다 한 번을 지킨다.
 */
export class TestChangeNotifier {
  readonly #biveHome: string;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #git: GitRunner;
  readonly #seen = new Set<string>();
  readonly #pending = new Set<Promise<void>>();

  constructor(options: TestChangeNotifierOptions) {
    this.#biveHome = options.biveHome;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#git = options.git ?? createGitRunner();
  }

  /** 엔진 이벤트 하나. 병합으로 끝난 실행을 처음 보면 기록을 시작한다(기다리지 않는다). */
  observe(event: EngineEvent): void {
    if (event.type !== 'run.saved') return;
    const { run, steps } = event.detail;
    if (run.status !== 'merged') return;
    this.#start(event.projectId, run, steps);
  }

  /**
   * 기동 때 한 번: 등록된 프로젝트마다 알림 확인 전 표시가 남은 병합 실행(앞 프로세스가 병합 저장 뒤 확인을 끝내지 못함)을 병합
   * 순으로 다시 본다(기다리지 않는다). 실행을 다시 시작하거나 재개하지 않는다. 프로젝트 · 실행을 읽지 못하면 로그 한 줄이고 표시는
   * 그대로 남는다(다음 기동에 다시 본다).
   */
  recoverPending(): void {
    let projectIds: string[];
    try {
      projectIds = registeredProjectIds(this.#biveHome);
    } catch (error) {
      this.#log(`테스트 변경 알림 되짚기 실패: ${errorText(error)}`);
      return;
    }
    for (const projectId of projectIds) {
      try {
        const details = withRegisteredProjectStore(this.#biveHome, projectId, (store) =>
          store.runs.pendingTestChangeChecks().flatMap((runId) => {
            const detail = store.runs.getDetail(runId);
            return detail === null ? [] : [detail];
          }),
        );
        for (const { run, steps } of details) {
          if (run.status !== 'merged') continue;
          this.#log(`테스트 변경 알림 되짚기 (${run.displayId}, 재기동)`);
          this.#start(projectId, run, steps);
        }
      } catch (error) {
        this.#log(`테스트 변경 알림 되짚기 실패 (프로젝트 ${projectId}): ${errorText(error)}`);
      }
    }
  }

  #start(projectId: string, run: Run, steps: readonly Step[]): void {
    if (this.#seen.has(run.id)) return;
    this.#seen.add(run.id);
    const task = this.#record(projectId, run, steps).catch((error: unknown) => {
      this.#log(`테스트 변경 알림 실패 (${run.displayId}): ${errorText(error)}`);
    });
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
  }

  /** 진행 중인 기록이 모두 끝날 때까지 (종료 · 시험용). */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }

  async #record(projectId: string, run: Run, steps: readonly Step[]): Promise<void> {
    const { baseCommit, headCommit } = run;
    const at = (): string => new Date(this.#now()).toISOString();
    if (baseCommit === null || headCommit === null) {
      // 비교할 두 커밋이 없다: 알림은 없고 확인만 채운다
      withRegisteredProjectStore(this.#biveHome, projectId, (store) =>
        store.runs.markTestChangeChecked(run.id, at()),
      );
      return;
    }
    const target = withRegisteredProjectStore(this.#biveHome, projectId, (store) => ({
      repoPath: store.projects.get(projectId)?.rootPath ?? null,
      rules: run.targetRuleIds.flatMap((id) => {
        const rule = store.rules.get(id);
        return rule === null ? [] : [{ id, displayId: rule.displayId }];
      }),
    }));
    if (target.repoPath === null) {
      this.#log(`테스트 변경 알림 확인 보류 (${run.displayId}): 프로젝트 폴더를 알 수 없음`);
      return;
    }
    const changes: RuleTestChange[] = [];
    for (const rule of target.rules) {
      const files = await changedAcceptanceFiles(
        this.#git,
        target.repoPath,
        { baseCommit, headCommit },
        rule.displayId,
      );
      if (files.length > 0) changes.push({ ruleId: rule.id, files });
    }
    // 바뀐 파일이 없어도 확인은 채운다 (기록 함수가 같은 트랜잭션에서)
    const recorded = withRegisteredProjectStore(this.#biveHome, projectId, (store) =>
      recordTestChanges(store, {
        run,
        baseCommit,
        headCommit,
        sessionId: testWriterSessionOf(steps),
        at: at(),
        changes,
      }),
    );
    if (recorded.length > 0) {
      this.#log(`테스트 변경 알림 ${String(recorded.length)}건 (${run.displayId})`);
    }
  }
}
