// 변이 주입 단계 시험 도우미 (M3-07 #52 · M3-54 #311): 픽스처 git 복사본 · 실제 SQLite · 블록 선언 · ScriptedAdapter(실제 고정 도구 ·
// 경로 가드) · 제품 변이 주입 실행기. 앞 단계(테스트 작성 · Red 확인 · 구현 · 검사)는 시험용 실행기이고 판정 · 설치만 주입한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  type BlockDeclaration,
  type Risk,
  type Rule,
  type SettingsPatch,
  type TestCaseStatus,
} from '@bive/shared';
import { registerProject } from '@bive/store';
import { stringify } from 'yaml';

import type { AgentAdapter, SessionSpec } from '../../src/agent/adapter.js';
import { loadScenario } from '../../src/agent/scenario.js';
import { ScriptedAdapter } from '../../src/agent/scripted-adapter.js';
import { PipelineEngine } from '../../src/engine/pipeline-engine.js';
import type { StepExecutor } from '../../src/engine/types.js';
import { hashAcceptanceFiles } from '../../src/judge/checkout.js';
import { AutoStarter } from '../../src/runs/auto-start.js';
import { createRun } from '../../src/runs/run-service.js';
import { createMutationExecutor, type MutationStepOptions } from '../../src/steps/mutation.js';
import {
  COMPLETE_SETTINGS,
  copyFixture,
  human,
  mergeStep,
  newId,
  scripted,
  T0,
  userGit,
  withProject,
} from './engine-harness.js';
import {
  fakeInstall,
  injectedJudge,
  type JudgeCall,
  type JudgeDecision,
} from './pipeline-harness.js';
import { cleanup, makeBiveHome } from './process.js';

/** 이 도우미가 만든 임시 폴더 · 엔진 (시험 파일의 afterEach가 `cleanupMutationHarness`로 정리한다). */
export const temps: string[] = [];
export const engines: PipelineEngine[] = [];

export const cleanupMutationHarness = async (): Promise<void> => {
  for (const engine of engines.splice(0)) await engine.stop();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
};

export const HEALTH = 'src/app/api/health/route.ts';
export const AUTH = 'src/app/api/auth/session/route.ts';
export const LIB = 'src/lib/db.ts';

/** 픽스처 블록 선언 예제와 같은 블록 (auth high · health medium · lib low). */
export const DECLARATION: BlockDeclaration = {
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

export interface RuleSeed {
  readonly blocks: readonly string[];
  readonly risk: Risk | null;
  /** 기준 커밋에 인수 테스트 파일을 둔다 (기본 참) */
  readonly acceptance?: boolean;
}

export const RESULT = (cost: number) => ({
  subtype: 'success' as const,
  total_cost_usd: cost,
  num_turns: 2,
  modelUsage: {
    'test-model': {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: cost,
    },
  },
});

export type Turn = { tool: string; args: Record<string, unknown> } | { message: string };

/** 규칙마다(`when.ruleId`) 변이 주입 세션 대본. 대본이 없는 규칙은 변이를 내지 않는 세션이다. */
export const writeScenario = (
  sessions: Record<string, Turn[]>,
  cost = 0.01,
  extra: {
    readonly subtypes?: Record<string, 'error_during_execution'>;
    readonly noMutator?: boolean;
  } = {},
): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bive-mutation-'));
  temps.push(dir);
  const scenario = structuredClone(loadScenario('happy-path'));
  scenario.name = 'mutation-test';
  // 변이 주입 대본이 없는 시나리오 (가짜 어댑터의 기본 세션: 변이 없이 정상 종료, M3-54)
  scenario.roles =
    extra.noMutator === true
      ? {}
      : {
          mutator: {
            sessions: [
              ...Object.entries(sessions).map(([ruleId, turns]) => ({
                when: { ruleId },
                turns,
                result: {
                  ...RESULT(cost),
                  subtype: (extra.subtypes?.[ruleId] ?? 'success') as
                    'success' | 'error_during_execution',
                },
              })),
              { turns: [{ message: '낼 변이가 없다.' }], result: RESULT(cost) },
            ],
          },
        };
  fs.writeFileSync(path.join(dir, 'mutation-test.yaml'), stringify(scenario));
  return dir;
};

/** 시험용 Red 확인: 워크트리(= 기준 커밋)의 인수 테스트 해시만 남긴다. */
export const redFromWorktree: StepExecutor = (context) =>
  Promise.resolve({
    status: 'passed',
    exitDetail: { acceptanceHashes: hashAcceptanceFiles(context.git.worktreePath) },
  });

export interface Harness {
  biveHome: string;
  repo: string;
  projectId: string;
  runId: string;
  rules: Rule[];
  engine: PipelineEngine;
  judgeCalls: JudgeCall[];
  sessions: SessionSpec[];
  /** 세션이 열릴 때 본 세션 폴더의 파일 (세션 폴더 기준 경로, 정렬) */
  sessionFiles: string[][];
  /** 세션이 열릴 때 본 세션 폴더의 파일 내용 */
  sessionTexts: Record<string, string>[];
  /** 엔진 저장 이벤트를 받는 자동 시작 창구 (보강 실행을 만든다) */
  autoStarter: AutoStarter;
  logs: string[];
}

