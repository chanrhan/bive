// 앱 main의 오케스트레이터 기동 · 접속 · app.pid 기록 (이슈 #9 수용 기준 2, NFR-06, ADR-041).
// main(src/main/index.ts)이 부르는 startMainSession · ensureOrchestrator를 그대로 시험한다.
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { ErrorCode } from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureOrchestrator,
  isProcessAlive,
  type OrchestratorCommand,
  orchestratorCommand,
  readPidFile,
  resolveOrchestratorMode,
  type SpawnFn,
} from '../src/main/orchestrator-launch.js';
import { PipeRpcError } from '../src/main/pipe-client.js';
import { appRunPaths } from '../src/main/run-paths.js';
import { OrchestratorLink, startMainSession } from '../src/main/session.js';
import { createFakeNet } from './helpers/fake-net.js';
import {
  cleanup,
  listenFakeOrchestrator,
  makeBiveHome,
  ORCHESTRATOR_DIR,
  sleep,
  spawnOrchestratorDirectly,
  waitFor,
  writeRunFiles,
} from './helpers/orchestrator.js';

afterEach(cleanup);

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
  child: ChildProcess;
}

/** 실제 spawn을 부르면서 인자를 기록한다. */
const recordingSpawn = (): { spawn: SpawnFn; calls: SpawnCall[] } => {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn: (command, args, options) => {
      const child = nodeSpawn(command, args, options);
      calls.push({ command, args, options, child });
      return child;
    },
  };
};

const forbiddenSpawn: SpawnFn = () => {
  throw new Error('기동하면 안 됨');
};

/** 가짜 자식 프로세스: 아무것도 실행하지 않는다. */
const fakeSpawn = (): { spawn: SpawnFn; count: () => number } => {
  let count = 0;
  return {
    count: () => count,
    spawn: () => {
      count += 1;
      return Object.assign(new EventEmitter(), {
        pid: 999_999,
        unref: () => undefined,
      }) as unknown as ChildProcess;
    },
  };
};

const sourceCommand = (biveHome: string): OrchestratorCommand =>
  orchestratorCommand({
    mode: 'source',
    orchestratorDir: ORCHESTRATOR_DIR,
    nodePath: process.execPath,
    biveHome,
    // 테스트 중 유휴 종료로 사라지지 않게 길게 둔다. 정리는 cleanup이 한다
    env: { ...process.env, BIVE_IDLE_SHUTDOWN_MS: '60000' },
  });

/** Linux: /proc/<pid>/stat의 프로세스 그룹 · 세션 ID. 다른 OS는 null. */
const processGroup = (pid: number): { pgrp: number; session: number } | null => {
  if (process.platform !== 'linux') return null;
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // 두 번째 필드(comm)는 괄호 안에 공백이 있을 수 있으므로 마지막 ')' 뒤부터 센다
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { pgrp: Number(fields[2]), session: Number(fields[3]) };
};

describe('main 세션: 오케스트레이터 기동 · 접속 · app.pid', () => {
  it('오케스트레이터가 없으면 분리(detached) 프로세스로 기동하고 앱 main pid를 app.pid에 기록한다', async () => {
    const home = makeBiveHome();
    const paths = appRunPaths(home);
    const { spawn, calls } = recordingSpawn();

    const session = startMainSession({
      biveHome: home,
      command: sourceCommand(home),
      spawn,
      timeoutMs: 20_000,
    });
    // app.pid는 접속 전에 바로 쓴다
    expect(readFileSync(paths.appPid, 'utf8')).toBe(`${process.pid}\n`);
    expect(session.appPid).toBe(process.pid);

    const result = await session.link.connect();
    expect(result.launched).toBe(true);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.options).toMatchObject({ detached: true, stdio: 'ignore', cwd: ORCHESTRATOR_DIR });
    expect(call?.options.env?.BIVE_HOME).toBe(home);
    expect(call?.args.slice(0, 3)).toEqual(['--conditions=@bive/source', '--import', 'tsx']);

    // 띄운 프로세스가 잠금을 잡은 오케스트레이터다 (앱과 다른 pid)
    const orchestratorPid = readPidFile(paths.orchestratorPid);
    expect(orchestratorPid).toBe(result.spawnedPid);
    expect(orchestratorPid).not.toBe(process.pid);
    const group = orchestratorPid === null ? null : processGroup(orchestratorPid);
    if (group !== null) {
      // detached = 새 세션 · 프로세스 그룹의 리더 (앱의 프로세스 그룹과 분리)
      expect(group.pgrp).toBe(orchestratorPid);
      expect(group.session).toBe(orchestratorPid);
      expect(group.pgrp).not.toBe(processGroup(process.pid)?.pgrp);
    }

    await expect(session.link.request('ping')).resolves.toMatchObject({ pong: true });

    // 앱 종료: 연결을 닫고 app.pid만 지운다. 오케스트레이터는 계속 산다 (NFR-06)
    session.dispose();
    expect(existsSync(paths.appPid)).toBe(false);
    await sleep(300);
    expect(orchestratorPid !== null && isProcessAlive(orchestratorPid)).toBe(true);
    expect(readPidFile(paths.orchestratorPid)).toBe(orchestratorPid);
  });

  it('오케스트레이터가 이미 실행 중이면 기동하지 않고 붙는다', async () => {
    const home = makeBiveHome();
    const paths = appRunPaths(home);
    const existing = spawnOrchestratorDirectly(home);
    await waitFor(
      () => readPidFile(paths.orchestratorPid) === existing.pid && existsSync(paths.token),
      20_000,
      '기존 오케스트레이터 기동',
    );

    const session = startMainSession({
      biveHome: home,
      command: sourceCommand(home),
      spawn: forbiddenSpawn,
    });
    const result = await session.link.connect();
    expect(result).toMatchObject({ launched: false, spawnedPid: null });
    await expect(session.link.request('ping')).resolves.toMatchObject({ pong: true });
    expect(readFileSync(paths.appPid, 'utf8')).toBe(`${process.pid}\n`);

    session.dispose();
    expect(existsSync(paths.appPid)).toBe(false);
    await sleep(200);
    expect(existing.exitCode).toBeNull();
    expect(readPidFile(paths.orchestratorPid)).toBe(existing.pid);
  });

  it('dispose는 app.pid가 다른 pid를 가리키면 지우지 않는다', () => {
    const home = makeBiveHome();
    const paths = appRunPaths(home);
    const session = startMainSession({
      biveHome: home,
      command: sourceCommand(home),
      appPid: 4242,
    });
    expect(readFileSync(paths.appPid, 'utf8')).toBe('4242\n');
    writeFileSync(paths.appPid, '5353\n');
    session.dispose();
    expect(readFileSync(paths.appPid, 'utf8')).toBe('5353\n');
  });
});

