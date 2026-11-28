// 검토 대기열의 예산 초과 액션: 규칙 분할 (M3-57 #320, TODO-02 · NRM-02 · NRM-07 · NFR-01, ADR-100 B⑨ · C2 · D6, ADR-147 ⑧, ADR-153).
// 제품 오케스트레이터(`startOrchestrator`)를 이 프로세스에서 띄우고 앱과 같은 파이프 RPC로 조작한다: 요구사항 저장 → 규칙 작성 세션
// (ScriptedAdapter, 규칙 2개) → 사람의 [실행](대상 규칙 2개) → 테스트 작성 단계가 예산 초과로 끝남 → 검토 대기열의 예산 초과 항목 →
// `reviewQueue.splitRule`(사람) → 규칙 작성 역할의 분할 세션이 나눌 규칙을 새 규칙 2개로 대체 → 항목 처리 · 새 규칙마다 실행 자동 시작.
// 단계 실행기는 시험용이다(첫 실행의 테스트 작성만 예산 초과, 나머지는 통과 · 실제 git 병합). 반영의 원자성은 열린 저장소에서 직접 본다.
import fs from 'node:fs';
import path from 'node:path';

import {
  type Author,
  DomainErrorReason,
  ErrorCode,
  type NormChangeEntry,
  type Rule,
  RUN_STEP_PLANS,
  type SettingsPatch,
  STEP_ROLES,
} from '@bive/shared';
import type { ProjectStore } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import { type Scenario, ScenarioSchema } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import type { StepExecutor, StepExecutors } from '../src/engine/types.js';
import { createAgentRule, retireAgentRule, splitAgentRule } from '../src/norms/agent-rule.js';
import { type Orchestrator, startOrchestrator } from '../src/orchestrator.js';
import { splitSettlement, splitTarget } from '../src/review/review-queue.js';
import { reinforceSurvivedMutants } from '../src/runs/auto-start.js';
import { createRun, evaluateApprovalStep } from '../src/runs/run-service.js';
import { SplitRuleInput } from '../src/tools/definitions.js';
import { runEnding } from '../src/engine/run-ending.js';
import { connect, RpcCallError, type TestClient } from './helpers/client.js';
import {
  COMPLETE_SETTINGS,
  copyFixture,
  human,
  mergeStep,
  newId,
  seedNormRule,
  seedProject,
  withProject,
} from './helpers/engine-harness.js';
import { makeBiveHome, waitFor } from './helpers/process.js';

const temps: string[] = [];
const running: { orchestrator: Orchestrator; client: TestClient }[] = [];

afterEach(async () => {
  for (const { orchestrator, client } of running.splice(0)) {
    client.destroy();
    await orchestrator.stop();
  }
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}, 60_000);

const clock = { now: Date.now, newId };
const at = (): string => new Date().toISOString();
const agentAuthor = { kind: 'agent', role: 'implementer' } as const satisfies Author;
const RESULT = { subtype: 'success', total_cost_usd: 0.01, num_turns: 1, modelUsage: {} };
const statement = (what: string) =>
  `WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 응답 JSON의 ${what}을 담는다`;
/** 나눌 규칙(RULE-001)의 진술: 서버 시각과 버전을 한 규칙에 */
const COMBINED = 'time 필드와 version 필드에 서버 시각과 버전';
const GROUNDS = `"${COMBINED}을"을 시각과 버전 둘로 나눈다 (한 실행이 예산 한도를 넘었다)`;

const proposal = (title: string, what: string) => ({
  parentRequirementId: '{{requirementId}}',
  title,
  statement: statement(what),
  kind: 'business',
  checkKinds: ['test'],
  targetBlocks: ['health'],
  risk: 'medium',
  behavior: 'new',
  rationale: '요구사항의 그 부분',
  contradiction: { verdict: 'none' },
});

/** 분할로 만드는 새 규칙 하나 (부모 요구사항 칸 없음). */
const piece = (title: string, what: string, behavior: 'new' | 'existing' = 'new') => ({
  title,
  statement: statement(what),
  kind: 'business',
  checkKinds: ['test'],
  targetBlocks: ['health'],
  risk: 'medium',
  behavior,
  rationale: `나누는 규칙의 ${title} 부분`,
  contradiction: { verdict: 'none' },
});

const VALID_SPLIT = {
  tool: 'split_rule',
  args: {
    ruleId: '{{ruleId}}',
    grounds: GROUNDS,
    rules: [
      piece('서버 시각', 'time 필드에 서버 시각'),
      piece('버전', 'version 필드에 버전', 'existing'),
    ],
  },
} as const;

/** 요구사항 세션: 규칙 2개(RULE-001 = 나눌 규칙, RULE-002 = 나머지 대상 규칙). 앞에 `before` 호출을 둔다. */
const requirementSession = (before: readonly Record<string, unknown>[] = []) => ({
  when: { requirementDisplayId: 'REQ-001' },
  turns: [
    ...before,
    { tool: 'propose_rule', args: proposal('서버 시각과 버전', COMBINED) },
    { tool: 'propose_rule', args: proposal('상태', 'status 필드에 상태') },
  ],
  result: RESULT,
});

const scenarioOf = (splitSessions: readonly Record<string, unknown>[]): Scenario =>
  ScenarioSchema.parse({
    name: 'rule-split-test',
    description: '예산 초과 항목의 규칙 분할',
    roles: {
      'rule-writer': {
        sessions: [
          requirementSession([
            { tool: 'split_rule', args: { ...VALID_SPLIT.args, ruleId: 'RULE-001' } },
          ]),
          ...splitSessions.map((session) => ({ when: { judgment: 'rule_split' }, ...session })),
        ],
      },
    },
  });

