// 이어받는 실행의 중간 시작 (M3-60 #325, TODO-02 · COST-01 · NFR-01, ADR-147 ② ③, ADR-150 ③, ADR-152).
// 실제 SQLite · 픽스처 git 복사본 · 실제 엔진 · 실제 실행 처리기(한도 상향 재개). 단계 실행기는 시험용(멈춘 자리 · 회귀 상한)과 제품
// 실행기(판정 · 설치만 주입: 판정 근거 · 보강의 재주입 · 더하기만)를 쓴다.
// - 시작 단계 = 원 실행에서 예산 초과를 낸 시도의 단계. 파이프라인 순서에서 그 앞 단계만 skipped(이어받음), 시작 단계와 그 뒤는 다시 돈다
// - 작업 가지 = 원 실행의 마지막 산출 커밋(없으면 기준 커밋), 커밋되지 않은 변경은 이어받지 않는다
// - 판정 근거 = 이어받은 단계가 가리키는 시도 + 자기 단계 (basisSteps), 회귀 상한 = 사슬 전체
import fs from 'node:fs';
import path from 'node:path';

import type { BudgetSnapshot, RunType, Step } from '@bive/shared';
import type { ProjectStore, RunDetail } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import { selectAgent } from '../src/agent/select.js';
import { PipelineEngine } from '../src/engine/pipeline-engine.js';
import type { StepContext, StepExecutor, StepExecutors } from '../src/engine/types.js';
import { createRunHandlers } from '../src/ipc/run-handlers.js';
import { reinforceSurvivedMutants } from '../src/runs/auto-start.js';
import { basisSteps } from '../src/runs/run-continuation.js';
import { createRun } from '../src/runs/run-service.js';
import { EXISTING_TEST_CHANGED_MESSAGE, TEST_ONLY_STAGE } from '../src/steps/green-check.js';
import {
  COMPLETE_SETTINGS,
  copyFixture,
  human,
  mergeStep,
  newId,
  seedProject,
  testExecutors,
  userGit,
  withProject,
} from './helpers/engine-harness.js';
import {
  cleanupMutationHarness,
  HEALTH,
  redFromWorktree,
  runToEnd as runMutationToEnd,
  settleAll,
  setup as setupMutation,
} from './helpers/mutation-harness.js';
import {
  contentJudge,
  hookAdapter,
  type JudgeCall,
  type JudgeDecision,
  type PipelineSetupOptions,
  runToEnd as runPipelineToEnd,
  setupPipeline,
} from './helpers/pipeline-harness.js';
import { cleanup, makeBiveHome } from './helpers/process.js';

const temps: string[] = [];
const engines: PipelineEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}, 60_000);
afterEach(cleanupMutationHarness, 60_000);

const clock = { now: Date.now, newId };

// ── 시험용 실행기 ────────────────────────────────────────

/** 실행을 예산 초과로 끝내는 실행기 (엔진의 세션 한도 subtype과 같은 사유). */
const budgetHalt: StepExecutor = () =>
  Promise.resolve({ status: 'halt', runStatus: 'budget_exceeded', reason: 'error_max_budget_usd' });
const unmet: StepExecutor = () =>
  Promise.resolve({ status: 'unmet', exitDetail: { scripted: true } });
