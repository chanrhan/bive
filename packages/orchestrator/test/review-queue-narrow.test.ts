// 검토 대기열의 예산 초과 액션: 허용 목록 축소 재개 (M3-58 #321, TODO-02 · COST-01 · NFR-01 · NFR-02, ADR-147 ⑥, ADR-155).
// 실제 SQLite · 픽스처 git 복사본 · 실제 엔진(단계 실행기는 시험용, 검사 · 병합은 실제 실행기를 쓰는 시험이 있다) · 실제 실행 처리기.
// - 사람이 준 제외 경로(블록 선언의 포함 경로와 같은 패턴 문법, 1개 이상)와 새 한도(한도 상향 재개와 같은 검증)로 이어받는 실행을 만들고
//   그 실행에만 쓰기 허용 범위(처음 목록 = 대상 블록 포함 경로의 합)를 붙인다. 실행 생성 · 연결 · 값 저장 · 항목 처리는 트랜잭션 1개
// - 그 실행의 구현 세션은 범위 안 경로에만 쓸 수 있다(제외 경로 · 대상 블록 밖 · 링크 · 대소문자 우회 거부, 읽기는 그대로)
// - 경로 가드를 지나지 않는 쓰기는 검사 단계 · 병합 직전의 git 객체 대조가 막는다
// - 사슬: 범위가 붙은 실행의 한도 상향 재개는 같은 범위를 잇고, 다시 좁히기는 제외를 더한다(합집합)
import fs from 'node:fs';
import path from 'node:path';

import {
  type Author,
  type BudgetSnapshot,
  DomainErrorReason,
  ErrorCode,
  type RunWriteScope,
  type SettingsPatch,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentAdapter } from '../src/agent/adapter.js';
import { selectAgent } from '../src/agent/select.js';
import { PipelineEngine } from '../src/engine/pipeline-engine.js';
import { runEnding } from '../src/engine/run-ending.js';
import type { StepExecutor, StepExecutors } from '../src/engine/types.js';
import { createRunHandlers } from '../src/ipc/run-handlers.js';
import { RpcError } from '../src/ipc/server.js';
import { splitTarget, WRITE_SCOPE_ALLOW_EMPTY_MESSAGE } from '../src/review/review-queue.js';
import { reinforceSurvivedMutants } from '../src/runs/auto-start.js';
import { createRun, evaluateApprovalStep } from '../src/runs/run-service.js';
import { createCheckExecutor } from '../src/steps/check.js';
import { createMergeExecutor } from '../src/steps/merge.js';
import { WRITE_SCOPE_STAGE, WRITE_SCOPE_VIOLATION_MESSAGE } from '../src/steps/write-scope.js';
import { WRITE_SCOPE_DENIALS } from '../src/tools/path-guard.js';
import {
  COMPLETE_SETTINGS,
  copyFixture,
  human,
  newId,
  seedProject,
  testExecutors,
  userGit,
  withProject,
} from './helpers/engine-harness.js';
import { cleanup, makeBiveHome } from './helpers/process.js';

const temps: string[] = [];
const engines: PipelineEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}, 60_000);

const agent = { kind: 'agent', role: 'implementer' } as const satisfies Author;
const clock = { now: Date.now, newId };
const at = (): string => new Date().toISOString();
const MUTANT = { path: 'src/app/api/health/route.ts', search: 'time', replace: 'tick' };

/** COMPLETE_SETTINGS의 유형 A 예산 값 (원 실행의 예산 값). */
const ORIGIN_BUDGET: BudgetSnapshot = {
  run: { maxBudgetUsd: 5, maxTurns: 200 },
  roles: {
    'test-writer': { maxBudgetUsd: 2, maxTurns: 100 },
    implementer: { maxBudgetUsd: 2, maxTurns: 100 },
    mutator: { maxBudgetUsd: 1, maxTurns: 50 },
  },
};
/** 원 실행의 테스트 작성 역할 한도(2 USD)가 닿았을 때 올린 새 한도. */
const RAISED: BudgetSnapshot = {
  run: { maxBudgetUsd: 6, maxTurns: 200 },
  roles: { ...ORIGIN_BUDGET.roles, 'test-writer': { maxBudgetUsd: 3, maxTurns: 100 } },
};

const HEALTH_INCLUDE = 'src/app/api/health/**';
/** 픽스처의 블록 선언 (auth · health · lib). 규칙의 대상 블록은 health. */
const DECLARATION = {
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
      include: [HEALTH_INCLUDE],
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
const EXCLUDE = ['src/app/api/health/internal/**'];

interface Harness {
  readonly biveHome: string;
  readonly repo: string;
  readonly projectId: string;
  readonly ruleId: string;
  readonly read: <T>(fn: (store: ProjectStore) => T) => T;
}

interface SetupOptions {
  readonly settings?: SettingsPatch;
  readonly targetBlocks?: readonly string[];
  readonly declaration?: unknown;
}

const setup = (options: SetupOptions = {}): Harness => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const seeded = seedProject(biveHome, repo, options.settings ?? COMPLETE_SETTINGS, 'approved', {
    targetBlocks: [...(options.targetBlocks ?? ['health'])],
  });
  const read = <T>(fn: (store: ProjectStore) => T): T =>
    withProject(biveHome, seeded.project.id, fn);
  const declaration = options.declaration === undefined ? DECLARATION : options.declaration;
  if (declaration !== null) {
    read((store) => store.blockDeclarations.set(declaration, { at: at(), by: human }));
  }
  return { biveHome, repo, projectId: seeded.project.id, ruleId: seeded.rule.id, read };
};

