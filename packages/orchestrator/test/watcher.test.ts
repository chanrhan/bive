// 감시자 · 규칙 변경의 재검증 필요 (M3-14 #59 수용 기준 1 · 2, JDG-02, ADR-156).
// 감시자가 기동 때와 5초마다 기준 브랜치 머리를 판정 기준 커밋과 비교해, 대상 블록 include에 걸리는 파일 변경이 있으면 영향 규칙을
// '재검증 필요'로 표시하는지(꺼져 있던 동안의 커밋 포함) 본다. 실제 git 저장소 · 임시 BIVE_HOME · 실제 SQLite 저장소.
// 주기는 주입한 예약 함수로 본다(실제 5초를 기다리지 않는다). 규칙 변경(진술 · 대상 블록)은 실제 처리기를 붙인 파이프로 부른다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  type Author,
  type BlockDeclaration,
  createUlidGenerator,
  ErrorCode,
  type JudgmentResult,
  type Rule,
  type Run,
  type Step,
} from '@bive/shared';
import {
  JudgmentRepository,
  openProjectStore,
  registerProject,
  type ProjectStore,
} from '@bive/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { selectAgent } from '../src/agent/select.js';
import type { GitRunner } from '../src/git/git-exec.js';
import { createGitRunner } from '../src/git/git-exec.js';
import type { PipeServer } from '../src/ipc/server.js';
import { startOrchestrator } from '../src/orchestrator.js';
import { recordNeedsRecheck, recordRejudgeMismatch } from '../src/judgments/judgment-marks.js';
import { createRun } from '../src/runs/run-service.js';
import { RecheckWatcher, WATCH_INTERVAL_MS } from '../src/watcher/recheck-watcher.js';
import type { TestClient } from './helpers/client.js';
import { cleanup, makeBiveHome, waitFor } from './helpers/process.js';
import { iso, startProjectHarness, T0 } from './helpers/project-harness.js';

const human = { kind: 'human' } as const satisfies Author;
const newId = createUlidGenerator();

const servers: PipeServer[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  await cleanup();
});

