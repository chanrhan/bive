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
  RULE_WRITER_ERROR_DISPLAY_MAX,
  type RuleWriterStatusParams,
  type RuleWriterStatusResult,
  type RunLimits,
} from '@bive/shared';
import { openProjectStore, registerProject, unregisterProject } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentAdapter, SessionEvent, SessionSpec } from '../src/agent/adapter.js';
import { loadScenario, type Scenario, ScenarioSchema } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import type { AgentSelection } from '../src/agent/select.js';
import { readRuleWriterStatus } from '../src/ipc/rule-writer-handlers.js';
import type { PipeServer } from '../src/ipc/server.js';
import { startOrchestrator, type Orchestrator } from '../src/orchestrator.js';
import { RULE_WRITER_SYSTEM_PROMPT, ruleWriterTaskPrompt } from '../src/rule-writer/prompts.js';
import {
  type RuleWriterSessionRecord,
  RuleWriterService,
} from '../src/rule-writer/rule-writer-service.js';
import { toolDefinitions } from '../src/tools/definitions.js';
import { earsStatementProblem, isEarsStatement } from '../src/tools/ears.js';
// 규칙 화면의 WHEN 조건 표시와 교차 확인한다 (DOM · React에 의존하지 않는 순수 함수, ADR-060 · ADR-062)
import { whenCondition } from '../../app/src/renderer/src/screens/rules/rulesView.js';
// 개발용 CLI 본체 (`cli rpc`, 조회 접미사만 허용). 파이프 연결만 이 시험의 클라이언트로 바꾼다
import { runCli } from '../../app/src/cli-core.js';
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

