// 계약 검사 도구의 자식 프로세스 (M3-47 #292, ADR-132 ②).
// - 실행 파일은 오케스트레이터 자신의 Node(`process.execPath`), 진입 파일은 오케스트레이터 패키지가 가진 도구다(대상 프로젝트의
//   `node_modules`가 아니다). 셸 없이 인자 배열로 띄운다
// - 작업 폴더는 대상 프로젝트 밖의 빈 임시 폴더다(도구가 작업 폴더에서 설정 파일 · 플러그인을 찾는다: `@redocly/cli`는
//   `redocly.yaml`의 플러그인 JS를 실행한다). 넘기는 문서는 그 폴더의 계약 사본 하나뿐이다
// - 환경 변수는 부모 값을 하나도 넘기지 않는다({@link toolEnv}): BIVE가 정한 고정 값만이다. 프록시 환경 변수도 넘기지 않는다
// - 시간 제한 · 출력 상한 · 중단 신호. 넘으면 프로세스 그룹을 끝낸다
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { signalTree, stopProcess } from '../judge/process.js';

const require = createRequire(import.meta.url);

const packageDir = (name: string): string => path.dirname(require.resolve(`${name}/package.json`));

/** `@redocly/cli`의 진입 파일 (오케스트레이터 패키지의 의존성). */
export const REDOCLY_ENTRY = path.join(packageDir('@redocly/cli'), 'bin', 'cli.js');

/** `@stoplight/prism-cli`의 진입 파일 (오케스트레이터 패키지의 의존성). */
export const PRISM_ENTRY = path.join(packageDir('@stoplight/prism-cli'), 'dist', 'index.js');

/**
 * 도구 자식 프로세스의 환경 변수: 부모 값을 넘기지 않고 고정 값만 둔다.
 * - `HOME`: 도구 임시 폴더(도구가 홈 폴더에 알림 · 캐시 파일을 쓴다: 사용자 홈에 남기지 않는다)
 * - 사용 기록 · 갱신 알림 끔(`REDOCLY_TELEMETRY` · `REDOCLY_SUPPRESS_UPDATE_NOTICE` · `DO_NOT_TRACK`), 색 끔(출력 형식 확인)
 * - 부모가 Electron 실행 파일 위의 Node로 돌 때만 `ELECTRON_RUN_AS_NODE=1`(없으면 같은 실행 파일이 Electron 앱으로 뜬다)
 */
export const toolEnv = (
  home: string,
  versions: NodeJS.ProcessVersions = process.versions,
): Record<string, string> => ({
  HOME: home,
  REDOCLY_TELEMETRY: 'off',
  REDOCLY_SUPPRESS_UPDATE_NOTICE: 'true',
  DO_NOT_TRACK: '1',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  ...(typeof versions.electron === 'string' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
});

/** 도구의 빈 작업 폴더 (대상 프로젝트 밖, 시스템 임시 폴더 아래). 쓰고 나면 {@link removeToolDir}. */
export const createToolDir = (tempDir: string = os.tmpdir()): string =>
  mkdtempSync(path.join(tempDir, 'bive-contract-'));

export const removeToolDir = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true });
};

/** 도구를 끝까지 못 돌림 (판정하지 못한 것이다: 통과로 읽지 않는다). */
export class ContractToolError extends Error {
  override readonly name = 'ContractToolError';
  constructor(
    readonly code:
      | 'spawn_failed'
      | 'timeout'
      | 'output_too_large'
      | 'unexpected_exit'
      | 'output_invalid'
      | 'start_failed'
      | 'replay_failed',
    message: string,
  ) {
    super(message);
  }
}

export interface ToolRunOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal: AbortSignal;
}

export interface ToolRunResult {
  readonly code: number | null;
  readonly stdout: string;
}

/** 도구 프로세스를 띄운다 (새 프로세스 그룹, 셸 없음, 표준 입력 없음). */
export const spawnTool = (
  entry: string,
  args: readonly string[],
  options: Pick<ToolRunOptions, 'cwd' | 'env'>,
): ChildProcess =>
  spawn(process.execPath, [entry, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

/**
 * 도구를 끝까지 돌리고 표준 출력을 모은다. 시간 초과 · 출력 상한 초과 · 띄우지 못함은 {@link ContractToolError}, 중단 신호면 신호의
 * 사유로 던진다(도구를 끝낸 뒤). 종료 코드의 해석은 호출자가 한다.
 */
export const runTool = async (
  entry: string,
  args: readonly string[],
  options: ToolRunOptions,
): Promise<ToolRunResult> => {
  options.signal.throwIfAborted();
  const child = spawnTool(entry, args, options);
  const chunks: Buffer[] = [];
  let size = 0;
  let failure: ContractToolError | null = null;
  const fail = (error: ContractToolError): void => {
    if (failure !== null) return;
    failure = error;
    signalTree(child, 'SIGKILL');
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > options.maxOutputBytes) {
      fail(new ContractToolError('output_too_large', '도구 출력이 상한을 넘었습니다'));
      return;
    }
    chunks.push(chunk);
  });
  // 표준 오류는 읽어 버린다 (진행 글 · 경고. 판정 근거가 아니다)
  child.stderr?.resume();
  const timer = setTimeout(
    () => fail(new ContractToolError('timeout', '도구가 제한 시간 안에 끝나지 않았습니다')),
    options.timeoutMs,
  );
  const onAbort = (): void => {
    signalTree(child, 'SIGKILL');
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', (error) =>
        reject(new ContractToolError('spawn_failed', `도구를 띄우지 못했습니다: ${error.message}`)),
      );
      child.once('close', (exitCode) => resolve(exitCode));
    });
    options.signal.throwIfAborted();
    if (failure !== null) throw failure;
    return { code, stdout: Buffer.concat(chunks).toString('utf8') };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
    // 정상 종료여도 그룹에 남은 하위 프로세스를 정리한다
    await stopProcess(child, 1_000);
  }
};
