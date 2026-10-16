// 제안 모델 · 승인 · 수정 후 승인 · 거절 RPC (M1-09 수용 기준, NRM-04 · TODO-01 · NFR-01 · ADR-027 · ADR-050).
// 제안은 내부 API(`ProposalService.submit`)로 넣고, 처리는 파이프 RPC로 한다.
import {
  APPROVAL_LOG_GENESIS_HASH,
  createUlidGenerator,
  DomainErrorReason,
  ErrorCode,
  type Author,
  type Proposal,
  type Requirement,
  type RuleNewPayload,
} from '@bive/shared';
import { computeApprovalLogHash } from '@bive/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PipeServer } from '../src/ipc/server.js';
import type { TestClient } from './helpers/client.js';
import { cleanup } from './helpers/process.js';
import { iso, startProjectHarness, T0, type ProjectHarness } from './helpers/project-harness.js';

const human = { kind: 'human' } as const satisfies Author;
const ruleWriter = { kind: 'agent', role: 'rule-writer' } as const;
const chatAgent = { kind: 'agent', role: 'chat' } as const;

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

const createRequirement = async (text = '사용자는 이메일로 가입할 수 있다'): Promise<Requirement> =>
  (await h.client.call('requirement.create', { projectId: h.project.id, text, author: human }))
    .requirement;

const rulePayload = (parentRequirementId: string): RuleNewPayload => ({
  title: '중복 이메일 가입 거부',
  statement: 'WHEN 이미 가입된 이메일로 가입을 요청하면 THE SYSTEM SHALL 가입을 거부한다',
  kind: 'business',
  checkKinds: ['test'],
  parentRequirementId,
});

const submitRequirement = (text = '관리자는 회원을 정지할 수 있다'): Proposal =>
  h.proposals.submit(h.project.id, {
    kind: 'requirement_new',
    payload: { text },
    rationale: '운영 요구가 빠져 있음',
    author: chatAgent,
    source: 'chat',
  });

const submitRule = (parentRequirementId: string): Proposal =>
  h.proposals.submit(h.project.id, {
    kind: 'rule_new',
    payload: rulePayload(parentRequirementId),
    rationale: '요구사항의 예외 경로',
    author: ruleWriter,
    source: 'rule_generation',
  });

const getProposal = async (id: string): Promise<Proposal> =>
  (await h.client.call('proposal.get', { projectId: h.project.id, id })).proposal;

const logCount = (): number => h.read((store) => store.approvalLog.list().length);

describe('제안 등록 (내부 API): 승인 대기로만 들어가고 규범에는 반영되지 않는다', () => {
  it('요구사항 · 규칙 신규 제안이 pending으로 등록되고 목록 · 건수에 보인다', async () => {
    const req = await createRequirement();
    const reqProposal = submitRequirement();
    h.clock.now = T0 + 1_000;
    const ruleProposal = submitRule(req.id);

    expect(reqProposal).toMatchObject({
      displayId: 'PRP-001',
      kind: 'requirement_new',
      targetRef: null,
      payload: { text: '관리자는 회원을 정지할 수 있다' },
      diff: { before: null, after: { text: '관리자는 회원을 정지할 수 있다' } },
      author: chatAgent,
      source: 'chat',
      state: 'pending',
      decision: null,
      readAt: null,
      createdAt: iso(T0),
    });
    expect(ruleProposal).toMatchObject({
      displayId: 'PRP-002',
      kind: 'rule_new',
      targetRef: { entity: 'Requirement', id: req.id },
      payload: rulePayload(req.id),
      state: 'pending',
      createdAt: iso(T0 + 1_000),
    });

    // 승인 전에는 규범(요구사항 · 규칙)에 없다 (NRM-04)
    await expect(h.client.call('requirement.list', { projectId: h.project.id })).resolves.toEqual({
      requirements: [req],
    });
    expect(h.read((store) => store.rules.list())).toEqual([]);

    await expect(
      h.client.call('proposal.list', { projectId: h.project.id, state: 'pending' }),
    ).resolves.toEqual({ proposals: [reqProposal, ruleProposal] });
    await expect(
      h.client.call('proposal.list', { projectId: h.project.id, kind: 'rule_new' }),
    ).resolves.toEqual({ proposals: [ruleProposal] });
    await expect(h.client.call('proposal.count', { projectId: h.project.id })).resolves.toEqual({
      pending: 2,
      pendingByKind: {
        requirement_new: 1,
        requirement_change: 0,
        rule_new: 1,
        rule_change: 0,
        contract_new: 0,
        design_change: 0,
        rule_title_change: 0,
        contract_change: 0,
      },
    });
    await expect(getProposal(ruleProposal.id)).resolves.toEqual(ruleProposal);
  });

  it('지원하지 않는 종류 · 본문 위반 · 사람 작성자 · 없거나 삭제된 부모는 등록하지 않는다', async () => {
    const req = await createRequirement();
    const base = {
      rationale: '근거',
      author: ruleWriter,
      source: 'rule_generation',
    } as const;
    const attempts: (() => unknown)[] = [
      () =>
        h.proposals.submit(h.project.id, {
          ...base,
          kind: 'design_change' as 'rule_new',
          payload: rulePayload(req.id),
        }),
      () =>
        h.proposals.submit(h.project.id, {
          ...base,
          kind: 'rule_new',
          payload: { ...rulePayload(req.id), checkKinds: [] },
        }),
      () => h.proposals.submit(h.project.id, { ...base, kind: 'requirement_new', payload: {} }),
      () =>
        h.proposals.submit(h.project.id, {
          ...base,
          author: human as unknown as typeof ruleWriter,
          kind: 'requirement_new',
          payload: { text: '본문' },
        }),
      () =>
        h.proposals.submit(h.project.id, {
          ...base,
          kind: 'rule_new',
          payload: rulePayload(newId()),
        }),
    ];
    for (const attempt of attempts) expect(attempt).toThrow();

    await h.client.call('requirement.delete', {
      projectId: h.project.id,
      id: req.id,
      author: human,
    });
    expect(() => submitRule(req.id)).toThrow(/삭제/);
    expect(() =>
      h.proposals.submit(newId(), {
        ...base,
        kind: 'requirement_new',
        payload: { text: '본문' },
      }),
    ).toThrow(/등록되지 않은 프로젝트/);

    await expect(h.client.call('proposal.list', { projectId: h.project.id })).resolves.toEqual({
      proposals: [],
    });
  });
});