/** 세션 1개를 실행의 테스트 작성 단계에 남긴다 (값을 아는 끝난 세션). */
const recordSession = (store: ProjectStore, runId: string, cost: number, turns: number): void => {
  const step = store.runs.steps(runId).find((item) => item.kind === 'test_writing');
  const id = newId();
  store.sessions.start({
    id,
    runId,
    stepId: step!.id,
    role: 'test-writer',
    model: 'test-model',
    workDir: '/work/session',
    budget: { maxBudgetUsd: cost, maxTurns: turns },
    startedAt: at(),
  });
  store.sessions.end(id, {
    endReason: 'success',
    totalCostUsd: cost,
    numTurns: turns,
    endedAt: at(),
  });
};

/** 사람이 시작한 실행(`runId`를 주면 그 실행)을 테스트 작성 세션 뒤 예산 초과로 끝낸다 (저장만, 워크트리 없이). */
const budgetEnded = (
  store: ProjectStore,
  ruleId: string,
  cost: number,
  turns: number,
  runId?: string,
): string => {
  const id =
    runId ??
    createRun(store, { ruleIds: [ruleId], author: human }, { clientId: null }, clock).run.id;
  evaluateApprovalStep(store, id, clock);
  recordSession(store, id, cost, turns);
  const run = store.runs.get(id)!;
  store.runs.transition(id, {
    expectedStatus: 'running',
    steps: store.runs
      .steps(id)
      .filter((step) => step.status === 'running')
      .map((step) => ({ id: step.id, status: 'failed' as const, endedAt: at() })),
    run: { ...runEnding(run, 'budget_exceeded', 'budget_aggregate_exceeded').run, endedAt: at() },
  });
  return id;
};

const openBudgetItem = (store: ProjectStore, runId: string) => {
  const item = store.reviewQueue
    .list({ kind: 'budget_exceeded', state: 'open' })
    .find((entry) => entry.runId === runId);
  if (item === undefined) throw new Error(`예산 초과 항목 없음: ${runId}`);
  return item;
};

type Handlers = ReturnType<typeof createRunHandlers>;
type NarrowParams = Parameters<NonNullable<Handlers['reviewQueue.resumeNarrowed']>>;
type BudgetParams = Parameters<NonNullable<Handlers['reviewQueue.resumeWithBudget']>>;

const handlersOf = (h: Harness, engine?: PipelineEngine) =>
  createRunHandlers({
    biveHome: h.biveHome,
    now: Date.now,
    ...(engine === undefined ? {} : { engine }),
  });

/** 실제 실행 처리기의 `reviewQueue.resumeNarrowed`. */
const narrow = (h: Harness, params: Omit<NarrowParams[0], 'projectId'>, engine?: PipelineEngine) =>
  handlersOf(h, engine)['reviewQueue.resumeNarrowed']!({ projectId: h.projectId, ...params }, {
    connectionId: 7,
  } as NarrowParams[1]);

/** 실제 실행 처리기의 `reviewQueue.resumeWithBudget`. */
const raise = (h: Harness, params: Omit<BudgetParams[0], 'projectId'>) =>
  handlersOf(h)['reviewQueue.resumeWithBudget']!({ projectId: h.projectId, ...params }, {
    connectionId: 7,
  } as BudgetParams[1]);

const rejection = async (fn: () => unknown): Promise<RpcError> => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error('거부되지 않음');
};

/** 거부 뒤에도 그대로여야 하는 것: 실행 수 · 승인 기록 · 연결 · 범위 행 · 항목 처리. */
const snapshot = (h: Harness, originId: string, seq: number) =>
  h.read((store) => ({
    runs: store.runs.list().length,
    runStarts: store.approvalLog.list().filter((entry) => entry.action === 'run_start').length,
    continuation: store.runContinuations.continuationOf(originId),
    scopes: (store.db.prepare('SELECT count(*) AS n FROM run_write_scopes').get() as { n: number })
      .n,
    resolution: store.reviewQueue.get(seq)?.resolution ?? null,
  }));

/** 변이 보강 실행(자동 연결)이 실패로 끝나 생긴 변이 생존 항목의 순번 (다른 종류의 항목). */
const mutantItem = (store: ProjectStore, ruleId: string): number => {
  const origin = createRun(store, { ruleIds: [ruleId], author: human }, { clientId: null }, clock);
  evaluateApprovalStep(store, origin.run.id, clock);
  store.runs.transition(origin.run.id, {
    expectedStatus: 'running',
    run: { status: 'merged', mergeCommit: 'a'.repeat(40), currentStep: null, endedAt: at() },
  });
  const survived = store.mutations.record({
    id: newId(),
    ruleId,
    runId: origin.run.id,
    stepId: origin.steps.find((step) => step.kind === 'mutation')!.id,
    sessionId: newId(),
    commit: 'b'.repeat(40),
    status: 'survived',
    outcome: 'survived',
    mutant: MUTANT,
    recordedAt: at(),
  });
  const outcome = reinforceSurvivedMutants(store, { runId: survived.runId }, clock);
  if (outcome.status !== 'started') throw new Error(`보강 실행 없음: ${outcome.status}`);
  const runId = outcome.runs[0]!.detail.run.id;
  evaluateApprovalStep(store, runId, clock);
  const run = store.runs.get(runId)!;
  store.runs.transition(runId, {
    expectedStatus: 'running',
    run: { ...runEnding(run, 'failed', 'regression_limit').run, endedAt: at() },
  });
  return store.reviewQueue.list({ kind: 'mutant_survived', state: 'open' })[0]!.seq;
};