const pass: StepExecutor = () => Promise.resolve({ status: 'passed' });
/** 워크트리에 파일 하나를 더하고 통과 (커밋 단계면 엔진이 커밋한다). */
const touch: StepExecutor = (context) => {
  const file = path.join(
    context.git.worktreePath,
    'notes',
    `${context.step.kind}-${context.run.displayId}-${String(context.step.attempt)}.md`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${context.step.kind}\n`);
  return Promise.resolve({ status: 'passed' });
};
/** 시도 번호(1부터)에 따라 고른다. 다 쓰면 마지막을 반복한다. */
const byAttempt =
  (...outcomes: StepExecutor[]): StepExecutor =>
  (context) =>
    (outcomes[Math.min(context.step.attempt, outcomes.length) - 1] as StepExecutor)(context);

/** 실행마다 고르는 실행기: 이름 붙인 실행(원 · 1차 …)이면 그 실행기, 아니면 `other`. */
type Cast = Record<string, string>;
const byRun =
  (cast: Cast, plan: Record<string, StepExecutor>, other: StepExecutor): StepExecutor =>
  (context) => {
    const name = Object.entries(cast).find(([, id]) => id === context.run.id)?.[0];
    return (name === undefined ? other : (plan[name] ?? other))(context);
  };

// ── 하네스 ──────────────────────────────────────────────

interface Harness {
  readonly biveHome: string;
  readonly repo: string;
  readonly projectId: string;
  readonly ruleId: string;
  readonly engine: PipelineEngine;
  readonly cast: Cast;
  readonly read: <T>(fn: (store: ProjectStore) => T) => T;
}

/** 시험용 실행기로 도는 엔진 (`executors`는 이름 붙인 실행 · 그 밖을 가른다). */
const setup = (executors: (cast: Cast) => StepExecutors): Harness => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const seeded = seedProject(biveHome, repo, COMPLETE_SETTINGS);
  const cast: Cast = {};
  const engine = new PipelineEngine({
    biveHome,
    agent: selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome }).adapter,
    executors: testExecutors(executors(cast)),
  });
  engines.push(engine);
  return {
    biveHome,
    repo,
    projectId: seeded.project.id,
    ruleId: seeded.rule.id,
    engine,
    cast,
    read: (fn) => withProject(biveHome, seeded.project.id, fn),
  };
};

const detailOf = (h: Pick<Harness, 'read'>, runId: string): RunDetail =>
  h.read((store) => store.runs.getDetail(runId)!);

/** 사람이 시작한 실행(`type`)을 끝까지 돌린다. */
const startRun = async (h: Harness, name: string, type?: RunType): Promise<RunDetail> => {
  const id = h.read(
    (store) =>
      createRun(
        store,
        { ruleIds: [h.ruleId], author: human, ...(type === undefined ? {} : { type }) },
        { clientId: null },
        clock,
      ).run.id,
  );
  h.cast[name] = id;
  h.engine.evaluateApproval(h.projectId, id);
  await h.engine.settled();
  return detailOf(h, id);
};

/** 실제 실행 처리기의 한도 상향 재개(원 실행과 같은 예산 값)로 이어받는 실행을 만들고 끝까지 돌린다. */
const continueRun = async (
  h: { biveHome: string; projectId: string; engine: PipelineEngine; read: Harness['read'] },
  originId: string,
  settle: () => Promise<void>,
  cast?: { cast: Cast; name: string },
): Promise<RunDetail> => {
  const { seq, budget } = h.read((store) => ({
    seq: store.reviewQueue
      .list({ kind: 'budget_exceeded', state: 'open' })
      .find((item) => item.runId === originId)!.seq,
    budget: store.runs.get(originId)!.budgetSnapshot as BudgetSnapshot,
  }));
  const handlers = createRunHandlers({ biveHome: h.biveHome, now: Date.now, engine: h.engine });
  const resume = handlers['reviewQueue.resumeWithBudget']!;
  const created = await resume({ projectId: h.projectId, seq, budget, author: human }, {
    connectionId: 1,
  } as Parameters<typeof resume>[1]);
  if (cast !== undefined) cast.cast[cast.name] = created.run.id;
  await settle();
  return detailOf(h, created.run.id);
};

const attempts = (detail: RunDetail): string[] =>
  detail.steps.map((step) => `${step.kind}#${String(step.attempt)}:${step.status}`);

/** 이어받은 시도의 가리킴 (종류 → [실행 ID, 단계 시도 ID]). */
const pointers = (detail: RunDetail): Record<string, [string, string]> =>
  Object.fromEntries(
    detail.steps.flatMap((step) => {
      const exit = step.exitDetail as { reason?: string; fromRunId?: string; fromStepId?: string };
      return step.status === 'skipped' && exit.reason === 'inherited'
        ? [[step.kind, [exit.fromRunId!, exit.fromStepId!]]]
        : [];
    }),
  );

const lastPassedId = (detail: RunDetail, kind: Step['kind']): string =>
  detail.steps.filter((step) => step.kind === kind && step.status === 'passed').at(-1)!.id;

const recordOf = (h: Pick<Harness, 'read'>, runId: string) =>
  h.read((store) => ({
    detail: store.runs.getDetail(runId),
    sessions: store.sessions.listByRun(runId),
  }));

// ── 시작 단계 · 이어받은 단계 · 작업 가지 ─────────────────

describe('시작 단계와 이어받은 단계 (M3-60 수용 기준 1, ADR-150 ③ⓐ)', () => {
  it('유형 A가 구현에서 멈추면: 테스트 작성 · Red 확인은 skipped(이어받음, 원 실행의 통과 시도), 구현부터 돌고, 가지는 원 실행의 마지막 산출 커밋에서 시작하며 원 실행이 남긴 커밋되지 않은 변경은 없다. 원 실행 기록은 그대로다', async () => {
    const h = setup((cast) => ({
      test_writing: touch,
      red_check: pass,
      implementation: byRun(
        cast,
        {
          // 원 실행: 커밋되지 않은 변경을 남기고 예산 초과
          origin: (context) => {
            fs.writeFileSync(path.join(context.git.worktreePath, 'UNCOMMITTED.md'), '남은 변경\n');
            return budgetHalt(context);
          },
        },
        touch,
      ),
      check: pass,
      merge: mergeStep,
    }));
    const origin = await startRun(h, 'origin');
    expect(origin.run).toMatchObject({ status: 'budget_exceeded', currentStep: 'implementation' });
    const before = recordOf(h, origin.run.id);
    const next = await continueRun(h, origin.run.id, () => h.engine.settled());
    expect(next.run.status).toBe('merged');
    expect(attempts(next)).toEqual([
      'approval#1:passed',
      'test_writing#1:skipped',
      'red_check#1:skipped',
      'implementation#1:passed',
      'check#1:passed',
      'mutation#1:skipped',
      'merge#1:passed',
      'screen_update#1:passed',
    ]);
    expect(pointers(next)).toEqual({
      test_writing: [origin.run.id, lastPassedId(origin, 'test_writing')],
      red_check: [origin.run.id, lastPassedId(origin, 'red_check')],
    });
    expect(next.steps.filter((step) => step.status === 'passed').map((s) => s.kind)).not.toContain(
      'test_writing',
    );
    // 작업 가지: 원 실행의 테스트 작성 커밋 위에 이 실행의 구현 커밋 하나, 커밋되지 않은 변경은 들어오지 않았다
    const impl = next.steps.find((step) => step.kind === 'implementation')!;
    expect(userGit(h.repo, 'rev-parse', `${impl.commit!}^`)).toBe(origin.run.headCommit);
    expect(next.run.baseCommit).toBe(origin.run.baseCommit);
    expect(
      userGit(h.repo, 'ls-tree', '-r', '--name-only', next.run.mergeCommit!).split('\n'),
    ).not.toContain('UNCOMMITTED.md');
    expect(fs.existsSync(path.join(next.run.worktreePath!, 'UNCOMMITTED.md'))).toBe(false);
    expect(fs.existsSync(path.join(origin.run.worktreePath!, 'UNCOMMITTED.md'))).toBe(true);
    // 원 실행은 그대로다 (읽기만)
    expect(recordOf(h, origin.run.id)).toEqual(before);
  }, 90_000);

  it('회귀 중에 멈추면(구현 1회차 통과 → 검사 미충족 → 구현 2회차에서 예산 초과) 구현부터 다시 돌고 검사도 다시 돈다. 회귀 수는 사슬로 이어 세어 상한이 늘지 않는다', async () => {
    const h = setup((cast) => ({
      test_writing: touch,
      red_check: pass,
      implementation: byRun(cast, { origin: byAttempt(touch, budgetHalt) }, touch),
      check: unmet,
      merge: mergeStep,
    }));
    const origin = await startRun(h, 'origin');
    expect(attempts(origin)).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'red_check#1:passed',
      'implementation#1:passed',
      'implementation#2:failed',
      'check#1:failed',
      'check#2:pending',
      'mutation#1:pending',
      'merge#1:pending',
      'screen_update#1:pending',
    ]);
    expect(origin.run.regressionCount).toBe(1);
    const next = await continueRun(h, origin.run.id, () => h.engine.settled());
    // 원 실행 1회 + 이 실행 1회 = 2회까지, 세 번째 검사 미충족에서 상한 (이어 세지 않으면 이 실행에서 두 번 더 회귀한다)
    expect(next.run).toMatchObject({ status: 'failed', failureReason: 'regression_limit' });
    expect(next.run.regressionCount).toBe(1);
    expect(attempts(next)).toEqual([
      'approval#1:passed',
      'test_writing#1:skipped',
      'red_check#1:skipped',
      'implementation#1:passed',
      'implementation#2:passed',
      'check#1:failed',
      'check#2:failed',
      'mutation#1:pending',
      'merge#1:pending',
      'screen_update#1:pending',
    ]);
    // 가지는 원 실행의 마지막 산출 커밋(구현 1회차)에서 시작했다
    expect(origin.run.headCommit).toBe(
      origin.steps.find((s) => s.id === lastPassedId(origin, 'implementation'))!.commit,
    );
    expect(
      userGit(
        h.repo,
        'rev-parse',
        `${next.steps.find((s) => s.kind === 'implementation')!.commit!}^`,
      ),
    ).toBe(origin.run.headCommit);
  }, 90_000);

  it('유형 C가 회귀 중 테스트 작성에서 멈추면(Green · 검사 통과 뒤 변이 미충족 → 테스트 작성 2회차) 테스트 작성부터 돌고 원 실행의 통과였던 Green 확인 · 검사도 다시 돌며, 그 시도들은 판정 근거에 들지 않는다', async () => {
    const seen: string[][] = [];
    const h = setup((cast) => ({
      test_writing: byRun(cast, { origin: byAttempt(touch, budgetHalt) }, touch),
      green_check: pass,
      check: pass,
      mutation: byRun(cast, { origin: unmet }, pass),
      merge: (context) => {
        seen.push(basisSteps(context).map((step) => step.id));
        return mergeStep(context);
      },
    }));
    const origin = await startRun(h, 'origin', 'C');
    expect(origin.run).toMatchObject({ status: 'budget_exceeded', currentStep: 'test_writing' });
    expect(attempts(origin)).toEqual(
      expect.arrayContaining(['green_check#1:passed', 'check#1:passed', 'mutation#1:failed']),
    );
    const next = await continueRun(h, origin.run.id, () => h.engine.settled());
    expect(next.run.status).toBe('merged');
    expect(attempts(next).slice(0, 5)).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'green_check#1:passed',
      'implementation#1:skipped',
      'check#1:passed',
    ]);
    expect(pointers(next)).toEqual({});
    // 병합 실행기가 본 판정 근거 = 이 실행의 단계뿐 (원 실행의 Green 확인 · 검사 통과 시도는 들지 않는다)
    expect(seen).toEqual([next.steps.map((step) => step.id)]);
  }, 90_000);

  it('유형 D · B: 유형이 생략하는 단계는 이어받지 않고(유형 생략 그대로), D의 기준 검사(Green 확인)는 이어받는다', async () => {
    for (const type of ['D', 'B'] as const) {
      const h = setup((cast) => ({
        green_check: pass,
        implementation: byRun(cast, { origin: budgetHalt }, touch),
        check: pass,
        merge: mergeStep,
      }));
      const origin =
        type === 'B' ? await startRunWithBuiltin(h) : await startRun(h, 'origin', type);
      expect(origin.run).toMatchObject({
        status: 'budget_exceeded',
        currentStep: 'implementation',
      });
      const next = await continueRun(h, origin.run.id, () => h.engine.settled());
      const skipped = next.steps
        .filter((step) => step.status === 'skipped')
        .map((step) => [step.kind, (step.exitDetail as { reason: string }).reason]);
      expect(skipped, type).toEqual(
        type === 'D'
          ? [
              ['test_writing', 'run_type'],
              ['red_check', 'run_type'],
              ['green_check', 'inherited'],
            ]
          : [
              ['test_writing', 'run_type'],
              ['red_check', 'run_type'],
              ['mutation', 'run_type'],
            ],
      );
      expect(next.steps.find((step) => step.kind === 'implementation')?.status, type).toBe(
        'passed',
      );
    }
  }, 120_000);

  it('원 실행이 끝낸 단계가 없으면(첫 단계에서 멈춤) 이어받는 단계 없이 기준 커밋에서 첫 단계부터 돈다', async () => {
    const h = setup((cast) => ({
      test_writing: byRun(cast, { origin: budgetHalt }, touch),
      red_check: pass,
      implementation: budgetHalt,
    }));
    const origin = await startRun(h, 'origin');
    expect(origin.run).toMatchObject({ currentStep: 'test_writing', headCommit: null });
    const next = await continueRun(h, origin.run.id, () => h.engine.settled());
    expect(pointers(next)).toEqual({});
    const writing = next.steps.find((step) => step.kind === 'test_writing')!;
    expect(writing.status).toBe('passed');
    expect(userGit(h.repo, 'rev-parse', `${writing.commit!}^`)).toBe(origin.run.baseCommit);
  }, 90_000);

  it('사람이 원 실행 브랜치를 지웠으면 이어받는 실행은 작업 가지를 만들지 못하고 실패한다 (start_commit_unavailable, 닫힌 쪽)', async () => {
    const h = setup((cast) => ({
      test_writing: touch,
      red_check: pass,
      implementation: byRun(cast, { origin: budgetHalt }, touch),
    }));
    const origin = await startRun(h, 'origin');
    userGit(h.repo, 'worktree', 'remove', '--force', '--force', origin.run.worktreePath!);
    userGit(h.repo, 'branch', '-D', origin.run.branch!);
    const next = await continueRun(h, origin.run.id, () => h.engine.settled());
    expect(next.run).toMatchObject({
      status: 'failed',
      failureReason: 'worktree_error',
      branch: null,
    });
    const failedStep = next.steps.find((step) => step.status === 'failed')!;
    expect(JSON.stringify(failedStep.exitDetail)).toContain(origin.run.branch!);
  }, 90_000);
});

