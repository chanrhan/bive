// 저장소 밖에서 형식이 깨진 행 하나의 영향 (M3-36 #264 수용 기준 4, NFR-01, ADR-094 · ADR-120).
// - 실행 행 1건이 깨져도 `run.list`는 나머지를 돌려주고, 재기동 복구는 그 프로젝트의 다른 일(실행 밖 세션 닫기)을 마친다
// - 세션의 규범 입력 기록(`sessions.norm_input`) 1건이 깨져도 `run.get` · 하루 예산 합산 · 재기동 복구가 그대로 돈다. 합산은
//   그 세션을 빼지 않는다(덜 세지 않는다)
// - 건너뛴 · 비워 읽은 사실은 경고 한 줄로 드러난다(건수 · 프로젝트 ID만, 저장 값 없음)
import fs from 'node:fs';

import { METHODS, RUN_STEP_PLANS, STEP_ROLES } from '@bive/shared';
import type { ProjectStore, RunDetail } from '@bive/store';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { selectAgent } from '../src/agent/select.js';
import { PipelineEngine } from '../src/engine/pipeline-engine.js';
import { createRunHandlers } from '../src/ipc/run-handlers.js';
import { projectDailyBudget } from '../src/settings/project-budget.js';
import {
  COMPLETE_SETTINGS,
  copyFixture,
  human,
  newId,
  seedProject,
  withProject,
} from './helpers/engine-harness.js';
import { makeBiveHome } from './helpers/process.js';

const temps: string[] = [];
const engines: PipelineEngine[] = [];
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  warn.mockRestore();
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const NORM_INPUT = {
  summary: {
    requirements: { total: 1, included: 1, omitted: 0 },
    rules: { total: 1, included: 1, omitted: 0 },
    truncated: false,
  },
  requirementDisplayIds: ['REQ-001'],
  ruleDisplayIds: ['RULE-001'],
};

const harness = () => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const seeded = seedProject(biveHome, repo, { ...COMPLETE_SETTINGS, dailyBudgetUsd: 10 });
  return {
    biveHome,
    projectId: seeded.project.id,
    ruleId: seeded.rule.id,
    read: <T>(fn: (store: ProjectStore) => T): T => withProject(biveHome, seeded.project.id, fn),
  };
};
type Harness = ReturnType<typeof harness>;

const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

/** 승인 대기 실행 1개 (`running: true`면 테스트 작성 단계 진행 중으로). */
const createRun = (h: Harness, running = false): RunDetail =>
  h.read((store) => {
    const created = store.runs.create({
      id: newId(),
      type: 'A',
      targetRuleIds: [h.ruleId],
      currentStep: 'approval',
      baseBranch: 'main',
      budgetSnapshot: {
        run: { maxBudgetUsd: 5, maxTurns: 100 },
        roles: { 'test-writer': { maxBudgetUsd: 2, maxTurns: 50 } },
      },
      modelSnapshot: { 'test-writer': 'model-a' },
      startedBy: human,
      createdAt: at(-60_000),
      steps: RUN_STEP_PLANS.A.map((kind, index) => ({
        id: newId(),
        kind,
        attempt: 1,
        status: index === 0 ? ('running' as const) : ('pending' as const),
        role: STEP_ROLES[kind],
        startedAt: index === 0 ? at(-60_000) : null,
      })),
    });
    if (!running) return created;
    const stepId = (kind: string) => created.steps.find((step) => step.kind === kind)?.id ?? '';
    return store.runs.transition(created.run.id, {
      expectedStatus: 'waiting_approval',
      run: {
        status: 'running',
        currentStep: 'test_writing',
        lastCompletedStep: 'approval',
        startedAt: at(-50_000),
      },
      steps: [
        { id: stepId('approval'), status: 'passed', endedAt: at(-50_000) },
        { id: stepId('test_writing'), status: 'running', startedAt: at(-50_000) },
      ],
    });
  });

const testWritingStep = (detail: RunDetail): string =>
  detail.steps.find((step) => step.kind === 'test_writing')?.id ?? '';