describe('허용 목록 축소 재개 = 쓰기 허용 범위가 붙은 이어받는 실행 (M3-58 수용 기준 1 · 3, ADR-147 ⑥)', () => {
  it('한도 상향 재개와 같은 이어받는 실행(사람 · 같은 유형 · 대상 규칙 · 새 한도 = 예산 값 · 연결)을 만들고 그 실행에만 범위(처음 목록 = 대상 블록 포함 경로의 합, 제외 = 받은 값)를 붙이며 항목은 처리됨이다', async () => {
    const h = setup();
    const originId = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    const result = await narrow(h, { seq, budget: RAISED, exclude: EXCLUDE, author: human });
    expect(result.run).toMatchObject({
      type: 'A',
      status: 'waiting_approval',
      targetRuleIds: [h.ruleId],
      startedBy: { kind: 'human' },
      budgetSnapshot: RAISED,
    });
    expect(result.approvalLog).toMatchObject({
      action: 'run_start',
      actor: { kind: 'human' },
      clientId: 'pipe-7',
    });
    expect(result.entry.item.resolution).toEqual({
      action: 'narrow_allowlist_resume',
      by: human,
      at: result.run.createdAt,
      reason: null,
      runId: result.run.id,
    });
    h.read((store) => {
      expect(store.runContinuations.originOf(result.run.id)?.originRunId).toBe(originId);
      expect(store.runWriteScopes.ofRun(result.run.id)).toEqual({
        allow: [HEALTH_INCLUDE],
        exclude: EXCLUDE,
      });
      // 값은 그 실행에만 붙는다 (원 실행 · 다른 실행에는 없다)
      expect(store.runWriteScopes.ofRun(originId)).toBeNull();
      expect(store.runs.get(originId)?.status).toBe('budget_exceeded');
    });
    // 같은 항목을 두 번 처리할 수 없다
    const again = await rejection(() =>
      narrow(h, { seq, budget: RAISED, exclude: EXCLUDE, author: human }),
    );
    expect([again.code, again.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'already_resolved' },
    ]);
    // 같은 항목에서 액션이 갈라지지 않는다: 허용 목록 축소 재개로 처리된 항목은 규칙 분할도 받지 않는다
    const split = await rejection(() => h.read((store) => splitTarget(store, seq, h.ruleId)));
    expect([split.code, split.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'already_resolved' },
    ]);
  }, 60_000);

  it('처음 목록은 대상 규칙들의 대상 블록 포함 경로의 합이다 (선언의 블록 순 · 중복 없음, 대상이 아닌 블록은 들지 않음)', async () => {
    const h = setup({ targetBlocks: ['lib', 'health'] });
    const originId = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    const result = await narrow(h, { seq, budget: RAISED, exclude: EXCLUDE, author: human });
    expect(h.read((store) => store.runWriteScopes.ofRun(result.run.id))).toEqual({
      allow: [HEALTH_INCLUDE, 'src/lib/**'],
      exclude: EXCLUDE,
    });
  }, 60_000);

  it('에이전트 주체(저장소를 열기 전 -32020) · 없는 항목(-32004) · 처리된 항목 · 다른 종류의 항목(-32009) · 설정 미비(-32010)는 거부되고 아무것도 남지 않는다', async () => {
    // 자동 보강(다른 종류의 항목을 만드는 길)은 하루 한도가 있어야 돈다
    const h = setup({ settings: { ...COMPLETE_SETTINGS, dailyBudgetUsd: 10 } });
    const { originId, mutantSeq } = h.read((store) => ({
      originId: budgetEnded(store, h.ruleId, 2, 30),
      mutantSeq: mutantItem(store, h.ruleId),
    }));
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    const before = snapshot(h, originId, seq);
    // 등록되지 않은 프로젝트여도 -32004가 아니라 -32020 (형식이 틀린 제외 경로보다도 먼저)
    const byAgent = await rejection(() =>
      handlersOf(h)['reviewQueue.resumeNarrowed']!(
        { projectId: newId(), seq, budget: RAISED, exclude: [], author: agent },
        { connectionId: 1 } as NarrowParams[1],
      ),
    );
    expect(byAgent.code).toBe(ErrorCode.Unauthorized);
    const missing = await rejection(() =>
      narrow(h, { seq: 999, budget: RAISED, exclude: EXCLUDE, author: human }),
    );
    expect(missing.code).toBe(ErrorCode.NotFound);
    const wrongKind = await rejection(() =>
      narrow(h, { seq: mutantSeq, budget: RAISED, exclude: EXCLUDE, author: human }),
    );
    expect([wrongKind.code, wrongKind.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'action_not_allowed' },
    ]);
    h.read((store) =>
      store.settings.update({ roles: { implementer: { model: null } } }, { by: human, at: at() }),
    );
    const incomplete = await rejection(() =>
      narrow(h, { seq, budget: RAISED, exclude: EXCLUDE, author: human }),
    );
    expect(incomplete.code).toBe(ErrorCode.SettingsIncomplete);
    expect(snapshot(h, originId, seq)).toEqual(before);
    // 처리된 항목 (한도 상향 재개로 처리한 뒤)
    h.read((store) =>
      store.settings.update(
        { roles: { implementer: { model: 'test-model' } } },
        { by: human, at: at() },
      ),
    );
    await raise(h, { seq, budget: RAISED, author: human });
    const resolved = await rejection(() =>
      narrow(h, { seq, budget: RAISED, exclude: EXCLUDE, author: human }),
    );
    expect([resolved.code, resolved.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'already_resolved' },
    ]);
  }, 60_000);

  it('제외 경로가 비면 -32001 WRITE_SCOPE_EXCLUDE_REQUIRED, 형식이 틀리면 각각 -32001 WRITE_SCOPE_EXCLUDE_INVALID(걸린 자리)이고 아무것도 남지 않는다', async () => {
    const h = setup();
    const originId = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    const before = snapshot(h, originId, seq);
    const empty = await rejection(() =>
      narrow(h, { seq, budget: RAISED, exclude: [], author: human }),
    );
    expect([empty.code, empty.data]).toEqual([
      ErrorCode.ValidationFailed,
      { reason: DomainErrorReason.WriteScopeExcludeRequired },
    ]);
    const cases: [string, string[], string[]][] = [
      ['절대 경로', ['/src/a.ts'], ['exclude.0']],
      ['상위 폴더', ['src/../x.ts'], ['exclude.0']],
      ['점 구간', ['./src/a.ts'], ['exclude.0']],
      ['빈 값', [''], ['exclude.0']],
      ['빈 구간', ['src//a.ts'], ['exclude.0']],
      ['끝의 /', ['src/'], ['exclude.0']],
      ['숨은 글자', [`src/a${String.fromCodePoint(0x202e)}.ts`], ['exclude.0']],
      ['폭 없는 글자', [`src/a${String.fromCodePoint(0x200b)}.ts`], ['exclude.0']],
      ['공백', ['src/a b.ts'], ['exclude.0']],
      ['역슬래시', ['src\\a.ts'], ['exclude.0']],
      ['매처가 받지 않는 문법(구간 안의 **)', ['src/**.ts'], ['exclude.0']],
      ['매처가 받지 않는 문법(잇달은 **)', ['src/**/**'], ['exclude.0']],
      ['매처가 받지 않는 글자({ } ?)', ['src/{a,b}.ts', 'src/a?.ts'], ['exclude.0', 'exclude.1']],
      ['길이 상한(200자)', [`src/${'a'.repeat(197)}`], ['exclude.0']],
      ['중복', ['src/a.ts', 'src/b.ts', 'src/a.ts'], ['exclude.2']],
      [
        '개수 상한(20개)',
        Array.from({ length: 21 }, (_, i) => `src/f${String(i)}.ts`),
        ['exclude'],
      ],
    ];
    for (const [name, exclude, fields] of cases) {
      const rejected = await rejection(() =>
        narrow(h, { seq, budget: RAISED, exclude, author: human }),
      );
      expect([rejected.code, rejected.data], name).toEqual([
        ErrorCode.ValidationFailed,
        { reason: DomainErrorReason.WriteScopeExcludeInvalid, fields },
      ]);
    }
    // 경계: 200자 · 20개는 받는다 (형식 검사만, 실제로 만들지는 않는다: 다른 이유로 막는다)
    h.read((store) =>
      store.db.exec(`CREATE TRIGGER test_block_runs BEFORE INSERT ON runs
        BEGIN SELECT RAISE(ABORT, '시험이 막은 실행'); END;`),
    );
    for (const exclude of [
      [`src/${'a'.repeat(196)}`],
      Array.from({ length: 20 }, (_, i) => `src/f${String(i)}.ts`),
    ]) {
      await expect(async () =>
        narrow(h, { seq, budget: RAISED, exclude, author: human }),
      ).rejects.toThrow(/시험이 막은 실행/);
    }
    h.read((store) => store.db.exec('DROP TRIGGER test_block_runs'));
    expect(snapshot(h, originId, seq)).toEqual(before);
  }, 60_000);

  it('처음 목록이 비면(대상 블록이 없는 규칙뿐 · 블록 선언 없음 · 선언에 없는 블록 이름뿐) 고정 사유의 -32001 WRITE_SCOPE_ALLOW_EMPTY이고 아무것도 남지 않는다', async () => {
    for (const options of [
      { targetBlocks: [] },
      { declaration: null },
      { targetBlocks: ['payments'] },
    ] satisfies SetupOptions[]) {
      const h = setup(options);
      const originId = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
      const seq = h.read((store) => openBudgetItem(store, originId).seq);
      const before = snapshot(h, originId, seq);
      const rejected = await rejection(() =>
        narrow(h, { seq, budget: RAISED, exclude: EXCLUDE, author: human }),
      );
      expect([rejected.code, rejected.message, rejected.data]).toEqual([
        ErrorCode.ValidationFailed,
        WRITE_SCOPE_ALLOW_EMPTY_MESSAGE,
        { reason: DomainErrorReason.WriteScopeAllowEmpty },
      ]);
      expect(snapshot(h, originId, seq)).toEqual(before);
    }
  }, 60_000);

  it('새 한도는 한도 상향 재개와 같은 검증이다: BUDGET_SHAPE_MISMATCH · BUDGET_LOWERED · BUDGET_NOT_ABOVE_SPENT (모두 -32001, 아무것도 남지 않음)', async () => {
    const h = setup();
    const originId = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    const before = snapshot(h, originId, seq);
    const withoutMutator = Object.fromEntries(
      Object.entries(RAISED.roles).filter(([role]) => role !== 'mutator'),
    );
    const cases: [BudgetSnapshot, string, string[]][] = [
      [
        { ...RAISED, roles: withoutMutator },
        DomainErrorReason.BudgetShapeMismatch,
        ['roles.mutator'],
      ],
      [
        { ...RAISED, run: { maxBudgetUsd: 4.99, maxTurns: 200 } },
        DomainErrorReason.BudgetLowered,
        ['run.maxBudgetUsd'],
      ],
      [ORIGIN_BUDGET, DomainErrorReason.BudgetNotAboveSpent, ['roles.test-writer.maxBudgetUsd']],
    ];
    for (const [budget, reason, fields] of cases) {
      const rejected = await rejection(() =>
        narrow(h, { seq, budget, exclude: EXCLUDE, author: human }),
      );
      expect([rejected.code, rejected.data], reason).toEqual([
        ErrorCode.ValidationFailed,
        { reason, fields },
      ]);
    }
    expect(snapshot(h, originId, seq)).toEqual(before);
  }, 60_000);

  it('실행을 만든 뒤 범위 저장 · 항목 처리가 실패하면 실행 · 승인 기록 · 연결 · 범위 · 처리 어느 것도 남지 않는다 (트랜잭션 1개)', async () => {
    const h = setup();
    const originId = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    const before = snapshot(h, originId, seq);
    // 시험에서만: 범위 넣기를 실패시킨다 (실행 생성 · 연결 뒤의 실패)
    h.read((store) =>
      store.db.exec(`CREATE TRIGGER test_fail_scope BEFORE INSERT ON run_write_scopes
        BEGIN SELECT RAISE(ABORT, '시험이 넣은 범위 실패'); END;`),
    );
    await expect(async () =>
      narrow(h, { seq, budget: RAISED, exclude: EXCLUDE, author: human }),
    ).rejects.toThrow(/범위 실패/);
    expect(snapshot(h, originId, seq)).toEqual(before);
    // 처리 쓰기가 실패해도 같다 (범위 저장 뒤의 실패)
    h.read((store) =>
      store.db.exec(`DROP TRIGGER test_fail_scope;
        CREATE TRIGGER test_fail_resolve BEFORE UPDATE ON review_items
        BEGIN SELECT RAISE(ABORT, '시험이 넣은 처리 실패'); END;`),
    );
    await expect(async () =>
      narrow(h, { seq, budget: RAISED, exclude: EXCLUDE, author: human }),
    ).rejects.toThrow(/처리 실패/);
    expect(snapshot(h, originId, seq)).toEqual(before);
  }, 60_000);
});