const GIT_FLAGS = [
  '-c',
  'user.name=BIVE 시험',
  '-c',
  'user.email=test@bive.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
];
const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', [...GIT_FLAGS, ...args], { cwd: repo, encoding: 'utf8' }).trim();
const write = (repo: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
/** 사람의 커밋 하나 (기준 브랜치에 직접). */
const commit = (repo: string, files: Record<string, string>, message = 'human'): string => {
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
};

const DECLARATION: BlockDeclaration = {
  blocks: [
    {
      name: 'auth',
      kind: 'domain',
      include: ['src/app/api/auth/**'],
      public: [],
      dependsOn: ['lib'],
      risk: 'high',
    },
    {
      name: 'health',
      kind: 'domain',
      include: ['src/app/api/health/**'],
      public: [],
      dependsOn: ['lib'],
      risk: 'medium',
    },
    {
      name: 'lib',
      kind: 'shared',
      include: ['src/lib/**'],
      public: ['src/lib/db.ts'],
      dependsOn: [],
      risk: 'low',
    },
  ],
};

const insertRule = (
  store: ProjectStore,
  title: string,
  targetBlockIds: string[],
  { builtin = false }: { builtin?: boolean } = {},
): Rule => {
  const requirement = builtin
    ? null
    : store.requirements.create({
        id: newId(),
        text: `${title} 요구사항`,
        author: human,
        normState: 'approved',
        createdAt: iso(T0),
      });
  return store.rules.create({
    id: newId(),
    title,
    statement: `WHEN ${title} THE SYSTEM SHALL 요청을 거부한다`,
    kind: builtin ? 'architecture' : 'business',
    checkKinds: builtin ? ['structure'] : ['test'],
    parentRequirementId: requirement?.id ?? null,
    builtin,
    targetBlockIds,
    risk: null,
    contractId: null,
    author: builtin ? human : { kind: 'agent', role: 'rule-writer' },
    normState: 'approved',
    createdAt: iso(T0),
  });
};

const stepOf = (steps: readonly Step[], kind: Step['kind']): Step => {
  const step = steps.find((s) => s.kind === kind);
  if (step === undefined) throw new Error(`단계 없음: ${kind}`);
  return step;
};

/**
 * 실행 하나를 저장소에 남긴다 (엔진이 남기는 저장 모양): 검사 단계까지 통과(머리 커밋 `head`), 병합 커밋을 주면 병합 단계 통과와
 * `merged`, 아니면 병합 단계 실패. 검사 단계 판정은 `judged`의 규칙마다 '통과'(커밋 = `head`).
 */
const seedRun = (
  store: ProjectStore,
  input: {
    at: number;
    head: string;
    mergeCommit?: string;
    target: Rule;
    judged: Rule[];
    status?: 'pass' | 'fail';
  },
): { run: Run; judgments: JudgmentResult[] } => {
  const created = createRun(
    store,
    { ruleIds: [input.target.id], author: human },
    { clientId: null },
    { now: () => input.at, newId },
  );
  const runId = created.run.id;
  const before = created.steps.filter(
    (step) => step.status === 'pending' && step.kind !== 'merge' && step.kind !== 'screen_update',
  );
  store.runs.transition(runId, {
    run: {
      status: 'running',
      currentStep: 'merge',
      startedAt: iso(input.at),
      headCommit: input.head,
    },
    steps: before.map((step) => ({
      id: step.id,
      status: 'passed' as const,
      startedAt: iso(input.at),
      endedAt: iso(input.at + 1_000),
    })),
  });
  const judgments = store.judgments.record(
    input.judged.map((rule) => ({
      id: newId(),
      ruleId: rule.id,
      runId,
      stepId: stepOf(created.steps, 'check').id,
      commit: input.head,
      judgedAt: iso(input.at + 500),
      status: input.status ?? 'pass',
      runner: 'vitest' as const,
      exitCode: input.status === 'fail' ? 1 : 0,
      reporterPath: null,
      cases: [],
      quarantineReason: null,
    })),
  );
  const merge = stepOf(created.steps, 'merge');
  const end = input.at + 60_000;
  if (input.mergeCommit === undefined) {
    const run = store.runs.transition(runId, {
      run: { status: 'failed', currentStep: null, endedAt: iso(end), failureReason: 'x' },
      steps: [{ id: merge.id, status: 'failed', startedAt: iso(input.at), endedAt: iso(end) }],
    }).run;
    return { run, judgments };
  }
  store.runs.transition(runId, {
    steps: [
      {
        id: merge.id,
        status: 'passed',
        startedAt: iso(input.at + 1_000),
        endedAt: iso(end),
        exitDetail: { mergeCommit: input.mergeCommit },
      },
    ],
  });
  const screen = stepOf(created.steps, 'screen_update');
  store.runs.transition(runId, {
    run: { currentStep: 'screen_update', mergeCommit: input.mergeCommit },
    steps: [{ id: screen.id, status: 'running', startedAt: iso(end) }],
  });
  const run = store.runs.transition(runId, {
    run: { status: 'merged', currentStep: null, endedAt: iso(end + 1_000) },
    steps: [{ id: screen.id, status: 'passed', endedAt: iso(end + 1_000) }],
  }).run;
  return { run, judgments };
};

interface Rules {
  lib: Rule;
  auth: Rule;
  /** 대상 블록 없음 (판정 있음) */
  untargeted: Rule;
  /** 내장 규칙 (대상 블록이 있어도 대상 아님) */
  builtin: Rule;
  /** 판정 기록 없음 (lib 대상) */
  unjudged: Rule;
}

interface Watched {
  home: string;
  repo: string;
  projectId: string;
  basis: string;
  rules: Rules;
  read: <T>(fn: (store: ProjectStore) => T) => T;
  /** 실행 밖 재검증 필요 기록 (규칙 표시 ID 순) */
  marks: () => { rule: string; commit: string }[];
  /** 규칙의 최신 판정 상태 */
  latest: (rule: Rule) => JudgmentResult['status'] | null;
}

const project = (home: string, repo: string): string =>
  registerProject(
    { id: newId(), name: '샘플', rootPath: repo, baseBranch: 'main', createdAt: iso(T0) },
    { home },
  ).id;

/**
 * 감시 대상 프로젝트: 실제 git 저장소(블록 lib · auth · health 파일과 README) 첫 커밋 = 판정 기준(병합된 실행의 병합 커밋), 블록 선언,
 * 규칙 다섯(판정은 첫 커밋에서 '통과').
 */
const watchedProject = (
  options: { declaration?: boolean; merged?: boolean; home?: string } = {},
): Watched => {
  const home = options.home ?? makeBiveHome();
  const repo = path.join(home, `repo-${newId()}`);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  const basis = commit(repo, {
    'src/lib/db.ts': 'export const db = 1;\n',
    'src/app/api/auth/route.ts': 'export const auth = 1;\n',
    'src/app/api/health/route.ts': 'export const health = 1;\n',
    'README.md': '# 샘플\n',
  });
  const projectId = project(home, repo);
  const read = <T>(fn: (store: ProjectStore) => T): T => {
    const store = openProjectStore(projectId, { home, create: false });
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };
  const rules = read((store): Rules => {
    store.settings.update(
      {
        run: { maxBudgetUsd: 5, maxTurns: 200 },
        roles: {
          'rule-writer': { model: 'm', maxBudgetUsd: 1, maxTurns: 20 },
          'test-writer': { model: 'm', maxBudgetUsd: 2, maxTurns: 100 },
          implementer: { model: 'm', maxBudgetUsd: 3, maxTurns: 150 },
          mutator: { model: 'm', maxBudgetUsd: 1, maxTurns: 50 },
        },
      },
      { by: human, at: iso(T0) },
    );
    if (options.declaration !== false) {
      store.blockDeclarations.set(DECLARATION, { at: iso(T0), by: human });
    }
    const created: Rules = {
      lib: insertRule(store, '라이브러리', ['lib']),
      auth: insertRule(store, '인증', ['auth']),
      untargeted: insertRule(store, '대상 없음', []),
      builtin: insertRule(store, '내장', ['lib'], { builtin: true }),
      unjudged: insertRule(store, '판정 없음', ['lib']),
    };
    seedRun(store, {
      at: T0 + 60_000,
      head: basis,
      ...(options.merged === false ? {} : { mergeCommit: basis }),
      target: created.lib,
      judged: [created.lib, created.auth, created.untargeted, created.builtin],
    });
    return created;
  });
  const displayIds = new Map(Object.values(rules).map((rule) => [rule.id, rule.title]));
  return {
    home,
    repo,
    projectId,
    basis,
    rules,
    read,
    marks: () =>
      read((store) =>
        store.judgments
          .listUnattached()
          .filter((record) => record.status === 'needs_recheck')
          .map((record) => ({ rule: displayIds.get(record.ruleId) ?? '?', commit: record.commit }))
          .sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)),
      ),
    latest: (rule) => read((store) => store.judgments.latestByRule(rule.id)?.status ?? null),
  };
};

