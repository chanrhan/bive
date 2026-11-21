// 실행 자동 시작 (M7-05 #217 수용 기준 1, RUN-01 · RUN-02 · NFR-07, ADR-100 D1 · B⑤ · B⑥ · A2 · A12 · C2, ADR-107).
// 제품 오케스트레이터(`startOrchestrator`)를 이 프로세스에서 띄우고 앱과 같은 파이프 RPC로만 조작한다: project.open →
// settings.update → requirement.create(사람) → 규칙 작성 세션(ScriptedAdapter happy-path, 규칙 2개 바로 반영) → 세션 종료 뒤
// 오케스트레이터가 실행을 자동 시작한다. 실행의 단계 실행기는 시험용이다(테스트 작성은 실행별 문이 열릴 때까지 기다린 뒤 파일
// 하나를 쓰고, 병합은 실제 git 병합). 픽스처 git 복사본 · 실제 SQLite · 실제 엔진.
// 자동 시작 함수(`autoStartRun`)의 생략 · 멱등 분기와 창구(`AutoStarter`)의 예외 처리는 열린 저장소에서 직접 부른다.
import fs from 'node:fs';
import path from 'node:path';

import {
  type NormChangeEntry,
  type Requirement,
  type Rule,
  type RuleWriterStatusEntry,
  type RunStatus,
  type SettingsPatch,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import { selectAgent } from '../src/agent/select.js';
import { PipelineEngine } from '../src/engine/pipeline-engine.js';
import type { StepExecutor, StepExecutors } from '../src/engine/types.js';
import { createAgentRule } from '../src/norms/agent-rule.js';
import { type Orchestrator, startOrchestrator } from '../src/orchestrator.js';
import { AUTO_START_REASON, AutoStarter, autoStartRun } from '../src/runs/auto-start.js';
import { connect, type TestClient } from './helpers/client.js';
import {
  COMPLETE_SETTINGS,
  copyFixture,
  human,
  mergeStep,
  newId,
  seedProject,
  testExecutors,
  withProject,
} from './helpers/engine-harness.js';
import { makeBiveHome, waitFor } from './helpers/process.js';

const temps: string[] = [];
const running: { orchestrator: Orchestrator; client: TestClient }[] = [];
const engines: PipelineEngine[] = [];

afterEach(async () => {
  for (const { orchestrator, client } of running.splice(0)) {
    client.destroy();
    await orchestrator.stop();
  }
  for (const engine of engines.splice(0)) await engine.stop();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 실행 표시 ID별 문. 열기 전에는 그 실행의 테스트 작성이 끝나지 않는다. */
class Gates {
  readonly #waiting = new Map<string, () => void>();
  readonly #opened = new Set<string>();

  wait(displayId: string, signal: AbortSignal): Promise<void> {
    if (this.#opened.has(displayId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#waiting.set(displayId, resolve);
      signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
    });
  }

  open(displayId: string): void {
    this.#opened.add(displayId);
    this.#waiting.get(displayId)?.();
  }

  get waiting(): string[] {
    return [...this.#waiting.keys()].filter((id) => !this.#opened.has(id));
  }
}

const gatedExecutors = (gates: Gates | null): StepExecutors => {
  const testWriting: StepExecutor = async (context) => {
    if (gates !== null) await gates.wait(context.run.displayId, context.signal);
    fs.writeFileSync(path.join(context.git.worktreePath, `auto-${context.run.displayId}.txt`), 'x');
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

interface Harness {
  biveHome: string;
  repo: string;
  orchestrator: Orchestrator;
  client: TestClient;
  projectId: string;
  logs: string[];
  read<T>(fn: (store: ProjectStore) => T): T;
}

const start = async (settings: SettingsPatch, gates: Gates | null = null): Promise<Harness> => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const logs: string[] = [];
  const result = await startOrchestrator({
    biveHome,
    idleShutdownMs: 60_000,
    agent: selectAgent(
      { BIVE_AGENT: 'scripted', BIVE_SCENARIO: 'happy-path' },
      { biveHome, pollIntervalMs: 10 },
    ),
    executors: gatedExecutors(gates),
    log: (line) => logs.push(line),
  });
  if (result.status !== 'started') throw new Error('기동 실패');
  const { orchestrator } = result;
  const client = await connect(orchestrator.paths.pipe, orchestrator.token);
  running.push({ orchestrator, client });
  const { project } = await client.call('project.open', { path: repo });
  await client.call('settings.update', { projectId: project.id, patch: settings, author: human });
  return {
    biveHome,
    repo,
    orchestrator,
    client,
    projectId: project.id,
    logs,
    read: (fn) => withProject(biveHome, project.id, fn),
  };
};

/** 요구사항을 저장하고(사람) 규칙 작성 세션이 끝날 때까지 기다린다. 가장 최근 시도와 만든 규칙을 돌려준다. */
const saveRequirement = async (
  h: Harness,
  text: string,
): Promise<{ requirement: Requirement; rules: Rule[]; status: RuleWriterStatusEntry }> => {
  const { requirement } = await h.client.call('requirement.create', {
    projectId: h.projectId,
    text,
    author: human,
  });
  await h.orchestrator.ruleWriter.whenSettled(h.projectId, requirement.id);
  const { entries } = await h.client.call('ruleWriter.status', {
    projectId: h.projectId,
    requirementId: requirement.id,
  });
  const [status] = entries;
  if (status === undefined) throw new Error('시도 기록 없음');
  const rules = (await h.client.call('rule.list', { projectId: h.projectId })).rules
    .map((entry) => entry.rule)
    .filter((rule) => rule.parentRequirementId === requirement.id);
  return { requirement, rules, status };
};

const statusOf = async (h: Harness, runId: string): Promise<RunStatus> =>
  (await h.client.call('run.get', { projectId: h.projectId, id: runId })).run.status;

const DAILY: SettingsPatch = { ...COMPLETE_SETTINGS, dailyBudgetUsd: 10 };
/** 구현 역할의 모델만 빈 설정 (나머지 역할은 채움) */
const NO_IMPLEMENTER_MODEL: SettingsPatch['roles'] = {
  ...COMPLETE_SETTINGS.roles,
  implementer: { model: null, maxBudgetUsd: 2, maxTurns: 100 },
};

describe('규칙 작성 세션 뒤 실행 자동 시작 (수용 기준 1)', () => {
  it('규칙을 만든 세션이 끝나면 그 규칙들로 실행 1개가 사람 확인 없이 생기고, 규범 변경 기록에 자동 시작 항목(원인 = 신규 기록 순번)이 남으며 승인 기록은 비어 있다', async () => {
    const h = await start(DAILY);
    const { rules, status } = await saveRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    expect(rules).toHaveLength(2);
    expect(status).toMatchObject({ state: 'ended', endReason: 'success' });

    // 실행 1개: 대상 = 세션이 만든 규칙(만든 순서), 시작 주체 = 오케스트레이터(원인 순번), 사람 조작 없이 merged
    const { runs } = await h.client.call('run.list', { projectId: h.projectId });
    expect(runs).toHaveLength(1);
    const [run] = runs;
    if (run === undefined) throw new Error('실행 없음');
    expect(run).toMatchObject({
      displayId: 'EXE-001',
      targetRuleIds: rules.map((rule) => rule.id),
      startedBy: { kind: 'orchestrator', causeSeqs: [1, 2] },
    });
    await waitFor(
      async () => (await statusOf(h, run.id)) === 'merged',
      30_000,
      '자동 시작 실행 병합',
    );
    const done = await h.client.call('run.get', { projectId: h.projectId, id: run.id });
    expect(done.steps.map((step) => `${step.kind}:${step.status}`)).toEqual([
      'approval:passed',
      'test_writing:passed',
      'red_check:passed',
      'implementation:passed',
      'check:passed',
      'mutation:skipped',
      'merge:passed',
      'screen_update:passed',
    ]);

    // 규범 변경 기록: 신규 2건 뒤 자동 시작 1건 (주체 오케스트레이터, 대상 = 실행, 원인 = 신규 기록 순번), 체인 정상
    const changes = await h.client.call('normChange.list', { projectId: h.projectId });
    expect(changes.chain.valid).toBe(true);
    expect(changes.entries.map((entry) => [entry.seq, entry.kind, entry.targetRef.id])).toEqual([
      [1, 'created', rules[0]?.id],
      [2, 'created', rules[1]?.id],
      [3, 'auto_start', run.id],
    ]);
    expect(changes.entries[2]).toMatchObject({
      actor: { kind: 'orchestrator' },
      targetRef: { entity: 'Run', id: run.id },
      sessionId: null,
      runId: run.id,
      reason: AUTO_START_REASON,
      detail: { causeSeqs: [1, 2], ruleIds: rules.map((rule) => rule.id) },
    });
    // 원인 순번은 그 세션(= 시도)의 신규 기록이다
    expect(changes.entries.slice(0, 2).map((entry) => entry.sessionId)).toEqual([
      status.attemptId,
      status.attemptId,
    ]);
    // 승인 기록(사람 행동만, C2)에는 아무것도 없다: 실행 시작 확인 · 승인이 없었다
    const approvals = await h.client.call('approvalLog.list', { projectId: h.projectId });
    expect(approvals.entries).toEqual([]);
    // 상태 줄 쪽 조회에는 자동 시작한 실행이 실리고 생략 기록은 없다
    const { entries } = await h.client.call('ruleWriter.status', { projectId: h.projectId });
    expect(entries.map((entry) => entry.autoStart)).toEqual([
      { state: 'started', runId: run.id, runDisplayId: 'EXE-001' },
    ]);
    expect(h.read((store) => store.autoStartSkips.get(status.attemptId))).toBeNull();
    expect(h.logs).toContain('실행 자동 시작 (EXE-001, 규칙 2건, 규범 변경 기록 3)');
  }, 60_000);

  it('하루 한도가 비어 있으면 자동 시작을 생략하고 그 사실이 규칙 작성 상태(상태 줄)에 실린다. 사람의 [실행]은 그대로 실행을 만든다', async () => {
    const h = await start(COMPLETE_SETTINGS);
    const { rules, status } = await saveRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    expect(rules).toHaveLength(2);
    expect(status).toMatchObject({
      state: 'ended',
      endReason: 'success',
      autoStart: { state: 'skipped', reason: 'project_daily_budget_unset', missing: [] },
    });
    expect((await h.client.call('run.list', { projectId: h.projectId })).runs).toEqual([]);
    expect(
      (await h.client.call('normChange.list', { projectId: h.projectId })).entries.map(
        (entry) => entry.kind,
      ),
    ).toEqual(['created', 'created']);
    expect(h.read((store) => store.autoStartSkips.get(status.attemptId))).toMatchObject({
      reason: 'project_daily_budget_unset',
    });

    // 사람의 [실행](SCR-03 확인 대화의 run.create): 사람 주체 · 승인 기록 run_start 1건으로 실행이 생기고 끝까지 간다
    const [first] = rules;
    if (first === undefined) throw new Error('규칙 없음');
    const { run, approvalLog } = await h.client.call('run.create', {
      projectId: h.projectId,
      ruleIds: [first.id],
      author: human,
    });
    expect(run.startedBy).toEqual({ kind: 'human' });
    expect(approvalLog).toMatchObject({ action: 'run_start', detail: { ruleIds: [first.id] } });
    await waitFor(async () => (await statusOf(h, run.id)) === 'merged', 30_000, '사람 실행 병합');
    expect(
      (await h.client.call('normChange.list', { projectId: h.projectId })).entries.map(
        (entry) => entry.kind,
      ),
    ).toEqual(['created', 'created']);
  }, 60_000);

  it('자동 시작 실행도 프로젝트당 진행 중 1개 · 실행 대기를 따른다: 앞 실행이 도는 동안 생긴 자동 시작 실행은 실행 대기, 앞 실행이 끝나면 생성 순으로 시작한다', async () => {
    const gates = new Gates();
    const h = await start(DAILY, gates);
    await saveRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await waitFor(() => gates.waiting.includes('EXE-001'), 20_000, 'EXE-001 테스트 작성');
    await saveRequirement(h, '헬스 체크 응답에 버전 포함');
    const list = async () =>
      (await h.client.call('run.list', { projectId: h.projectId })).runs.map((run) => [
        run.displayId,
        run.status,
        run.startedBy.kind,
      ]);
    await waitFor(
      async () => (await list()).some(([id, state]) => id === 'EXE-002' && state === 'queued'),
      20_000,
      'EXE-002 실행 대기',
    );
    expect(await list()).toEqual([
      ['EXE-001', 'running', 'orchestrator'],
      ['EXE-002', 'queued', 'orchestrator'],
    ]);
    gates.open('EXE-001');
    await waitFor(() => gates.waiting.includes('EXE-002'), 20_000, 'EXE-002 시작');
    expect(await list()).toEqual([
      ['EXE-001', 'merged', 'orchestrator'],
      ['EXE-002', 'running', 'orchestrator'],
    ]);
    gates.open('EXE-002');
    await waitFor(
      async () => (await list()).every(([, state]) => state === 'merged'),
      20_000,
      'EXE-002 병합',
    );
    // 자동 시작 항목도 실행마다 1건이고 원인 순번이 겹치지 않는다
    const changes = (await h.client.call('normChange.list', { projectId: h.projectId })).entries;
    expect(
      changes
        .filter((entry) => entry.kind === 'auto_start')
        .map((entry) => [entry.seq, entry.detail.causeSeqs]),
    ).toEqual([
      [3, [1, 2]],
      [6, [4, 5]],
    ]);
    expect((await h.client.call('approvalLog.list', { projectId: h.projectId })).entries).toEqual(
      [],
    );
  }, 60_000);
});

// ── 자동 시작 함수 · 창구 (열린 저장소에서 직접) ─────────────

interface StoreHarness {
  biveHome: string;
  projectId: string;
  requirementId: string;
  read<T>(fn: (store: ProjectStore) => T): T;
}

const storeHarness = (settings: SettingsPatch = DAILY): StoreHarness => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const seeded = seedProject(biveHome, repo, settings);
  return {
    biveHome,
    projectId: seeded.project.id,
    requirementId: seeded.rule.parentRequirementId ?? '',
    read: (fn) => withProject(biveHome, seeded.project.id, fn),
  };
};

const clock = { now: Date.now, newId };

/** 규칙 작성 역할이 세션 `sessionId`에서 규칙 하나를 만든 것과 같은 기록 (바로 반영 모듈 그대로). */
const makeRule = (h: StoreHarness, sessionId: string, title: string): NormChangeEntry =>
  h.read(
    (store) =>
      createAgentRule(
        store,
        {
          payload: {
            title,
            statement: `WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL ${title}을 담는다`,
            kind: 'business',
            checkKinds: ['test'],
            parentRequirementId: h.requirementId,
          },
          rationale: '시험 근거',
          author: { kind: 'agent', role: 'rule-writer' },
          sessionId,
        },
        clock,
      ).normChange,
  );

const counts = (store: ProjectStore) => ({
  runs: store.runs.list().length,
  autoStarts: store.normChanges.list().filter((entry) => entry.kind === 'auto_start').length,
  approvals: store.approvalLog.list().length,
});

describe('autoStartRun: 생략 · 멱등 (ADR-107)', () => {
  it('같은 세션으로 두 번 불러도 실행은 1개다: 둘째는 기록 없이 이미 만든 실행을 돌려준다', () => {
    const h = storeHarness();
    const session = newId();
    const [a, b] = [makeRule(h, session, '서버 시각'), makeRule(h, session, '버전')];
    const first = h.read((store) => autoStartRun(store, { sessionId: session }, clock));
    if (first.status !== 'started') throw new Error(`시작 안 됨: ${first.status}`);
    expect(first.detail.run).toMatchObject({
      status: 'waiting_approval',
      currentStep: 'approval',
      targetRuleIds: [a.targetRef.id, b.targetRef.id],
      startedBy: { kind: 'orchestrator', causeSeqs: [a.seq, b.seq] },
    });
    expect(first.normChange.detail).toEqual({
      causeSeqs: [a.seq, b.seq],
      ruleIds: [a.targetRef.id, b.targetRef.id],
    });
    const second = h.read((store) => autoStartRun(store, { sessionId: session }, clock));
    expect(second).toEqual({ status: 'duplicate', runId: first.detail.run.id });
    expect(h.read(counts)).toEqual({ runs: 1, autoStarts: 1, approvals: 0 });
    // 다른 세션의 규칙은 따로 실행 1개 (원인 순번이 겹치지 않음)
    const other = newId();
    makeRule(h, other, '응답 형식');
    expect(h.read((store) => autoStartRun(store, { sessionId: other }, clock)).status).toBe(
      'started',
    );
    expect(h.read(counts)).toEqual({ runs: 2, autoStarts: 2, approvals: 0 });
  });

  it('세션이 만든 규칙이 없으면 아무것도 남기지 않는다 (다른 세션 · 사람이 만든 규칙은 원인이 아니다)', () => {
    const h = storeHarness();
    makeRule(h, newId(), '서버 시각');
    expect(h.read((store) => autoStartRun(store, { sessionId: newId() }, clock))).toEqual({
      status: 'no_rules',
    });
    expect(h.read(counts)).toEqual({ runs: 0, autoStarts: 0, approvals: 0 });
  });

  it('하루 한도 비움 · 설정 미비 · 오늘 지출이 하루 한도에 이름이면 실행을 만들지 않고 생략 기록 1건을 남긴다 (다시 불러도 1건)', () => {
    const cases: [string, SettingsPatch, (h: StoreHarness) => void, unknown][] = [
      [
        '비움',
        COMPLETE_SETTINGS,
        () => undefined,
        { reason: 'project_daily_budget_unset', missing: [] },
      ],
      [
        '비움과 설정 미비가 함께면 비움',
        { ...COMPLETE_SETTINGS, roles: NO_IMPLEMENTER_MODEL },
        () => undefined,
        { reason: 'project_daily_budget_unset', missing: [] },
      ],
      [
        '설정 미비',
        { ...DAILY, roles: NO_IMPLEMENTER_MODEL },
        () => undefined,
        { reason: 'settings_incomplete', missing: ['roles.implementer.model'] },
      ],
      [
        '하루 한도에 이름',
        { ...COMPLETE_SETTINGS, dailyBudgetUsd: 0.05 },
        (h) => {
          // 오늘 끝난 규칙 작성 세션이 0.05를 썼다
          const id = newId();
          const at = new Date().toISOString();
          h.read((store) => {
            store.sessions.start({
              id,
              runId: null,
              stepId: null,
              requirementId: h.requirementId,
              role: 'rule-writer',
              model: 'test-model',
              workDir: '/w',
              budget: { maxBudgetUsd: 1, maxTurns: 20 },
              startedAt: at,
            });
            store.sessions.end(id, {
              endReason: 'success',
              totalCostUsd: 0.05,
              numTurns: 1,
              endedAt: at,
            });
          });
        },
        { reason: 'project_daily_budget_exceeded', missing: [] },
      ],
    ];
    for (const [name, settings, prepare, expected] of cases) {
      const h = storeHarness(settings);
      prepare(h);
      const session = newId();
      makeRule(h, session, '서버 시각');
      const outcome = h.read((store) => autoStartRun(store, { sessionId: session }, clock));
      expect(outcome, name).toEqual({ status: 'skipped', ...(expected as object) });
      expect(
        h.read((store) => store.autoStartSkips.get(session)),
        name,
      ).toMatchObject(expected as object);
      expect(
        h.read((store) => autoStartRun(store, { sessionId: session }, clock)),
        name,
      ).toEqual({
        status: 'duplicate',
        runId: null,
      });
      expect(h.read(counts), name).toEqual({ runs: 0, autoStarts: 0, approvals: 0 });
    }
  });

  it('하루 한도에 이르기 직전(남은 USD > 0)이면 만든다 (경계)', () => {
    const h = storeHarness({ ...COMPLETE_SETTINGS, dailyBudgetUsd: 0.06 });
    const id = newId();
    const at = new Date().toISOString();
    h.read((store) => {
      store.sessions.start({
        id,
        runId: null,
        stepId: null,
        requirementId: h.requirementId,
        role: 'rule-writer',
        model: 'test-model',
        workDir: '/w',
        budget: { maxBudgetUsd: 1, maxTurns: 20 },
        startedAt: at,
      });
      store.sessions.end(id, {
        endReason: 'success',
        totalCostUsd: 0.05,
        numTurns: 1,
        endedAt: at,
      });
    });
    const session = newId();
    makeRule(h, session, '서버 시각');
    expect(h.read((store) => autoStartRun(store, { sessionId: session }, clock)).status).toBe(
      'started',
    );
  });

  it('대상 규칙이 그사이 삭제됐으면 던지고 아무것도 남기지 않는다(트랜잭션 1개)', () => {
    const h = storeHarness();
    const session = newId();
    const created = makeRule(h, session, '서버 시각');
    // 제품에는 규칙 삭제 경로가 아직 없다(M7-09 폐기 대비): 저장소 밖에서 지운 것과 같은 상태
    h.read((store) =>
      store.db
        .prepare('UPDATE rules SET deleted_at = ? WHERE id = ?')
        .run(new Date().toISOString(), created.targetRef.id),
    );
    expect(() => h.read((store) => autoStartRun(store, { sessionId: session }, clock))).toThrow();
    expect(h.read(counts)).toEqual({ runs: 0, autoStarts: 0, approvals: 0 });
    expect(h.read((store) => store.sequences.last('EXE'))).toBe(0);
  });
});

describe('AutoStarter: 세션 종료 알림 → 자동 시작 → 엔진 (ADR-107)', () => {
  it('정상 종료만 자동 시작하고 엔진의 생성 뒤 처리를 한 번 부른다. 정상 종료가 아니면 아무것도 하지 않는다', () => {
    const h = storeHarness();
    const created: string[] = [];
    const logs: string[] = [];
    const starter = new AutoStarter({
      biveHome: h.biveHome,
      engine: { onRunCreated: (projectId, runId) => created.push(`${projectId}:${runId}`) },
      log: (line) => logs.push(line),
    });
    const session = newId();
    makeRule(h, session, '서버 시각');
    for (const endReason of [
      'error_max_turns',
      'error_max_budget_usd',
      'error_during_execution',
      'aborted',
      'guard_violation',
    ] as const) {
      expect(starter.afterRuleWriterSession(h.projectId, session, endReason), endReason).toBeNull();
    }
    expect(h.read(counts)).toEqual({ runs: 0, autoStarts: 0, approvals: 0 });
    const outcome = starter.afterRuleWriterSession(h.projectId, session, 'success');
    if (outcome?.status !== 'started') throw new Error('시작 안 됨');
    expect(created).toEqual([`${h.projectId}:${outcome.detail.run.id}`]);
    // 같은 세션을 다시 알려도 엔진을 다시 부르지 않는다
    expect(starter.afterRuleWriterSession(h.projectId, session, 'success')?.status).toBe(
      'duplicate',
    );
    expect(created).toHaveLength(1);
    expect(logs).toEqual([`실행 자동 시작 (EXE-001, 규칙 1건, 규범 변경 기록 2)`]);
  });

  it('저장소를 열 수 없거나 저장이 실패하면 로그만 남기고 던지지 않는다 (규칙 작성 세션 기록 · 알림을 막지 않음)', () => {
    const h = storeHarness();
    const logs: string[] = [];
    const created: string[] = [];
    const starter = new AutoStarter({
      biveHome: h.biveHome,
      engine: { onRunCreated: (_p, runId) => created.push(runId) },
      log: (line) => logs.push(line),
    });
    expect(starter.afterRuleWriterSession(newId(), newId(), 'success')).toBeNull();
    expect(created).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^실행 자동 시작 실패 \(세션 /);
  });

  it('자동 시작 저장 뒤 엔진에 알리기 전에 프로세스가 끝나 승인 대기로 남은 실행은 다음 기동이 판정해 끝까지 간다 (시작 근거 대조 통과)', async () => {
    const h = storeHarness();
    const session = newId();
    makeRule(h, session, '서버 시각');
    const outcome = h.read((store) => autoStartRun(store, { sessionId: session }, clock));
    if (outcome.status !== 'started') throw new Error('시작 안 됨');
    const engine = new PipelineEngine({
      biveHome: h.biveHome,
      agent: selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome: h.biveHome }).adapter,
      executors: { ...testExecutors(), ...gatedExecutors(null) },
    });
    engines.push(engine);
    expect(engine.recoverInterruptedRuns()).toEqual([]);
    engine.startQueuedRuns();
    await engine.settled();
    expect(h.read((store) => store.runs.get(outcome.detail.run.id))).toMatchObject({
      status: 'merged',
      failureReason: null,
    });
    expect(h.read(counts)).toEqual({ runs: 1, autoStarts: 1, approvals: 0 });
  }, 60_000);
});
