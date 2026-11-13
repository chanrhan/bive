// 구현 · 검사 · 병합 시험 도우미 (M1-16): 픽스처 git 복사본 · 실제 SQLite · ScriptedAdapter(실제 고정 도구 · 경로 가드) ·
// 제품 단계 실행기(테스트 작성 · Red 확인 · 구현 · 검사 · 병합). 판정 · 의존성 설치만 주입한다(체크아웃 · 커밋 · 병합은 실제 git).
// 주입한 판정은 판정 러너 대신 체크아웃의 파일 내용으로 케이스 결과를 정한다: 기본은 헬스 체크 라우트가 서버 시각
// (`toISOString()`)을 담으면 RULE-001 통과, 그 밖 규칙은 통과. 호출마다 체크아웃 상태를 기록해 "판정은 커밋의 깨끗한
// 체크아웃에서"를 단언할 수 있게 한다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Rule, StepKind, TestCaseStatus } from '@bive/shared';
import type { RunDetail } from '@bive/store';

import type { AgentAdapter, SessionEvent, SessionSpec } from '../../src/agent/adapter.js';
import { loadScenario } from '../../src/agent/scenario.js';
import { ScriptedAdapter } from '../../src/agent/scripted-adapter.js';
import { PipelineEngine } from '../../src/engine/pipeline-engine.js';
import type { StepContext, StepExecutor, StepExecutors } from '../../src/engine/types.js';
import type { WorktreeManager } from '../../src/git/worktree-manager.js';
import type { JudgeRunInput, JudgeRunResult, JudgeRunStatus } from '../../src/judge/runner.js';
import { createRun } from '../../src/runs/run-service.js';
import { createCheckExecutor } from '../../src/steps/check.js';
import { createImplementationExecutor } from '../../src/steps/implementation.js';
import type { JudgingOptions } from '../../src/steps/judging.js';
import { createMergeExecutor } from '../../src/steps/merge.js';
import { createRedCheckExecutor } from '../../src/steps/red-check.js';
import { createTestWritingExecutor } from '../../src/steps/test-writing.js';
import {
  copyFixture,
  human,
  newId,
  ROUTE,
  seedProject,
  type SeededProject,
  T0,
  userGit,
  withProject,
} from './engine-harness.js';
import { makeBiveHome } from './process.js';

export const FAKE_INSTALL_MARKER = '.bive-fake-install';

/** 주입한 설치: `node_modules`에 표시 파일만 둔다 (실행 워크트리 · 판정 체크아웃 모두). */
export const fakeInstall = (dir: string): Promise<void> => {
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', FAKE_INSTALL_MARKER), '');
  return Promise.resolve();
};

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const listFiles = (root: string): string[] => {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
};

/** 주입한 판정이 본 체크아웃 상태. */
export interface JudgeCall {
  /** 판정을 부른 단계 */
  kind: StepKind;
  input: JudgeRunInput;
  head: string;
  /** 체크아웃의 `bive-acceptance/` 아래 파일 (`bive-acceptance/…`) */
  acceptance: string[];
  /** 실행 워크트리에 심은 무시된 파일이 보이는지 */
  planted: boolean;
  plantedDependency: boolean;
  /** 체크아웃에 의존성을 새로 설치했는지 (주입한 설치의 표시 파일) */
  installed: boolean;
  nodeModulesIsLink: boolean;
  /** 미추적 · 무시된 파일 (`git status --ignored`) */
  status: string;
  routeHasTime: boolean;
}

/** 판정 계획: 규칙 표시 ID → 케이스 상태 목록, 또는 판정 러너의 오류 결과. */
export type JudgeDecision =
  Record<string, readonly TestCaseStatus[]> | 'collect_error' | 'runner_error';

/** 기본 판정: RULE-001은 라우트가 서버 시각을 담으면 통과(케이스 2개), 그 밖 규칙은 통과. */
export const contentJudge = (call: JudgeCall): JudgeDecision =>
  Object.fromEntries(
    (call.input.ruleIds ?? []).map((id) => [
      id,
      id === 'RULE-001' && !call.routeHasTime ? ['failed', 'failed'] : ['passed', 'passed'],
    ]),
  );

