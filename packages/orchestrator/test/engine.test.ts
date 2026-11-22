// 파이프라인 엔진 (M1-14 수용 기준, RUN-01 · RUN-02 · RUN-08 · PRD 5.1 · ADR-011 · ADR-026 · ADR-027 · ADR-066).
// 픽스처 git 복사본 · 실제 git(워크트리 · 커밋 · 병합) · 실제 SQLite · ScriptedAdapter(실제 고정 도구 · 세션 가드).
// 단계 종료 조건은 시험용 실행기(파일 내용 대역)로 정하고 판정 러너는 돌리지 않는다(#28 · #29가 실제 실행기를 넣는다).
// 재기동 시험은 오케스트레이터 프로세스를 실제로 SIGKILL 하고 다시 띄운다.
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type AgentRole,
  ErrorCode,
  RUN_STATUS_TRANSITIONS,
  RUN_STEP_PLANS,
  type RunStatus,
  type SettingsPatch,
  type Step,
  type StepKind,
} from '@bive/shared';
import type { ProjectStore, RunDetail } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentAdapter, SessionEvent } from '../src/agent/adapter.js';
import { loadScenario } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import { INTERRUPTED_EXIT_DETAIL, PipelineEngine } from '../src/engine/pipeline-engine.js';
import type { StepExecutor, StepExecutors } from '../src/engine/types.js';
import { runPaths } from '../src/run-paths.js';
import { createRun, saveNewRun } from '../src/runs/run-service.js';
import { connect, RpcCallError, type TestClient } from './helpers/client.js';
import {
  COMPLETE_SETTINGS,
  copyFixture,
  human,
  newId,
  ROUTE,
  scripted,
  seedProject,
  type SeededProject,
  TEST_SCENARIOS_DIR,
  testExecutors,
  userGit,
  withProject,
} from './helpers/engine-harness.js';
import {
  cleanup,
  makeBiveHome,
  sleep,
  spawnScript,
  type Spawned,
  waitFor,
} from './helpers/process.js';

const temps: string[] = [];
const engines: PipelineEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Harness extends SeededProject {
  biveHome: string;
  repo: string;
  runId: string;
  engine: PipelineEngine;
  adapter: AgentAdapter;
  executors: StepExecutors;
  /** 저장마다의 (상태, 현재 단계) */
  saves: string[];
  newEngine(): PipelineEngine;
}

interface SetupOptions {
  scenario?: string;
  scenariosDir?: string;
  executors?: StepExecutors;
  settings?: SettingsPatch;
  wrap?: (adapter: AgentAdapter) => AgentAdapter;
  normState?: 'approved' | 'provisional';
}

const setup = (options: SetupOptions = {}): Harness => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const seeded = seedProject(biveHome, repo, options.settings, options.normState);
  const scripted = new ScriptedAdapter({
    scenario: loadScenario(options.scenario ?? 'happy-path', options.scenariosDir),
    biveHome,
    pollIntervalMs: 20,
  });
  const adapter = options.wrap?.(scripted) ?? scripted;
  const executors = testExecutors(options.executors);
  const saves: string[] = [];
  const newEngine = (): PipelineEngine => {
    const engine = new PipelineEngine({
      biveHome,
      agent: adapter,
      executors,
      onEvent: (event) => {
        if (event.type !== 'run.saved') return;
        saves.push(`${event.detail.run.status}:${String(event.detail.run.currentStep)}`);
      },
    });
    engines.push(engine);
    return engine;
  };
  const runId = withProject(biveHome, seeded.project.id, (store) =>
    createRun(
      store,
      { ruleIds: [seeded.rule.id], author: human },
      { clientId: null },
      {
        now: Date.now,
        newId,
      },
    ),
  ).run.id;
  return {
    ...seeded,
    biveHome,
    repo,
    runId,
    engine: newEngine(),
    adapter,
    executors,
    saves,
    newEngine,
  };
};

const detailOf = (h: Harness): RunDetail =>
  withProject(h.biveHome, h.project.id, (store) => {
    const detail = store.runs.getDetail(h.runId);
    if (detail === null) throw new Error('실행 없음');
    return detail;
  });

const sessionsOf = (h: Harness, role?: AgentRole) =>
  withProject(h.biveHome, h.project.id, (store) =>
    store.sessions.listByRun(h.runId).filter((s) => role === undefined || s.role === role),
  );

const attempts = (detail: RunDetail, kind?: StepKind): string[] =>
  detail.steps
    .filter((step) => kind === undefined || step.kind === kind)
    .map((step) => `${step.kind}#${String(step.attempt)}:${step.status}`);

const stepOf = (detail: RunDetail, kind: StepKind, attempt = 1): Step => {
  const step = detail.steps.find((s) => s.kind === kind && s.attempt === attempt);
  if (step === undefined) throw new Error(`단계 없음: ${kind}#${String(attempt)}`);
  return step;
};

/** 승인 단계를 판정하고 구동이 끝날 때까지 기다린다. */
const runToEnd = async (h: Harness): Promise<RunDetail> => {
  expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
  await h.engine.settled();
  return detailOf(h);
};