/** 첫 실행(EXE-001)의 테스트 작성만 예산 초과로 끝내고, 나머지 실행은 통과 · 실제 병합. */
const executors = (): StepExecutors => {
  const testWriting: StepExecutor = (context) => {
    if (context.run.displayId === 'EXE-001') {
      return Promise.resolve({
        status: 'halt',
        runStatus: 'budget_exceeded',
        reason: 'error_max_budget_usd',
      });
    }
    fs.writeFileSync(
      path.join(context.git.worktreePath, `split-${context.run.displayId}.txt`),
      'x',
    );
    return Promise.resolve({ status: 'passed' });
  };
  const pass: StepExecutor = () => Promise.resolve({ status: 'passed' });
  return {
    test_writing: testWriting,
    red_check: pass,
    green_check: pass,
    implementation: pass,
    check: pass,
    merge: mergeStep,
  };
};

interface Harness {
  readonly biveHome: string;
  readonly orchestrator: Orchestrator;
  readonly client: TestClient;
  readonly projectId: string;
  readonly requirementId: string;
  /** RULE-001 (나눌 규칙) · RULE-002 (나머지 대상 규칙) */
  readonly rules: readonly [Rule, Rule];
  /** 예산 초과로 끝난 원 실행 EXE-001 */
  readonly originId: string;
  /** 그 실행의 예산 초과 항목 */
  readonly seq: number;
  readonly logs: string[];
  read<T>(fn: (store: ProjectStore) => T): T;
}

/**
 * 오케스트레이터를 띄우고 예산 초과 항목까지 만든다: 요구사항 저장(하루 한도 비움: 규칙 작성 세션의 자동 시작은 생략) → 사람의
 * [실행](RULE-001 · RULE-002) → EXE-001 예산 초과 → 하루 한도 설정(분할로 생긴 규칙의 자동 시작이 돌도록).
 */
const prepare = async (
  scenario: Scenario,
  daily: SettingsPatch = { dailyBudgetUsd: 10 },
): Promise<Harness> => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const logs: string[] = [];
  const started = await startOrchestrator({
    biveHome,
    idleShutdownMs: 60_000,
    agent: {
      kind: 'scripted',
      adapter: new ScriptedAdapter({ scenario, biveHome, pollIntervalMs: 10 }),
      scenario: scenario.name,
    },
    executors: executors(),
    log: (line) => logs.push(line),
  });
  if (started.status !== 'started') throw new Error('기동 실패');
  const { orchestrator } = started;
  const client = await connect(orchestrator.paths.pipe, orchestrator.token);
  running.push({ orchestrator, client });
  const { project } = await client.call('project.open', { path: repo });
  await client.call('settings.update', {
    projectId: project.id,
    patch: COMPLETE_SETTINGS,
    author: human,
  });
  const { requirement } = await client.call('requirement.create', {
    projectId: project.id,
    text: '헬스 체크 응답에 서버 시각과 버전, 상태 포함',
    author: human,
  });
  await orchestrator.ruleWriter.whenSettled(project.id, requirement.id);
  const listed = (await client.call('rule.list', { projectId: project.id })).rules.map(
    (entry) => entry.rule,
  );
  const [first, second] = listed;
  if (first === undefined || second === undefined) {
    throw new Error(`규칙 2개가 아님: ${logs.join('\n')}`);
  }
  const created = await client.call('run.create', {
    projectId: project.id,
    ruleIds: [first.id, second.id],
    author: human,
  });
  const read = <T>(fn: (store: ProjectStore) => T): T => withProject(biveHome, project.id, fn);
  await waitFor(
    () => read((store) => store.runs.get(created.run.id)?.status === 'budget_exceeded'),
    30_000,
    'EXE-001 예산 초과',
  );
  await client.call('settings.update', { projectId: project.id, patch: daily, author: human });
  const item = read((store) =>
    store.reviewQueue.list({ kind: 'budget_exceeded' }).find((i) => i.runId === created.run.id),
  );
  if (item === undefined) throw new Error('예산 초과 항목 없음');
  return {
    biveHome,
    orchestrator,
    client,
    projectId: project.id,
    requirementId: requirement.id,
    rules: [first, second],
    originId: created.run.id,
    seq: item.seq,
    logs,
    read,
  };
};

const rejection = async (promise: Promise<unknown>): Promise<RpcCallError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcCallError) return error;
    throw error;
  }
  throw new Error('거부되지 않음');
};

const split = (h: Harness, ruleId: string, author: Author = human, seq = h.seq) =>
  h.client.call('reviewQueue.splitRule', { projectId: h.projectId, seq, ruleId, author });

/** 원 실행 상세 (상태 · 단계 불변 확인용). */
const originDetail = (h: Harness): NonNullable<ReturnType<ProjectStore['runs']['getDetail']>> =>
  h.read((store) => {
    const detail = store.runs.getDetail(h.originId);
    if (detail === null) throw new Error('원 실행 없음');
    return detail;
  });

/** 규범 · 실행 · 제안 · 승인 기록의 모양 (아무것도 바뀌지 않았는지). */
const snapshot = (h: Harness) =>
  h.read((store) => ({
    rules: store.rules.list().map((rule) => rule.id),
    changes: store.normChanges.list().length,
    retired: [...store.ruleRetirements.retiredRuleIds()].sort(),
    splits: store.ruleSplits.newRulesOf(h.rules[0].id),
    runs: store.runs.list().map((run) => [run.displayId, run.status]),
    proposals: store.proposals.list().length,
    approvals: store.approvalLog.list().length,
    resolution: store.reviewQueue.get(h.seq)?.resolution ?? null,
  }));

