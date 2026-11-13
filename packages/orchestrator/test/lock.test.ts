// 단일 인스턴스 잠금 (M0-05 수용 기준 4, PRD 5.1 · ADR-027):
// `pnpm --filter @bive/orchestrator start` 두 번째 기동은 즉시 종료 코드 0, 죽은 pid의 잠금은 인수,
// 토큰 파일 권한은 0600.
// 제한: 기동 테스트는 40초, 잠금 인수 테스트의 유휴 종료는 4초 · 접속은 거부(bind 뒤 listen 전)되면 재시도(부하에서 ECONNREFUSED가 났다, #122).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquirePidLock, isProcessAlive, readPidFile } from '../src/lock.js';
import { runPaths } from '../src/run-paths.js';
import { connectWhenReady } from './helpers/client.js';
import { cleanup, makeBiveHome, spawnCli, spawnPnpmStart, waitFor } from './helpers/process.js';

const unixOnly = process.platform === 'win32' ? it.skip : it;

afterEach(async () => {
  await cleanup();
});

/** 확실히 끝난 프로세스의 pid. */
const deadPid = (): number => {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  const pid = Number(result.stdout);
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  expect(isProcessAlive(pid)).toBe(false);
  return pid;
};

/**
 * 잠금 파일에 적는 지어낸 pid. 실제 프로세스가 가질 수 없는 값이어야 한다(Linux pid 상한 4194304 초과):
 * 111 · 222 같은 작은 수는 VM에서 실제 프로세스의 pid일 수 있어, 정리 단계가 그 프로세스를 죽일 수 있다.
 */
const FAKE_OWN_PID = 4_194_304 + 111;
const FAKE_OTHER_PID = 4_194_304 + 222;

describe('acquirePidLock', () => {
  const pidPath = (): string => {
    const dir = path.join(makeBiveHome(), 'run');
    mkdirSync(dir, { recursive: true });
    return path.join(dir, 'orchestrator.pid');
  };

  it('비어 있으면 잡고, release는 자기 pid일 때만 지운다', () => {
    const file = pidPath();
    const result = acquirePidLock(file, { pid: FAKE_OWN_PID, isAlive: () => true });
    expect(result).toMatchObject({ acquired: true, staleTakenOver: false });
    expect(readPidFile(file)).toBe(FAKE_OWN_PID);
    expect(existsSync(`${file}.${FAKE_OWN_PID}.tmp`)).toBe(false);
    writeFileSync(file, `${FAKE_OTHER_PID}\n`);
    if (result.acquired) result.lock.release();
    expect(readPidFile(file)).toBe(FAKE_OTHER_PID);
  });

  it('살아 있는 다른 pid가 잡고 있으면 실패하고 파일을 건드리지 않는다', () => {
    const file = pidPath();
    writeFileSync(file, `${FAKE_OTHER_PID}\n`);
    expect(acquirePidLock(file, { pid: FAKE_OWN_PID, isAlive: () => true })).toEqual({
      acquired: false,
      runningPid: FAKE_OTHER_PID,
    });
    expect(readPidFile(file)).toBe(FAKE_OTHER_PID);
  });

  it.each([
    ['죽은 pid', `${FAKE_OTHER_PID}\n`, FAKE_OTHER_PID],
    ['형식이 틀린 내용', 'garbage', null],
    ['빈 파일', '', null],
  ])('%s의 잠금은 인수한다', (_, content, stalePid) => {
    const file = pidPath();
    writeFileSync(file, content);
    const result = acquirePidLock(file, { pid: FAKE_OWN_PID, isAlive: () => false });
    expect(result).toMatchObject({ acquired: true, staleTakenOver: true, stalePid });
    expect(readPidFile(file)).toBe(FAKE_OWN_PID);
  });
});

