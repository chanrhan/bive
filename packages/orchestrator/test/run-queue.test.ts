// 프로젝트당 동시 실행 1개 · 실행 대기 (M7-06 #218, RUN-01 · RUN-08, ADR-100 B⑥ · A13, ADR-105).
// 픽스처 git 복사본 · 실제 git(워크트리 · 커밋 · 병합) · 실제 SQLite · 실제 엔진. 단계 실행기는 시험용이다: 테스트 작성은
// 실행마다 문(gate)이 열릴 때까지 기다린 뒤 실행별 파일 하나를 쓰고, 병합은 실제 git 병합이다(앞 실행의 병합 결과 위에서
// 뒤 실행이 도는지 본다). 저장마다(`run.saved`) 같은 프로젝트의 `running`이 2건이 되지 않는지 DB에서 센다.
// 실행은 제품과 같은 길로 만든다: `createRun`(사람의 실행 시작 확인 + 승인 기록 `run_start`) → `engine.onRunCreated`.
import fs from 'node:fs';
import path from 'node:path';

import { ErrorCode, type RunStatus } from '@bive/shared';
import type { ProjectStore, RunDetail } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentAdapter } from '../src/agent/adapter.js';
import { loadScenario } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import { PipelineEngine, RESUME_UNRECOVERABLE } from '../src/engine/pipeline-engine.js';
import type { StepExecutor, StepExecutors, StepOutcome } from '../src/engine/types.js';
import { RpcError } from '../src/ipc/server.js';
import { selectAgent } from '../src/agent/select.js';
import { startOrchestrator } from '../src/orchestrator.js';
import {
  createRun,
  evaluateApprovalStep,
  QUEUED_TARGET_UNAVAILABLE,
} from '../src/runs/run-service.js';
import { verificationSummary } from '../src/verification/summary.js';
import {
  copyFixture,
  human,
  mergeStep,
  newId,
  seedProject,
  type SeededProject,
  userGit,
  withProject,
} from './helpers/engine-harness.js';
import { makeBiveHome, waitFor } from './helpers/process.js';

const temps: string[] = [];
const engines: PipelineEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 실행 표시 ID별 문. `open`하면 그 실행의 테스트 작성이 끝난다. */
class Gates {
  readonly #waiting = new Map<string, () => void>();
  readonly #opened = new Set<string>();

  wait(displayId: string, signal: AbortSignal): Promise<void> {
    if (this.#opened.has(displayId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#waiting.set(displayId, resolve);
      signal.addEventListener(
        'abort',
        () => {
          // 중단된 구동은 더 기다리지 않는다 (재개 뒤의 새 구동이 다시 기다린다)
          this.#waiting.delete(displayId);
          reject(signal.reason as Error);
        },
        { once: true },
      );
    });
  }

  open(displayId: string): void {
    this.#opened.add(displayId);
    this.#waiting.get(displayId)?.();
  }

  /** 지금 문 앞에서 기다리는 실행 */
  get waiting(): string[] {
    return [...this.#waiting.keys()].filter((id) => !this.#opened.has(id));
  }
}

/** 테스트 작성(문을 기다린 뒤 실행별 파일 1개) · 나머지 통과 · 실제 병합. `halt`로 특정 실행을 끝낼 수 있다. */
const gatedExecutors = (
  gates: Gates,
  halts: Map<string, Extract<StepOutcome, { status: 'halt' }>> = new Map(),
): StepExecutors => {
  const testWriting: StepExecutor = async (context) => {
    await gates.wait(context.run.displayId, context.signal);
    const halt = halts.get(context.run.displayId);
    if (halt !== undefined) return halt;
    fs.writeFileSync(
      path.join(context.git.worktreePath, `queue-${context.run.displayId}.txt`),
      'x',
    );
    return { status: 'passed' };
  };
  const pass: StepExecutor = () => Promise.resolve({ status: 'passed' });
  return {
    test_writing: testWriting,
    red_check: pass,
    implementation: pass,
    check: pass,
    merge: mergeStep,
  };
};