export interface SetupOptions {
  readonly rules: readonly RuleSeed[];
  readonly sessions: Record<string, Turn[]>;
  readonly decide?: (call: JudgeCall) => JudgeDecision;
  readonly settings?: SettingsPatch;
  readonly cost?: number;
  readonly judging?: Partial<MutationStepOptions>;
  /** 블록 선언 (기본 `DECLARATION`) */
  readonly declaration?: BlockDeclaration;
  /** 기준 커밋에 더 둘 파일 (경로 → 내용) */
  readonly extraFiles?: Record<string, string>;
  readonly subtypes?: Record<string, 'error_during_execution'>;
  readonly noMutator?: boolean;
  /** 자동 시작 배선을 끈다 (보강 실행을 시험이 직접 만들 때) */
  readonly noAutoStart?: boolean;
}

export const listTree = (root: string): string[] => {
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

export const setup = (options: SetupOptions): Harness => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  options.rules.forEach((seed, index) => {
    if (seed.acceptance === false) return;
    const id = `RULE-${String(index + 1).padStart(3, '0')}`;
    const file = path.join(repo, 'bive-acceptance', id, 'mutation.acc.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `import { it } from 'vitest';\nit('${id} 동작', () => undefined);\n`);
  });
  for (const [rel, text] of Object.entries(options.extraFiles ?? {})) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  userGit(repo, 'add', '--all');
  userGit(repo, 'commit', '-q', '-m', 'fixture: 인수 테스트');
  const project = registerProject(
    {
      id: newId(),
      name: '샘플 앱',
      rootPath: repo,
      baseBranch: 'main',
      createdAt: new Date(T0).toISOString(),
    },
    { home: biveHome },
  );
  const at = new Date(T0).toISOString();
  const rules = withProject(biveHome, project.id, (store) => {
    store.settings.update(options.settings ?? COMPLETE_SETTINGS, { by: human, at });
    store.blockDeclarations.set(options.declaration ?? DECLARATION, { at, by: human });
    const requirement = store.requirements.create({
      id: newId(),
      text: '변이 시험 요구사항',
      author: human,
      normState: 'approved',
      createdAt: at,
    });
    return options.rules.map((seed, index) =>
      store.rules.create({
        id: newId(),
        title: `규칙 ${String(index + 1)}`,
        statement: `WHEN 클라이언트가 요청 ${String(index + 1)}을 보내면 THE SYSTEM SHALL 정해진 응답을 돌려준다`,
        kind: 'business',
        checkKinds: ['test'],
        parentRequirementId: requirement.id,
        builtin: false,
        targetBlockIds: [...seed.blocks],
        risk: seed.risk,
        contractId: null,
        author: { kind: 'agent', role: 'rule-writer' },
        normState: 'approved',
        createdAt: at,
      }),
    );
  });
  const scripted = new ScriptedAdapter({
    scenario: loadScenario(
      'mutation-test',
      writeScenario(options.sessions, options.cost, {
        ...(options.subtypes === undefined ? {} : { subtypes: options.subtypes }),
        ...(options.noMutator === undefined ? {} : { noMutator: options.noMutator }),
      }),
    ),
    biveHome,
    pollIntervalMs: 20,
  });
  const sessions: SessionSpec[] = [];
  const sessionFiles: string[][] = [];
  const sessionTexts: Record<string, string>[] = [];
  const adapter: AgentAdapter = {
    kind: scripted.kind,
    startSession: (spec) => {
      sessions.push(spec);
      const listed = listTree(spec.workDir);
      sessionFiles.push(listed);
      sessionTexts.push(
        Object.fromEntries(
          listed.map((rel) => [rel, fs.readFileSync(path.join(spec.workDir, rel), 'utf8')]),
        ),
      );
      return scripted.startSession(spec);
    },
  };
  const judgeCalls: JudgeCall[] = [];
  const logs: string[] = [];
  // 자동 시작 배선 (오케스트레이터와 같이 엔진 저장 이벤트를 넘긴다, M3-54): 병합된 유형 A 실행의 변이 생존 → 보강 실행
  const starter: { current: AutoStarter | null } = { current: null };
  const engine = new PipelineEngine({
    biveHome,
    agent: adapter,
    onEvent: (event) => {
      if (options.noAutoStart !== true) starter.current?.observe(event);
    },
    executors: {
      test_writing: reinforcingTestWriting,
      red_check: redFromWorktree,
      green_check: redFromWorktree,
      implementation: implementOutsideBlocks,
      check: scriptedPass(),
      mutation: createMutationExecutor({
        judge: injectedJudge(judgeCalls, options.decide ?? killedWhenMutated),
        installDependencies: fakeInstall,
        ...options.judging,
      }),
      merge: mergeStep,
    },
  });
  engines.push(engine);
  starter.current = new AutoStarter({ biveHome, engine, log: (line) => logs.push(line) });
  const runId = withProject(biveHome, project.id, (store) =>
    createRun(
      store,
      { ruleIds: rules.map((rule) => rule.id), author: human },
      { clientId: null },
      { now: Date.now, newId },
    ),
  ).run.id;
  return {
    biveHome,
    repo,
    projectId: project.id,
    runId,
    rules,
    engine,
    judgeCalls,
    sessions,
    sessionFiles,
    sessionTexts,
    autoStarter: starter.current,
    logs,
  };
};

export const scriptedPass = (): StepExecutor => scripted(['passed']);

/** 시험용 구현: 블록 밖 파일 하나를 더한다 (병합할 커밋이 생기게, 변이 대상 · 세션 사본과 무관). */
export const implementOutsideBlocks: StepExecutor = (context) => {
  fs.mkdirSync(path.join(context.git.worktreePath, 'notes'), { recursive: true });
  fs.writeFileSync(
    path.join(context.git.worktreePath, 'notes', `impl-${context.run.displayId}.md`),
    '구현\n',
  );
  return Promise.resolve({ status: 'passed' });
};

/** 기본 판정: 체크아웃의 파일이 바뀌었으면(변이가 적용됨) 판정한 규칙의 케이스 하나가 실패, 아니면 모두 통과. */
export const killedWhenMutated = (call: JudgeCall): JudgeDecision =>
  Object.fromEntries(
    (call.input.ruleIds ?? []).map((id) => [
      id,
      call.status.includes('M src/')
        ? (['failed', 'passed'] as const)
        : (['passed', 'passed'] as const),
    ]),
  );

export const allPass = (call: JudgeCall): JudgeDecision =>
  Object.fromEntries(
    (call.input.ruleIds ?? []).map((id) => [id, ['passed', 'passed'] as readonly TestCaseStatus[]]),
  );

/** 실행 · 자동 시작(보강 실행과 그 진행)이 모두 멈출 때까지 기다린다. */
export const settleAll = async (h: Harness): Promise<void> => {
  for (let i = 0; i < 10; i += 1) {
    await h.engine.settled();
    await h.autoStarter.idle();
    await h.engine.settled();
    const busy = withProject(h.biveHome, h.projectId, (store) =>
      store.runs
        .list()
        .some((run) => ['waiting_approval', 'queued', 'running'].includes(run.status)),
    );
    if (!busy) return;
  }
};

/** 실행 목록 (표시 ID 순). */
export const runsOf = (h: Harness) =>
  withProject(h.biveHome, h.projectId, (store) =>
    store.runs.list().map((run) => store.runs.getDetail(run.id)!),
  );

/**
 * 시험용 테스트 작성: 유형 C(보강) 실행이면 대상 규칙 폴더에 새 인수 테스트 파일을 더한다(테스트 작성 커밋이 생기게, 시도마다 한 파일).
 * 유형 A는 기준 커밋의 인수 테스트를 그대로 쓴다.
 */
export const reinforcingTestWriting: StepExecutor = (context) => {
  if (context.run.type === 'C') {
    const rule = context.read((store) => store.rules.get(context.run.targetRuleIds[0] ?? ''));
    const dir = path.join(context.git.worktreePath, 'bive-acceptance', rule?.displayId ?? 'X');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `reinforce-${String(context.step.attempt)}.acc.ts`),
      `import { it } from 'vitest';\nit('보강 ${String(context.step.attempt)}', () => undefined);\n`,
    );
  }
  return Promise.resolve({ status: 'passed' });
};

export const runToEnd = async (h: Harness) => {
  if (!h.engine.evaluateApproval(h.projectId, h.runId)) throw new Error('승인 단계 미충족');
  await h.engine.settled();
  return withProject(h.biveHome, h.projectId, (store) => {
    const detail = store.runs.getDetail(h.runId);
    if (detail === null) throw new Error('실행 없음');
    return detail;
  });
};

export const mutationsOf = (h: Harness) =>
  withProject(h.biveHome, h.projectId, (store) => store.mutations.listByRun(h.runId));
export const statusOf = (h: Harness, rule: Rule) =>
  withProject(h.biveHome, h.projectId, (store) => store.mutations.statusOf(rule.id));
export const toolCallsOf = (h: Harness) =>
  withProject(h.biveHome, h.projectId, (store) => store.sessions.toolCalls(h.runId));
export const mainTip = (h: Harness) => userGit(h.repo, 'rev-parse', 'refs/heads/main');
export const stepExit = (detail: Awaited<ReturnType<typeof runToEnd>>) =>
  detail.steps.find((step) => step.kind === 'mutation')?.exitDetail as Record<string, unknown>;
