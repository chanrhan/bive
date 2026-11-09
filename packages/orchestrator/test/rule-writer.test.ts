// 요구사항 → 규칙 자동 생성 rule-writer 세션 (이슈 #21 수용 기준 1 · 2 · 3, NRM-02 · ADR-009 · ADR-024 · ADR-062).
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소 · ScriptedAdapter(실제 고정 도구 · 세션 가드 통과).
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

import {
  type AgentRole,
  type Author,
  createUlidGenerator,
  type Requirement,
  type RoleSettings,
  type RunLimits,
} from '@bive/shared';
import { openProjectStore, registerProject, unregisterProject } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentAdapter, SessionEvent, SessionSpec } from '../src/agent/adapter.js';
import { loadScenario, type Scenario, ScenarioSchema } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import type { AgentSelection } from '../src/agent/select.js';
import type { PipeServer } from '../src/ipc/server.js';
import { startOrchestrator, type Orchestrator } from '../src/orchestrator.js';
import { RULE_WRITER_SYSTEM_PROMPT } from '../src/rule-writer/prompts.js';
import {
  type RuleWriterSessionRecord,
  RuleWriterService,
} from '../src/rule-writer/rule-writer-service.js';
import { toolDefinitions } from '../src/tools/definitions.js';
import { earsStatementProblem, isEarsStatement } from '../src/tools/ears.js';
// 규칙 화면의 WHEN 조건 표시와 교차 확인한다 (DOM · React에 의존하지 않는 순수 함수, ADR-060 · ADR-062)
import { whenCondition } from '../../app/src/renderer/src/screens/rules/rulesView.js';
import { connect, type TestClient } from './helpers/client.js';
import { cleanup, makeBiveHome, waitFor } from './helpers/process.js';
import { iso, type ProjectHarness, startProjectHarness, T0 } from './helpers/project-harness.js';

const human = { kind: 'human' } as const satisfies Author;

/** roadmap M1 흐름 2: rule-writer만 먼저 저장한다 */
const RULE_WRITER_SETTINGS: RoleSettings = { model: 'test-model', maxBudgetUsd: 1, maxTurns: 20 };
const RUN_LIMITS: RunLimits = { maxBudgetUsd: 5, maxTurns: 200 };

const servers: PipeServer[] = [];
const clients: TestClient[] = [];
const services: RuleWriterService[] = [];
const running: Orchestrator[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  for (const orchestrator of running.splice(0)) await orchestrator.stop();
  await cleanup();
});

interface RuleWriterHarness extends ProjectHarness {
  service: RuleWriterService;
  /** 어댑터가 받은 세션 시작 입력 (시작 순서) */
  specs: SessionSpec[];
  /** 세션 이벤트 (모든 세션, 받은 순서) */
  events: SessionEvent[];
  logs: string[];
  /** 다음 세션부터 이 시나리오로 재생한다 */
  useScenario: (scenario: Scenario) => void;
}

interface HarnessOptions {
  scenario?: Scenario;
  /** 어댑터 이벤트를 바꾼다 (세션 가드 시험) */
  transform?: (event: SessionEvent) => SessionEvent;
}

const startHarness = async (options: HarnessOptions = {}): Promise<RuleWriterHarness> => {
  const specs: SessionSpec[] = [];
  const events: SessionEvent[] = [];
  const logs: string[] = [];
  let scenario = options.scenario ?? loadScenario('happy-path');
  let inner: ScriptedAdapter | null = null;
  let home = '';
  let service: RuleWriterService | null = null;
  const transform = options.transform ?? ((event: SessionEvent) => event);
  async function* observe(source: AsyncIterable<SessionEvent>): AsyncGenerator<SessionEvent> {
    for await (const event of source) {
      const changed = transform(event);
      events.push(changed);
      yield changed;
    }
  }
  const adapter: AgentAdapter = {
    kind: 'scripted',
    startSession: (spec) => {
      specs.push(spec);
      inner ??= new ScriptedAdapter({ scenario, biveHome: home, pollIntervalMs: 10 });
      return observe(inner.startSession(spec));
    },
  };
  const h = await startProjectHarness(
    { servers, clients },
    {
      ruleWriter: ({ biveHome, now }) => {
        home = biveHome;
        service = new RuleWriterService({ biveHome, adapter, now, log: (line) => logs.push(line) });
        services.push(service);
        return service;
      },
    },
  );
  if (service === null) throw new Error('서비스가 만들어지지 않음');
  return {
    ...h,
    service,
    specs,
    events,
    logs,
    useScenario: (next) => {
      scenario = next;
      inner = null;
    },
  };
};

const saveSettings = (
  h: ProjectHarness,
  roles: Partial<Record<AgentRole, RoleSettings>> = { 'rule-writer': RULE_WRITER_SETTINGS },
  run: RunLimits = RUN_LIMITS,
) =>
  h.client.call('settings.update', {
    projectId: h.project.id,
    patch: { run, roles },
    author: human,
  });