/** 판정 러너 결과 모양. 케이스는 규칙 폴더의 첫 파일에 붙인다. */
export const judgeResult = (call: JudgeCall, decision: JudgeDecision): JudgeRunResult => {
  const { input } = call;
  const status: JudgeRunStatus = typeof decision === 'string' ? decision : 'completed';
  const plan = typeof decision === 'string' ? {} : decision;
  const cases = Object.entries(plan).flatMap(([ruleId, statuses]) => {
    const file =
      call.acceptance.find((rel) => rel.startsWith(`bive-acceptance/${ruleId}/`)) ??
      `bive-acceptance/${ruleId}/x.acc.ts`;
    return statuses.map((caseStatus, index) => ({
      name: `${ruleId} > 케이스 ${String(index + 1)}`,
      file,
      line: (index + 1) * 10,
      status: caseStatus,
      message: caseStatus === 'failed' ? `expected 실패 ${String(index + 1)}` : null,
    }));
  });
  const count = (s: TestCaseStatus) => cases.filter((c) => c.status === s).length;
  const dir = `/판정/${call.kind}`;
  return {
    status,
    runner: 'vitest',
    profile: input.profile,
    projectId: input.projectId,
    runId: input.runId,
    judgeId: newId(),
    ruleIds: input.ruleIds === undefined ? null : [...input.ruleIds],
    exitCode: status === 'completed' ? (count('failed') > 0 ? 1 : 0) : null,
    cases,
    summary: {
      files: Object.keys(plan).length,
      total: cases.length,
      passed: count('passed'),
      failed: count('failed'),
      skipped: cases.length - count('passed') - count('failed'),
    },
    problems: status === 'completed' ? [] : [{ file: null, message: `${status} 원인` }],
    message: status === 'completed' ? null : `${status} 원인`,
    reporterPath: status === 'completed' ? `${dir}/result.json` : null,
    tampered: null,
    paths: {
      dir,
      config: dir,
      collectConfig: dir,
      globalSetup: dir,
      httpHelper: dir,
      result: `${dir}/result.json`,
      collectResult: dir,
      collectLog: dir,
      stdout: dir,
      stderr: dir,
      profileLog: dir,
      serverLog: dir,
    },
    server: null,
    timings: {},
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  };
};

/** 판정 계획을 따르는 주입 판정. 호출마다 체크아웃 상태를 `calls`에 남긴다. */
export const injectedJudge =
  (
    calls: JudgeCall[],
    decide: (call: JudgeCall, index: number) => JudgeDecision = contentJudge,
    onJudge?: (call: JudgeCall, context: StepContext) => void,
  ): NonNullable<JudgingOptions['judge']> =>
  (input, context) => {
    const dir = input.worktreeDir;
    const nodeModules = path.join(dir, 'node_modules');
    const route = path.join(dir, ROUTE);
    const call: JudgeCall = {
      kind: context.step.kind,
      input,
      head: git(dir, 'rev-parse', 'HEAD'),
      acceptance: listFiles(path.join(dir, 'bive-acceptance')).map(
        (rel) => `bive-acceptance/${rel}`,
      ),
      planted: fs.existsSync(path.join(dir, 'src', 'planted', 'evil.ts')),
      plantedDependency: fs.existsSync(path.join(nodeModules, '.planted-dependency')),
      installed: fs.existsSync(path.join(nodeModules, FAKE_INSTALL_MARKER)),
      nodeModulesIsLink:
        fs.lstatSync(nodeModules, { throwIfNoEntry: false })?.isSymbolicLink() ?? false,
      status: git(dir, 'status', '--porcelain', '--ignored', '--untracked-files=all'),
      routeHasTime:
        fs.existsSync(route) && fs.readFileSync(route, 'utf8').includes('toISOString()'),
    };
    calls.push(call);
    onJudge?.(call, context);
    return Promise.resolve(judgeResult(call, decide(call, calls.length - 1)));
  };