const sinceSeq = (entries: readonly NormChangeEntry[], seq: number) =>
  entries.filter((entry) => entry.seq > seq);

describe('규칙 분할: 분할 세션이 새 규칙 2개로 대체하면 항목이 처리됨 (수용 기준 1 · 2 · 3)', () => {
  it('사람의 분할 액션이 규칙 작성 역할 세션(분할 도구 하나)을 띄우고, 그 세션이 나눌 규칙을 새 규칙 2개로 대체하면 폐기 · 새 규칙 · 규범 변경 기록(사유와 근거) · 분할 기록 · 항목 처리가 남고 승인 대기 제안은 없다. 원 실행은 예산 초과 그대로, 새 규칙마다 자동 시작 실행 1개(선언대로의 유형)가 생기고 나머지 대상 규칙은 다시 시작되지 않는다', async () => {
    const h = await prepare(scenarioOf([{ turns: [VALID_SPLIT], result: RESULT }]));
    const [target, remaining] = h.rules;
    const before = originDetail(h);
    const lastSeq = h.read((store) => store.normChanges.list().at(-1)?.seq ?? 0);
    const approvalsBefore = h.read((store) => store.approvalLog.list());

    const result = await split(h, target.id);
    // 세션을 띄운 때의 항목은 열림 그대로다
    expect(result.entry.item.resolution).toBeNull();
    expect(result.entry.rules.map((rule) => rule.id)).toEqual([target.id, remaining.id]);
    await h.orchestrator.ruleWriter.idle();

    // 항목: 처리됨(규칙 분할, 주체 = 누른 사람, 결과 = 나눈 규칙)
    const item = await h.client.call('reviewQueue.get', { projectId: h.projectId, seq: h.seq });
    expect(item.entry.item.resolution).toEqual({
      action: 'split_rule',
      by: human,
      at: expect.any(String),
      reason: null,
      ruleId: target.id,
    });
    // 규칙: 나눈 규칙은 효력이 없고(목록에서 빠짐), 새 규칙 둘은 부모 요구사항을 물려받아 미확인 효력 규칙이다
    const listed = (await h.client.call('rule.list', { projectId: h.projectId })).rules.map(
      (entry) => entry.rule,
    );
    expect(listed.map((rule) => rule.displayId)).toEqual(['RULE-002', 'RULE-003', 'RULE-004']);
    const [, rule3, rule4] = listed;
    if (rule3 === undefined || rule4 === undefined) throw new Error('새 규칙 없음');
    for (const rule of [rule3, rule4]) {
      expect(rule).toMatchObject({
        parentRequirementId: h.requirementId,
        normState: 'approved',
        author: { kind: 'agent', role: 'rule-writer' },
        confirmation: { state: 'unconfirmed' },
      });
    }
    expect([rule3.statement, rule4.statement]).toEqual([
      statement('time 필드에 서버 시각'),
      statement('version 필드에 버전'),
    ]);
    // 규범 변경 기록: 새 규칙마다 신규 · 모순 판단 → 나눈 규칙의 대체(분할 상세, 사유 = 근거) → 새 규칙마다 자동 시작
    const changes = await h.client.call('normChange.list', { projectId: h.projectId });
    expect(changes.chain.valid).toBe(true);
    const written = sinceSeq(changes.entries, lastSeq);
    expect(written.map((entry) => [entry.kind, entry.targetRef.id])).toEqual([
      ['created', rule3.id],
      ['judgment', rule3.id],
      ['created', rule4.id],
      ['judgment', rule4.id],
      ['superseded', target.id],
      ['auto_start', expect.any(String)],
      ['auto_start', expect.any(String)],
    ]);
    const [created3, , created4, , superseded] = written;
    expect(superseded).toMatchObject({
      actor: { kind: 'agent', role: 'rule-writer' },
      sessionId: result.sessionId,
      reason: GROUNDS,
      detail: {
        retirement: {
          supersededBy: { id: rule3.id, displayId: 'RULE-003' },
          split: [
            { rule: { id: rule3.id, displayId: 'RULE-003' }, createdSeq: created3?.seq },
            { rule: { id: rule4.id, displayId: 'RULE-004' }, createdSeq: created4?.seq },
          ],
        },
      },
    });
    expect(created3?.reason).toBe('나누는 규칙의 서버 시각 부분');
    expect(created4?.detail.behavior).toBe('existing');
    h.read((store) => {
      expect(store.ruleRetirements.get(target.id)?.supersededBy).toBe(rule3.id);
      expect(store.ruleSplits.newRulesOf(target.id)).toEqual([rule3.id, rule4.id]);
      // 승인 대기 제안이 생기지 않고 승인 기록도 그대로다 (ADR-100 C2: 규범은 바로 효력)
      expect(store.proposals.list()).toEqual([]);
      expect(store.approvalLog.list()).toEqual(approvalsBefore);
      // 분할 세션: 규칙 작성 역할 · 실행 밖 · 부모 요구사항 · 도구는 분할 도구 하나
      expect(store.sessions.get(result.sessionId)).toMatchObject({
        role: 'rule-writer',
        runId: null,
        stepId: null,
        requirementId: h.requirementId,
        tools: ['split_rule'],
        endReason: 'success',
      });
      expect(
        store.sessions.toolCallsBySession(result.sessionId).map((call) => [call.name, call.status]),
      ).toEqual([['split_rule', 'ok']]);
    });

    // 새 규칙마다 기존 자동 시작이 실행 1개를 만든다: 선언대로 새 동작 → 유형 A, 기존 동작 → 유형 C. 둘째는 실행 대기를 거친다
    const runs = async () =>
      (await h.client.call('run.list', { projectId: h.projectId })).runs.map((run) => ({
        displayId: run.displayId,
        type: run.type,
        status: run.status,
        targetRuleIds: run.targetRuleIds,
        startedBy: run.startedBy,
      }));
    await waitFor(
      async () => (await runs()).filter((run) => run.status === 'merged').length === 2,
      60_000,
      '새 규칙 실행 둘 병합',
    );
    expect(await runs()).toEqual([
      expect.objectContaining({ displayId: 'EXE-001', status: 'budget_exceeded' }),
      {
        displayId: 'EXE-002',
        type: 'A',
        status: 'merged',
        targetRuleIds: [rule3.id],
        startedBy: { kind: 'orchestrator', causeSeqs: [created3?.seq] },
      },
      {
        displayId: 'EXE-003',
        type: 'C',
        status: 'merged',
        targetRuleIds: [rule4.id],
        startedBy: { kind: 'orchestrator', causeSeqs: [created4?.seq] },
      },
    ]);
    // 나머지 대상 규칙(RULE-002)은 그대로이고 자동으로 다시 시작되지 않았다 (ADR-147 한계)
    expect(
      (await runs())
        .filter((run) => run.targetRuleIds.includes(remaining.id))
        .map((r) => r.displayId),
    ).toEqual(['EXE-001']);
    expect(listed[0]).toMatchObject({ id: remaining.id, statement: remaining.statement });
    // 원 실행은 예산 초과 그대로다 (상태 · 단계 · 세션 불변)
    expect(originDetail(h)).toEqual(before);

    // 처리 두 번: 처리된 항목이라 거부된다. 한도 상향 재개로도 이을 수 없다(처리됨)
    const again = await rejection(split(h, remaining.id));
    expect([again.code, again.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'already_resolved' },
    ]);
    const resume = await rejection(
      h.client.call('reviewQueue.resumeWithBudget', {
        projectId: h.projectId,
        seq: h.seq,
        budget: before.run.budgetSnapshot,
        author: human,
      }),
    );
    expect([resume.code, resume.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'already_resolved' },
    ]);
  }, 120_000);

  it('분할 세션이 대체하지 않고 끝나면 항목은 열림 그대로이고 아무것도 바뀌지 않는다: 새 규칙 1개 · 같은 진술 둘 · 선언 빠짐 · 부모 요구사항 칸 · 다른 규칙 · 인용 없는 근거 · 분할 세션에 없는 도구는 모두 거부된다. 사람이 다시 누르면 새 세션이 나눈다. 요구사항 세션에서 부른 분할 도구는 없는 도구다', async () => {
    const [time, version] = VALID_SPLIT.args.rules;
    const bad = (args: Record<string, unknown>) => ({
      tool: 'split_rule',
      args: { ...VALID_SPLIT.args, ...args },
    });
    const h = await prepare(
      scenarioOf([
        {
          turns: [
            bad({ rules: [time] }),
            bad({ rules: [time, { ...version, statement: ` ${time.statement}  ` }] }),
            bad({ rules: [time, { ...version, behavior: undefined }] }),
            bad({ rules: [time, { ...version, parentRequirementId: '{{requirementId}}' }] }),
            // 다른 규칙: 근거가 나눌 규칙을 인용해도 세션이 받은 규칙이 아니면 거부
            bad({ ruleId: 'RULE-002' }),
            bad({ grounds: '나눈다 (인용 없음)' }),
            { tool: 'propose_rule', args: proposal('따로 만듦', 'host 필드에 호스트') },
            {
              tool: 'supersede_rule',
              args: {
                ...proposal('대체', 'host 필드에 호스트'),
                ruleId: '{{ruleId}}',
                grounds: GROUNDS,
              },
            },
          ],
          result: RESULT,
        },
        { turns: [VALID_SPLIT], result: RESULT },
      ]),
    );
    const [target] = h.rules;
    // 요구사항 세션(첫 세션)에서 부른 분할 도구: 그 세션의 도구 목록에 없다
    const requirementSessionCalls = h.read((store) => {
      const session = store.sessions
        .listByRequirement(h.requirementId)
        .find((item) => item.tools.includes('propose_rule'));
      return session === undefined
        ? []
        : store.sessions
            .toolCallsBySession(session.id)
            .map((call) => [call.name, call.status, call.reason]);
    });
    expect(requirementSessionCalls[0]).toEqual(['split_rule', 'denied', 'unknown_tool']);
    const before = snapshot(h);
    const origin = originDetail(h);

    const first = await split(h, target.id);
    await h.orchestrator.ruleWriter.idle();
    expect(snapshot(h)).toEqual({
      ...before,
      // 세션 기록 외에는 그대로 (규범 변경 기록 · 규칙 · 폐기 · 분할 · 실행 · 항목)
    });
    expect(h.read((store) => store.reviewQueue.get(h.seq)?.resolution)).toBeNull();
    expect(
      h.read((store) =>
        store.sessions
          .toolCallsBySession(first.sessionId)
          .map((call) => [call.name, call.status, call.reason ?? null]),
      ),
    ).toEqual([
      ['split_rule', 'denied', 'invalid_args'],
      ['split_rule', 'denied', 'invalid_args'],
      ['split_rule', 'denied', 'invalid_args'],
      ['split_rule', 'denied', 'invalid_args'],
      ['split_rule', 'denied', 'invalid_args'],
      ['split_rule', 'denied', 'invalid_args'],
      ['propose_rule', 'denied', 'unknown_tool'],
      ['supersede_rule', 'denied', 'unknown_tool'],
    ]);
    expect(originDetail(h)).toEqual(origin);

    // 사람이 다시 누른다: 새 세션이 나눠 처리된다
    const second = await split(h, target.id);
    expect(second.sessionId).not.toBe(first.sessionId);
    await h.orchestrator.ruleWriter.idle();
    expect(h.read((store) => store.reviewQueue.get(h.seq)?.resolution?.action)).toBe('split_rule');
    expect(h.read((store) => store.ruleSplits.newRulesOf(target.id))).toHaveLength(2);
  }, 120_000);
});

