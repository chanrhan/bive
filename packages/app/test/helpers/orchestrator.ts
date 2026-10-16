// 테스트용 임시 BIVE_HOME · 실제 오케스트레이터 · 가짜 오케스트레이터(소켓 서버) 도우미.
// 테스트가 끝나면 cleanup()으로 남은 오케스트레이터 프로세스 · 서버 · 임시 폴더를 정리한다.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isProcessAlive, readPidFile } from '../../src/main/orchestrator-launch.js';
import { appRunPaths } from '../../src/main/run-paths.js';

export const APP_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const ORCHESTRATOR_DIR = path.resolve(APP_DIR, '../orchestrator');
export const REPO_ROOT = path.resolve(APP_DIR, '../..');

const homes: string[] = [];
const servers = new Set<net.Server>();
const fakeSockets = new Set<net.Socket>();
const children = new Set<ChildProcess>();

/** 짧은 임시 BIVE_HOME. Unix 소켓 경로 제한을 넘지 않도록 `/tmp` 바로 아래. */
export const makeBiveHome = (): string => {
  const base = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const home = mkdtempSync(path.join(base, 'bive-app-'));
  homes.push(home);
  return home;
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const waitFor = async (
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`시간 초과: ${what}`);
    await sleep(25);
  }
};

/** 오케스트레이터 CLI를 테스트가 직접 띄운다 (`pnpm --filter @bive/orchestrator start`와 같은 방식). */
export const spawnOrchestratorDirectly = (biveHome: string, idleMs = 60_000): ChildProcess => {
  const child = spawn(
    process.execPath,
    ['--conditions=@bive/source', '--import', 'tsx', 'src/cli.ts'],
    {
      cwd: ORCHESTRATOR_DIR,
      env: { ...process.env, BIVE_HOME: biveHome, BIVE_IDLE_SHUTDOWN_MS: String(idleMs) },
      stdio: 'ignore',
    },
  );
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
};

export interface FakeOrchestrator {
  readonly connections: number;
  /** 듣기를 멈추고 열린 연결을 모두 끊는다 (오케스트레이터가 죽은 것처럼). */
  close(): Promise<void>;
}

const send = (socket: net.Socket, message: unknown): void => {
  socket.write(`${JSON.stringify(message)}\n`);
};

/**
 * 가짜 오케스트레이터: 앱 경로 규칙의 소켓에서 듣고, 지정 토큰의 `system.hello`와 `ping` · `system.status`에만 답한다.
 * 잠금 파일 · 토큰 파일은 테스트가 따로 쓴다.
 */
export const listenFakeOrchestrator = (
  biveHome: string,
  token: string,
): Promise<FakeOrchestrator> => {
  const paths = appRunPaths(biveHome);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const startedAt = Date.now();
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    fakeSockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      fakeSockets.delete(socket);
    });
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('error', () => undefined);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i !== -1; i = buffer.indexOf('\n')) {
        const req = JSON.parse(buffer.slice(0, i)) as {
          id: number;
          method: string;
          params?: { token?: string };
        };
        buffer = buffer.slice(i + 1);
        if (req.method === 'system.hello') {
          if (req.params?.token === token) {
            send(socket, { jsonrpc: '2.0', id: req.id, result: { orchestratorVersion: 'fake' } });
          } else {
            send(socket, {
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -32020, message: '토큰 불일치' },
            });
            socket.end();
          }
        } else if (req.method === 'ping') {
          send(socket, { jsonrpc: '2.0', id: req.id, result: { pong: true, version: 'fake' } });
        } else if (req.method === 'system.status') {
          send(socket, {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              version: 'fake',
              uptimeMs: Date.now() - startedAt,
              connections: sockets.size,
              runsInProgress: 0,
            },
          });
        }
      }
    });
  });
  servers.add(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.pipe, () => {
      resolve({
        get connections() {
          return connections;
        },
        close: () =>
          new Promise<void>((done) => {
            servers.delete(server);
            server.close(() => done());
            for (const socket of sockets) socket.destroy();
          }),
      });
    });
  });
};

/** 잠금 파일 · 토큰 파일을 직접 쓴다 (가짜 오케스트레이터용). */
export const writeRunFiles = (biveHome: string, files: { pid?: number; token?: string }): void => {
  const paths = appRunPaths(biveHome);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  if (files.pid !== undefined) writeFileSync(paths.orchestratorPid, `${files.pid}\n`);
  if (files.token !== undefined) writeFileSync(paths.token, files.token);
};

/** 남은 서버 · 자식 · 잠금 파일이 가리키는 오케스트레이터를 정리하고 임시 폴더를 지운다. */
export const cleanup = async (): Promise<void> => {
  // 열린 연결이 남아 있으면 server.close가 끝나지 않으므로 먼저 끊는다
  for (const socket of fakeSockets) socket.destroy();
  fakeSockets.clear();
  await Promise.all([...servers].map((s) => new Promise<void>((done) => s.close(() => done()))));
  servers.clear();
  for (const home of homes) {
    const pid = readPidFile(appRunPaths(home).orchestratorPid);
    if (pid !== null && pid !== process.pid && isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 이미 끝남
      }
    }
  }
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
};
