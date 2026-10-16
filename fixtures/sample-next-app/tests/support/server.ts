// 테스트용 서버 기동 (ADR-026의 판정 서버 기동과 같은 순서).
// 임시 SQLite에 prisma migrate deploy → next build → next start(127.0.0.1, 빈 포트).
// next dev는 쓰지 않는다. 기준 URL은 provide('baseUrl')로 테스트에 넘긴다.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    baseUrl: string;
  }
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bin = (name: string) => join(projectRoot, 'node_modules', '.bin', name);
const START_TIMEOUT_MS = 60_000;

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd: projectRoot, env, stdio: 'inherit' });
    child.on('error', fail);
    child.on('exit', (code, signal) =>
      code === 0 ? done() : fail(new Error(`${cmd} ${args.join(' ')} 실패 (${code ?? signal})`)),
    );
  });
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.on('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => done(port));
    });
  });
}

async function waitForServer(url: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`next start 조기 종료 (${server.exitCode})`);
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`서버 응답 대기 시간 초과: ${url}`);
}

function stop(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(() => server.kill('SIGKILL'), 5_000);
    server.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    server.kill('SIGTERM');
  });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dbDir = mkdtempSync(join(tmpdir(), 'sample-next-app-db-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: `file:${join(dbDir, 'test.db')}`,
    NEXT_TELEMETRY_DISABLED: '1',
  };

  let server: ChildProcess | undefined;
  try {
    await run(bin('prisma'), ['migrate', 'deploy'], env);
    await run(bin('next'), ['build'], { ...env, NODE_ENV: 'production' });

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(bin('next'), ['start', '-H', '127.0.0.1', '-p', String(port)], {
      cwd: projectRoot,
      env: { ...env, NODE_ENV: 'production' },
      stdio: 'inherit',
    });
    await waitForServer(baseUrl, server);
    project.provide('baseUrl', baseUrl);
  } catch (err) {
    if (server) await stop(server);
    rmSync(dbDir, { recursive: true, force: true });
    throw err;
  }

  const started = server;
  return async () => {
    await stop(started);
    rmSync(dbDir, { recursive: true, force: true });
  };
}
