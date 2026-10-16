// 프로젝트 열기 RPC (M1-01 수용 기준 1, PRJ-01 · ADR-025 · ADR-036 · ADR-040 · ADR-054).
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소 · 실제 폴더.
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { ErrorCode, PROJECT_FILE_NAME, type Project } from '@bive/shared';
import { bivePaths, listRegisteredProjects, unregisterProject } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import { createHandlers } from '../src/ipc/handlers.js';
import { PipeServer } from '../src/ipc/server.js';
import { NetPipeTransport } from '../src/ipc/transport.js';
import { detectBaseBranch, formatProjectFile } from '../src/project/open-project.js';
import { connect, RpcCallError, type TestClient } from './helpers/client.js';
import { cleanup, makeBiveHome } from './helpers/process.js';

const T0 = Date.parse('2026-10-16T09:00:00.000Z');
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const servers: PipeServer[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  await cleanup();
});

interface Harness {
  biveHome: string;
  client: TestClient;
  /** 오케스트레이터 시계(ms) */
  clock: { now: number };
}

/** 실제 처리기를 붙인 파이프 서버 + 인증된 클라이언트. 같은 BIVE_HOME으로 다시 띄우면 메모리만 새로 시작한다. */
const harness = async (biveHome = makeBiveHome()): Promise<Harness> => {
  const clock = { now: T0 };
  const socketPath = path.join(biveHome, `p${servers.length}.sock`);
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
  return { biveHome, client, clock };
};

/** 프로젝트 폴더를 만들 임시 위치. BIVE_HOME과 분리한다. */
const makeFolder = (name: string): string => {
  const parent = makeBiveHome();
  const dir = path.join(parent, name);
  mkdirSync(dir);
  return realpathSync(dir);
};

/** 비어 있지 않은 미연결 폴더 (M1 픽스처처럼 소스 · git 저장소가 있는 폴더). */
const makeExistingApp = (name = 'sample-app', branch = 'main'): string => {
  const dir = makeFolder(name);
  writeFileSync(path.join(dir, 'package.json'), '{"name":"sample-app"}\n');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {};\n');
  mkdirSync(path.join(dir, '.git'));
  writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  return dir;
};

const projectFile = (dir: string): string => path.join(dir, PROJECT_FILE_NAME);
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

const expectRpcError = async (promise: Promise<unknown>, code: number): Promise<void> => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RpcCallError);
  expect((error as RpcCallError).code).toBe(code);
};

/** 스키마 검증을 거치지 않고 보낸 요청의 오류 코드. */
const rawErrorCode = async (client: TestClient, params: unknown): Promise<number | undefined> => {
  const response = (await client.requestRaw({
    jsonrpc: '2.0',
    id: 'raw',
    method: 'project.open',
    params,
  })) as { error?: { code: number } };
  return response.error?.code;
};

describe('project.open: 미연결 폴더 → .bive.json 생성 · 등록', () => {
  it('비어 있지 않은 미연결 폴더에 projectId · schemaVersion 두 키만 쓰고 저장소에 등록한다', async () => {
    const h = await harness();
    const dir = makeExistingApp('sample-app', 'main');

    const result = await h.client.call('project.open', { path: dir });

    const expected: Project = {
      id: result.project.id,
      name: 'sample-app',
      rootPath: dir,
      baseBranch: 'main',
      createdAt: new Date(T0).toISOString(),
    };
    expect(result).toEqual({ project: expected, created: true, empty: false });
    expect(result.project.id).toMatch(ULID);

    const json = readJson(projectFile(dir)) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['projectId', 'schemaVersion']);
    expect(json).toEqual({ projectId: result.project.id, schemaVersion: 1 });
    // 들여쓰기 JSON + 끝 개행
    expect(readFileSync(projectFile(dir), 'utf8')).toBe(
      `{\n  "projectId": "${result.project.id}",\n  "schemaVersion": 1\n}\n`,
    );

    expect(listRegisteredProjects({ home: h.biveHome })).toEqual([expected]);
    expect(statSync(bivePaths(h.biveHome).projectDb(result.project.id)).isFile()).toBe(true);
    // 원래 파일은 그대로다
    expect(readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe('{"name":"sample-app"}\n');
  });

  it('빈 폴더도 같은 방식으로 만들고 empty = true', async () => {
    const h = await harness();
    const dir = makeFolder('new-app');

    const result = await h.client.call('project.open', { path: dir });

    expect(result.created).toBe(true);
    expect(result.empty).toBe(true);
    expect(result.project).toMatchObject({ name: 'new-app', rootPath: dir, baseBranch: 'main' });
    expect(readJson(projectFile(dir))).toEqual({ projectId: result.project.id, schemaVersion: 1 });
    expect(listRegisteredProjects({ home: h.biveHome }).map((p) => p.id)).toEqual([
      result.project.id,
    ]);
  });

  it('심볼릭 링크 경로로 열면 실경로를 저장하고 폴더 이름은 실경로의 이름이다', async () => {
    const h = await harness();
    const dir = makeExistingApp('real-app');
    const link = path.join(makeFolder('links'), 'alias');
    symlinkSync(dir, link);

    const { project } = await h.client.call('project.open', { path: link });

    expect(project.rootPath).toBe(dir);
    expect(project.name).toBe('real-app');
    expect(readJson(projectFile(dir))).toEqual({ projectId: project.id, schemaVersion: 1 });
  });

  it('기준 브랜치는 git HEAD의 브랜치, git이 아니거나 HEAD가 브랜치가 아니면 main', async () => {
    const h = await harness();
    const trunk = makeExistingApp('trunk-app', 'trunk');
    expect((await h.client.call('project.open', { path: trunk })).project.baseBranch).toBe('trunk');

    const detached = makeExistingApp('detached-app');
    writeFileSync(
      path.join(detached, '.git', 'HEAD'),
      '0123456789abcdef0123456789abcdef01234567\n',
    );
    expect(detectBaseBranch(detached)).toBe('main');

    const worktree = makeFolder('wt');
    const gitDir = path.join(makeFolder('gitdirs'), 'wt');
    mkdirSync(gitDir);
    writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature/x\n');
    writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    expect(detectBaseBranch(worktree)).toBe('feature/x');

    expect(detectBaseBranch(makeFolder('plain'))).toBe('main');
  });
});