describe('proposal.approve: 규범 반영 + 승인 기록 (행동 · 주체 · 시각 · 이전 해시)', () => {
  it('요구사항 신규를 그대로 승인하면 에이전트 주체 요구사항이 생기고 approve 기록이 남는다', async () => {
    const proposal = submitRequirement();
    h.clock.now = T0 + 60_000;
    const result = await h.client.call('proposal.approve', {
      projectId: h.project.id,
      id: proposal.id,
      author: human,
    });

    // 규범 반영: 승인 시각에 생성, 생성 주체는 제안한 에이전트, 규범 상태 approved
    expect(result.applied.entity).toBe('Requirement');
    if (result.applied.entity !== 'Requirement') throw new Error('요구사항이 아님');
    const requirement = result.applied.requirement;
    expect(requirement).toMatchObject({
      displayId: 'REQ-001',
      text: '관리자는 회원을 정지할 수 있다',
      author: chatAgent,
      normState: 'approved',
      createdAt: iso(T0 + 60_000),
      deletedAt: null,
    });
    await expect(h.client.call('requirement.list', { projectId: h.project.id })).resolves.toEqual({
      requirements: [requirement],
    });

    // 제안 처리 기록: 주체(사람) · 시각 · 반영된 규범
    const appliedRef = { entity: 'Requirement', id: requirement.id } as const;
    expect(result.proposal).toEqual({
      ...proposal,
      state: 'approved',
      decision: { at: iso(T0 + 60_000), by: human, appliedRef },
    });
    await expect(getProposal(proposal.id)).resolves.toEqual(result.proposal);

    // 승인 기록: 행동 · 주체 · 시각 · 대상 · 연결 · 이전 해시(첫 기록이라 0 64자)
    expect(result.approvalLog).toEqual({
      seq: 1,
      at: iso(T0 + 60_000),
      action: 'approve',
      actor: human,
      targetRef: { entity: 'Proposal', id: proposal.id },
      clientId: expect.stringMatching(/^pipe-\d+$/) as unknown as string,
      detail: { appliedRef },
      prevHash: APPROVAL_LOG_GENESIS_HASH,
      hash: computeApprovalLogHash(result.approvalLog),
    });

    await expect(h.client.call('approvalLog.list', { projectId: h.project.id })).resolves.toEqual({
      entries: [result.approvalLog],
      chain: { valid: true, brokenAtSeq: null },
    });
    await expect(
      h.client.call('proposal.count', { projectId: h.project.id }),
    ).resolves.toMatchObject({ pending: 0 });
  });

  it('수정 후 승인: 고친 본문으로 규칙이 생기고 approve_edited 기록에 수정 diff · 이전 해시가 남는다', async () => {
    const req = await createRequirement();
    const first = submitRequirement();
    const ruleProposal = submitRule(req.id);

    h.clock.now = T0 + 1_000;
    const firstResult = await h.client.call('proposal.approve', {
      projectId: h.project.id,
      id: first.id,
      author: human,
    });

    h.clock.now = T0 + 2_000;
    const edited: RuleNewPayload = {
      ...rulePayload(req.id),
      title: '이미 가입된 이메일은 다시 가입 불가',
      checkKinds: ['test', 'pbt'],
    };
    const result = await h.client.call('proposal.approve', {
      projectId: h.project.id,
      id: ruleProposal.id,
      author: human,
      edited,
    });

    // 규범 반영: 사람이 고친 값으로, 부모 요구사항 연결, 생성 주체는 rule-writer
    if (result.applied.entity !== 'Rule') throw new Error('규칙이 아님');
    const rule = result.applied.rule;
    expect(rule).toEqual({
      id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/) as unknown as string,
      displayId: 'RULE-001',
      title: '이미 가입된 이메일은 다시 가입 불가',
      statement: edited.statement,
      kind: 'business',
      checkKinds: ['test', 'pbt'],
      parentRequirementId: req.id,
      parentDetachedAt: null,
      builtin: false,
      targetBlockIds: [],
      risk: null,
      contractId: null,
      author: ruleWriter,
      normState: 'approved',
      createdAt: iso(T0 + 2_000),
      updatedAt: iso(T0 + 2_000),
      deletedAt: null,
    });
    expect(h.read((store) => store.rules.listByParent(req.id))).toEqual([rule]);

    // 제안: 원래 본문은 그대로, 수정 본문 · 주체는 처리 기록에
    const appliedRef = { entity: 'Rule', id: rule.id } as const;
    expect(result.proposal).toEqual({
      ...ruleProposal,
      state: 'approved',
      decision: { at: iso(T0 + 2_000), by: human, appliedRef, editedPayload: edited },
    });
    expect(result.proposal.payload).toEqual(rulePayload(req.id));

    // 승인 기록: approve_edited · 수정 diff(원래 → 고친 값) · 이전 해시 = 앞 기록의 해시
    expect(result.approvalLog).toMatchObject({
      seq: 2,
      at: iso(T0 + 2_000),
      action: 'approve_edited',
      actor: human,
      targetRef: { entity: 'Proposal', id: ruleProposal.id },
      detail: { diff: { before: rulePayload(req.id), after: edited }, appliedRef },
      prevHash: firstResult.approvalLog.hash,
    });

    const listed = await h.client.call('approvalLog.list', { projectId: h.project.id });
    expect(listed).toEqual({
      entries: [firstResult.approvalLog, result.approvalLog],
      chain: { valid: true, brokenAtSeq: null },
    });
    await expect(
      h.client.call('approvalLog.list', {
        projectId: h.project.id,
        targetRef: { entity: 'Proposal', id: ruleProposal.id },
      }),
    ).resolves.toEqual({
      entries: [result.approvalLog],
      chain: { valid: true, brokenAtSeq: null },
    });
  });

  it('proposal.amend는 수정 후 승인과 같고, 고친 내용이 없으면 그대로 승인으로 기록한다', async () => {
    const a = submitRequirement('관리자는 회원을 정지할 수 있다');
    const b = submitRequirement('관리자는 공지를 올릴 수 있다');

    const amended = await h.client.call('proposal.amend', {
      projectId: h.project.id,
      id: a.id,
      author: human,
      edited: { text: '관리자는 사유를 남기고 회원을 정지할 수 있다' },
    });
    expect(amended.approvalLog.action).toBe('approve_edited');
    expect(amended.approvalLog.detail.diff).toEqual({
      before: { text: '관리자는 회원을 정지할 수 있다' },
      after: { text: '관리자는 사유를 남기고 회원을 정지할 수 있다' },
    });
    expect(amended.applied).toMatchObject({
      entity: 'Requirement',
      requirement: { text: '관리자는 사유를 남기고 회원을 정지할 수 있다' },
    });

    const same = await h.client.call('proposal.amend', {
      projectId: h.project.id,
      id: b.id,
      author: human,
      edited: { text: '관리자는 공지를 올릴 수 있다' },
    });
    expect(same.approvalLog.action).toBe('approve');
    expect(same.approvalLog.detail.diff).toBeUndefined();
    expect(same.proposal.decision?.editedPayload).toBeUndefined();
  });

  it('수정 본문이 제안 종류와 맞지 않으면 -32001이고 아무것도 바뀌지 않는다', async () => {
    const req = await createRequirement();
    const ruleProposal = submitRule(req.id);
    await expect(
      h.client.call('proposal.approve', {
        projectId: h.project.id,
        id: ruleProposal.id,
        author: human,
        edited: { text: '요구사항 본문을 규칙 제안에' },
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.ValidationFailed,
      data: { reason: DomainErrorReason.EditedPayloadInvalid },
    });
    await expect(getProposal(ruleProposal.id)).resolves.toEqual(ruleProposal);
    expect(h.read((store) => store.rules.list())).toEqual([]);
    expect(logCount()).toBe(0);
  });

  it('승인 전에 부모 요구사항이 삭제된 규칙 제안은 -32009이고 아무것도 바뀌지 않는다', async () => {
    const req = await createRequirement();
    const ruleProposal = submitRule(req.id);
    await h.client.call('requirement.delete', {
      projectId: h.project.id,
      id: req.id,
      author: human,
    });
    await expect(
      h.client.call('proposal.approve', {
        projectId: h.project.id,
        id: ruleProposal.id,
        author: human,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.StateConflict });
    await expect(getProposal(ruleProposal.id)).resolves.toEqual(ruleProposal);
    expect(h.read((store) => store.rules.list())).toEqual([]);
    expect(logCount()).toBe(0);
  });
});

describe('proposal.reject: 거절 사유 필수 (NRM-04)', () => {
  it('빈 사유는 -32001(REJECT_REASON_REQUIRED)로 거부되고 제안 상태가 그대로다', async () => {
    const proposal = submitRequirement();
    for (const reason of ['', '   ', '\n\t']) {
      await expect(
        h.client.call('proposal.reject', {
          projectId: h.project.id,
          id: proposal.id,
          author: human,
          reason,
        }),
      ).rejects.toMatchObject({
        code: ErrorCode.ValidationFailed,
        data: { reason: DomainErrorReason.RejectReasonRequired },
      });
    }
    await expect(getProposal(proposal.id)).resolves.toEqual(proposal);
    expect((await getProposal(proposal.id)).state).toBe('pending');
    expect(logCount()).toBe(0);
    // 사유 키가 아예 없으면 스키마 불일치
    await expect(
      h.client.requestRaw({
        jsonrpc: '2.0',
        id: 'no-reason',
        method: 'proposal.reject',
        params: { projectId: h.project.id, id: proposal.id, author: human },
      }),
    ).resolves.toMatchObject({ error: { code: ErrorCode.InvalidParams } });
  });

  it('사유가 있으면 rejected로 처리되고 reject 기록에 사유가 남으며 규범은 바뀌지 않는다', async () => {
    const proposal = submitRequirement();
    h.clock.now = T0 + 30_000;
    const result = await h.client.call('proposal.reject', {
      projectId: h.project.id,
      id: proposal.id,
      author: human,
      reason: '이미 다른 요구사항에 포함됨',
    });
    expect(result.proposal).toEqual({
      ...proposal,
      state: 'rejected',
      decision: { at: iso(T0 + 30_000), by: human, rejectReason: '이미 다른 요구사항에 포함됨' },
    });
    expect(result.approvalLog).toMatchObject({
      seq: 1,
      at: iso(T0 + 30_000),
      action: 'reject',
      actor: human,
      targetRef: { entity: 'Proposal', id: proposal.id },
      detail: { reason: '이미 다른 요구사항에 포함됨' },
      prevHash: APPROVAL_LOG_GENESIS_HASH,
    });
    await expect(h.client.call('requirement.list', { projectId: h.project.id })).resolves.toEqual({
      requirements: [],
    });
    await expect(
      h.client.call('proposal.list', { projectId: h.project.id, state: 'rejected' }),
    ).resolves.toEqual({ proposals: [result.proposal] });
  });
});

describe('처리 상태 · 주체 · 대상 검증', () => {
  it('이미 처리된 제안의 승인 · 수정 후 승인 · 거절은 -32009이고 기록이 늘지 않는다', async () => {
    const approved = submitRequirement('가');
    const rejected = submitRequirement('나');
    await h.client.call('proposal.approve', {
      projectId: h.project.id,
      id: approved.id,
      author: human,
    });
    await h.client.call('proposal.reject', {
      projectId: h.project.id,
      id: rejected.id,
      author: human,
      reason: '중복',
    });
    const before = await h.client.call('approvalLog.list', { projectId: h.project.id });

    for (const id of [approved.id, rejected.id]) {
      const conflict = { code: ErrorCode.StateConflict };
      await expect(
        h.client.call('proposal.approve', { projectId: h.project.id, id, author: human }),
      ).rejects.toMatchObject(conflict);
      await expect(
        h.client.call('proposal.amend', {
          projectId: h.project.id,
          id,
          author: human,
          edited: { text: '다' },
        }),
      ).rejects.toMatchObject(conflict);
      await expect(
        h.client.call('proposal.reject', {
          projectId: h.project.id,
          id,
          author: human,
          reason: '다시',
        }),
      ).rejects.toMatchObject(conflict);
    }
    await expect(h.client.call('approvalLog.list', { projectId: h.project.id })).resolves.toEqual(
      before,
    );
    expect(h.read((store) => store.requirements.list())).toHaveLength(1);
  });

  it('에이전트 주체의 승인 · 수정 후 승인 · 거절은 -32020이고 상태가 그대로다 (NFR-01)', async () => {
    const proposal = submitRequirement();
    for (const author of [ruleWriter, chatAgent]) {
      const unauthorized = { code: ErrorCode.Unauthorized };
      await expect(
        h.client.call('proposal.approve', { projectId: h.project.id, id: proposal.id, author }),
      ).rejects.toMatchObject(unauthorized);
      await expect(
        h.client.call('proposal.amend', {
          projectId: h.project.id,
          id: proposal.id,
          author,
          edited: { text: '바꿈' },
        }),
      ).rejects.toMatchObject(unauthorized);
      await expect(
        h.client.call('proposal.reject', {
          projectId: h.project.id,
          id: proposal.id,
          author,
          reason: '사유',
        }),
      ).rejects.toMatchObject(unauthorized);
    }
    await expect(getProposal(proposal.id)).resolves.toEqual(proposal);
    expect(logCount()).toBe(0);
  });

  it('없는 제안 · 등록되지 않은 프로젝트는 -32004', async () => {
    const notFound = { code: ErrorCode.NotFound };
    const missing = newId();
    await expect(getProposal(missing)).rejects.toMatchObject(notFound);
    await expect(
      h.client.call('proposal.approve', { projectId: h.project.id, id: missing, author: human }),
    ).rejects.toMatchObject(notFound);
    await expect(
      h.client.call('proposal.reject', {
        projectId: h.project.id,
        id: missing,
        author: human,
        reason: '사유',
      }),
    ).rejects.toMatchObject(notFound);
    await expect(
      h.client.call('proposal.markRead', { projectId: h.project.id, id: missing }),
    ).rejects.toMatchObject(notFound);
    await expect(h.client.call('proposal.list', { projectId: newId() })).rejects.toMatchObject(
      notFound,
    );
    await expect(h.client.call('approvalLog.list', { projectId: newId() })).rejects.toMatchObject(
      notFound,
    );
  });

  it('proposal.markRead: 처음 읽은 시각만 남는다', async () => {
    const proposal = submitRequirement();
    h.clock.now = T0 + 5_000;
    const first = await h.client.call('proposal.markRead', {
      projectId: h.project.id,
      id: proposal.id,
    });
    expect(first.proposal).toEqual({ ...proposal, readAt: iso(T0 + 5_000) });
    h.clock.now = T0 + 9_000;
    const again = await h.client.call('proposal.markRead', {
      projectId: h.project.id,
      id: proposal.id,
    });
    expect(again.proposal.readAt).toBe(iso(T0 + 5_000));
  });
});

describe('approvalLog.list: 해시 체인 검증 결과', () => {
  it('저장소 밖에서 기록을 고치면 chain.valid가 false이고 처음 어긋난 순번을 알려 준다', async () => {
    for (const text of ['가', '나', '다']) {
      const proposal = submitRequirement(text);
      await h.client.call('proposal.approve', {
        projectId: h.project.id,
        id: proposal.id,
        author: human,
      });
    }
    // 같은 사용자 권한의 다른 프로세스 흉내: 추가 전용 트리거를 지우고 2번 기록의 시각을 바꾼다
    h.read((store) => {
      store.db.exec('DROP TRIGGER approval_log_no_update');
      store.db.prepare('UPDATE approval_log SET at = ? WHERE seq = 2').run(iso(T0 - 86_400_000));
    });
    const listed = await h.client.call('approvalLog.list', { projectId: h.project.id });
    expect(listed.chain).toEqual({ valid: false, brokenAtSeq: 2 });
    expect(listed.entries).toHaveLength(3);
  });
});
