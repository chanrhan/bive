// 앱 프로세스 도우미 (M1-20, ADR-074): `packages/app/test/helpers/app-process.ts`를 자식 프로세스로 띄우고
// 표준 입력 · 출력으로 파이프 RPC를 보낸다. 그 프로세스는 앱 main과 같은 코드 경로로 오케스트레이터를 분리 프로세스로
// 띄우거나 붙는다. `exit()`는 표준 입력을 닫아 앱 종료(`will-quit` → `session.dispose()`)를 흉내 낸다.
// 정리는 이 도우미가 띄운 자식 핸들만 죽인다(오케스트레이터는 `test/helpers/process.ts`의 cleanup이 맡는다).
import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

import type { MethodName, MethodParams, MethodResult } from '@bive/shared';

import { ORCHESTRATOR_DIR } from '../../test/helpers/process.js';

const APP_DIR = path.resolve(ORCHESTRATOR_DIR, '../app');
const APP_SCRIPT = 'test/helpers/app-process.ts';

/** 앱 프로세스 기동 · 접속 대기 (tsx 변환 · 오케스트레이터 기동 포함) */
const READY_TIMEOUT_MS = 60_000;

const children = new Set<ChildProcess>();

export interface AppReady {
  appPid: number;
  launched: boolean;
  spawnedPid: number | null;
  /** 접속 직후 잠금 파일의 오케스트레이터 pid */
  orchestratorPid: number | null;
}

export interface AppProcess {
  readonly ready: AppReady;
  readonly child: ChildProcess;
  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  /** 앱 종료: 표준 입력을 닫고 프로세스가 끝날 때까지 기다린다. 종료 코드를 돌려준다. */
  exit(): Promise<number | null>;
}

interface Reply {
  id?: number;
  event?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** 앱 프로세스를 띄우고 오케스트레이터 접속(ready)까지 기다린다. */
export const startApp = async (env: Record<string, string>): Promise<AppProcess> => {
  const child = spawn(
    process.execPath,
    ['--conditions=@bive/source', '--import', 'tsx', APP_SCRIPT],
    { cwd: APP_DIR, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  children.add(child);
  let stdout = '';
  let stderr = '';
  let buffer = '';
  const pending = new Map<number, (reply: Reply) => void>();
  let onReady: ((ready: AppReady) => void) | null = null;
  const closed = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      children.delete(child);
      resolve(code);
    });
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const reply = JSON.parse(line) as Reply & Partial<AppReady>;
      if (reply.event === 'ready') onReady?.(reply as AppReady);
      else if (reply.id !== undefined) {
        pending.get(reply.id)?.(reply);
        pending.delete(reply.id);
      }
    }
  });

  const ready = await new Promise<AppReady>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`시간 초과: 앱 프로세스 접속\n${stdout}\n${stderr}`)),
      READY_TIMEOUT_MS,
    );
    onReady = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    void closed.then((code) => {
      clearTimeout(timer);
      reject(new Error(`앱 프로세스가 접속 전에 끝남 (코드 ${String(code)})\n${stderr}`));
    });
  });

  let nextId = 1;
  return {
    ready,
    child,
    call: (method, params) => {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, (reply) => {
          if (reply.error !== undefined) {
            reject(new Error(`${method}: ${String(reply.error.code)} ${reply.error.message}`));
          } else {
            resolve(reply.result as never);
          }
        });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    exit: () => {
      child.stdin.end();
      return closed;
    },
  };
};

/** 이 도우미가 띄운 앱 프로세스 중 남은 것을 죽이고 끝날 때까지 기다린다. */
export const cleanupApps = async (): Promise<void> => {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('close', () => resolve());
          child.kill('SIGKILL');
        }),
    ),
  );
};