describe('사슬에서의 물려받기 (ADR-155)', () => {
  it('범위가 붙은 실행 → 한도 상향 재개는 같은 범위를 잇고(선언이 바뀌어도 다시 읽지 않음), 다시 좁히기는 제외를 더한다(합집합, 허용은 그대로). 범위 없는 실행의 한도 상향 재개는 범위가 없다', async () => {
    const h = setup();
    const originId = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
    const first = await narrow(h, {
      seq: h.read((store) => openBudgetItem(store, originId).seq),
      budget: RAISED,
      exclude: EXCLUDE,
      author: human,
    });
    const scopeOf = (runId: string): RunWriteScope | null =>
      h.read((store) => store.runWriteScopes.ofRun(runId));
    const firstScope = scopeOf(first.run.id);
    // 그 사이 블록 선언이 넓어진다 (health 블록에 경로를 더함)
    h.read((store) =>
      store.blockDeclarations.set(
        {
          blocks: DECLARATION.blocks.map((block) =>
            block.name === 'health' ? { ...block, include: [...block.include, 'src/**'] } : block,
          ),
        },
        { at: at(), by: human },
      ),
    );
    h.read((store) => budgetEnded(store, h.ruleId, 0.1, 1, first.run.id));
    const second = await raise(h, {
      seq: h.read((store) => openBudgetItem(store, first.run.id).seq),
      budget: RAISED,
      author: human,
    });
    expect(second.entry.item.resolution?.action).toBe('raise_limit_resume');
    expect(scopeOf(second.run.id)).toEqual(firstScope);
    h.read((store) => budgetEnded(store, h.ruleId, 0.1, 1, second.run.id));
    const third = await narrow(h, {
      seq: h.read((store) => openBudgetItem(store, second.run.id).seq),
      budget: RAISED,
      exclude: ['src/app/api/health/route.ts', ...EXCLUDE],
      author: human,
    });
    expect(scopeOf(third.run.id)).toEqual({
      allow: [HEALTH_INCLUDE],
      exclude: [...EXCLUDE, 'src/app/api/health/route.ts'],
    });
    // 범위 없는 실행의 한도 상향 재개에는 범위가 없다
    const plainOrigin = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
    const plain = await raise(h, {
      seq: h.read((store) => openBudgetItem(store, plainOrigin).seq),
      budget: RAISED,
      author: human,
    });
    expect(scopeOf(plain.run.id)).toBeNull();
  }, 60_000);

  it('다시 좁히기의 제외 합이 실행의 상한(100개)을 넘으면 -32001 WRITE_SCOPE_EXCLUDE_INVALID이고 아무것도 남지 않는다', async () => {
    const h = setup();
    const originId = h.read((store) => budgetEnded(store, h.ruleId, 2, 30));
    // 시험에서만: 제외 95개가 붙은 이어받는 실행을 저장소로 직접 만든다
    const scopedId = h.read((store) => {
      const next = createRun(
        store,
        { ruleIds: [h.ruleId], author: human },
        { clientId: null },
        clock,
      );
      store.runContinuations.link({ runId: next.run.id, originRunId: originId, createdAt: at() });
      store.runWriteScopes.record({
        runId: next.run.id,
        scope: {
          allow: [HEALTH_INCLUDE],
          exclude: Array.from({ length: 95 }, (_, i) => `src/app/api/health/x${String(i)}.ts`),
        },
        createdAt: at(),
      });
      return budgetEnded(store, h.ruleId, 0.1, 1, next.run.id);
    });
    const seq = h.read((store) => openBudgetItem(store, scopedId).seq);
    const before = snapshot(h, scopedId, seq);
    const rejected = await rejection(() =>
      narrow(h, {
        seq,
        budget: RAISED,
        exclude: Array.from({ length: 6 }, (_, i) => `src/app/api/health/y${String(i)}.ts`),
        author: human,
      }),
    );
    expect([rejected.code, rejected.data]).toEqual([
      ErrorCode.ValidationFailed,
      { reason: DomainErrorReason.WriteScopeExcludeInvalid, fields: ['exclude'] },
    ]);
    expect(snapshot(h, scopedId, seq)).toEqual(before);
    // 합이 100개면 받는다 (이미 있는 값은 한 번만 센다)
    const ok = await narrow(h, {
      seq,
      budget: RAISED,
      exclude: [
        'src/app/api/health/x0.ts',
        ...Array.from({ length: 5 }, (_, i) => `src/app/api/health/y${String(i)}.ts`),
      ],
      author: human,
    });
    expect(h.read((store) => store.runWriteScopes.ofRun(ok.run.id)?.exclude.length)).toBe(100);
  }, 60_000);
});