describe('규칙 분할: 세션을 띄우기 전 RPC 입구의 거부 (수용 기준 1, ADR-147 ⑧)', () => {
  it('에이전트 주체(저장소를 열기 전 -32020) · 없는 항목 · 대상이 아닌 규칙(-32001) · 내장 규칙 · 폐기된 규칙 · 부모 없는 규칙 · 변이 생존 항목 · 설정 미비(-32010) · 하루 한도는 거부되고 세션이 열리지 않으며 아무것도 남지 않는다', async () => {
    const h = await prepare(scenarioOf([{ turns: [VALID_SPLIT], result: RESULT }]));
    const [target, remaining] = h.rules;
    const sessions = () =>
      h.read((store) => store.sessions.listStartedBetween(0, Date.now() + 60_000).length);
    const sessionsBefore = sessions();
    const before = snapshot(h);

    // 에이전트: 등록되지 않은 프로젝트여도 -32004가 아니라 -32020
    const byAgent = await rejection(
      h.client.call('reviewQueue.splitRule', {
        projectId: newId(),
        seq: h.seq,
        ruleId: target.id,
        author: agentAuthor,
      }),
    );
    expect(byAgent.code).toBe(ErrorCode.Unauthorized);
    const missing = await rejection(split(h, target.id, human, 999));
    expect(missing.code).toBe(ErrorCode.NotFound);
    const notTarget = await rejection(split(h, newId()));
    expect([notTarget.code, notTarget.data]).toEqual([
      ErrorCode.ValidationFailed,
      { reason: DomainErrorReason.SplitRuleNotTarget },
    ]);

    // 내장 규칙이 대상인 예산 초과 실행의 항목
    const builtinSeq = h.read((store) => {
      const builtin = seedNormRule(store, {
        title: '공개 API로만 접근',
        statement: 'WHEN 모듈이 다른 블록을 가져오면 THE SYSTEM SHALL 그 블록의 공개 API만 쓴다',
        parent: null,
        builtin: true,
        at: Date.now(),
      });
      return { builtin, seq: budgetItem(store, [builtin.id]) };
    });
    // 있는 규칙이어도 그 항목의 실행의 대상이 아니면 -32001 (내장 규칙 거부보다 먼저)
    const otherTarget = await rejection(split(h, builtinSeq.builtin.id));
    expect([otherTarget.code, otherTarget.data]).toEqual([
      ErrorCode.ValidationFailed,
      { reason: DomainErrorReason.SplitRuleNotTarget },
    ]);
    const builtinRejected = await rejection(split(h, builtinSeq.builtin.id, human, builtinSeq.seq));
    expect([builtinRejected.code, builtinRejected.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'builtin_rule' },
    ]);

    // 부모 요구사항이 없는 규칙 (요구사항 삭제로 부모가 풀린 규칙)
    const orphanSeq = h.read((store) => {
      const orphan = orphanRule(store);
      return { orphan, seq: budgetItem(store, [orphan.id]) };
    });
    const orphanRejected = await rejection(split(h, orphanSeq.orphan.id, human, orphanSeq.seq));
    expect([orphanRejected.code, orphanRejected.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'rule_without_parent' },
    ]);

    // 설정 미비 · 하루 한도 (규칙 작성 역할의 기존 세션이 지나는 문 그대로)
    await h.client.call('settings.update', {
      projectId: h.projectId,
      patch: { roles: { 'rule-writer': { model: null } } },
      author: human,
    });
    const incomplete = await rejection(split(h, target.id));
    expect(incomplete.code).toBe(ErrorCode.SettingsIncomplete);
    await h.client.call('settings.update', {
      projectId: h.projectId,
      patch: { roles: COMPLETE_SETTINGS.roles, dailyBudgetUsd: 0.01 },
      author: human,
    });
    const daily = await rejection(split(h, target.id));
    expect([daily.code, daily.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'project_daily_budget_exceeded' },
    ]);
    await h.client.call('settings.update', {
      projectId: h.projectId,
      patch: { dailyBudgetUsd: 10 },
      author: human,
    });

    // 폐기된 규칙 (나머지 대상 규칙을 다른 세션이 폐기했다)
    h.read((store) =>
      retireAgentRule(
        store,
        {
          ruleId: remaining.id,
          grounds: '"status 필드에 상태을"을 더는 요구하지 않는다',
          author: { kind: 'agent', role: 'rule-writer' },
          sessionId: newId(),
        },
        clock,
      ),
    );
    const retired = await rejection(split(h, remaining.id));
    expect([retired.code, retired.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'rule_not_effective' },
    ]);

    // 변이 생존 항목은 받지 않는 액션
    const mutantSeq = h.read((store) => failedReinforcementItem(store, target.id));
    const wrongKind = await rejection(split(h, target.id, human, mutantSeq));
    expect([wrongKind.code, wrongKind.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'action_not_allowed' },
    ]);

    // 어느 거부도 세션을 열지 않았고 처음 항목은 열림 그대로다
    await h.orchestrator.ruleWriter.idle();
    expect(sessions()).toBe(sessionsBefore);
    const after = snapshot(h);
    expect(after.resolution).toBeNull();
    expect(after.splits).toEqual(before.splits);
    expect(h.logs.some((line) => line.includes('규칙 분할 세션 대기'))).toBe(false);
  }, 120_000);

  it('이어받는 실행이 이미 있는 원 실행의 항목(한도 상향 재개로 처리됨)은 분할할 수 없고 세션이 열리지 않는다', async () => {
    const h = await prepare(scenarioOf([{ turns: [VALID_SPLIT], result: RESULT }]));
    const [target] = h.rules;
    const origin = originDetail(h);
    const resumed = await h.client.call('reviewQueue.resumeWithBudget', {
      projectId: h.projectId,
      seq: h.seq,
      budget: origin.run.budgetSnapshot,
      author: human,
    });
    expect(resumed.entry.item.resolution?.action).toBe('raise_limit_resume');
    const rejected = await rejection(split(h, target.id));
    expect([rejected.code, rejected.data]).toEqual([
      ErrorCode.StateConflict,
      { reason: 'already_resolved' },
    ]);
    await h.orchestrator.ruleWriter.idle();
    expect(h.logs.some((line) => line.includes('규칙 분할 세션 대기'))).toBe(false);
    expect(h.read((store) => store.ruleSplits.newRulesOf(target.id))).toEqual([]);
  }, 120_000);

  it('같은 항목의 분할 세션이 대기 · 진행 중이면 또 띄우지 않는다 (-32009 split_in_progress). 그 세션이 끝나면 다시 띄울 수 있다', async () => {
    const h = await prepare(scenarioOf([{ turns: [{ message: '나누지 않음' }], result: RESULT }]));
    const [target] = h.rules;
    const request = (store: ProjectStore) => {
      const found = splitTarget(store, h.seq, target.id);
      return {
        projectId: h.projectId,
        key: `review:${String(h.seq)}`,
        ruleId: target.id,
        run: { displayId: 'EXE-001', failureReason: null, stoppedAt: null },
        settle: splitSettlement(found, human),
      };
    };
    // 같은 틱에서 두 번: 둘째는 거부 (첫 세션은 아직 대기열에 있다)
    const thrown = h.read((store) => {
      h.orchestrator.ruleWriter.split(store, request(store));
      try {
        h.orchestrator.ruleWriter.split(store, request(store));
      } catch (error) {
        return error as { code: number; data: unknown };
      }
      return null;
    });
    expect(thrown).toMatchObject({
      code: ErrorCode.StateConflict,
      data: { reason: 'split_in_progress' },
    });
    await h.orchestrator.ruleWriter.idle();
    const again = await split(h, target.id);
    expect(again.sessionId).toEqual(expect.any(String));
    await h.orchestrator.ruleWriter.idle();
    expect(h.read((store) => store.reviewQueue.get(h.seq)?.resolution)).toBeNull();
  }, 120_000);
});