interface QueueHarness extends SeededProject {
  biveHome: string;
  repo: string;
  gates: Gates;
  halts: Map<string, Extract<StepOutcome, { status: 'halt' }>>;
  adapter: AgentAdapter;
  /** 저장마다 (표시 ID, 상태) */
  saves: string[];
  /** 저장 알림 때 DB에서 센 `running` 수의 최댓값 */
  maxRunning: number;
  engine: PipelineEngine;
  newEngine(onSaved?: (detail: RunDetail) => void): PipelineEngine;
}

const runningCount = (store: ProjectStore): number => store.runs.list({ status: 'running' }).length;

const setup = (biveHome = makeBiveHome()): QueueHarness => {
  const repo = copyFixture(temps);
  const seeded = seedProject(biveHome, repo);
  const adapter = new ScriptedAdapter({
    scenario: loadScenario('happy-path'),
    biveHome,
    pollIntervalMs: 20,
  });
  const gates = new Gates();
  const halts = new Map<string, Extract<StepOutcome, { status: 'halt' }>>();
  const h = {
    ...seeded,
    biveHome,
    repo,
    gates,
    halts,
    adapter,
    saves: [] as string[],
    maxRunning: 0,
  } as Omit<QueueHarness, 'engine' | 'newEngine'> as QueueHarness;
  h.newEngine = (onSaved) => {
    const engine = new PipelineEngine({
      biveHome,
      agent: adapter,
      executors: gatedExecutors(gates, halts),
      onEvent: (event) => {
        if (event.type !== 'run.saved' || event.projectId !== seeded.project.id) return;
        h.saves.push(`${event.detail.run.displayId}:${event.detail.run.status}`);
        h.maxRunning = Math.max(
          h.maxRunning,
          withProject(biveHome, seeded.project.id, runningCount),
        );
        onSaved?.(event.detail);
      },
    });
    engines.push(engine);
    return engine;
  };
  h.engine = h.newEngine();
  return h;
};

/** 사람의 [실행]과 같은 길: 실행 시작 확인 저장(+ `run_start`) → 엔진의 생성 뒤 처리. 표시 ID를 돌려준다. */
const startRun = (h: QueueHarness, engine = h.engine, ruleId = h.rule.id): string => {
  const created = withProject(h.biveHome, h.project.id, (store) =>
    createRun(
      store,
      { ruleIds: [ruleId], author: human },
      { clientId: null },
      { now: Date.now, newId },
    ),
  );
  engine.onRunCreated(h.project.id, created.run.id);
  return created.run.displayId;
};

const detailOf = (h: QueueHarness, displayId: string): RunDetail =>
  withProject(h.biveHome, h.project.id, (store) => {
    const detail = store.runs.getDetailByDisplayId(displayId);
    if (detail === null) throw new Error(`실행 없음: ${displayId}`);
    return detail;
  });

const statusOf = (h: QueueHarness, displayId: string): RunStatus =>
  detailOf(h, displayId).run.status;

const statuses = (h: QueueHarness): Record<string, RunStatus> =>
  withProject(h.biveHome, h.project.id, (store) =>
    Object.fromEntries(store.runs.list().map((run) => [run.displayId, run.status])),
  );

const attempts = (detail: RunDetail): string[] =>
  detail.steps.map((step) => `${step.kind}#${String(step.attempt)}:${step.status}`);

/** 표시 ID의 첫 `running` 저장 순서. */
const startOrder = (h: QueueHarness): string[] =>
  [
    ...new Set(
      h.saves.filter((save) => save.endsWith(':running')).map((save) => save.split(':')[0]),
    ),
  ].filter((id): id is string => id !== undefined);

const waitGate = (h: QueueHarness, displayId: string): Promise<void> =>
  waitFor(() => h.gates.waiting.includes(displayId), 20_000, `${displayId} 테스트 작성 대기`);

/** 다 기다리는 실행 대기 (승인 단계만 통과, 나머지 대기, 워크트리 · 브랜치 · 기준 커밋 · 시작 시각 없음). */
const QUEUED_STEPS = [
  'approval#1:passed',
  'test_writing#1:pending',
  'red_check#1:pending',
  'implementation#1:pending',
  'check#1:pending',
  'mutation#1:pending',
  'merge#1:pending',
  'screen_update#1:pending',
];