describe('ensureOrchestrator: 접속 재시도 (ADR-041)', () => {
  it('잠금 pid는 살아 있는데 소켓이 늦게 열리면(ENOENT) 재시도해 붙고 기동하지 않는다', async () => {
    const home = makeBiveHome();
    writeRunFiles(home, { pid: process.pid, token: 'tok' });
    setTimeout(() => void listenFakeOrchestrator(home, 'tok'), 400);
    const started = Date.now();
    const result = await ensureOrchestrator({
      biveHome: home,
      command: sourceCommand(home),
      spawn: forbiddenSpawn,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(result.launched).toBe(false);
    await expect(result.client.call('ping')).resolves.toEqual({ pong: true, version: 'fake' });
    await result.client.close();
  });

  it('ECONNREFUSED도 100ms 간격으로 재시도한다', async () => {
    const home = makeBiveHome();
    writeRunFiles(home, { pid: process.pid, token: 'tok' });
    let attempts = 0;
    const net = createFakeNet(
      (line, socket) => {
        const req = JSON.parse(line) as { id: number };
        socket.send({ jsonrpc: '2.0', id: req.id, result: { orchestratorVersion: 'fake' } });
      },
      () => {
        attempts += 1;
        return attempts <= 3 ? 'ECONNREFUSED' : null;
      },
    );
    const started = Date.now();
    const result = await ensureOrchestrator({
      biveHome: home,
      command: sourceCommand(home),
      spawn: forbiddenSpawn,
      net,
    });
    expect(attempts).toBe(4);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await result.client.close();
  });

  it('죽은 인스턴스의 토큰을 읽어 인증이 거부되면(-32020) 토큰을 다시 읽어 붙는다', async () => {
    const home = makeBiveHome();
    const paths = appRunPaths(home);
    writeRunFiles(home, { pid: process.pid, token: 'old' });
    await listenFakeOrchestrator(home, 'new');
    setTimeout(() => writeFileSync(paths.token, 'new'), 250);
    const result = await ensureOrchestrator({
      biveHome: home,
      command: sourceCommand(home),
      spawn: forbiddenSpawn,
    });
    await expect(result.client.call('ping')).resolves.toMatchObject({ pong: true });
    await result.client.close();
  });

  it('제한 시간 안에 접속하지 못하면 시간 초과 오류', async () => {
    const home = makeBiveHome();
    writeRunFiles(home, { pid: process.pid, token: 'tok' });
    await expect(
      ensureOrchestrator({
        biveHome: home,
        command: sourceCommand(home),
        spawn: forbiddenSpawn,
        timeoutMs: 300,
      }),
    ).rejects.toThrow('오케스트레이터 접속 시간 초과');
  });

  it('잠금 파일의 pid가 죽어 있으면 기동한다', async () => {
    const home = makeBiveHome();
    const dead = nodeSpawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => dead.once('exit', resolve));
    writeRunFiles(home, { pid: dead.pid ?? 1, token: 'tok' });
    const { spawn, count } = fakeSpawn();
    const net = createFakeNet((line, socket) => {
      const req = JSON.parse(line) as { id: number };
      socket.send({ jsonrpc: '2.0', id: req.id, result: { orchestratorVersion: 'fake' } });
    });
    const result = await ensureOrchestrator({
      biveHome: home,
      command: sourceCommand(home),
      spawn,
      net,
    });
    expect(count()).toBe(1);
    expect(result).toMatchObject({ launched: true, spawnedPid: 999_999 });
    await result.client.close();
  });

  it('실행 파일이 없어 기동이 실패하면 제한 시간을 기다리지 않고 오류', async () => {
    const home = makeBiveHome();
    const command = { ...sourceCommand(home), command: '/nonexistent/bive-node' };
    const started = Date.now();
    await expect(ensureOrchestrator({ biveHome: home, command })).rejects.toThrow(
      '오케스트레이터 기동 실패',
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('띄운 자식이 비정상 종료하면 제한 시간을 기다리지 않고 오류', async () => {
    const home = makeBiveHome();
    const command = { ...sourceCommand(home), args: ['-e', 'process.exit(3)'] };
    const started = Date.now();
    await expect(ensureOrchestrator({ biveHome: home, command })).rejects.toThrow(
      '오케스트레이터 기동 실패: 비정상 종료 (코드 3',
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('자식이 종료 코드 0(이미 실행 중)으로 끝나면 실패로 보지 않고 접속을 계속 시도한다', async () => {
    const home = makeBiveHome();
    const command = { ...sourceCommand(home), args: ['-e', ''] };
    await expect(ensureOrchestrator({ biveHome: home, command, timeoutMs: 800 })).rejects.toThrow(
      '오케스트레이터 접속 시간 초과',
    );
  });
});

describe('실행 방식 판단', () => {
  it('BIVE_ORCHESTRATOR_MODE가 있으면 그 값, 없으면 패키징 여부로 고른다', () => {
    expect(resolveOrchestratorMode({}, false)).toBe('source');
    expect(resolveOrchestratorMode({}, true)).toBe('dist');
    expect(resolveOrchestratorMode({ BIVE_ORCHESTRATOR_MODE: 'dist' }, false)).toBe('dist');
    expect(resolveOrchestratorMode({ BIVE_ORCHESTRATOR_MODE: 'source' }, true)).toBe('source');
    expect(() => resolveOrchestratorMode({ BIVE_ORCHESTRATOR_MODE: 'x' }, false)).toThrow();
  });

  it('source는 tsx로 src/cli.ts, dist는 dist/cli.js. 패키징은 ELECTRON_RUN_AS_NODE를 붙인다', () => {
    const base = {
      orchestratorDir: '/o',
      nodePath: '/n',
      biveHome: '/h',
      env: { ELECTRON_RUN_AS_NODE: '1', X: 'y' },
    };
    const source = orchestratorCommand({ ...base, mode: 'source' });
    expect(source.args).toEqual(['--conditions=@bive/source', '--import', 'tsx', '/o/src/cli.ts']);
    expect(source.env).toMatchObject({ BIVE_HOME: '/h', X: 'y' });
    expect(source.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    const dist = orchestratorCommand({ ...base, mode: 'dist', runAsNode: true });
    expect(dist).toMatchObject({ command: '/n', args: ['/o/dist/cli.js'], cwd: '/o' });
    expect(dist.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

describe('OrchestratorLink', () => {
  it('동시 요청은 접속 1번을 함께 기다리고, 연결이 끊기면 다음 요청 때 다시 접속한다', async () => {
    const home = makeBiveHome();
    writeRunFiles(home, { pid: process.pid, token: 'tok' });
    const server = await listenFakeOrchestrator(home, 'tok');
    let connects = 0;
    const link = new OrchestratorLink(async () => {
      connects += 1;
      return ensureOrchestrator({
        biveHome: home,
        command: sourceCommand(home),
        spawn: forbiddenSpawn,
      });
    });
    await Promise.all([link.request('ping'), link.request('ping')]);
    expect(connects).toBe(1);
    expect(link.state).toBe('connected');

    const first = await link.connect();
    first.client.destroy();
    await first.client.closed;
    expect(link.state).toBe('disconnected');
    await expect(link.request('ping')).resolves.toMatchObject({ pong: true });
    expect(connects).toBe(2);
    expect(server.connections).toBe(2);
    link.close();
  });

  it('접속에 실패하면 -32603 오케스트레이터 연결 실패로 거부한다', async () => {
    const logs: string[] = [];
    const link = new OrchestratorLink(
      () => Promise.reject(new Error('/tmp/x/run/token 없음')),
      (m) => logs.push(m),
    );
    const error = await link.request('ping').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PipeRpcError);
    // 응답에는 코드 · 고정 메시지만, 원본 메시지(경로)는 main 로그에만 (ADR-042)
    expect((error as PipeRpcError).toErrorObject()).toEqual({
      code: ErrorCode.InternalError,
      message: '오케스트레이터 연결 실패',
    });
    expect(logs).toEqual(['오케스트레이터 연결 실패: /tmp/x/run/token 없음']);
    expect(link.state).toBe('disconnected');
  });
});