/** 읽기 스키마(SessionNormInput)에 맞지 않는 규범 입력 기록을 가진 세션 (DB CHECK는 지나는 JSON 객체). */
const insertBrokenSession = (
  h: Harness,
  row: { runId: string | null; stepId: string | null; requirementId?: string; budgetUsd: number },
): string => {
  const id = newId();
  h.read((store) =>
    store.db
      .prepare(
        `INSERT INTO sessions (id, run_id, step_id, requirement_id, role, model, work_dir, model_usage, tools,
         mcp_servers, started_at, budget_max_usd, budget_max_turns, norm_input) VALUES (?, ?, ?, ?, ?, 'model-a',
         '/tmp/w', '{}', '[]', '[]', ?, ?, 20, '{"summary":"x"}')`,
      )
      .run(
        id,
        row.runId,
        row.stepId,
        row.requirementId ?? null,
        row.runId === null ? 'rule-writer' : 'test-writer',
        at(-40_000),
        row.budgetUsd,
      ),
  );
  return id;
};

/** 읽기 스키마(Run.toolManifest)에 맞지 않는 실행 행 (DB CHECK는 지나는 JSON 배열). */
const breakRun = (h: Harness, runId: string) =>
  h.read((store) =>
    store.db.prepare(`UPDATE runs SET tool_manifest = '[{"x":1}]' WHERE id = ?`).run(runId),
  );

const warnings = () => warn.mock.calls.map((call) => String(call[0]));

describe('실행 조회 RPC: 깨진 행 하나가 전체를 실패시키지 않는다', () => {
  /** 처리기를 부르고 결과를 프로토콜 결과 스키마로 확인한다 (동기 예외도 거부로). */
  const invoke = async (h: Harness, method: 'run.list' | 'run.get', params: object) => {
    const handler = createRunHandlers({ biveHome: h.biveHome, now: Date.now })[method];
    if (handler === undefined) throw new Error(`${method} 처리기 없음`);
    return (await (handler as (p: unknown, c: unknown) => unknown)(params, {
      connectionId: 1,
    })) as unknown;
  };
  const listRuns = async (h: Harness) =>
    METHODS['run.list'].result.parse(await invoke(h, 'run.list', { projectId: h.projectId }));
  const getRun = async (h: Harness, id: string) =>
    METHODS['run.get'].result.parse(await invoke(h, 'run.get', { projectId: h.projectId, id }));

  it('run.list는 깨진 실행 행만 건너뛰고 나머지를 순서대로 돌려주며 경고 한 줄을 남긴다. 그 실행의 run.get만 오류다', async () => {
    const h = harness();
    const first = createRun(h);
    const broken = createRun(h);
    const third = createRun(h);
    breakRun(h, broken.run.id);
    const listed = await listRuns(h);
    expect(listed.runs.map((run) => run.id)).toEqual([first.run.id, third.run.id]);
    expect(warnings()).toEqual([
      `실행 기록 1건이 저장 형식에 맞지 않아 조회에서 건너뜀 (프로젝트 ${h.projectId})`,
    ]);
    await expect(getRun(h, broken.run.id)).rejects.toThrow();
    const got = await getRun(h, third.run.id);
    expect(got.run.id).toBe(third.run.id);
  });

  it('run.get은 깨진 규범 입력 기록을 가진 세션을 normInput null로 싣고 나머지 세션 · 사용량은 그대로다', async () => {
    const h = harness();
    const run = createRun(h, true);
    const stepId = testWritingStep(run);
    const good = h.read((store) =>
      store.sessions.start({
        id: newId(),
        runId: run.run.id,
        stepId,
        role: 'test-writer',
        model: 'model-a',
        workDir: '/tmp/w',
        startedAt: at(-45_000),
        normInput: NORM_INPUT,
      }),
    );
    h.read((store) =>
      store.sessions.end(good.id, {
        endReason: 'success',
        totalCostUsd: 0.5,
        endedAt: at(-44_000),
      }),
    );
    const broken = insertBrokenSession(h, { runId: run.run.id, stepId, budgetUsd: 2 });
    const result = await getRun(h, run.run.id);
    expect(result.sessions.map((session) => [session.id, session.normInput])).toEqual([
      [good.id, NORM_INPUT],
      [broken, null],
    ]);
    expect(result.usage.run.costUsd).toBe(0.5);
    expect(warnings()).toEqual([
      `세션 기록의 규범 입력 1건이 저장 형식에 맞지 않아 비워 읽음 (프로젝트 ${h.projectId})`,
    ]);
  });
});

