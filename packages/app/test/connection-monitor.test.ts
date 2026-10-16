// 사이드바 연결 상태의 main 쪽 (이슈 #13 수용 기준 3, ADR-045):
// 1초 간격 system.status → system.connection 알림, 끊기면 오케스트레이터를 다시 띄우지 않고 재접속.
import { type ChildProcess, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import type { ConnectionEventParams } from '../src/common/bridge.js';
import {
  CONNECTION_POLL_INTERVAL_MS,
  ConnectionMonitor,
  type ConnectionMonitorTarget,
} from '../src/main/connection-monitor.js';
import {
  ensureOrchestrator,
  NOT_RUNNING_MESSAGE,
  type OrchestratorCommand,
  type SpawnFn,
} from '../src/main/orchestrator-launch.js';
import { type ConnectionState, OrchestratorLink } from '../src/main/session.js';
import {
  cleanup,
  listenFakeOrchestrator,
  makeBiveHome,
  sleep,
  waitFor,
  writeRunFiles,
} from './helpers/orchestrator.js';

const STATUS = { version: '1.0.0', uptimeMs: 10, connections: 1, runsInProgress: 0 };

const monitors: ConnectionMonitor[] = [];
const links: OrchestratorLink[] = [];

afterEach(async () => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  for (const link of links.splice(0)) link.close();
  await cleanup();
});

/** 요청 결과를 테스트가 정하는 가짜 대상. */
type FakeTarget = ConnectionMonitorTarget & {
  respond: (fn: () => Promise<unknown>) => void;
  setState: (state: ConnectionState) => void;
  requests: string[];
  drops: number;
};

const fakeTarget = (): FakeTarget => {
  let handler: () => Promise<unknown> = () => Promise.resolve(STATUS);
  const listeners = new Set<(state: ConnectionState) => void>();
  const requests: string[] = [];
  const target: FakeTarget = {
    requests,
    drops: 0,
    dropConnection: () => {
      target.drops += 1;
    },
    request: (method) => {
      requests.push(method);
      return handler();
    },
    onStateChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    respond: (fn) => {
      handler = fn;
    },
    setState: (state: ConnectionState) => {
      for (const listener of listeners) listener(state);
    },
  };
  return target;
};

