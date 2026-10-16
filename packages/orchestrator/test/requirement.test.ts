// 요구사항 CRUD RPC (M1-02 수용 기준, NRM-01 · ADR-047). 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소.
import path from 'node:path';

import {
  createUlidGenerator,
  ErrorCode,
  type Author,
  type Project,
  type Requirement,
} from '@bive/shared';
import { openProjectStore, registerProject } from '@bive/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHandlers } from '../src/ipc/handlers.js';
import { PipeServer } from '../src/ipc/server.js';
import { NetPipeTransport } from '../src/ipc/transport.js';
import { startOrchestrator, type Orchestrator } from '../src/orchestrator.js';
import { ProposalService } from '../src/proposals/proposal-service.js';
import { connect, type TestClient } from './helpers/client.js';
import { cleanup, makeBiveHome } from './helpers/process.js';

const human = { kind: 'human' } as const satisfies Author;
const ruleWriter = { kind: 'agent', role: 'rule-writer' } as const satisfies Author;
const chatAgent = { kind: 'agent', role: 'chat' } as const satisfies Author;

const T0 = Date.parse('2026-10-16T09:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const newId = createUlidGenerator();

const servers: PipeServer[] = [];
const clients: TestClient[] = [];
const running: Orchestrator[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  for (const orchestrator of running.splice(0)) await orchestrator.stop();
  await cleanup();
});

const registerSampleProject = (biveHome: string): Project =>
  registerProject(
    {
      id: newId(),
      name: '샘플 앱',
      rootPath: '/work/sample-next-app',
      baseBranch: 'main',
      createdAt: iso(T0),
    },
    { home: biveHome },
  );

interface Harness {
  biveHome: string;
  project: Project;
  client: TestClient;
  /** 오케스트레이터 시계(ms). 바꾸면 다음 요청부터 반영된다 */
  clock: { now: number };
}

/** 실제 처리기(`createHandlers`)를 붙인 파이프 서버 + 인증된 클라이언트. 시계는 고정해 시각을 단언한다. */
const harness = async (): Promise<Harness> => {
  const biveHome = makeBiveHome();
  const project = registerSampleProject(biveHome);
  const clock = { now: T0 };
  const socketPath = path.join(biveHome, 'r.sock');
  const server = new PipeServer({
    transport: new NetPipeTransport(),
    path: socketPath,
    token: 'tok',
    orchestratorVersion: '0.0.0-test',
    handlers: createHandlers({
      orchestratorVersion: '0.0.0-test',
      status: { startedAt: T0, connectionCount: 0, activeRunCount: 0 },
      biveHome,
      now: () => clock.now,
    }),
  });
  servers.push(server);
  await server.listen();
  const client = await connect(socketPath, 'tok');
  clients.push(client);
  return { biveHome, project, client, clock };
};

/** 에이전트 제안 승인(#22)으로 들어온 요구사항을 흉내 낸다: 저장소에 에이전트 주체로 직접 넣는다. */
const seedAgentRequirement = (biveHome: string, projectId: string, text: string): Requirement => {
  const store = openProjectStore(projectId, { home: biveHome, create: false });
  try {
    return store.requirements.create({
      id: newId(),
      text,
      author: ruleWriter,
      normState: 'approved',
      createdAt: iso(T0 - 60_000),
    });
  } finally {
    store.close();
  }
};

/** 프로젝트 DB에 제안 테이블이 있으면 그 행 수, 없으면 0. */
const proposalCount = (biveHome: string, projectId: string): number => {
  const store = openProjectStore(projectId, { home: biveHome, create: false });
  try {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%proposal%'")
      .all() as { name: string }[];
    return tables.reduce((sum, { name }) => {
      const row = store.db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number };
      return sum + row.n;
    }, 0);
  } finally {
    store.close();
  }
};

const rowCount = (biveHome: string, projectId: string): number => {
  const store = openProjectStore(projectId, { home: biveHome, create: false });
  try {
    return (store.db.prepare('SELECT count(*) AS n FROM requirements').get() as { n: number }).n;
  } finally {
    store.close();
  }
};

