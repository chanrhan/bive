// 확인 상태 · 사람 전용 확인 RPC (M7-01 #213 수용 기준 1 · 2, NFR-01 · ADR-100 D2 · I1 · B① · C1 · C2 · A1 · A2 · ADR-101).
// - 요구사항 · 규칙마다 확인 상태(미확인 · 확인됨, 기본 미확인)가 저장되고 조회 응답에 실린다
// - `confirmation.set`은 사람 주체만 받고(에이전트 -32020) 없는 대상은 -32004, 확인은 승인 기록 `confirm`으로 남는다
// - 사람의 `requirement.create` · `requirement.update`는 같은 트랜잭션에서 확인됨이 되고 승인 기록은 늘지 않는다
// - 사람이 승인한 제안으로 생긴 규칙 · 요구사항은 확인됨(근거 = 그 승인 기록 순번), 제안 승인 없이 생긴 규칙은 미확인
// - 확인 풀림 (M7-13 #225 수용 기준 1, ADR-100 D3 · C2, ADR-113): 확인됨 규칙을 에이전트가 폐기 · 대체하면 같은 트랜잭션에서
//   미확인이 되고 규범 변경 기록에 확인 풀림(주체 오케스트레이터 · 풀린 시각 · 원인 순번 · 앞선 확인)이 남는다. 원자성은 k번째
//   쓰기만 실패시키는 시험용 트리거로 쓰기마다 본다
// - 확인할 것 목록 (M7-13 수용 기준 3, ADR-100 B⑦ · A7): 폐기 · 대체가 시각 최신순으로 맨 앞, 그 뒤 테스트 변경 · 미확인 규범
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소.
import {
  APPROVAL_LOG_GENESIS_HASH,
  type Author,
  CONFIRMATION_LIST_MAX_ITEMS,
  type ConfirmationItem,
  createUlidGenerator,
  ErrorCode,
  type Requirement,
  type Rule,
  RuleNewPayload,
} from '@bive/shared';
import { computeApprovalLogHash, type ProjectStore } from '@bive/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PipeServer } from '../src/ipc/server.js';
import { RELEASE_REASON, retireAgentRule, supersedeAgentRule } from '../src/norms/agent-rule.js';
import { recordTestChanges } from '../src/norms/test-change.js';
import type { TestClient } from './helpers/client.js';
import { seedNormRequirement, seedNormRule } from './helpers/engine-harness.js';
import { cleanup } from './helpers/process.js';
import { iso, startProjectHarness, T0, type ProjectHarness } from './helpers/project-harness.js';

const human = { kind: 'human' } as const satisfies Author;
const AGENTS = [
  { kind: 'agent', role: 'rule-writer' },
  { kind: 'agent', role: 'test-writer' },
  { kind: 'agent', role: 'implementer' },
  { kind: 'agent', role: 'planner' },
  { kind: 'agent', role: 'chat' },
] as const satisfies readonly Author[];

const newId = createUlidGenerator();

const servers: PipeServer[] = [];
const clients: TestClient[] = [];
let h: ProjectHarness;

beforeEach(async () => {
  h = await startProjectHarness({ servers, clients });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  await cleanup();
});

const createRequirement = async (text = '사용자는 이메일로 가입할 수 있다'): Promise<Requirement> =>
  (await h.client.call('requirement.create', { projectId: h.project.id, text, author: human }))
    .requirement;

/** 제안 승인 없이 생긴 규칙 (에이전트 작성, 저장소에 바로 둔다: 규칙 작성 결과의 바로 반영 M7-02의 자리). */
const seedAgentRule = (parentRequirementId: string): Rule =>
  h.read((store: ProjectStore) =>
    store.rules.create({
      id: newId(),
      title: '중복 이메일 가입 거부',
      statement: 'WHEN 이미 가입된 이메일로 가입을 요청하면 THE SYSTEM SHALL 가입을 거부한다',
      kind: 'business',
      checkKinds: ['test'],
      parentRequirementId,
      builtin: false,
      targetBlockIds: [],
      risk: null,
      contractId: null,
      author: { kind: 'agent', role: 'rule-writer' },
      normState: 'approved',
      createdAt: iso(T0),
    }),
  );

const ruleOf = async (id: string): Promise<Rule> =>
  (await h.client.call('rule.get', { projectId: h.project.id, id })).rule;

const logOf = () => h.read((store) => store.approvalLog.list());

describe('확인 상태 저장: 요구사항 · 규칙마다 두 값, 기본 미확인 (ADR-100 D2 · C1)', () => {
  it('제안 승인 없이 생긴 규칙은 미확인이고 rule.list · rule.get · 저장소 모두 같은 값을 돌려준다', async () => {
    const requirement = await createRequirement();
    const rule = seedAgentRule(requirement.id);
    expect(rule.confirmation).toEqual({ state: 'unconfirmed' });
    expect((await ruleOf(rule.id)).confirmation).toEqual({ state: 'unconfirmed' });
    const { rules } = await h.client.call('rule.list', { projectId: h.project.id });
    expect(rules.map((item) => item.rule.confirmation)).toEqual([{ state: 'unconfirmed' }]);
    expect(h.read((store) => store.confirmations.get({ entity: 'Rule', id: rule.id }))).toEqual({
      state: 'unconfirmed',
    });
    // 확인 상태 행이 없다 = 기본 미확인
    expect(h.read((store) => store.db.prepare('SELECT * FROM confirmations').all())).toEqual([
      {
        entity: 'Requirement',
        target_id: requirement.id,
        state: 'confirmed',
        confirmed_at: iso(T0),
        confirmed_by: '{"kind":"human"}',
        basis: JSON.stringify({ kind: 'requirement_record', at: iso(T0) }),
      },
    ]);
  });
});

