// 규칙 조회 RPC (M1-11 수용 기준 1, NRM-02 · JDG-02 · NRM-04 · ADR-060).
// `rule.list` · `rule.get`은 규칙 테이블의 규범(승인된 규칙)만, 승인 전 · 거절된 제안은 빼고, 최신 판정과 함께 돌려준다.
// 판정 기록이 없으면 미판정이다. 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소.
import path from 'node:path';

import {
  createUlidGenerator,
  ErrorCode,
  RUN_STEP_PLANS,
  STEP_ROLES,
  type Author,
  type JudgmentResult,
  type Proposal,
  type Requirement,
  type Rule,
  type RuleNewPayload,
  type Run,
  type Step,
} from '@bive/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storedLatestJudgments, toRuleJudgment } from '../src/judgments/latest-judgment.js';
import { createRuleHandlers } from '../src/ipc/rule-handlers.js';
import { PipeServer } from '../src/ipc/server.js';
import { NetPipeTransport } from '../src/ipc/transport.js';
import { connect, type TestClient } from './helpers/client.js';
import { cleanup } from './helpers/process.js';
import {
  iso,
  startProjectHarness,
  T0,
  TOKEN,
  type ProjectHarness,
} from './helpers/project-harness.js';

const human = { kind: 'human' } as const satisfies Author;
const ruleWriter = { kind: 'agent', role: 'rule-writer' } as const satisfies Author;

const newId = createUlidGenerator();

const servers: PipeServer[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  await cleanup();
});

let h: ProjectHarness;
beforeEach(async () => {
  h = await startProjectHarness({ servers, clients });
});

const UNJUDGED = { status: 'unjudged', latest: null } as const;

const createRequirement = async (text = '사용자는 이메일로 가입할 수 있다'): Promise<Requirement> =>
  (await h.client.call('requirement.create', { projectId: h.project.id, text, author: human }))
    .requirement;

const rulePayload = (parentRequirementId: string, title: string): RuleNewPayload => ({
  title,
  statement: `WHEN ${title} 조건이면 THE SYSTEM SHALL 요청을 거부한다`,
  kind: 'business',
  checkKinds: ['test'],
  parentRequirementId,
});

const submitRule = (parentRequirementId: string, title: string): Proposal =>
  h.proposals.submit(h.project.id, {
    kind: 'rule_new',
    payload: rulePayload(parentRequirementId, title),
    rationale: '요구사항의 예외 경로',
    author: ruleWriter,
    source: 'rule_generation',
  });

/** 규칙 제안을 사람이 승인해 규칙으로 만든다 (규칙이 생기는 유일한 경로, NRM-04). */
const approveRule = async (parentRequirementId: string, title: string): Promise<Rule> => {
  const proposal = submitRule(parentRequirementId, title);
  const { applied } = await h.client.call('proposal.approve', {
    projectId: h.project.id,
    id: proposal.id,
    author: human,
  });
  if (applied.entity !== 'Rule') throw new Error('규칙이 반영되지 않음');
  return applied.rule;
};

const listRules = async () => (await h.client.call('rule.list', { projectId: h.project.id })).rules;