describe('requirement.create · get · list: 본문 · 생성 주체 · 생성 시각 · 수정 시각 · 상태', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it('사람이 만든 요구사항은 승인 없이 규범(approved)이 되고 필드가 모두 기록된다', async () => {
    const { requirement } = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '사용자는 이메일로 가입할 수 있다',
      author: human,
    });
    expect(requirement).toEqual({
      id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/) as unknown as string,
      displayId: 'REQ-001',
      text: '사용자는 이메일로 가입할 수 있다',
      author: human,
      normState: 'approved',
      unrulable: null,
      createdAt: iso(T0),
      updatedAt: iso(T0),
      updatedBy: human,
      deletedAt: null,
    });

    await expect(
      h.client.call('requirement.get', { projectId: h.project.id, id: requirement.id }),
    ).resolves.toEqual({ requirement });

    h.clock.now = T0 + 1_000;
    const second = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '가입한 사용자는 로그인할 수 있다',
      author: human,
    });
    expect(second.requirement.displayId).toBe('REQ-002');
    expect(second.requirement.createdAt).toBe(iso(T0 + 1_000));

    await expect(h.client.call('requirement.list', { projectId: h.project.id })).resolves.toEqual({
      requirements: [requirement, second.requirement],
    });
    expect(proposalCount(h.biveHome, h.project.id)).toBe(0);
  });

  it('빈 목록 · 공백 본문 · 모르는 필드 · projectId 누락', async () => {
    await expect(h.client.call('requirement.list', { projectId: h.project.id })).resolves.toEqual({
      requirements: [],
    });
    const raw = (params: unknown) =>
      h.client.requestRaw({
        jsonrpc: '2.0',
        id: newId(),
        method: 'requirement.create',
        params,
      });
    for (const params of [
      { projectId: h.project.id, text: '   ', author: human },
      { projectId: h.project.id, text: '본문', author: human, normState: 'provisional' },
      { text: '본문', author: human },
      { projectId: h.project.id, text: '본문' },
      { projectId: 'not-a-ulid', text: '본문', author: human },
    ]) {
      await expect(raw(params)).resolves.toMatchObject({
        error: { code: ErrorCode.InvalidParams },
      });
    }
    expect(rowCount(h.biveHome, h.project.id)).toBe(0);
  });
});

describe('requirement.update: 사람의 직접 편집은 제안 없이 바로 반영', () => {
  it('본문이 바로 바뀌고 수정 시각과 수정 주체가 갱신된다 (생성 주체 · 생성 시각은 그대로)', async () => {
    const h = await harness();
    // 에이전트 제안이 승인돼 들어온 요구사항을 사람이 고친다 → 수정 주체가 에이전트에서 사람으로 바뀐다
    const seeded = seedAgentRequirement(h.biveHome, h.project.id, '관리자는 회원을 정지할 수 있다');
    expect(seeded.updatedBy).toEqual(ruleWriter);

    h.clock.now = T0 + 5 * 60_000;
    const { requirement: updated } = await h.client.call('requirement.update', {
      projectId: h.project.id,
      id: seeded.id,
      text: '관리자는 사유를 남기고 회원을 정지할 수 있다',
      author: human,
    });
    expect(updated).toEqual({
      ...seeded,
      text: '관리자는 사유를 남기고 회원을 정지할 수 있다',
      updatedAt: iso(T0 + 5 * 60_000),
      updatedBy: human,
    });
    expect(updated.author).toEqual(ruleWriter);
    expect(updated.createdAt).toBe(seeded.createdAt);
    expect(updated.normState).toBe('approved');

    // 승인 대기 없이 곧바로 조회 · 목록에 반영되고, 제안은 생기지 않는다
    await expect(
      h.client.call('requirement.get', { projectId: h.project.id, id: seeded.id }),
    ).resolves.toEqual({ requirement: updated });
    await expect(h.client.call('requirement.list', { projectId: h.project.id })).resolves.toEqual({
      requirements: [updated],
    });
    expect(proposalCount(h.biveHome, h.project.id)).toBe(0);

    // 다시 고치면 수정 시각이 또 바뀐다
    h.clock.now = T0 + 10 * 60_000;
    const again = await h.client.call('requirement.update', {
      projectId: h.project.id,
      id: seeded.id,
      text: '관리자는 사유를 남기고 회원을 7일간 정지할 수 있다',
      author: human,
    });
    expect(again.requirement.updatedAt).toBe(iso(T0 + 10 * 60_000));
    expect(again.requirement.updatedAt).not.toBe(updated.updatedAt);
  });
});