const createRequirement = async (h: ProjectHarness, text: string): Promise<Requirement> =>
  (await h.client.call('requirement.create', { projectId: h.project.id, text, author: human }))
    .requirement;

const onlyRecord = (h: RuleWriterHarness, requirementId: string): RuleWriterSessionRecord => {
  const records = h.service.recordsFor(h.project.id, requirementId);
  expect(records).toHaveLength(1);
  const [record] = records;
  if (record === undefined) throw new Error('기록 없음');
  return record;
};

/** happy-path rule-writer 세션의 propose_rule 인자 (시나리오 파일 그대로). */
const happyPathProposals = (): Record<string, unknown>[] =>
  (loadScenario('happy-path').roles['rule-writer']?.sessions[0]?.turns ?? []).flatMap((turn) =>
    'tool' in turn && turn.tool === 'propose_rule' ? [turn.args] : [],
  );

const SCENARIO_RESULT = {
  subtype: 'success',
  total_cost_usd: 0.01,
  num_turns: 1,
  modelUsage: {
    'model-a': {
      inputTokens: 10,
      outputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.01,
    },
  },
} as const;

/** rule-writer 세션 1개짜리 시험 시나리오. */
const ruleWriterScenario = (turns: unknown[]): Scenario =>
  ScenarioSchema.parse({
    name: 'rule-writer-test',
    description: 'rule-writer 시험',
    roles: { 'rule-writer': { sessions: [{ turns, result: SCENARIO_RESULT }] } },
  });

const validArgs = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  parentRequirementId: '{{requirementId}}',
  title: '헬스 체크 응답의 서버 시각',
  statement:
    'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 응답 JSON에 서버 시각을 담는다',
  kind: 'business',
  checkKinds: ['test'],
  rationale: "요구사항의 '서버 시각 포함'",
  ...overrides,
});

/** EARS 검사가 받는 진술 (규칙 화면 whenCondition과 교차 확인하는 공용 사례). */
const EARS_ACCEPTED = [
  'WHEN 결제 후 7일 초과 환불 요청 THE SYSTEM SHALL 요청 거절',
  'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 상태 코드 200을 돌려준다',
  'WHEN THE USER LOGS IN THE SYSTEM SHALL CREATE A SESSION',
  'WHEN the user opens the page THE SYSTEM SHALL load it within 1,000 ms',
  'WHEN 주문 금액이 1,000원 이상이면 THE SYSTEM SHALL 무료 배송을 적용한다',
  'WHEN 사용자가 로그인할 때(WHEN) THE SYSTEM SHALL 세션을 만든다',
  'WHEN Whenever 버튼을 누르면 THE SYSTEM SHALL 저장한다',
  'WHEN 결제가 실패하면 THE SYSTEM SHALL 재시도하고 when 세 번 실패하면 shall 알린다',
];

/** EARS 검사가 거부하는 진술. 조건 안 when · shall 사례는 규칙 화면에서 조건이 빠지거나 잘못 잘린다(리뷰 재현). */
const EARS_REJECTED = [
  'when 요청하면 the system shall 응답한다',
  'When 요청하면 The System Shall 응답한다',
  'WHEN 요청하면 응답한다',
  'THE SYSTEM SHALL 응답한다',
  'WHILE 로그인 상태 THE SYSTEM SHALL 메뉴를 보인다',
  'IF 요청이 실패하면 THEN THE SYSTEM SHALL 오류를 돌려준다',
  'WHEN 요청하면\nTHE SYSTEM SHALL 응답한다',
  'WHEN 요청하면\tTHE SYSTEM SHALL 응답한다',
  ' WHEN 요청하면 THE SYSTEM SHALL 응답한다',
  'WHEN 요청하면 THE SYSTEM SHALL 응답한다 ',
  'WHEN  요청하면 THE SYSTEM SHALL 응답한다',
  'WHEN 요청하면  THE SYSTEM SHALL 응답한다',
  'WHEN 요청하면 THE SYSTEM SHALL  응답한다',
  'WHEN 요청하면 THE  SYSTEM SHALL 응답한다',
  'WHEN THE SYSTEM SHALL 응답한다',
  'WHEN 요청하면 THE SYSTEM SHALL',
  'WHEN 요청하면 THE SYSTEM SHALLx',
  'WHEN a THE SYSTEM SHALL b THE SYSTEM SHALL c',
  'WHEN',
  '',
  // 조건 안의 낱말 when · shall (화면에 조건이 표시되지 않음)
  'WHEN a WHEN b THE SYSTEM SHALL c',
  'WHEN the user saves when offline THE SYSTEM SHALL queue the change',
  'WHEN 결제 shall 확인 THE SYSTEM SHALL 거부',
  // 조건 안의 낱말 shall (화면에서 조건이 잘못 잘림)
  'WHEN A PAYMENT THAT THE BUYER SHALL CONFIRM EXPIRES THE SYSTEM SHALL CANCEL THE ORDER',
  'WHEN the order, the buyer shall confirm, expires THE SYSTEM SHALL cancel it',
  // 조건 끝의 쉼표 (화면이 지운다)
  'WHEN 결제가 실패하면, THE SYSTEM SHALL 알린다',
  'WHEN 결제가 실패하면， THE SYSTEM SHALL 알린다',
];