describe('rule.list: 승인된 규칙만, 최신 판정(없으면 미판정)과 함께', () => {
  it('규칙이 없으면 빈 목록', async () => {
    expect(await h.client.call('rule.list', { projectId: h.project.id })).toEqual({ rules: [] });
  });

  it('승인 대기 · 거절된 제안은 빼고, 승인된 규칙만 표시 ID 순으로 미판정과 함께 돌려준다', async () => {
    const req = await createRequirement();
    const first = await approveRule(req.id, '중복 이메일 가입 거부');
    h.clock.now = T0 + 1_000;
    const pending = submitRule(req.id, '승인 대기 규칙');
    const rejected = submitRule(req.id, '거절된 규칙');
    await h.client.call('proposal.reject', {
      projectId: h.project.id,
      id: rejected.id,
      author: human,
      reason: '요구사항과 무관',
    });
    h.clock.now = T0 + 2_000;
    const second = await approveRule(req.id, '비밀번호 5회 실패 시 잠금');

    const rules = await listRules();
    expect(rules).toEqual([
      { rule: first, judgment: UNJUDGED },
      { rule: second, judgment: UNJUDGED },
    ]);
    expect(rules.map(({ rule }) => rule.displayId)).toEqual(['RULE-001', 'RULE-002']);
    // 제안은 그대로 제안 목록에만 있다
    const titles = rules.map(({ rule }) => rule.title);
    expect(titles).not.toContain('승인 대기 규칙');
    expect(titles).not.toContain('거절된 규칙');
    const { proposals } = await h.client.call('proposal.list', {
      projectId: h.project.id,
      kind: 'rule_new',
    });
    expect(proposals.map((p) => [p.id, p.state])).toEqual(
      expect.arrayContaining([
        [pending.id, 'pending'],
        [rejected.id, 'rejected'],
      ]),
    );
  });

  it('부모 요구사항이 삭제돼 부모가 해제된 규칙도 규범이므로 목록에 남는다', async () => {
    const req = await createRequirement();
    const rule = await approveRule(req.id, '중복 이메일 가입 거부');
    h.clock.now = T0 + 5_000;
    await h.client.call('requirement.delete', {
      projectId: h.project.id,
      id: req.id,
      author: human,
    });

    const [only] = await listRules();
    expect(only?.rule).toMatchObject({
      id: rule.id,
      parentRequirementId: null,
      parentDetachedAt: iso(T0 + 5_000),
    });
    expect(only?.judgment).toEqual(UNJUDGED);
  });

  it('소프트 삭제된 규칙은 목록에서 빠진다', async () => {
    const req = await createRequirement();
    const kept = await approveRule(req.id, '남는 규칙');
    const removed = await approveRule(req.id, '삭제된 규칙');
    markDeleted(removed.id, iso(T0 + 9_000));

    expect((await listRules()).map(({ rule }) => rule.id)).toEqual([kept.id]);
  });

  it('등록되지 않은 프로젝트는 -32004', async () => {
    await expect(h.client.call('rule.list', { projectId: newId() })).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
  });
});

describe('rule.get: 규칙 1건 + 최신 판정', () => {
  it('승인된 규칙을 미판정과 함께 돌려준다', async () => {
    const req = await createRequirement();
    const rule = await approveRule(req.id, '중복 이메일 가입 거부');
    expect(await h.client.call('rule.get', { projectId: h.project.id, id: rule.id })).toEqual({
      rule,
      judgment: UNJUDGED,
      latestRun: null,
    });
  });

  it('제안 ID(승인 대기 · 승인됨)는 규칙이 아니므로 -32004', async () => {
    const req = await createRequirement();
    const pending = submitRule(req.id, '승인 대기 규칙');
    await expect(
      h.client.call('rule.get', { projectId: h.project.id, id: pending.id }),
    ).rejects.toMatchObject({ code: ErrorCode.NotFound });

    const approved = submitRule(req.id, '승인된 규칙');
    const { applied } = await h.client.call('proposal.approve', {
      projectId: h.project.id,
      id: approved.id,
      author: human,
    });
    await expect(
      h.client.call('rule.get', { projectId: h.project.id, id: approved.id }),
    ).rejects.toMatchObject({ code: ErrorCode.NotFound });
    // 반영된 규칙은 제안과 다른 ID로 조회된다
    if (applied.entity !== 'Rule') throw new Error('규칙이 반영되지 않음');
    expect(
      (await h.client.call('rule.get', { projectId: h.project.id, id: applied.rule.id })).rule
        .title,
    ).toBe('승인된 규칙');
  });

  it('소프트 삭제된 규칙도 돌려준다 (deletedAt으로 구분)', async () => {
    const req = await createRequirement();
    const rule = await approveRule(req.id, '삭제된 규칙');
    markDeleted(rule.id, iso(T0 + 9_000));
    const result = await h.client.call('rule.get', { projectId: h.project.id, id: rule.id });
    expect(result.rule.deletedAt).toBe(iso(T0 + 9_000));
    expect(result.judgment).toEqual(UNJUDGED);
  });

  it('없는 규칙 · 등록되지 않은 프로젝트는 -32004', async () => {
    await expect(
      h.client.call('rule.get', { projectId: h.project.id, id: newId() }),
    ).rejects.toMatchObject({ code: ErrorCode.NotFound });
    await expect(
      h.client.call('rule.get', { projectId: newId(), id: newId() }),
    ).rejects.toMatchObject({ code: ErrorCode.NotFound });
  });
});