/** 세션 시작 · 끝(결과 이벤트 직전)에 끼어드는 어댑터 감싸기. */
export const hookAdapter = (
  inner: AgentAdapter,
  hooks: {
    onStart?: (spec: SessionSpec) => void;
    /** 결과 이벤트를 내기 직전 (세션 도구 호출이 모두 끝난 뒤) */
    beforeResult?: (spec: SessionSpec) => void;
  },
): AgentAdapter => ({
  kind: inner.kind,
  startSession: (spec) => {
    hooks.onStart?.(spec);
    const events = inner.startSession(spec);
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
        for await (const event of events) {
          if (event.type === 'result') hooks.beforeResult?.(spec);
          yield event;
        }
      },
    };
  },
});

export interface PipelineHarness extends SeededProject {
  biveHome: string;
  repo: string;
  runId: string;
  rules: Rule[];
  engine: PipelineEngine;
  judgeCalls: JudgeCall[];
  sessions: SessionSpec[];
  /** 같은 저장소 · 실행기로 새 엔진 (재기동 흉내) */
  newEngine(): PipelineEngine;
}

export interface PipelineSetupOptions {
  scenario?: string;
  scenariosDir?: string;
  /** 승인된 규칙을 하나 더 (RULE-002, 대상 아님) */
  secondRule?: boolean;
  /** 실행 시작 전 저장소를 고치고 커밋한다 */
  prepareRepo?: (repo: string) => void;
  /** 판정 계획 (기본 `contentJudge`) */
  decide?: (call: JudgeCall, index: number) => JudgeDecision;
  onJudge?: (call: JudgeCall, context: StepContext) => void;
  wrapAdapter?: (adapter: AgentAdapter, h: () => PipelineHarness) => AgentAdapter;
  /** 실행기 바꿔 끼우기 (기본 제품 실행기를 받아 감싼다) */
  executors?: (
    defaults: Required<
      Pick<StepExecutors, 'test_writing' | 'red_check' | 'implementation' | 'check' | 'merge'>
    >,
  ) => StepExecutors;
  /** 워크트리 관리자 (기본 엔진 기본값). 같은 하네스의 엔진들이 같은 관리자를 쓴다 */
  worktrees?: (biveHome: string) => WorktreeManager;
  merge?: { checkTimeoutMs?: number };
  /** 실제 설치 · 판정 러너 (판정 1회 제한 시간 ms). 지정하면 `decide` · `onJudge`는 쓰지 않는다 */
  realJudgeTimeoutMs?: number;
  temps: string[];
  engines: PipelineEngine[];
}

/** 프로젝트 · 실행을 만들고 제품 실행기(판정 · 설치 주입)로 엔진을 준비한다. */
export const setupPipeline = (options: PipelineSetupOptions): PipelineHarness => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(options.temps);
  if (options.prepareRepo !== undefined) {
    options.prepareRepo(repo);
    userGit(repo, 'add', '--all');
    userGit(repo, 'commit', '-q', '-m', 'fixture: 시험 준비');
  }
  const seeded = seedProject(biveHome, repo);
  const rules = [seeded.rule];
  if (options.secondRule === true) {
    rules.push(
      withProject(biveHome, seeded.project.id, (store) =>
        store.rules.create({
          id: newId(),
          title: '헬스 체크 상태',
          statement:
            'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 응답 JSON의 ok 값 true를 유지한다',
          kind: seeded.rule.kind,
          checkKinds: seeded.rule.checkKinds,
          parentRequirementId: seeded.rule.parentRequirementId,
          builtin: false,
          targetBlockIds: [],
          risk: null,
          contractId: null,
          author: seeded.rule.author,
          normState: 'approved',
          createdAt: new Date(T0).toISOString(),
        }),
      ),
    );
  }
  const ref: { harness?: PipelineHarness } = {};
  const scripted = new ScriptedAdapter({
    scenario: loadScenario(options.scenario ?? 'happy-path', options.scenariosDir),
    biveHome,
    pollIntervalMs: 20,
  });
  const sessions: SessionSpec[] = [];
  const recording: AgentAdapter = {
    kind: scripted.kind,
    startSession: (spec) => {
      sessions.push(spec);
      return scripted.startSession(spec);
    },
  };
  const adapter =
    options.wrapAdapter?.(recording, () => {
      if (ref.harness === undefined) throw new Error('하네스 준비 전');
      return ref.harness;
    }) ?? recording;
  const judgeCalls: JudgeCall[] = [];
  const judging: JudgingOptions =
    options.realJudgeTimeoutMs === undefined
      ? {
          judge: injectedJudge(judgeCalls, options.decide, options.onJudge),
          installDependencies: fakeInstall,
        }
      : { judgeTimeoutMs: options.realJudgeTimeoutMs };
  const defaults = {
    test_writing: createTestWritingExecutor(),
    red_check: createRedCheckExecutor(judging),
    implementation: createImplementationExecutor(judging),
    check: createCheckExecutor(judging),
    merge: createMergeExecutor({ ...judging, ...options.merge }),
  };
  const executors: StepExecutors = options.executors?.(defaults) ?? defaults;
  const worktrees = options.worktrees?.(biveHome);
  const newEngine = (): PipelineEngine => {
    const engine = new PipelineEngine({
      biveHome,
      agent: adapter,
      executors,
      ...(worktrees === undefined ? {} : { worktrees }),
    });
    options.engines.push(engine);
    return engine;
  };
  const engine = newEngine();
  const runId = withProject(biveHome, seeded.project.id, (store) =>
    createRun(
      store,
      { ruleIds: [seeded.rule.id], author: human },
      { clientId: null },
      { now: Date.now, newId },
    ),
  ).run.id;
  ref.harness = {
    ...seeded,
    biveHome,
    repo,
    runId,
    rules,
    engine,
    judgeCalls,
    sessions,
    newEngine,
  };
  return ref.harness;
};