describe('실행 대기: 진행 중인 실행이 있으면 새 실행은 대기, 앞 실행이 끝나면 생성 순으로 시작 (수용 기준 1)', () => {
  it('EXE-001 진행 중에 만든 EXE-002 · EXE-003은 실행 대기로 저장되고, 하나씩 생성 순으로 시작해 앞 실행의 병합 위에서 돈다', async () => {
    const h = setup();
    const base = userGit(h.repo, 'rev-parse', 'refs/heads/main');
    const first = startRun(h);
    await waitGate(h, first);
    const second = startRun(h);
    const third = startRun(h);
    await waitFor(
      () => statusOf(h, second) === 'queued' && statusOf(h, third) === 'queued',
      10_000,
      '실행 대기 저장',
    );
    expect(statuses(h)).toEqual({ [first]: 'running', [second]: 'queued', [third]: 'queued' });

    // 실행 대기는 승인 단계만 통과한 상태: 다음 단계는 시작하지 않았고 워크트리 · 브랜치 · 기준 커밋 · 시작 시각이 없다.
    // 사람의 실행 시작 확인(승인 기록 run_start)은 생성 때 1건씩 남았다
    for (const id of [second, third]) {
      const detail = detailOf(h, id);
      expect(attempts(detail)).toEqual(QUEUED_STEPS);
      expect(detail.run).toMatchObject({
        status: 'queued',
        currentStep: 'test_writing',
        lastCompletedStep: 'approval',
        branch: null,
        worktreePath: null,
        baseCommit: null,
        startedAt: null,
        endedAt: null,
      });
      const runStarts = withProject(h.biveHome, h.project.id, (store) =>
        store.approvalLog
          .list({ entity: 'Run', id: detail.run.id })
          .filter((entry) => entry.action === 'run_start'),
      );
      expect(runStarts).toHaveLength(1);
    }
    expect(h.engine.activeRunIds).toEqual([detailOf(h, first).run.id]);

    // 앞 실행이 병합으로 끝나면 생성 순으로 EXE-002가 시작한다(EXE-003은 그대로 대기)
    h.gates.open(first);
    await waitGate(h, second);
    const firstDone = detailOf(h, first);
    expect(firstDone.run.status).toBe('merged');
    expect(statuses(h)).toEqual({ [first]: 'merged', [second]: 'running', [third]: 'queued' });
    const secondRunning = detailOf(h, second);
    // 기준 커밋은 시작 때 정해진다: 앞 실행의 병합 커밋 위(생성 때의 기준 브랜치 끝이 아니다)
    expect(secondRunning.run.baseCommit).toBe(firstDone.run.mergeCommit);
    expect(secondRunning.run.baseCommit).not.toBe(base);
    expect(secondRunning.run.branch).toBe(`bive/run-${second}`);
    expect(Date.parse(String(secondRunning.run.startedAt))).toBeGreaterThanOrEqual(
      Date.parse(String(firstDone.run.endedAt)),
    );

    h.gates.open(second);
    await waitGate(h, third);
    h.gates.open(third);
    await h.engine.settled();
    expect(statuses(h)).toEqual({ [first]: 'merged', [second]: 'merged', [third]: 'merged' });
    expect(startOrder(h)).toEqual([first, second, third]);
    expect(detailOf(h, third).run.baseCommit).toBe(detailOf(h, second).run.mergeCommit);
    // 병합 커밋은 차례대로 쌓였다
    expect(userGit(h.repo, 'rev-parse', 'refs/heads/main')).toBe(
      detailOf(h, third).run.mergeCommit,
    );
    expect(h.maxRunning).toBe(1);
  }, 120_000);

  it.each([
    ['merged', undefined],
    ['failed', { status: 'halt', runStatus: 'failed', reason: 'scripted_halt' }],
    [
      'budget_exceeded',
      { status: 'halt', runStatus: 'budget_exceeded', reason: 'budget_exhausted' },
    ],
  ] as const)(
    '종료 상태 %s는 다음 실행 대기를 깨운다 ("끝남" = 병합 완료 · 실패 · 예산 초과)',
    async (ending, halt) => {
      const h = setup();
      const first = startRun(h);
      await waitGate(h, first);
      const second = startRun(h);
      await waitFor(() => statusOf(h, second) === 'queued', 10_000, '실행 대기');
      if (halt !== undefined) h.halts.set(first, halt);
      h.gates.open(first);
      await waitGate(h, second);
      expect(statuses(h)).toEqual({ [first]: ending, [second]: 'running' });
      h.gates.open(second);
      await h.engine.settled();
      expect(statusOf(h, second)).toBe('merged');
      expect(h.maxRunning).toBe(1);
    },
    60_000,
  );

  it('경합: 두 생성 요청이 같은 순간에 와도 진행 중은 1개이고 나머지는 실행 대기다', async () => {
    const h = setup();
    // 두 실행 시작 확인을 먼저 저장하고(응답 전 판정 없음) 엔진 처리를 같은 틱에 넘긴다
    const ids = withProject(h.biveHome, h.project.id, (store) =>
      [0, 1].map(
        () =>
          createRun(
            store,
            { ruleIds: [h.rule.id], author: human },
            { clientId: null },
            { now: Date.now, newId },
          ).run,
      ),
    );
    for (const run of ids) h.engine.onRunCreated(h.project.id, run.id);
    const [a, b] = ids.map((run) => run.displayId);
    if (a === undefined || b === undefined) throw new Error('실행 없음');
    await waitGate(h, a);
    expect(statuses(h)).toEqual({ [a]: 'running', [b]: 'queued' });
    // 같은 실행을 두 번 판정해도(규칙 승인 알림 등) 다시 시작하지 않는다
    h.engine.onNormsApproved(h.project.id);
    h.gates.open(a);
    await waitGate(h, b);
    h.gates.open(b);
    await h.engine.settled();
    expect(statuses(h)).toEqual({ [a]: 'merged', [b]: 'merged' });
    expect(startOrder(h)).toEqual([a, b]);
    expect(h.maxRunning).toBe(1);
  }, 60_000);

  it('경합: 앞 실행이 끝나는 순간(종료 저장 직후, 다음 시작 전)에 온 새 요청은 먼저 기다리던 실행 뒤에 선다', async () => {
    const h = setup();
    await h.engine.stop();
    let late: string | null = null;
    const engine: PipelineEngine = h.newEngine((detail) => {
      // 첫 실행의 종료 저장 알림 안에서(구동이 끝나 다음 실행 대기를 깨우기 전) 사람의 [실행]이 들어온다
      if (late !== null || detail.run.displayId !== 'EXE-001' || detail.run.status !== 'merged') {
        return;
      }
      late = startRun(h, engine);
      // 생성 뒤 처리(승인 단계 판정)를 그 자리에서 바로 한다: 자리가 비었어도 EXE-002가 기다리므로 실행 대기
      engine.evaluateApproval(h.project.id, detailOf(h, late).run.id);
    });
    const first = startRun(h, engine);
    await waitGate(h, first);
    const second = startRun(h, engine);
    await waitFor(() => statusOf(h, second) === 'queued', 10_000, '실행 대기');
    h.gates.open(first);
    await waitGate(h, second);
    if (late === null) throw new Error('끝나는 순간의 요청이 없음');
    expect(statuses(h)).toEqual({ [first]: 'merged', [second]: 'running', [late]: 'queued' });
    expect(h.saves).toContain(`${late}:queued`);
    h.gates.open(second);
    await waitGate(h, late);
    h.gates.open(late);
    await engine.settled();
    expect(startOrder(h)).toEqual([first, second, late]);
    expect(h.maxRunning).toBe(1);
  }, 60_000);

  it('경합: 앞 실행이 끝나는 순간에 온 새 요청은 기다리는 실행이 없으면 바로 시작하고, 진행 중은 여전히 1개다', async () => {
    const h = setup();
    await h.engine.stop();
    let late: string | null = null;
    const engine: PipelineEngine = h.newEngine((detail) => {
      if (late !== null || detail.run.displayId !== 'EXE-001' || detail.run.status !== 'merged') {
        return;
      }
      late = startRun(h, engine);
      engine.evaluateApproval(h.project.id, detailOf(h, late).run.id);
    });
    const first = startRun(h, engine);
    await waitGate(h, first);
    h.gates.open(first);
    await waitFor(() => late !== null, 20_000, '끝나는 순간의 요청');
    const lateId = String(late);
    await waitGate(h, lateId);
    expect(statuses(h)).toEqual({ [first]: 'merged', [lateId]: 'running' });
    expect(h.saves.filter((save) => save.startsWith(`${lateId}:`))).not.toContain(
      `${lateId}:queued`,
    );
    h.gates.open(lateId);
    await engine.settled();
    expect(statusOf(h, lateId)).toBe('merged');
    expect(h.maxRunning).toBe(1);
  }, 60_000);

  it('다른 프로젝트의 실행은 서로 막지 않는다 (같은 BIVE_HOME, 프로젝트마다 진행 중 1개)', async () => {
    const biveHome = makeBiveHome();
    const one = setup(biveHome);
    const two = setup(biveHome);
    const a = startRun(one);
    const b = startRun(two);
    await waitGate(one, a);
    await waitGate(two, b);
    expect(statuses(one)).toEqual({ [a]: 'running' });
    expect(statuses(two)).toEqual({ [b]: 'running' });
    one.gates.open(a);
    two.gates.open(b);
    await one.engine.settled();
    await two.engine.settled();
    expect(statusOf(one, a)).toBe('merged');
    expect(statusOf(two, b)).toBe('merged');
  }, 60_000);

  it('대기 중에 대상 규칙이 효력을 잃으면 시작 때 다시 보아 실패(target_rule_unavailable)로 끝내고 다음 실행 대기를 시작한다', async () => {
    const h = setup();
    const otherRule = withProject(h.biveHome, h.project.id, (store) =>
      store.rules.create({
        id: newId(),
        title: '다른 규칙',
        statement: h.rule.statement,
        kind: 'business',
        checkKinds: ['test'],
        parentRequirementId: h.rule.parentRequirementId,
        builtin: false,
        targetBlockIds: [],
        risk: null,
        contractId: null,
        author: { kind: 'agent', role: 'rule-writer' },
        normState: 'approved',
        createdAt: new Date().toISOString(),
      }),
    );
    const first = startRun(h);
    await waitGate(h, first);
    const doomed = startRun(h, h.engine, otherRule.id);
    const next = startRun(h);
    await waitFor(
      () => statusOf(h, doomed) === 'queued' && statusOf(h, next) === 'queued',
      10_000,
      '실행 대기',
    );
    // 대기 중에 규칙이 삭제됨 (제품에 규칙 삭제 경로는 아직 없어 DB를 직접 바꾼다, M7-09 대비)
    withProject(h.biveHome, h.project.id, (store) =>
      store.db
        .prepare('UPDATE rules SET deleted_at = ? WHERE id = ?')
        .run(new Date().toISOString(), otherRule.id),
    );
    h.gates.open(first);
    await waitGate(h, next);
    const failed = detailOf(h, doomed);
    expect(failed.run).toMatchObject({
      status: 'failed',
      failureReason: QUEUED_TARGET_UNAVAILABLE,
      branch: null,
      worktreePath: null,
      baseCommit: null,
      startedAt: null,
    });
    expect(failed.run.endedAt).not.toBeNull();
    expect(h.saves).toContain(`${doomed}:failed`);
    h.gates.open(next);
    await h.engine.settled();
    expect(statuses(h)).toEqual({ [first]: 'merged', [doomed]: 'failed', [next]: 'merged' });
    expect(h.maxRunning).toBe(1);
  }, 60_000);
});