describe('requirement.delete: deletedAt을 채우는 소프트 삭제', () => {
  it('deletedAt이 채워지고 list에서 빠지며, 행과 get 결과는 남는다', async () => {
    const h = await harness();
    const keep = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '사용자는 이메일로 가입할 수 있다',
      author: human,
    });
    const gone = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '사용자는 전화번호로 가입할 수 있다',
      author: human,
    });

    h.clock.now = T0 + 3_000;
    const { requirement: deleted } = await h.client.call('requirement.delete', {
      projectId: h.project.id,
      id: gone.requirement.id,
      author: human,
    });
    expect(deleted).toEqual({
      ...gone.requirement,
      updatedAt: iso(T0 + 3_000),
      updatedBy: human,
      deletedAt: iso(T0 + 3_000),
    });

    await expect(h.client.call('requirement.list', { projectId: h.project.id })).resolves.toEqual({
      requirements: [keep.requirement],
    });
    await expect(
      h.client.call('requirement.get', { projectId: h.project.id, id: gone.requirement.id }),
    ).resolves.toEqual({ requirement: deleted });
    expect(rowCount(h.biveHome, h.project.id)).toBe(2);

    // 이미 삭제된 것의 재삭제 · 수정은 상태 충돌
    await expect(
      h.client.call('requirement.delete', {
        projectId: h.project.id,
        id: gone.requirement.id,
        author: human,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.StateConflict });
    await expect(
      h.client.call('requirement.update', {
        projectId: h.project.id,
        id: gone.requirement.id,
        text: '되살리기',
        author: human,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.StateConflict });

    // 삭제된 번호는 다시 쓰지 않는다
    const next = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '사용자는 소셜 계정으로 가입할 수 있다',
      author: human,
    });
    expect(next.requirement.displayId).toBe('REQ-003');
  });
});

