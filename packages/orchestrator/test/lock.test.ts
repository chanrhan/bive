// 단일 인스턴스 잠금 (M0-05 수용 기준 4, PRD 5.1 · ADR-027):
// `pnpm --filter @bive/orchestrator start` 두 번째 기동은 즉시 종료 코드 0, 죽은 pid의 잠금은 인수,
// 토큰 파일 권한은 0600.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquirePidLock, isProcessAlive, readPidFile } from '../src/lock.js';
import { runPaths } from '../src/run-paths.js';
import { connect } from './helpers/client.js';
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

describe('acquirePidLock', () => {
  const pidPath = (): string => {
    const dir = path.join(makeBiveHome(), 'run');
    mkdirSync(dir, { recursive: true });
    return path.join(dir, 'orchestrator.pid');
  };

  it('비어 있으면 잡고, release는 자기 pid일 때만 지운다', () => {
    const file = pidPath();
    const result = acquirePidLock(file, { pid: 111, isAlive: () => true });
    expect(result).toMatchObject({ acquired: true, staleTakenOver: false });
    expect(readPidFile(file)).toBe(111);
    expect(existsSync(`${file}.111.tmp`)).toBe(false);
    writeFileSync(file, '222\n');
    if (result.acquired) result.lock.release();
    expect(readPidFile(file)).toBe(222);
  });

  it('살아 있는 다른 pid가 잡고 있으면 실패하고 파일을 건드리지 않는다', () => {
    const file = pidPath();
    writeFileSync(file, '222\n');
    expect(acquirePidLock(file, { pid: 111, isAlive: () => true })).toEqual({
      acquired: false,
      runningPid: 222,
    });
    expect(readPidFile(file)).toBe(222);
  });

  it.each([
    ['죽은 pid', '222\n', 222],
    ['형식이 틀린 내용', 'garbage', null],
    ['빈 파일', '', null],
  ])('%s의 잠금은 인수한다', (_, content, stalePid) => {
    const file = pidPath();
    writeFileSync(file, content);
    const result = acquirePidLock(file, { pid: 111, isAlive: () => false });
    expect(result).toMatchObject({ acquired: true, staleTakenOver: true, stalePid });
    expect(readPidFile(file)).toBe(111);
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
      const client = await connect(paths.pipe, token);
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

      const proc = spawnPnpmStart({ BIVE_HOME: home, BIVE_IDLE_SHUTDOWN_MS: '1500' });
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
      const client = await connect(paths.pipe, token);
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
