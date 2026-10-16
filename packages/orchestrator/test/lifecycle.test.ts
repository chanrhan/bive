// 백그라운드 수명 (M0-05 수용 기준 3, PRD 5.1): 진행 중 실행 0개 · 연결 0개가
// BIVE_IDLE_SHUTDOWN_MS(기본 300000) 동안 이어지면 프로세스가 종료된다.
import { existsSync, readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { DEFAULT_IDLE_SHUTDOWN_MS, Lifecycle, parseIdleShutdownMs } from '../src/lifecycle.js';
import { startOrchestrator } from '../src/orchestrator.js';
import { runPaths } from '../src/run-paths.js';
import { connect } from './helpers/client.js';
import { cleanup, makeBiveHome, sleep, spawnCli, waitFor } from './helpers/process.js';

afterEach(async () => {
  vi.useRealTimers();
  await cleanup();
});

describe('BIVE_IDLE_SHUTDOWN_MS 해석', () => {
  it('없거나 비면 기본 300000', () => {
    expect(DEFAULT_IDLE_SHUTDOWN_MS).toBe(300_000);
    expect(parseIdleShutdownMs(undefined)).toBe(300_000);
    expect(parseIdleShutdownMs('  ')).toBe(300_000);
  });

  it('양의 정수만 받는다', () => {
    expect(parseIdleShutdownMs('1500')).toBe(1500);
    expect(parseIdleShutdownMs(' 20 ')).toBe(20);
    for (const bad of ['0', '-1', '1.5', '1e3', 'abc', '99999999999999999999']) {
      expect(parseIdleShutdownMs(bad)).toBeNull();
    }
  });
});

describe('Lifecycle (가짜 시계)', () => {
  const make = (ms = 1000): { lifecycle: Lifecycle; onIdle: Mock<() => void> } => {
    vi.useFakeTimers();
    const onIdle = vi.fn<() => void>();
    const lifecycle = new Lifecycle({ idleShutdownMs: ms, onIdle });
    return { lifecycle, onIdle };
  };

  it('start 전에는 세지 않고, start 뒤 유휴 시간이 지나면 한 번 부른다', () => {
    const { lifecycle, onIdle } = make();
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
    lifecycle.start();
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('연결이 있으면 멈추고, 마지막 연결이 끊긴 때부터 다시 센다', () => {
    const { lifecycle, onIdle } = make();
    lifecycle.start();
    vi.advanceTimersByTime(900);
    lifecycle.connectionOpened();
    lifecycle.connectionOpened();
    expect(lifecycle.idleTimerRunning).toBe(false);
    vi.advanceTimersByTime(10_000);
    lifecycle.connectionClosed();
    vi.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();
    lifecycle.connectionClosed();
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('진행 중 실행이 있으면 연결이 0개여도 종료하지 않는다', () => {
    const { lifecycle, onIdle } = make();
    lifecycle.start();
    const run = lifecycle.beginRun();
    expect(lifecycle.activeRunCount).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();
    run.end();
    run.end();
    expect(lifecycle.activeRunCount).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('stop 뒤에는 부르지 않는다 · 잘못된 값은 거부', () => {
    const { lifecycle, onIdle } = make();
    lifecycle.start();
    lifecycle.stop();
    vi.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();
    expect(() => lifecycle.connectionClosed()).toThrow();
    expect(() => new Lifecycle({ idleShutdownMs: 0, onIdle })).toThrow(RangeError);
  });
});

describe('오케스트레이터 유휴 종료 (실제 소켓)', () => {
  it('진행 중 실행이 끝나고 연결도 없으면 idle로 종료한다', async () => {
    const result = await startOrchestrator({ biveHome: makeBiveHome(), idleShutdownMs: 150 });
    if (result.status !== 'started') throw new Error('기동 실패');
    const { orchestrator } = result;
    const run = orchestrator.runs.beginRun();
    let closedReason: string | null = null;
    void orchestrator.closed.then((reason) => (closedReason = reason));
    await sleep(500);
    expect(closedReason).toBeNull();
    run.end();
    await expect(orchestrator.closed).resolves.toBe('idle');
    expect(existsSync(orchestrator.paths.pipe)).toBe(false);
  });
});

describe('프로세스 유휴 종료 (CLI)', () => {
  it('연결 0개 · 실행 0개가 BIVE_IDLE_SHUTDOWN_MS 동안 이어지면 종료 코드 0으로 끝난다', async () => {
    const home = makeBiveHome();
    const paths = runPaths(home);
    const proc = spawnCli({ BIVE_HOME: home, BIVE_IDLE_SHUTDOWN_MS: '800' });
    await waitFor(() => existsSync(paths.pipe), 15_000, '소켓 생성');
    const readyAt = Date.now();
    const exit = await proc.exited;
    const elapsed = Date.now() - readyAt;
    expect(exit.code).toBe(0);
    // 소켓은 lifecycle.start() 직전에 생기므로 유휴 시간보다 약간 짧을 수 있다
    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(exit.stdout).toContain('오케스트레이터 종료 (idle)');
    expect(existsSync(paths.pipe)).toBe(false);
    expect(existsSync(paths.pid)).toBe(false);
    expect(existsSync(paths.token)).toBe(false);
  }, 30_000);

  it('연결이 열려 있는 동안은 유지되고, 연결이 끊기면 유휴 시간 뒤 종료한다', async () => {
    const home = makeBiveHome();
    const paths = runPaths(home);
    const proc = spawnCli({ BIVE_HOME: home, BIVE_IDLE_SHUTDOWN_MS: '500' });
    await waitFor(() => existsSync(paths.token) && existsSync(paths.pipe), 15_000, '기동');
    const client = await connect(paths.pipe, readFileSync(paths.token, 'utf8'));
    await sleep(1500);
    expect(proc.child.exitCode).toBeNull();
    await expect(client.call('ping')).resolves.toMatchObject({ pong: true });
    await client.close();
    const exit = await proc.exited;
    expect(exit.code).toBe(0);
  }, 30_000);

  it('잘못된 BIVE_IDLE_SHUTDOWN_MS는 종료 코드 2', async () => {
    const home = makeBiveHome();
    const exit = await spawnCli({ BIVE_HOME: home, BIVE_IDLE_SHUTDOWN_MS: 'soon' }).exited;
    expect(exit.code).toBe(2);
    expect(existsSync(runPaths(home).pid)).toBe(false);
  }, 30_000);
});