/** 진술에서 기대하는 화면 조건: `WHEN `부터 ` THE SYSTEM SHALL ` 앞까지 그대로. */
const expectedWhen = (statement: string): string =>
  statement.slice(0, statement.indexOf(' THE SYSTEM SHALL '));

/** 세션을 멈춰 둘 관문 파일 (지우면 이어 간다). */
const GATE = '{{biveHome}}/rw-gate';
const gateTurn = { pause: { file: GATE } };
const gatePath = (h: ProjectHarness): string => path.join(h.biveHome, 'rw-gate');

describe('requirement.create 뒤 rule-writer 세션 (happy-path)', () => {
  it('세션 1회가 propose_rule로 제안 2개를 승인 대기에 등록하고 규칙 테이블에는 반영되지 않는다', async () => {
    const h = await startHarness();
    await saveSettings(h);

    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await h.service.whenSettled(h.project.id, requirement.id);

    // 세션은 1회만 열렸다
    expect(h.specs).toHaveLength(1);
    const record = onlyRecord(h, requirement.id);
    expect(record).toMatchObject({
      status: 'ended',
      endReason: 'success',
      requirementDisplayId: 'REQ-001',
      error: null,
    });
    expect(record.toolCalls.map((call) => [call.name, call.status])).toEqual([
      ['propose_rule', 'ok'],
      ['propose_rule', 'ok'],
    ]);

    const { proposals } = await h.client.call('proposal.list', { projectId: h.project.id });
    expect(proposals).toHaveLength(2);
    expect(record.proposalIds).toEqual(proposals.map((proposal) => proposal.id));
    const expected = happyPathProposals();
    expect(expected).toHaveLength(2);
    proposals.forEach((proposal, index) => {
      const { rationale, ...payload } = expected[index] ?? {};
      expect(proposal).toMatchObject({
        displayId: `PRP-00${String(index + 1)}`,
        kind: 'rule_new',
        state: 'pending',
        decision: null,
        source: 'rule_generation',
        author: { kind: 'agent', role: 'rule-writer' },
        targetRef: { entity: 'Requirement', id: requirement.id },
        rationale,
        runId: null,
      });
      expect(proposal.payload).toEqual({ ...payload, parentRequirementId: requirement.id });
    });
    await expect(
      h.client.call('proposal.count', { projectId: h.project.id }),
    ).resolves.toMatchObject({ pending: 2 });

    // 규칙 · 승인 기록은 그대로다 (NRM-04: 승인 전 제안은 규범 테이블에 없음)
    h.read((store) => {
      expect(store.rules.list()).toEqual([]);
      expect(store.rules.listByParent(requirement.id)).toEqual([]);
      expect(store.approvalLog.list()).toEqual([]);
      expect(store.requirements.get(requirement.id)).toEqual(requirement);
      // 세션 · 도구 호출 기록은 저장소에도 남는다 (실행 밖 세션, ADR-066)
      const sessions = store.sessions.listByRequirement(requirement.id);
      expect(sessions).toEqual([
        expect.objectContaining({
          id: record.id,
          runId: null,
          stepId: null,
          role: 'rule-writer',
          endReason: 'success',
          sdkSessionId: record.sdkSessionId,
          tools: ['propose_rule'],
          mcpServers: ['bive'],
          totalCostUsd: record.result?.total_cost_usd,
        }),
      ]);
      expect(
        store.sessions
          .toolCallsBySession(record.id)
          .map((call) => [call.seq, call.name, call.status]),
      ).toEqual([
        [0, 'propose_rule', 'ok'],
        [1, 'propose_rule', 'ok'],
      ]);
    });
    // 세션 작업 폴더는 끝나면 지운다
    expect(existsSync(path.join(h.biveHome, 'work', h.project.id, 'sessions', record.id))).toBe(
      false,
    );
  });

  it('응답은 세션 종료를 기다리지 않는다', async () => {
    const h = await startHarness({
      scenario: ruleWriterScenario([gateTurn, { tool: 'propose_rule', args: validArgs() }]),
    });
    await saveSettings(h);

    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    // 응답을 받은 시점에 세션은 아직 끝나지 않았다
    expect(['queued', 'running']).toContain(onlyRecord(h, requirement.id).status);
    await waitFor(() => existsSync(gatePath(h)), 5000, '세션이 관문에서 대기');
    expect(onlyRecord(h, requirement.id).status).toBe('running');
    expect(h.read((store) => store.proposals.list())).toEqual([]);

    rmSync(gatePath(h));
    await h.service.whenSettled(h.project.id, requirement.id);
    expect(onlyRecord(h, requirement.id)).toMatchObject({ status: 'ended', endReason: 'success' });
    expect(h.read((store) => store.proposals.list())).toHaveLength(1);
  });
});