// ── 반영의 원자성 (열린 저장소에서 직접) ─────────────────────────

/** 대상 규칙 `ruleIds`인 실행을 예산 초과로 끝내 항목을 만든다 (엔진 밖). 항목 순번을 돌려준다. */
const budgetItem = (store: ProjectStore, ruleIds: readonly string[]): number => {
  const created = store.runs.create({
    id: newId(),
    type: 'A',
    targetRuleIds: [...ruleIds],
    currentStep: 'approval',
    baseBranch: 'main',
    budgetSnapshot: { run: { maxBudgetUsd: 5, maxTurns: 200 }, roles: {} },
    modelSnapshot: {},
    startedBy: human,
    createdAt: at(),
    steps: RUN_STEP_PLANS.A.map((kind) => ({
      id: newId(),
      kind,
      attempt: 1,
      status: 'pending' as const,
      role: STEP_ROLES[kind],
      startedAt: null,
    })),
  });
  store.runs.transition(created.run.id, { run: { status: 'running', startedAt: at() } });
  store.runs.transition(created.run.id, {
    expectedStatus: 'running',
    run: { status: 'budget_exceeded', failureReason: 'error_max_budget_usd', endedAt: at() },
  });
  const item = store.reviewQueue.list().find((entry) => entry.runId === created.run.id);
  if (item === undefined) throw new Error('예산 초과 항목 없음');
  return item.seq;
};

