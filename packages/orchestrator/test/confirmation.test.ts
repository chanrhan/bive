// 확인 상태 · 사람 전용 확인 RPC (M7-01 #213 수용 기준 1 · 2, NFR-01 · ADR-100 D2 · I1 · B① · C1 · C2 · A1 · A2 · ADR-101).
// - 요구사항 · 규칙마다 확인 상태(미확인 · 확인됨, 기본 미확인)가 저장되고 조회 응답에 실린다
// - `confirmation.set`은 사람 주체만 받고(에이전트 -32020) 없는 대상은 -32004, 확인은 승인 기록 `confirm`으로 남는다
// - 사람의 `requirement.create` · `requirement.update`는 같은 트랜잭션에서 확인됨이 되고 승인 기록은 늘지 않는다
// - 사람이 승인한 제안으로 생긴 규칙 · 요구사항은 확인됨(근거 = 그 승인 기록 순번), 제안 승인 없이 생긴 규칙은 미확인
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소.
import {
  APPROVAL_LOG_GENESIS_HASH,
  type Author,
  createUlidGenerator,
  ErrorCode,
  type Requirement,
  type Rule,
  RuleNewPayload,
} from '@bive/shared';
import { computeApprovalLogHash, type ProjectStore } from '@bive/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PipeServer } from '../src/ipc/server.js';
import type { TestClient } from './helpers/client.js';
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
    await expect(
      h.client.call('requirement.list', { projectId: h.project.id }),
    ).resolves.toEqual({ requirements: [requirement] });
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