/** 유형 B 원 실행: 내장 구조 규칙을 대상으로 (정적 검사 규칙만). */
const startRunWithBuiltin = async (h: Harness): Promise<RunDetail> => {
  const ruleId = h.read((store) => {
    return store.rules.create({
      id: newId(),
      title: 'structure.declared-direction',
      statement: 'WHEN 블록의 파일이 다른 블록을 가져오면 THE SYSTEM SHALL 선언한 방향만 허용한다',
      kind: 'architecture',
      checkKinds: ['structure'],
      parentRequirementId: null,
      builtin: true,
      targetBlockIds: [],
      risk: null,
      contractId: null,
      author: human,
      normState: 'approved',
      createdAt: new Date().toISOString(),
    }).id;
  });
  const id = h.read(
    (store) =>
      createRun(store, { ruleIds: [ruleId], author: human, type: 'B' }, { clientId: null }, clock)
        .run.id,
  );
  h.cast['origin'] = id;
  h.engine.evaluateApproval(h.projectId, id);
  await h.engine.settled();
  return detailOf(h, id);
};

// ── 회귀 상한 · 사슬 2단 ────────────────────────────────

describe('회귀 상한은 사슬 전체로 센다 · 사슬 2단 (M3-60 수용 기준 3, ADR-150 ③ⓓ)', () => {
  it('테스트 작성 재시도: 원 실행의 시도(멈춘 시도는 빼고)부터 이어 세어 재시도 상한을 넘기지 못하고, 멈춘 시도 때문에 줄지도 않는다', async () => {
    const h = setup((cast) => ({
      test_writing: byRun(cast, { origin: byAttempt(touch, budgetHalt) }, touch),
      green_check: unmet,
    }));
    const origin = await startRun(h, 'origin', 'C');
    expect(attempts(origin).filter((a) => a.startsWith('test_writing'))).toEqual([
      'test_writing#1:passed',
      'test_writing#2:failed',
    ]);
    const next = await continueRun(h, origin.run.id, () => h.engine.settled());
    // 사슬의 판정된 테스트 작성 = 원 1 + 이 실행 2 = 상한 2 + 1 (멈춘 시도를 세면 이 실행은 1번만, 세지 않으면 3번)
    expect(next.run).toMatchObject({ status: 'failed', failureReason: 'test_retry_limit' });
    expect(attempts(next).filter((a) => a.startsWith('test_writing'))).toEqual([
      'test_writing#1:passed',
      'test_writing#2:passed',
    ]);
  }, 90_000);

  it('사슬 2단(원 → 1차 → 2차): 2차는 1차가 멈춘 단계부터 돌고, 1차가 이어받은 단계는 실제로 그 단계를 돈 원 실행의 시도를 가리키며, 회귀 수는 원 실행과 1차의 합부터 이어 센다', async () => {
    const h = setup((cast) => ({
      test_writing: touch,
      red_check: pass,
      // 원 실행: 구현 1회차 통과 → 검사 미충족(회귀 1) → 구현 2회차에서 예산 초과
      implementation: byRun(cast, { origin: byAttempt(touch, budgetHalt) }, touch),
      // 1차: 검사 미충족 1번(회귀 1) 뒤 두 번째 검사 시도에서 예산 초과 / 원 실행 · 2차: 늘 미충족
      check: byRun(cast, { first: byAttempt(unmet, budgetHalt) }, unmet),
    }));
    const origin = await startRun(h, 'origin');
    expect(origin.run).toMatchObject({ currentStep: 'implementation', regressionCount: 1 });
    const first = await continueRun(h, origin.run.id, () => h.engine.settled(), {
      cast: h.cast,
      name: 'first',
    });
    expect(first.run).toMatchObject({
      status: 'budget_exceeded',
      currentStep: 'check',
      regressionCount: 1,
    });
    const second = await continueRun(h, first.run.id, () => h.engine.settled());
    expect(pointers(second)).toEqual({
      test_writing: [origin.run.id, lastPassedId(origin, 'test_writing')],
      red_check: [origin.run.id, lastPassedId(origin, 'red_check')],
      implementation: [first.run.id, lastPassedId(first, 'implementation')],
    });
    // 2차는 검사부터: 첫 검사 미충족 → 원 1 + 1차 1 + 이 실행 1 = 3 > 2 상한 (바로 앞 원 실행만 세면 한 번 더 회귀한다)
    expect(second.run).toMatchObject({
      status: 'failed',
      failureReason: 'regression_limit',
      regressionCount: 0,
    });
    expect(attempts(second).filter((a) => /^(implementation|check)/.test(a))).toEqual([
      'implementation#1:skipped',
      'check#1:failed',
    ]);
    // 2차의 가지와 마지막 완료 단계 커밋은 1차의 것에서 시작했다
    expect(second.run.baseCommit).toBe(origin.run.baseCommit);
    expect(second.run.headCommit).toBe(first.run.headCommit);
    expect(userGit(h.repo, 'rev-parse', `refs/heads/${second.run.branch!}`)).toBe(
      first.run.headCommit,
    );
  }, 120_000);
});