describe('최신 판정 결합 지점', () => {
  const record = (ruleId: string, status: JudgmentResult['status']): JudgmentResult => ({
    id: newId(),
    ruleId,
    runId: newId(),
    stepId: null,
    commit: 'c'.repeat(40),
    judgedAt: iso(T0 + 60_000),
    status,
    runner: 'vitest',
    exitCode: status === 'pass' ? 0 : 1,
    reporterPath: null,
    cases: [],
    quarantineReason: null,
  });

  it('결합 지점은 판정 기록 테이블에서 규칙별 최신 기록(판정 시각 기준)을 읽고, 기록이 없는 규칙은 null이다', async () => {
    const req = await createRequirement();
    const judged = await approveRule(req.id, '중복 이메일 가입 거부');
    const fresh = await approveRule(req.id, '판정 전 규칙');
    // 실행 밖 판정 기록(실행 · 단계 없음)으로 저장소 결합만 본다
    const older = { ...record(judged.id, 'pass'), runId: null, judgedAt: iso(T0 + 1_000) };
    const latest = { ...record(judged.id, 'fail'), runId: null };
    h.read((store) => store.judgments.record([latest, older]));
    expect(h.read((store) => storedLatestJudgments(store)(judged.id))).toEqual(latest);
    expect(h.read((store) => storedLatestJudgments(store)(fresh.id))).toBeNull();

    // 기본 처리기(결합 지점 주입 없음)도 같은 최신 판정을 싣는다
    expect(
      (await h.client.call('rule.get', { projectId: h.project.id, id: judged.id })).judgment,
    ).toEqual({
      status: 'fail',
      latest,
    });
    expect(
      (await h.client.call('rule.get', { projectId: h.project.id, id: fresh.id })).judgment,
    ).toEqual(UNJUDGED);
  });

  it('가드: 프로젝트 DB의 판정 기록 테이블은 judgments 하나다 (다른 판정 테이블이 생기면 storedLatestJudgments를 함께 고친다)', () => {
    // 결합 지점은 judgments만 읽는다. 판정을 담는 다른 테이블 · 뷰가 생겼는데 결합 지점을 고치지 않으면
    // 그 기록이 화면에 보이지 않으므로, 그런 테이블이 생기는 순간 여기서 실패하게 한다
    const tables = h.read(
      (store) =>
        store.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND (name LIKE '%judg%' OR name LIKE '%verdict%') ORDER BY name",
          )
          .all() as { name: string }[],
    );
    expect(tables).toEqual([{ name: 'judgments' }]);
  });

  it('기록이 없으면 미판정, 있으면 기록의 상태와 기록(커밋 · 시각 · 실행 링크)을 싣는다', () => {
    const fail = record(newId(), 'fail');
    expect(toRuleJudgment(null)).toEqual(UNJUDGED);
    expect(toRuleJudgment(fail)).toEqual({ status: 'fail', latest: fail });
  });

  it('조회 처리기는 결합 지점이 돌려준 최신 판정을 규칙마다 붙여 파이프로 보낸다', async () => {
    const req = await createRequirement();
    const judged = await approveRule(req.id, '판정된 규칙');
    const fresh = await approveRule(req.id, '판정 전 규칙');
    const latest = record(judged.id, 'needs_recheck');
    const socketPath = path.join(h.biveHome, 'j.sock');
    const server = new PipeServer({
      transport: new NetPipeTransport(),
      path: socketPath,
      token: TOKEN,
      orchestratorVersion: '0.0.0-test',
      handlers: createRuleHandlers({
        biveHome: h.biveHome,
        latestJudgments: () => (ruleId) => (ruleId === judged.id ? latest : null),
      }),
    });
    servers.push(server);
    await server.listen();
    const client = await connect(socketPath, TOKEN);
    clients.push(client);

    expect((await client.call('rule.list', { projectId: h.project.id })).rules).toEqual([
      { rule: judged, judgment: { status: 'needs_recheck', latest } },
      { rule: fresh, judgment: UNJUDGED },
    ]);
    expect(await client.call('rule.get', { projectId: h.project.id, id: judged.id })).toEqual({
      rule: judged,
      judgment: { status: 'needs_recheck', latest },
      latestRun: null,
    });
  });
});