describe('project.open: 연결된 폴더 재진입', () => {
  it('파일을 다시 쓰지 않는다 (내용 · 수정 시각 동일), 같은 프로젝트로 진입하고 등록은 1건 그대로다', async () => {
    const h = await harness();
    const dir = makeExistingApp();
    const first = await h.client.call('project.open', { path: dir });
    // 수정 시각 비교가 의미 있도록 과거 시각으로 돌려 둔다
    const past = new Date(T0 - 3_600_000);
    utimesSync(projectFile(dir), past, past);
    const before = statSync(projectFile(dir));
    const content = readFileSync(projectFile(dir), 'utf8');
    h.clock.now = T0 + 60_000;

    const second = await h.client.call('project.open', { path: dir });

    expect(second).toEqual({ project: first.project, created: false, empty: false });
    const after = statSync(projectFile(dir));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
    expect(readFileSync(projectFile(dir), 'utf8')).toBe(content);
    expect(listRegisteredProjects({ home: h.biveHome })).toEqual([first.project]);
  });

  it('오케스트레이터를 다시 띄워도(메모리 초기화) 같은 프로젝트로 진입하고 파일은 그대로다', async () => {
    const first = await harness();
    const dir = makeExistingApp();
    const opened = await first.client.call('project.open', { path: dir });
    const mtime = statSync(projectFile(dir)).mtimeMs;

    const second = await harness(first.biveHome);
    expect(await second.client.call('project.current')).toEqual({ project: null });
    const again = await second.client.call('project.open', { path: dir });

    expect(again).toEqual({ project: opened.project, created: false, empty: false });
    expect(statSync(projectFile(dir)).mtimeMs).toBe(mtime);
  });

  it('빈 폴더를 다시 열면 created = false, empty = true (설정 파일만 있는 폴더)', async () => {
    const h = await harness();
    const dir = makeFolder('new-app');
    const first = await h.client.call('project.open', { path: dir });

    await expect(h.client.call('project.open', { path: dir })).resolves.toEqual({
      project: first.project,
      created: false,
      empty: true,
    });
  });

  it('등록부에 없는 설정 파일(다른 저장소 루트에서 만든 것)은 그 ID로 등록하고 파일은 쓰지 않는다', async () => {
    const original = await harness();
    const dir = makeExistingApp();
    const { project } = await original.client.call('project.open', { path: dir });
    const mtime = statSync(projectFile(dir)).mtimeMs;

    const other = await harness(makeBiveHome());
    other.clock.now = T0 + 5_000;
    const result = await other.client.call('project.open', { path: dir });

    expect(result.created).toBe(false);
    expect(result.project).toEqual({ ...project, createdAt: new Date(T0 + 5_000).toISOString() });
    expect(listRegisteredProjects({ home: other.biveHome }).map((p) => p.id)).toEqual([project.id]);
    expect(statSync(projectFile(dir)).mtimeMs).toBe(mtime);
  });

  it('등록 해제된 프로젝트는 저장된 행 그대로 다시 등록한다 (ADR-040: 규범 · 기록 보존)', async () => {
    const h = await harness();
    const dir = makeExistingApp();
    const { project } = await h.client.call('project.open', { path: dir });
    expect(unregisterProject(project.id, { home: h.biveHome })).toBe(true);
    h.clock.now = T0 + 120_000;

    const result = await h.client.call('project.open', { path: dir });

    expect(result).toEqual({ project, created: false, empty: false });
    expect(listRegisteredProjects({ home: h.biveHome })).toEqual([project]);
  });
});