describe('propose_rule 검증 (제목 · EARS 진술 · 검사 종류 · 부모 요구사항)', () => {
  it('EARS 형식: WHEN … THE SYSTEM SHALL … 한 줄만 받는다', () => {
    for (const ok of EARS_ACCEPTED) {
      expect(earsStatementProblem(ok), ok).toBeNull();
      expect(isEarsStatement(ok)).toBe(true);
    }
    for (const bad of EARS_REJECTED) {
      expect(earsStatementProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    expect(earsStatementProblem('WHEN a WHEN b THE SYSTEM SHALL c')).toContain('낱말 WHEN');
  });

  it('받은 진술은 규칙 화면의 WHEN 조건(whenCondition, ADR-060)으로 정확히 WHEN <조건>이 된다', () => {
    const scenarioStatements = ['happy-path', 'fail-check', 'pause-implement'].flatMap((name) =>
      (loadScenario(name).roles['rule-writer']?.sessions ?? []).flatMap((session) =>
        session.turns.flatMap((turn) =>
          'tool' in turn && turn.tool === 'propose_rule' ? [String(turn.args.statement)] : [],
        ),
      ),
    );
    expect(scenarioStatements.length).toBeGreaterThan(0);
    for (const statement of [...EARS_ACCEPTED, ...scenarioStatements]) {
      expect(isEarsStatement(statement), statement).toBe(true);
      expect(whenCondition(statement), statement).toBe(expectedWhen(statement));
    }
    // 화면에서 조건이 빠지거나 잘못 잘리는 진술은 받지 않는다 (리뷰 재현 사례)
    for (const statement of EARS_REJECTED) {
      const shown = whenCondition(statement);
      if (shown === null || !statement.startsWith('WHEN ')) continue;
      if (shown !== expectedWhen(statement))
        expect(isEarsStatement(statement), statement).toBe(false);
    }
  });

  it('무작위 조건 조합에서도 받은 진술은 언제나 화면 조건과 같다', () => {
    // 경계를 흔드는 낱말 · 문장 부호를 섞은 결정적 의사 난수 조합
    const tokens = [
      '결제',
      'A',
      'THE',
      'the',
      'SYSTEM',
      'system',
      'when',
      'WHEN',
      'When',
      'shall',
      'SHALL',
      'shall,',
      '(WHEN)',
      'Whenever',
      'shallow',
      '1,000',
      ',',
      '，',
      'user,',
      'THE,',
    ];
    let seed = 21;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    let accepted = 0;
    for (let i = 0; i < 5000; i += 1) {
      const words = Array.from({ length: 1 + next(6) }, () => tokens[next(tokens.length)] ?? '');
      const statement = `WHEN ${words.join(' ')} THE SYSTEM SHALL 응답한다`;
      if (!isEarsStatement(statement)) continue;
      accepted += 1;
      expect(whenCondition(statement), statement).toBe(expectedWhen(statement));
    }
    expect(accepted).toBeGreaterThan(500);
  });

  it('틀린 인자는 denied(invalid_args)로 거부하고 제안을 만들지 않는다', async () => {
    const h = await startHarness();
    // 다른 살아 있는 요구사항 (설정 전이라 세션이 뜨지 않는다)
    const other = await createRequirement(h, '다른 요구사항');
    expect(h.specs).toHaveLength(0);
    const invalid: [string, Record<string, unknown>][] = [
      ['소문자 키워드', { statement: 'when 요청하면 the system shall 응답한다' }],
      ['조건 안의 WHEN', { statement: 'WHEN a WHEN b THE SYSTEM SHALL c' }],
      ['조건 안의 shall', { statement: 'WHEN 결제 shall 확인 THE SYSTEM SHALL 거부' }],
      ['SHALL 없음', { statement: 'WHEN 요청하면 응답한다' }],
      ['상시형', { statement: 'THE SYSTEM SHALL 응답에 서버 시각을 담는다' }],
      ['여러 줄 진술', { statement: 'WHEN 요청하면\nTHE SYSTEM SHALL 응답한다' }],
      ['빈 제목', { title: '   ' }],
      ['여러 줄 제목', { title: '서버 시각\n포함' }],
      ['검사 종류 없음', { checkKinds: [] }],
      ['검사 종류 중복', { checkKinds: ['test', 'test'] }],
      ['모르는 검사 종류', { checkKinds: ['manual'] }],
      ['빈 근거', { rationale: ' ' }],
      ['모르는 인자', { state: 'approved' }],
      ['없는 부모', { parentRequirementId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }],
      ['다른 요구사항 부모', { parentRequirementId: other.id }],
    ];
    h.useScenario(
      ruleWriterScenario([
        ...invalid.map(([, overrides]) => ({ tool: 'propose_rule', args: validArgs(overrides) })),
        { tool: 'propose_rule', args: validArgs() },
      ]),
    );
    await saveSettings(h);

    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await h.service.whenSettled(h.project.id, requirement.id);

    const record = onlyRecord(h, requirement.id);
    expect(record.endReason).toBe('success');
    expect(record.toolCalls.map((call) => [call.status, call.reason])).toEqual([
      ...invalid.map(() => ['denied', 'invalid_args']),
      ['ok', undefined],
    ]);
    // 모델에게 돌려준 사유에 형식이 드러난다
    const results = h.events.flatMap((event) =>
      event.type === 'tool_result' ? [event.result] : [],
    );
    expect(results[0]?.content).toContain('WHEN <조건> THE SYSTEM SHALL <응답>');
    expect(results.at(-2)?.content).toContain(`이 세션의 요구사항 ${requirement.id}만`);

    const proposals = h.read((store) => store.proposals.list());
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.payload).toMatchObject({ parentRequirementId: requirement.id });
    expect(h.read((store) => store.rules.list())).toEqual([]);
  });

  it('세션 중 부모 요구사항이 삭제되면 error(state_conflict)', async () => {
    const h = await startHarness({
      scenario: ruleWriterScenario([gateTurn, { tool: 'propose_rule', args: validArgs() }]),
    });
    await saveSettings(h);
    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await waitFor(() => existsSync(gatePath(h)), 5000, '세션이 관문에서 대기');

    await h.client.call('requirement.delete', {
      projectId: h.project.id,
      id: requirement.id,
      author: human,
    });
    rmSync(gatePath(h));
    await h.service.whenSettled(h.project.id, requirement.id);

    expect(
      onlyRecord(h, requirement.id).toolCalls.map((call) => [call.status, call.reason]),
    ).toEqual([['error', 'state_conflict']]);
    expect(h.read((store) => store.proposals.list())).toEqual([]);
  });

  it('세션 중 프로젝트 등록이 해제되면 error(not_found)', async () => {
    const h = await startHarness({
      scenario: ruleWriterScenario([gateTurn, { tool: 'propose_rule', args: validArgs() }]),
    });
    await saveSettings(h);
    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await waitFor(() => existsSync(gatePath(h)), 5000, '세션이 관문에서 대기');

    expect(unregisterProject(h.project.id, { home: h.biveHome })).toBe(true);
    rmSync(gatePath(h));
    await h.service.whenSettled(h.project.id, requirement.id);

    expect(
      onlyRecord(h, requirement.id).toolCalls.map((call) => [call.status, call.reason]),
    ).toEqual([['error', 'not_found']]);
    expect(h.read((store) => store.proposals.list())).toEqual([]);
  });
});

describe('도구 목록 · 모델 · 한도 (ADR-024)', () => {
  it('도구 목록은 propose_rule 하나이고 설정의 rule-writer 모델 · 한도로 시작한다', async () => {
    const h = await startHarness();
    // 다른 역할 값과 섞이지 않는지 보려고 다른 값을 함께 저장한다
    const other: RoleSettings = { model: 'other-model', maxBudgetUsd: 2, maxTurns: 100 };
    await saveSettings(h, {
      'rule-writer': RULE_WRITER_SETTINGS,
      'test-writer': other,
      implementer: other,
    });

    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await h.service.whenSettled(h.project.id, requirement.id);

    expect(toolDefinitions('rule-writer').map((definition) => definition.name)).toEqual([
      'propose_rule',
    ]);
    expect(h.specs).toHaveLength(1);
    const [spec] = h.specs;
    if (spec === undefined) throw new Error('세션 없음');
    expect(spec.role).toBe('rule-writer');
    expect(spec.tools.toolNames).toEqual(['propose_rule']);
    expect(spec.model).toBe('test-model');
    expect(spec.budget).toEqual({ maxBudgetUsd: 1, maxTurns: 20 });
    expect(spec.runId).toBeUndefined();
    expect(spec.systemPrompt).toBe(RULE_WRITER_SYSTEM_PROMPT);
    expect(spec.prompt).toContain(requirement.id);
    expect(spec.prompt).toContain('헬스 체크 응답에 서버 시각 포함');
    expect(spec.vars).toMatchObject({ requirementId: requirement.id });
    expect(spec.workDir).toBe(
      path.join(h.biveHome, 'work', h.project.id, 'sessions', onlyRecord(h, requirement.id).id),
    );

    // init에 보고된 도구 목록 · MCP 수 (NFR-02)
    const init = h.events.find((event) => event.type === 'init');
    expect(init).toMatchObject({
      model: 'test-model',
      tools: ['propose_rule'],
      mcpServers: ['bive'],
    });
    expect(onlyRecord(h, requirement.id)).toMatchObject({
      model: 'test-model',
      budget: { maxBudgetUsd: 1, maxTurns: 20 },
      manifest: { role: 'rule-writer', tools: ['propose_rule'], mcpServerCount: 1 },
    });
    expect(h.logs.some((line) => line.includes('모델 test-model, 한도 USD 1 · 턴 20'))).toBe(true);
  });

  it('결과가 역할 한도를 넘으면 그 사유로 끝나고 이미 등록한 제안은 승인 대기로 남는다', async () => {
    const h = await startHarness();
    await saveSettings(h, { 'rule-writer': { ...RULE_WRITER_SETTINGS, maxBudgetUsd: 0.01 } });

    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await h.service.whenSettled(h.project.id, requirement.id);

    expect(h.specs[0]?.budget).toEqual({ maxBudgetUsd: 0.01, maxTurns: 20 });
    expect(onlyRecord(h, requirement.id)).toMatchObject({
      status: 'ended',
      endReason: 'error_max_budget_usd',
    });
    const proposals = h.read((store) => store.proposals.list());
    expect(proposals.map((proposal) => proposal.state)).toEqual(['pending', 'pending']);
    expect(h.read((store) => store.rules.list())).toEqual([]);
  });

  it('init의 도구 목록이 허용 목록과 다르면 세션 가드가 멈추고 제안을 만들지 않는다', async () => {
    const h = await startHarness({
      transform: (event) =>
        event.type === 'init' ? { ...event, tools: [...event.tools, 'mcp__evil__run'] } : event,
    });
    await saveSettings(h);

    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await h.service.whenSettled(h.project.id, requirement.id);

    const record = onlyRecord(h, requirement.id);
    expect(record).toMatchObject({
      status: 'ended',
      endReason: 'guard_violation',
      manifest: { role: 'rule-writer', tools: ['propose_rule', 'mcp__evil__run'] },
    });
    expect(record.toolCalls).toEqual([]);
    expect(h.read((store) => store.proposals.list())).toEqual([]);
  });
});

describe('설정 미비 · 중복 · 종료', () => {
  it('대기 중 삭제된 요구사항은 세션 없이 생략하고, 수정된 요구사항은 최신 본문으로 시작한다', async () => {
    const proposeOnce = { tool: 'propose_rule', args: validArgs() };
    const h = await startHarness({
      scenario: ScenarioSchema.parse({
        name: 'rule-writer-queue',
        description: '첫 세션만 관문에서 기다린다',
        roles: {
          'rule-writer': {
            sessions: [
              { turns: [gateTurn, proposeOnce], result: SCENARIO_RESULT },
              { turns: [proposeOnce], result: SCENARIO_RESULT },
            ],
          },
        },
      }),
    });
    await saveSettings(h);
    const first = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await waitFor(() => existsSync(gatePath(h)), 5000, '첫 세션이 관문에서 대기');
    const removed = await createRequirement(h, '헬스 체크 응답에 버전 포함');
    const edited = await createRequirement(h, '헬스 체크 응답에 호스트 포함');
    expect(onlyRecord(h, removed.id).status).toBe('queued');
    expect(onlyRecord(h, edited.id).status).toBe('queued');

    await h.client.call('requirement.delete', {
      projectId: h.project.id,
      id: removed.id,
      author: human,
    });
    await h.client.call('requirement.update', {
      projectId: h.project.id,
      id: edited.id,
      text: '헬스 체크 응답에 호스트 이름 포함',
      author: human,
    });
    rmSync(gatePath(h));
    await h.service.idle();

    expect(onlyRecord(h, removed.id)).toMatchObject({
      status: 'skipped',
      skipReason: 'requirement_unavailable',
      proposalIds: [],
    });
    expect(onlyRecord(h, removed.id).error).toContain('요구사항 삭제됨');
    expect(h.logs.some((line) => line.startsWith('규칙 작성 생략 (REQ-002, 요구사항 삭제됨'))).toBe(
      true,
    );
    expect(h.specs.map((spec) => spec.vars?.requirementId)).toEqual([first.id, edited.id]);
    expect(h.specs[1]?.prompt).toContain('헬스 체크 응답에 호스트 이름 포함');
    expect(onlyRecord(h, edited.id)).toMatchObject({ status: 'ended', endReason: 'success' });
    const parents = h
      .read((store) => store.proposals.list())
      .map((proposal) => proposal.targetRef?.id);
    expect(parents).toEqual([first.id, edited.id]);
  });

  it('앞 세션이 예외로 끝나도 다음 대기 세션은 돈다', async () => {
    const specs: SessionSpec[] = [];
    let service: RuleWriterService | null = null;
    const h = await startProjectHarness(
      { servers, clients },
      {
        ruleWriter: ({ biveHome, now }) => {
          const scripted = new ScriptedAdapter({
            scenario: loadScenario('happy-path'),
            biveHome,
            pollIntervalMs: 10,
          });
          service = new RuleWriterService({
            biveHome,
            now,
            adapter: {
              kind: 'scripted',
              startSession: (spec) => {
                specs.push(spec);
                // 첫 세션은 시작하자마자 예외 (어댑터 오류)
                if (specs.length === 1) throw new Error('어댑터 시작 실패');
                return scripted.startSession(spec);
              },
            },
          });
          services.push(service);
          return service;
        },
      },
    );
    if (service === null) throw new Error('서비스가 만들어지지 않음');
    const rw: RuleWriterService = service;
    await saveSettings(h);

    const [failing, next] = await Promise.all([
      createRequirement(h, '헬스 체크 응답에 서버 시각 포함'),
      createRequirement(h, '헬스 체크 응답에 버전 포함'),
    ]);
    await rw.idle();

    expect(specs).toHaveLength(2);
    const failedRecords = [failing, next].map((requirement) =>
      rw.recordsFor(h.project.id, requirement.id),
    );
    const ended = failedRecords.flat();
    expect(ended.map((record) => record.endReason).sort()).toEqual([
      'error_during_execution',
      'success',
    ]);
    expect(ended.find((record) => record.endReason === 'error_during_execution')?.error).toBe(
      '어댑터 시작 실패',
    );
    expect(h.read((store) => store.proposals.list())).toHaveLength(2);
  });

  it('rule-writer 설정이 비면 요구사항은 저장되고 세션은 뜨지 않으며 그 사실이 기록된다', async () => {
    const h = await startHarness();

    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');

    await expect(h.client.call('requirement.list', { projectId: h.project.id })).resolves.toEqual({
      requirements: [requirement],
    });
    expect(h.specs).toEqual([]);
    expect(onlyRecord(h, requirement.id)).toMatchObject({
      status: 'skipped',
      skipReason: 'settings_incomplete',
      missing: [
        'run.maxBudgetUsd',
        'run.maxTurns',
        'roles.rule-writer.model',
        'roles.rule-writer.maxBudgetUsd',
        'roles.rule-writer.maxTurns',
      ],
      error: '예산 · 모델 미설정',
      createdAt: iso(T0),
    });
    expect(
      h.logs.some((line) => line.startsWith('규칙 작성 생략 (REQ-001, 예산 · 모델 미설정')),
    ).toBe(true);
    expect(h.read((store) => store.proposals.list())).toEqual([]);

    // 실행 전체 한도가 없어도 생략한다 (ADR-057: 역할 검사에 실행 전체 한도를 늘 포함)
    await h.client.call('settings.update', {
      projectId: h.project.id,
      patch: { roles: { 'rule-writer': RULE_WRITER_SETTINGS } },
      author: human,
    });
    const second = await createRequirement(h, '헬스 체크 응답에 버전 포함');
    expect(onlyRecord(h, second.id)).toMatchObject({
      status: 'skipped',
      missing: ['run.maxBudgetUsd', 'run.maxTurns'],
    });
    expect(h.specs).toEqual([]);
  });

  it('동시 requirement.create는 요구사항마다 세션 1회, 제안은 각자의 요구사항을 부모로 한다', async () => {
    const h = await startHarness();
    await saveSettings(h);

    const created = await Promise.all(
      ['서버 시각', '버전', '호스트 이름'].map((what) =>
        createRequirement(h, `헬스 체크 응답에 ${what} 포함`),
      ),
    );
    await h.service.idle();

    expect(new Set(created.map((requirement) => requirement.id)).size).toBe(3);
    expect(h.specs).toHaveLength(3);
    expect(h.specs.map((spec) => spec.vars?.requirementId).sort()).toEqual(
      created.map((requirement) => requirement.id).sort(),
    );
    const proposals = h.read((store) => store.proposals.list());
    expect(proposals).toHaveLength(6);
    for (const requirement of created) {
      expect(onlyRecord(h, requirement.id).proposalIds).toHaveLength(2);
      expect(
        proposals.filter((proposal) => proposal.targetRef?.id === requirement.id),
      ).toHaveLength(2);
    }
  });

  it('같은 요구사항에는 다시 세션을 띄우지 않는다 (프로세스 안 · 재기동 뒤)', async () => {
    const h = await startHarness();
    await saveSettings(h);
    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await h.service.whenSettled(h.project.id, requirement.id);
    const input = { projectId: h.project.id, requirement };

    // 같은 프로세스: 요구사항별 기록으로 가린다
    const again = h.read((store) => h.service.start(store, input));
    expect(again).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    expect(h.specs).toHaveLength(1);

    // 재기동 뒤(새 서비스): 저장된 규칙 자동 생성 제안으로 가린다
    const restartedSpecs: SessionSpec[] = [];
    const scripted = new ScriptedAdapter({
      scenario: loadScenario('happy-path'),
      biveHome: h.biveHome,
      pollIntervalMs: 10,
    });
    const restarted = new RuleWriterService({
      biveHome: h.biveHome,
      adapter: {
        kind: 'scripted',
        startSession: (spec) => {
          restartedSpecs.push(spec);
          return scripted.startSession(spec);
        },
      },
    });
    services.push(restarted);
    expect(h.read((store) => restarted.start(store, input))).toEqual({
      status: 'skipped',
      reason: 'duplicate',
      record: null,
    });
    expect(restartedSpecs).toEqual([]);

    // 제안이 없는 요구사항은 새 서비스에서도 띄운다 (중복 검사가 넘치지 않음)
    const fresh = h.read((store) =>
      store.requirements.create({
        id: createUlidGenerator()(),
        text: '헬스 체크 응답에 버전 포함',
        author: human,
        normState: 'approved',
        createdAt: iso(T0),
      }),
    );
    expect(
      h.read((store) => restarted.start(store, { projectId: h.project.id, requirement: fresh })),
    ).toMatchObject({ status: 'queued' });
    await restarted.idle();
    expect(restartedSpecs).toHaveLength(1);
    expect(h.read((store) => store.proposals.list())).toHaveLength(4);
  });

  it('close는 진행 중 세션을 중단하고 이후 요구사항에는 세션을 띄우지 않는다', async () => {
    const h = await startHarness({
      scenario: ruleWriterScenario([gateTurn, { tool: 'propose_rule', args: validArgs() }]),
    });
    await saveSettings(h);
    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await waitFor(() => existsSync(gatePath(h)), 5000, '세션이 관문에서 대기');

    await h.service.close();

    expect(onlyRecord(h, requirement.id)).toMatchObject({ status: 'ended', endReason: 'aborted' });
    expect(h.read((store) => store.proposals.list())).toEqual([]);
    const later = await createRequirement(h, '헬스 체크 응답에 버전 포함');
    expect(onlyRecord(h, later.id)).toMatchObject({ status: 'skipped', skipReason: 'closed' });
    expect(h.specs).toHaveLength(1);
  });
});

describe('오케스트레이터 기동 경로', () => {
  const newId = createUlidGenerator();

  const scriptedAgent = (biveHome: string): AgentSelection => ({
    kind: 'scripted',
    adapter: new ScriptedAdapter({
      scenario: loadScenario('happy-path'),
      biveHome,
      pollIntervalMs: 10,
    }),
    scenario: 'happy-path',
  });

  it('선택된 어댑터로 세션을 띄우고, 재기동은 끊긴 세션을 다시 띄우지 않는다', async () => {
    const biveHome = makeBiveHome();
    const project = registerProject(
      {
        id: newId(),
        name: '샘플 앱',
        rootPath: '/work/sample-next-app',
        baseBranch: 'main',
        createdAt: iso(T0),
      },
      { home: biveHome },
    );
    const logs: string[] = [];
    const first = await startOrchestrator({
      biveHome,
      idleShutdownMs: 60_000,
      agent: scriptedAgent(biveHome),
      log: (line) => logs.push(line),
    });
    if (first.status !== 'started') throw new Error('기동 실패');
    running.push(first.orchestrator);
    const client = await connect(first.orchestrator.paths.pipe, first.orchestrator.token);
    clients.push(client);
    await client.call('settings.update', {
      projectId: project.id,
      patch: { run: RUN_LIMITS, roles: { 'rule-writer': RULE_WRITER_SETTINGS } },
      author: human,
    });

    const { requirement } = await client.call('requirement.create', {
      projectId: project.id,
      text: '헬스 체크 응답에 서버 시각 포함',
      author: human,
    });
    await first.orchestrator.ruleWriter.whenSettled(project.id, requirement.id);
    const { proposals } = await client.call('proposal.list', { projectId: project.id });
    expect(proposals.map((proposal) => [proposal.state, proposal.targetRef?.id])).toEqual([
      ['pending', requirement.id],
      ['pending', requirement.id],
    ]);
    expect(
      logs.some((line) => line.startsWith('규칙 작성 세션 종료 (REQ-001, success, 제안 2건')),
    ).toBe(true);

    // 세션 없이 남은 요구사항(세션 도중 강제 종료를 흉내 냄)이 있어도 재기동은 세션을 띄우지 않는다
    const store = openProjectStore(project.id, { home: biveHome, create: false });
    try {
      store.requirements.create({
        id: newId(),
        text: '헬스 체크 응답에 버전 포함',
        author: human,
        normState: 'approved',
        createdAt: iso(T0),
      });
    } finally {
      store.close();
    }
    client.destroy();
    await first.orchestrator.stop();

    const second = await startOrchestrator({
      biveHome,
      idleShutdownMs: 60_000,
      agent: scriptedAgent(biveHome),
      log: (line) => logs.push(line),
    });
    if (second.status !== 'started') throw new Error('재기동 실패');
    running.push(second.orchestrator);
    await second.orchestrator.ruleWriter.idle();
    expect(second.orchestrator.ruleWriter.records).toEqual([]);
    const reader = openProjectStore(project.id, { home: biveHome, create: false });
    try {
      expect(reader.proposals.list()).toHaveLength(2);
      expect(reader.rules.list()).toEqual([]);
    } finally {
      reader.close();
    }
  });
});