/** 도구 인자에서 근거를 뺀 규칙 본문 (근거는 규범 변경 기록 · 제안의 별도 칸). */
const withoutRationale = (args: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'rationale'));

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
  it('세션 1회의 propose_rule 2건이 승인 대기 제안 없이 같은 트랜잭션에서 규칙(효력 · 미확인 · 에이전트)과 규범 변경 기록(신규)을 남긴다 (M7-02)', async () => {
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
    // 모델에게 돌려준 본문: 반영된 규칙 (승인 대기 아님)
    const results = h.events.flatMap((event) =>
      event.type === 'tool_result' ? [event.result.content] : [],
    );
    expect(results).toEqual([
      expect.stringContaining('규칙 RULE-001 반영'),
      expect.stringContaining('규칙 RULE-002 반영'),
    ]);

    // 승인 대기 제안은 생기지 않는다 (ADR-100 A1)
    expect((await h.client.call('proposal.list', { projectId: h.project.id })).proposals).toEqual(
      [],
    );
    await expect(
      h.client.call('proposal.count', { projectId: h.project.id }),
    ).resolves.toMatchObject({ pending: 0 });

    // 규칙: 효력 상태(기존 값 approved) · 미확인 · 생성 주체 규칙 작성 역할, 내용은 도구 인자 그대로
    const rules = (await h.client.call('rule.list', { projectId: h.project.id })).rules.map(
      (entry) => entry.rule,
    );
    expect(rules.map((rule) => rule.id)).toEqual(record.ruleIds);
    const expected = happyPathProposals();
    expect(expected).toHaveLength(2);
    rules.forEach((rule, index) => {
      expect(rule).toMatchObject({
        ...withoutRationale(expected[index] ?? {}),
        displayId: `RULE-00${String(index + 1)}`,
        parentRequirementId: requirement.id,
        normState: 'approved',
        author: { kind: 'agent', role: 'rule-writer' },
        builtin: false,
        deletedAt: null,
        confirmation: { state: 'unconfirmed' },
      });
    });

    h.read((store) => {
      // 규범 변경 기록: 규칙마다 신규 1건 (이후 내용 · 사유 · 세션 ID · 시각), 규칙과 같은 시각
      const changes = store.normChanges.list();
      expect(changes).toHaveLength(2);
      changes.forEach((change, index) => {
        const rule = rules[index];
        if (rule === undefined) throw new Error('규칙 없음');
        expect(change).toMatchObject({
          seq: index + 1,
          kind: 'created',
          actor: { kind: 'agent', role: 'rule-writer' },
          targetRef: { entity: 'Rule', id: rule.id },
          sessionId: record.id,
          runId: null,
          reason: expected[index]?.rationale,
          at: rule.createdAt,
          detail: {
            after: {
              displayId: rule.displayId,
              title: rule.title,
              statement: rule.statement,
              kind: rule.kind,
              checkKinds: rule.checkKinds,
              parentRequirementId: requirement.id,
            },
          },
        });
        expect(change.detail.before).toBeUndefined();
      });
      expect(store.normChanges.verify()).toMatchObject({ valid: true });
      // 사람 기록(승인 기록) · 확인 상태에는 아무것도 생기지 않는다 (ADR-100 C2 · I1)
      expect(store.approvalLog.list()).toEqual([]);
      for (const rule of rules) {
        expect(store.confirmations.get({ entity: 'Rule', id: rule.id })).toEqual({
          state: 'unconfirmed',
        });
      }
      expect(store.proposals.list()).toEqual([]);
      expect(store.requirements.get(requirement.id)).toEqual(requirement);
      // 세션 · 도구 호출 기록은 저장소에도 남는다 (실행 밖 세션, ADR-066). 규범 변경 기록의 세션 ID가 이 세션이다
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

    // 조회 RPC: 대상 규칙으로 거르고, 체인 검증 결과를 함께 돌려준다
    const firstRule = rules[0];
    if (firstRule === undefined) throw new Error('규칙 없음');
    const listed = await h.client.call('normChange.list', {
      projectId: h.project.id,
      targetRef: { entity: 'Rule', id: firstRule.id },
    });
    expect(listed.chain).toEqual({ valid: true, brokenAtSeq: null, reason: null });
    expect(listed.entries.map((entry) => [entry.seq, entry.kind, entry.textTruncated])).toEqual([
      [1, 'created', false],
    ]);
    expect(
      (await h.client.call('normChange.list', { projectId: h.project.id })).entries,
    ).toHaveLength(2);
    // 규칙 작성 세션 로그는 만든 규칙 수를 적는다
    expect(h.logs.some((line) => line.includes('success, 규칙 2건'))).toBe(true);
    // 세션 작업 폴더는 끝나면 지운다
    expect(existsSync(path.join(h.biveHome, 'work', h.project.id, 'sessions', record.id))).toBe(
      false,
    );
  });

  it('규칙 반영이 중간에 실패하면 규칙도 규범 변경 기록도 남지 않는다 (트랜잭션 1개)', async () => {
    const h = await startHarness();
    await saveSettings(h);
    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await h.service.whenSettled(h.project.id, requirement.id);
    const before = h.read((store) => ({
      rules: store.rules.list(),
      changes: store.normChanges.list(),
    }));
    // 규범 변경 기록 추가가 실패하는 저장소 (DB가 새 행을 거부)
    h.read((store) =>
      store.db.exec(`CREATE TRIGGER norm_changes_fail BEFORE INSERT ON norm_changes
        BEGIN SELECT RAISE(ABORT, '시험: 기록 실패'); END;`),
    );
    const { requirement: second } = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '헬스 체크 응답에 버전 포함',
      author: human,
    });
    await h.service.whenSettled(h.project.id, second.id);
    const record = onlyRecord(h, second.id);
    expect(record.toolCalls.map((call) => [call.status, call.reason])).toEqual([
      ['error', 'tool_failed'],
      ['error', 'tool_failed'],
    ]);
    expect(record.ruleIds).toEqual([]);
    h.read((store) => {
      expect(store.rules.list()).toEqual(before.rules);
      expect(store.normChanges.list()).toEqual(before.changes);
      expect(store.rules.listByParent(second.id)).toEqual([]);
    });
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
    expect(h.read((store) => store.rules.list())).toEqual([]);

    rmSync(gatePath(h));
    await h.service.whenSettled(h.project.id, requirement.id);
    expect(onlyRecord(h, requirement.id)).toMatchObject({ status: 'ended', endReason: 'success' });
    expect(h.read((store) => store.rules.list())).toHaveLength(1);
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
    const scenarioStatements = [
      'happy-path',
      'fail-check',
      'false-pass',
      'pause-implement',
      'budget-exceeded',
    ].flatMap((name) =>
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

  it('틀린 인자는 denied(invalid_args)로 거부하고 규칙을 만들지 않는다', async () => {
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

    const rules = h.read((store) => store.rules.list());
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ parentRequirementId: requirement.id });
    // 거부된 호출은 규범 변경 기록도 남기지 않는다
    expect(h.read((store) => store.normChanges.list())).toHaveLength(1);
  });

  it('줄바꿈 · 제어 문자를 담은 도구 이름은 로그 한 줄 안에 표기로 남는다: 가짜 로그 줄을 만들지 못한다 (ADR-089)', async () => {
    const h = await startHarness();
    const forged = 'proposal.approve\n규칙 작성 세션 종료 (REQ-001, success\u001b[2J';
    h.useScenario(
      ruleWriterScenario([
        { tool: forged, args: {} },
        { tool: 'propose_rule', args: validArgs() },
      ]),
    );
    await saveSettings(h);

    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await h.service.whenSettled(h.project.id, requirement.id);

    const record = onlyRecord(h, requirement.id);
    expect(record.toolCalls.map((call) => [call.name, call.status, call.reason])).toEqual([
      [forged, 'denied', 'unknown_tool'],
      ['propose_rule', 'ok', undefined],
    ]);
    const callLogs = h.logs.filter((line) => line.startsWith('규칙 작성 도구 호출'));
    expect(callLogs).toEqual([
      `규칙 작성 도구 호출 (${requirement.displayId}, proposal.approve\\n규칙 작성 세션 종료 (REQ-001, success\\u001b[2J denied unknown_tool)`,
      `규칙 작성 도구 호출 (${requirement.displayId}, propose_rule ok)`,
    ]);
    // 어느 로그 줄에도 줄바꿈 · ESC 등 제어 문자가 없다
    for (const line of h.logs) expect(line).not.toMatch(/\p{Cc}/u);
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
    expect(h.read((store) => store.rules.list())).toEqual([]);
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
    expect(h.read((store) => store.rules.list())).toEqual([]);
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

  it('결과가 역할 한도를 넘으면 그 사유로 끝나고 이미 반영한 규칙은 효력 그대로 남는다', async () => {
    const h = await startHarness();
    await saveSettings(h, { 'rule-writer': { ...RULE_WRITER_SETTINGS, maxBudgetUsd: 0.01 } });

    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await h.service.whenSettled(h.project.id, requirement.id);

    expect(h.specs[0]?.budget).toEqual({ maxBudgetUsd: 0.01, maxTurns: 20 });
    expect(onlyRecord(h, requirement.id)).toMatchObject({
      status: 'ended',
      endReason: 'error_max_budget_usd',
    });
    const rules = h.read((store) => store.rules.list());
    expect(rules.map((rule) => [rule.normState, rule.confirmation.state])).toEqual([
      ['approved', 'unconfirmed'],
      ['approved', 'unconfirmed'],
    ]);
    expect(h.read((store) => store.proposals.list())).toEqual([]);
  });

  it('init의 도구 목록이 허용 목록과 다르면 세션 가드가 멈추고 규칙을 만들지 않는다', async () => {
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
    expect(h.read((store) => store.rules.list())).toEqual([]);
  });

  it('가드 위반의 MCP 서버 이름에 줄바꿈 · 양방향 제어 문자가 있어도 세션 종료 로그는 한 줄이고 이름은 표시 값이다 (M2-11 #190 · ADR-094)', async () => {
    const evil = 'evil\n규칙 작성 세션 종료 (REQ-001, success, 제안 9건)\u202e';
    const h = await startHarness({
      transform: (event) =>
        event.type === 'init' ? { ...event, mcpServers: [...event.mcpServers, evil] } : event,
    });
    await saveSettings(h);

    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await h.service.whenSettled(h.project.id, requirement.id);

    const record = onlyRecord(h, requirement.id);
    expect(record).toMatchObject({
      endReason: 'guard_violation',
      manifest: { role: 'rule-writer', mcpServerCount: 2 },
    });
    const ended = h.logs.filter((line) => line.startsWith('규칙 작성 세션 종료'));
    expect(ended).toHaveLength(1);
    expect(ended[0]).toContain(
      '세션 가드: 허용되지 않은 MCP 서버 evil\\n규칙 작성 세션 종료 (REQ-001, success, 제안 9건)\\u202e',
    );
    for (const line of h.logs) expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
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
      ruleIds: [],
    });
    expect(onlyRecord(h, removed.id).error).toContain('요구사항 삭제됨');
    expect(h.logs.some((line) => line.startsWith('규칙 작성 생략 (REQ-002, 요구사항 삭제됨'))).toBe(
      true,
    );
    expect(h.specs.map((spec) => spec.vars?.requirementId)).toEqual([first.id, edited.id]);
    expect(h.specs[1]?.prompt).toContain('헬스 체크 응답에 호스트 이름 포함');
    expect(onlyRecord(h, edited.id)).toMatchObject({ status: 'ended', endReason: 'success' });
    const parents = h.read((store) => store.rules.list()).map((rule) => rule.parentRequirementId);
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
    expect(h.read((store) => store.rules.list())).toHaveLength(2);
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
    expect(h.read((store) => store.rules.list())).toEqual([]);

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

  it('동시 requirement.create는 요구사항마다 세션 1회, 규칙은 각자의 요구사항을 부모로 한다', async () => {
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
    const rules = h.read((store) => store.rules.list());
    expect(rules).toHaveLength(6);
    for (const requirement of created) {
      expect(onlyRecord(h, requirement.id).ruleIds).toHaveLength(2);
      expect(rules.filter((rule) => rule.parentRequirementId === requirement.id)).toHaveLength(2);
    }
    // 규범 변경 기록의 세션 ID는 그 규칙을 만든 세션이다
    h.read((store) => {
      for (const change of store.normChanges.list()) {
        const rule = rules.find((r) => r.id === change.targetRef.id);
        const parent = rule?.parentRequirementId ?? '';
        expect(change.sessionId).toBe(onlyRecord(h, parent).id);
      }
    });
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

    // 재기동 뒤(새 서비스): 그 요구사항에서 규칙 작성 역할이 만든 규칙으로 가린다 (M7-02, 제안이 없어도)
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
    expect(h.read((store) => store.proposals.list())).toEqual([]);

    // 이 변경 전부터 있던 규칙 자동 생성 제안(규칙 없음)도 그대로 가린다 (ADR-100 A1)
    const legacy = h.read((store) =>
      store.requirements.create({
        id: createUlidGenerator()(),
        text: '헬스 체크 응답에 호스트 이름 포함',
        author: human,
        normState: 'approved',
        createdAt: iso(T0),
      }),
    );
    const legacyPayload = withoutRationale(validArgs({ parentRequirementId: legacy.id }));
    h.proposals.submit(h.project.id, {
      kind: 'rule_new',
      payload: legacyPayload,
      rationale: '이 변경 전의 제안',
      author: { kind: 'agent', role: 'rule-writer' },
      source: 'rule_generation',
    });
    expect(
      h.read((store) => restarted.start(store, { projectId: h.project.id, requirement: legacy })),
    ).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    expect(restartedSpecs).toEqual([]);

    // 만든 규칙 · 제안이 없는 요구사항은 새 서비스에서도 띄운다 (중복 검사가 넘치지 않음)
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
    expect(h.read((store) => store.rules.list())).toHaveLength(4);
    expect(h.read((store) => store.proposals.list())).toHaveLength(1);
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
    expect(h.read((store) => store.rules.list())).toEqual([]);
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
    const rules = (await client.call('rule.list', { projectId: project.id })).rules.map(
      (entry) => entry.rule,
    );
    expect(rules.map((rule) => [rule.normState, rule.parentRequirementId])).toEqual([
      ['approved', requirement.id],
      ['approved', requirement.id],
    ]);
    expect((await client.call('proposal.list', { projectId: project.id })).proposals).toEqual([]);
    expect(
      logs.some((line) => line.startsWith('규칙 작성 세션 종료 (REQ-001, success, 규칙 2건')),
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
      expect(reader.rules.list()).toHaveLength(2);
      expect(reader.normChanges.list()).toHaveLength(2);
      expect(reader.proposals.list()).toEqual([]);
    } finally {
      reader.close();
    }
  });
});

describe('규칙 작성 시도 기록 · 조회 · 다시 시도 (M3-26 #206, NRM-02 · NFR-03 · ADR-099)', () => {
  /** 저장소만 읽는 조회 처리기 (서비스 · 메모리 없이, 재기동 뒤와 같다) */
  const storedStatus = (h: ProjectHarness, requirementId?: string): RuleWriterStatusResult =>
    readRuleWriterStatus(
      h.biveHome,
      requirementId === undefined
        ? { projectId: h.project.id }
        : { projectId: h.project.id, requirementId },
    );

  /** `cli rpc ruleWriter.status <json>` (앱 CLI 본체를 이 파이프 클라이언트에 붙인다) */
  const cliStatus = async (h: ProjectHarness, params: unknown) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['rpc', 'ruleWriter.status', JSON.stringify(params)], {
      connect: () =>
        Promise.resolve({
          request: (method: string, p?: unknown) =>
            h.client.call(method as 'ruleWriter.status', p as RuleWriterStatusParams),
          close: () => Promise.resolve(),
        }),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    });
    return { code, out: out.join('\n'), err };
  };

  const updateRequirement = (h: ProjectHarness, id: string, text: string) =>
    h.client.call('requirement.update', { projectId: h.project.id, id, text, author: human });

  /** 첫 세션의 init에만 허용되지 않은 MCP 서버를 넣는다 (세션 가드 위반 재현) */
  const failFirstInit = (name: string) => {
    let seen = 0;
    return (event: SessionEvent): SessionEvent => {
      if (event.type !== 'init') return event;
      seen += 1;
      return seen === 1 ? { ...event, mcpServers: [...event.mcpServers, name] } : event;
    };
  };

  it('어댑터 오류(외부 문자열)로 끝난 시도는 ruleWriter.status · cli rpc로 종료 사유 · 오류 문장(이스케이프 · 상한)이 보이고, 값은 저장소에서만 나온다', async () => {
    // SDK · 어댑터가 던진 오류 문장은 줄바꿈 · 양방향 제어 문자 · 긴 문자열을 담을 수 있다
    const evil = `SDK 오류\n${String.fromCodePoint(0x202e)}${'x'.repeat(600)}`;
    const h = await startHarness({
      transform: (event) => {
        if (event.type === 'init') throw new Error(evil);
        return event;
      },
    });
    await saveSettings(h);

    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await h.service.whenSettled(h.project.id, requirement.id);
    const record = onlyRecord(h, requirement.id);
    expect(record).toMatchObject({ status: 'ended', endReason: 'error_during_execution' });

    const { entries } = await h.client.call('ruleWriter.status', { projectId: h.project.id });
    expect(entries).toEqual([
      {
        requirementId: requirement.id,
        attemptId: record.id,
        state: 'ended',
        skipReason: null,
        missing: [],
        endReason: 'error_during_execution',
        error: expect.any(String) as string,
        errorTruncated: true,
        requestedAt: iso(T0),
        endedAt: iso(T0),
      },
    ]);
    const shown = entries[0]?.error ?? '';
    expect(shown.startsWith('SDK 오류\\n\\u202exxx')).toBe(true);
    expect(shown.endsWith('…')).toBe(true);
    expect(shown).toHaveLength(RULE_WRITER_ERROR_DISPLAY_MAX);
    expect(shown).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    // 저장된 기록은 원문 그대로다 (이스케이프는 표시 값에만)
    expect(h.read((store) => store.sessions.get(record.id)?.error)).toBe(evil);

    // 저장소만 읽는 처리기도 같은 값이다(오케스트레이터 메모리를 읽지 않음)
    expect(storedStatus(h)).toEqual({ entries });
    expect(storedStatus(h, requirement.id)).toEqual({ entries });

    // 개발용 CLI의 조회(접미사 .status)로도 같은 값이 나온다
    const cli = await cliStatus(h, { projectId: h.project.id, requirementId: requirement.id });
    expect(cli).toMatchObject({ code: 0, err: [] });
    expect(JSON.parse(cli.out)).toEqual({ entries });
  });

  it('설정 미비로 생략된 시도는 사유 · 비어 있던 항목이 저장되고, 설정 뒤 직접 편집 저장이 다시 시도해 규칙이 한 번만 생긴다', async () => {
    const h = await startHarness();
    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    expect(h.specs).toEqual([]);
    const skipped = onlyRecord(h, requirement.id);
    expect(storedStatus(h, requirement.id)).toEqual({
      entries: [
        {
          requirementId: requirement.id,
          attemptId: skipped.id,
          state: 'skipped',
          skipReason: 'settings_incomplete',
          missing: [
            'run.maxBudgetUsd',
            'run.maxTurns',
            'roles.rule-writer.model',
            'roles.rule-writer.maxBudgetUsd',
            'roles.rule-writer.maxTurns',
          ],
          endReason: null,
          error: '예산 · 모델 미설정',
          errorTruncated: false,
          requestedAt: iso(T0),
          endedAt: iso(T0),
        },
      ],
    });

    // 설정을 고쳐도 그것만으로는 다시 시도하지 않는다 (사람의 요구사항 저장이 계기)
    await saveSettings(h);
    await h.service.idle();
    expect(h.specs).toEqual([]);

    h.clock.now = T0 + 1000;
    await updateRequirement(h, requirement.id, '헬스 체크 응답에 서버 시각을 포함');
    await h.service.whenSettled(h.project.id, requirement.id);
    expect(h.specs).toHaveLength(1);
    expect(h.specs[0]?.prompt).toContain('헬스 체크 응답에 서버 시각을 포함');
    const [, retried] = h.service.recordsFor(h.project.id, requirement.id);
    expect(retried).toMatchObject({ status: 'ended', endReason: 'success' });
    expect(storedStatus(h, requirement.id).entries).toEqual([
      expect.objectContaining({
        attemptId: retried?.id,
        state: 'ended',
        endReason: 'success',
        error: null,
        requestedAt: iso(T0 + 1000),
      }),
    ]);
    expect(h.read((store) => store.rules.list())).toHaveLength(2);
    expect(h.logs).toContain('규칙 작성 다시 시도 (REQ-001)');

    // 성공한 요구사항은 다시 편집해도 띄우지 않는다 (중복 규칙 없음)
    await updateRequirement(h, requirement.id, '헬스 체크 응답에 서버 시각 포함');
    await h.service.idle();
    expect(h.specs).toHaveLength(1);
    expect(h.read((store) => store.rules.list())).toHaveLength(2);
    expect(
      h.read((store) => store.ruleWriterRequests.listByRequirement(requirement.id)),
    ).toHaveLength(2);
  });

  it('실패한 요구사항의 다시 시도는 진행 중이면 또 띄우지 않고, 끝나면 시도 기록이 실패 → 성공으로 이어진다', async () => {
    const h = await startHarness({ transform: failFirstInit('evil') });
    await saveSettings(h);
    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await h.service.whenSettled(h.project.id, requirement.id);
    expect(storedStatus(h, requirement.id).entries[0]).toMatchObject({
      state: 'ended',
      endReason: 'guard_violation',
      error: '세션 가드: 허용되지 않은 MCP 서버 evil',
    });

    h.useScenario(ruleWriterScenario([gateTurn, { tool: 'propose_rule', args: validArgs() }]));
    await updateRequirement(h, requirement.id, '헬스 체크 응답에 서버 시각을 포함');
    await waitFor(() => existsSync(gatePath(h)), 5000, '다시 시도 세션이 관문에서 대기');
    expect(storedStatus(h, requirement.id).entries[0]).toMatchObject({
      state: 'running',
      endReason: null,
      endedAt: null,
    });
    // 진행 중에 다시 편집해도 새 시도는 없다
    await updateRequirement(h, requirement.id, '헬스 체크 응답에 서버 시각 포함');
    expect(h.specs).toHaveLength(2);

    rmSync(gatePath(h));
    await h.service.whenSettled(h.project.id, requirement.id);
    expect(h.specs).toHaveLength(2);
    expect(storedStatus(h, requirement.id).entries[0]).toMatchObject({
      state: 'ended',
      endReason: 'success',
    });
    expect(h.read((store) => store.rules.list())).toHaveLength(1);
    expect(
      h.read((store) =>
        store.ruleWriterRequests.listByRequirement(requirement.id).map((a) => a.endReason),
      ),
    ).toEqual(['guard_violation', 'success']);
  });

  it('규칙을 남기고 실패한 요구사항(예산 초과)은 편집해도 다시 시도하지 않는다 (이미 만든 규칙 유지)', async () => {
    const h = await startHarness();
    await saveSettings(h, { 'rule-writer': { ...RULE_WRITER_SETTINGS, maxBudgetUsd: 0.01 } });
    const requirement = await createRequirement(h, '헬스 체크 응답에 서버 시각 포함');
    await h.service.whenSettled(h.project.id, requirement.id);
    expect(storedStatus(h, requirement.id).entries[0]).toMatchObject({
      state: 'ended',
      endReason: 'error_max_budget_usd',
    });

    await updateRequirement(h, requirement.id, '헬스 체크 응답에 서버 시각을 포함');
    await h.service.idle();
    expect(h.specs).toHaveLength(1);
    expect(h.read((store) => store.rules.list())).toHaveLength(2);
    expect(
      h.read((store) => store.ruleWriterRequests.listByRequirement(requirement.id)),
    ).toHaveLength(1);
  });

  it('시도 기록이 없는 요구사항은 조회 결과에 없고 편집해도 시작하지 않으며, 없는 프로젝트는 -32004', async () => {
    const h = await startHarness();
    await saveSettings(h);
    const old = h.read((store) =>
      store.requirements.create({
        id: createUlidGenerator()(),
        text: '이전 요구사항',
        author: human,
        normState: 'approved',
        createdAt: iso(T0),
      }),
    );
    expect(storedStatus(h)).toEqual({ entries: [] });
    await updateRequirement(h, old.id, '이전 요구사항 수정');
    await h.service.idle();
    expect(h.service.recordsFor(h.project.id, old.id)).toEqual([]);
    expect(h.specs).toEqual([]);
    await expect(
      h.client.call('ruleWriter.status', { projectId: createUlidGenerator()() }),
    ).rejects.toMatchObject({ code: -32004 });
  });
});

