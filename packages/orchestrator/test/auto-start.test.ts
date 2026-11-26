// 실행 자동 시작 (M7-05 #217 수용 기준 1 · M7-19 #244 수용 기준 1, RUN-01 · RUN-02 · NFR-07, ADR-100 D1 · B⑤ · B⑥ · A2 · A12 ·
// C2, ADR-107 · ADR-110 · ADR-111).
// 제품 오케스트레이터(`startOrchestrator`)를 이 프로세스에서 띄우고 앱과 같은 파이프 RPC로만 조작한다: project.open →
// settings.update → requirement.create(사람) → 규칙 작성 세션(ScriptedAdapter happy-path, 규칙 2개 바로 반영) → 세션 종료 뒤
// 오케스트레이터가 규칙마다 실행 1개를 자동 시작한다. 실행의 단계 실행기는 시험용이다(테스트 작성은 실행별 문이 열릴 때까지 기다린 뒤 파일
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

import { type Scenario, ScenarioSchema } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import { selectAgent } from '../src/agent/select.js';
import { PipelineEngine } from '../src/engine/pipeline-engine.js';
import type { StepExecutor, StepExecutors } from '../src/engine/types.js';
import { createAgentRule, retireAgentRule, supersedeAgentRule } from '../src/norms/agent-rule.js';
import { checkRunStartBasis } from '../src/engine/start-basis.js';
import {
  createRun,
  evaluateApprovalStep,
  saveNewRun,
  startNextQueuedRun,
} from '../src/runs/run-service.js';
import { type Orchestrator, startOrchestrator } from '../src/orchestrator.js';
import {
  AUTO_START_REASON,
  type AutoStartedRun,
  AutoStarter,
  autoStartRun,
  reinforceSurvivedMutants,
} from '../src/runs/auto-start.js';
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
import {
  allPass,
  cleanupMutationHarness,
  type Harness as MutationHarness,
  HEALTH,
  runToEnd as mutationRunToEnd,
  setup as setupMutation,
} from './helpers/mutation-harness.js';
import { makeBiveHome, waitFor } from './helpers/process.js';

const VALID = { path: HEALTH, search: 'ok: true', replace: 'ok: false' };

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

