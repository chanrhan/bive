// 규칙 조회 RPC (M1-11 수용 기준 1, NRM-02 · JDG-02 · NRM-04 · ADR-060).
// `rule.list` · `rule.get`은 규칙 테이블의 규범(승인된 규칙)만, 승인 전 · 거절된 제안은 빼고, 최신 판정과 함께 돌려준다.
// 판정 기록이 없으면 미판정이다. 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소.
import path from 'node:path';

import {
  createUlidGenerator,
  ErrorCode,
  type Author,
  type JudgmentResult,
  type Proposal,
  type Requirement,
  type Rule,
  type RuleNewPayload,
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

  it('판정 기록 저장소가 생기기 전(#29)에는 어떤 규칙도 판정 기록이 없다', async () => {
    const req = await createRequirement();
    const rule = await approveRule(req.id, '중복 이메일 가입 거부');
    expect(h.read((store) => storedLatestJudgments(store)(rule.id))).toBeNull();
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
    });
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