const mainTip = (h: Harness): string => userGit(h.repo, 'rev-parse', 'refs/heads/main');
const isLocked = (h: Harness, worktree: string): boolean =>
  userGit(h.repo, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .some(
      (entry) =>
        entry.includes(`worktree ${fs.realpathSync(worktree)}`) && entry.includes('\nlocked'),
    );

describe('유형 A 단계 순서 · 전이 (수용 기준 1)', () => {
  it('승인 → 테스트 작성 → Red 확인 → 구현 → 검사 → 변이 주입(skipped) → 병합 → 화면 갱신 → merged', async () => {
    const h = setup();
    const initialMain = mainTip(h);
    const notified: string[] = [];
    const engine = new PipelineEngine({
      biveHome: h.biveHome,
      agent: h.adapter,
      executors: h.executors,
      onEvent: (event) => {
        if (event.type === 'notify') notified.push(event.topic);
        if (event.type !== 'run.saved') return;
        h.saves.push(`${event.detail.run.status}:${String(event.detail.run.currentStep)}`);
      },
    });
    engines.push(engine);
    h.engine = engine;

    const done = await runToEnd(h);

    // 단계는 RUN_STEP_PLANS.A 순서, 시도 1회씩, 변이 주입만 skipped
    expect(done.steps.map((s) => s.kind)).toEqual([...RUN_STEP_PLANS.A]);
    expect(attempts(done)).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'red_check#1:passed',
      'implementation#1:passed',
      'check#1:passed',
      'mutation#1:skipped',
      'merge#1:passed',
      'screen_update#1:passed',
    ]);
    // 단계 종료마다 1회 저장: (상태, 현재 단계)가 단계 순서대로 바뀐다 (워크트리 생성 정보 저장 1회 포함)
    expect(h.saves).toEqual([
      'running:test_writing',
      'running:test_writing',
      'running:red_check',
      'running:implementation',
      'running:check',
      'running:mutation',
      'running:merge',
      'running:screen_update',
      'merged:null',
    ]);
    expect(notified).toEqual(['screen_update']);

    const { run } = done;
    expect(run).toMatchObject({
      status: 'merged',
      currentStep: null,
      lastCompletedStep: 'screen_update',
      regressionCount: 0,
      failureReason: null,
      branch: 'bive/run-EXE-001',
      baseCommit: initialMain,
    });
    expect(run.endedAt).not.toBeNull();
    // 커밋은 테스트 작성 · 구현 종료 때 오케스트레이터가 만든다 (RUN-08)
    const testCommit = stepOf(done, 'test_writing').commit;
    const implCommit = stepOf(done, 'implementation').commit;
    expect(testCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(implCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(run.headCommit).toBe(implCommit);
    expect(userGit(h.repo, 'rev-parse', `${String(implCommit)}^`)).toBe(testCommit);
    expect(userGit(h.repo, 'log', '-1', '--format=%an <%ae>', String(implCommit))).toBe(
      'BIVE <bive@bive.invalid>',
    );
    for (const kind of ['approval', 'red_check', 'check', 'mutation', 'merge'] as const) {
      expect(stepOf(done, kind).commit).toBeNull();
    }
    // 병합: 기준 브랜치가 병합 커밋을 가리키고 실행 커밋이 들어 있다
    expect(run.mergeCommit).toBe(mainTip(h));
    expect(
      userGit(h.repo, 'rev-list', '--parents', '-n', '1', String(run.mergeCommit)).split(' '),
    ).toEqual([String(run.mergeCommit), initialMain, String(implCommit)]);
    expect(userGit(h.repo, 'show', `main:${ROUTE}`)).toContain('toISOString()');
    expect(stepOf(done, 'mutation').exitDetail).toEqual({ reason: 'not_in_scope', scope: 'P1' });

    // 세션 · 도구 호출 · 도구 목록 기록 (세션당 init 1회, 도구 호출은 거부 포함 전부)
    const sessions = sessionsOf(h);
    expect(sessions.map((s) => [s.role, s.endReason, s.totalCostUsd, s.numTurns])).toEqual([
      ['test-writer', 'success', 0.0421, 2],
      ['implementer', 'success', 0.0587, 3],
    ]);
    expect(sessions.map((s) => s.stepId)).toEqual([
      stepOf(done, 'test_writing').id,
      stepOf(done, 'implementation').id,
    ]);
    expect(run.toolManifest).toEqual([
      { role: 'test-writer', tools: expect.any(Array), mcpServerCount: 1 },
      { role: 'implementer', tools: expect.any(Array), mcpServerCount: 1 },
    ]);
    const calls = withProject(h.biveHome, h.project.id, (store) =>
      store.sessions.toolCalls(h.runId),
    );
    expect(calls.map((c) => [c.role, c.name, c.status])).toEqual([
      ['test-writer', 'write_file', 'ok'],
      ['implementer', 'read_file', 'ok'],
      ['implementer', 'write_file', 'ok'],
    ]);
  }, 60_000);

  it('확인 상태가 미확인인 규칙으로도 실행이 생성 · 단계 진행 · 판정 · 병합을 거쳐 merged가 되고 확인 상태는 그대로다 (M7-01, ADR-100 D2 · D8)', async () => {
    const h = setup();
    const target = { entity: 'Rule', id: h.rule.id } as const;
    const confirmationOf = () =>
      withProject(h.biveHome, h.project.id, (store) => ({
        rule: store.rules.get(h.rule.id)?.confirmation,
        stored: store.confirmations.get(target),
      }));
    // 대상 규칙은 제안 승인 없이 생긴 에이전트 규칙이라 미확인이고, 실행은 이미 생성됐다 (waiting_approval)
    expect(confirmationOf()).toEqual({
      rule: { state: 'unconfirmed' },
      stored: { state: 'unconfirmed' },
    });
    expect(detailOf(h).run).toMatchObject({ status: 'waiting_approval' });

    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'merged', failureReason: null });
    expect(attempts(done)).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'red_check#1:passed',
      'implementation#1:passed',
      'check#1:passed',
      'mutation#1:skipped',
      'merge#1:passed',
      'screen_update#1:passed',
    ]);
    expect(done.run.mergeCommit).toBe(mainTip(h));
    // 실행은 확인 상태를 바꾸지 않고 승인 기록에 확인 항목을 만들지 않는다
    expect(confirmationOf()).toEqual({
      rule: { state: 'unconfirmed' },
      stored: { state: 'unconfirmed' },
    });
    expect(
      withProject(h.biveHome, h.project.id, (store) =>
        store.approvalLog.list().map((entry) => entry.action),
      ),
    ).toEqual(['run_start']);
  }, 60_000);

  it('승인 단계 자리는 효력 확인: 대상 규칙이 효력 상태가 아니면 사람을 기다리지 않고 그 자리에서 실행을 끝낸다 (ADR-100 A3, ADR-107)', async () => {
    const h = setup({ normState: 'provisional' });
    const before = detailOf(h);
    expect(before.run).toMatchObject({ status: 'waiting_approval', currentStep: 'approval' });
    expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(false);
    await h.engine.settled();
    const after = detailOf(h);
    // 실행은 실패(효력 없는 대상 규칙)로 끝나고 승인 단계 시도만 실패로 닫힌다. 다음 단계는 열리지 않는다
    expect(after.run).toMatchObject({
      status: 'failed',
      failureReason: 'target_rule_unavailable',
      currentStep: 'approval',
      lastCompletedStep: null,
      startedAt: null,
      branch: null,
      worktreePath: null,
    });
    expect(after.run.endedAt).not.toBeNull();
    expect(attempts(after)).toEqual([
      'approval#1:failed',
      'test_writing#1:pending',
      'red_check#1:pending',
      'implementation#1:pending',
      'check#1:pending',
      'mutation#1:pending',
      'merge#1:pending',
      'screen_update#1:pending',
    ]);
    expect(stepOf(after, 'approval').exitDetail).toEqual({
      reason: 'target_rule_unavailable',
      unavailableRuleIds: [h.rule.id],
    });
    // 저장 1회(종료)가 알려지고, 브랜치 · 세션이 없으며, 다시 판정해도 승인 대기로 돌아가지 않는다
    expect(h.saves).toEqual(['failed:approval']);
    expect(userGit(h.repo, 'branch', '--list', 'bive/run-*')).toBe('');
    expect(sessionsOf(h)).toEqual([]);
    expect(() => h.engine.evaluateApproval(h.project.id, h.runId)).toThrow(/승인 단계가 아닙니다/);
    expect(detailOf(h)).toEqual(after);
  });

  it('승인 대기에 머무는 경로가 없다: 효력 있는 대상이면 통과, 아니면 실패. 꺼진 동안 남은 승인 대기는 기동 때 판정한다 (ADR-107)', async () => {
    // 효력 있음 → 통과 · 구동 (승인 대기를 벗어난다)
    const effective = setup();
    expect(effective.engine.evaluateApproval(effective.project.id, effective.runId)).toBe(true);
    expect(detailOf(effective).run.status).not.toBe('waiting_approval');
    await effective.engine.settled();
    expect(detailOf(effective).run.status).toBe('merged');

    // 생성 뒤 판정 전에 엔진이 멈춘 실행 (승인 대기로 남음) → 다음 엔진의 기동 판정이 이어간다
    const left = setup();
    await left.engine.stop();
    expect(left.engine.evaluateApproval(left.project.id, left.runId)).toBe(false);
    expect(detailOf(left).run.status).toBe('waiting_approval');
    const next = left.newEngine();
    next.startQueuedRuns();
    await next.settled();
    expect(detailOf(left).run).toMatchObject({ status: 'merged', failureReason: null });

    // 효력 없는 대상으로 남은 승인 대기도 기동 판정이 끝낸다
    const stale = setup({ normState: 'provisional' });
    await stale.engine.stop();
    const restarted = stale.newEngine();
    restarted.startQueuedRuns();
    await restarted.settled();
    expect(detailOf(stale).run).toMatchObject({
      status: 'failed',
      failureReason: 'target_rule_unavailable',
    });
  }, 60_000);

  it('규칙 승인 뒤(onNormsApproved) 그 프로젝트의 승인 대기 실행을 판정해 진행한다', async () => {
    const h = setup();
    h.engine.onNormsApproved(h.project.id);
    await h.engine.settled();
    expect(detailOf(h).run).toMatchObject({ status: 'merged', currentStep: null });
  }, 60_000);

  it('승인 기록 run_start가 없는 실행은 진행하지 않고 failed (run_without_log, NFR-01)', async () => {
    const h = setup();
    // 승인 기록을 남기지 않은 실행을 저장소에 바로 만든다 (파이프 밖 경로의 흉내)
    const forged = withProject(h.biveHome, h.project.id, (store) => {
      const plan = RUN_STEP_PLANS.A;
      return store.runs.create({
        id: newId(),
        type: 'A',
        targetRuleIds: [h.rule.id],
        currentStep: 'approval',
        baseBranch: 'main',
        budgetSnapshot: {
          run: { maxBudgetUsd: 5, maxTurns: 200 },
          roles: {
            'test-writer': { maxBudgetUsd: 2, maxTurns: 100 },
            implementer: { maxBudgetUsd: 2, maxTurns: 100 },
          },
        },
        modelSnapshot: { 'test-writer': 'test-model', implementer: 'test-model' },
        startedBy: human,
        createdAt: new Date().toISOString(),
        steps: plan.map((kind, index) => ({
          id: newId(),
          kind,
          attempt: 1,
          status: index === 0 ? ('running' as const) : ('pending' as const),
          role:
            kind === 'test_writing'
              ? 'test-writer'
              : kind === 'implementation'
                ? 'implementer'
                : null,
          startedAt: index === 0 ? new Date().toISOString() : null,
        })),
      });
    });
    h.runId = forged.run.id;
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'run_without_log',
      branch: null,
    });
    expect(stepOf(done, 'test_writing')).toMatchObject({
      status: 'failed',
      exitDetail: { reason: 'run_without_log' },
    });
    expect(sessionsOf(h)).toEqual([]);
  });
});