describe('pnpm --filter @bive/orchestrator start', () => {
  unixOnly(
    '두 번째 기동은 즉시 종료 코드 0으로 끝나고 첫 인스턴스 · 토큰(0600)은 그대로다',
    async () => {
      const home = makeBiveHome();
      const paths = runPaths(home);
      const first = spawnCli({ BIVE_HOME: home, BIVE_IDLE_SHUTDOWN_MS: '60000' });
      await waitFor(
        () => existsSync(paths.pipe) && readPidFile(paths.pid) === first.child.pid,
        15_000,
        '첫 인스턴스 기동',
      );
      expect(statSync(paths.token).mode & 0o777).toBe(0o600);
      expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
      const token = readFileSync(paths.token, 'utf8');

      const startedAt = Date.now();
      const second = await spawnPnpmStart({ BIVE_HOME: home }).exited;
      expect(second.code).toBe(0);
      expect(second.stdout).toContain(`오케스트레이터 이미 실행 중 (pid ${first.child.pid})`);
      // 유휴 종료(60초)를 기다리지 않고 바로 끝난다
      expect(Date.now() - startedAt).toBeLessThan(20_000);

      expect(first.child.exitCode).toBeNull();
      expect(readPidFile(paths.pid)).toBe(first.child.pid);
      expect(readFileSync(paths.token, 'utf8')).toBe(token);
      const client = await connectWhenReady(paths.pipe, () => token);
      await expect(client.call('ping')).resolves.toMatchObject({ pong: true });
      await client.close();

      // SIGTERM은 정상 종료: 종료 코드 0, 잠금 · 소켓 · 토큰 정리
      first.child.kill('SIGTERM');
      const exit = await first.exited;
      expect(exit.code).toBe(0);
      expect(exit.stdout).toContain('오케스트레이터 종료 (signal)');
      expect(existsSync(paths.pid)).toBe(false);
      expect(existsSync(paths.pipe)).toBe(false);
      expect(existsSync(paths.token)).toBe(false);
    },
    40_000,
  );

  unixOnly(
    'pid가 죽은 잠금은 인수하고, 남은 소켓 파일을 정리한 뒤 기동한다',
    async () => {
      const home = makeBiveHome();
      const paths = runPaths(home);
      mkdirSync(paths.dir, { recursive: true });
      const stale = deadPid();
      writeFileSync(paths.pid, `${stale}\n`);
      // 비정상 종료가 남긴 소켓 자리
      writeFileSync(paths.pipe, '');
      writeFileSync(paths.token, 'old-token', { mode: 0o644 });

      // 기동 확인과 접속 사이에 테스트가 잠시 멈춰도 유휴 종료가 먼저 오지 않을 만큼 둔다 (#122)
      const proc = spawnPnpmStart({ BIVE_HOME: home, BIVE_IDLE_SHUTDOWN_MS: '4000' });
      await waitFor(
        () => {
          const pid = readPidFile(paths.pid);
          // 잠금을 잡은 뒤 남은 소켓을 지우고 bind하기 전 틈에는 소켓 파일이 없다
          return (
            pid !== null &&
            pid !== stale &&
            existsSync(paths.pipe) &&
            statSync(paths.pipe).isSocket()
          );
        },
        15_000,
        '잠금 인수 · 기동',
      );
      const newPid = readPidFile(paths.pid);
      expect(newPid !== null && isProcessAlive(newPid)).toBe(true);
      expect(statSync(paths.token).mode & 0o777).toBe(0o600);
      const token = readFileSync(paths.token, 'utf8');
      expect(token).not.toBe('old-token');
      const client = await connectWhenReady(paths.pipe, () => token);
      await expect(client.call('ping')).resolves.toMatchObject({ pong: true });
      await client.close();

      // 연결이 끊기면 유휴 종료로 스스로 끝난다
      const exit = await proc.exited;
      expect(exit.code).toBe(0);
      expect(existsSync(paths.pid)).toBe(false);
      expect(existsSync(paths.pipe)).toBe(false);
    },
    40_000,
  );
});

describe('cleanup (테스트 도우미)', () => {
  /** 테스트가 끝나도록 반드시 죽여야 하는, 계속 떠 있는 프로세스. */
  const sleeper = (env: NodeJS.ProcessEnv) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env,
      stdio: 'ignore',
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    return { child, exited };
  };

  unixOnly('잠금 파일의 pid가 이 테스트의 오케스트레이터가 아니면 죽이지 않는다', async () => {
    const home = makeBiveHome();
    const paths = runPaths(home);
    mkdirSync(paths.dir, { recursive: true });
    // 환경 변수 BIVE_HOME이 없는, 테스트와 무관한 프로세스
    const env = { ...process.env };
    delete env.BIVE_HOME;
    const bystander = sleeper(env);
    try {
      writeFileSync(paths.pid, `${bystander.child.pid}\n`);
      await cleanup();
      // 신호를 받았다면 종료가 드러날 시간을 준다
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(bystander.child.exitCode).toBeNull();
      expect(bystander.child.signalCode).toBeNull();
      expect(isProcessAlive(bystander.child.pid ?? -1)).toBe(true);
    } finally {
      bystander.child.kill('SIGKILL');
      await bystander.exited;
    }
  });

  const linuxOnly = process.platform === 'linux' ? it : it.skip;
  linuxOnly('잠금 파일의 pid가 그 BIVE_HOME으로 뜬 프로세스면 죽인다', async () => {
    const home = makeBiveHome();
    const paths = runPaths(home);
    mkdirSync(paths.dir, { recursive: true });
    const leftover = sleeper({ ...process.env, BIVE_HOME: home });
    try {
      writeFileSync(paths.pid, `${leftover.child.pid}\n`);
      await cleanup();
      await leftover.exited;
      expect(leftover.child.signalCode).toBe('SIGKILL');
    } finally {
      leftover.child.kill('SIGKILL');
    }
  });
});
