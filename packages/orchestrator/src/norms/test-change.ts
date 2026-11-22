// 테스트 변경 알림 (ADR-100 G, NRM-07, M7-13 #225, ADR-113).
// - 사람이 확인한 규칙의 인수 테스트를 에이전트(테스트 작성 역할)가 다시 써도 확인은 풀지 않는다. 대신 확인할 것 목록에 올릴
//   규범 변경 기록 `test_changed`(주체 오케스트레이터, 대상 규칙, 바뀐 파일, 실행 · 테스트 작성 세션)를 남긴다
// - 쓰는 시점: 실행이 병합으로 끝났을 때(`run.saved`에서 상태 `merged`를 처음 본 때). 비교는 실행 시작 때 기준 브랜치 커밋
//   (`baseCommit`)과 병합한 실행 브랜치 끝(`headCommit`)의 대상 규칙 폴더(`bive-acceptance/<규칙 표시 ID>/`)다. 실행 브랜치에서
//   그 폴더를 쓰는 것은 테스트 작성 단계뿐이다(구현 역할은 인수 테스트 쓰기 거부). 바뀜 = 기준 커밋에 있던 파일의 내용이 달라짐
//   (`M` · `T`) · 지움(`D`). 새 파일(`A`)은 처음 쓰는 것이라 넣지 않고, 이름 바꿈은 지움 + 새 파일로 본다(`--no-renames`)
//   병합되지 않은 실행(실패 · 예산 초과)의 테스트는 기준 브랜치에 들어가지 않으므로 알림이 없다. 재시도마다 다시 쓴 테스트도
//   병합된 최종 내용 한 번만 본다
// - 실행 1개 · 규칙 1개에 기록 1건이다(같은 실행 · 규칙의 기록이 있으면 남기지 않는다). 기록할 때 규칙이 확인됨이 아니면 남기지
//   않는다(미확인 규칙은 미확인 항목으로 이미 목록에 있다). 사람의 진술 편집으로 시작된 실행(ADR-109)도 대상이다
// - 확인 상태는 실행 생성 · 단계 진행 · 판정 · 병합의 조건이 아니다: 이 모듈은 엔진 · 단계가 아니라 오케스트레이터 배선이 엔진의
//   저장 이벤트를 받아 부르고(엔진은 기다리지 않는다), 실패해도 로그 한 줄만 남긴다
import {
  type NormChangeEntry,
  NORM_TEST_CHANGE_FILES_MAX,
  type NormTestChangeFile,
  type Run,
  type Step,
  Ulid,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';

import type { EngineEvent } from '../engine/types.js';
import { createGitRunner, type GitRunner } from '../git/git-exec.js';
import { withRegisteredProjectStore } from '../ipc/project-store-access.js';
import { ACCEPTANCE_DIR } from '../judge/config.js';

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
 * 두 커밋 사이에 규칙 폴더 안에서 바뀌거나 지워진 파일 (`git diff --name-status -z --no-renames`). 새 파일은 넣지 않는다.
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
      '--name-status',
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
    const change = CHANGE_OF[parts[i] ?? ''];
    const file = parts[i + 1] ?? '';
    if (change !== undefined && file !== '') files.push({ path: file, change });
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
 * 같은 실행 · 규칙의 알림이 아직 없을 때만 1건.
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
    return recorded;
  });

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
    if (run.status !== 'merged' || this.#seen.has(run.id)) return;
    this.#seen.add(run.id);
    const task = this.#record(event.projectId, run, steps).catch((error: unknown) => {
      this.#log(
        `테스트 변경 알림 실패 (${run.displayId}): ${error instanceof Error ? error.message : String(error)}`,
      );
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
    if (baseCommit === null || headCommit === null) return;
    const target = withRegisteredProjectStore(this.#biveHome, projectId, (store) => ({
      repoPath: store.projects.get(projectId)?.rootPath ?? null,
      rules: run.targetRuleIds.flatMap((id) => {
        const rule = store.rules.get(id);
        return rule === null ? [] : [{ id, displayId: rule.displayId }];
      }),
    }));
    if (target.repoPath === null) return;
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
    if (changes.length === 0) return;
    const recorded = withRegisteredProjectStore(this.#biveHome, projectId, (store) =>
      recordTestChanges(store, {
        run,
        baseCommit,
        headCommit,
        sessionId: testWriterSessionOf(steps),
        at: new Date(this.#now()).toISOString(),
        changes,
      }),
    );
    if (recorded.length > 0) {
      this.#log(`테스트 변경 알림 ${String(recorded.length)}건 (${run.displayId})`);
    }
  }
}