/** 부모 요구사항이 풀린 규칙 (요구사항 삭제가 남기는 모양: 부모 없음 · 풀린 시각). */
function orphanRule(store: ProjectStore): Rule {
  const requirement = store.requirements.create({
    id: newId(),
    text: '곧 지울 요구사항',
    author: human,
    normState: 'approved',
    createdAt: at(),
  });
  const rule = seedNormRule(store, {
    title: '부모 없음',
    statement: statement('host 필드에 호스트'),
    parent: requirement,
    at: Date.now(),
  });
  store.rules.detachFromParent(requirement.id, at());
  const detached = store.rules.get(rule.id);
  if (detached === null || detached.parentRequirementId !== null)
    throw new Error('부모가 풀리지 않음');
  return detached;
}

/** 실패로 끝난 변이 보강 실행의 변이 생존 항목 (엔진 밖, 순번). */
const failedReinforcementItem = (store: ProjectStore, ruleId: string): number => {
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
    mutant: { path: 'src/app/api/health/route.ts', search: 'time', replace: 'tick' },
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
  const item = store.reviewQueue.list({ kind: 'mutant_survived', state: 'open' })[0];
  if (item === undefined) throw new Error('변이 생존 항목 없음');
  return item.seq;
};

const NORM_INPUT = {
  requirements: { total: 1, included: 1, omitted: 0 },
  rules: { total: 2, included: 2, omitted: 0 },
  truncated: false,
} as const;