describe('시작 근거 대조: 사람 run_start 1건 또는 자동 시작 항목 1건 (M7-05 #217 · M7-19 #244, NFR-01, ADR-107 · ADR-111)', () => {
  type Starter = { kind: 'human' } | { kind: 'orchestrator'; causeSeqs: number[] };
  /** 자동 시작이 가능한 설정 (하루 한도 채움) */
  const AUTO_START_SETTINGS: SettingsPatch = { ...COMPLETE_SETTINGS, dailyBudgetUsd: 10 };
  const at = () => new Date().toISOString();
  /** 시작 근거 없이 실행만 저장한다 (파이프 밖 경로의 흉내). 근거는 경우마다 따로 남긴다. */
  const forgeRun = (store: ProjectStore, ruleIds: string[], startedBy: Starter): string =>
    saveNewRun(store, store.settings.get(), { runId: newId(), ruleIds, startedBy }, at(), newId).run
      .id;
  const created = (store: ProjectStore, ruleId: string): number =>
    store.normChanges.append({
      at: at(),
      kind: 'created',
      actor: { kind: 'agent', role: 'rule-writer' },
      targetRef: { entity: 'Rule', id: ruleId },
      sessionId: newId(),
      runId: null,
      reason: '시험 근거',
      detail: { after: { ruleId } },
    }).seq;
  const autoStart = (
    store: ProjectStore,
    runId: string,
    causeSeqs: number[],
    ruleIds: string[],
  ): number =>
    store.normChanges.append({
      at: at(),
      kind: 'auto_start',
      actor: { kind: 'orchestrator' },
      targetRef: { entity: 'Run', id: runId },
      sessionId: null,
      runId,
      reason: null,
      detail: { causeSeqs, ruleIds },
    }).seq;
  /** 같은 요구사항 아래의 효력 있는 규칙 하나 더 (규칙 여러 개 실행의 흉내). */
  const anotherRule = (store: ProjectStore, rule: string): string => {
    const base = store.rules.get(rule);
    if (base === null) throw new Error('규칙 없음');
    return store.rules.create({
      id: newId(),
      title: '헬스 체크 응답 형식',
      statement: base.statement,
      kind: 'business',
      checkKinds: ['test'],
      parentRequirementId: base.parentRequirementId,
      builtin: false,
      targetBlockIds: [],
      risk: null,
      contractId: null,
      author: { kind: 'agent', role: 'rule-writer' },
      normState: 'approved',
      createdAt: at(),
    }).id;
  };
  const runStart = (store: ProjectStore, runId: string, ruleIds: string[]): void => {
    store.approvalLog.append({
      at: at(),
      action: 'run_start',
      actor: human,
      targetRef: { entity: 'Run', id: runId },
      clientId: null,
      detail: { ruleIds },
    });
  };

  interface BasisCase {
    name: string;
    build: (store: ProjectStore, rule: string) => string;
    mismatch: string;
    counts: [number, number];
  }
  const cases: BasisCase[] = [
    {
      name: '사람: 근거 0건',
      build: (store, rule) => forgeRun(store, [rule], human),
      mismatch: 'no_entry',
      counts: [0, 0],
    },
    {
      name: '사람: run_start 2건',
      build: (store, rule) => {
        const id = forgeRun(store, [rule], human);
        runStart(store, id, [rule]);
        runStart(store, id, [rule]);
        return id;
      },
      mismatch: 'multiple_entries',
      counts: [2, 0],
    },
    {
      name: '사람: run_start와 자동 시작 항목이 둘 다',
      build: (store, rule) => {
        const id = forgeRun(store, [rule], human);
        runStart(store, id, [rule]);
        autoStart(store, id, [created(store, rule)], [rule]);
        return id;
      },
      mismatch: 'both_entries',
      counts: [1, 1],
    },
    {
      name: '사람: run_start의 대상 규칙이 다름',
      build: (store, rule) => {
        const id = forgeRun(store, [rule], human);
        runStart(store, id, [newId()]);
        return id;
      },
      mismatch: 'rules_mismatch',
      counts: [1, 0],
    },
    {
      name: '사람 주체인데 근거가 자동 시작 항목뿐',
      build: (store, rule) => {
        const id = forgeRun(store, [rule], human);
        autoStart(store, id, [created(store, rule)], [rule]);
        return id;
      },
      mismatch: 'starter_mismatch',
      counts: [0, 1],
    },
    {
      name: '오케스트레이터 주체인데 근거가 사람 run_start뿐',
      build: (store, rule) => {
        const id = forgeRun(store, [rule], {
          kind: 'orchestrator',
          causeSeqs: [created(store, rule)],
        });
        runStart(store, id, [rule]);
        return id;
      },
      mismatch: 'starter_mismatch',
      counts: [1, 0],
    },
    {
      name: '오케스트레이터: 근거 0건',
      build: (store, rule) =>
        forgeRun(store, [rule], { kind: 'orchestrator', causeSeqs: [created(store, rule)] }),
      mismatch: 'no_entry',
      counts: [0, 0],
    },
    {
      name: '오케스트레이터: 다른 실행의 자동 시작 항목만 있음',
      build: (store, rule) => {
        const cause = created(store, rule);
        const id = forgeRun(store, [rule], { kind: 'orchestrator', causeSeqs: [cause] });
        autoStart(store, newId(), [cause], [rule]);
        return id;
      },
      mismatch: 'no_entry',
      counts: [0, 0],
    },
    {
      name: '오케스트레이터: 자동 시작 항목 2건',
      build: (store, rule) => {
        const cause = created(store, rule);
        const id = forgeRun(store, [rule], { kind: 'orchestrator', causeSeqs: [cause] });
        autoStart(store, id, [cause], [rule]);
        autoStart(store, id, [cause], [rule]);
        return id;
      },
      mismatch: 'multiple_entries',
      counts: [0, 2],
    },
    {
      // ADR-107 때의 모양: 세션이 만든 규칙 전부로 실행 1개. 규칙마다 실행 1개가 된 뒤로는 구동하지 않는다 (ADR-110 · ADR-111)
      name: '오케스트레이터: 대상 규칙 2개 · 원인 2건 (항목 · 시작 주체 · 신규 기록이 모두 맞음)',
      build: (store, rule) => {
        const other = anotherRule(store, rule);
        const causes = [created(store, rule), created(store, other)];
        const id = forgeRun(store, [rule, other], { kind: 'orchestrator', causeSeqs: causes });
        autoStart(store, id, causes, [rule, other]);
        return id;
      },
      mismatch: 'not_single_rule',
      counts: [0, 1],
    },
    {
      name: '오케스트레이터: 대상 규칙 1개인데 원인 2건',
      build: (store, rule) => {
        const causes = [created(store, rule), created(store, rule)];
        const id = forgeRun(store, [rule], { kind: 'orchestrator', causeSeqs: causes });
        // 항목은 원인과 규칙 수가 같아야 한다(스키마): 항목 쪽은 원인 1건
        autoStart(store, id, causes.slice(0, 1), [rule]);
        return id;
      },
      mismatch: 'not_single_rule',
      counts: [0, 1],
    },
    {
      name: '오케스트레이터: 대상 규칙 2개인데 원인 1건',
      build: (store, rule) => {
        const other = anotherRule(store, rule);
        const cause = created(store, rule);
        const id = forgeRun(store, [rule, other], { kind: 'orchestrator', causeSeqs: [cause] });
        // 항목은 원인과 규칙 수가 같아야 한다(스키마): 항목 쪽은 규칙 1개
        autoStart(store, id, [cause], [rule]);
        return id;
      },
      mismatch: 'not_single_rule',
      counts: [0, 1],
    },
    {
      name: '오케스트레이터: 항목의 원인 순번이 시작 주체와 다름',
      build: (store, rule) => {
        const id = forgeRun(store, [rule], {
          kind: 'orchestrator',
          causeSeqs: [created(store, rule)],
        });
        autoStart(store, id, [created(store, rule)], [rule]);
        return id;
      },
      mismatch: 'cause_mismatch',
      counts: [0, 1],
    },
    {
      name: '오케스트레이터: 원인 순번이 신규 기록이 아님 (다른 자동 시작 항목의 순번)',
      build: (store, rule) => {
        const other = autoStart(store, newId(), [created(store, rule)], [rule]);
        const id = forgeRun(store, [rule], { kind: 'orchestrator', causeSeqs: [other] });
        autoStart(store, id, [other], [rule]);
        return id;
      },
      mismatch: 'cause_mismatch',
      counts: [0, 1],
    },
    {
      name: '오케스트레이터: 원인 순번이 그 규칙의 모순 판단 기록 (신규 기록이 아님, M7-07)',
      build: (store, rule) => {
        const createdSeq = created(store, rule);
        const judgment = store.normChanges.append({
          at: at(),
          kind: 'judgment',
          actor: { kind: 'agent', role: 'rule-writer' },
          targetRef: { entity: 'Rule', id: rule },
          sessionId: newId(),
          runId: null,
          reason: '시험 판단',
          detail: {
            judgment: {
              subject: 'new_rule',
              verdict: 'no_contradiction',
              contradicts: [],
              createdSeq,
              input: {
                requirements: { total: 1, included: 1 },
                rules: { total: 0, included: 0 },
              },
            },
          },
        }).seq;
        const id = forgeRun(store, [rule], { kind: 'orchestrator', causeSeqs: [judgment] });
        autoStart(store, id, [judgment], [rule]);
        return id;
      },
      mismatch: 'cause_mismatch',
      counts: [0, 1],
    },
    {
      name: '오케스트레이터: 원인 순번이 없는 기록',
      build: (store, rule) => {
        const id = forgeRun(store, [rule], { kind: 'orchestrator', causeSeqs: [9999] });
        autoStart(store, id, [9999], [rule]);
        return id;
      },
      mismatch: 'cause_mismatch',
      counts: [0, 1],
    },
    {
      name: '오케스트레이터: 원인 순번이 다른 규칙의 신규 기록',
      build: (store, rule) => {
        const cause = created(store, newId());
        const id = forgeRun(store, [rule], { kind: 'orchestrator', causeSeqs: [cause] });
        autoStart(store, id, [cause], [rule]);
        return id;
      },
      mismatch: 'cause_mismatch',
      counts: [0, 1],
    },
    {
      name: '오케스트레이터: 항목의 대상 규칙이 다름',
      build: (store, rule) => {
        const cause = created(store, rule);
        const id = forgeRun(store, [rule], { kind: 'orchestrator', causeSeqs: [cause] });
        autoStart(store, id, [cause], [newId()]);
        return id;
      },
      mismatch: 'rules_mismatch',
      counts: [0, 1],
    },
    {
      name: '오케스트레이터: 같은 원인 순번을 다른 실행의 자동 시작 항목도 씀',
      build: (store, rule) => {
        const cause = created(store, rule);
        const id = forgeRun(store, [rule], { kind: 'orchestrator', causeSeqs: [cause] });
        autoStart(store, id, [cause], [rule]);
        autoStart(store, newId(), [cause], [rule]);
        return id;
      },
      mismatch: 'cause_reused',
      counts: [0, 1],
    },
  ];

  it('근거가 정확히 1건이 아니거나 실행과 맞지 않으면 run_without_log: 워크트리 · 세션 없이 실패로 끝난다', async () => {
    // 하루 한도를 채운다: 자동 시작 실행은 시작 때 하루 한도 문을 먼저 지난다(비어 있으면 그 사유로 끝남, ADR-111)
    const h = setup({ settings: AUTO_START_SETTINGS });
    const results: [string, unknown][] = [];
    for (const basisCase of cases) {
      h.runId = withProject(h.biveHome, h.project.id, (store) =>
        store.transaction(() => basisCase.build(store, h.rule.id)),
      );
      expect(h.engine.evaluateApproval(h.project.id, h.runId), basisCase.name).toBe(true);
      await h.engine.settled();
      const done = detailOf(h);
      expect(done.run, basisCase.name).toMatchObject({
        status: 'failed',
        failureReason: 'run_without_log',
        branch: null,
      });
      results.push([basisCase.name, stepOf(done, 'test_writing').exitDetail]);
      expect(sessionsOf(h), basisCase.name).toEqual([]);
    }
    expect(results).toEqual(
      cases.map((c) => [
        c.name,
        {
          reason: 'run_without_log',
          detail: {
            runStartEntries: c.counts[0],
            autoStartEntries: c.counts[1],
            mismatch: c.mismatch,
          },
        },
      ]),
    );
    expect(userGit(h.repo, 'branch', '--list', 'bive/run-*')).toBe('');
  }, 60_000);

  it('사람의 [실행]은 지금처럼 규칙 여러 개를 한 실행으로 받는다: 사람 주체 · run_start 1건(대상 규칙 2개)이면 대조를 지나 merged까지 간다', async () => {
    const h = setup();
    const ruleIds = withProject(h.biveHome, h.project.id, (store) => [
      h.rule.id,
      anotherRule(store, h.rule.id),
    ]);
    h.runId = withProject(h.biveHome, h.project.id, (store) =>
      createRun(store, { ruleIds, author: human }, { clientId: null }, { now: Date.now, newId }),
    ).run.id;
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'merged',
      failureReason: null,
      targetRuleIds: ruleIds,
      startedBy: { kind: 'human' },
    });
  }, 60_000);

  it('자동 시작 항목 1건(원인 = 대상 규칙의 신규 기록, 승인 기록 없음)이면 대조를 지나 merged까지 간다', async () => {
    const h = setup({ settings: AUTO_START_SETTINGS });
    h.runId = withProject(h.biveHome, h.project.id, (store) =>
      store.transaction(() => {
        const cause = created(store, h.rule.id);
        const id = forgeRun(store, [h.rule.id], { kind: 'orchestrator', causeSeqs: [cause] });
        autoStart(store, id, [cause], [h.rule.id]);
        return id;
      }),
    );
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'merged',
      failureReason: null,
      startedBy: { kind: 'orchestrator', causeSeqs: [1] },
    });
    // 승인 기록에는 생성 때의 사람 실행(setup의 EXE-001) 1건뿐이고 이 실행의 항목은 없다
    expect(
      withProject(h.biveHome, h.project.id, (store) =>
        store.approvalLog.list({ entity: 'Run', id: h.runId }),
      ),
    ).toEqual([]);
  }, 60_000);
});

