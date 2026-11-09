// 테스트 전용: 등록된 프로젝트 + 실제 처리기(`createHandlers`)를 붙인 파이프 서버 + 인증된 클라이언트.
// 시계를 고정해 처리 시각을 단언한다. 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소.
import path from 'node:path';

import { createUlidGenerator, type Project } from '@bive/shared';
import { openProjectStore, registerProject, type ProjectStore } from '@bive/store';

import { createHandlers } from '../../src/ipc/handlers.js';
import { PipeServer } from '../../src/ipc/server.js';
import { NetPipeTransport } from '../../src/ipc/transport.js';
import { ProposalService } from '../../src/proposals/proposal-service.js';
import type { RuleWriterLauncher } from '../../src/rule-writer/rule-writer-service.js';
import { connect, type TestClient } from './client.js';
import { makeBiveHome } from './process.js';

export const TOKEN = 'tok';
export const T0 = Date.parse('2026-10-16T09:00:00.000Z');
export const iso = (ms: number): string => new Date(ms).toISOString();

const newId = createUlidGenerator();

export interface ProjectHarness {
  biveHome: string;
  socketPath: string;
  project: Project;
  server: PipeServer;
  client: TestClient;
  /** 오케스트레이터 시계(ms). 바꾸면 다음 요청부터 반영된다 */
  clock: { now: number };
  /** 같은 시계를 쓰는 내부 제안 등록 창구 */
  proposals: ProposalService;
  /** 프로젝트 저장소를 열어 읽고 닫는다 */
  read: <T>(fn: (store: ProjectStore) => T) => T;
}

/** 열린 서버 · 클라이언트를 테스트 끝에 닫도록 모아 둔다. */
export interface HarnessRegistry {
  servers: PipeServer[];
  clients: TestClient[];
}

export interface ProjectHarnessOptions {
  /** `requirement.create` 뒤 세션 창구를 만든다 (생략하면 세션을 띄우지 않는다) */
  ruleWriter?: (context: { biveHome: string; now: () => number }) => RuleWriterLauncher;
}

export const startProjectHarness = async (
  registry: HarnessRegistry,
  options: ProjectHarnessOptions = {},
): Promise<ProjectHarness> => {
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
  const clock = { now: T0 };
  const now = () => clock.now;
  const socketPath = path.join(biveHome, 'p.sock');
  const ruleWriter = options.ruleWriter?.({ biveHome, now });
  const server = new PipeServer({
    transport: new NetPipeTransport(),
    path: socketPath,
    token: TOKEN,
    orchestratorVersion: '0.0.0-test',
    handlers: createHandlers({
      orchestratorVersion: '0.0.0-test',
      status: { startedAt: T0, connectionCount: 0, activeRunCount: 0 },
      biveHome,
      now,
      ...(ruleWriter === undefined ? {} : { ruleWriter }),
    }),
  });
  registry.servers.push(server);
  await server.listen();
  const client = await connect(socketPath, TOKEN);
  registry.clients.push(client);
  const read = <T>(fn: (store: ProjectStore) => T): T => {
    const store = openProjectStore(project.id, { home: biveHome, create: false });
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };
  return {
    biveHome,
    socketPath,
    project,
    server,
    client,
    clock,
    proposals: new ProposalService({ biveHome, now }),
    read,
  };
};