describe('judgment.list: 규칙 상세의 실행 이력 (M1-28, ADR-073)', () => {
  const failingCase = {
    name: 'RULE-001 > 중복 이메일이면 409',
    file: 'bive-acceptance/RULE-001/signup.acc.ts',
    line: 12,
    status: 'failed',
    message: 'expected 201 to be 409',
  } as const;

  const record = (
    ruleId: string,
    patch: Partial<JudgmentResult> & Pick<JudgmentResult, 'judgedAt' | 'status'>,
  ): JudgmentResult => ({
    id: newId(),
    ruleId,
    runId: null,
    stepId: null,
    commit: 'c'.repeat(40),
    runner: 'vitest',
    exitCode: patch.status === 'pass' ? 0 : 1,
    reporterPath: null,
    cases: [],
    quarantineReason: null,
    ...patch,
  });

  /** 실행 1건을 저장소에 바로 만든다 (판정 기록의 실행 링크용, 실행 생성 경로는 run.test.ts). */
  const createRun = (ruleId: string) =>
    h.read((store) =>
      store.runs.create({
        id: newId(),
        type: 'A',
        targetRuleIds: [ruleId],
        currentStep: 'approval',
        baseBranch: 'main',
        budgetSnapshot: { run: { maxBudgetUsd: 5, maxTurns: 200 }, roles: {} },
        modelSnapshot: {},
        startedBy: human,
        createdAt: iso(T0),
        steps: RUN_STEP_PLANS.A.map((kind) => ({
          id: newId(),
          kind,
          attempt: 1,
          status: 'pending' as const,
          role: STEP_ROLES[kind],
          startedAt: null,
        })),
      }),
    );

  it('판정 기록이 없으면 빈 이력', async () => {
    const req = await createRequirement();
    const rule = await approveRule(req.id, '중복 이메일 가입 거부');
    expect(
      await h.client.call('judgment.list', { projectId: h.project.id, ruleId: rule.id }),
    ).toEqual({ judgments: [] });
  });

  it('그 규칙의 판정 기록만 최신부터, 실행 표시 ID와 실행기 출력(케이스 이름 · 메시지 · 파일 · 줄)을 그대로 싣는다', async () => {
    const req = await createRequirement();
    const rule = await approveRule(req.id, '중복 이메일 가입 거부');
    const other = await approveRule(req.id, '다른 규칙');
    const { run, steps } = createRun(rule.id);
    const older = record(rule.id, { judgedAt: iso(T0 + 1_000), status: 'pass' });
    const latest = record(rule.id, {
      judgedAt: iso(T0 + 2_000),
      status: 'fail',
      runId: run.id,
      stepId: steps.find((step) => step.kind === 'implementation')?.id ?? null,
      cases: [failingCase],
    });
    const elsewhere = record(other.id, { judgedAt: iso(T0 + 3_000), status: 'pass' });
    h.read((store) => store.judgments.record([older, latest, elsewhere]));

    expect(
      await h.client.call('judgment.list', { projectId: h.project.id, ruleId: rule.id }),
    ).toEqual({
      judgments: [
        { judgment: latest, runDisplayId: run.displayId },
        { judgment: older, runDisplayId: null },
      ],
    });
    expect(run.displayId).toBe('EXE-001');
    // 최신 판정(rule.get)과 이력의 첫 항목은 같은 기록이다
    expect(
      (await h.client.call('rule.get', { projectId: h.project.id, id: rule.id })).judgment.latest,
    ).toEqual(latest);
  });

  it('삭제된 규칙도 돌려주고, 없는 규칙 · 제안 ID · 등록되지 않은 프로젝트는 -32004', async () => {
    const req = await createRequirement();
    const rule = await approveRule(req.id, '삭제된 규칙');
    markDeleted(rule.id, iso(T0 + 9_000));
    expect(
      await h.client.call('judgment.list', { projectId: h.project.id, ruleId: rule.id }),
    ).toEqual({ judgments: [] });

    const pending = submitRule(req.id, '승인 대기 규칙');
    for (const params of [
      { projectId: h.project.id, ruleId: newId() },
      { projectId: h.project.id, ruleId: pending.id },
      { projectId: newId(), ruleId: rule.id },
    ]) {
      await expect(h.client.call('judgment.list', params)).rejects.toMatchObject({
        code: ErrorCode.NotFound,
      });
    }
  });
});