describe('project.open: 오류', () => {
  it('절대 경로가 아니거나 빈 값이면 -32602, 없는 경로는 -32004로 구분한다', async () => {
    const h = await harness();
    expect(await rawErrorCode(h.client, { path: 'relative/app' })).toBe(ErrorCode.InvalidParams);
    expect(await rawErrorCode(h.client, { path: '' })).toBe(ErrorCode.InvalidParams);
    expect(await rawErrorCode(h.client, {})).toBe(ErrorCode.InvalidParams);
    expect(await rawErrorCode(h.client, { path: '/a', extra: 1 })).toBe(ErrorCode.InvalidParams);

    const missing = path.join(makeFolder('parent'), 'no-such-dir');
    await expectRpcError(h.client.call('project.open', { path: missing }), ErrorCode.NotFound);
    expect(listRegisteredProjects({ home: h.biveHome })).toEqual([]);
  });

  it('폴더가 아닌 파일 경로는 -32001이고 아무것도 만들지 않는다', async () => {
    const h = await harness();
    const dir = makeFolder('parent');
    const file = path.join(dir, 'notes.txt');
    writeFileSync(file, 'x');

    await expectRpcError(h.client.call('project.open', { path: file }), ErrorCode.ValidationFailed);
    expect(listRegisteredProjects({ home: h.biveHome })).toEqual([]);
  });

  it('형식이 틀린 설정 파일은 -32001이고 고치거나 덮어쓰지 않는다', async () => {
    const h = await harness();
    const cases = [
      'not json',
      '{"projectId":"x","schemaVersion":1}',
      `{"projectId":"01JABCDEFGHJKMNPQRSTVWXYZ0","schemaVersion":1,"blocks":[]}`,
      `{"projectId":"01JABCDEFGHJKMNPQRSTVWXYZ0","schemaVersion":2}`,
    ];
    for (const content of cases) {
      const dir = makeExistingApp();
      writeFileSync(projectFile(dir), content);
      await expectRpcError(
        h.client.call('project.open', { path: dir }),
        ErrorCode.ValidationFailed,
      );
      expect(readFileSync(projectFile(dir), 'utf8')).toBe(content);
    }
    const dirAsFile = makeExistingApp();
    mkdirSync(projectFile(dirAsFile));
    await expectRpcError(
      h.client.call('project.open', { path: dirAsFile }),
      ErrorCode.ValidationFailed,
    );
    expect(listRegisteredProjects({ home: h.biveHome })).toEqual([]);
  });

  it('다른 경로에 등록된 프로젝트의 설정 파일(복사한 폴더)은 -32009이고 등록을 늘리지 않는다', async () => {
    const h = await harness();
    const dir = makeExistingApp('original');
    const { project } = await h.client.call('project.open', { path: dir });
    const copy = makeExistingApp('copy');
    writeFileSync(projectFile(copy), formatProjectFile(project.id));

    await expectRpcError(h.client.call('project.open', { path: copy }), ErrorCode.StateConflict);
    expect(listRegisteredProjects({ home: h.biveHome })).toEqual([project]);
  });
});

describe('project.current · project.list', () => {
  it('current는 열기 전 null, 연 뒤 마지막으로 연 프로젝트, 등록 해제되면 null', async () => {
    const h = await harness();
    expect(await h.client.call('project.current')).toEqual({ project: null });

    const a = await h.client.call('project.open', { path: makeExistingApp('a-app') });
    expect(await h.client.call('project.current')).toEqual({ project: a.project });

    h.clock.now = T0 + 1_000;
    const b = await h.client.call('project.open', { path: makeFolder('b-app') });
    expect(await h.client.call('project.current')).toEqual({ project: b.project });

    unregisterProject(b.project.id, { home: h.biveHome });
    expect(await h.client.call('project.current')).toEqual({ project: null });
  });

  it('list는 등록된 프로젝트를 등록 시각 순으로, 등록부가 없으면 빈 목록이고 파일을 만들지 않는다', async () => {
    const h = await harness();
    expect(await h.client.call('project.list')).toEqual({ projects: [] });
    expect(() => statSync(bivePaths(h.biveHome).registryDb)).toThrow();

    const a = await h.client.call('project.open', { path: makeExistingApp('a-app') });
    h.clock.now = T0 + 1_000;
    const b = await h.client.call('project.open', { path: makeFolder('b-app') });

    expect(await h.client.call('project.list')).toEqual({ projects: [a.project, b.project] });
  });

  it('current · list에 파라미터를 넣으면 -32602', async () => {
    const h = await harness();
    for (const method of ['project.current', 'project.list']) {
      const response = (await h.client.requestRaw({
        jsonrpc: '2.0',
        id: method,
        method,
        params: {},
      })) as { error?: { code: number } };
      expect(response.error?.code).toBe(ErrorCode.InvalidParams);
    }
  });
});