/** 예약을 받아 두고 시험이 직접 부르는 예약 함수. */
const manualScheduler = () => {
  const pending: { run: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    pending,
    schedule: (run: () => void, ms: number) => {
      const entry = { run, ms, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** 잡힌 다음 회차 하나를 꺼내 부른다 */
    fire: () => {
      const entry = pending.shift();
      if (entry === undefined || entry.cancelled) throw new Error('잡힌 회차 없음');
      entry.run();
    },
  };
};

const watcherOf = (
  w: { home: string },
  options: Partial<ConstructorParameters<typeof RecheckWatcher>[0]> = {},
) => {
  const logs: string[] = [];
  const watcher = new RecheckWatcher({
    biveHome: w.home,
    log: (line) => logs.push(line),
    schedule: manualScheduler().schedule,
    now: () => Date.now(),
    ...options,
  });
  return { watcher, logs };
};

describe('감시자: 기동 때 · 주기 비교 (수용 기준 1)', () => {
  it('기동 때 한 번: 꺼져 있던 동안 기준 브랜치에 들어간 사람 커밋이 lib 블록 파일을 바꿨으면 lib 대상 규칙만 재검증 필요(커밋 = 지금 머리)이고, 대상 블록 없음 · 내장 · 판정 없는 규칙과 다른 블록 규칙은 그대로다', async () => {
    const w = watchedProject();
    // 감시자가 없던 동안의 커밋 둘 (lib 파일 · 블록 밖 파일)
    commit(w.repo, { 'src/lib/db.ts': 'export const db = 2;\n' });
    const head = commit(w.repo, { 'README.md': '# 샘플 2\n' });
    // 실행이 도는 중에도 본다 (프로젝트당 실행 1개의 자리를 차지한 실행)
    w.read((store) => {
      const running = createRun(
        store,
        { ruleIds: [w.rules.auth.id], author: human },
        { clientId: null },
        { now: () => T0 + 120_000, newId },
      );
      store.runs.transition(running.run.id, {
        run: { status: 'running', currentStep: 'test_writing', startedAt: iso(T0 + 120_000) },
      });
    });
    const scheduler = manualScheduler();
    const { watcher } = watcherOf(w, { schedule: scheduler.schedule });
    watcher.start();
    await waitFor(() => w.marks().length > 0, 10_000, '재검증 필요 표시');
    await watcher.tick();
    expect(w.marks()).toEqual([{ rule: '라이브러리', commit: head }]);
    expect(w.latest(w.rules.lib)).toBe('needs_recheck');
    for (const rule of [w.rules.auth, w.rules.untargeted, w.rules.builtin]) {
      expect(w.latest(rule)).toBe('pass');
    }
    expect(w.latest(w.rules.unjudged)).toBeNull();
    // 표시 기록의 모양: 실행 · 단계 · 케이스 · 격리 사유 없음, 실행기는 낡은 판정의 것
    const [mark] = w.read((store) => store.judgments.listUnattached());
    expect(mark).toMatchObject({
      ruleId: w.rules.lib.id,
      runId: null,
      stepId: null,
      status: 'needs_recheck',
      runner: 'vitest',
      exitCode: null,
      reporterPath: null,
      cases: [],
      quarantineReason: null,
    });
    // 다음 회차는 앞 회차가 끝난 뒤 5초로 잡힌다
    expect(scheduler.pending.map((entry) => entry.ms)).toEqual([WATCH_INTERVAL_MS]);
    expect(WATCH_INTERVAL_MS).toBe(5_000);
    await watcher.stop();
  }, 30_000);

  it('5초마다: 기동 회차 뒤에 들어온 auth 블록 커밋은 다음 회차가 잡고, 블록 밖 · 대상 규칙 없는 블록(health)의 변경은 표시하지 않는다', async () => {
    const w = watchedProject();
    const scheduler = manualScheduler();
    const { watcher } = watcherOf(w, { schedule: scheduler.schedule });
    watcher.start();
    await waitFor(() => scheduler.pending.length === 1, 10_000, '첫 회차');
    expect(w.marks()).toEqual([]);
    commit(w.repo, {
      'README.md': '# 바뀜\n',
      'src/app/api/health/route.ts': 'export const health = 2;\n',
    });
    scheduler.fire();
    await waitFor(() => scheduler.pending.length === 1, 10_000, '둘째 회차');
    expect(w.marks()).toEqual([]);
    const head = commit(w.repo, { 'src/app/api/auth/route.ts': 'export const auth = 2;\n' });
    scheduler.fire();
    await waitFor(() => scheduler.pending.length === 1, 10_000, '셋째 회차');
    expect(w.marks()).toEqual([{ rule: '인증', commit: head }]);
    expect(w.latest(w.rules.lib)).toBe('pass');
    await watcher.stop();
    // 멈춘 뒤에는 다음 회차를 잡지 않는다
    expect(scheduler.pending.every((entry) => entry.cancelled)).toBe(true);
  }, 30_000);

  it('lib 블록 파일을 지운 사람 커밋: lib 대상 규칙만 재검증 필요다 (지운 파일도 바뀐 파일)', async () => {
    const w = watchedProject();
    git(w.repo, 'rm', '-q', 'src/lib/db.ts');
    git(w.repo, 'commit', '-q', '-m', 'human: remove');
    const head = git(w.repo, 'rev-parse', 'HEAD');
    await watcherOf(w).watcher.tick();
    expect(w.marks()).toEqual([{ rule: '라이브러리', commit: head }]);
    expect(w.latest(w.rules.auth)).toBe('pass');
  }, 30_000);

  it('lib 블록 파일을 블록 밖 경로로 옮긴 사람 커밋: lib 대상 규칙이 재검증 필요다 (이름 바꿈은 옛 경로도 바뀐 파일)', async () => {
    const w = watchedProject();
    git(w.repo, 'mv', 'src/lib/db.ts', 'src/moved-db.ts');
    git(w.repo, 'commit', '-q', '-m', 'human: move');
    const head = git(w.repo, 'rev-parse', 'HEAD');
    await watcherOf(w).watcher.tick();
    expect(w.marks()).toEqual([{ rule: '라이브러리', commit: head }]);
    expect(w.latest(w.rules.auth)).toBe('pass');
  }, 30_000);

  it('오케스트레이터 기동이 감시자를 띄운다: 꺼져 있던 동안의 lib 커밋이 기동 뒤 재검증 필요가 된다', async () => {
    const w = watchedProject();
    const head = commit(w.repo, { 'src/lib/db.ts': 'export const db = 3;\n' });
    const result = await startOrchestrator({
      biveHome: w.home,
      idleShutdownMs: 60_000,
      agent: selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome: w.home }),
      log: () => undefined,
    });
    if (result.status !== 'started') throw new Error('기동 실패');
    try {
      await waitFor(() => w.marks().length > 0, 10_000, '기동 뒤 재검증 필요');
    } finally {
      await result.orchestrator.stop();
    }
    expect(w.marks()).toEqual([{ rule: '라이브러리', commit: head }]);
  }, 30_000);
});