describe('requirement.delete: 자식 규칙은 남고 부모만 해제된다 (M1-09, ADR-050)', () => {
  it('삭제 뒤 자식 규칙이 그대로 남고 parentRequirementId가 비며 해제 시각이 남는다', async () => {
    const h = await harness();
    const proposals = new ProposalService({ biveHome: h.biveHome, now: () => h.clock.now });
    const parent = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '사용자는 이메일로 가입할 수 있다',
      author: human,
    });
    const other = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '가입한 사용자는 로그인할 수 있다',
      author: human,
    });

    // 규칙은 제안 → 사람 승인으로만 생긴다
    const approveRule = async (parentRequirementId: string, title: string) => {
      const proposal = proposals.submit(h.project.id, {
        kind: 'rule_new',
        payload: {
          title,
          statement: `WHEN ${title} THE SYSTEM SHALL 요청을 거부한다`,
          kind: 'business',
          checkKinds: ['test'],
          parentRequirementId,
        },
        rationale: '요구사항 분해',
        author: ruleWriter,
        source: 'rule_generation',
      });
      const { applied } = await h.client.call('proposal.approve', {
        projectId: h.project.id,
        id: proposal.id,
        author: human,
      });
      if (applied.entity !== 'Rule') throw new Error('규칙이 아님');
      return applied.rule;
    };
    const childA = await approveRule(parent.requirement.id, '중복 이메일 가입 거부');
    const childB = await approveRule(parent.requirement.id, '형식이 틀린 이메일 가입 거부');
    const unrelated = await approveRule(other.requirement.id, '틀린 비밀번호 로그인 거부');

    h.clock.now = T0 + 7_000;
    await h.client.call('requirement.delete', {
      projectId: h.project.id,
      id: parent.requirement.id,
      author: human,
    });

    const store = openProjectStore(h.project.id, { home: h.biveHome, create: false });
    try {
      for (const child of [childA, childB]) {
        expect(store.rules.get(child.id)).toEqual({
          ...child,
          parentRequirementId: null,
          parentDetachedAt: iso(T0 + 7_000),
          updatedAt: iso(T0 + 7_000),
        });
      }
      // 규칙은 지워지지 않고 목록에 남는다. 다른 요구사항의 규칙은 그대로다
      expect(store.rules.list().map((rule) => rule.id)).toEqual([
        childA.id,
        childB.id,
        unrelated.id,
      ]);
      expect(store.rules.get(unrelated.id)).toEqual(unrelated);
      expect(store.rules.listByParent(parent.requirement.id)).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe('주체 · 대상 검증', () => {
  it('에이전트 주체의 생성 · 수정 · 삭제는 -32020이고 아무것도 바꾸지 않는다', async () => {
    const h = await harness();
    const seeded = seedAgentRequirement(h.biveHome, h.project.id, '관리자는 회원을 정지할 수 있다');

    for (const author of [ruleWriter, chatAgent]) {
      await expect(
        h.client.call('requirement.create', { projectId: h.project.id, text: '새 요구', author }),
      ).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
      await expect(
        h.client.call('requirement.update', {
          projectId: h.project.id,
          id: seeded.id,
          text: '바꾼 본문',
          author,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
      await expect(
        h.client.call('requirement.delete', { projectId: h.project.id, id: seeded.id, author }),
      ).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
    }

    await expect(h.client.call('requirement.list', { projectId: h.project.id })).resolves.toEqual({
      requirements: [seeded],
    });
    expect(rowCount(h.biveHome, h.project.id)).toBe(1);
  });

  it('등록되지 않은 프로젝트 · 없는 요구사항은 -32004 (저장소를 새로 만들지 않는다)', async () => {
    const h = await harness();
    const unknownProject = newId();
    const notFound = { code: ErrorCode.NotFound };

    await expect(
      h.client.call('requirement.list', { projectId: unknownProject }),
    ).rejects.toMatchObject(notFound);
    await expect(
      h.client.call('requirement.create', {
        projectId: unknownProject,
        text: '본문',
        author: human,
      }),
    ).rejects.toMatchObject(notFound);
    expect(() => openProjectStore(unknownProject, { home: h.biveHome, create: false })).toThrow();

    const missing = newId();
    await expect(
      h.client.call('requirement.get', { projectId: h.project.id, id: missing }),
    ).rejects.toMatchObject(notFound);
    await expect(
      h.client.call('requirement.update', {
        projectId: h.project.id,
        id: missing,
        text: '본문',
        author: human,
      }),
    ).rejects.toMatchObject(notFound);
    await expect(
      h.client.call('requirement.delete', { projectId: h.project.id, id: missing, author: human }),
    ).rejects.toMatchObject(notFound);
  });

  it('등록부가 아직 없는 BIVE_HOME에서도 -32004', async () => {
    const biveHome = makeBiveHome();
    const socketPath = path.join(biveHome, 'e.sock');
    const server = new PipeServer({
      transport: new NetPipeTransport(),
      path: socketPath,
      token: 'tok',
      orchestratorVersion: '0.0.0-test',
      handlers: createHandlers({
        orchestratorVersion: '0.0.0-test',
        status: { startedAt: 0, connectionCount: 0, activeRunCount: 0 },
        biveHome,
      }),
    });
    servers.push(server);
    await server.listen();
    const client = await connect(socketPath, 'tok');
    clients.push(client);
    await expect(client.call('requirement.list', { projectId: newId() })).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
  });
});

describe('오케스트레이터 기동 경로', () => {
  it('startOrchestrator의 BIVE_HOME 저장소로 요구사항을 만들고 읽는다', async () => {
    const biveHome = makeBiveHome();
    const project = registerSampleProject(biveHome);
    const result = await startOrchestrator({ biveHome, idleShutdownMs: 60_000 });
    if (result.status !== 'started') throw new Error('기동 실패');
    running.push(result.orchestrator);
    const client = await connect(result.orchestrator.paths.pipe, result.orchestrator.token);
    clients.push(client);

    const before = Date.now();
    const { requirement } = await client.call('requirement.create', {
      projectId: project.id,
      text: '사용자는 이메일로 가입할 수 있다',
      author: human,
    });
    const createdAt = Date.parse(requirement.createdAt);
    expect(createdAt).toBeGreaterThanOrEqual(before - 1);
    expect(createdAt).toBeLessThanOrEqual(Date.now() + 1);
    await expect(client.call('requirement.list', { projectId: project.id })).resolves.toEqual({
      requirements: [requirement],
    });

    const store = openProjectStore(project.id, { home: biveHome, create: false });
    try {
      expect(store.requirements.get(requirement.id)).toEqual(requirement);
    } finally {
      store.close();
    }
  });
});