describe('종료 조건 미충족 · 회귀 (수용 기준 2)', () => {
  it('테스트 작성 미충족은 다음 단계로 가지 않고 새 시도 · 새 세션으로 다시 한다', async () => {
    let calls = 0;
    const h = setup({
      executors: {
        test_writing: async (context) => {
          calls += 1;
          await context.runSession({
            workDir: context.git.worktreePath,
            systemPrompt: '시험',
            prompt: '시험',
            vars: { ruleId: 'RULE-001' },
          });
          return calls === 1 ? { status: 'unmet', exitDetail: { files: 0 } } : { status: 'passed' };
        },
      },
    });
    const done = await runToEnd(h);
    expect(attempts(done, 'test_writing')).toEqual([
      'test_writing#1:failed',
      'test_writing#2:passed',
    ]);
    expect(stepOf(done, 'test_writing')).toMatchObject({ exitDetail: { files: 0 }, commit: null });
    expect(attempts(done, 'red_check')).toEqual(['red_check#1:passed']);
    expect(h.saves.slice(0, 3)).toEqual([
      'running:test_writing',
      'running:test_writing',
      'running:test_writing',
    ]);
    expect(done.run).toMatchObject({ status: 'merged', regressionCount: 0 });
    expect(sessionsOf(h, 'test-writer')).toHaveLength(2);
  }, 60_000);

  it('Red 확인 미충족은 테스트 작성으로 회귀하고, 재시도 2회를 넘으면 failed (test_retry_limit)', async () => {
    const h = setup({ executors: { red_check: scripted(['unmet']) } });
    const before = mainTip(h);
    const done = await runToEnd(h);
    expect(attempts(done, 'test_writing')).toEqual([
      'test_writing#1:passed',
      'test_writing#2:passed',
      'test_writing#3:passed',
    ]);
    expect(attempts(done, 'red_check')).toEqual([
      'red_check#1:failed',
      'red_check#2:failed',
      'red_check#3:failed',
    ]);
    expect(attempts(done, 'implementation')).toEqual(['implementation#1:pending']);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'test_retry_limit',
      currentStep: 'red_check',
      regressionCount: 0,
    });
    expect(sessionsOf(h, 'test-writer')).toHaveLength(3);
    expect(sessionsOf(h, 'implementer')).toHaveLength(0);
    expect(mainTip(h)).toBe(before);
    expect(isLocked(h, String(done.run.worktreePath))).toBe(true);
  }, 60_000);

  it('검사 실패는 구현으로 회귀하고 회귀 2회를 넘으면 failed, 브랜치 보존 · 병합 없음 (fail-check)', async () => {
    const h = setup({ scenario: 'fail-check' });
    const before = mainTip(h);
    const done = await runToEnd(h);
    expect(attempts(done, 'implementation')).toEqual([
      'implementation#1:passed',
      'implementation#2:passed',
      'implementation#3:passed',
    ]);
    expect(attempts(done, 'check')).toEqual(['check#1:failed', 'check#2:failed', 'check#3:failed']);
    expect(attempts(done, 'mutation')).toEqual(['mutation#1:pending']);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'regression_limit',
      regressionCount: 2,
      currentStep: 'check',
      mergeCommit: null,
    });
    expect(stepOf(done, 'check', 3).exitDetail).toMatchObject({ reason: 'regression_limit' });
    // 회귀 수는 저장마다 1씩: 0 → 1 → 2, 그 뒤 실패
    expect(h.saves.filter((s) => s === 'running:implementation')).toHaveLength(3);
    expect(sessionsOf(h, 'implementer')).toHaveLength(3);
    expect(mainTip(h)).toBe(before);
    expect(userGit(h.repo, 'branch', '--list', 'bive/run-EXE-001')).toContain('bive/run-EXE-001');
    expect(isLocked(h, String(done.run.worktreePath))).toBe(true);
  }, 60_000);

  it('규칙이 없는 단계의 미충족 · 실행기 없음 · 예외는 failed (step_unmet · step_executor_missing · step_error)', async () => {
    const unmet = setup({ executors: { merge: scripted(['unmet']) } });
    expect((await runToEnd(unmet)).run).toMatchObject({
      status: 'failed',
      failureReason: 'step_unmet',
      currentStep: 'merge',
    });

    // 남은 단계의 실행기가 하나라도 없으면 워크트리 · 브랜치를 만들기 전에 첫 단계에서 끝난다
    const missing = setup({ executors: { red_check: undefined } });
    const missingDone = await runToEnd(missing);
    expect(missingDone.run).toMatchObject({
      status: 'failed',
      failureReason: 'step_executor_missing',
      currentStep: 'test_writing',
      branch: null,
      worktreePath: null,
    });
    expect(stepOf(missingDone, 'test_writing').exitDetail).toEqual({
      reason: 'step_executor_missing',
      detail: { missing: ['red_check'] },
    });
    expect(sessionsOf(missing)).toEqual([]);
    expect(userGit(missing.repo, 'branch', '--list', 'bive/run-*')).toBe('');

    const thrown = setup({ executors: { check: () => Promise.reject(new Error('검사 폭발')) } });
    const done = await runToEnd(thrown);
    expect(done.run).toMatchObject({ status: 'failed', failureReason: 'step_error' });
    expect(stepOf(done, 'check').exitDetail).toEqual({
      reason: 'step_error',
      detail: { message: '검사 폭발' },
    });
  }, 90_000);
});

describe('결과 저장 실패 (리뷰 반영)', () => {
  it('실행기가 형식이 틀린 실행 필드(커밋 해시 아님)를 내면 저장 전에 failed (step_error)', async () => {
    const h = setup({
      executors: {
        merge: () => Promise.resolve({ status: 'passed', run: { mergeCommit: 'not-a-sha' } }),
      },
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'step_error',
      currentStep: 'merge',
      mergeCommit: null,
    });
    expect(stepOf(done, 'merge').exitDetail).toEqual({
      reason: 'step_error',
      detail: { message: 'mergeCommit가 커밋 해시가 아닙니다: not-a-sha' },
    });
    expect(h.engine.activeRunIds).toEqual([]);
    expect(isLocked(h, String(done.run.worktreePath))).toBe(true);
  }, 60_000);

  it('결과 저장이 예외로 실패해도 running에 남지 않고 failed (step_error)', async () => {
    // JSON으로 저장할 수 없는 종료 조건 결과 → completeStep 저장에서 예외
    const h = setup({
      executors: { check: () => Promise.resolve({ status: 'passed', exitDetail: { n: 1n } }) },
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'step_error',
      currentStep: 'check',
    });
    expect(stepOf(done, 'check')).toMatchObject({
      status: 'failed',
      exitDetail: { reason: 'step_error', detail: { message: expect.any(String) } },
    });
    expect(h.engine.activeRunIds).toEqual([]);
    expect(isLocked(h, String(done.run.worktreePath))).toBe(true);
  }, 60_000);
});

