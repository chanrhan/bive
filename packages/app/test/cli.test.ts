// 개발용 CLI (이슈 #9 수용 기준 3).
import { spawnSync } from 'node:child_process';

import { ErrorCode, rpcError } from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  isReadOnlyMethod,
  runCli,
  type CliDeps,
} from '../src/cli-core.js';
import { PipeRpcError } from '../src/main/pipe-client.js';
import { readPidFile } from '../src/main/orchestrator-launch.js';
import { appRunPaths } from '../src/main/run-paths.js';
import { cleanup, makeBiveHome, REPO_ROOT } from './helpers/orchestrator.js';

afterEach(cleanup);

const fakeDeps = (
  request: (method: string, params?: unknown) => Promise<unknown> = () =>
    Promise.resolve({ pong: true }),
): CliDeps & { out: string[]; err: string[]; connects: number; requests: unknown[][] } => {
  const deps = {
    out: [] as string[],
    err: [] as string[],
    connects: 0,
    requests: [] as unknown[][],
    stdout: (t: string) => deps.out.push(t),
    stderr: (t: string) => deps.err.push(t),
    connect: () => {
      deps.connects += 1;
      return Promise.resolve({
        request: (method: string, params?: unknown) => {
          deps.requests.push([method, params]);
          return request(method, params);
        },
        close: () => Promise.resolve(),
      });
    },
  };
  return deps;
};

describe('cli 본체', () => {
  it('ping → 표준 출력 pong, 종료 0', async () => {
    const deps = fakeDeps();
    expect(await runCli(['ping'], deps)).toBe(EXIT_OK);
    expect(deps.out).toEqual(['pong']);
    expect(deps.requests).toEqual([['ping', undefined]]);
  });

  it('rpc는 .list · .get · .status · .summary로 끝나는 메서드만 허용한다', () => {
    for (const ok of ['project.list', 'rule.get', 'system.status', 'verification.summary']) {
      expect(isReadOnlyMethod(ok), ok).toBe(true);
    }
    for (const no of [
      'ping',
      'proposal.approve',
      'run.create',
      'system.hello',
      '.list',
      'listing',
      'project.listx',
    ]) {
      expect(isReadOnlyMethod(no), no).toBe(false);
    }
  });

  it('허용되지 않는 메서드는 접속하지 않고 표준 오류 메시지 + 종료 2', async () => {
    for (const method of ['proposal.approve', 'run.create', 'system.hello', 'ping']) {
      const deps = fakeDeps();
      expect(await runCli(['rpc', method], deps)).toBe(EXIT_USAGE);
      expect(deps.connects).toBe(0);
      expect(deps.err[0]).toContain(`허용되지 않는 메서드: ${method}`);
      expect(deps.out).toEqual([]);
    }
  });

  it('rpc 결과를 JSON으로 출력하고, JSON 인자를 파라미터로 넘긴다', async () => {
    const deps = fakeDeps(() => Promise.resolve({ projects: [] }));
    expect(await runCli(['rpc', 'project.get', '{"projectId":"p1"}'], deps)).toBe(EXIT_OK);
    expect(deps.requests).toEqual([['project.get', { projectId: 'p1' }]]);
    expect(JSON.parse(deps.out[0] ?? '')).toEqual({ projects: [] });
  });

  it('JSON 해석 실패 · 사용법 위반은 종료 2, 원격 오류는 종료 1', async () => {
    expect(await runCli(['rpc', 'project.get', '{bad'], fakeDeps())).toBe(EXIT_USAGE);
    expect(await runCli([], fakeDeps())).toBe(EXIT_USAGE);
    expect(await runCli(['ping', 'extra'], fakeDeps())).toBe(EXIT_USAGE);
    expect(await runCli(['rpc'], fakeDeps())).toBe(EXIT_USAGE);
    const deps = fakeDeps(() =>
      Promise.reject(
        new PipeRpcError(rpcError(ErrorCode.MethodNotFound, '없는 메서드: system.status')),
      ),
    );
    expect(await runCli(['rpc', 'system.status'], deps)).toBe(EXIT_ERROR);
    expect(deps.err).toEqual(['오류 -32601: 없는 메서드: system.status']);
  });
});

describe('pnpm --filter @bive/app cli (실제 오케스트레이터)', () => {
  const runPnpmCli = (home: string, args: string[]) =>
    spawnSync('pnpm', ['--silent', '--filter', '@bive/app', 'cli', ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, BIVE_HOME: home, BIVE_IDLE_SHUTDOWN_MS: '60000' },
      shell: process.platform === 'win32',
      timeout: 60_000,
    });

  it('cli ping → 오케스트레이터를 기동해 표준 출력 pong, 종료 0', () => {
    const home = makeBiveHome();
    const result = runPnpmCli(home, ['ping']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('pong');
    // CLI가 띄운 오케스트레이터는 CLI가 끝나도 남는다 (cleanup이 정리)
    expect(readPidFile(appRunPaths(home).orchestratorPid)).not.toBeNull();
  });

  it('cli rpc <허용되지 않는 메서드> → 종료 2', () => {
    const home = makeBiveHome();
    const result = runPnpmCli(home, ['rpc', 'proposal.approve', '{}']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('허용되지 않는 메서드');
    // 접속 전에 거부하므로 오케스트레이터를 띄우지 않는다
    expect(readPidFile(appRunPaths(home).orchestratorPid)).toBeNull();
  });
});