// ── 판정 근거 (제품 실행기) ──────────────────────────────

const ACC_FILE = 'bive-acceptance/RULE-001/health-time.acc.ts';

describe('판정 근거는 원 실행의 단계 기록에서 읽는다 (M3-60 수용 기준 2, ADR-147 ③)', () => {
  const setupProduct = (
    options: Omit<PipelineSetupOptions, 'temps' | 'engines' | 'executors'> = {},
  ) => {
    const ref: { origin?: string } = {};
    const h = setupPipeline({
      ...options,
      temps,
      engines,
      executors: (defaults) => ({
        ...defaults,
        implementation: (context) =>
          context.run.id === ref.origin ? budgetHalt(context) : defaults.implementation(context),
      }),
    });
    ref.origin = h.runId;
    return h;
  };
  const harnessOf = (h: ReturnType<typeof setupPipeline>) => ({
    biveHome: h.biveHome,
    projectId: h.project.id,
    engine: h.engine,
    read: <T>(fn: (store: ProjectStore) => T): T => withProject(h.biveHome, h.project.id, fn),
  });

  it('구현에서 멈춘 원 실행을 이으면 이 실행은 Red 확인을 다시 하지 않고 원 실행의 Red 해시 · 테스트 작성 커밋으로 구현 · 검사 · 병합까지 간다 (원 실행의 상태 · 단계는 그대로)', async () => {
    const h = setupProduct();
    const origin = await runPipelineToEnd(h);
    expect(origin.run).toMatchObject({ status: 'budget_exceeded', currentStep: 'implementation' });
    const before = recordOf(harnessOf(h), origin.run.id);
    const redCalls = h.judgeCalls.filter((call) => call.kind === 'red_check').length;
    const next = await continueRun(harnessOf(h), origin.run.id, () => h.engine.settled());
    expect(next.run.status).toBe('merged');
    expect(pointers(next)).toEqual({
      test_writing: [origin.run.id, lastPassedId(origin, 'test_writing')],
      red_check: [origin.run.id, lastPassedId(origin, 'red_check')],
    });
    // Red 확인 판정은 원 실행의 것 하나뿐, 이 실행의 판정은 구현 · 검사 · 병합 재검사
    expect(h.judgeCalls.filter((call) => call.kind === 'red_check')).toHaveLength(redCalls);
    expect(
      h.judgeCalls.filter((call) => call.input.runId === next.run.id).map((call) => call.kind),
    ).toEqual(['implementation', 'check']);
    expect(recordOf(harnessOf(h), origin.run.id)).toEqual(before);
  }, 90_000);

  it('이어받는 실행의 구현 세션이 인수 테스트를 바꾸면 원 실행의 Red 해시로 guard_violation이다 (판정하지 않음)', async () => {
    const h = setupProduct({
      wrapAdapter: (adapter) =>
        hookAdapter(adapter, {
          beforeResult: (spec) => {
            if (spec.role !== 'implementer') return;
            fs.writeFileSync(
              path.join(spec.workDir, ACC_FILE),
              "import { it } from 'vitest';\nit('항상 통과', () => {});\n",
            );
          },
        }),
    });
    const origin = await runPipelineToEnd(h);
    const next = await continueRun(harnessOf(h), origin.run.id, () => h.engine.settled());
    expect(next.run).toMatchObject({ status: 'failed', failureReason: 'guard_violation' });
    expect(next.steps.find((step) => step.kind === 'implementation')?.exitDetail).toMatchObject({
      reason: 'guard_violation',
      detail: { stage: 'acceptance_hash', changed: [ACC_FILE] },
    });
    expect(h.judgeCalls.filter((call) => call.input.runId === next.run.id)).toEqual([]);
  }, 90_000);

  it('검사(판단 세션)에서 멈춘 원 실행을 이으면 검사부터 돌고, 검사 미충족으로 구현을 다시 돈 뒤에는 이 실행의 구현 시도가 근거다 (원 실행의 구현 시도를 고르지 않는다)', async () => {
    const ref: { origin?: string; next?: string } = {};
    let checks = 0;
    const h = setupPipeline({
      temps,
      engines,
      decide: (call) => {
        if (call.kind === 'check' && call.input.runId !== ref.origin) {
          checks += 1;
          // 이어받는 실행의 첫 검사만 RULE-001 실패 (구현으로 회귀)
          if (checks === 1) return { 'RULE-001': ['failed', 'failed'] };
        }
        return contentJudge(call);
      },
      // 이어받는 실행의 구현 세션은 새 파일을 하나 더 써서 새 커밋을 만든다
      wrapAdapter: (adapter) =>
        hookAdapter(adapter, {
          beforeResult: (spec) => {
            if (spec.role !== 'implementer' || spec.runId === ref.origin) return;
            fs.mkdirSync(path.join(spec.workDir, 'notes'), { recursive: true });
            fs.writeFileSync(path.join(spec.workDir, 'notes', 'next.md'), '이어받는 실행\n');
          },
        }),
      executors: (defaults) => ({
        ...defaults,
        check: (context) =>
          context.run.id === ref.origin ? budgetHalt(context) : defaults.check(context),
      }),
    });
    ref.origin = h.runId;
    const origin = await runPipelineToEnd(h);
    expect(origin.run).toMatchObject({ status: 'budget_exceeded', currentStep: 'check' });
    const next = await continueRun(harnessOf(h), origin.run.id, () => h.engine.settled());
    expect(next.run.status).toBe('merged');
    expect(attempts(next).filter((a) => /^(implementation|check)/.test(a))).toEqual([
      'implementation#1:skipped',
      'implementation#2:passed',
      'check#1:failed',
      'check#2:passed',
    ]);
    const own = next.steps.find((s) => s.kind === 'implementation' && s.attempt === 2)!;
    expect(own.commit).not.toBe(origin.run.headCommit);
    expect(checks).toBe(2);
  }, 90_000);

  it('이어받은 시도의 가리킴은 읽을 때 대조한다: 사슬 밖 실행 · 다른 단계 종류 · 기록과 다른 상태를 가리키면 이어받은 근거를 싣지 않아 구현 단계가 state_inconsistent로 멈춘다', async () => {
    const halting = new Set<string>();
    const h = setupPipeline({
      temps,
      engines,
      executors: (defaults) => ({
        ...defaults,
        implementation: (context) =>
          halting.has(context.run.id) ? budgetHalt(context) : defaults.implementation(context),
      }),
    });
    const read = <T>(fn: (store: ProjectStore) => T): T =>
      withProject(h.biveHome, h.project.id, fn);
    /** 테스트 작성 · Red 확인을 통과하고 구현에서 예산 초과로 끝난 사람 실행 하나. */
    const halted = async (id?: string): Promise<RunDetail> => {
      const runId =
        id ??
        read(
          (store) =>
            createRun(store, { ruleIds: [h.rule.id], author: human }, { clientId: null }, clock).run
              .id,
        );
      halting.add(runId);
      h.engine.evaluateApproval(h.project.id, runId);
      await h.engine.settled();
      const detail = read((store) => store.runs.getDetail(runId)!);
      expect(detail.run).toMatchObject({
        status: 'budget_exceeded',
        currentStep: 'implementation',
      });
      return detail;
    };
    const first = await halted(h.runId);
    const outsider = await halted();
    /** 원 실행 `origin`을 잇는 실행을 시험이 고른 이어받은 단계로 만든다 (검토 대기열을 거치지 않고 내부 값으로). */
    const continuationWith = (
      origin: RunDetail,
      pointed: { tw: [RunDetail, Step['kind']]; red: [RunDetail, Step['kind']] },
      redStatus: 'passed' | 'skipped' = 'passed',
    ): string =>
      read((store) =>
        store.transaction(() => {
          const created = createRun(
            store,
            { ruleIds: [h.rule.id], author: human },
            { clientId: null },
            clock,
            {
              budgetSnapshot: origin.run.budgetSnapshot,
              inherited: (
                [
                  ['test_writing', pointed.tw, 'passed'],
                  ['red_check', pointed.red, redStatus],
                ] as const
              ).map(([kind, [run, pointedKind], fromStatus]) => ({
                kind,
                detail: {
                  reason: 'inherited' as const,
                  fromRunId: run.run.id,
                  fromStepId: lastPassedId(run, pointedKind),
                  fromStatus,
                },
              })),
            },
          );
          store.runContinuations.link({
            runId: created.run.id,
            originRunId: origin.run.id,
            createdAt: created.run.createdAt,
          });
          return created.run.id;
        }),
      );
    const drive = async (runId: string): Promise<RunDetail> => {
      h.engine.evaluateApproval(h.project.id, runId);
      await h.engine.settled();
      return read((store) => store.runs.getDetail(runId)!);
    };
    const expectClosed = (detail: RunDetail, label: string) => {
      expect(detail.run, label).toMatchObject({
        status: 'failed',
        failureReason: 'state_inconsistent',
      });
      expect(
        detail.steps.find((s) => s.kind === 'implementation')?.exitDetail,
        label,
      ).toMatchObject({
        reason: 'state_inconsistent',
      });
    };
    // 사슬 밖 실행(같은 프로젝트의 다른 실행)의 시도를 가리킴
    expectClosed(
      await drive(
        continuationWith(first, {
          tw: [outsider, 'test_writing'],
          red: [outsider, 'red_check'],
        }),
      ),
      'outside',
    );
    // 다른 단계 종류 (테스트 작성 행 → Red 확인 시도, Red 확인 행 → 테스트 작성 시도)
    const second = await halted();
    expectClosed(
      await drive(
        continuationWith(second, { tw: [second, 'red_check'], red: [second, 'test_writing'] }),
      ),
      'kind',
    );
    // 통과한 시도를 생략이라고 기록
    const third = await halted();
    expectClosed(
      await drive(
        continuationWith(
          third,
          { tw: [third, 'test_writing'], red: [third, 'red_check'] },
          'skipped',
        ),
      ),
      'status',
    );
    // 대조군: 바르게 가리키면 구현이 돈다
    const fourth = await halted();
    const ok = await drive(
      continuationWith(fourth, { tw: [fourth, 'test_writing'], red: [fourth, 'red_check'] }),
    );
    expect(ok.steps.find((s) => s.kind === 'implementation')?.status).toBe('passed');
  }, 180_000);

  it('이어받는 실행이 아닌 실행은 판정 근거를 읽을 때 저장소를 읽지 않고 그 실행의 단계 그대로다', () => {
    const steps = [{ id: 'x', status: 'passed', exitDetail: null }] as unknown as Step[];
    const context = {
      run: { id: newId() },
      steps,
      read: () => {
        throw new Error('읽지 않아야 함');
      },
    } as unknown as Pick<StepContext, 'run' | 'steps' | 'read'>;
    expect(basisSteps(context)).toEqual(steps);
  });
});

