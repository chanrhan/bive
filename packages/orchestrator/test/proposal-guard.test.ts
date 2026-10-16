// 승인 경로 격리 (M1-09 수용 기준, NFR-01 · NRM-04 · PRD 5.1 · ADR-027 · ADR-050).
// - 승인은 토큰 인증된 파이프 연결에서만: 인증 전 연결의 `proposal.approve`는 -32020 후 연결 종료
// - 승인된 규칙 · 계약을 직접 고치는 RPC는 없다: `rule.update` · `contract.update` → -32601
// - 제안 등록도 파이프 RPC가 없다(내부 API `ProposalService.submit`만)
import { ErrorCode, METHOD_NAMES, PROTOCOL_VERSION, type Proposal } from '@bive/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PipeServer } from '../src/ipc/server.js';
import { TestClient } from './helpers/client.js';
import { cleanup } from './helpers/process.js';
import { startProjectHarness, type ProjectHarness } from './helpers/project-harness.js';

const human = { kind: 'human' } as const;

const servers: PipeServer[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  await cleanup();
});

let h: ProjectHarness;
let proposal: Proposal;
beforeEach(async () => {
  h = await startProjectHarness({ servers, clients });
  proposal = h.proposals.submit(h.project.id, {
    kind: 'requirement_new',
    payload: { text: '관리자는 회원을 정지할 수 있다' },
    rationale: '운영 요구가 빠져 있음',
    author: { kind: 'agent', role: 'chat' },
    source: 'chat',
  });
});

const openUnauthenticated = async (): Promise<TestClient> => {
  const client = await TestClient.open(h.socketPath);
  clients.push(client);
  return client;
};

/** 제안이 그대로 대기 중이고 규범 · 승인 기록이 늘지 않았는지 저장소에서 직접 확인한다. */
const expectUntouched = (): void => {
  h.read((store) => {
    expect(store.proposals.get(proposal.id)).toEqual(proposal);
    expect(store.requirements.list()).toEqual([]);
    expect(store.approvalLog.list()).toEqual([]);
  });
};

const approveRequest = (id: string | number) => ({
  jsonrpc: '2.0',
  id,
  method: 'proposal.approve',
  params: { projectId: h.project.id, id: proposal.id, author: human },
});

describe('토큰 없는 연결의 승인 호출', () => {
  it('hello 없이 보낸 proposal.approve는 -32020이고 연결이 닫히며 제안은 그대로다', async () => {
    const client = await openUnauthenticated();
    const response = await client.requestRaw(approveRequest(1));
    expect(response).toMatchObject({ id: 1, error: { code: ErrorCode.Unauthorized } });
    await client.closed;
    expect(client.isClosed).toBe(true);
    expectUntouched();
  });

  it('틀린 토큰으로 hello한 연결은 -32020으로 닫히고 바로 뒤에 보낸 승인 요청은 처리되지 않는다', async () => {
    const client = await openUnauthenticated();
    const hello = client.requestRaw({
      jsonrpc: '2.0',
      id: 'hello',
      method: 'system.hello',
      params: { protocolVersion: PROTOCOL_VERSION, token: 'wrong-token' },
    });
    // hello 응답을 기다리지 않고 승인 요청을 이어 보낸다
    client.sendRaw(JSON.stringify(approveRequest(2)));
    await expect(hello).resolves.toMatchObject({ error: { code: ErrorCode.Unauthorized } });
    await client.closed;
    // 승인 요청에는 어떤 응답도 오지 않았다 (닫히는 연결의 이후 프레임은 버린다)
    expect(client.unmatched).toEqual([]);
    expectUntouched();
  });

  it('같은 서버에서 토큰 인증된 연결은 승인할 수 있다 (대조군)', async () => {
    const result = await h.client.call('proposal.approve', {
      projectId: h.project.id,
      id: proposal.id,
      author: human,
    });
    expect(result.proposal.state).toBe('approved');
  });
});

describe('승인된 규칙 · 계약의 직접 수정 RPC 없음 (NRM-04)', () => {
  it.each([
    ['rule.update', { projectId: 'p', id: 'r', title: '바꾼 제목' }],
    ['contract.update', { projectId: 'p', id: 'c', content: '{}' }],
    ['rule.create', { projectId: 'p' }],
    ['rule.delete', { projectId: 'p', id: 'r' }],
    ['proposal.create', { projectId: 'p' }],
    ['proposal.submit', { projectId: 'p' }],
  ])('%s → -32601', async (method, params) => {
    const response = await h.client.requestRaw({ jsonrpc: '2.0', id: method, method, params });
    expect(response).toMatchObject({ id: method, error: { code: ErrorCode.MethodNotFound } });
    // 연결은 그대로 쓸 수 있다
    await expect(h.client.call('ping')).resolves.toMatchObject({ pong: true });
  });

  it('메서드 레지스트리에 규칙 · 계약 쓰기와 제안 등록 메서드가 없다', () => {
    const writes = METHOD_NAMES.filter(
      (name) => /^(rule|contract)\./.test(name) && !/\.(list|get)$/.test(name),
    );
    expect(writes).toEqual([]);
    expect(METHOD_NAMES).not.toContain('proposal.create');
    expect(METHOD_NAMES).not.toContain('proposal.submit');
    expectUntouched();
  });
});