// ── 엔진: 구현 세션의 경로 가드 · 병합 전 대조 ────────────────────────────────────

/** 구현 세션이 시도할 쓰기 (실행 워크트리 기준). */
const PROBES = [
  'src/app/api/health/extra.ts',
  'src/app/api/health/new-dir/deep.ts',
  'src/app/api/health/internal/keep.ts',
  'src/app/api/health/internal/new.ts',
  'src/app/api/health/INTERNAL/case.ts',
  'src/app/api/health/to-internal/keep.ts',
  'src/app/api/health/to-lib/x.ts',
  'src/lib/db.ts',
  'src/lib/new.ts',
  'package.json',
] as const;

interface ProbeResult {
  readonly path: string;
  readonly status: string;
  readonly content: string;
}

/** 구현 세션이 열리면 첫 이벤트 뒤에 쓰기 · 읽기를 시도해 결과를 실행별로 모으는 시험 어댑터 (나머지는 기본 대본). */
const probingAgent = (
  biveHome: string,
  results: Map<string, { writes: ProbeResult[]; reads: string[] }>,
): AgentAdapter => {
  const inner = selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome }).adapter;
  return {
    kind: inner.kind,
    startSession: (spec) =>
      (async function* () {
        let probed = spec.role !== 'implementer';
        for await (const event of inner.startSession(spec)) {
          yield event;
          if (probed) continue;
          probed = true;
          const writes: ProbeResult[] = [];
          for (const target of PROBES) {
            const result = await spec.tools.execute('write_file', {
              path: target,
              content: 'PROBE\n',
            });
            writes.push({ path: target, status: result.status, content: result.content });
          }
          const reads: string[] = [];
          for (const target of ['src/lib/db.ts', 'src/app/api/health/internal/keep.ts']) {
            reads.push((await spec.tools.execute('read_file', { path: target })).status);
          }
          results.set(spec.runId ?? '', { writes, reads });
        }
      })(),
  };
};

