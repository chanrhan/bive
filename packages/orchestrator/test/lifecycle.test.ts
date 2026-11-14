// 백그라운드 수명 (M0-05 수용 기준 3, PRD 5.1): 진행 중 실행 0개 · 연결 0개가
// BIVE_IDLE_SHUTDOWN_MS(기본 300000) 동안 이어지면 프로세스가 종료된다.
// 제한: CLI 테스트는 30초, 유휴 시간은 3초 · 접속은 거부되면 재시도(부하에서 접속 전 유휴 종료 · listen 전 접속으로 ECONNREFUSED가 났다, #122).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { DEFAULT_IDLE_SHUTDOWN_MS, Lifecycle, parseIdleShutdownMs } from '../src/lifecycle.js';
import { startOrchestrator } from '../src/orchestrator.js';
import { runPaths } from '../src/run-paths.js';
import { connectWhenReady } from './helpers/client.js';
import { copyFixture, human, seedProject, withProject } from './helpers/engine-harness.js';
import { cleanup, makeBiveHome, sleep, spawnCli, spawnScript, waitFor } from './helpers/process.js';

const temps: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await cleanup();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
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

  it('진행 중 작업(규칙 작성 세션)이 있어도 종료하지 않고, 실행 수에는 세지 않는다 (ADR-062)', () => {
    const { lifecycle, onIdle } = make();
    lifecycle.start();
    const task = lifecycle.beginTask();
    expect(lifecycle.activeTaskCount).toBe(1);
    expect(lifecycle.activeRunCount).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();
    task.end();
    task.end();
    expect(lifecycle.activeTaskCount).toBe(0);
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
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

/**
 * CLI 테스트의 유휴 시간. 소켓이 생긴 걸 확인하고 접속하기까지 테스트가 부하로 잠시 멈춰도
 * 그 사이에 유휴 종료가 오지 않을 만큼 둔다 (#122).
 */
const CLI_IDLE_MS = 3000;
/** 소켓 확인이 늦어질 수 있는 폭. 유휴 종료까지 걸린 시간은 CLI_IDLE_MS - 이 값 이상이어야 한다 */
const READY_DETECT_SLACK_MS = 1500;

describe('프로세스 유휴 종료 (CLI)', () => {
  it('연결 0개 · 실행 0개가 BIVE_IDLE_SHUTDOWN_MS 동안 이어지면 종료 코드 0으로 끝난다', async () => {
    const home = makeBiveHome();
    const paths = runPaths(home);
    const proc = spawnCli({ BIVE_HOME: home, BIVE_IDLE_SHUTDOWN_MS: String(CLI_IDLE_MS) });
    await waitFor(() => existsSync(paths.pipe), 15_000, '소켓 생성');
    const readyAt = Date.now();
    const exit = await proc.exited;
    const elapsed = Date.now() - readyAt;
    expect(exit.code).toBe(0);
    // 소켓은 lifecycle.start() 직전에 생기고, 부하에서는 테스트가 소켓을 늦게 볼 수 있어 유휴 시간보다 짧을 수 있다
    expect(elapsed).toBeGreaterThanOrEqual(CLI_IDLE_MS - READY_DETECT_SLACK_MS);
    expect(exit.stdout).toContain('오케스트레이터 종료 (idle)');
    expect(existsSync(paths.pipe)).toBe(false);
    expect(existsSync(paths.pid)).toBe(false);
    expect(existsSync(paths.token)).toBe(false);
  }, 30_000);

  it('연결이 열려 있는 동안은 유지되고, 연결이 끊기면 유휴 시간 뒤 종료한다', async () => {
    const home = makeBiveHome();
    const paths = runPaths(home);
    const proc = spawnCli({ BIVE_HOME: home, BIVE_IDLE_SHUTDOWN_MS: String(CLI_IDLE_MS) });
    await waitFor(() => existsSync(paths.token) && existsSync(paths.pipe), 15_000, '기동');
    const client = await connectWhenReady(paths.pipe, () => readFileSync(paths.token, 'utf8'));
    // 유휴 시간보다 길게 기다려도 연결이 있으므로 살아 있다
    await sleep(CLI_IDLE_MS + 1000);
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

describe('진행 중 실행이 있는 동안 유휴 종료하지 않음 (M1-20, 실제 프로세스 · run.create)', () => {
  /** 짧은 유휴 시간: 실행이 멈춰 있는 동안 이 시간의 몇 배를 기다린다 */
  const IDLE_MS = 1500;

  it('연결 0개여도 실행이 끝날 때까지 살아 있고, 실행이 merged로 끝난 뒤 유휴 시간이 지나면 idle로 종료한다', async () => {
    const biveHome = makeBiveHome();
    const repo = copyFixture(temps);
    const { project, rule } = seedProject(biveHome, repo);
    const paths = runPaths(biveHome);
    const pause = path.join(biveHome, 'run', 'pause');
    // 시험용 단계 실행기 · 시나리오 regress-pause: 둘째 구현 세션이 pause 파일이 지워질 때까지 기다린다
    const proc = spawnScript('test/helpers/engine-orchestrator.ts', {
      BIVE_HOME: biveHome,
      BIVE_IDLE_SHUTDOWN_MS: String(IDLE_MS),
      BIVE_SCENARIO: 'regress-pause',
    });
    await waitFor(() => proc.stdout.includes('오케스트레이터 기동'), 30_000, '오케스트레이터 기동');
    const client = await connectWhenReady(paths.pipe, () => readFileSync(paths.token, 'utf8'));
    const { run } = await client.call('run.create', {
      projectId: project.id,
      ruleIds: [rule.id],
      author: human,
    });
    await waitFor(() => existsSync(pause), 30_000, '구현 세션 대기 파일');
    await client.close();

    // 연결 0개 · 진행 중 실행 1개: 유휴 시간의 3배를 기다려도 살아 있다
    await sleep(IDLE_MS * 3);
    expect(proc.child.exitCode).toBeNull();
    expect(proc.stdout).not.toContain('오케스트레이터 종료');
    const runStatus = (): string | undefined =>
      withProject(biveHome, project.id, (store) => store.runs.get(run.id)?.status);
    expect(runStatus()).toBe('running');

    // 실행이 끝나면(연결 0개 그대로) 유휴 시간 뒤 스스로 끝난다
    rmSync(pause);
    // (시험 진입점은 종료 이유를 찍지 않는다. 신호를 보내지 않았으므로 종료 코드 0은 유휴 종료다)
    const exit = await proc.exited;
    expect(exit.code).toBe(0);
    expect(existsSync(paths.pid)).toBe(false);
    expect(runStatus()).toBe('merged');
  }, 60_000);
});