describe('rule.get: 최신 실행 링크의 비용 · 턴 (M3-16 #61, COST-02 · ADR-134)', () => {
  /**
   * 실행 1건을 저장소에 바로 만든다. 단계 시도는 유형 A 계획에 `extra`(회귀로 생기는 다음 시도)를 더한다.
   * 표시 ID는 만든 순서대로 붙는다(EXE-001, EXE-002, ...).
   */
  const createRun = (
    targetRuleIds: string[],
    extra: { kind: 'test_writing' | 'implementation'; attempt: number }[] = [],
    createdAt = iso(T0),
  ): { run: Run; steps: Step[] } =>
    h.read((store) =>
      store.runs.create({
        id: newId(),
        type: 'A',
        targetRuleIds,
        currentStep: 'approval',
        baseBranch: 'main',
        budgetSnapshot: { run: { maxBudgetUsd: 5, maxTurns: 200 }, roles: {} },
        modelSnapshot: {},
        startedBy: human,
        createdAt,
        steps: [...RUN_STEP_PLANS.A.map((kind) => ({ kind, attempt: 1 })), ...extra].map(
          ({ kind, attempt }) => ({
            id: newId(),
            kind,
            attempt,
            status: 'pending' as const,
            role: STEP_ROLES[kind],
            startedAt: null,
          }),
        ),
      }),
    );

  const stepOf = (steps: Step[], kind: Step['kind'], attempt = 1): Step => {
    const step = steps.find((item) => item.kind === kind && item.attempt === attempt);
    if (step === undefined) throw new Error(`단계 없음: ${kind} ${String(attempt)}`);
    return step;
  };

  /**
   * 단계 시도에 세션 1개를 기록한다. `end`가 `null`이면 끝나지 않은 세션(진행 중), 값이 `null`이면 결과에 그 값이 없던
   * 세션(비정상 종료 등)이다.
   */
  const addSession = (
    run: Run,
    step: Step,
    end: { costUsd: number | null; turns: number | null; reason?: 'success' | 'aborted' } | null,
  ): void => {
    h.read((store) => {
      const id = newId();
      store.sessions.start({
        id,
        runId: run.id,
        stepId: step.id,
        role: step.role ?? 'implementer',
        model: 'test-model',
        workDir: '/w',
        budget: { maxBudgetUsd: 1, maxTurns: 20 },
        startedAt: iso(T0 + 1_000),
      });
      if (end !== null) {
        store.sessions.end(id, {
          endReason: end.reason ?? 'success',
          totalCostUsd: end.costUsd,
          numTurns: end.turns,
          endedAt: iso(T0 + 2_000),
        });
      }
    });
  };

  const latestRunOf = async (ruleId: string) =>
    (await h.client.call('rule.get', { projectId: h.project.id, id: ruleId })).latestRun;

  it('그 규칙을 대상으로 한 실행이 없으면 최신 실행 자체가 null', async () => {
    const req = await createRequirement();
    const rule = await approveRule(req.id, '중복 이메일 가입 거부');
    expect(await latestRunOf(rule.id)).toBeNull();
  });

  it('세션이 없는 실행은 실행 ID · 표시 ID와 비용 · 턴 null (0이 아니다)', async () => {
    const req = await createRequirement();
    const rule = await approveRule(req.id, '중복 이메일 가입 거부');
    const { run } = createRun([rule.id]);
    expect(await latestRunOf(rule.id)).toEqual({
      id: run.id,
      displayId: 'EXE-001',
      costUsd: null,
      turns: null,
    });
  });

  it('값이 모두 있는 실행: 모든 단계 · 회귀로 생긴 다음 시도의 모든 세션을 더한다 (실행 사용량 집계와 같은 값)', async () => {
    const req = await createRequirement();
    const rule = await approveRule(req.id, '중복 이메일 가입 거부');
    const { run, steps } = createRun(
      [rule.id],
      [
        { kind: 'implementation', attempt: 2 },
        { kind: 'implementation', attempt: 3 },
      ],
    );
    addSession(run, stepOf(steps, 'test_writing'), { costUsd: 0.1, turns: 3 });
    addSession(run, stepOf(steps, 'implementation', 1), { costUsd: 0.2, turns: 5 });
    addSession(run, stepOf(steps, 'implementation', 2), { costUsd: 0.05, turns: 2 });
    addSession(run, stepOf(steps, 'implementation', 3), { costUsd: 0.004, turns: 1 });
    const latest = await latestRunOf(rule.id);
    // 0.1 + 0.2 + 0.05 + 0.004 (나노 달러 정수 합산이라 부동소수 오차가 없다)
    expect(latest).toEqual({ id: run.id, displayId: 'EXE-001', costUsd: 0.354, turns: 11 });
    // 같은 값을 두 가지로 계산하지 않는다: 실행 사용량 집계(run.get의 usage)와 같다
    const usage = h.read((store) => store.runs.usage(run.id));
    expect(usage?.run.costUsd).toBe(latest?.costUsd);
    expect(usage?.run.turns).toBe(latest?.turns);
  });

  it('비용 · 턴을 모르는 세션이 하나라도 섞이면 그 값은 null (아는 것만 더한 하한 · 0으로 더한 값을 보이지 않는다)', async () => {
    const req = await createRequirement();
    const both = await approveRule(req.id, '비용 · 턴 모두 모름');
    const costOnly = await approveRule(req.id, '비용만 모름');
    const turnsOnly = await approveRule(req.id, '턴만 모름');
    const running = await approveRule(req.id, '진행 중 세션');

    // 결과 없이 끝난 세션(비정상 종료): 비용 · 턴 모두 모름
    const a = createRun([both.id]);
    addSession(a.run, stepOf(a.steps, 'test_writing'), { costUsd: 0.1, turns: 3 });
    addSession(a.run, stepOf(a.steps, 'implementation'), {
      costUsd: null,
      turns: null,
      reason: 'aborted',
    });
    expect(await latestRunOf(both.id)).toEqual({
      id: a.run.id,
      displayId: a.run.displayId,
      costUsd: null,
      turns: null,
    });

    // 비용만 모름: 턴은 모든 세션의 합
    const b = createRun([costOnly.id]);
    addSession(b.run, stepOf(b.steps, 'test_writing'), { costUsd: 0.1, turns: 3 });
    addSession(b.run, stepOf(b.steps, 'implementation'), { costUsd: null, turns: 4 });
    expect(await latestRunOf(costOnly.id)).toEqual({
      id: b.run.id,
      displayId: b.run.displayId,
      costUsd: null,
      turns: 7,
    });

    // 턴만 모름: 비용은 모든 세션의 합
    const c = createRun([turnsOnly.id]);
    addSession(c.run, stepOf(c.steps, 'test_writing'), { costUsd: 0.1, turns: 3 });
    addSession(c.run, stepOf(c.steps, 'implementation'), { costUsd: 0.25, turns: null });
    expect(await latestRunOf(turnsOnly.id)).toEqual({
      id: c.run.id,
      displayId: c.run.displayId,
      costUsd: 0.35,
      turns: null,
    });

    // 아직 끝나지 않은 세션: 지금까지의 합은 하한이라 둘 다 null
    const d = createRun([running.id]);
    addSession(d.run, stepOf(d.steps, 'test_writing'), { costUsd: 0.1, turns: 3 });
    addSession(d.run, stepOf(d.steps, 'implementation'), null);
    expect(await latestRunOf(running.id)).toEqual({
      id: d.run.id,
      displayId: d.run.displayId,
      costUsd: null,
      turns: null,
    });
  });

  it('기록이 실제로 0이면 0 (null과 구분한다)', async () => {
    const req = await createRequirement();
    const rule = await approveRule(req.id, '첫 요청 실패');
    const { run, steps } = createRun([rule.id]);
    addSession(run, stepOf(steps, 'test_writing'), { costUsd: 0, turns: 0 });
    expect(await latestRunOf(rule.id)).toEqual({
      id: run.id,
      displayId: 'EXE-001',
      costUsd: 0,
      turns: 0,
    });
  });

  it('여러 실행 중 가장 나중에 만든 실행(표시 ID 순 마지막)을 고르고 그 실행의 세션만 더한다', async () => {
    const req = await createRequirement();
    const rule = await approveRule(req.id, '중복 이메일 가입 거부');
    // 생성 시각이 뒤섞여 있어도 표시 ID(= 생성 순)로 고른다
    const first = createRun([rule.id], [], iso(T0 + 3_000));
    addSession(first.run, stepOf(first.steps, 'test_writing'), { costUsd: 1, turns: 10 });
    const second = createRun([rule.id], [], iso(T0 + 1_000));
    addSession(second.run, stepOf(second.steps, 'test_writing'), { costUsd: 0.5, turns: 6 });
    const third = createRun([rule.id], [], iso(T0 + 2_000));
    addSession(third.run, stepOf(third.steps, 'test_writing'), { costUsd: 0.2, turns: 2 });
    expect([first, second, third].map(({ run }) => run.displayId)).toEqual([
      'EXE-001',
      'EXE-002',
      'EXE-003',
    ]);
    expect(await latestRunOf(rule.id)).toEqual({
      id: third.run.id,
      displayId: 'EXE-003',
      costUsd: 0.2,
      turns: 2,
    });
  });

  it('다른 규칙만 대상인 실행은 섞이지 않는다 (더 나중에 만들어졌어도)', async () => {
    const req = await createRequirement();
    const mine = await approveRule(req.id, '이 규칙');
    const other = await approveRule(req.id, '다른 규칙');
    const own = createRun([mine.id]);
    addSession(own.run, stepOf(own.steps, 'test_writing'), { costUsd: 0.3, turns: 4 });
    const foreign = createRun([other.id]);
    addSession(foreign.run, stepOf(foreign.steps, 'test_writing'), { costUsd: 2, turns: 30 });
    expect(await latestRunOf(mine.id)).toEqual({
      id: own.run.id,
      displayId: 'EXE-001',
      costUsd: 0.3,
      turns: 4,
    });
    expect(await latestRunOf(other.id)).toEqual({
      id: foreign.run.id,
      displayId: 'EXE-002',
      costUsd: 2,
      turns: 30,
    });
  });

  it('여러 규칙을 대상으로 한 실행은 대상 규칙마다 같은 실행 합계로 최신 실행이 된다 (대상 순서와 무관)', async () => {
    const req = await createRequirement();
    const firstTarget = await approveRule(req.id, '첫 대상');
    const secondTarget = await approveRule(req.id, '둘째 대상');
    const onlyFirst = createRun([firstTarget.id]);
    addSession(onlyFirst.run, stepOf(onlyFirst.steps, 'test_writing'), { costUsd: 9, turns: 90 });
    const both = createRun([firstTarget.id, secondTarget.id]);
    addSession(both.run, stepOf(both.steps, 'test_writing'), { costUsd: 0.4, turns: 5 });
    addSession(both.run, stepOf(both.steps, 'implementation'), { costUsd: 0.6, turns: 7 });
    const expected = { id: both.run.id, displayId: 'EXE-002', costUsd: 1, turns: 12 };
    expect(await latestRunOf(firstTarget.id)).toEqual(expected);
    expect(await latestRunOf(secondTarget.id)).toEqual(expected);
  });

  it('rule.list 항목에는 최신 실행을 싣지 않는다 (목록에서 규칙마다 실행 · 세션을 읽지 않는다)', async () => {
    const req = await createRequirement();
    const rule = await approveRule(req.id, '중복 이메일 가입 거부');
    const { run, steps } = createRun([rule.id]);
    addSession(run, stepOf(steps, 'test_writing'), { costUsd: 0.1, turns: 1 });
    const [item] = await listRules();
    expect(item).toEqual({ rule, judgment: UNJUDGED });
    expect(item).not.toHaveProperty('latestRun');
  });
});

/** 규칙 소프트 삭제를 흉내 낸다 (규칙 삭제 경로는 아직 없다). */
const markDeleted = (ruleId: string, at: string): void => {
  h.read((store) =>
    store.db
      .prepare('UPDATE rules SET deleted_at = ?, updated_at = ? WHERE id = ?')
      .run(at, at, ruleId),
  );
};