const start = (
  target: ConnectionMonitorTarget,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): { monitor: ConnectionMonitor; events: ConnectionEventParams[] } => {
  const events: ConnectionEventParams[] = [];
  const monitor = new ConnectionMonitor({
    target,
    emit: (params) => events.push(params),
    intervalMs: options.intervalMs ?? 20,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  monitors.push(monitor);
  monitor.start();
  return { monitor, events };
};

/** 실행 중이 아닌 pid (끝난 자식 프로세스의 pid). */
const deadPid = (): number => {
  const result = spawnSync(process.execPath, ['-e', '']);
  if (result.pid === undefined) throw new Error('pid 없음');
  return result.pid;
};

describe('ConnectionMonitor', () => {
  it('기본 간격은 1초다', () => {
    expect(CONNECTION_POLL_INTERVAL_MS).toBe(1000);
  });

  it('바로 system.status를 부르고 결과를 연결됨 알림으로 보내며, 간격마다 반복한다', async () => {
    const target = fakeTarget();
    const { monitor, events } = start(target);
    await waitFor(() => events.length >= 3, 2_000, '알림 3건');
    expect(events[0]).toEqual({ state: 'connected', status: STATUS });
    expect(new Set(target.requests)).toEqual(new Set(['system.status']));
    expect(monitor.last).toEqual({ state: 'connected', status: STATUS });
  });

  it('요청이 실패하면 연결 끊김, 다시 성공하면 연결됨', async () => {
    const target = fakeTarget();
    target.respond(() => Promise.reject(new Error('연결 실패')));
    const { events } = start(target);
    await waitFor(() => events.length >= 1, 2_000, '첫 알림');
    expect(events[0]).toEqual({ state: 'disconnected' });
    target.respond(() => Promise.resolve(STATUS));
    await waitFor(() => events.at(-1)?.state === 'connected', 2_000, '재연결');
  });

  it('연결됨 상태에서 링크가 끊기면 다음 주기를 기다리지 않고 바로 끊김을 보낸다', async () => {
    const target = fakeTarget();
    const { events } = start(target, { intervalMs: 60_000 });
    await waitFor(() => events.length === 1, 2_000, '첫 알림');
    target.setState('disconnected');
    expect(events).toEqual([{ state: 'connected', status: STATUS }, { state: 'disconnected' }]);
    // 이미 끊김이면 같은 알림을 또 보내지 않는다
    target.setState('disconnected');
    expect(events).toHaveLength(2);
  });

  it('응답이 없으면 대기 한도 뒤 끊김으로 보고 연결을 버린 뒤 다음 주기로 넘어간다', async () => {
    const target = fakeTarget();
    target.respond(() => new Promise(() => {}));
    const { events } = start(target, { intervalMs: 10, timeoutMs: 50 });
    await waitFor(() => events.length >= 2, 2_000, '알림 2건');
    expect(events.every((e) => e.state === 'disconnected')).toBe(true);
    // 대기 한도를 넘길 때마다 지금 연결을 버려 대기 요청이 쌓이지 않게 한다
    expect(target.drops).toBeGreaterThanOrEqual(2);
  });

  it('stop 뒤에는 알림을 보내지 않는다', async () => {
    const target = fakeTarget();
    const { monitor, events } = start(target);
    await waitFor(() => events.length >= 1, 2_000, '첫 알림');
    monitor.stop();
    const count = events.length;
    await sleep(100);
    target.setState('disconnected');
    expect(events).toHaveLength(count);
  });
});

describe('끊긴 뒤 재접속: 오케스트레이터를 다시 띄우지 않는다', () => {
  const command: OrchestratorCommand = { command: 'node', args: [], cwd: '/', env: {} };

  it('ensureOrchestrator(launch: false)는 실행 중인 인스턴스가 없으면 띄우지 않고 바로 실패한다', async () => {
    const home = makeBiveHome();
    let spawned = 0;
    const spawn: SpawnFn = () => {
      spawned += 1;
      throw new Error('기동하면 안 됨');
    };
    await expect(
      ensureOrchestrator({ biveHome: home, command, spawn, launch: false }),
    ).rejects.toThrow(NOT_RUNNING_MESSAGE);
    writeRunFiles(home, { pid: deadPid(), token: 'tok' });
    await expect(
      ensureOrchestrator({ biveHome: home, command, spawn, launch: false }),
    ).rejects.toThrow(NOT_RUNNING_MESSAGE);
    expect(spawned).toBe(0);
  });

  it('첫 기동이 실패하면 이후 감시 주기는 다시 띄우지 않는다 (기동은 첫 접속 시도 1회만)', async () => {
    const home = makeBiveHome();
    let spawned = 0;
    // 기동 직후 종료 코드 1로 끝나는 가짜 자식
    const spawn: SpawnFn = () => {
      spawned += 1;
      const child = Object.assign(new EventEmitter(), {
        pid: 999_999,
        unref: () => undefined,
      }) as unknown as ChildProcess;
      setImmediate(() => child.emit('exit', 1, null));
      return child;
    };
    const launches: boolean[] = [];
    const link = new OrchestratorLink(
      ({ launch }) => {
        launches.push(launch);
        return ensureOrchestrator({ biveHome: home, command, spawn, launch, timeoutMs: 300 });
      },
      () => undefined,
    );
    links.push(link);
    expect(link.launchAllowed).toBe(true);
    const { events } = start(link, { intervalMs: 50 });

    await waitFor(() => launches.length >= 5, 5_000, '감시 5회');
    expect(spawned).toBe(1);
    expect(launches[0]).toBe(true);
    expect(launches.slice(1).every((launch) => !launch)).toBe(true);
    expect(link.launchAllowed).toBe(false);
    expect(events.every((e) => e.state === 'disconnected')).toBe(true);
  });

  it('연결됨 → 오케스트레이터 사라짐 → 연결 끊김(기동 없음) → 다시 뜨면 1초 간격 재접속으로 연결됨', async () => {
    const home = makeBiveHome();
    writeRunFiles(home, { pid: process.pid, token: 'tok' });
    let server = await listenFakeOrchestrator(home, 'tok');

    const launches: boolean[] = [];
    let spawned = 0;
    const spawn: SpawnFn = () => {
      spawned += 1;
      throw new Error('기동하면 안 됨');
    };
    const link = new OrchestratorLink(
      ({ launch }) => {
        launches.push(launch);
        return ensureOrchestrator({ biveHome: home, command, spawn, launch, timeoutMs: 300 });
      },
      () => undefined,
    );
    links.push(link);
    const { events } = start(link, { intervalMs: CONNECTION_POLL_INTERVAL_MS });

    await waitFor(() => events.at(-1)?.state === 'connected', 5_000, '연결됨');
    expect(events.at(-1)).toMatchObject({ state: 'connected', status: { version: 'fake' } });
    expect(link.launchAllowed).toBe(false);

    // 오케스트레이터가 죽음: 소켓 연결이 끊기고 잠금 pid도 죽은 pid
    writeRunFiles(home, { pid: deadPid() });
    await server.close();
    const lostAt = Date.now();
    await waitFor(() => events.at(-1)?.state === 'disconnected', 2_000, '연결 끊김');
    // 끊김은 주기를 기다리지 않고 바로 보낸다
    expect(Date.now() - lostAt).toBeLessThan(CONNECTION_POLL_INTERVAL_MS);

    // 끊긴 동안 1초 간격으로 재접속을 시도하되 띄우지 않는다
    const attemptsBefore = launches.length;
    await sleep(2_300);
    const attempts = launches.length - attemptsBefore;
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(attempts).toBeLessThanOrEqual(3);
    expect(spawned).toBe(0);
    expect(launches.slice(1).every((launch) => !launch)).toBe(true);
    expect(events.at(-1)).toEqual({ state: 'disconnected' });

    // 다른 쪽(사용자 · 다음 앱 실행)이 다시 띄우면 붙는다
    writeRunFiles(home, { pid: process.pid, token: 'tok' });
    server = await listenFakeOrchestrator(home, 'tok');
    await waitFor(() => events.at(-1)?.state === 'connected', 3_000, '재연결');
    expect(spawned).toBe(0);
    expect(server.connections).toBe(1);
  }, 20_000);
});