describe('감시자: 표시하지 않는 경우 · 멱등', () => {
  it('BIVE 자신의 병합: 실행 브랜치의 lib 변경을 병합한 커밋이 기준 브랜치 머리가 되면(병합 커밋 기록 전 · 후 모두) 재검증 필요가 생기지 않는다', async () => {
    const w = watchedProject();
    git(w.repo, 'checkout', '-q', '-b', 'bive/run-1');
    const checked = commit(w.repo, { 'src/lib/db.ts': 'export const db = 4;\n' }, 'run');
    git(w.repo, 'checkout', '-q', 'main');
    git(w.repo, 'merge', '-q', '--no-ff', '-m', 'bive merge', 'bive/run-1');
    const merged = git(w.repo, 'rev-parse', 'HEAD');
    // 병합 커밋을 기록하기 전: 기준 브랜치는 이미 병합 커밋, 판정 기준은 앞 병합, 검사 판정은 실행 브랜치 끝
    w.read((store) =>
      seedRun(store, {
        at: T0 + 10 * 60_000,
        head: checked,
        target: w.rules.lib,
        judged: [w.rules.lib, w.rules.auth, w.rules.untargeted],
      }),
    );
    const { watcher } = watcherOf(w);
    await watcher.tick();
    expect(w.marks()).toEqual([]);
    // 병합 커밋을 기록한 뒤 (병합 커밋 = 판정 기준 = 머리)
    const recorded = w.read((store) =>
      seedRun(store, {
        at: T0 + 20 * 60_000,
        head: checked,
        mergeCommit: merged,
        target: w.rules.lib,
        judged: [w.rules.lib, w.rules.auth, w.rules.untargeted],
      }),
    );
    expect(recorded.run.mergeCommit).toBe(merged);
    await watcher.tick();
    expect(w.marks()).toEqual([]);
    expect(w.latest(w.rules.lib)).toBe('pass');
  }, 30_000);

  it('멱등: 같은 머리를 여러 회차 · 재기동(새 감시자)에서 다시 봐도 표시는 한 번이고, 새 판정이 생기면 그 판정이 최신이며 다시 표시하지 않는다', async () => {
    const w = watchedProject();
    const head = commit(w.repo, { 'src/lib/db.ts': 'export const db = 5;\n' });
    const first = watcherOf(w).watcher;
    await first.tick();
    await first.tick();
    await watcherOf(w).watcher.tick();
    expect(w.marks()).toEqual([{ rule: '라이브러리', commit: head }]);
    // 그 머리 뒤에 만든 실행(병합되지 않음)이 lib 규칙을 실제로 판정하면 그 판정이 최신이고 풀린다
    git(w.repo, 'checkout', '-q', '-b', 'bive/run-2');
    const runHead = commit(
      w.repo,
      { 'src/app/api/auth/route.ts': 'export const auth = 9;\n' },
      'run',
    );
    git(w.repo, 'checkout', '-q', 'main');
    w.read((store) =>
      seedRun(store, {
        // 판정 시각(실행 시각 + 0.5초)이 표시보다 뒤
        at: Date.now(),
        head: runHead,
        target: w.rules.lib,
        judged: [w.rules.lib],
      }),
    );
    expect(w.latest(w.rules.lib)).toBe('pass');
    await watcherOf(w).watcher.tick();
    expect(w.latest(w.rules.lib)).toBe('pass');
    expect(w.marks()).toEqual([{ rule: '라이브러리', commit: head }]);
  }, 30_000);

  it('블록 선언이 없는 프로젝트 · 병합된 실행이 없는 프로젝트는 보지 않는다', async () => {
    const home = makeBiveHome();
    const noDeclaration = watchedProject({ home, declaration: false });
    const notMerged = watchedProject({ home, merged: false });
    commit(noDeclaration.repo, { 'src/lib/db.ts': 'export const db = 6;\n' });
    commit(notMerged.repo, { 'src/lib/db.ts': 'export const db = 6;\n' });
    const { watcher, logs } = watcherOf({ home });
    await watcher.tick();
    expect(noDeclaration.marks()).toEqual([]);
    expect(notMerged.marks()).toEqual([]);
    expect(logs).toEqual([]);
  }, 30_000);

  it('기준 브랜치를 되감으면(판정 기준 커밋이 머리의 조상이 아님) 블록 대상 규칙 전부가 재검증 필요다 (닫힌 쪽)', async () => {
    const w = watchedProject();
    // lib을 바꾼 병합이 새 판정 기준이 된다 (두 규칙 모두 그 커밋에서 판정)
    const merged = commit(w.repo, { 'src/lib/db.ts': 'export const db = 7;\n' });
    w.read((store) =>
      seedRun(store, {
        at: T0 + 5 * 60_000,
        head: merged,
        mergeCommit: merged,
        target: w.rules.lib,
        judged: [w.rules.lib, w.rules.auth],
      }),
    );
    // 그 병합을 버리고 앞 커밋에서 블록 밖 파일만 바꾼 커밋으로 기준 브랜치를 되감는다. 공통 조상(첫 커밋)에서 머리까지의 변경은
    // 블록 밖뿐이지만 lib 파일은 판정한 커밋과 다르다: 되감음은 닫힌 쪽으로 본다
    git(w.repo, 'reset', '-q', '--hard', w.basis);
    const head = commit(w.repo, { 'README.md': '# 다시 씀\n' }, 'rewrite');
    // 다시 쓴 머리 뒤에 만든 실행(병합되지 않음)이 판정한 규칙(대상 없음 규칙의 블록 무관)은 그 판정이 머리를 포함하므로 낡지 않았다
    git(w.repo, 'checkout', '-q', '-b', 'bive/after-rewrite');
    const after = commit(w.repo, { 'notes.md': '실행\n' }, 'run');
    git(w.repo, 'checkout', '-q', 'main');
    const auth2 = w.read((store) => {
      const rule = insertRule(store, '다시 쓴 뒤 판정', ['auth']);
      seedRun(store, { at: Date.now(), head: after, target: rule, judged: [rule] });
      return rule;
    });
    await watcherOf(w).watcher.tick();
    expect(w.marks()).toEqual([
      { rule: '라이브러리', commit: head },
      { rule: '인증', commit: head },
    ]);
    expect(w.latest(auth2)).toBe('pass');
  }, 30_000);

  it('닫힌 쪽: 판정 기준 커밋이 저장소에 없으면 블록 대상 규칙 전부, 최신 판정의 커밋이 저장소에 없으면 그 규칙을 표시한다 (바뀐 파일이 블록 밖이어도)', async () => {
    const home = makeBiveHome();
    const lostBasis = watchedProject({ home });
    const lostJudgment = watchedProject({ home });
    // 판정 기준을 저장소에 없는 커밋의 병합 실행으로 옮긴다
    lostBasis.read((store) =>
      seedRun(store, {
        at: T0 + 5 * 60_000,
        head: 'c'.repeat(40),
        mergeCommit: 'd'.repeat(40),
        target: lostBasis.rules.lib,
        judged: [],
      }),
    );
    // 인증 규칙의 최신 판정을 저장소에 없는 커밋의 판정으로 (병합되지 않은 실행)
    lostJudgment.read((store) =>
      seedRun(store, {
        at: T0 + 5 * 60_000,
        head: 'e'.repeat(40),
        target: lostJudgment.rules.auth,
        judged: [lostJudgment.rules.auth],
      }),
    );
    const headA = commit(lostBasis.repo, { 'README.md': '# 블록 밖\n' });
    const headB = commit(lostJudgment.repo, { 'README.md': '# 블록 밖\n' });
    await watcherOf({ home }).watcher.tick();
    expect(lostBasis.marks()).toEqual([
      { rule: '라이브러리', commit: headA },
      { rule: '인증', commit: headA },
    ]);
    expect(lostJudgment.marks()).toEqual([{ rule: '인증', commit: headB }]);
  }, 30_000);

  it('최신 판정이 격리인 규칙은 표시하지 않는다 (격리를 덮지 않는다)', async () => {
    const w = watchedProject();
    w.read((store) =>
      store.judgments.record([
        {
          id: newId(),
          ruleId: w.rules.lib.id,
          runId: null,
          stepId: null,
          commit: w.basis,
          judgedAt: new Date(Date.now() - 1_000).toISOString(),
          status: 'quarantined',
          runner: 'vitest',
          exitCode: null,
          reporterPath: null,
          cases: [],
          quarantineReason: '불안정한 검사',
        },
      ]),
    );
    commit(w.repo, { 'src/lib/db.ts': 'export const db = 11;\n' });
    await watcherOf(w).watcher.tick();
    expect(w.marks()).toEqual([]);
    expect(w.latest(w.rules.lib)).toBe('quarantined');
  }, 30_000);

  it('git 비교 도중 그 규칙의 새 판정이 생기면 쓰기 직전 대조로 표시하지 않는다', async () => {
    const w = watchedProject();
    const head = commit(w.repo, { 'src/lib/db.ts': 'export const db = 12;\n' });
    const real = createGitRunner();
    const racing: GitRunner = async (args, options) => {
      if (args.includes('diff')) {
        w.read((store) =>
          seedRun(store, { at: Date.now(), head, target: w.rules.lib, judged: [w.rules.lib] }),
        );
      }
      return real(args, options);
    };
    await watcherOf(w, { git: racing }).watcher.tick();
    expect(w.marks()).toEqual([]);
    expect(w.latest(w.rules.lib)).toBe('pass');
  }, 30_000);
});