describe('사람의 저장 = 확인됨 (수용 기준 2, ADR-100 B① · A1, NRM-01)', () => {
  it('requirement.create는 같은 트랜잭션에서 확인됨(근거 = 작성 기록)이 되고 승인 기록은 늘지 않는다', async () => {
    h.clock.now = T0 + 5_000;
    const requirement = await createRequirement();
    const confirmed = {
      state: 'confirmed',
      at: iso(T0 + 5_000),
      by: human,
      basis: { kind: 'requirement_record', at: iso(T0 + 5_000) },
    };
    expect(requirement.confirmation).toEqual(confirmed);
    expect(requirement).toMatchObject({ author: human, createdAt: iso(T0 + 5_000) });
    await expect(
      h.client.call('requirement.get', { projectId: h.project.id, id: requirement.id }),
    ).resolves.toEqual({ requirement });
    await expect(h.client.call('requirement.list', { projectId: h.project.id })).resolves.toEqual({
      requirements: [requirement],
    });
    expect(logOf()).toEqual([]);
  });

  it('requirement.update는 수정과 같은 트랜잭션에서 확인됨(근거 = 수정 기록의 시각)으로 바뀌고 승인 기록은 늘지 않는다', async () => {
    const requirement = await createRequirement();
    h.clock.now = T0 + 60_000;
    const { requirement: updated } = await h.client.call('requirement.update', {
      projectId: h.project.id,
      id: requirement.id,
      text: '사용자는 이메일과 휴대폰 번호로 가입할 수 있다',
      author: human,
    });
    expect(updated.confirmation).toEqual({
      state: 'confirmed',
      at: iso(T0 + 60_000),
      by: human,
      basis: { kind: 'requirement_record', at: iso(T0 + 60_000) },
    });
    expect(updated).toMatchObject({ updatedAt: iso(T0 + 60_000), updatedBy: human });
    await expect(
      h.client.call('requirement.get', { projectId: h.project.id, id: requirement.id }),
    ).resolves.toEqual({ requirement: updated });
    expect(logOf()).toEqual([]);
  });

  it('에이전트 주체의 요구사항 작성 · 편집은 -32020이고 확인 상태가 생기지 않는다', async () => {
    const requirement = await createRequirement();
    for (const author of AGENTS) {
      await expect(
        h.client.call('requirement.create', { projectId: h.project.id, text: '에이전트', author }),
      ).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
      await expect(
        h.client.call('requirement.update', {
          projectId: h.project.id,
          id: requirement.id,
          text: '에이전트가 고침',
          author,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
    }
    expect(h.read((store) => store.requirements.list())).toEqual([requirement]);
  });
});

describe('confirmation.set: 사람 전용 확인 RPC (수용 기준 1, NFR-01 · ADR-100 I1 · C2 · A2)', () => {
  it('사람의 확인은 승인 기록 confirm(사람 · 대상 · 연결 · 이전 해시)과 확인됨(근거 = 그 순번)을 함께 남긴다', async () => {
    const requirement = await createRequirement();
    const rule = seedAgentRule(requirement.id);
    h.clock.now = T0 + 120_000;
    const result = await h.client.call('confirmation.set', {
      projectId: h.project.id,
      target: { entity: 'Rule', id: rule.id },
      author: human,
    });
    expect(result.approvalLog).toEqual({
      seq: 1,
      at: iso(T0 + 120_000),
      action: 'confirm',
      actor: human,
      targetRef: { entity: 'Rule', id: rule.id },
      clientId: expect.stringMatching(/^pipe-\d+$/) as unknown as string,
      detail: {},
      prevHash: APPROVAL_LOG_GENESIS_HASH,
      hash: computeApprovalLogHash(result.approvalLog),
    });
    const confirmed = {
      state: 'confirmed',
      at: iso(T0 + 120_000),
      by: human,
      basis: { kind: 'approval_log', seq: 1 },
    };
    expect(result).toMatchObject({
      target: { entity: 'Rule', id: rule.id },
      confirmation: confirmed,
    });
    // 저장된 확인 상태가 조회 응답에 실린다
    expect((await ruleOf(rule.id)).confirmation).toEqual(confirmed);
    // 승인 기록(사람 행동만)에 새 행동으로 남고 체인이 검증된다
    await expect(h.client.call('approvalLog.list', { projectId: h.project.id })).resolves.toEqual({
      entries: [result.approvalLog],
      chain: { valid: true, brokenAtSeq: null, reason: null },
    });
    await expect(
      h.client.call('approvalLog.list', {
        projectId: h.project.id,
        targetRef: { entity: 'Rule', id: rule.id },
      }),
    ).resolves.toMatchObject({ entries: [result.approvalLog] });
  });

  it('에이전트 주체는 -32020이고 확인 상태 · 승인 기록이 그대로다', async () => {
    const requirement = await createRequirement();
    const rule = seedAgentRule(requirement.id);
    for (const author of AGENTS) {
      await expect(
        h.client.call('confirmation.set', {
          projectId: h.project.id,
          target: { entity: 'Rule', id: rule.id },
          author,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
    }
    // 프로젝트가 없어도 주체부터 거부한다 (저장소를 열기 전)
    await expect(
      h.client.call('confirmation.set', {
        projectId: newId(),
        target: { entity: 'Rule', id: rule.id },
        author: { kind: 'agent', role: 'test-writer' },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
    expect((await ruleOf(rule.id)).confirmation).toEqual({ state: 'unconfirmed' });
    expect(logOf()).toEqual([]);
  });

  it('없는 대상(규칙 · 요구사항)은 -32004, 확인 상태를 두지 않는 엔터티는 -32602, 아무것도 남지 않는다', async () => {
    const requirement = await createRequirement();
    for (const entity of ['Rule', 'Requirement'] as const) {
      await expect(
        h.client.call('confirmation.set', {
          projectId: h.project.id,
          target: { entity, id: newId() },
          author: human,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.NotFound });
    }
    // 제안 · 계약은 확인 대상이 아니다 (스키마)
    for (const entity of ['Proposal', 'Contract']) {
      const response = await h.client.requestRaw({
        jsonrpc: '2.0',
        id: entity,
        method: 'confirmation.set',
        params: { projectId: h.project.id, target: { entity, id: requirement.id }, author: human },
      });
      expect(response).toMatchObject({ error: { code: ErrorCode.InvalidParams } });
    }
    // 등록되지 않은 프로젝트도 -32004
    await expect(
      h.client.call('confirmation.set', {
        projectId: newId(),
        target: { entity: 'Requirement', id: requirement.id },
        author: human,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.NotFound });
    expect(logOf()).toEqual([]);
  });

  it('이미 확인됨 · 삭제된 대상은 -32009이고 승인 기록이 늘지 않는다', async () => {
    const requirement = await createRequirement();
    // 사람이 쓴 요구사항은 이미 확인됨
    await expect(
      h.client.call('confirmation.set', {
        projectId: h.project.id,
        target: { entity: 'Requirement', id: requirement.id },
        author: human,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.StateConflict });
    const rule = seedAgentRule(requirement.id);
    const target = { entity: 'Rule', id: rule.id } as const;
    await h.client.call('confirmation.set', { projectId: h.project.id, target, author: human });
    await expect(
      h.client.call('confirmation.set', { projectId: h.project.id, target, author: human }),
    ).rejects.toMatchObject({ code: ErrorCode.StateConflict });
    expect(logOf().map((entry) => entry.action)).toEqual(['confirm']);

    // 삭제된 요구사항 (에이전트가 쓴 미확인 요구사항을 사람이 지움)
    const agentRequirement = h.read((store) =>
      store.requirements.create({
        id: newId(),
        text: '에이전트가 쓴 요구사항',
        author: { kind: 'agent', role: 'chat' },
        normState: 'approved',
        createdAt: iso(T0),
      }),
    );
    expect(agentRequirement.confirmation).toEqual({ state: 'unconfirmed' });
    await h.client.call('requirement.delete', {
      projectId: h.project.id,
      id: agentRequirement.id,
      author: human,
    });
    await expect(
      h.client.call('confirmation.set', {
        projectId: h.project.id,
        target: { entity: 'Requirement', id: agentRequirement.id },
        author: human,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.StateConflict });
    // 삭제는 확인 상태를 바꾸지 않는다
    expect(h.read((store) => store.requirements.get(agentRequirement.id)?.confirmation)).toEqual({
      state: 'unconfirmed',
    });
    expect(logOf().map((entry) => entry.action)).toEqual(['confirm']);
  });
});

describe('사람이 승인한 제안으로 생긴 규범은 확인됨 (ADR-100 A1, 이행 마이그레이션과 같은 규칙)', () => {
  it('규칙 신규 승인 · 수정 후 승인은 반영 규칙을 확인됨(근거 = approve · approve_edited 순번)으로, 거절은 아무것도 확인하지 않는다', async () => {
    const requirement = await createRequirement();
    const submit = (title: string) =>
      h.proposals.submit(h.project.id, {
        kind: 'rule_new',
        payload: {
          title,
          statement: 'WHEN 이미 가입된 이메일로 가입을 요청하면 THE SYSTEM SHALL 가입을 거부한다',
          kind: 'business',
          checkKinds: ['test'],
          parentRequirementId: requirement.id,
        },
        rationale: '요구사항의 예외 경로',
        author: { kind: 'agent', role: 'rule-writer' },
        source: 'rule_generation',
      });
    const first = submit('중복 이메일 가입 거부');
    const second = submit('중복 가입 거부');
    const third = submit('거절될 제안');
    h.clock.now = T0 + 1_000;
    const approved = await h.client.call('proposal.approve', {
      projectId: h.project.id,
      id: first.id,
      author: human,
    });
    h.clock.now = T0 + 2_000;
    const amended = await h.client.call('proposal.amend', {
      projectId: h.project.id,
      id: second.id,
      author: human,
      edited: { ...RuleNewPayload.parse(second.payload), title: '같은 이메일 중복 가입 거부' },
    });
    await h.client.call('proposal.reject', {
      projectId: h.project.id,
      id: third.id,
      author: human,
      reason: '중복',
    });
    const ruleOfApplied = (applied: typeof approved.applied): Rule => {
      if (applied.entity !== 'Rule') throw new Error('규칙이 아님');
      return applied.rule;
    };
    expect(approved.approvalLog).toMatchObject({ seq: 1, action: 'approve' });
    expect(amended.approvalLog).toMatchObject({ seq: 2, action: 'approve_edited' });
    expect(ruleOfApplied(approved.applied).confirmation).toEqual({
      state: 'confirmed',
      at: iso(T0 + 1_000),
      by: human,
      basis: { kind: 'approval_log', seq: 1 },
    });
    expect(ruleOfApplied(amended.applied).confirmation).toEqual({
      state: 'confirmed',
      at: iso(T0 + 2_000),
      by: human,
      basis: { kind: 'approval_log', seq: 2 },
    });
    // 응답의 확인 상태가 저장된 값과 같다
    const { rules } = await h.client.call('rule.list', { projectId: h.project.id });
    expect(rules.map((item) => item.rule)).toEqual([
      ruleOfApplied(approved.applied),
      ruleOfApplied(amended.applied),
    ]);
    // 승인으로 확인됨이 될 때 승인 기록은 승인 · 수정 후 승인 · 거절 3건뿐 (확인 항목을 따로 만들지 않는다)
    expect(logOf().map((entry) => entry.action)).toEqual(['approve', 'approve_edited', 'reject']);
  });

  it('요구사항 신규 제안의 승인도 반영 요구사항을 확인됨(근거 = 승인 기록 순번)으로 둔다', async () => {
    const proposal = h.proposals.submit(h.project.id, {
      kind: 'requirement_new',
      payload: { text: '관리자는 회원을 정지할 수 있다' },
      rationale: '운영 요구가 빠져 있음',
      author: { kind: 'agent', role: 'chat' },
      source: 'chat',
    });
    const result = await h.client.call('proposal.approve', {
      projectId: h.project.id,
      id: proposal.id,
      author: human,
    });
    if (result.applied.entity !== 'Requirement') throw new Error('요구사항이 아님');
    expect(result.applied.requirement.author).toEqual({ kind: 'agent', role: 'chat' });
    expect(result.applied.requirement.confirmation).toEqual({
      state: 'confirmed',
      at: iso(T0),
      by: human,
      basis: { kind: 'approval_log', seq: result.approvalLog.seq },
    });
  });
});

// ── 확인 풀림 · 확인할 것 목록 (M7-13 #225, ADR-100 D3 · B⑦ · C2 · G · A7, ADR-113) ─────

const AGENT_RW = { kind: 'agent', role: 'rule-writer' } as const;
const SESSION = newId();
const STATEMENT_A = 'WHEN 사용자가 가입을 요청하면 THE SYSTEM SHALL 이메일 형식을 검사한다';
const STATEMENT_B = 'WHEN 사용자가 가입을 요청하면 THE SYSTEM SHALL 비밀번호 길이를 검사한다';
const STATEMENT_C = 'WHEN 가입이 끝나면 THE SYSTEM SHALL 안내 화면을 보인다';
/** 진술을 글자 그대로 인용한 근거 (A · B · C 각각) */
const GROUNDS_A =
  '진술 "이메일 형식을 검사한다"는 새 요구사항(형식 검사 없음)과 동시에 만족될 수 없다';
const GROUNDS_B = '진술 "비밀번호 길이를 검사한다"는 새 요구사항과 동시에 만족될 수 없다';
const GROUNDS_C = '진술 "안내 화면을 보인다"는 더 쓰지 않는다';
const NORM_INPUT = {
  requirements: { total: 1, included: 1, omitted: 0 },
  rules: { total: 3, included: 3, omitted: 0 },
  truncated: false,
} as const;
const NEW_RULE = {
  title: '가입 비밀번호 길이 검사 없음',
  statement: 'WHEN 사용자가 가입을 요청하면 THE SYSTEM SHALL 비밀번호 길이로 가입을 막지 않는다',
  kind: 'business',
  checkKinds: ['test'],
} as const;
const RATIONALE = "새 요구사항의 '길이 제한 없음'을 옮김";

interface Norms {
  requirement: Requirement;
  a: Rule;
  b: Rule;
  c: Rule;
}

/** 사람의 요구사항 1개(확인됨) + 에이전트 규칙 A · B · C (미확인, 효력). */
const seedNorms = (): Norms =>
  h.read((store) => {
    const requirement = seedNormRequirement(store, '사용자는 이메일로 가입할 수 있다', T0);
    // 사람의 작성 = 확인됨 (요구사항 RPC와 같은 모양, 이 묶음에서는 저장소에 바로 둔다)
    store.confirmations.confirm(
      { entity: 'Requirement', id: requirement.id },
      { by: human, at: iso(T0), basis: { kind: 'requirement_record', at: iso(T0) } },
    );
    const rule = (title: string, statement: string, at: number) =>
      seedNormRule(store, { title, statement, parent: requirement, at });
    return {
      requirement,
      a: rule('가입 이메일 형식 검사', STATEMENT_A, T0 + 1),
      b: rule('가입 비밀번호 길이 검사', STATEMENT_B, T0 + 2),
      c: rule('가입 완료 안내', STATEMENT_C, T0 + 3),
    };
  });

const confirmRule = async (id: string, at: number) => {
  h.clock.now = at;
  return h.client.call('confirmation.set', {
    projectId: h.project.id,
    target: { entity: 'Rule', id },
    author: human,
  });
};

const retireAt = (ruleId: string, grounds: string, at: number) =>
  h.read((store) =>
    retireAgentRule(
      store,
      { ruleId, grounds, author: AGENT_RW, sessionId: SESSION },
      { now: () => at },
    ),
  );

const supersedeAt = (norms: Norms, ruleId: string, grounds: string, at: number) =>
  h.read((store) =>
    supersedeAgentRule(
      store,
      {
        payload: { ...NEW_RULE, parentRequirementId: norms.requirement.id },
        rationale: RATIONALE,
        author: AGENT_RW,
        sessionId: SESSION,
        contradiction: { verdict: 'none' },
        normInput: NORM_INPUT,
        ruleId,
        grounds,
      },
      { now: () => at, newId },
    ),
  );

/** 저장소의 규범 · 확인 상태 전체 (원자성 비교용). */
const normSnapshot = () =>
  h.read((store) => ({
    rules: store.rules.list(),
    changes: store.normChanges.list(),
    retirements: store.ruleRetirements.list(),
    confirmations: store.db.prepare('SELECT * FROM confirmations ORDER BY entity, target_id').all(),
    approvals: store.approvalLog.list(),
    nextRule: store.sequences.last('RULE'),
  }));

const listOf = () => h.client.call('confirmation.list', { projectId: h.project.id });

describe('확인 풀림: 확인됨 규칙의 에이전트 폐기 · 대체 (M7-13 수용 기준 1, ADR-100 D3 · C2, ADR-113)', () => {
  it('폐기: 같은 트랜잭션에서 미확인이 되고 확인 풀림 기록(주체 오케스트레이터 · 풀린 시각 · 원인 순번 · 앞선 확인)이 남으며, 승인 기록은 사람의 확인 1건 그대로다', async () => {
    const norms = seedNorms();
    const confirmed = await confirmRule(norms.a.id, T0 + 1_000);
    const result = retireAt('RULE-001', GROUNDS_A, T0 + 2_000);
    const changes = h.read((store) => store.normChanges.list());
    expect(changes.map((entry) => [entry.seq, entry.kind, entry.targetRef.id])).toEqual([
      [1, 'retired', norms.a.id],
      [2, 'unconfirmed', norms.a.id],
    ]);
    expect(result.released).toEqual(changes[1]);
    expect(confirmed.confirmation).toEqual({
      state: 'confirmed',
      at: iso(T0 + 1_000),
      by: human,
      basis: { kind: 'approval_log', seq: confirmed.approvalLog.seq },
    });
    expect(changes[1]).toMatchObject({
      at: iso(T0 + 2_000),
      actor: { kind: 'orchestrator' },
      targetRef: { entity: 'Rule', id: norms.a.id },
      sessionId: null,
      runId: null,
      reason: RELEASE_REASON,
      detail: { unconfirm: { causeSeq: 1, previous: confirmed.confirmation } },
    });
    expect(changes[1]?.detail).toEqual({
      unconfirm: { causeSeq: 1, previous: confirmed.confirmation },
    });
    // 확인 상태 행은 남고 미확인 (시각 · 주체 · 근거가 비고 앞선 확인은 기록에)
    expect((await ruleOf(norms.a.id)).confirmation).toEqual({ state: 'unconfirmed' });
    expect(
      h.read((store) =>
        store.db.prepare("SELECT * FROM confirmations WHERE entity = 'Rule'").all(),
      ),
    ).toEqual([
      {
        entity: 'Rule',
        target_id: norms.a.id,
        state: 'unconfirmed',
        confirmed_at: null,
        confirmed_by: null,
        basis: null,
      },
    ]);
    // 승인 기록에는 오케스트레이터 · 에이전트 행동을 쓰지 않는다 (C2)
    expect(logOf().map((entry) => [entry.action, entry.actor])).toEqual([['confirm', human]]);
    const listed = await h.client.call('normChange.list', { projectId: h.project.id });
    expect(listed.chain).toEqual({ valid: true, brokenAtSeq: null, reason: null });
  });

  it('대체: 새 규칙 · 신규 · 판단 · 대체 · 폐기 행 뒤에 확인 풀림이 남고, 대체로 생긴 새 규칙은 미확인이다', async () => {
    const norms = seedNorms();
    await confirmRule(norms.b.id, T0 + 1_000);
    const result = supersedeAt(norms, 'RULE-002', GROUNDS_B, T0 + 2_000);
    const changes = h.read((store) => store.normChanges.list());
    expect(changes.map((entry) => [entry.kind, entry.targetRef.id])).toEqual([
      ['created', result.rule.id],
      ['judgment', result.rule.id],
      ['superseded', norms.b.id],
      ['unconfirmed', norms.b.id],
    ]);
    expect(result.retirement.released?.detail.unconfirm?.causeSeq).toBe(3);
    expect((await ruleOf(norms.b.id)).confirmation).toEqual({ state: 'unconfirmed' });
    expect((await ruleOf(result.rule.id)).confirmation).toEqual({ state: 'unconfirmed' });
    expect(logOf()).toHaveLength(1);
  });

  it('미확인 규칙의 폐기 · 대체에는 확인 풀림 기록이 생기지 않는다', () => {
    const norms = seedNorms();
    expect(retireAt('RULE-001', GROUNDS_A, T0 + 2_000).released).toBeNull();
    expect(supersedeAt(norms, 'RULE-002', GROUNDS_B, T0 + 3_000).retirement.released).toBeNull();
    expect(h.read((store) => store.normChanges.list()).map((entry) => entry.kind)).toEqual([
      'retired',
      'created',
      'judgment',
      'superseded',
    ]);
    expect(
      h.read((store) =>
        store.db.prepare("SELECT count(*) AS n FROM confirmations WHERE entity = 'Rule'").get(),
      ),
    ).toEqual({ n: 0 });
  });

  /** 확인됨 규칙 대체의 쓰기 순서. k번째만 실패시키는 트리거 조건. */
  const SUPERSEDE_WRITES = [
    ['규칙', 'BEFORE INSERT ON rules'],
    ['신규 기록', "BEFORE INSERT ON norm_changes WHEN NEW.kind = 'created'"],
    ['판단 기록', "BEFORE INSERT ON norm_changes WHEN NEW.kind = 'judgment'"],
    ['대체 기록', "BEFORE INSERT ON norm_changes WHEN NEW.kind = 'superseded'"],
    ['폐기 행', 'BEFORE INSERT ON rule_retirements'],
    ['확인 풀림 기록', "BEFORE INSERT ON norm_changes WHEN NEW.kind = 'unconfirmed'"],
    ['확인 상태 풀기', 'BEFORE UPDATE ON confirmations'],
  ] as const;
  const RETIRE_WRITES = [
    ['폐기 기록', "BEFORE INSERT ON norm_changes WHEN NEW.kind = 'retired'"],
    ['폐기 행', 'BEFORE INSERT ON rule_retirements'],
    ['확인 풀림 기록', "BEFORE INSERT ON norm_changes WHEN NEW.kind = 'unconfirmed'"],
    ['확인 상태 풀기', 'BEFORE UPDATE ON confirmations'],
  ] as const;

  const block = (label: string, when: string) => {
    h.read((store) =>
      store.db.exec(
        `CREATE TRIGGER test_block ${when} BEGIN SELECT RAISE(ABORT, '시험: ${label} 실패'); END;`,
      ),
    );
  };
  const unblock = () => {
    h.read((store) => store.db.exec('DROP TRIGGER test_block'));
  };

  it.each(SUPERSEDE_WRITES.map(([label, when], index) => [index + 1, label, when] as const))(
    '원자성: 확인됨 규칙 대체의 %i번째 쓰기(%s)만 실패하면 규칙 · 기록 · 폐기 · 확인 상태 · 승인 기록이 모두 전과 같다',
    async (_k, label, when) => {
      const norms = seedNorms();
      await confirmRule(norms.b.id, T0 + 1_000);
      const before = normSnapshot();
      block(label, when);
      expect(() => supersedeAt(norms, 'RULE-002', GROUNDS_B, T0 + 2_000)).toThrow(
        `시험: ${label} 실패`,
      );
      expect(normSnapshot()).toEqual(before);
      expect((await ruleOf(norms.b.id)).confirmation.state).toBe('confirmed');
      unblock();
      // 막는 것을 치우면 같은 호출이 그대로 성공하고 확인이 풀린다 (실패가 상태를 남기지 않았다)
      expect(
        supersedeAt(norms, 'RULE-002', GROUNDS_B, T0 + 3_000).retirement.released,
      ).not.toBeNull();
      expect((await ruleOf(norms.b.id)).confirmation.state).toBe('unconfirmed');
    },
  );

  it.each(RETIRE_WRITES.map(([label, when], index) => [index + 1, label, when] as const))(
    '원자성: 확인됨 규칙 폐기의 %i번째 쓰기(%s)만 실패하면 아무것도 바뀌지 않는다',
    async (_k, label, when) => {
      const norms = seedNorms();
      await confirmRule(norms.a.id, T0 + 1_000);
      const before = normSnapshot();
      block(label, when);
      expect(() => retireAt('RULE-001', GROUNDS_A, T0 + 2_000)).toThrow(`시험: ${label} 실패`);
      expect(normSnapshot()).toEqual(before);
      expect((await ruleOf(norms.a.id)).confirmation.state).toBe('confirmed');
      unblock();
      expect(retireAt('RULE-001', GROUNDS_A, T0 + 3_000).released).not.toBeNull();
    },
  );

  it('해시 체인: 확인 풀림 기록이 기록 중간 · 끝 어디에 끼어도 체인 검증이 통과하고, 원인 순번은 같은 트랜잭션의 폐기 · 대체 기록이다', async () => {
    const norms = seedNorms();
    await confirmRule(norms.a.id, T0 + 1_000);
    await confirmRule(norms.b.id, T0 + 1_001);
    retireAt('RULE-001', GROUNDS_A, T0 + 2_000); // 1 retired · 2 unconfirmed (중간)
    retireAt('RULE-003', GROUNDS_C, T0 + 2_001); // 3 retired (미확인이라 풀림 없음)
    supersedeAt(norms, 'RULE-002', GROUNDS_B, T0 + 2_002); // 4 · 5 · 6 superseded · 7 unconfirmed (끝)
    const changes = h.read((store) => store.normChanges.list());
    expect(changes.map((entry) => entry.kind)).toEqual([
      'retired',
      'unconfirmed',
      'retired',
      'created',
      'judgment',
      'superseded',
      'unconfirmed',
    ]);
    expect(
      changes
        .filter((entry) => entry.kind === 'unconfirmed')
        .map((entry) => entry.detail.unconfirm?.causeSeq),
    ).toEqual([1, 6]);
    expect(h.read((store) => store.normChanges.verify())).toMatchObject({ valid: true });
    const listed = await h.client.call('normChange.list', { projectId: h.project.id });
    expect(listed.chain.valid).toBe(true);
    expect(listed.entries).toHaveLength(7);
  });

  it('DB는 기록 없는 확인 풀림을 거부한다: 저장소의 풀기를 바로 부르면 실패하고 확인됨 그대로다', async () => {
    const norms = seedNorms();
    await confirmRule(norms.a.id, T0 + 1_000);
    expect(() =>
      h.read((store) => store.confirmations.release({ entity: 'Rule', id: norms.a.id })),
    ).toThrow(/확인 풀림 기록 없이/);
    expect((await ruleOf(norms.a.id)).confirmation.state).toBe('confirmed');
  });
});

describe('폐기된 규칙의 [확인] (M7-13, ADR-113): "이 폐기를 봤다"로 받는다', () => {
  it('확인이 풀린 폐기 규칙 · 처음부터 미확인이던 폐기 규칙 모두 사람이 확인할 수 있고, 폐기는 그대로이며 같은 확인을 두 번 받지 않는다', async () => {
    const norms = seedNorms();
    await confirmRule(norms.a.id, T0 + 1_000);
    retireAt('RULE-001', GROUNDS_A, T0 + 2_000);
    retireAt('RULE-003', GROUNDS_C, T0 + 2_001);
    const again = await confirmRule(norms.a.id, T0 + 3_000);
    expect(again.confirmation).toMatchObject({ state: 'confirmed', at: iso(T0 + 3_000) });
    const fresh = await confirmRule(norms.c.id, T0 + 3_001);
    expect(fresh.confirmation.state).toBe('confirmed');
    // 폐기는 되돌아가지 않는다
    expect(
      h.read((store) =>
        store.ruleRetirements
          .list()
          .map((item) => item.ruleId)
          .sort(),
      ),
    ).toEqual([norms.a.id, norms.c.id].sort());
    expect(logOf().map((entry) => entry.action)).toEqual(['confirm', 'confirm', 'confirm']);
    await expect(confirmRule(norms.a.id, T0 + 4_000)).rejects.toMatchObject({
      code: ErrorCode.StateConflict,
    });
    expect(logOf()).toHaveLength(3);
  });
});

describe('confirmation.list: 확인할 것 목록 (M7-13 수용 기준 3, ADR-100 B⑦ · A7 · G, ADR-113)', () => {
  /**
   * A 확인(1 000) → A 폐기 · 확인 풀림(2 000) → B 대체(3 000, 미확인이던 규칙, 새 규칙 RULE-004) → C 확인(4 000) →
   * C 테스트 변경 알림(5 000) → 에이전트 요구사항(6 000)
   */
  const scene = async () => {
    const norms = seedNorms();
    await confirmRule(norms.a.id, T0 + 1_000);
    const retired = retireAt('RULE-001', GROUNDS_A, T0 + 2_000);
    const superseded = supersedeAt(norms, 'RULE-002', GROUNDS_B, T0 + 3_000);
    await confirmRule(norms.c.id, T0 + 4_000);
    const runId = newId();
    const [testChange] = h.read((store) =>
      recordTestChanges(store, {
        run: { id: runId },
        baseCommit: 'a'.repeat(40),
        headCommit: 'b'.repeat(40),
        sessionId: SESSION,
        at: iso(T0 + 5_000),
        changes: [
          {
            ruleId: norms.c.id,
            files: [
              { path: 'bive-acceptance/RULE-003/done.acc.ts', change: 'modified' },
              { path: 'bive-acceptance/RULE-003/old.acc.ts', change: 'removed' },
            ],
          },
        ],
      }),
    );
    const agentRequirement = h.read((store) =>
      store.requirements.create({
        id: newId(),
        text: '에이전트가 쓴 요구사항',
        author: { kind: 'agent', role: 'chat' },
        normState: 'approved',
        createdAt: iso(T0 + 6_000),
      }),
    );
    return { norms, retired, superseded, testChange, runId, agentRequirement };
  };

  it('폐기 · 대체(확인 여부와 무관)를 시각 최신순으로 맨 앞에, 그 뒤 테스트 변경 알림 · 미확인 규범을 두고 항목마다 변경 전후 내용 · 근거 · 사유 · 확인 풀림을 싣는다', async () => {
    const { norms, retired, superseded, testChange, runId, agentRequirement } = await scene();
    const list = await listOf();
    expect(list.items.map((item) => item.kind)).toEqual([
      'superseded',
      'retired',
      'test_changed',
      'unconfirmed_norm',
      'unconfirmed_norm',
    ]);
    expect(list).toMatchObject({ total: 5, truncated: false });
    const [supersede, retire, test, ...unconfirmed] = list.items as [
      ConfirmationItem,
      ConfirmationItem,
      ConfirmationItem,
      ...ConfirmationItem[],
    ];
    expect(supersede).toEqual({
      kind: 'superseded',
      seq: superseded.retirement.normChange.seq,
      at: iso(T0 + 3_000),
      actor: AGENT_RW,
      sessionId: SESSION,
      rule: { id: norms.b.id, displayId: 'RULE-002' },
      before: { title: '가입 비밀번호 길이 검사', statement: STATEMENT_B },
      after: {
        title: NEW_RULE.title,
        statement: NEW_RULE.statement,
        rule: { id: superseded.rule.id, displayId: 'RULE-004' },
      },
      grounds: GROUNDS_B,
      rationale: RATIONALE,
      released: null,
      textTruncated: false,
    });
    expect(retire).toEqual({
      kind: 'retired',
      seq: retired.normChange.seq,
      at: iso(T0 + 2_000),
      actor: AGENT_RW,
      sessionId: SESSION,
      rule: { id: norms.a.id, displayId: 'RULE-001' },
      before: { title: '가입 이메일 형식 검사', statement: STATEMENT_A },
      after: null,
      grounds: GROUNDS_A,
      rationale: null,
      released: { seq: retired.released?.seq, at: iso(T0 + 2_000) },
      textTruncated: false,
    });
    expect(test).toEqual({
      kind: 'test_changed',
      seq: testChange?.seq,
      at: iso(T0 + 5_000),
      rule: { id: norms.c.id, displayId: 'RULE-003' },
      title: '가입 완료 안내',
      runId,
      runDisplayId: null,
      sessionId: SESSION,
      files: [
        { path: 'bive-acceptance/RULE-003/done.acc.ts', change: 'modified' },
        { path: 'bive-acceptance/RULE-003/old.acc.ts', change: 'removed' },
      ],
      fileCount: 2,
      textTruncated: false,
    });
    // 미확인 규범: 마지막 수정 시각 최신순. 폐기된 규칙(A · B)은 맨 앞 항목에만, 확인됨(요구사항 · C)은 없다
    expect(unconfirmed).toEqual([
      {
        kind: 'unconfirmed_norm',
        at: iso(T0 + 6_000),
        target: { entity: 'Requirement', id: agentRequirement.id },
        displayId: agentRequirement.displayId,
        text: '에이전트가 쓴 요구사항',
        author: { kind: 'agent', role: 'chat' },
        textTruncated: false,
      },
      {
        kind: 'unconfirmed_norm',
        at: iso(T0 + 3_000),
        target: { entity: 'Rule', id: superseded.rule.id },
        displayId: 'RULE-004',
        text: NEW_RULE.title,
        author: AGENT_RW,
        textTruncated: false,
      },
    ]);
  });

  it('맨 위 묶음의 순서는 시각 최신순이고 같은 시각이면 기록 순번이 큰 것이 먼저다', async () => {
    seedNorms();
    retireAt('RULE-003', GROUNDS_C, T0 + 5_000);
    retireAt('RULE-001', GROUNDS_A, T0 + 2_000);
    retireAt('RULE-002', GROUNDS_B, T0 + 2_000);
    const top = (await listOf()).items.flatMap((item) =>
      item.kind === 'retired' ? [item.rule.displayId] : [],
    );
    expect(top).toEqual(['RULE-003', 'RULE-002', 'RULE-001']);
  });

  it('사람이 대상을 [확인]하면 그 항목이 내려간다: 폐기 규칙 · 대체된 규칙 · 테스트 변경(확인됨 규칙을 다시 확인) · 미확인 규범. 다시 볼 알림이 없는 확인됨은 -32009', async () => {
    const { norms, superseded, agentRequirement } = await scene();
    await confirmRule(norms.a.id, T0 + 10_000);
    expect((await listOf()).items.map((item) => item.kind)).toEqual([
      'superseded',
      'test_changed',
      'unconfirmed_norm',
      'unconfirmed_norm',
    ]);
    await confirmRule(norms.b.id, T0 + 10_001);
    // 확인됨 규칙 C는 테스트 변경 알림이 있어 다시 확인할 수 있다 (근거가 새 확인으로 바뀐다)
    const reconfirmed = await confirmRule(norms.c.id, T0 + 10_002);
    expect(reconfirmed.confirmation).toMatchObject({
      at: iso(T0 + 10_002),
      basis: { kind: 'approval_log', seq: reconfirmed.approvalLog.seq },
    });
    await expect(confirmRule(norms.c.id, T0 + 10_003)).rejects.toMatchObject({
      code: ErrorCode.StateConflict,
    });
    expect((await listOf()).items.map((item) => item.kind)).toEqual([
      'unconfirmed_norm',
      'unconfirmed_norm',
    ]);
    await confirmRule(superseded.rule.id, T0 + 10_004);
    h.clock.now = T0 + 10_005;
    await h.client.call('confirmation.set', {
      projectId: h.project.id,
      target: { entity: 'Requirement', id: agentRequirement.id },
      author: human,
    });
    expect(await listOf()).toEqual({ items: [], total: 0, truncated: false });
  });

  it('삭제된 요구사항은 목록에서 빠지고, 기록보다 앞선 확인은 그 기록을 본 것이 아니다', async () => {
    const { agentRequirement, norms } = await scene();
    h.read((store) =>
      store.requirements.softDelete(agentRequirement.id, { by: human, at: iso(T0 + 8_000) }),
    );
    const kinds = (await listOf()).items.map((item) =>
      item.kind === 'unconfirmed_norm' ? item.displayId : item.kind,
    );
    expect(kinds).toEqual(['superseded', 'retired', 'test_changed', 'RULE-004']);
    // C의 확인(4 000)은 테스트 변경(5 000)보다 앞이라 알림은 남아 있다
    expect((await ruleOf(norms.c.id)).confirmation).toMatchObject({ at: iso(T0 + 4_000) });
  });

  it('에이전트가 쓴 글은 표시 값(숨은 글자 표기, 문자열마다 4000자 상한)이고 잘리면 textTruncated', async () => {
    seedNorms();
    const rlo = String.fromCodePoint(0x202e);
    const grounds = `${GROUNDS_A}${rlo.repeat(800)}`;
    retireAt('RULE-001', grounds, T0 + 2_000);
    const [item] = (await listOf()).items;
    if (item?.kind !== 'retired') throw new Error('폐기 항목 없음');
    expect(item.grounds?.startsWith(`${GROUNDS_A}\\u202e`)).toBe(true);
    expect(item.grounds?.includes(rlo)).toBe(false);
    expect(item.grounds?.length).toBeLessThanOrEqual(4000);
    expect(item.textTruncated).toBe(true);
    // 저장은 원문
    expect(h.read((store) => store.normChanges.list()[0]?.reason)).toBe(grounds);
  });

  it(`항목 수 상한 ${String(CONFIRMATION_LIST_MAX_ITEMS)}: 넘으면 잘림 표시와 전체 수(배지 수)를 싣고, 맨 위 항목은 잘리지 않는다`, async () => {
    seedNorms();
    retireAt('RULE-001', GROUNDS_A, T0 + 2_000);
    h.read((store) => {
      for (let i = 0; i < CONFIRMATION_LIST_MAX_ITEMS + 3; i += 1) {
        store.requirements.create({
          id: newId(),
          text: `에이전트 요구사항 ${String(i)}`,
          author: { kind: 'agent', role: 'chat' },
          normState: 'approved',
          createdAt: iso(T0 + 100 + i),
        });
      }
    });
    const list = await listOf();
    // 폐기 1 + 미확인 규범(요구사항 203 + 규칙 B · C)
    expect(list.total).toBe(1 + CONFIRMATION_LIST_MAX_ITEMS + 3 + 2);
    expect(list.items).toHaveLength(CONFIRMATION_LIST_MAX_ITEMS);
    expect(list.truncated).toBe(true);
    expect(list.items[0]?.kind).toBe('retired');
  });

  it('상한과 같은 수면 잘리지 않는다 (경계값)', async () => {
    h.read((store) => {
      for (let i = 0; i < CONFIRMATION_LIST_MAX_ITEMS; i += 1) {
        store.requirements.create({
          id: newId(),
          text: `에이전트 요구사항 ${String(i)}`,
          author: { kind: 'agent', role: 'chat' },
          normState: 'approved',
          createdAt: iso(T0 + i),
        });
      }
    });
    const list = await listOf();
    expect(list).toMatchObject({ total: CONFIRMATION_LIST_MAX_ITEMS, truncated: false });
    expect(list.items).toHaveLength(CONFIRMATION_LIST_MAX_ITEMS);
  });

  it('등록되지 않은 프로젝트는 -32004', async () => {
    await expect(h.client.call('confirmation.list', { projectId: newId() })).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
  });
});