// ── 보강 실행을 이어받은 실행 (제품 실행기) ─────────────────

describe('보강 실행을 이어받은 실행의 재주입 · 더하기만은 원 실행의 근거로 돈다 (M3-60 수용 기준 4, ADR-143 ⑮)', () => {
  const EXISTING = 'bive-acceptance/RULE-001/mutation.acc.ts';
  const ADDED = 'bive-acceptance/RULE-001/reinforce-added.acc.ts';
  const VALID_MUTANT = { path: HEALTH, search: 'ok: true', replace: 'ok: false' };
  const killedByAdded = (call: JudgeCall): JudgeDecision =>
    Object.fromEntries(
      (call.input.ruleIds ?? []).map((id) => [
        id,
        call.status.includes('M src/') && call.acceptance.some((f) => f.includes('/reinforce-'))
          ? (['failed', 'passed'] as const)
          : (['passed', 'passed'] as const),
      ]),
    );
  const isAuto = (context: StepContext): boolean =>
    context.run.type === 'C' && context.run.startedBy.kind === 'orchestrator';
  type MutationSetup = Parameters<typeof setupMutation>[0];
  const setupChain = (executors: MutationSetup['executors']) =>
    setupMutation({
      rules: [{ blocks: ['health'], risk: 'medium' }],
      sessions: { 'RULE-001': [{ tool: 'propose_mutant', args: VALID_MUTANT }] },
      settings: { ...COMPLETE_SETTINGS, dailyBudgetUsd: 10 },
      noAutoStart: true,
      decide: killedByAdded,
      testWriter: [
        [
          {
            tool: 'write_file',
            args: {
              path: ADDED,
              content: "import { it } from 'vitest';\nit('보강 케이스', () => undefined);\n",
            },
          },
          { message: '보강 테스트 1개를 더했다.' },
        ],
      ],
      ...(executors === undefined ? {} : { executors }),
    });
  /** 유형 A 생존 → 자동 보강 실행을 엔진으로 돌린다 (변이 주입 단계에서 예산 초과). */
  const reinforceThenHalt = async (h: ReturnType<typeof setupMutation>) => {
    expect((await runMutationToEnd(h)).run.status).toBe('merged');
    const auto = withProject(h.biveHome, h.projectId, (store) => {
      const outcome = reinforceSurvivedMutants(store, { runId: h.runId }, clock);
      if (outcome.status !== 'started') throw new Error(`보강 실행 없음: ${outcome.status}`);
      return outcome.runs[0]!.detail.run.id;
    });
    h.engine.evaluateApproval(h.projectId, auto);
    await settleAll(h);
    const detail = withProject(h.biveHome, h.projectId, (store) => store.runs.getDetail(auto)!);
    expect(detail.run).toMatchObject({ status: 'budget_exceeded', currentStep: 'mutation' });
    return detail;
  };
  const harnessOf = (h: ReturnType<typeof setupMutation>) => ({
    biveHome: h.biveHome,
    projectId: h.projectId,
    engine: h.engine,
    read: <T>(fn: (store: ProjectStore) => T): T => withProject(h.biveHome, h.projectId, fn),
  });

  it('변이 주입에서 멈춘 보강 실행을 이으면 테스트 작성 · Green 확인 · 검사는 이어받고, 재주입이 원 실행의 Green 해시 · 테스트 작성 커밋으로 검출해 병합된다 (새 세션 없음)', async () => {
    const h = setupChain((current) => ({
      ...current,
      mutation: (context) => (isAuto(context) ? budgetHalt(context) : current.mutation!(context)),
    }));
    const auto = await reinforceThenHalt(h);
    const sessionsBefore = h.sessions.length;
    const next = await continueRun(harnessOf(h), auto.run.id, () => settleAll(h));
    expect(next.run).toMatchObject({ type: 'C', status: 'merged' });
    expect(pointers(next)).toEqual({
      test_writing: [auto.run.id, lastPassedId(auto, 'test_writing')],
      green_check: [auto.run.id, lastPassedId(auto, 'green_check')],
      check: [auto.run.id, lastPassedId(auto, 'check')],
    });
    expect(h.sessions).toHaveLength(sessionsBefore);
    const cause = withProject(h.biveHome, h.projectId, (store) =>
      store.mutations.reinforcementCauseOfRun(auto.run.id),
    );
    expect(next.steps.find((step) => step.kind === 'mutation')).toMatchObject({
      status: 'passed',
      exitDetail: { reinjected: cause },
    });
    const reinjection = h.judgeCalls.filter((call) => call.input.runId === next.run.id)[0]!;
    expect(reinjection.kind).toBe('mutation');
    expect(reinjection.acceptance).toEqual(expect.arrayContaining([EXISTING, ADDED]));
    expect(
      withProject(h.biveHome, h.projectId, (store) =>
        store.mutations.listByRun(next.run.id).map((r) => [r.status, r.sessionId]),
      ),
    ).toEqual([['verified', null]]);
  }, 120_000);

  it('유형 A가 변이 주입 세션에서 멈추면 테스트 작성 · Red 확인 · 구현 · 검사는 이어받고, 이어받는 실행의 변이 주입이 원 실행의 Red 해시 · 구현 커밋으로 돌아 병합된다', async () => {
    const ref: { origin?: string } = {};
    const h = setupMutation({
      rules: [{ blocks: ['health'], risk: 'medium' }],
      sessions: { 'RULE-001': [{ tool: 'propose_mutant', args: VALID_MUTANT }] },
      settings: { ...COMPLETE_SETTINGS, dailyBudgetUsd: 10 },
      noAutoStart: true,
      executors: (current) => ({
        ...current,
        mutation: (context) =>
          context.run.id === ref.origin ? budgetHalt(context) : current.mutation!(context),
      }),
    });
    ref.origin = h.runId;
    const origin = await runMutationToEnd(h);
    expect(origin.run).toMatchObject({ status: 'budget_exceeded', currentStep: 'mutation' });
    const next = await continueRun(harnessOf(h), origin.run.id, () => settleAll(h));
    expect(pointers(next)).toEqual({
      test_writing: [origin.run.id, lastPassedId(origin, 'test_writing')],
      red_check: [origin.run.id, lastPassedId(origin, 'red_check')],
      implementation: [origin.run.id, lastPassedId(origin, 'implementation')],
      check: [origin.run.id, lastPassedId(origin, 'check')],
    });
    expect(next.steps.find((step) => step.kind === 'mutation')?.status).toBe('passed');
    expect(next.run.status).toBe('merged');
    expect(h.sessions.map((spec) => [spec.role, spec.runId])).toEqual([['mutator', next.run.id]]);
    expect(
      withProject(h.biveHome, h.projectId, (store) =>
        store.mutations.listByRun(next.run.id).map((r) => [r.status, r.commit]),
      ),
    ).toEqual([['verified', origin.run.headCommit]]);
  }, 120_000);

  it('원 실행의 테스트 작성 커밋이 기준 커밋의 기존 인수 테스트를 바꿨으면(대조를 지나친 변경) 이어받는 실행의 병합 직전 대조가 원 실행의 커밋과 기준 커밋 사이에서 막는다', async () => {
    const h = setupChain((current) => ({
      ...current,
      test_writing: async (context) => {
        const outcome = await current.test_writing!(context);
        if (isAuto(context)) {
          fs.appendFileSync(path.join(context.git.worktreePath, EXISTING), '// 직접 고침\n');
        }
        return outcome;
      },
      green_check: (context) =>
        isAuto(context) ? redFromWorktree(context) : current.green_check!(context),
      mutation: (context) =>
        isAuto(context)
          ? budgetHalt(context)
          : context.run.type === 'C'
            ? Promise.resolve({ status: 'passed' as const })
            : current.mutation!(context),
    }));
    const auto = await reinforceThenHalt(h);
    const next = await continueRun(harnessOf(h), auto.run.id, () => settleAll(h));
    expect(next.run).toMatchObject({ status: 'failed', failureReason: 'guard_violation' });
    expect(next.steps.find((step) => step.kind === 'merge')?.exitDetail).toMatchObject({
      reason: 'guard_violation',
      detail: {
        stage: TEST_ONLY_STAGE,
        message: EXISTING_TEST_CHANGED_MESSAGE,
        changed: [EXISTING],
      },
    });
  }, 120_000);
});
