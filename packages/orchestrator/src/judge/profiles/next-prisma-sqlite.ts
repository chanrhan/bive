// 스택 프로필 `next-prisma-sqlite` (ADR-026).
// 임시 SQLite 파일 → prisma migrate deploy → next build → next start(127.0.0.1, 빈 포트) → HTTP 응답 대기.
// next dev는 쓰지 않는다. 명령은 워크트리의 node_modules/.bin만 쓰고 셸 없이 실행한다.
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type Deadline,
  describeExit,
  freePort,
  JudgeTimeoutError,
  runCommand,
  startProcess,
  stopProcess,
} from '../process.js';
import {
  type ProfileContext,
  ProfileError,
  type ProfileStep,
  type StackProfile,
  type StartedServer,
} from './types.js';

/** 준비 확인 요청 1회의 제한 시간. */
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_INTERVAL_MS = 250;

const binPath = (worktreeDir: string, name: string): string =>
  path.join(worktreeDir, 'node_modules', '.bin', name);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 서버가 HTTP로 응답할 때까지 기다린다. 응답 코드는 따지지 않는다(응답 = 기동 완료). */
const waitForHttp = async (
  url: string,
  server: ChildProcess,
  deadline: Deadline,
): Promise<void> => {
  for (;;) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new ProfileError(
        'start',
        `next start 조기 종료 (${server.signalCode ?? String(server.exitCode)})`,
      );
    }
    if (deadline.expired()) throw new JudgeTimeoutError('start');
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(PROBE_TIMEOUT_MS, Math.max(1, deadline.remaining()))),
        redirect: 'manual',
      });
      await res.body?.cancel();
      return;
    } catch {
      await sleep(Math.min(PROBE_INTERVAL_MS, deadline.remaining()));
    }
  }
};

const runStep = async (
  ctx: ProfileContext,
  step: ProfileStep,
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> => {
  const cmd = binPath(ctx.worktreeDir, bin);
  if (!existsSync(cmd)) throw new ProfileError(step, `실행 파일 없음: ${cmd}`);
  const result = await runCommand(cmd, args, {
    cwd: ctx.worktreeDir,
    env,
    stdoutFile: ctx.profileLog,
    timeoutMs: ctx.deadline.remaining(),
  });
  ctx.onStep(step, result.durationMs);
  if (result.timedOut) throw new JudgeTimeoutError(step);
  if (result.code !== 0) {
    throw new ProfileError(step, `${bin} ${args.join(' ')} ${describeExit(result)}`);
  }
};

export const nextPrismaSqliteProfile: StackProfile = {
  name: 'next-prisma-sqlite',

  async start(ctx: ProfileContext): Promise<StartedServer> {
    const dbDir = await mkdtemp(path.join(tmpdir(), 'bive-judge-db-'));
    const databasePath = path.join(dbDir, 'judge.db');
    const env: NodeJS.ProcessEnv = {
      ...ctx.env,
      DATABASE_URL: `file:${databasePath}`,
      NEXT_TELEMETRY_DISABLED: '1',
      CHECKPOINT_DISABLE: '1',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
    };
    const prodEnv: NodeJS.ProcessEnv = { ...env, NODE_ENV: 'production' };

    let server: ChildProcess | undefined;
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        if (server !== undefined) await stopProcess(server);
        await rm(dbDir, { recursive: true, force: true });
      })();
      return stopping;
    };

    try {
      await runStep(ctx, 'migrate', 'prisma', ['migrate', 'deploy'], env);
      await runStep(ctx, 'build', 'next', ['build'], prodEnv);

      const startedAt = Date.now();
      const nextBin = binPath(ctx.worktreeDir, 'next');
      const port = await freePort();
      const baseUrl = `http://127.0.0.1:${String(port)}`;
      server = startProcess(nextBin, ['start', '-H', '127.0.0.1', '-p', String(port)], {
        cwd: ctx.worktreeDir,
        env: prodEnv,
        stdoutFile: ctx.serverLog,
      });
      const spawnFailed = new Promise<never>((_, reject) => {
        server?.once('error', (err) => reject(new ProfileError('start', err.message)));
      });
      // 준비 확인이 먼저 끝난 뒤의 거부가 처리되지 않은 거부로 남지 않게 한다
      spawnFailed.catch(() => undefined);
      await Promise.race([waitForHttp(baseUrl, server, ctx.deadline), spawnFailed]);
      ctx.onStep('start', Date.now() - startedAt);

      return { baseUrl, pid: server.pid ?? null, databasePath, stop };
    } catch (err) {
      await stop();
      throw err;
    }
  },
};