describe('하루 예산 합산: 깨진 규범 입력 기록의 세션도 빼지 않는다 (덜 세지 않음)', () => {
  it('진행 중인 깨진 세션은 지금 규칙대로 넘긴 한도 전부로 세어 합계에 든다', () => {
    const h = harness();
    const run = createRun(h, true);
    const stepId = testWritingStep(run);
    const good = h.read((store) =>
      store.sessions.start({
        id: newId(),
        runId: run.run.id,
        stepId,
        role: 'test-writer',
        model: 'model-a',
        workDir: '/tmp/w',
        startedAt: at(-45_000),
        normInput: NORM_INPUT,
        budget: { maxBudgetUsd: 1, maxTurns: 10 },
      }),
    );
    h.read((store) =>
      store.sessions.end(good.id, {
        endReason: 'success',
        totalCostUsd: 0.5,
        endedAt: at(-44_000),
      }),
    );
    insertBrokenSession(h, { runId: run.run.id, stepId, budgetUsd: 2 });
    const state = h.read((store) => projectDailyBudget(store, { dailyBudgetUsd: 10 }, Date.now()));
    expect(state).toMatchObject({
      limit: 10,
      remaining: 7.5,
      spend: { spent: 2.5, known: 0.5, estimated: 2, unknownSessions: 1, sessionCount: 2 },
    });
    expect(warnings()).toHaveLength(1);
  });
});

describe('재기동 복구: 깨진 행이 있어도 그 프로젝트의 복구를 마친다', () => {
  const newEngine = (h: Harness, logs: string[]) => {
    const engine = new PipelineEngine({
      biveHome: h.biveHome,
      agent: selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome: h.biveHome }).adapter,
      log: (line) => logs.push(line),
    });
    engines.push(engine);
    return engine;
  };

  it('깨진 규범 입력 기록의 세션이 있는 진행 중 실행을 중단으로 표시하고 그 세션 · 실행 밖 세션을 모두 닫는다', () => {
    const h = harness();
    const run = createRun(h, true);
    const inRun = insertBrokenSession(h, {
      runId: run.run.id,
      stepId: testWritingStep(run),
      budgetUsd: 2,
    });
    const requirementId = h.read((store) => store.requirements.list()[0]?.id ?? '');
    const runless = insertBrokenSession(h, {
      runId: null,
      stepId: null,
      requirementId,
      budgetUsd: 1,
    });
    const logs: string[] = [];
    expect(newEngine(h, logs).recoverInterruptedRuns()).toEqual([
      { projectId: h.projectId, runId: run.run.id, displayId: run.run.displayId },
    ]);
    expect(logs).toEqual([`실행 중단으로 표시 (${run.run.displayId}, 재기동)`]);
    h.read((store) => {
      expect(store.runs.get(run.run.id)?.status).toBe('interrupted');
      expect(store.sessions.get(inRun)).toMatchObject({ endReason: 'aborted', normInput: null });
      expect(store.sessions.get(runless)).toMatchObject({ endReason: 'aborted', normInput: null });
      // 저장된 기록 값은 그대로
      expect(
        store.db
          .prepare('SELECT norm_input FROM sessions WHERE id IN (?, ?) ORDER BY id')
          .all(inRun, runless),
      ).toEqual([{ norm_input: '{"summary":"x"}' }, { norm_input: '{"summary":"x"}' }]);
    });
  });

  it('진행 중인 실행 행이 깨졌으면 그 행만 건너뛰고(경고) 같은 프로젝트의 실행 밖 세션은 닫으며 복구 실패 로그가 없다', () => {
    const h = harness();
    const run = createRun(h, true);
    breakRun(h, run.run.id);
    const requirementId = h.read((store) => store.requirements.list()[0]?.id ?? '');
    const runless = insertBrokenSession(h, {
      runId: null,
      stepId: null,
      requirementId,
      budgetUsd: 1,
    });
    const logs: string[] = [];
    expect(newEngine(h, logs).recoverInterruptedRuns()).toEqual([]);
    expect(logs).toEqual([]);
    expect(h.read((store) => store.sessions.get(runless)?.endReason)).toBe('aborted');
    expect(warnings()).toEqual([
      `세션 기록의 규범 입력 1건이 저장 형식에 맞지 않아 비워 읽음 (프로젝트 ${h.projectId})`,
      `실행 기록 1건이 저장 형식에 맞지 않아 조회에서 건너뜀 (프로젝트 ${h.projectId})`,
    ]);
  });
});