describe('세션 실행 틀: 가드 · 예산 · 시작 실패', () => {
  it('세션 가드 위반(추가 MCP 서버)은 실행 failed (guard_violation), 도구 목록은 기록된다', async () => {
    const h = setup({
      wrap: (inner) => ({
        kind: inner.kind,
        startSession: (spec) =>
          (async function* (): AsyncGenerator<SessionEvent> {
            for await (const event of inner.startSession(spec)) {
              yield event.type === 'init'
                ? { ...event, mcpServers: [...event.mcpServers, 'evil'] }
                : event;
            }
          })(),
      }),
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'guard_violation',
      currentStep: 'test_writing',
    });
    expect(done.run.toolManifest).toEqual([
      { role: 'test-writer', tools: expect.any(Array), mcpServerCount: 2 },
    ]);
    expect(sessionsOf(h).map((s) => s.endReason)).toEqual(['guard_violation']);
    expect(
      withProject(h.biveHome, h.project.id, (store) => store.sessions.toolCalls(h.runId)),
    ).toEqual([]);
  }, 60_000);

  it('CLI 시작 실패(init 없이 결과)는 가드 위반이 아니라 오류 결과 → 미충족 재시도', async () => {
    const h = setup({
      wrap: (inner) => ({
        kind: inner.kind,
        startSession: () =>
          (async function* (): AsyncGenerator<SessionEvent> {
            yield {
              type: 'result',
              subtype: 'error_during_execution',
              total_cost_usd: 0,
              num_turns: 0,
              modelUsage: {},
            };
          })(),
      }),
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'failed', failureReason: 'test_retry_limit' });
    expect(sessionsOf(h).map((s) => s.endReason)).toEqual([
      'error_during_execution',
      'error_during_execution',
      'error_during_execution',
    ]);
  }, 60_000);

  it('남은 예산이 0이면 세션을 열지 않고 budget_exceeded (budget_exhausted)', async () => {
    const h = setup({
      settings: { ...COMPLETE_SETTINGS, run: { maxBudgetUsd: 0.0421, maxTurns: 200 } },
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'budget_exceeded',
      failureReason: 'budget_exhausted',
      currentStep: 'implementation',
      mergeCommit: null,
    });
    expect(sessionsOf(h, 'implementer')).toEqual([]);
    expect(isLocked(h, String(done.run.worktreePath))).toBe(true);
  }, 60_000);

  it('세션 결과가 예산 한도 subtype이면 budget_exceeded, 세션 한도는 min(역할 잔여, 실행 잔여)', async () => {
    const h = setup({
      settings: { ...COMPLETE_SETTINGS, run: { maxBudgetUsd: 0.05, maxTurns: 200 } },
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'budget_exceeded',
      failureReason: 'error_max_budget_usd',
    });
    expect(sessionsOf(h).map((s) => [s.role, s.endReason])).toEqual([
      ['test-writer', 'success'],
      ['implementer', 'error_max_budget_usd'],
    ]);
  }, 60_000);
});

describe('중단 · 재개 (수용 기준 3 · 4, 엔진 인스턴스 교체)', () => {
  it('재기동 복구는 running만 interrupted로 바꾸고 자동 재개하지 않으며, run.resume은 hard reset + clean 뒤 새 세션으로 이어간다', async () => {
    const h = setup({ scenario: 'regress-pause', scenariosDir: TEST_SCENARIOS_DIR });
    const pause = path.join(h.biveHome, 'run', 'pause');
    expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
    await waitFor(
      () =>
        fs.existsSync(pause) &&
        detailOf(h).steps.some(
          (s) => s.kind === 'implementation' && s.attempt === 2 && s.status === 'running',
        ),
      30_000,
      '두 번째 구현 세션 대기',
    );
    const paused = detailOf(h);
    expect(paused.run.regressionCount).toBe(1);
    const lastCompleted = String(paused.run.headCommit);
    expect(lastCompleted).toBe(stepOf(paused, 'implementation').commit);

    // 진행 중 워크트리를 더럽힌다: 추적 파일 변경 · 미추적 파일 · 무시된 파일
    const worktree = String(paused.run.worktreePath);
    fs.appendFileSync(path.join(worktree, 'src/app/page.tsx'), '\n// 커밋되지 않은 변경\n');
    fs.writeFileSync(path.join(worktree, 'junk.txt'), '남은 파일\n');
    fs.mkdirSync(path.join(worktree, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'node_modules', 'keep.txt'), '무시된 파일\n');

    // 엔진을 상태 저장 없이 멈춘다 (비정상 종료와 같은 저장 상태: running)
    await h.engine.stop();
    expect(detailOf(h).run.status).toBe('running');
    // 정상 종료 중 시작된 판정 · 재개는 받지 않는다
    expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(false);

    const engine = h.newEngine();
    expect(engine.recoverInterruptedRuns()).toEqual([
      { projectId: h.project.id, runId: h.runId, displayId: 'EXE-001' },
    ]);
    const interrupted = detailOf(h);
    expect(interrupted.run).toMatchObject({
      status: 'interrupted',
      currentStep: 'implementation',
      lastCompletedStep: 'implementation',
      regressionCount: 1,
    });
    expect(attempts(interrupted, 'implementation')).toEqual([
      'implementation#1:passed',
      'implementation#2:failed',
      'implementation#3:pending',
    ]);
    expect(stepOf(interrupted, 'implementation', 2).exitDetail).toEqual(INTERRUPTED_EXIT_DETAIL);
    expect(sessionsOf(h, 'implementer').map((s) => s.endReason)).toEqual(['success', 'aborted']);
    // 두 번 불러도 바꿀 것이 없다
    expect(engine.recoverInterruptedRuns()).toEqual([]);

    // 자동 재개 없음
    await engine.settled();
    await sleep(300);
    expect(detailOf(h)).toEqual(interrupted);
    expect(sessionsOf(h, 'implementer')).toHaveLength(2);

    // 재개 거부: 에이전트 주체 · 없는 실행 · 등록 안 된 프로젝트
    await expect(
      engine.resume(h.project.id, h.runId, { kind: 'agent', role: 'implementer' }),
    ).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
    await expect(engine.resume(h.project.id, 'EXE-009', human)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
    await expect(engine.resume(newId(), h.runId, human)).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });

    const resumed = await engine.resume(h.project.id, 'EXE-001', human);
    expect(resumed.run).toMatchObject({
      status: 'running',
      currentStep: 'implementation',
      regressionCount: 1,
    });
    expect(stepOf(resumed, 'implementation', 3).status).toBe('running');
    // 재개 직후 무시된 파일은 남고 미추적 파일은 지워졌다
    expect(fs.existsSync(path.join(worktree, 'node_modules', 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(worktree, 'junk.txt'))).toBe(false);

    await engine.settled();
    const done = detailOf(h);
    expect(done.run).toMatchObject({ status: 'merged', regressionCount: 1 });
    expect(attempts(done, 'implementation')).toEqual([
      'implementation#1:passed',
      'implementation#2:failed',
      'implementation#3:passed',
    ]);
    expect(attempts(done, 'check')).toEqual(['check#1:failed', 'check#2:passed']);
    // 새 구현 커밋은 마지막 완료 단계 커밋 위에 있고, 되돌린 변경 · 지운 파일이 들어가지 않았다
    const resumedCommit = String(stepOf(done, 'implementation', 3).commit);
    expect(userGit(h.repo, 'rev-parse', `${resumedCommit}^`)).toBe(lastCompleted);
    expect(userGit(h.repo, 'diff', '--name-only', lastCompleted, resumedCommit)).toBe(ROUTE);
    // 재개 뒤 세션은 새 세션(순번 2)이라 대기하지 않았다
    expect(sessionsOf(h, 'implementer').map((s) => s.endReason)).toEqual([
      'success',
      'aborted',
      'success',
    ]);

    // interrupted가 아닌 실행은 재개할 수 없다
    await expect(engine.resume(h.project.id, h.runId, human)).rejects.toMatchObject({
      code: ErrorCode.StateConflict,
    });
    fs.rmSync(pause, { force: true });
  }, 90_000);
});

describe('재개 · 재기동의 예외 경로 (리뷰 반영)', () => {
  /** 테스트 작성 실행기가 중단될 때까지 멈춰 있는 실행을 만들고, 엔진을 멈춘 뒤 새 엔진으로 interrupted 표시. */
  const interruptedHarness = async (): Promise<{ h: Harness; engine: PipelineEngine }> => {
    const h = setup({
      executors: {
        test_writing: (context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(context.signal.reason as Error), {
              once: true,
            });
          }),
      },
    });
    expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
    await waitFor(() => detailOf(h).run.worktreePath !== null, 20_000, '워크트리 생성');
    await h.engine.stop();
    const engine = h.newEngine();
    expect(engine.recoverInterruptedRuns()).toHaveLength(1);
    return { h, engine };
  };

  it('워크트리를 되돌리지 못하면(일시적일 수 있는 명령 실패) -32009, 실행은 interrupted 그대로, 예약은 풀린다', async () => {
    const { h, engine } = await interruptedHarness();
    const before = detailOf(h);
    // 명령 실패(워크트리의 .git 연결이 깨짐). 워크트리가 아예 없는 것 같은 복구 불가 사유는 그 재개 안에서 실행을
    // 실패로 끝낸다 (ADR-105, run-queue.test.ts)
    fs.writeFileSync(path.join(String(before.run.worktreePath), '.git'), 'gitdir: /nonexistent\n');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error: unknown = await engine
        .resume(h.project.id, h.runId, human)
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: ErrorCode.StateConflict });
      // 두 번째도 "이미 진행 중"이 아니라 되돌리기 실패다 (예약이 풀렸다)
      expect((error as Error).message).toContain('되돌리지 못했습니다');
      expect(engine.activeRunIds).toEqual([]);
      expect(detailOf(h)).toEqual(before);
    }
  }, 60_000);

  it('재기동 복구는 끝나지 않은 규칙 작성 세션(실행 밖)도 aborted로 닫는다', () => {
    const h = setup();
    const sessionId = newId();
    withProject(h.biveHome, h.project.id, (store) => {
      store.sessions.start({
        id: sessionId,
        runId: null,
        stepId: null,
        requirementId: h.rule.parentRequirementId,
        role: 'rule-writer',
        model: 'test-model',
        workDir: '/tmp/w',
        startedAt: new Date().toISOString(),
      });
    });
    expect(h.engine.recoverInterruptedRuns()).toEqual([]);
    const closed = withProject(h.biveHome, h.project.id, (store) => store.sessions.get(sessionId));
    expect(closed).toMatchObject({ endReason: 'aborted', error: '오케스트레이터가 비정상 종료됨' });
  });

  it('재기동 복구는 세션을 열기 전 대기열에 남은 규칙 작성 시도를 생략(closed)으로 끝내고 다시 띄우지 않는다 (M3-26, ADR-099)', () => {
    const h = setup();
    const requirementId = h.rule.parentRequirementId ?? '';
    const pending = newId();
    withProject(h.biveHome, h.project.id, (store) => {
      store.ruleWriterRequests.create({
        id: pending,
        requirementId,
        requestedAt: new Date().toISOString(),
      });
    });
    expect(h.engine.recoverInterruptedRuns()).toEqual([]);
    const attempt = withProject(h.biveHome, h.project.id, (store) =>
      store.ruleWriterRequests.latest(requirementId),
    );
    expect(attempt).toMatchObject({
      id: pending,
      state: 'skipped',
      skipReason: 'closed',
      error: '오케스트레이터가 비정상 종료됨',
    });
    expect(
      withProject(h.biveHome, h.project.id, (store) => store.sessions.get(pending)),
    ).toBeNull();
  });
});