describe('사후 확인 전환: 프롬프트 · 대기 중이던 제안 (M7-02 #214 수용 기준 3, ADR-100 A1 · D1)', () => {
  /** 사람 승인을 전제한 문장 (이 변경 전 프롬프트 · 도구 설명의 표현) */
  const APPROVAL_PREMISE =
    /승인해야|승인 대기|승인을 받|제안을 등록|제안으로 등록|제안한다|제안하라/;

  it('규칙 작성 역할의 시스템 프롬프트 · 작업 지시 · 도구 설명에 사람 승인을 전제한 문장이 없고, 바로 효력 · 사후 확인을 밝힌다', () => {
    const task = ruleWriterTaskPrompt({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      displayId: 'REQ-001',
      text: '헬스 체크 응답에 서버 시각 포함',
    });
    const [tool] = toolDefinitions('rule-writer');
    for (const text of [RULE_WRITER_SYSTEM_PROMPT, task, tool?.description ?? '']) {
      expect(text).not.toMatch(APPROVAL_PREMISE);
      expect(text).not.toContain('제안');
    }
    expect(RULE_WRITER_SYSTEM_PROMPT).toContain('그 즉시 효력을 갖고');
    expect(RULE_WRITER_SYSTEM_PROMPT).toContain('사람은 나중에');
    expect(tool?.description).toContain('바로 효력');
    // 이 변경 전 문장이 남아 있지 않다 (ADR-100 결과 절의 ADR-062 항목)
    expect(RULE_WRITER_SYSTEM_PROMPT).not.toContain('제안은 사람이 승인해야 규칙이 되고');
  });

  it('이 변경 전부터 대기 중이던 제안은 proposal.approve(확인됨) · proposal.reject로 처리되고, 규칙 작성 세션은 새 제안을 만들지 않는다', async () => {
    const h = await startHarness();
    await saveSettings(h);
    // 이 변경 전 데이터: 사람이 쓴 요구사항과 그 요구사항의 대기 중 규칙 제안 2개 (세션 없이 저장소에 직접)
    const legacy = h.read((store) =>
      store.requirements.create({
        id: createUlidGenerator()(),
        text: '헬스 체크 응답에 서버 시각 포함',
        author: human,
        normState: 'approved',
        createdAt: iso(T0),
      }),
    );
    const payload = withoutRationale(validArgs({ parentRequirementId: legacy.id }));
    const [kept, dropped] = ['헬스 체크 응답의 서버 시각', '헬스 체크 응답 형식 유지'].map(
      (title) =>
        h.proposals.submit(h.project.id, {
          kind: 'rule_new',
          payload: { ...payload, title },
          rationale: '이 변경 전의 제안',
          author: { kind: 'agent', role: 'rule-writer' },
          source: 'rule_generation',
        }),
    );
    if (kept === undefined || dropped === undefined) throw new Error('제안 없음');

    // 새 요구사항의 규칙 작성 세션은 제안을 만들지 않고 규칙을 바로 반영한다
    const fresh = await createRequirement(h, '헬스 체크 응답에 버전 포함');
    await h.service.whenSettled(h.project.id, fresh.id);
    expect(onlyRecord(h, fresh.id).ruleIds).toHaveLength(2);
    expect(
      (await h.client.call('proposal.list', { projectId: h.project.id })).proposals.map(
        (proposal) => proposal.id,
      ),
    ).toEqual([kept.id, dropped.id]);
    await expect(
      h.client.call('proposal.count', { projectId: h.project.id }),
    ).resolves.toMatchObject({ pending: 2 });

    // 대기 중이던 제안: 승인하면 규칙이 되고 사람 행동이라 확인됨, 거절은 그대로
    const approved = await h.client.call('proposal.approve', {
      projectId: h.project.id,
      id: kept.id,
      author: human,
    });
    if (approved.applied.entity !== 'Rule') throw new Error('규칙 아님');
    expect(approved.applied.rule).toMatchObject({
      title: '헬스 체크 응답의 서버 시각',
      parentRequirementId: legacy.id,
      confirmation: {
        state: 'confirmed',
        by: human,
        basis: { kind: 'approval_log', seq: approved.approvalLog.seq },
      },
    });
    const rejected = await h.client.call('proposal.reject', {
      projectId: h.project.id,
      id: dropped.id,
      author: human,
      reason: '중복',
    });
    expect(rejected.proposal.state).toBe('rejected');
    await expect(
      h.client.call('proposal.count', { projectId: h.project.id }),
    ).resolves.toMatchObject({ pending: 0 });

    h.read((store) => {
      // 승인 기록: 사람의 승인 · 거절 2건뿐. 규범 변경 기록: 에이전트의 신규 2건뿐 (사람 행동은 섞이지 않는다, C2)
      expect(store.approvalLog.list().map((entry) => [entry.action, entry.actor.kind])).toEqual([
        ['approve', 'human'],
        ['reject', 'human'],
      ]);
      expect(
        store.normChanges.list().map((entry) => [entry.kind, entry.actor.kind, entry.sessionId]),
      ).toEqual([
        ['created', 'agent', onlyRecord(h, fresh.id).id],
        ['created', 'agent', onlyRecord(h, fresh.id).id],
      ]);
      // 바로 반영된 규칙은 미확인, 승인한 옛 제안의 규칙은 확인됨
      const states = store.rules
        .list()
        .map((rule) => [rule.parentRequirementId, rule.confirmation.state]);
      expect(states).toEqual([
        [fresh.id, 'unconfirmed'],
        [fresh.id, 'unconfirmed'],
        [legacy.id, 'confirmed'],
      ]);
    });
  });
});