describe('규칙 분할 반영: 쓰기 트랜잭션 1개 (수용 기준 1, ADR-100 D6)', () => {
  const storeHarness = () => {
    const biveHome = makeBiveHome();
    const repo = copyFixture(temps);
    const seeded = seedProject(
      biveHome,
      repo,
      { ...COMPLETE_SETTINGS, dailyBudgetUsd: 10 },
      'approved',
      {
        statement: statement(COMBINED),
        title: '서버 시각과 버전',
        targetBlocks: ['health'],
      },
    );
    const read = <T>(fn: (store: ProjectStore) => T): T =>
      withProject(biveHome, seeded.project.id, fn);
    const remaining = read(
      (store) =>
        createAgentRule(
          store,
          {
            payload: {
              title: '상태',
              statement: statement('status 필드에 상태'),
              kind: 'business',
              checkKinds: ['test'],
              targetBlocks: ['health'],
              risk: 'medium',
              parentRequirementId: seeded.rule.parentRequirementId,
            },
            rationale: '시험',
            behavior: 'new',
            author: { kind: 'agent', role: 'rule-writer' },
            sessionId: newId(),
            contradiction: { verdict: 'none' },
            normInput: NORM_INPUT,
          },
          clock,
        ).rule,
    );
    const seq = read((store) => budgetItem(store, [seeded.rule.id, remaining.id]));
    return { read, target: seeded.rule, remaining, seq };
  };

  const splitInput = (
    store: ProjectStore,
    h: ReturnType<typeof storeHarness>,
    rules = [
      piece('서버 시각', 'time 필드에 서버 시각'),
      piece('버전', 'version 필드에 버전', 'existing'),
    ],
  ) => ({
    ruleId: h.target.id,
    grounds: GROUNDS,
    rules: rules.map(({ rationale, contradiction, behavior, ...payload }) => ({
      payload,
      rationale,
      behavior,
      contradiction: contradiction as { verdict: 'none' },
    })),
    author: { kind: 'agent', role: 'rule-writer' } as const,
    sessionId: newId(),
    normInput: NORM_INPUT,
    settle: splitSettlement(splitTarget(store, h.seq, h.target.id), human),
  });

  const state = (store: ProjectStore, h: ReturnType<typeof storeHarness>) => ({
    rules: store.rules.list().map((rule) => [rule.displayId, rule.id]),
    changes: store.normChanges.list().map((entry) => [entry.seq, entry.kind]),
    retired: [...store.ruleRetirements.retiredRuleIds()],
    splits: store.ruleSplits.newRulesOf(h.target.id),
    resolution: store.reviewQueue.get(h.seq)?.resolution ?? null,
    proposals: store.proposals.list().length,
    approvals: store.approvalLog.list().length,
  });

  it('k번째 쓰기(둘째 새 규칙 · 대체 기록 · 폐기 기록 · 둘째 분할 행 · 항목 처리)만 실패하면 새 규칙 · 기록 · 폐기 · 분할 · 처리 · 표시 ID 순번이 하나도 남지 않는다. 실패가 없으면 모두 남는다', () => {
    const h = storeHarness();
    const failures: readonly [string, string][] = [
      [
        'rules',
        "CREATE TRIGGER inject_fail BEFORE INSERT ON rules WHEN (SELECT count(*) FROM rules) >= 3 BEGIN SELECT RAISE(ABORT, 'inject'); END",
      ],
      [
        'superseded',
        "CREATE TRIGGER inject_fail BEFORE INSERT ON norm_changes WHEN NEW.kind = 'superseded' BEGIN SELECT RAISE(ABORT, 'inject'); END",
      ],
      [
        'retirement',
        "CREATE TRIGGER inject_fail BEFORE INSERT ON rule_retirements BEGIN SELECT RAISE(ABORT, 'inject'); END",
      ],
      [
        'split row',
        "CREATE TRIGGER inject_fail BEFORE INSERT ON rule_splits WHEN NEW.position = 2 BEGIN SELECT RAISE(ABORT, 'inject'); END",
      ],
      [
        'resolve',
        "CREATE TRIGGER inject_fail BEFORE UPDATE ON review_items BEGIN SELECT RAISE(ABORT, 'inject'); END",
      ],
    ];
    const before = h.read((store) => state(store, h));
    for (const [name, sql] of failures) {
      h.read((store) => {
        store.db.exec(sql);
        try {
          expect(() => splitAgentRule(store, splitInput(store, h), clock), name).toThrow(/inject/);
        } finally {
          store.db.exec('DROP TRIGGER inject_fail');
        }
        expect(state(store, h), name).toEqual(before);
      });
    }
    const written = h.read((store) => {
      const result = splitAgentRule(store, splitInput(store, h), clock);
      return { result, after: state(store, h) };
    });
    // 표시 ID 순번도 되돌려졌다: 새 규칙은 RULE-003 · RULE-004
    expect(written.result.created.map((item) => item.rule.displayId)).toEqual([
      'RULE-003',
      'RULE-004',
    ]);
    expect(written.after.retired).toEqual([h.target.id]);
    expect(written.after.splits).toEqual(written.result.created.map((item) => item.rule.id));
    expect(written.after.resolution).toMatchObject({ action: 'split_rule', ruleId: h.target.id });
    expect(written.after.proposals).toBe(0);
    expect(written.after.approvals).toBe(before.approvals);
  });

  it('반영 모듈의 거부: 새 규칙 1개 · 같은 진술 둘 · 인용 없는 근거 · 나누는 규칙을 모순 대상으로 · 내장 규칙 · 이미 폐기된 규칙 · 부모 없는 규칙은 아무것도 남기지 않는다', () => {
    const h = storeHarness();
    const before = h.read((store) => state(store, h));
    const [time, version] = [
      piece('서버 시각', 'time 필드에 서버 시각'),
      piece('버전', 'version 필드에 버전'),
    ];
    const cases: readonly [string, (store: ProjectStore) => unknown, RegExp][] = [
      ['1개', (store) => splitAgentRule(store, splitInput(store, h, [time]), clock), /2개 이상/],
      [
        '같은 진술',
        (store) =>
          splitAgentRule(
            store,
            splitInput(store, h, [time, { ...version, statement: `${time.statement} ` }]),
            clock,
          ),
        /진술이 같음/,
      ],
      [
        '인용 없음',
        (store) => splitAgentRule(store, { ...splitInput(store, h), grounds: '나눈다' }, clock),
        /인용하지 않음/,
      ],
      [
        '나누는 규칙을 모순 대상으로',
        (store) => {
          const input = splitInput(store, h);
          return splitAgentRule(
            store,
            {
              ...input,
              rules: [
                {
                  ...input.rules[0]!,
                  contradiction: {
                    verdict: 'contradicts',
                    ruleIds: [h.target.id],
                    grounds: '부딪힘',
                  },
                },
                input.rules[1]!,
              ],
            },
            clock,
          );
        },
        /넣지 않는다/,
      ],
    ];
    for (const [name, run, pattern] of cases) {
      h.read((store) => {
        expect(() => run(store), name).toThrow(pattern);
        expect(state(store, h), name).toEqual(before);
      });
    }
    // 내장 규칙 · 부모 없는 규칙 · 폐기된 규칙 (부른 쪽 확인을 지나도 반영 모듈이 다시 막는다)
    h.read((store) => {
      const builtin = seedNormRule(store, {
        title: '내장',
        statement: 'WHEN 모듈이 다른 블록을 가져오면 THE SYSTEM SHALL 그 블록의 공개 API만 쓴다',
        parent: null,
        builtin: true,
        at: Date.now(),
      });
      const orphan = orphanRule(store);
      const changes = store.normChanges.list().length;
      expect(() =>
        splitAgentRule(store, { ...splitInput(store, h), ruleId: builtin.id }, clock),
      ).toThrow(/내장 구조 규칙/);
      expect(() =>
        splitAgentRule(
          store,
          {
            ...splitInput(store, h),
            ruleId: orphan.id,
            grounds: '"host 필드에 호스트을"을 나눈다',
          },
          clock,
        ),
      ).toThrow(/부모 요구사항이 없어/);
      retireAgentRule(
        store,
        {
          ruleId: h.remaining.id,
          grounds: '"status 필드에 상태을"을 더는 요구하지 않는다',
          author: { kind: 'agent', role: 'rule-writer' },
          sessionId: newId(),
        },
        clock,
      );
      expect(() =>
        splitAgentRule(
          store,
          {
            ...splitInput(store, h),
            ruleId: h.remaining.id,
            grounds: '"status 필드에 상태을"을 나눈다',
          },
          clock,
        ),
      ).toThrow(/이미 폐기된 규칙/);
      // 폐기 기록 2건(retired + 폐기 행)만 늘었다
      expect(store.normChanges.list().length).toBe(changes + 1);
      expect(store.ruleSplits.newRulesOf(h.target.id)).toEqual([]);
      expect(store.reviewQueue.get(h.seq)?.resolution).toBeNull();
    });
  });
});