describe('비정상 종료(SIGKILL) 뒤 재기동 · run.resume (수용 기준 3 · 4, 실제 프로세스)', () => {
  interface Running {
    proc: Spawned;
    client: TestClient;
  }

  const start = async (biveHome: string): Promise<Running> => {
    const proc = spawnScript('test/helpers/engine-orchestrator.ts', {
      BIVE_HOME: biveHome,
      BIVE_IDLE_SHUTDOWN_MS: '60000',
      BIVE_SCENARIO: 'regress-pause',
    });
    await waitFor(() => proc.stdout.includes('오케스트레이터 기동'), 30_000, '오케스트레이터 기동');
    const paths = runPaths(biveHome);
    const client = await connect(paths.pipe, readFileSync(paths.token, 'utf8'));
    return { proc, client };
  };

  const kill = async ({ proc, client }: Running): Promise<void> => {
    client.destroy();
    proc.child.kill('SIGKILL');
    await proc.exited;
  };

  it('running 실행이 interrupted가 되고 자동 재개하지 않으며, run.resume으로 이어가 merged (regressionCount 유지)', async () => {
    const biveHome = makeBiveHome();
    const repo = copyFixture(temps);
    const { project, rule } = seedProject(biveHome, repo);
    const pause = path.join(biveHome, 'run', 'pause');
    const read = (): RunDetail =>
      withProject(biveHome, project.id, (store) => {
        const detail = store.runs.getDetailByDisplayId('EXE-001');
        if (detail === null) throw new Error('실행 없음');
        return detail;
      });

    let current = await start(biveHome);
    expect(current.proc.stdout).toContain('중단으로 표시 0');
    await current.client.call('run.create', {
      projectId: project.id,
      ruleIds: [rule.id],
      author: human,
    });
    await waitFor(
      () =>
        fs.existsSync(pause) &&
        read().steps.some(
          (s) => s.kind === 'implementation' && s.attempt === 2 && s.status === 'running',
        ),
      60_000,
      '두 번째 구현 세션 대기',
    );
    const paused = read();
    expect(paused.run).toMatchObject({ status: 'running', regressionCount: 1 });
    const worktree = String(paused.run.worktreePath);
    fs.appendFileSync(path.join(worktree, 'src/app/page.tsx'), '\n// 커밋되지 않은 변경\n');
    fs.writeFileSync(path.join(worktree, 'junk.txt'), '남은 파일\n');
    await kill(current);
    // 죽은 뒤에도 저장 상태는 running (단계 중간은 저장하지 않음)
    expect(read().run.status).toBe('running');

    current = await start(biveHome);
    expect(current.proc.stdout).toContain('중단으로 표시 1');
    const interrupted = await current.client.call('run.get', {
      projectId: project.id,
      id: 'EXE-001',
    });
    expect(interrupted.run).toMatchObject({
      status: 'interrupted',
      currentStep: 'implementation',
      regressionCount: 1,
    });
    expect(attempts(interrupted, 'implementation')).toEqual([
      'implementation#1:passed',
      'implementation#2:failed',
      'implementation#3:pending',
    ]);
    // 자동 재개 없음: 시간이 지나도 그대로이고 새 세션이 없다
    await sleep(1_000);
    expect(await current.client.call('run.get', { projectId: project.id, id: 'EXE-001' })).toEqual(
      interrupted,
    );
    expect(
      withProject(biveHome, project.id, (store) =>
        store.sessions.countByRunRole(interrupted.run.id, 'implementer'),
      ),
    ).toBe(2);
    expect((await current.client.call('system.status')).runsInProgress).toBe(0);

    const refused = await current.client
      .call('run.resume', {
        projectId: project.id,
        id: 'EXE-001',
        author: { kind: 'agent', role: 'implementer' },
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RpcCallError);
    expect((refused as RpcCallError).code).toBe(ErrorCode.Unauthorized);

    const resumed = await current.client.call('run.resume', {
      projectId: project.id,
      id: 'EXE-001',
      author: human,
    });
    expect(resumed.run).toMatchObject({ status: 'running', regressionCount: 1 });
    expect(stepOf(resumed, 'implementation', 3).status).toBe('running');
    expect(fs.existsSync(path.join(worktree, 'junk.txt'))).toBe(false);

    await waitFor(() => read().run.status === 'merged', 60_000, '재개한 실행 병합');
    const done = await current.client.call('run.get', { projectId: project.id, id: 'EXE-001' });
    expect(done.run).toMatchObject({ status: 'merged', regressionCount: 1 });
    const resumedCommit = String(stepOf(done, 'implementation', 3).commit);
    expect(userGit(repo, 'rev-parse', `${resumedCommit}^`)).toBe(paused.run.headCommit);
    expect(userGit(repo, 'diff', '--name-only', String(paused.run.headCommit), resumedCommit)).toBe(
      ROUTE,
    );
    expect(userGit(repo, 'rev-parse', 'refs/heads/main')).toBe(done.run.mergeCommit);

    const again = await current.client
      .call('run.resume', { projectId: project.id, id: 'EXE-001', author: human })
      .catch((error: unknown) => error);
    expect((again as RpcCallError).code).toBe(ErrorCode.StateConflict);
    await kill(current);
  }, 180_000);
});

describe('상태 기계', () => {
  it('RUN_STATUS_TRANSITIONS의 모든 전이를 이 시험 안에서 거친다 (다른 시험에 기대지 않음)', async () => {
    const seen = new Set<string>();
    const last = new Map<string, RunStatus>();
    const track = (detail: RunDetail): void => {
      const previous = last.get(detail.run.id) ?? 'waiting_approval';
      if (previous !== detail.run.status) seen.add(`${previous}→${detail.run.status}`);
      last.set(detail.run.id, detail.run.status);
    };
    // 세션 · 판정 없이 결과만 내는 실행기 (병합 커밋은 기준 커밋을 그대로 쓴다)
    const stub = (overrides: StepExecutors): StepExecutors => ({
      test_writing: scripted(['passed']),
      red_check: scripted(['passed']),
      implementation: scripted(['passed']),
      check: scripted(['passed']),
      merge: (context) =>
        Promise.resolve({ status: 'passed', run: { mergeCommit: context.git.baseCommit } }),
      ...overrides,
    });
    const engineFor = (h: Harness, executors: StepExecutors): PipelineEngine => {
      const engine = new PipelineEngine({
        biveHome: h.biveHome,
        agent: h.adapter,
        executors,
        onEvent: (event) => {
          if (event.type === 'run.saved') track(event.detail);
        },
      });
      engines.push(engine);
      return engine;
    };
    const drive = async (h: Harness, engine: PipelineEngine): Promise<RunDetail> => {
      expect(engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
      await engine.settled();
      return detailOf(h);
    };

    // waiting_approval → running → merged
    const merged = setup();
    expect((await drive(merged, engineFor(merged, stub({})))).run.status).toBe('merged');
    // waiting_approval → failed (승인 단계에서 효력 없는 대상 규칙, ADR-107)
    const unavailable = setup({ normState: 'provisional' });
    expect(
      engineFor(unavailable, stub({})).evaluateApproval(unavailable.project.id, unavailable.runId),
    ).toBe(false);
    expect(detailOf(unavailable).run.status).toBe('failed');
    // running → failed
    const failed = setup();
    const failedExecutors = stub({ check: scripted(['halt']) });
    expect((await drive(failed, engineFor(failed, failedExecutors))).run.status).toBe('failed');
    // running → budget_exceeded
    const budget = setup();
    const budgetExecutors = stub({
      test_writing: () =>
        Promise.resolve({
          status: 'halt',
          runStatus: 'budget_exceeded',
          reason: 'budget_exhausted',
        }),
    });
    expect((await drive(budget, engineFor(budget, budgetExecutors))).run.status).toBe(
      'budget_exceeded',
    );
    // running → interrupted (재기동 복구) → running (재개) → merged
    const paused = setup();
    let release = false;
    const pausedExecutors = stub({
      test_writing: (context) =>
        release
          ? Promise.resolve({ status: 'passed' })
          : new Promise((_resolve, reject) => {
              context.signal.addEventListener(
                'abort',
                () => reject(context.signal.reason as Error),
                {
                  once: true,
                },
              );
            }),
    });
    const first = engineFor(paused, pausedExecutors);
    expect(first.evaluateApproval(paused.project.id, paused.runId)).toBe(true);
    await waitFor(() => detailOf(paused).run.worktreePath !== null, 20_000, '워크트리 생성');
    // waiting_approval → queued: 진행 중인 실행이 있는 프로젝트의 새 실행 2개 (ADR-105). 둘째의 대상 규칙은 대기 중 삭제
    const doomedRule = withProject(paused.biveHome, paused.project.id, (store) =>
      store.rules.create({
        id: newId(),
        title: '삭제될 규칙',
        statement: paused.rule.statement,
        kind: 'business',
        checkKinds: ['test'],
        parentRequirementId: paused.rule.parentRequirementId,
        builtin: false,
        targetBlockIds: [],
        risk: null,
        contractId: null,
        author: { kind: 'agent', role: 'rule-writer' },
        normState: 'approved',
        createdAt: new Date().toISOString(),
      }),
    );
    const queuedIds = [paused.rule.id, doomedRule.id].map((ruleId) => {
      const runId = withProject(paused.biveHome, paused.project.id, (store) =>
        createRun(
          store,
          { ruleIds: [ruleId], author: human },
          { clientId: null },
          { now: Date.now, newId },
        ),
      ).run.id;
      expect(first.evaluateApproval(paused.project.id, runId)).toBe(true);
      return runId;
    });
    withProject(paused.biveHome, paused.project.id, (store) =>
      store.db
        .prepare('UPDATE rules SET deleted_at = ? WHERE id = ?')
        .run(new Date().toISOString(), doomedRule.id),
    );
    await first.stop();
    const second = engineFor(paused, pausedExecutors);
    expect(second.recoverInterruptedRuns()).toHaveLength(1);
    release = true;
    await second.resume(paused.project.id, paused.runId, human);
    // 재개한 실행이 끝나면 queued → running(첫째) → merged, 그다음 queued → failed(둘째, 대상 규칙 재검사)
    await second.settled();
    expect(detailOf(paused).run.status).toBe('merged');
    expect(
      queuedIds.map((id) =>
        withProject(paused.biveHome, paused.project.id, (store) => store.runs.get(id)?.status),
      ),
    ).toEqual(['merged', 'failed']);

    // interrupted → failed: 워크트리가 사라진 중단 실행의 재개는 그 자리에서 실패로 끝난다 (ADR-105)
    const broken = setup();
    const brokenFirst = engineFor(broken, pausedExecutors);
    release = false;
    expect(brokenFirst.evaluateApproval(broken.project.id, broken.runId)).toBe(true);
    await waitFor(() => detailOf(broken).run.worktreePath !== null, 20_000, '워크트리 생성');
    await brokenFirst.stop();
    const brokenSecond = engineFor(broken, pausedExecutors);
    expect(brokenSecond.recoverInterruptedRuns()).toHaveLength(1);
    fs.rmSync(String(detailOf(broken).run.worktreePath), { recursive: true, force: true });
    await expect(brokenSecond.resume(broken.project.id, broken.runId, human)).rejects.toThrow(
      /재개할 수 없어/,
    );
    expect(detailOf(broken).run.status).toBe('failed');

    // interrupted → merged: 병합 커밋이 기록된 중단 실행(화면 갱신 도중)을 재개할 수 없으면 병합 완료로 끝난다 (runEnding)
    const mergedBroken = setup();
    const holdScreen = stub({
      screen_update: (context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason as Error), {
            once: true,
          });
        }),
    });
    const mergedFirst = engineFor(mergedBroken, holdScreen);
    expect(mergedFirst.evaluateApproval(mergedBroken.project.id, mergedBroken.runId)).toBe(true);
    await waitFor(
      () => detailOf(mergedBroken).run.currentStep === 'screen_update',
      20_000,
      '화면 갱신 단계',
    );
    await mergedFirst.stop();
    const mergedSecond = engineFor(mergedBroken, holdScreen);
    expect(mergedSecond.recoverInterruptedRuns()).toHaveLength(1);
    fs.rmSync(String(detailOf(mergedBroken).run.worktreePath), { recursive: true, force: true });
    await expect(
      mergedSecond.resume(mergedBroken.project.id, mergedBroken.runId, human),
    ).rejects.toThrow(/병합 완료로 끝냈습니다/);
    expect(detailOf(mergedBroken).run.status).toBe('merged');

    // queued → budget_exceeded: 실행 대기에 선 자동 시작 실행이 시작할 차례에 오늘 지출이 하루 한도에 이르렀다 (ADR-111).
    // 하루 한도 0 = 오늘 남은 USD 0. 앞 실행(사람)은 세션 없는 대역이라 한도와 무관하게 끝난다
    const daily = setup({ settings: { ...COMPLETE_SETTINGS, dailyBudgetUsd: 0 } });
    let releaseDaily = false;
    const dailyExecutors = stub({
      test_writing: (context) =>
        waitFor(() => releaseDaily, 20_000, '앞 실행 대기').then(() => {
          if (context.signal.aborted) throw context.signal.reason as Error;
          return { status: 'passed' as const };
        }),
    });
    const dailyEngine = engineFor(daily, dailyExecutors);
    expect(dailyEngine.evaluateApproval(daily.project.id, daily.runId)).toBe(true);
    const autoRunId = withProject(daily.biveHome, daily.project.id, (store) =>
      store.transaction(() => {
        const cause = store.normChanges.append({
          at: new Date().toISOString(),
          kind: 'created',
          actor: { kind: 'agent', role: 'rule-writer' },
          targetRef: { entity: 'Rule', id: daily.rule.id },
          sessionId: newId(),
          runId: null,
          reason: '시험 근거',
          detail: { after: { ruleId: daily.rule.id } },
        }).seq;
        const id = saveNewRun(
          store,
          store.settings.get(),
          {
            runId: newId(),
            ruleIds: [daily.rule.id],
            startedBy: { kind: 'orchestrator', causeSeqs: [cause] },
          },
          new Date().toISOString(),
          newId,
        ).run.id;
        store.normChanges.append({
          at: new Date().toISOString(),
          kind: 'auto_start',
          actor: { kind: 'orchestrator' },
          targetRef: { entity: 'Run', id },
          sessionId: null,
          runId: id,
          reason: null,
          detail: { causeSeqs: [cause], ruleIds: [daily.rule.id] },
        });
        return id;
      }),
    );
    expect(dailyEngine.evaluateApproval(daily.project.id, autoRunId)).toBe(true);
    const autoRun = () =>
      withProject(daily.biveHome, daily.project.id, (store) => store.runs.get(autoRunId));
    expect(autoRun()?.status).toBe('queued');
    releaseDaily = true;
    await dailyEngine.settled();
    expect(detailOf(daily).run.status).toBe('merged');
    expect(autoRun()).toMatchObject({
      status: 'budget_exceeded',
      failureReason: 'project_daily_budget_exceeded',
      worktreePath: null,
    });

    const all = Object.entries(RUN_STATUS_TRANSITIONS).flatMap(([from, tos]) =>
      (tos as readonly string[]).map((to) => `${from}→${to}`),
    );
    expect([...seen].sort()).toEqual([...all].sort());
  }, 120_000);
});