describe('감시자: 오류 · 겹침', () => {
  it('git 오류 · 저장소 없음 · 기준 브랜치 없음에서 죽지 않는다: 그 프로젝트는 로그 한 줄(같은 오류는 한 번)이고 다른 프로젝트는 그대로 본다', async () => {
    const home = makeBiveHome();
    const broken = watchedProject({ home });
    const healthy = watchedProject({ home });
    fs.rmSync(broken.repo, { recursive: true, force: true });
    const head = commit(healthy.repo, { 'src/lib/db.ts': 'export const db = 8;\n' });
    const { watcher, logs } = watcherOf({ home });
    await watcher.tick();
    await watcher.tick();
    expect(healthy.marks()).toEqual([{ rule: '라이브러리', commit: head }]);
    expect(broken.marks()).toEqual([]);
    expect(logs.filter((line) => line.includes(broken.projectId))).toHaveLength(1);
    expect(logs.find((line) => line.includes(broken.projectId))).toMatch(
      /^감시자: 프로젝트 .* 건너뜀/,
    );
    // git 실행 함수가 던져도 회차는 끝나고 다음 회차가 잡힌다
    const scheduler = manualScheduler();
    const failing = watcherOf(
      { home },
      {
        schedule: scheduler.schedule,
        git: () => Promise.reject(new Error('git 없음')),
      },
    );
    failing.watcher.start();
    await waitFor(() => scheduler.pending.length === 1, 10_000, '다음 회차');
    expect(failing.logs.length).toBeGreaterThan(0);
    await failing.watcher.stop();
  }, 30_000);

  it('겹쳐 돌지 않는다: 느린 git(5초 넘게)으로 회차가 끝나지 않으면 그 동안의 회차 요청은 같은 회차를 기다리고 다음 회차를 잡지 않는다', async () => {
    const w = watchedProject();
    commit(w.repo, { 'src/lib/db.ts': 'export const db = 10;\n' });
    const real = createGitRunner();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const slow: GitRunner = async (args, options) => {
      calls += 1;
      await gate;
      return real(args, options);
    };
    const scheduler = manualScheduler();
    const { watcher } = watcherOf(w, { schedule: scheduler.schedule, git: slow });
    watcher.start();
    await waitFor(() => calls === 1, 10_000, '첫 git');
    const again = watcher.tick();
    const third = watcher.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 회차 하나만 돌고 있다: git 호출은 1회에서 멈춰 있고, 다음 회차는 아직 잡히지 않았다
    expect(calls).toBe(1);
    expect(scheduler.pending).toEqual([]);
    release();
    await Promise.all([again, third]);
    await waitFor(() => scheduler.pending.length === 1, 10_000, '다음 회차');
    expect(w.marks().map((mark) => mark.rule)).toEqual(['라이브러리']);
    await watcher.stop();
  }, 30_000);
});