/** 시험 저장소에 링크 둘과 제외 폴더의 파일을 커밋한다 (허용 범위 안의 링크가 제외 폴더 · 블록 밖을 가리킨다). */
const commitLinks = (repo: string): void => {
  const dir = path.join(repo, 'src', 'app', 'api', 'health');
  fs.mkdirSync(path.join(dir, 'internal'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'internal', 'keep.ts'), 'export const keep = 1;\n');
  fs.symlinkSync('internal', path.join(dir, 'to-internal'), 'dir');
  fs.symlinkSync('../../../lib', path.join(dir, 'to-lib'), 'dir');
  userGit(repo, 'add', '-A');
  userGit(repo, 'commit', '-q', '-m', '링크');
};

/** 구현 단계에서 멈춘 원 실행(엔진으로 돌림)과 그 열린 예산 초과 항목. */
const originStoppedAtImplementation = async (
  h: Harness,
  engine: PipelineEngine,
  onCreated: (originId: string) => void,
) => {
  const originId = h.read(
    (store) =>
      createRun(store, { ruleIds: [h.ruleId], author: human }, { clientId: null }, clock).run.id,
  );
  onCreated(originId);
  engine.evaluateApproval(h.projectId, originId);
  await engine.settled();
  const origin = h.read((store) => store.runs.get(originId)!);
  expect(origin).toMatchObject({ status: 'budget_exceeded', currentStep: 'implementation' });
  return { originId, seq: h.read((store) => openBudgetItem(store, originId).seq) };
};

const budgetHalt: StepExecutor = () =>
  Promise.resolve({ status: 'halt', runStatus: 'budget_exceeded', reason: 'error_max_budget_usd' });