const start = async (
  settings: SettingsPatch,
  gates: Gates | null = null,
  scenario: Scenario | null = null,
): Promise<Harness> => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const logs: string[] = [];
  const result = await startOrchestrator({
    biveHome,
    idleShutdownMs: 60_000,
    agent:
      scenario === null
        ? selectAgent(
            { BIVE_AGENT: 'scripted', BIVE_SCENARIO: 'happy-path' },
            { biveHome, pollIntervalMs: 10 },
          )
        : {
            kind: 'scripted',
            adapter: new ScriptedAdapter({ scenario, biveHome, pollIntervalMs: 10 }),
            scenario: scenario.name,
          },
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
  it('규칙 2개를 만든 세션이 끝나면 규칙마다 실행 1개씩 2개가 생성 기록 순서대로 사람 확인 없이 생기고(대상 규칙 1개), 규범 변경 기록에 실행마다 자동 시작 항목 1건(원인 = 그 규칙의 신규 기록 1건)이 남으며, 첫 실행이 도는 동안 둘째는 실행 대기다. 승인 기록은 비어 있다', async () => {
    const gates = new Gates();
    const h = await start(DAILY, gates);
    const { rules, status } = await saveRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    expect(rules).toHaveLength(2);
    expect(status).toMatchObject({ state: 'ended', endReason: 'success' });
    const [ruleA, ruleB] = rules;
    if (ruleA === undefined || ruleB === undefined) throw new Error('규칙 없음');

    // 실행 2개: 실행마다 대상 = 규칙 1개(만든 순서), 시작 주체 = 오케스트레이터(그 규칙의 신규 기록 순번 1개)
    const list = async () =>
      (await h.client.call('run.list', { projectId: h.projectId })).runs.map((run) => ({
        displayId: run.displayId,
        status: run.status,
        targetRuleIds: run.targetRuleIds,
        startedBy: run.startedBy,
      }));
    await waitFor(() => gates.waiting.includes('EXE-001'), 20_000, 'EXE-001 테스트 작성');
    await waitFor(
      async () =>
        (await list()).some((run) => run.displayId === 'EXE-002' && run.status === 'queued'),
      20_000,
      'EXE-002 실행 대기',
    );
    expect(await list()).toEqual([
      {
        displayId: 'EXE-001',
        status: 'running',
        targetRuleIds: [ruleA.id],
        startedBy: { kind: 'orchestrator', causeSeqs: [1] },
      },
      {
        displayId: 'EXE-002',
        status: 'queued',
        targetRuleIds: [ruleB.id],
        startedBy: { kind: 'orchestrator', causeSeqs: [3] },
      },
    ]);
    gates.open('EXE-001');
    await waitFor(() => gates.waiting.includes('EXE-002'), 20_000, 'EXE-002 시작');
    expect((await list()).map((run) => [run.displayId, run.status])).toEqual([
      ['EXE-001', 'merged'],
      ['EXE-002', 'running'],
    ]);
    gates.open('EXE-002');
    await waitFor(
      async () => (await list()).every((run) => run.status === 'merged'),
      30_000,
      '자동 시작 실행 병합',
    );
    const { runs } = await h.client.call('run.list', { projectId: h.projectId });
    const [first, second] = runs;
    if (first === undefined || second === undefined) throw new Error('실행 없음');
    const done = await h.client.call('run.get', { projectId: h.projectId, id: first.id });
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
    // 둘째 실행은 첫 실행이 끝난 뒤 시작했다 (병합 위에서 돈다)
    expect(String(second.startedAt) >= String(first.endedAt)).toBe(true);

    // 규범 변경 기록: 규칙마다 신규 · 모순 판단 1쌍(M7-07) 뒤 실행마다 자동 시작 1건 (주체 오케스트레이터, 대상 = 그 실행,
    // 원인 = 그 규칙의 신규 기록 순번 1개이고 판단 기록 순번이 아니다), 체인 정상
    const changes = await h.client.call('normChange.list', { projectId: h.projectId });
    expect(changes.chain.valid).toBe(true);
    expect(changes.entries.map((entry) => [entry.seq, entry.kind, entry.targetRef.id])).toEqual([
      [1, 'created', ruleA.id],
      [2, 'judgment', ruleA.id],
      [3, 'created', ruleB.id],
      [4, 'judgment', ruleB.id],
      [5, 'auto_start', first.id],
      [6, 'auto_start', second.id],
    ]);
    expect(changes.entries.slice(4)).toMatchObject([
      {
        actor: { kind: 'orchestrator' },
        targetRef: { entity: 'Run', id: first.id },
        sessionId: null,
        runId: first.id,
        reason: AUTO_START_REASON,
        detail: { causeSeqs: [1], ruleIds: [ruleA.id] },
      },
      {
        actor: { kind: 'orchestrator' },
        targetRef: { entity: 'Run', id: second.id },
        sessionId: null,
        runId: second.id,
        reason: AUTO_START_REASON,
        detail: { causeSeqs: [3], ruleIds: [ruleB.id] },
      },
    ]);
    // 원인 순번은 그 세션(= 시도)의 신규 기록이다
    expect(
      changes.entries.filter((entry) => entry.kind === 'created').map((entry) => entry.sessionId),
    ).toEqual([status.attemptId, status.attemptId]);
    // 승인 기록(사람 행동만, C2)에는 아무것도 없다: 실행 시작 확인 · 승인이 없었다
    const approvals = await h.client.call('approvalLog.list', { projectId: h.projectId });
    expect(approvals.entries).toEqual([]);
    // 상태 줄 쪽 조회에는 자동 시작한 첫 실행이 실리고 생략 기록은 없다
    const { entries } = await h.client.call('ruleWriter.status', { projectId: h.projectId });
    expect(entries.map((entry) => entry.autoStart)).toEqual([
      { state: 'started', runId: first.id, runDisplayId: 'EXE-001' },
    ]);
    expect(h.read((store) => store.autoStartSkips.get(status.attemptId))).toBeNull();
    expect(h.logs).toContain('실행 자동 시작 (EXE-001, 규칙 1건, 규범 변경 기록 5)');
    expect(h.logs).toContain('실행 자동 시작 (EXE-002, 규칙 1건, 규범 변경 기록 6)');
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
    ).toEqual(['created', 'judgment', 'created', 'judgment']);
    expect(h.read((store) => store.autoStartSkips.get(status.attemptId))).toMatchObject({
      reason: 'project_daily_budget_unset',
    });

    // 사람의 [실행](SCR-03 확인 대화의 run.create): 지금처럼 규칙 여러 개를 한 실행으로 받는다. 사람 주체 · 승인 기록
    // run_start 1건으로 실행이 생기고 시작 근거 대조를 지나 끝까지 간다 (규칙마다 실행 1개는 자동 시작에만, ADR-110)
    const ruleIds = rules.map((rule) => rule.id);
    const { run, approvalLog } = await h.client.call('run.create', {
      projectId: h.projectId,
      ruleIds,
      author: human,
    });
    expect(run.startedBy).toEqual({ kind: 'human' });
    expect(run.targetRuleIds).toEqual(ruleIds);
    expect(approvalLog).toMatchObject({ action: 'run_start', detail: { ruleIds } });
    await waitFor(async () => (await statusOf(h, run.id)) === 'merged', 30_000, '사람 실행 병합');
    expect((await h.client.call('run.list', { projectId: h.projectId })).runs).toHaveLength(1);
    expect(
      (await h.client.call('normChange.list', { projectId: h.projectId })).entries.map(
        (entry) => entry.kind,
      ),
    ).toEqual(['created', 'judgment', 'created', 'judgment']);
  }, 60_000);

  it('요구사항 수정의 재판단이 자식 규칙을 대체하면 새 규칙의 실행 1개가 자동 시작되어 병합되고, 유지만 한 재판단은 실행을 만들지 않는다 (M7-10 #222 수용 기준 3, ADR-116)', async () => {
    const result = { subtype: 'success', total_cost_usd: 0.01, num_turns: 1, modelUsage: {} };
    const statement = (field: string, what: string) =>
      `WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 응답 JSON의 ${field} 필드에 ${what}을 담는다`;
    const proposal = (title: string, field: string, what: string) => ({
      parentRequirementId: '{{requirementId}}',
      title,
      statement: statement(field, what),
      kind: 'business',
      checkKinds: ['test'],
      targetBlocks: ['health'],
      risk: 'medium',
      rationale: '요구사항의 그 부분',
      contradiction: { verdict: 'none' },
    });
    const scenario = ScenarioSchema.parse({
      name: 'requirement-rejudge-test',
      description: '요구사항 수정 뒤 재판단: 대체 → 유지',
      roles: {
        'rule-writer': {
          sessions: [
            {
              when: { requirementDisplayId: 'REQ-001' },
              turns: [
                {
                  tool: 'propose_rule',
                  args: proposal('서버 시각', 'time', '응답 시점의 서버 시각'),
                },
              ],
              result,
            },
            {
              when: { judgment: 'requirement_updated' },
              turns: [
                {
                  tool: 'supersede_rule',
                  args: {
                    ...proposal('서버 시각(UTC)', 'time', 'UTC 기준 서버 시각'),
                    ruleId: '{{ruleId}}',
                    grounds:
                      '고친 본문이 UTC를 요구해 "time 필드에 응답 시점의 서버 시각을"을 바꾼다',
                  },
                },
              ],
              result,
            },
            {
              when: { judgment: 'requirement_updated' },
              turns: [
                { tool: 'uphold_rule', args: { ruleId: '{{ruleId}}', grounds: '그대로 맞음' } },
              ],
              result,
            },
          ],
        },
      },
    });
    const h = await start(DAILY, null, scenario);
    const list = async () =>
      (await h.client.call('run.list', { projectId: h.projectId })).runs.map((run) => ({
        displayId: run.displayId,
        status: run.status,
        targetRuleIds: run.targetRuleIds,
        startedBy: run.startedBy,
      }));
    const { requirement, rules } = await saveRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    const [rule1] = rules;
    if (rule1 === undefined) throw new Error('규칙 없음');
    await waitFor(
      async () =>
        (await list()).every((run) => run.status === 'merged') && (await list()).length === 1,
      30_000,
      'EXE-001 병합',
    );

    // 사람이 본문을 고친다 → 재판단 세션이 RULE-001을 RULE-002로 대체 → 세션 종료 뒤 RULE-002의 실행 1개 자동 시작
    await h.client.call('requirement.update', {
      projectId: h.projectId,
      id: requirement.id,
      text: '헬스 체크 응답에 UTC 기준 서버 시각 포함',
      author: human,
    });
    await h.orchestrator.ruleWriter.whenSettled(h.projectId, requirement.id);
    const listed = (await h.client.call('rule.list', { projectId: h.projectId })).rules.map(
      (entry) => entry.rule,
    );
    expect(listed.map((rule) => rule.displayId)).toEqual(['RULE-002']);
    const [rule2] = listed;
    if (rule2 === undefined) throw new Error('새 규칙 없음');
    expect(rule2.parentRequirementId).toBe(requirement.id);
    await waitFor(
      async () =>
        (await list()).length === 2 && (await list()).every((run) => run.status === 'merged'),
      30_000,
      'EXE-002 병합',
    );
    const changes = await h.client.call('normChange.list', { projectId: h.projectId });
    expect(changes.chain.valid).toBe(true);
    expect(changes.entries.map((entry) => [entry.seq, entry.kind, entry.targetRef.id])).toEqual([
      [1, 'created', rule1.id],
      [2, 'judgment', rule1.id],
      [3, 'auto_start', expect.any(String)],
      [4, 'created', rule2.id],
      [5, 'judgment', rule2.id],
      [6, 'judgment', rule1.id],
      [7, 'superseded', rule1.id],
      [8, 'auto_start', expect.any(String)],
    ]);
    expect(changes.entries[5]?.detail.judgment).toMatchObject({
      subject: 'requirement_change',
      verdict: 'superseded',
      createdSeq: 4,
      requirementChange: { change: 'updated' },
    });
    const runs = await list();
    expect(runs[1]).toEqual({
      displayId: 'EXE-002',
      status: 'merged',
      targetRuleIds: [rule2.id],
      startedBy: { kind: 'orchestrator', causeSeqs: [4] },
    });

    // 유지만 한 재판단: 새 규칙이 없으므로 실행이 생기지 않는다
    await h.client.call('requirement.update', {
      projectId: h.projectId,
      id: requirement.id,
      text: '헬스 체크 응답에 UTC 기준 서버 시각을 포함',
      author: human,
    });
    await h.orchestrator.ruleWriter.whenSettled(h.projectId, requirement.id);
    await h.orchestrator.ruleWriter.idle();
    expect(await list()).toHaveLength(2);
    const after = await h.client.call('normChange.list', { projectId: h.projectId });
    expect(after.entries.slice(8).map((entry) => [entry.kind, entry.targetRef.id])).toEqual([
      ['judgment', rule2.id],
    ]);
    const { entries } = await h.client.call('ruleWriter.status', {
      projectId: h.projectId,
      requirementId: requirement.id,
    });
    expect(entries).toEqual([
      expect.objectContaining({ state: 'ended', endReason: 'success', autoStart: null }),
    ]);
  }, 90_000);

  it('자동 시작 실행도 프로젝트당 진행 중 1개 · 실행 대기를 따른다: 앞 실행이 도는 동안 생긴 자동 시작 실행들은 실행 대기, 앞 실행이 끝나면 생성 순으로 하나씩 시작한다', async () => {
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
      async () => (await list()).some(([id, state]) => id === 'EXE-004' && state === 'queued'),
      20_000,
      'EXE-004 실행 대기',
    );
    // 요구사항 2개 × 규칙 2개 = 실행 4개. 진행 중은 늘 1개
    expect(await list()).toEqual([
      ['EXE-001', 'running', 'orchestrator'],
      ['EXE-002', 'queued', 'orchestrator'],
      ['EXE-003', 'queued', 'orchestrator'],
      ['EXE-004', 'queued', 'orchestrator'],
    ]);
    gates.open('EXE-001');
    await waitFor(() => gates.waiting.includes('EXE-002'), 20_000, 'EXE-002 시작');
    expect(await list()).toEqual([
      ['EXE-001', 'merged', 'orchestrator'],
      ['EXE-002', 'running', 'orchestrator'],
      ['EXE-003', 'queued', 'orchestrator'],
      ['EXE-004', 'queued', 'orchestrator'],
    ]);
    gates.open('EXE-002');
    await waitFor(() => gates.waiting.includes('EXE-003'), 20_000, 'EXE-003 시작');
    gates.open('EXE-003');
    await waitFor(() => gates.waiting.includes('EXE-004'), 20_000, 'EXE-004 시작');
    gates.open('EXE-004');
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
      [5, [1]],
      [6, [3]],
      [11, [7]],
      [12, [9]],
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
            targetBlocks: ['health'],
            risk: 'medium',
            parentRequirementId: h.requirementId,
          },
          rationale: '시험 근거',
          author: { kind: 'agent', role: 'rule-writer' },
          sessionId,
          contradiction: { verdict: 'none' },
          normInput: {
            requirements: { total: 1, included: 1, omitted: 0 },
            rules: { total: 0, included: 0, omitted: 0 },
            truncated: false,
          },
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
  it('규칙 N개면 실행 N개를 신규 기록 순서대로 만든다: 실행마다 대상 규칙 1개 · 원인 1건 · 자동 시작 항목 1건', () => {
    const h = storeHarness();
    const session = newId();
    const made = [
      makeRule(h, session, '서버 시각'),
      makeRule(h, session, '버전'),
      makeRule(h, session, '호스트'),
    ];
    const outcome = h.read((store) => autoStartRun(store, { sessionId: session }, clock));
    if (outcome.status !== 'started') throw new Error(`시작 안 됨: ${outcome.status}`);
    expect(
      outcome.runs.map(({ detail }) => ({
        displayId: detail.run.displayId,
        status: detail.run.status,
        currentStep: detail.run.currentStep,
        targetRuleIds: detail.run.targetRuleIds,
        startedBy: detail.run.startedBy,
      })),
    ).toEqual(
      made.map((cause, index) => ({
        displayId: `EXE-00${String(index + 1)}`,
        status: 'waiting_approval',
        currentStep: 'approval',
        targetRuleIds: [cause.targetRef.id],
        startedBy: { kind: 'orchestrator', causeSeqs: [cause.seq] },
      })),
    );
    expect(
      outcome.runs.map(({ normChange }) => [normChange.targetRef.id, normChange.detail]),
    ).toEqual(
      outcome.runs.map(({ detail }, index) => [
        detail.run.id,
        { causeSeqs: [made[index]?.seq], ruleIds: [made[index]?.targetRef.id] },
      ]),
    );
    // 저장된 상태도 같다: 실행 3개 · 자동 시작 항목 3건 · 승인 기록 없음, 원인 순번이 겹치지 않는다
    expect(h.read(counts)).toEqual({ runs: 3, autoStarts: 3, approvals: 0 });
    expect(
      h.read((store) =>
        store.normChanges
          .list()
          .filter((entry) => entry.kind === 'auto_start')
          .map((entry) => entry.detail.causeSeqs),
      ),
    ).toEqual(made.map((cause) => [cause.seq]));
  });

  it('같은 세션으로 두 번 불러도 실행 수가 늘지 않는다: 둘째는 기록 없이 이미 만든 실행들을 돌려준다', () => {
    const h = storeHarness();
    const session = newId();
    makeRule(h, session, '서버 시각');
    makeRule(h, session, '버전');
    const first = h.read((store) => autoStartRun(store, { sessionId: session }, clock));
    if (first.status !== 'started') throw new Error(`시작 안 됨: ${first.status}`);
    expect(first.runs).toHaveLength(2);
    const second = h.read((store) => autoStartRun(store, { sessionId: session }, clock));
    expect(second).toEqual({
      status: 'duplicate',
      runIds: first.runs.map(({ detail }) => detail.run.id),
    });
    expect(h.read(counts)).toEqual({ runs: 2, autoStarts: 2, approvals: 0 });
    // 다른 세션의 규칙은 따로 실행 (원인 순번이 겹치지 않음)
    const other = newId();
    makeRule(h, other, '응답 형식');
    expect(h.read((store) => autoStartRun(store, { sessionId: other }, clock)).status).toBe(
      'started',
    );
    expect(h.read(counts)).toEqual({ runs: 3, autoStarts: 3, approvals: 0 });
  });

  it('멱등: 원인 중 일부만 자동 시작 항목에 쓰인 상태(저장소 밖 변조)면 나머지를 채우지 않고 아무것도 만들지 않는다', () => {
    const h = storeHarness();
    const session = newId();
    const a = makeRule(h, session, '서버 시각');
    makeRule(h, session, '버전');
    // 첫 원인만 쓰는 자동 시작 항목 (제품은 N건을 한 트랜잭션에 쓰므로 이 상태는 저장소 밖에서만 생긴다)
    const forged = newId();
    h.read((store) =>
      store.normChanges.append({
        at: new Date().toISOString(),
        kind: 'auto_start',
        actor: { kind: 'orchestrator' },
        targetRef: { entity: 'Run', id: forged },
        sessionId: null,
        runId: forged,
        reason: null,
        detail: { causeSeqs: [a.seq], ruleIds: [a.targetRef.id] },
      }),
    );
    expect(h.read((store) => autoStartRun(store, { sessionId: session }, clock))).toEqual({
      status: 'duplicate',
      runIds: [forged],
    });
    expect(h.read(counts)).toEqual({ runs: 0, autoStarts: 1, approvals: 0 });
    expect(h.read((store) => store.sequences.last('EXE'))).toBe(0);
    expect(h.read((store) => store.autoStartSkips.get(session))).toBeNull();
  });

  it('세션이 만든 규칙이 없으면 아무것도 남기지 않는다 (다른 세션 · 사람이 만든 규칙은 원인이 아니다)', () => {
    const h = storeHarness();
    makeRule(h, newId(), '서버 시각');
    expect(h.read((store) => autoStartRun(store, { sessionId: newId() }, clock))).toEqual({
      status: 'no_rules',
    });
    expect(h.read(counts)).toEqual({ runs: 0, autoStarts: 0, approvals: 0 });
  });

  it('하루 한도 비움 · 설정 미비 · 오늘 지출이 하루 한도에 이름이면 규칙 N개 모두 실행을 만들지 않고 세션마다 생략 기록 1건을 남긴다 (다시 불러도 1건)', () => {
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
      // 규칙 2개를 만든 세션: 실행은 하나도 만들지 않고 생략 기록은 세션마다 1건이다
      makeRule(h, session, '서버 시각');
      makeRule(h, session, '버전');
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
        runIds: [],
      });
      expect(h.read(counts), name).toEqual({ runs: 0, autoStarts: 0, approvals: 0 });
      expect(
        h.read((store) => store.db.prepare('SELECT count(*) AS n FROM auto_start_skips').get()),
        name,
      ).toEqual({ n: 1 });
      expect(
        h.read((store) => store.sequences.last('EXE')),
        name,
      ).toBe(0);
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

  it('대상 규칙 하나가 그사이 삭제됐으면 던지고 앞 규칙의 실행도 남기지 않는다(트랜잭션 1개)', () => {
    const h = storeHarness();
    const session = newId();
    makeRule(h, session, '서버 시각');
    const created = makeRule(h, session, '버전');
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

  it('원자성: 규칙 3개 중 k번째 자동 시작 항목 쓰기만 실패하면(k = 1 · 2 · 3) 앞서 저장한 실행 · 항목까지 실행 · 표시 ID 순번 · 단계 · 생략 기록이 하나도 남지 않고 엔진을 부르지 않는다', () => {
    for (const k of [1, 2, 3]) {
      const name = `k=${String(k)}`;
      const h = storeHarness();
      const session = newId();
      for (const title of ['서버 시각', '버전', '호스트']) makeRule(h, session, title);
      // k번째 자동 시작 항목 쓰기만 막는다 (그 앞의 실행 · 항목 저장과 k번째 실행 저장 · 순번 증가는 먼저 일어난다)
      h.read((store) =>
        store.db.exec(`CREATE TRIGGER test_block_auto_start BEFORE INSERT ON norm_changes
          WHEN NEW.kind = 'auto_start'
            AND (SELECT count(*) FROM norm_changes WHERE kind = 'auto_start') = ${String(k - 1)}
          BEGIN SELECT RAISE(ABORT, 'test: auto_start 쓰기 실패'); END;`),
      );
      expect(
        () => h.read((store) => autoStartRun(store, { sessionId: session }, clock)),
        name,
      ).toThrow(/auto_start 쓰기 실패/);
      const left = () =>
        h.read((store) => ({
          ...counts(store),
          exe: store.sequences.last('EXE'),
          skip: store.autoStartSkips.get(session),
          steps: store.db.prepare('SELECT count(*) AS n FROM steps').get(),
          targets: store.db.prepare('SELECT count(*) AS n FROM run_target_rules').get(),
        }));
      expect(left(), name).toEqual({
        runs: 0,
        autoStarts: 0,
        approvals: 0,
        exe: 0,
        skip: null,
        steps: { n: 0 },
        targets: { n: 0 },
      });
      // 창구로 불러도 같다: 로그만 남기고 엔진의 생성 뒤 처리를 한 번도 부르지 않는다
      const created: string[] = [];
      const logs: string[] = [];
      const starter = new AutoStarter({
        biveHome: h.biveHome,
        engine: { onRunCreated: (_p, runId) => created.push(runId) },
        log: (line) => logs.push(line),
      });
      expect(starter.afterRuleWriterSession(h.projectId, session, 'success'), name).toBeNull();
      expect(created, name).toEqual([]);
      expect(logs, name).toEqual([
        expect.stringMatching(/^실행 자동 시작 실패 .*auto_start 쓰기 실패/),
      ]);
      expect(left(), name).toMatchObject({ runs: 0, autoStarts: 0, exe: 0, skip: null });
      // 막은 것을 풀면 같은 세션으로 다시 시작할 수 있다 (실패가 중복 표시를 남기지 않았다)
      h.read((store) => store.db.exec('DROP TRIGGER test_block_auto_start'));
      expect(starter.afterRuleWriterSession(h.projectId, session, 'success')?.status, name).toBe(
        'started',
      );
      expect(created, name).toHaveLength(3);
      expect(h.read(counts), name).toEqual({ runs: 3, autoStarts: 3, approvals: 0 });
    }
  });

  it('원자성: 생략 기록 쓰기가 실패하면 던지고 생략 기록 · 실행 · 자동 시작 항목이 하나도 남지 않는다', () => {
    const h = storeHarness(COMPLETE_SETTINGS);
    const session = newId();
    makeRule(h, session, '서버 시각');
    h.read((store) =>
      store.db.exec(`CREATE TRIGGER test_block_skip BEFORE INSERT ON auto_start_skips
        BEGIN SELECT RAISE(ABORT, 'test: 생략 기록 쓰기 실패'); END;`),
    );
    expect(() => h.read((store) => autoStartRun(store, { sessionId: session }, clock))).toThrow(
      /생략 기록 쓰기 실패/,
    );
    expect(
      h.read((store) => ({
        ...counts(store),
        exe: store.sequences.last('EXE'),
        skips: store.db.prepare('SELECT count(*) AS n FROM auto_start_skips').get(),
      })),
    ).toEqual({ runs: 0, autoStarts: 0, approvals: 0, exe: 0, skips: { n: 0 } });
  });
});

// ── 폐기 · 대체 뒤 자동 시작 (M7-09 #221 수용 기준 4, ADR-100 A4, ADR-112) ─────────────

/** seedProject의 RULE-001 진술을 글자 그대로 인용한 근거. */
const SEED_GROUNDS =
  'RULE-001 진술 "time 필드에 서버 시각을 담는다"는 새 요구사항(서버 시각 제거)과 동시에 만족될 수 없다';
const NORM_INPUT_ONE = {
  requirements: { total: 1, included: 1, omitted: 0 },
  rules: { total: 1, included: 1, omitted: 0 },
  truncated: false,
} as const;

/** 규칙 작성 역할이 세션 `sessionId`에서 RULE-001(또는 `ruleId`)을 대체한 것과 같은 기록. 새 규칙의 신규 기록을 돌려준다. */
const supersedeRule = (
  h: StoreHarness,
  sessionId: string,
  title: string,
  ruleId = 'RULE-001',
): NormChangeEntry =>
  h.read(
    (store) =>
      supersedeAgentRule(
        store,
        {
          payload: {
            title,
            statement: `WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL ${title}을 담지 않는다`,
            kind: 'business',
            checkKinds: ['test'],
            targetBlocks: ['health'],
            risk: 'medium',
            parentRequirementId: h.requirementId,
          },
          rationale: '시험 근거',
          author: { kind: 'agent', role: 'rule-writer' },
          sessionId,
          contradiction: { verdict: 'none' },
          normInput: NORM_INPUT_ONE,
          ruleId,
          grounds: SEED_GROUNDS,
        },
        clock,
      ).normChange,
  );

describe('autoStartRun: 폐기 · 대체 뒤 (M7-09 #221 수용 기준 4, ADR-100 A4, ADR-112)', () => {
  it('대체한 세션: 새 규칙의 신규 기록이 원인이 되어 새 규칙의 실행 1개가 생기고(옛 규칙의 실행은 없음), 엔진의 시작 근거 대조 · 승인 단계 자리를 통과한다', () => {
    const h = storeHarness();
    const session = newId();
    const created = supersedeRule(h, session, '서버 시각');
    const outcome = h.read((store) => autoStartRun(store, { sessionId: session }, clock));
    if (outcome.status !== 'started') throw new Error(`시작 안 됨: ${outcome.status}`);
    expect(outcome.runs).toHaveLength(1);
    const [only] = outcome.runs;
    if (only === undefined) throw new Error('실행 없음');
    expect(only.detail.run.targetRuleIds).toEqual([created.targetRef.id]);
    expect(only.detail.run.startedBy).toEqual({ kind: 'orchestrator', causeSeqs: [created.seq] });
    // 원인은 신규(created) 기록 하나다: 판단 · 대체 기록은 원인이 아니다
    expect(h.read((store) => store.normChanges.list().map((entry) => entry.kind))).toEqual([
      'created',
      'judgment',
      'superseded',
      'auto_start',
    ]);
    h.read((store) => {
      expect(checkRunStartBasis(store, only.detail.run).mismatch).toBeNull();
      expect(evaluateApprovalStep(store, only.detail.run.id, clock)).toMatchObject({
        approved: true,
        unapprovedRuleIds: [],
      });
    });
    expect(h.read(counts)).toEqual({ runs: 1, autoStarts: 1, approvals: 0 });
  });

  it('폐기만 한 세션: 새 규칙이 없으므로 실행 · 자동 시작 항목 · 생략 기록이 생기지 않는다', () => {
    const h = storeHarness();
    const session = newId();
    h.read((store) =>
      retireAgentRule(
        store,
        {
          ruleId: 'RULE-001',
          grounds: SEED_GROUNDS,
          author: { kind: 'agent', role: 'rule-writer' },
          sessionId: session,
        },
        clock,
      ),
    );
    expect(h.read((store) => autoStartRun(store, { sessionId: session }, clock))).toEqual({
      status: 'no_rules',
    });
    expect(h.read(counts)).toEqual({ runs: 0, autoStarts: 0, approvals: 0 });
    expect(h.read((store) => store.autoStartSkips.get(session))).toBeNull();
  });

  it('한 세션이 propose_rule · supersede_rule · retire_rule을 섞어 부르면 새 규칙마다 실행 1개가 신규 기록 순서(생성 · 대체 · 생성)대로 생기고, 폐기는 실행을 더하지 않는다', () => {
    const h = storeHarness();
    const session = newId();
    const first = makeRule(h, session, '버전');
    const second = supersedeRule(h, session, '서버 시각');
    const third = makeRule(h, session, '호스트');
    // 같은 세션이 방금 만든 규칙을 폐기해도 그 규칙의 신규 기록은 원인으로 남지만, 실행은 승인 단계 자리에서 끝난다
    const retiredRule = makeRule(h, session, '지역');
    h.read((store) =>
      retireAgentRule(
        store,
        {
          ruleId: retiredRule.targetRef.id,
          // 인용은 EARS 틀 글자를 빼고 다른 규칙과 겹치지 않는 조각이어야 한다 (M7-11 #223, ADR-115)
          grounds: '진술 "를 요청하면 THE SYSTEM SHALL 지역을 담는다"는 필요 없다',
          author: { kind: 'agent', role: 'rule-writer' },
          sessionId: session,
        },
        clock,
      ),
    );
    const outcome = h.read((store) => autoStartRun(store, { sessionId: session }, clock));
    if (outcome.status !== 'started') throw new Error(`시작 안 됨: ${outcome.status}`);
    expect(
      outcome.runs.map(({ detail }) => [detail.run.displayId, detail.run.targetRuleIds]),
    ).toEqual([
      ['EXE-001', [first.targetRef.id]],
      ['EXE-002', [second.targetRef.id]],
      ['EXE-003', [third.targetRef.id]],
      ['EXE-004', [retiredRule.targetRef.id]],
    ]);
    expect(outcome.runs.map(({ normChange }) => normChange.detail.causeSeqs)).toEqual([
      [first.seq],
      [second.seq],
      [third.seq],
      [retiredRule.seq],
    ]);
    // 폐기된 규칙의 실행은 승인 단계 자리(효력 확인)에서 효력 없음이다 (사람을 기다리지 않고 끝난다)
    h.read((store) => {
      const last = outcome.runs[3];
      if (last === undefined) throw new Error('실행 없음');
      expect(evaluateApprovalStep(store, last.detail.run.id, clock)).toMatchObject({
        approved: false,
        unapprovedRuleIds: [retiredRule.targetRef.id],
      });
    });
  });

  it('실행 대기 중인 실행의 대상 규칙이 대체되면 시작할 차례의 재검사에서 효력 없음(target_rule_unavailable)으로 끝나고 다음 대기(새 규칙의 실행)가 시작된다', () => {
    const h = storeHarness();
    const at = () => new Date().toISOString();
    const holderSession = newId();
    makeRule(h, holderSession, '버전');
    const holder = h.read((store) => autoStartRun(store, { sessionId: holderSession }, clock));
    if (holder.status !== 'started') throw new Error('시작 안 됨');
    const replaceSession = newId();
    const oldRunId = h.read((store) => {
      const [first] = holder.runs;
      if (first === undefined) throw new Error('실행 없음');
      expect(evaluateApprovalStep(store, first.detail.run.id, clock).run.status).toBe('running');
      // 옛 규칙(RULE-001)의 사람 [실행]은 자리가 없어 실행 대기
      const rule = store.rules.list().find((item) => item.displayId === 'RULE-001');
      if (rule === undefined) throw new Error('규칙 없음');
      const old = createRun(
        store,
        { ruleIds: [rule.id], author: human },
        { clientId: null },
        clock,
      ).run;
      expect(evaluateApprovalStep(store, old.id, clock).run.status).toBe('queued');
      return old.id;
    });
    supersedeRule(h, replaceSession, '서버 시각');
    const replaced = h.read((store) => autoStartRun(store, { sessionId: replaceSession }, clock));
    if (replaced.status !== 'started') throw new Error('시작 안 됨');
    const [newRun] = replaced.runs;
    if (newRun === undefined) throw new Error('실행 없음');
    const advance = h.read((store) => {
      expect(evaluateApprovalStep(store, newRun.detail.run.id, clock).run.status).toBe('queued');
      const [first] = holder.runs;
      if (first === undefined) throw new Error('실행 없음');
      // 앞 실행이 끝났다 (엔진 없이 저장만)
      store.runs.transition(first.detail.run.id, {
        expectedStatus: 'running',
        run: { status: 'failed', failureReason: 'scripted_halt', endedAt: at() },
      });
      return startNextQueuedRun(store, clock);
    });
    expect(
      advance.failed.map((detail) => [detail.run.id, detail.run.status, detail.run.failureReason]),
    ).toEqual([[oldRunId, 'failed', 'target_rule_unavailable']]);
    expect(advance.started?.run).toMatchObject({ id: newRun.detail.run.id, status: 'running' });
  });
});

describe('AutoStarter: 세션 종료 알림 → 자동 시작 → 엔진 (ADR-107)', () => {
  it('정상 종료만 자동 시작하고 엔진의 생성 뒤 처리를 실행마다 한 번, 만든 순서대로 부른다. 정상 종료가 아니면 아무것도 하지 않는다', () => {
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
    makeRule(h, session, '버전');
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
    // 실행마다 한 번, 만든 순서대로 (엔진이 그 순서로 판정해 첫 실행이 자리를 잡는다)
    expect(created).toEqual(outcome.runs.map(({ detail }) => `${h.projectId}:${detail.run.id}`));
    expect(created).toHaveLength(2);
    // 같은 세션을 다시 알려도 엔진을 다시 부르지 않는다
    expect(starter.afterRuleWriterSession(h.projectId, session, 'success')?.status).toBe(
      'duplicate',
    );
    expect(created).toHaveLength(2);
    expect(logs).toEqual([
      `실행 자동 시작 (EXE-001, 규칙 1건, 규범 변경 기록 5)`,
      `실행 자동 시작 (EXE-002, 규칙 1건, 규범 변경 기록 6)`,
    ]);
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

  it('자동 시작 저장 뒤 엔진에 알리기 전에 프로세스가 끝나 승인 대기로 남은 실행들은 다음 기동이 생성 순으로 판정해 하나씩 끝까지 간다 (시작 근거 대조 통과, 진행 중 1개)', async () => {
    const h = storeHarness();
    const session = newId();
    makeRule(h, session, '서버 시각');
    makeRule(h, session, '버전');
    const outcome = h.read((store) => autoStartRun(store, { sessionId: session }, clock));
    if (outcome.status !== 'started') throw new Error('시작 안 됨');
    let maxRunning = 0;
    const engine = new PipelineEngine({
      biveHome: h.biveHome,
      agent: selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome: h.biveHome }).adapter,
      executors: { ...testExecutors(), ...gatedExecutors(null) },
      onEvent: (event) => {
        if (event.type !== 'run.saved') return;
        maxRunning = Math.max(
          maxRunning,
          h.read((store) => store.runs.list({ status: 'running' }).length),
        );
      },
    });
    engines.push(engine);
    expect(engine.recoverInterruptedRuns()).toEqual([]);
    engine.startQueuedRuns();
    await engine.settled();
    expect(
      outcome.runs.map(({ detail }) => h.read((store) => store.runs.get(detail.run.id))),
    ).toMatchObject([
      { displayId: 'EXE-001', status: 'merged', failureReason: null },
      { displayId: 'EXE-002', status: 'merged', failureReason: null },
    ]);
    expect(maxRunning).toBe(1);
    expect(h.read(counts)).toEqual({ runs: 2, autoStarts: 2, approvals: 0 });
  }, 60_000);
});

describe('변이 생존의 자동 테스트 보강: 기존 자동 시작의 문과 시작 근거 (M3-54 #311 수용 기준 2, ADR-141 ② · ③ · ADR-143)', () => {
  afterEach(cleanupMutationHarness, 60_000);

  const AUTO = { ...COMPLETE_SETTINGS, dailyBudgetUsd: 10 };
  const SURVIVING = {
    rules: [{ blocks: ['health'], risk: 'medium' as const }],
    sessions: { 'RULE-001': [{ tool: 'propose_mutant', args: VALID } as const] },
    decide: allPass,
    noAutoStart: true,
  };
  const clock = { now: Date.now, newId };
  const reinforce = (h: MutationHarness) =>
    withProject(h.biveHome, h.projectId, (store) =>
      reinforceSurvivedMutants(store, { runId: h.runId }, clock),
    );

  it('생존이면 유형 C 보강 실행 1개(대상 = 그 규칙, 시작 주체 = 오케스트레이터, 원인 = 그 변이 기록)와 자동 시작 항목 1건, 엔진의 시작 근거 대조를 지난다', async () => {
    const h = setupMutation({ ...SURVIVING, settings: AUTO });
    await mutationRunToEnd(h);
    const outcome = reinforce(h);
    if (outcome.status !== 'started') throw new Error(`보강 실행 없음: ${outcome.status}`);
    const [{ detail, normChange }] = outcome.runs as [AutoStartedRun];
    const survived = withProject(h.biveHome, h.projectId, (store) =>
      store.mutations.listByRun(h.runId),
    )[0]!;
    expect(detail.run).toMatchObject({
      type: 'C',
      status: 'waiting_approval',
      targetRuleIds: [survived.ruleId],
      startedBy: { kind: 'orchestrator', causeLog: 'mutation_reinforcements' },
    });
    expect(normChange).toMatchObject({
      kind: 'auto_start',
      actor: { kind: 'orchestrator' },
      targetRef: { entity: 'Run', id: detail.run.id },
      detail: { mutationResultIds: [survived.id], ruleIds: [survived.ruleId] },
    });
    expect(
      withProject(h.biveHome, h.projectId, (store) => checkRunStartBasis(store, detail.run)),
    ).toEqual({ mismatch: null, runStartEntries: 0, autoStartEntries: 1 });
  }, 90_000);

  it.each([
    ['하루 한도 비움', { dailyBudgetUsd: null }, 'project_daily_budget_unset'],
    [
      '하루 한도에 이름',
      { ...COMPLETE_SETTINGS, dailyBudgetUsd: 0 },
      'project_daily_budget_exceeded',
    ],
  ] as const)(
    '기존 문(%s)에 걸리면 보강 실행을 만들지 않는다 (기록 없음)',
    async (_name, settings, reason) => {
      const h = setupMutation({ ...SURVIVING, settings: AUTO });
      await mutationRunToEnd(h);
      withProject(h.biveHome, h.projectId, (store) =>
        store.settings.update(settings, { by: human, at: new Date().toISOString() }),
      );
      expect(reinforce(h)).toEqual({ status: 'skipped', reason });
      expect(
        withProject(h.biveHome, h.projectId, (store) => store.runs.list().map((run) => run.type)),
      ).toEqual(['A']);
    },
    90_000,
  );

  it('설정이 비면(변이 주입 역할 칸) 만들지 않는다', async () => {
    const h = setupMutation({ ...SURVIVING, settings: AUTO });
    await mutationRunToEnd(h);
    withProject(h.biveHome, h.projectId, (store) =>
      store.settings.update(
        { roles: { mutator: { model: null } } },
        { by: human, at: new Date().toISOString() },
      ),
    );
    expect(reinforce(h)).toEqual({ status: 'skipped', reason: 'settings_incomplete' });
  }, 90_000);

  it('그 사이 규칙이 효력을 잃었으면 만들지 않는다', async () => {
    const h = setupMutation({ ...SURVIVING, settings: AUTO });
    await mutationRunToEnd(h);
    withProject(h.biveHome, h.projectId, (store) =>
      store.db
        .prepare("UPDATE rules SET norm_state = 'provisional' WHERE id = ?")
        .run(h.rules[0]!.id),
    );
    expect(reinforce(h)).toEqual({ status: 'none' });
  }, 90_000);

  it('위조한 원인은 시작 근거 대조가 거부한다: 연결 없는 원인 · 다른 기록을 가리키는 항목 · 유형 A 보강', async () => {
    const h = setupMutation({ ...SURVIVING, settings: AUTO });
    await mutationRunToEnd(h);
    const outcome = reinforce(h);
    if (outcome.status !== 'started') throw new Error('보강 실행 없음');
    const real = outcome.runs[0]!.detail.run;
    const check = (run: typeof real) =>
      withProject(h.biveHome, h.projectId, (store) => checkRunStartBasis(store, run).mismatch);
    // 시작 주체의 순번이 이 실행의 연결이 아님 (다른 순번)
    expect(check({ ...real, startedBy: { ...real.startedBy, causeSeqs: [99] } as never })).toBe(
      'cause_mismatch',
    );
    // 유형 C가 아닌 실행이 같은 원인을 쓴다
    expect(check({ ...real, type: 'A' })).toBe('cause_mismatch');
    // 연결은 없고 자동 시작 항목만 있는 실행 (오케스트레이터 밖에서 쓴 위조 항목)
    const forged = withProject(h.biveHome, h.projectId, (store) => {
      const settings = store.settings.get();
      const runId = newId();
      const saved = saveNewRun(
        store,
        settings,
        {
          runId,
          ruleIds: [real.targetRuleIds[0]!],
          type: 'C',
          startedBy: { kind: 'orchestrator', causeSeqs: [7], causeLog: 'mutation_reinforcements' },
        },
        new Date().toISOString(),
        newId,
      );
      store.normChanges.append({
        at: new Date().toISOString(),
        kind: 'auto_start',
        actor: { kind: 'orchestrator' },
        targetRef: { entity: 'Run', id: runId },
        sessionId: null,
        runId,
        reason: '위조',
        detail: {
          mutationResultIds: [store.mutations.reinforcementOfRun(real.id)!.mutationResultId],
          ruleIds: [real.targetRuleIds[0]!],
        },
      });
      return saved.run;
    });
    expect(check(forged)).toBe('cause_mismatch');
  }, 90_000);
});