describe('분할 도구의 입력 스키마 (ADR-153)', () => {
  it('새 규칙 2 ~ 5개, 공백 정리 뒤 같은 진술 없음, 칸마다 규칙 생성과 같은 검사(동작 선언 필수 · EARS), 부모 요구사항 칸은 받지 않는다', () => {
    const valid = {
      ruleId: 'RULE-001',
      grounds: GROUNDS,
      rules: [piece('서버 시각', 'time 필드에 서버 시각'), piece('버전', 'version 필드에 버전')],
    };
    expect(SplitRuleInput.safeParse(valid).success).toBe(true);
    const [time, version] = valid.rules;
    const many = Array.from({ length: 6 }, (_, index) =>
      piece(`조각 ${String(index)}`, `part${String(index)} 필드에 조각`),
    );
    for (const [name, rules] of [
      ['1개', [time]],
      ['6개', many],
      [
        '같은 진술 (공백만 다름)',
        // 한글을 풀어 쓴 꼴(NFD)은 정규화(NFC)하면 같은 진술이다 (EARS 형식은 맞다)
        [time, { ...version, statement: time!.statement.normalize('NFD') }],
      ],
      ['선언 빠짐', [time, { ...version, behavior: undefined }]],
      ['모르는 선언', [time, { ...version, behavior: 'maybe' }]],
      ['부모 요구사항 칸', [time, { ...version, parentRequirementId: newId() }]],
      ['EARS 아님', [time, { ...version, statement: '버전을 담는다' }]],
    ] as const) {
      expect(SplitRuleInput.safeParse({ ...valid, rules }).success, name).toBe(false);
    }
    expect(SplitRuleInput.safeParse({ ...valid, rules: many.slice(0, 5) }).success).toBe(true);
    expect(SplitRuleInput.safeParse({ ...valid, grounds: '  ' }).success).toBe(false);
    expect(SplitRuleInput.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
});