describe('쓰기 허용 범위가 붙은 실행의 구현 세션 (M3-58 수용 기준 2, NFR-02)', () => {
  it('범위 안 경로만 쓰고 제외 경로 · 대상 블록 밖 · 링크를 거친 제외 경로 · 블록 밖 · 대소문자만 다른 제외 경로는 고정 사유로 거부된다. 읽기는 그대로이고, 범위가 없는 원 실행의 가드는 그대로다', async () => {
    const h = setup();
    commitLinks(h.repo);
    const results = new Map<string, { writes: ProbeResult[]; reads: string[] }>();
    let originId = '';
    const implementation: StepExecutor = async (context) => {
      await context.runSession({
        workDir: context.git.worktreePath,
        systemPrompt: '시험',
        prompt: '시험',
        vars: { ruleId: 'RULE-001' },
      });
      return context.run.id === originId
        ? budgetHalt(context)
        : { status: 'halt', runStatus: 'failed', reason: 'step_unmet' };
    };
    const engine = new PipelineEngine({
      biveHome: h.biveHome,
      agent: probingAgent(h.biveHome, results),
      executors: testExecutors({ implementation }),
    });
    engines.push(engine);
    const origin = await originStoppedAtImplementation(h, engine, (id) => {
      originId = id;
    });
    const result = await narrow(
      h,
      { seq: origin.seq, budget: RAISED, exclude: EXCLUDE, author: human },
      engine,
    );
    await engine.settled();
    const scoped = results.get(result.run.id)!;
    const statusOf = (writes: ProbeResult[]) =>
      Object.fromEntries(writes.map((write) => [write.path, write.content]));
    const ok = '';
    const excluded = `거부됨: ${WRITE_SCOPE_DENIALS.excluded}`;
    const outside = `거부됨: ${WRITE_SCOPE_DENIALS.outside}`;
    expect(
      Object.fromEntries(
        scoped.writes.map((write) => [write.path, write.status === 'ok' ? ok : write.content]),
      ),
    ).toEqual({
      'src/app/api/health/extra.ts': ok,
      'src/app/api/health/new-dir/deep.ts': ok,
      'src/app/api/health/internal/keep.ts': excluded,
      'src/app/api/health/internal/new.ts': excluded,
      'src/app/api/health/INTERNAL/case.ts': excluded,
      'src/app/api/health/to-internal/keep.ts': excluded,
      'src/app/api/health/to-lib/x.ts': outside,
      'src/lib/db.ts': outside,
      'src/lib/new.ts': outside,
      'package.json': outside,
    });
    expect(scoped.reads).toEqual(['ok', 'ok']);
    // 이어받는 실행의 워크트리에서 거부된 파일은 바뀌지 않았다
    const worktree = h.read((store) => store.runs.get(result.run.id)!.worktreePath!);
    expect(
      fs.readFileSync(path.join(worktree, 'src/app/api/health/internal/keep.ts'), 'utf8'),
    ).toBe('export const keep = 1;\n');
    expect(fs.existsSync(path.join(worktree, 'src/lib/new.ts'))).toBe(false);
    // 범위가 없는 원 실행의 구현 세션은 같은 경로를 모두 썼다 (가드 동작 그대로)
    expect(results.get(originId)!.writes.every((write) => write.status === 'ok')).toBe(true);
    expect(statusOf(results.get(originId)!.writes)['package.json']).not.toContain('거부됨');
  }, 120_000);
});