export const detailOf = (h: PipelineHarness): RunDetail =>
  withProject(h.biveHome, h.project.id, (store) => {
    const detail = store.runs.getDetail(h.runId);
    if (detail === null) throw new Error('실행 없음');
    return detail;
  });

/** 승인 단계를 판정해 구동하고 끝날 때까지 기다린다. */
export const runToEnd = async (h: PipelineHarness): Promise<RunDetail> => {
  if (!h.engine.evaluateApproval(h.project.id, h.runId)) throw new Error('승인 단계 미충족');
  await h.engine.settled();
  return detailOf(h);
};

export const attempts = (detail: RunDetail, ...kinds: StepKind[]): string[] =>
  detail.steps
    .filter((step) => kinds.length === 0 || kinds.includes(step.kind))
    .map((step) => `${step.kind}#${String(step.attempt)}:${step.status}`);

export const stepOf = (detail: RunDetail, kind: StepKind, attempt = 1) => {
  const step = detail.steps.find((s) => s.kind === kind && s.attempt === attempt);
  if (step === undefined) throw new Error(`단계 없음: ${kind}#${String(attempt)}`);
  return step;
};

export const exitOf = (detail: RunDetail, kind: StepKind, attempt = 1): Record<string, unknown> =>
  stepOf(detail, kind, attempt).exitDetail as Record<string, unknown>;

export const judgmentsOf = (h: PipelineHarness) =>
  withProject(h.biveHome, h.project.id, (store) => store.judgments.listByRun(h.runId));

export const toolCallsOf = (h: PipelineHarness) =>
  withProject(h.biveHome, h.project.id, (store) => store.sessions.toolCalls(h.runId));

/** 실행기를 감싸 앞에서 무언가를 한다. */
export const before =
  (inner: StepExecutor, fn: (context: StepContext) => void | Promise<void>): StepExecutor =>
  async (context) => {
    await fn(context);
    return inner(context);
  };

/** 실행 워크트리에 무시된 파일(에이전트가 `.gitignore`로 숨긴 소스 · 의존성)을 심는다. */
export const plantIgnored = (worktree: string): void => {
  const planted = path.join(worktree, 'src', 'planted');
  fs.mkdirSync(planted, { recursive: true });
  fs.writeFileSync(path.join(planted, '.gitignore'), '*\n');
  fs.writeFileSync(path.join(planted, 'evil.ts'), 'export const evil = true;\n');
  fs.mkdirSync(path.join(worktree, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'node_modules', '.planted-dependency'), '');
};