describe('화면 갱신 단계 (M1-19 수용 기준 4, RUN-02 8단계, ADR-076)', () => {
  /** 검사 대역: 판정 기록 1건을 저장하고 통과 (판정 결과 저장은 검사 · 병합 재검사가 한다, ADR-069). */
  const judgingCheck: StepExecutor = (context) => {
    context.read((store) =>
      store.judgments.record([
        {
          id: newId(),
          ruleId: context.run.targetRuleIds[0] ?? '',
          runId: context.run.id,
          stepId: context.step.id,
          commit: context.git.baseCommit,
          judgedAt: new Date().toISOString(),
          status: 'pass',
          runner: 'vitest',
          exitCode: 0,
          reporterPath: null,
          cases: [],
          quarantineReason: null,
        },
      ]),
    );
    return Promise.resolve({ status: 'passed' });
  };

  interface NotifyProbe {
    /** notify가 불린 순간의 저장 상태 */
    seen: { judgments: number; screenUpdate: string; run: string }[];
    release: (error?: Error) => void;
  }

  const probedEngine = (h: Harness): { engine: PipelineEngine; probe: NotifyProbe } => {
    const probe: NotifyProbe = { seen: [], release: () => undefined };
    const engine = new PipelineEngine({
      biveHome: h.biveHome,
      agent: h.adapter,
      executors: { ...h.executors, check: judgingCheck },
      onEvent: (event) => {
        if (event.type === 'run.saved') {
          h.saves.push(`${event.detail.run.status}:${String(event.detail.run.currentStep)}`);
          return undefined;
        }
        if (event.topic !== 'screen_update') return undefined;
        const detail = detailOf(h);
        probe.seen.push({
          judgments: withProject(h.biveHome, h.project.id, (store) =>
            store.judgments.listByRun(h.runId),
          ).length,
          screenUpdate: stepOf(detail, 'screen_update').status,
          run: `${detail.run.status}:${String(detail.run.currentStep)}`,
        });
        // 알림 송신이 언제 끝나는지는 시험이 정한다
        return new Promise<void>((resolve, reject) => {
          probe.release = (error) => {
            if (error === undefined) resolve();
            else reject(error);
          };
        });
      },
    });
    engines.push(engine);
    return { engine, probe };
  };

  it('판정 결과 저장 뒤 event.run.updated를 보내고, 송신이 끝나야 완료(passed) · merged로 저장한다', async () => {
    const h = setup();
    const { engine, probe } = probedEngine(h);
    h.engine = engine;
    expect(engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
    await waitFor(() => probe.seen.length === 1, 30_000, '화면 갱신 알림');

    // 알림을 보내는 순간: 판정 결과는 이미 저장됐고 화면 갱신 단계는 아직 진행 중이다
    expect(probe.seen).toEqual([
      { judgments: 1, screenUpdate: 'running', run: 'running:screen_update' },
    ]);
    // 송신이 끝나지 않으면 완료로 저장하지 않는다
    await sleep(300);
    expect(stepOf(detailOf(h), 'screen_update').status).toBe('running');
    expect(detailOf(h).run.status).toBe('running');
    expect(h.saves.at(-1)).toBe('running:screen_update');

    probe.release();
    await engine.settled();
    const done = detailOf(h);
    expect(stepOf(done, 'screen_update')).toMatchObject({
      status: 'passed',
      exitDetail: { notified: true, judgments: 1 },
    });
    expect(done.run).toMatchObject({
      status: 'merged',
      currentStep: null,
      lastCompletedStep: 'screen_update',
    });
    expect(h.saves.slice(-2)).toEqual(['running:screen_update', 'merged:null']);
  }, 60_000);

  it('송신이 실패하면 화면 갱신 단계를 완료로 저장하지 않고(failed, step_error) 실행은 병합 완료 merged (ADR-091)', async () => {
    const h = setup();
    const { engine, probe } = probedEngine(h);
    h.engine = engine;
    expect(engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
    await waitFor(() => probe.seen.length === 1, 30_000, '화면 갱신 알림');
    probe.release(new Error('송신 실패'));
    await engine.settled();
    const done = detailOf(h);
    expect(stepOf(done, 'screen_update')).toMatchObject({
      status: 'failed',
      exitDetail: { reason: 'step_error', detail: { message: '송신 실패' } },
    });
    // 기준 브랜치에는 이미 병합 커밋이 있으므로 실행은 병합 완료다. 실패는 화면 갱신 단계 시도에만 남는다 (ADR-091)
    expect(done.run).toMatchObject({
      status: 'merged',
      failureReason: null,
      currentStep: null,
      mergeCommit: mainTip(h),
    });
    expect(done.run.lastCompletedStep).toBe('merge');
    // 병합된 실행은 실패 종료의 보존(워크트리 잠금)을 하지 않는다 (ADR-091, M2-11 #190 PR #188 검토)
    expect(isLocked(h, String(done.run.worktreePath))).toBe(false);
  }, 60_000);

  it('송신을 기다리는 중 엔진을 멈추면 바로 끝나고(저장 없음), 재기동 뒤 재개하면 병합을 다시 하지 않고 화면 갱신만 다시 해 merged (검토 1회차)', async () => {
    const h = setup();
    const { engine, probe } = probedEngine(h);
    h.engine = engine;
    expect(engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
    await waitFor(() => probe.seen.length === 1, 30_000, '화면 갱신 알림');
    const merged = detailOf(h);
    const mergeCommit = merged.run.mergeCommit;
    expect(mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(mainTip(h)).toBe(mergeCommit);

    // 송신이 끝나지 않아도 stop()은 중단 신호로 풀린다. 중단은 저장하지 않는다 (ADR-066)
    const outcome = await Promise.race([
      engine.stop().then(() => 'stopped'),
      sleep(5_000).then(() => 'timeout'),
    ]);
    expect(outcome).toBe('stopped');
    expect(detailOf(h).run).toMatchObject({ status: 'running', currentStep: 'screen_update' });

    // 재기동: running → interrupted (진행 중 시도 failed + 같은 단계 새 시도 pending)
    const notified: string[] = [];
    const second = new PipelineEngine({
      biveHome: h.biveHome,
      agent: h.adapter,
      executors: { ...h.executors, check: judgingCheck },
      onEvent: (event) => {
        if (event.type === 'notify') notified.push(event.topic);
      },
    });
    engines.push(second);
    expect(second.recoverInterruptedRuns()).toHaveLength(1);
    expect(attempts(detailOf(h), 'screen_update')).toEqual([
      'screen_update#1:failed',
      'screen_update#2:pending',
    ]);
    expect(detailOf(h).run.status).toBe('interrupted');

    await second.resume(h.project.id, h.runId, human);
    await second.settled();
    const done = detailOf(h);
    expect(done.run).toMatchObject({ status: 'merged', currentStep: null, mergeCommit });
    // 병합은 1번뿐이고 기준 브랜치도 그대로, 화면 갱신만 새 시도로 다시 했다
    expect(attempts(done, 'merge')).toEqual(['merge#1:passed']);
    expect(attempts(done, 'screen_update')).toEqual([
      'screen_update#1:failed',
      'screen_update#2:passed',
    ]);
    expect(mainTip(h)).toBe(mergeCommit);
    expect(notified).toEqual(['screen_update']);
  }, 60_000);
});

describe('실행의 종료 상태는 한 곳(runEnding)에서 정한다: #halt를 거치지 않는 두 경로 (M2-11 #190, ADR-091 · ADR-094)', () => {
  /** 자기 단계 시도를 저장소에서 먼저 끝낸 뒤 예외: 엔진의 #halt 저장이 끝난 시도에 걸려 #failAfterError의 "시도가 이미 끝남" 경로로 간다. */
  const closeAttemptThenThrow: StepExecutor = (context) => {
    const at = new Date().toISOString();
    context.read((store) =>
      store.runs.transition(context.run.id, {
        expectedStatus: 'running',
        steps: [
          {
            id: context.step.id,
            status: 'failed',
            exitDetail: { reason: 'closed_elsewhere' },
            startedAt: context.step.startedAt ?? at,
            endedAt: at,
          },
        ],
      }),
    );
    return Promise.reject(new Error('시도를 닫은 뒤 예외'));
  };

  /** 종료 신호가 올 때까지 끝나지 않는 단계 (엔진을 멈춰 그 단계 시도가 running인 채로 남긴다). */
  const untilStopped: StepExecutor = (context) =>
    new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason as Error), {
        once: true,
      });
    });

  /**
   * `kind` 단계가 도는 중에 엔진을 멈추고, 그 시도를 저장소에서 끝낸 뒤(열린 시도 없음) 재기동 · 재개한다:
   * 재개는 대기 시도가 없어 실행만 running으로 바꾸고 #drive가 `state_inconsistent` 경로로 간다.
   */
  const resumeWithoutOpenAttempt = async (h: Harness, kind: StepKind): Promise<RunDetail> => {
    expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
    await waitFor(
      () => detailOf(h).steps.some((s) => s.kind === kind && s.status === 'running'),
      30_000,
      `${kind} 단계 시작`,
    );
    await h.engine.stop();
    const open = detailOf(h).steps.find((s) => s.kind === kind && s.status === 'running');
    if (open === undefined) throw new Error('열린 시도 없음');
    const at = new Date().toISOString();
    withProject(h.biveHome, h.project.id, (store) =>
      store.runs.transition(h.runId, {
        expectedStatus: 'running',
        steps: [
          {
            id: open.id,
            status: 'failed',
            exitDetail: { reason: 'closed_elsewhere' },
            endedAt: at,
          },
        ],
      }),
    );
    const second = h.newEngine();
    expect(second.recoverInterruptedRuns()).toHaveLength(1);
    const interrupted = detailOf(h);
    expect(interrupted.run.status).toBe('interrupted');
    expect(interrupted.steps.filter((s) => s.kind === kind).map((s) => s.status)).toEqual([
      'failed',
    ]);
    await second.resume(h.project.id, h.runId, human);
    await second.settled();
    return detailOf(h);
  };

  it('엔진 코드에서 실행 상태를 failed로 직접 쓰는 곳이 없다: 실패 쪽 종료는 모두 runEnding을 거친다 (재개 불가 종료 포함, ADR-105)', () => {
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/engine/pipeline-engine.ts'),
      'utf8',
    );
    // 실행 패치(`run: { ... }`) 안의 `status: 'failed'` · `'budget_exceeded'` 리터럴이 없다 (단계 시도의 status는 대상 아님)
    expect(source.match(/run:\s*\{[^{}]*status:\s*'(failed|budget_exceeded)'/g) ?? []).toEqual([]);
    // 실행 서비스의 실행 대기 시작(대상 규칙 재검사 · 자동 시작 실행의 하루 한도 재확인)도 같다 (ADR-111)
    const queue = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/runs/run-service.ts'),
      'utf8',
    );
    expect(queue.match(/run:\s*\{[^{}]*status:\s*'(failed|budget_exceeded)'/g) ?? []).toEqual([]);
    expect(queue.match(/\brunEnding\(/g) ?? []).toHaveLength(2);
    // 재개 불가 종료도 runEnding을 부른다
    const body = source.slice(source.indexOf('#failUnresumable('), source.indexOf('// ── 수명'));
    expect(body).toContain('runEnding(run,');
  });

  it('#failAfterError(시도가 이미 끝남): 병합 커밋이 기록된 실행은 merged(실패 사유 없음), 보존하지 않음', async () => {
    const h = setup({ executors: { screen_update: closeAttemptThenThrow } });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'merged',
      failureReason: null,
      currentStep: null,
      lastCompletedStep: 'merge',
      mergeCommit: mainTip(h),
    });
    expect(done.run.endedAt).not.toBeNull();
    expect(attempts(done, 'screen_update')).toEqual(['screen_update#1:failed']);
    expect(stepOf(done, 'screen_update').exitDetail).toEqual({ reason: 'closed_elsewhere' });
    expect(isLocked(h, String(done.run.worktreePath))).toBe(false);
    expect(h.engine.activeRunIds).toEqual([]);
  }, 60_000);

  it('#failAfterError(시도가 이미 끝남) 대조: 병합 커밋이 없는 실행은 이전처럼 failed(step_error) · 보존, 기준 브랜치 그대로', async () => {
    const h = setup({ executors: { check: closeAttemptThenThrow } });
    const base = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'step_error',
      currentStep: 'check',
      mergeCommit: null,
    });
    expect(attempts(done, 'check')).toEqual(['check#1:failed']);
    expect(mainTip(h)).toBe(base);
    expect(isLocked(h, String(done.run.worktreePath))).toBe(true);
  }, 60_000);

  it('#drive의 state_inconsistent(열린 시도 없음): 병합 커밋이 기록된 실행은 merged(실패 사유 없음), 보존하지 않음', async () => {
    const h = setup({ executors: { screen_update: untilStopped } });
    const done = await resumeWithoutOpenAttempt(h, 'screen_update');
    const merge = String(done.run.mergeCommit);
    expect(merge).toMatch(/^[0-9a-f]{40}$/);
    expect(mainTip(h)).toBe(merge);
    expect(done.run).toMatchObject({
      status: 'merged',
      failureReason: null,
      currentStep: null,
      lastCompletedStep: 'merge',
    });
    expect(done.run.endedAt).not.toBeNull();
    expect(isLocked(h, String(done.run.worktreePath))).toBe(false);
  }, 60_000);

  it('#drive의 state_inconsistent 대조: 병합 커밋이 없는 실행은 이전처럼 failed(state_inconsistent), 병합 없음', async () => {
    const h = setup({ executors: { check: untilStopped } });
    const base = mainTip(h);
    const done = await resumeWithoutOpenAttempt(h, 'check');
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'state_inconsistent',
      currentStep: 'check',
      mergeCommit: null,
    });
    expect(mainTip(h)).toBe(base);
  }, 60_000);
});