describe('재기동 · 중단 · 재개 (수용 기준 2, ADR-105)', () => {
  it('재기동 뒤: 중단된 실행이 자리를 지켜 실행 대기는 시작하지 않고, 사람이 재개해 끝나면 저장된 순서대로 시작한다', async () => {
    const h = setup();
    const first = startRun(h);
    await waitGate(h, first);
    const second = startRun(h);
    const third = startRun(h);
    await waitFor(
      () => statusOf(h, second) === 'queued' && statusOf(h, third) === 'queued',
      10_000,
      '실행 대기',
    );
    // 오케스트레이터 종료(구동 중단, 저장 없음) → 새 엔진으로 재기동 복구 → 대기열 이어가기
    await h.engine.stop();
    const restarted = h.newEngine();
    expect(restarted.recoverInterruptedRuns().map((run) => run.displayId)).toEqual([first]);
    restarted.startQueuedRuns();
    await restarted.settled();
    // 중단된 실행이 자리를 차지한다: 대기는 그대로(메모리 대기열 없이 저장된 상태에서 판단)
    expect(statuses(h)).toEqual({ [first]: 'interrupted', [second]: 'queued', [third]: 'queued' });
    expect(restarted.activeRunIds).toEqual([]);
    // 검증 화면 파이프라인은 최근에 만든 실행 대기가 아니라 자리를 지킨 중단 실행(그래야 [재개]가 보인다)과 뒤 대기 건수
    const blocked = withProject(h.biveHome, h.project.id, (store) => verificationSummary(store));
    expect(blocked.pipeline?.run).toMatchObject({ displayId: first, status: 'interrupted' });
    expect(blocked.pipeline?.queued).toBe(2);

    // 재개는 실행 대기가 있어도 된다(중단된 실행이 먼저). 재개한 실행이 끝나면 생성 순으로 이어진다
    h.gates.open(first);
    await restarted.resume(h.project.id, first, human);
    await waitGate(h, second);
    expect(statuses(h)).toEqual({ [first]: 'merged', [second]: 'running', [third]: 'queued' });
    // 진행 중인 실행이 생기면 파이프라인은 그 실행, 뒤 대기 1건
    const running = withProject(h.biveHome, h.project.id, (store) => verificationSummary(store));
    expect(running.pipeline?.run).toMatchObject({ displayId: second, status: 'running' });
    expect(running.pipeline?.queued).toBe(1);
    h.gates.open(second);
    await waitGate(h, third);
    h.gates.open(third);
    await restarted.settled();
    expect(startOrder(h)).toEqual([first, second, third]);
    // 다 끝나면 최근에 만든 실행, 대기 0
    const done = withProject(h.biveHome, h.project.id, (store) => verificationSummary(store));
    expect(done.pipeline?.run.displayId).toBe(third);
    expect(done.pipeline?.queued).toBe(0);
    expect(h.maxRunning).toBe(1);
  }, 60_000);

  it('재기동 뒤: 자리가 빈 채(앞 실행 종료 저장 뒤 다음 시작 전에 꺼짐) 남은 실행 대기는 기동 때 생성 순으로 시작한다', async () => {
    const h = setup();
    const first = startRun(h);
    await waitGate(h, first);
    const second = startRun(h);
    const third = startRun(h);
    await waitFor(
      () => statusOf(h, second) === 'queued' && statusOf(h, third) === 'queued',
      10_000,
      '실행 대기',
    );
    // 엔진을 멈추고, 앞 실행이 실패로 끝난 저장만 남긴다(다음 실행 대기를 깨우기 전에 프로세스가 죽은 경우)
    await h.engine.stop();
    withProject(h.biveHome, h.project.id, (store) =>
      store.runs.transition(detailOf(h, first).run.id, {
        expectedStatus: 'running',
        run: {
          status: 'failed',
          failureReason: 'scripted_halt',
          endedAt: new Date().toISOString(),
        },
      }),
    );
    const restarted = h.newEngine();
    expect(restarted.recoverInterruptedRuns()).toEqual([]);
    expect(statuses(h)).toEqual({ [first]: 'failed', [second]: 'queued', [third]: 'queued' });
    restarted.startQueuedRuns();
    await waitGate(h, second);
    expect(statuses(h)).toEqual({ [first]: 'failed', [second]: 'running', [third]: 'queued' });
    // 기동을 두 번 해도(같은 저장 상태에서 다시 판단) 더 시작하지 않는다
    restarted.startQueuedRuns();
    expect(statusOf(h, third)).toBe('queued');
    h.gates.open(second);
    await waitGate(h, third);
    h.gates.open(third);
    await restarted.settled();
    expect(statuses(h)).toEqual({ [first]: 'failed', [second]: 'merged', [third]: 'merged' });
    expect(h.maxRunning).toBe(1);
  }, 60_000);

  it('오케스트레이터 기동(startOrchestrator)은 연결을 받은 뒤 남은 실행 대기를 시작한다', async () => {
    const biveHome = makeBiveHome();
    const repo = copyFixture(temps);
    const seeded = seedProject(biveHome, repo);
    // 엔진 없이 저장만: EXE-001 진행 중 → EXE-002 실행 대기 → EXE-001 실패 저장(다음 시작 전에 프로세스가 끝난 상태)
    const [first, second] = withProject(biveHome, seeded.project.id, (store) => {
      const make = () =>
        createRun(
          store,
          { ruleIds: [seeded.rule.id], author: human },
          { clientId: null },
          { now: Date.now, newId },
        ).run.id;
      const a = make();
      evaluateApprovalStep(store, a, { now: Date.now });
      const b = make();
      expect(evaluateApprovalStep(store, b, { now: Date.now }).run.status).toBe('queued');
      store.runs.transition(a, {
        expectedStatus: 'running',
        run: {
          status: 'failed',
          failureReason: 'scripted_halt',
          endedAt: new Date().toISOString(),
        },
      });
      return [a, b];
    });
    const gates = new Gates();
    const result = await startOrchestrator({
      biveHome,
      idleShutdownMs: 60_000,
      agent: selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome }),
      executors: gatedExecutors(gates),
      log: () => undefined,
    });
    if (result.status !== 'started') throw new Error('기동 실패');
    try {
      await waitFor(() => gates.waiting.includes('EXE-002'), 20_000, 'EXE-002 시작');
      const runs = withProject(biveHome, seeded.project.id, (store) =>
        [first, second].map((id) => store.runs.get(id)?.status),
      );
      expect(runs).toEqual(['failed', 'running']);
    } finally {
      await result.orchestrator.stop();
    }
  }, 60_000);

  it('중단된 실행이 있으면 새 실행은 승인 단계 뒤 실행 대기다 (중단은 자리를 비우지 않는다)', async () => {
    const h = setup();
    const first = startRun(h);
    await waitGate(h, first);
    await h.engine.stop();
    const restarted = h.newEngine();
    restarted.recoverInterruptedRuns();
    const second = startRun(h, restarted);
    await restarted.settled();
    expect(statuses(h)).toEqual({ [first]: 'interrupted', [second]: 'queued' });
  }, 60_000);

  /** 진행 중이던 EXE-001을 재기동으로 중단시키고 그 뒤 EXE-002를 실행 대기로 만든다. */
  const interruptWithQueue = async (
    h: QueueHarness,
  ): Promise<{ engine: PipelineEngine; first: string; second: string; worktree: string }> => {
    const first = startRun(h);
    await waitGate(h, first);
    await h.engine.stop();
    const engine = h.newEngine();
    expect(engine.recoverInterruptedRuns().map((run) => run.displayId)).toEqual([first]);
    const second = startRun(h, engine);
    await waitFor(() => statusOf(h, second) === 'queued', 10_000, '실행 대기');
    return { engine, first, second, worktree: String(detailOf(h, first).run.worktreePath) };
  };

  it.each([
    [
      'worktree_missing',
      (worktree: string) => fs.rmSync(worktree, { recursive: true, force: true }),
    ],
    [
      'worktree_branch_mismatch',
      (worktree: string) => userGit(worktree, 'checkout', '-q', '--detach'),
    ],
  ] as const)(
    '재개할 수 없는 중단 실행(%s)은 사람의 재개 안에서 실패(worktree_error)로 끝나 자리를 비우고, 다음 실행 대기가 시작한다',
    async (code, breakWorktree) => {
      const h = setup();
      const { engine, first, second, worktree } = await interruptWithQueue(h);
      breakWorktree(worktree);
      const refused = await engine.resume(h.project.id, first, human).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(RpcError);
      expect((refused as RpcError).code).toBe(ErrorCode.StateConflict);
      expect((refused as RpcError).message).toContain('재개할 수 없어 실행을 실패로 끝냈습니다');
      expect((refused as RpcError).data).toMatchObject({
        reason: RESUME_UNRECOVERABLE,
        displayId: first,
        code,
      });
      const ended = detailOf(h, first);
      expect(ended.run).toMatchObject({ status: 'failed', failureReason: 'worktree_error' });
      expect(ended.run.endedAt).not.toBeNull();
      const closed = ended.steps.find((step) => step.kind === 'test_writing' && step.attempt === 2);
      expect(closed?.status).toBe('failed');
      expect(closed?.exitDetail).toMatchObject({ reason: 'worktree_error', detail: { code } });
      // 자리가 났으므로 다음 실행 대기가 시작한다
      await waitGate(h, second);
      expect(statuses(h)).toEqual({ [first]: 'failed', [second]: 'running' });
      h.gates.open(second);
      await engine.settled();
      expect(statusOf(h, second)).toBe('merged');
      expect(h.maxRunning).toBe(1);
    },
    60_000,
  );

  it('일시적일 수 있는 재개 실패(git 명령 오류)는 상태를 바꾸지 않고, 고친 뒤 다시 재개하면 이어진다', async () => {
    const h = setup();
    const { engine, first, second, worktree } = await interruptWithQueue(h);
    const gitFile = path.join(worktree, '.git');
    const original = fs.readFileSync(gitFile);
    fs.writeFileSync(gitFile, 'gitdir: /nonexistent\n');
    const before = detailOf(h, first);
    const refused = await engine.resume(h.project.id, first, human).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RpcError);
    expect((refused as RpcError).code).toBe(ErrorCode.StateConflict);
    expect((refused as RpcError).data).toBeUndefined();
    expect(detailOf(h, first)).toEqual(before);
    await engine.settled();
    expect(statuses(h)).toEqual({ [first]: 'interrupted', [second]: 'queued' });
    fs.writeFileSync(gitFile, original);
    h.gates.open(first);
    await engine.resume(h.project.id, first, human);
    await waitGate(h, second);
    h.gates.open(second);
    await engine.settled();
    expect(statuses(h)).toEqual({ [first]: 'merged', [second]: 'merged' });
  }, 60_000);

  it('다른 실행이 진행 중이면 재개는 -32009이고 아무것도 바뀌지 않는다 (예전 데이터의 중단 실행 둘)', async () => {
    const h = setup();
    const first = startRun(h);
    await waitGate(h, first);
    await h.engine.stop();
    // 이 변경 전에는 한 프로젝트에 실행이 여럿 돌 수 있었다(ADR-097): 중단된 실행 둘을 DB에 바로 만든다
    const legacy = startRun(h, h.newEngine());
    await waitFor(() => statusOf(h, legacy) === 'queued', 10_000, '실행 대기');
    for (const engine of engines.splice(0)) await engine.stop();
    const restarted = h.newEngine();
    restarted.recoverInterruptedRuns();
    withProject(h.biveHome, h.project.id, (store) =>
      store.db
        .prepare("UPDATE runs SET status = 'interrupted' WHERE id = ?")
        .run(detailOf(h, legacy).run.id),
    );
    expect(statuses(h)).toEqual({ [first]: 'interrupted', [legacy]: 'interrupted' });

    await restarted.resume(h.project.id, first, human);
    await waitGate(h, first);
    const before = detailOf(h, legacy);
    const refused = await restarted
      .resume(h.project.id, legacy, human)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RpcError);
    expect((refused as RpcError).code).toBe(ErrorCode.StateConflict);
    expect((refused as RpcError).message).toContain(`다른 실행이 진행 중입니다 (${first})`);
    expect(detailOf(h, legacy)).toEqual(before);
    expect(restarted.activeRunIds).toEqual([detailOf(h, first).run.id]);

    // 앞 실행이 끝나도 중단된 실행은 자동으로 이어가지 않는다. 사람이 재개하면 된다
    h.gates.open(first);
    await restarted.settled();
    expect(statuses(h)).toEqual({ [first]: 'merged', [legacy]: 'interrupted' });
    h.gates.open(legacy);
    await restarted.resume(h.project.id, legacy, human);
    await restarted.settled();
    expect(statusOf(h, legacy)).toBe('merged');
    expect(h.maxRunning).toBe(1);
  }, 60_000);
});