describe('규칙 변경의 재검증 필요 (수용 기준 2)', () => {
  const ruleHarness = async () => {
    const h = await startProjectHarness({ servers, clients });
    const seeded = h.read((store) => {
      store.settings.update(
        {
          run: { maxBudgetUsd: 5, maxTurns: 200 },
          roles: {
            'rule-writer': { model: 'm', maxBudgetUsd: 1, maxTurns: 20 },
            'test-writer': { model: 'm', maxBudgetUsd: 2, maxTurns: 100 },
            implementer: { model: 'm', maxBudgetUsd: 3, maxTurns: 150 },
            mutator: { model: 'm', maxBudgetUsd: 1, maxTurns: 50 },
          },
        },
        { by: human, at: iso(T0) },
      );
      store.blockDeclarations.set(DECLARATION, { at: iso(T0), by: human });
      const lib = insertRule(store, '라이브러리', ['lib']);
      const auth = insertRule(store, '인증', ['auth']);
      const health = insertRule(store, '헬스', ['health']);
      const unjudged = insertRule(store, '판정 없음', ['auth']);
      const judged = seedRun(store, {
        at: T0 + 60_000,
        head: 'a'.repeat(40),
        mergeCommit: 'b'.repeat(40),
        target: lib,
        judged: [lib, auth, health],
      });
      return { lib, auth, health, unjudged, judged };
    });
    h.clock.now = T0 + 10 * 60_000;
    const statusOf = async (rule: Rule) =>
      (await h.client.call('rule.get', { projectId: h.project.id, id: rule.id })).judgment.status;
    return { h, ...seeded, statusOf };
  };

  it('효력 있는 규칙의 진술을 사람이 고치면 같은 트랜잭션에서 재검증 필요(커밋 = 낡은 판정의 커밋)이고, 제목만 고친 편집과 판정 없는 규칙의 편집은 표시하지 않는다', async () => {
    const { h, lib, auth, unjudged, judged, statusOf } = await ruleHarness();
    const titled = await h.client.call('rule.update', {
      projectId: h.project.id,
      id: auth.id,
      author: human,
      title: '인증 (제목만)',
    });
    expect(titled.judgment.status).toBe('pass');
    expect(await statusOf(auth)).toBe('pass');
    const edited = await h.client.call('rule.update', {
      projectId: h.project.id,
      id: lib.id,
      author: human,
      statement: 'WHEN 라이브러리 요청 THE SYSTEM SHALL 요청을 받아들인다',
    });
    // 응답의 판정도 표시 뒤의 최신 판정이다
    expect(edited.judgment.status).toBe('needs_recheck');
    expect(edited.judgment.latest).toMatchObject({
      runId: null,
      stepId: null,
      commit: judged.judgments[0]?.commit,
      judgedAt: iso(T0 + 10 * 60_000),
      status: 'needs_recheck',
    });
    expect(await statusOf(lib)).toBe('needs_recheck');
    // 같은 편집의 승인 기록과 같은 시각 (같은 트랜잭션)
    expect(edited.approvalLog.at).toBe(edited.judgment.latest?.judgedAt);
    await h.client.call('rule.update', {
      projectId: h.project.id,
      id: unjudged.id,
      author: human,
      statement: 'WHEN 판정 없음 요청 THE SYSTEM SHALL 요청을 받아들인다',
    });
    expect(await statusOf(unjudged)).toBe('unjudged');
    // 이미 재검증 필요인 규칙을 다시 고쳐도 표시는 하나다
    await h.client.call('rule.update', {
      projectId: h.project.id,
      id: lib.id,
      author: human,
      statement: 'WHEN 라이브러리 요청 THE SYSTEM SHALL 요청을 다시 받아들인다',
    });
    expect(
      h.read((store) => store.judgments.listUnattached().map((record) => record.ruleId)),
    ).toEqual([lib.id]);
  }, 30_000);

  it('에이전트 주체의 규칙 편집 · 블록 선언 저장은 -32020이고 판정 상태가 바뀌지 않는다 (JDG-01)', async () => {
    const { h, lib, statusOf } = await ruleHarness();
    const agent = { kind: 'agent', role: 'implementer' } as const;
    for (const call of [
      h.client.call('rule.update', {
        projectId: h.project.id,
        id: lib.id,
        author: agent,
        statement: 'WHEN 라이브러리 요청 THE SYSTEM SHALL 요청을 받아들인다',
      }),
      h.client.call('blocks.set', {
        projectId: h.project.id,
        author: agent,
        declaration: { blocks: DECLARATION.blocks.filter((block) => block.name !== 'lib') },
      }),
    ]) {
      await expect(call).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
    }
    expect(await statusOf(lib)).toBe('pass');
    expect(h.read((store) => store.judgments.listUnattached())).toEqual([]);
  }, 30_000);

  it('블록 선언 저장: 첫 선언은 표시하지 않고, 앞 판을 읽지 못하면(가장 큰 판의 행이 깨짐) 새 판 저장은 받고 블록 대상 규칙 전부가 재검증 필요다', async () => {
    const h = await startProjectHarness({ servers, clients });
    const { lib, auth } = h.read((store) => {
      store.settings.update(
        {
          run: { maxBudgetUsd: 5, maxTurns: 200 },
          roles: {
            'rule-writer': { model: 'm', maxBudgetUsd: 1, maxTurns: 20 },
            'test-writer': { model: 'm', maxBudgetUsd: 2, maxTurns: 100 },
            implementer: { model: 'm', maxBudgetUsd: 3, maxTurns: 150 },
            mutator: { model: 'm', maxBudgetUsd: 1, maxTurns: 50 },
          },
        },
        { by: human, at: iso(T0) },
      );
      const created = {
        lib: insertRule(store, '라이브러리', ['lib']),
        auth: insertRule(store, '인증', ['auth']),
      };
      seedRun(store, {
        at: T0 + 60_000,
        head: 'a'.repeat(40),
        mergeCommit: 'b'.repeat(40),
        target: created.lib,
        judged: [created.lib, created.auth],
      });
      return created;
    });
    h.clock.now = T0 + 10 * 60_000;
    const set = () =>
      h.client.call('blocks.set', {
        projectId: h.project.id,
        author: human,
        declaration: DECLARATION,
      });
    const statuses = () =>
      h.read((store) =>
        [lib, auth].map((rule) => store.judgments.latestByRule(rule.id)?.status ?? null),
      );
    await set();
    expect(statuses()).toEqual(['pass', 'pass']);
    // 가장 큰 판(2)의 행을 깨뜨린다
    h.read((store) =>
      store.db
        .prepare(
          'INSERT INTO block_declarations (version, set_at, set_by, declaration) VALUES (?, ?, ?, ?)',
        )
        .run(2, iso(T0 + 1_000), '{"kind":"human"}', '{"blocks":[{"name":"깨짐"}]}'),
    );
    const saved = await set();
    expect(saved.current.version).toBe(3);
    expect(statuses()).toEqual(['needs_recheck', 'needs_recheck']);
  }, 30_000);

  it('표시 시각은 낡은 판정보다 늘 뒤다: 시계가 그 판정보다 앞이면 판정 시각 1ms 뒤로 남겨 표시가 최신이다', () => {
    const w = watchedProject();
    const [judged] = w.read((store) => store.judgments.listByRule(w.rules.lib.id));
    if (judged === undefined) throw new Error('판정 없음');
    const [recorded] = w.read((store) =>
      recordNeedsRecheck(store, [{ rule: w.rules.lib, latest: judged, commit: w.basis }], {
        now: Date.parse(judged.judgedAt) - 60_000,
        newId,
      }),
    );
    expect(recorded?.judgedAt).toBe(iso(Date.parse(judged.judgedAt) + 1));
    expect(w.latest(w.rules.lib)).toBe('needs_recheck');
    // 최신 판정이 받은 것과 다르면 남기지 않는다
    expect(
      w.read((store) =>
        recordNeedsRecheck(store, [{ rule: w.rules.lib, latest: judged, commit: w.basis }], {
          now: Date.now(),
          newId,
        }),
      ),
    ).toEqual([]);
  });

  it('표시 모듈이 쓰는 상태는 둘뿐이다: 낡은 판정이 통과든 실패든 감시자 · 진술 편집의 표시는 재검증 필요이고, 재판정 불일치는 격리다', async () => {
    // 감시자: lib(최신 통과) · auth(최신 실패, 병합되지 않은 실행)가 모두 바뀐 사람 커밋
    const w = watchedProject();
    w.read((store) =>
      seedRun(store, {
        at: T0 + 5 * 60_000,
        head: w.basis,
        target: w.rules.auth,
        judged: [w.rules.auth],
        status: 'fail',
      }),
    );
    expect(w.latest(w.rules.auth)).toBe('fail');
    commit(w.repo, {
      'src/lib/db.ts': 'export const db = 13;\n',
      'src/app/api/auth/route.ts': 'export const auth = 13;\n',
    });
    await watcherOf(w).watcher.tick();
    const watched = w.read((store) => store.judgments.listUnattached());
    expect(watched.map((record) => [record.ruleId, record.status]).sort()).toEqual(
      [
        [w.rules.lib.id, 'needs_recheck'],
        [w.rules.auth.id, 'needs_recheck'],
      ].sort(),
    );
    // 진술 편집: 최신 통과(lib) · 최신 실패(auth)
    const { h, lib, auth } = await ruleHarness();
    h.read((store) =>
      seedRun(store, {
        at: T0 + 2 * 60_000,
        head: 'a'.repeat(40),
        target: auth,
        judged: [auth],
        status: 'fail',
      }),
    );
    for (const rule of [lib, auth]) {
      await h.client.call('rule.update', {
        projectId: h.project.id,
        id: rule.id,
        author: human,
        statement: `WHEN ${rule.title} 편집 THE SYSTEM SHALL 요청을 받아들인다`,
      });
    }
    // 재판정 불일치
    h.read((store) =>
      recordRejudgeMismatch(store, [{ ruleId: lib.id, commit: 'a'.repeat(40), runner: 'vitest' }], {
        now: T0 + 20 * 60_000,
        newId,
      }),
    );
    const edited = h.read((store) => store.judgments.listUnattached());
    expect(edited.map((record) => [record.ruleId, record.status, record.quarantineReason])).toEqual(
      [
        [lib.id, 'needs_recheck', null],
        [auth.id, 'needs_recheck', null],
        [lib.id, 'quarantined', '재판정 불일치'],
      ],
    );
    expect(new Set([...watched, ...edited].map((record) => record.status))).toEqual(
      new Set(['needs_recheck', 'quarantined']),
    );
  }, 30_000);

  it('진술 편집의 표시는 편집과 같은 트랜잭션이다: 표시 쓰기가 실패하면 편집이 실패하고 진술 · 승인 기록 · 판정 기록이 그대로다', async () => {
    const { h, lib, statusOf } = await ruleHarness();
    const before = h.read((store) => ({
      rule: store.rules.get(lib.id),
      approvals: store.approvalLog.list().length,
      judgments: store.judgments.listByRule(lib.id),
    }));
    const mocked = vi.spyOn(JudgmentRepository.prototype, 'record').mockImplementation(() => {
      throw new Error('표시 쓰기 실패');
    });
    try {
      await expect(
        h.client.call('rule.update', {
          projectId: h.project.id,
          id: lib.id,
          author: human,
          statement: 'WHEN 라이브러리 요청 THE SYSTEM SHALL 요청을 받아들인다',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.InternalError });
    } finally {
      mocked.mockRestore();
    }
    expect(
      h.read((store) => ({
        rule: store.rules.get(lib.id),
        approvals: store.approvalLog.list().length,
        judgments: store.judgments.listByRule(lib.id),
      })),
    ).toEqual(before);
    expect(await statusOf(lib)).toBe('pass');
  }, 30_000);

  it('블록 선언 저장의 표시는 선언 저장과 같은 트랜잭션이다: 표시 쓰기가 실패하면 저장이 실패하고 선언 판 · 규칙 · 판정 기록이 그대로다', async () => {
    const { h, health, statusOf } = await ruleHarness();
    const snapshot = () =>
      h.read((store) => ({
        version: store.blockDeclarations.current()?.version,
        rules: store.rules.list().length,
        judgments: store.judgments.listByRule(health.id),
      }));
    const before = snapshot();
    const mocked = vi.spyOn(JudgmentRepository.prototype, 'record').mockImplementation(() => {
      throw new Error('표시 쓰기 실패');
    });
    try {
      // health 블록을 지운 판: 헬스 규칙에 표시를 쓰려다 실패한다
      await expect(
        h.client.call('blocks.set', {
          projectId: h.project.id,
          author: human,
          declaration: { blocks: DECLARATION.blocks.filter((block) => block.name !== 'health') },
        }),
      ).rejects.toMatchObject({ code: ErrorCode.InternalError });
    } finally {
      mocked.mockRestore();
    }
    // 새 판 · 내장 구조 규칙도 남지 않는다
    expect(snapshot()).toEqual(before);
    expect(await statusOf(health)).toBe('pass');
  }, 30_000);

  it('편집이 거부되면(형식 오류) 표시도 남지 않는다 (같은 트랜잭션)', async () => {
    const { h, lib, statusOf } = await ruleHarness();
    await expect(
      h.client.call('rule.update', {
        projectId: h.project.id,
        id: lib.id,
        author: human,
        statement: 'EARS 형식이 아닌 진술',
      }),
    ).rejects.toThrow();
    expect(await statusOf(lib)).toBe('pass');
    expect(h.read((store) => store.judgments.listUnattached())).toEqual([]);
  }, 30_000);

  it('블록 선언 저장: 대상 블록의 이름이 바뀌거나 지워진 규칙 · include가 바뀐 규칙은 재검증 필요이고, public · 위험도만 바뀐 블록의 규칙은 그대로다', async () => {
    const { h, lib, auth, health, statusOf } = await ruleHarness();
    const blocks = DECLARATION.blocks;
    const [authBlock, healthBlock, libBlock] = blocks as [
      (typeof blocks)[number],
      (typeof blocks)[number],
      (typeof blocks)[number],
    ];
    // health: public · 위험도만 → 표시 없음
    await h.client.call('blocks.set', {
      projectId: h.project.id,
      author: human,
      declaration: {
        blocks: [
          authBlock,
          { ...healthBlock, public: ['src/app/api/health/route.ts'], risk: 'high' },
          libBlock,
        ],
      },
    });
    expect([await statusOf(lib), await statusOf(auth), await statusOf(health)]).toEqual([
      'pass',
      'pass',
      'pass',
    ]);
    // lib 이름 바꿈(→ shared-lib, 의존도 따라 바꿈) · auth include 바꿈
    await h.client.call('blocks.set', {
      projectId: h.project.id,
      author: human,
      declaration: {
        blocks: [
          {
            ...authBlock,
            include: ['src/app/api/auth/**', 'src/auth/**'],
            dependsOn: ['shared-lib'],
          },
          { ...healthBlock, dependsOn: ['shared-lib'] },
          { ...libBlock, name: 'shared-lib' },
        ],
      },
    });
    expect([await statusOf(lib), await statusOf(auth), await statusOf(health)]).toEqual([
      'needs_recheck',
      'needs_recheck',
      'pass',
    ]);
  }, 30_000);
});