describe('병합 전 대조: 경로 가드를 지나지 않은 범위 밖 변경 (ADR-155)', () => {
  /** 구현 단계: 실행 워크트리에 직접 파일을 쓰고(명령 도구가 실행한 코드 · 도구가 바꾼 파일의 대역) 통과한다. 원 실행은 예산 초과. */
  const directWrites =
    (originOf: () => string, files: readonly string[]): StepExecutor =>
    (context) => {
      if (context.run.id === originOf()) return budgetHalt(context);
      for (const file of files) {
        const target = path.join(context.git.worktreePath, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'export const GET = () => new Date().toISOString();\n');
      }
      return Promise.resolve({ status: 'passed' });
    };

  const runScoped = async (overrides: (originOf: () => string) => StepExecutors) => {
    const h = setup();
    let originId = '';
    const engine = new PipelineEngine({
      biveHome: h.biveHome,
      agent: selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome: h.biveHome }).adapter,
      executors: testExecutors(overrides(() => originId)),
    });
    engines.push(engine);
    const origin = await originStoppedAtImplementation(h, engine, (id) => {
      originId = id;
    });
    const result = await narrow(
      h,
      { seq: origin.seq, budget: RAISED, exclude: EXCLUDE, author: human },
      engine,
    );
    await engine.settled();
    return h.read((store) => store.runs.getDetail(result.run.id)!);
  };

  it('검사 단계: 구현 커밋에 범위 밖 파일(블록 밖 · 제외 경로)이 있으면 판정 전에 guard_violation(write_scope)으로 멈춘다', async () => {
    const detail = await runScoped((originOf) => ({
      implementation: directWrites(originOf, [
        'src/app/api/health/route.ts',
        'src/lib/outside.ts',
        'src/app/api/health/internal/x.ts',
      ]),
      check: createCheckExecutor(),
    }));
    expect(detail.run).toMatchObject({ status: 'failed', failureReason: 'guard_violation' });
    expect(detail.steps.find((step) => step.kind === 'check')?.exitDetail).toEqual({
      reason: 'guard_violation',
      detail: {
        commit: detail.run.headCommit,
        stage: WRITE_SCOPE_STAGE,
        message: WRITE_SCOPE_VIOLATION_MESSAGE,
        changed: ['src/app/api/health/internal/x.ts', 'src/lib/outside.ts'],
      },
    });
  }, 120_000);

  it('검사 단계: 범위 안 변경만이면 대조를 지나 다음 확인으로 간다 (이 시험의 Red 확인 대역에는 해시가 없어 state_inconsistent)', async () => {
    const detail = await runScoped((originOf) => ({
      implementation: directWrites(originOf, ['src/app/api/health/route.ts']),
      check: createCheckExecutor(),
    }));
    expect(detail.run).toMatchObject({ status: 'failed', failureReason: 'state_inconsistent' });
  }, 120_000);

  it('병합 직전: 검사를 지난 커밋이어도 범위 밖 파일이 있으면 병합하지 않고 guard_violation(write_scope)으로 멈춘다', async () => {
    const detail = await runScoped((originOf) => ({
      implementation: directWrites(originOf, ['src/app/api/health/route.ts', 'package.json']),
      mutation: () => Promise.resolve({ status: 'skipped' }),
      merge: createMergeExecutor(),
    }));
    expect(detail.run).toMatchObject({
      status: 'failed',
      failureReason: 'guard_violation',
      mergeCommit: null,
    });
    expect(detail.steps.find((step) => step.kind === 'merge')?.exitDetail).toEqual({
      reason: 'guard_violation',
      detail: {
        stage: WRITE_SCOPE_STAGE,
        message: WRITE_SCOPE_VIOLATION_MESSAGE,
        changed: ['package.json'],
        headCommit: detail.run.headCommit,
      },
    });
  }, 120_000);

  it('대조의 기준은 이 실행의 시작 커밋이다: 범위가 없던 원 실행이 이미 커밋한 범위 밖 변경은 대조하지 않는다 (검사에서 멈춘 원 실행을 이음)', async () => {
    const h = setup();
    let originId = '';
    const engine = new PipelineEngine({
      biveHome: h.biveHome,
      agent: selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome: h.biveHome }).adapter,
      executors: testExecutors({
        // 원 실행(범위 없음)의 구현이 블록 밖 파일을 커밋한다
        implementation: (context) =>
          directWrites(() => '', ['src/app/api/health/route.ts', 'src/lib/origin.ts'])(context),
        check: (context) =>
          context.run.id === originId ? budgetHalt(context) : createCheckExecutor()(context),
      }),
    });
    engines.push(engine);
    originId = h.read(
      (store) =>
        createRun(store, { ruleIds: [h.ruleId], author: human }, { clientId: null }, clock).run.id,
    );
    engine.evaluateApproval(h.projectId, originId);
    await engine.settled();
    const origin = h.read((store) => store.runs.get(originId)!);
    expect(origin).toMatchObject({ status: 'budget_exceeded', currentStep: 'check' });
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    const result = await narrow(
      h,
      { seq, budget: RAISED, exclude: EXCLUDE, author: human },
      engine,
    );
    await engine.settled();
    const detail = h.read((store) => store.runs.getDetail(result.run.id)!);
    // 이어받는 실행은 검사부터 돌고(구현은 이어받음), 원 실행의 커밋에 든 src/lib/origin.ts로 멈추지 않는다
    expect(detail.run.headCommit).toBe(origin.headCommit);
    expect(detail.run).toMatchObject({ status: 'failed', failureReason: 'state_inconsistent' });
  }, 120_000);

  it('대상 규칙의 인수 테스트 폴더(테스트 작성 세션의 산출)는 대조에서 빠진다: 테스트 작성부터 다시 도는 이어받는 실행', async () => {
    const h = setup();
    let originId = '';
    const testWritingHalt: StepExecutor = async (context) => {
      if (context.run.id !== originId) {
        const dir = path.join(context.git.worktreePath, 'bive-acceptance', 'RULE-001');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'health.acc.ts'), '// 인수 테스트\n');
        return { status: 'passed' };
      }
      return budgetHalt(context);
    };
    const engine = new PipelineEngine({
      biveHome: h.biveHome,
      agent: selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome: h.biveHome }).adapter,
      executors: testExecutors({
        test_writing: testWritingHalt,
        implementation: directWrites(() => originId, ['src/app/api/health/route.ts']),
        check: createCheckExecutor(),
      }),
    });
    engines.push(engine);
    originId = h.read(
      (store) =>
        createRun(store, { ruleIds: [h.ruleId], author: human }, { clientId: null }, clock).run.id,
    );
    engine.evaluateApproval(h.projectId, originId);
    await engine.settled();
    expect(h.read((store) => store.runs.get(originId)?.currentStep)).toBe('test_writing');
    const seq = h.read((store) => openBudgetItem(store, originId).seq);
    const result = await narrow(
      h,
      { seq, budget: RAISED, exclude: EXCLUDE, author: human },
      engine,
    );
    await engine.settled();
    const detail = h.read((store) => store.runs.getDetail(result.run.id)!);
    // 인수 테스트 폴더 변경은 범위 밖이어도 대조에 걸리지 않고 다음 확인(Red 해시 없음)으로 간다
    expect(detail.run).toMatchObject({ status: 'failed', failureReason: 'state_inconsistent' });
    expect(
      userGit(h.repo, 'diff', '--name-only', detail.run.baseCommit!, detail.run.headCommit!)
        .split('\n')
        .sort(),
    ).toEqual(['bive-acceptance/RULE-001/health.acc.ts', 'src/app/api/health/route.ts']);
  }, 120_000);
});
