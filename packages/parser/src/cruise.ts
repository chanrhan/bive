// dependency-cruiser 실행 (M3-02 #47, ADR-125 ④). 공식 API `cruise`를 파서의 실행기(runner/cruise.mjs)로 자식 프로세스에서 부른다.
// - 실행 파일: 이 프로세스의 Node(`process.execPath`) + 파서 패키지 안의 실행기. dependency-cruiser는 파서 자신의 의존성에서 찾는다
//   (대상 프로젝트의 node_modules가 아니다)
// - 인자는 배열, 입력은 표준 입력의 JSON. 작업 디렉터리는 실행기 폴더(프로젝트 밖), 환경 변수는 비운다(`NODE_OPTIONS` ·
//   `NODE_PATH` 등이 넘어가지 않음)
// - 시간 제한 · 출력 크기 상한. 시간 초과 · 깨진 JSON · 0이 아닌 종료는 오류다("위반 0건"으로 읽히지 않는다)
// - 대상 프로젝트의 설정 파일(.dependency-cruiser.* · webpack · babel)을 읽는 옵션을 넘기지 않는다. tsconfig는 경로 별칭을 풀려고
//   넘기고, 데이터(JSON)로만 읽힌다
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { ParserError } from './errors.js';
import { PARSER_LIMITS } from './limits.js';
import type { CruiseRuleSet } from './rules.js';

/** 실행기 경로 (src · dist 어느 쪽에서 불러도 패키지 루트의 runner/) */
export const RUNNER_PATH = fileURLToPath(new URL('../runner/cruise.mjs', import.meta.url));

/** 읽는 부분만의 출력 모양. 나머지 칸은 무시한다. */
const CruiseDependency = z.object({
  module: z.string(),
  resolved: z.string(),
  coreModule: z.boolean(),
  couldNotResolve: z.boolean(),
});
const CruiseModule = z.object({
  source: z.string(),
  dependencies: z.array(CruiseDependency),
});
const CruiseViolation = z.object({
  type: z.string().optional(),
  from: z.string(),
  to: z.string(),
  rule: z.object({ name: z.string(), severity: z.string() }),
  cycle: z.array(z.object({ name: z.string() })).optional(),
});
export const CruiseOutput = z.object({
  modules: z.array(CruiseModule),
  summary: z.object({ violations: z.array(CruiseViolation) }),
});
export type CruiseOutput = z.infer<typeof CruiseOutput>;

/** 실행기 출력 글 → 읽는 모양. 깨졌으면 던진다. */
export const parseCruiseOutput = (text: string): CruiseOutput => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ParserError('cruise_output_invalid', 'dependency-cruiser 출력이 JSON이 아닙니다');
  }
  const parsed = CruiseOutput.safeParse(json);
  if (!parsed.success) {
    throw new ParserError('cruise_output_invalid', 'dependency-cruiser 출력의 모양이 다릅니다');
  }
  return parsed.data;
};

export interface CruiseRequest {
  /** 프로젝트 폴더의 실제 경로 */
  root: string;
  /** dependency-cruiser에 제외로 넘길 정규식 */
  exclude: string;
  ruleSet: CruiseRuleSet | null;
}

export interface ProcessOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** 시험용: 다른 실행기 */
  runnerPath?: string;
}

/** 실행기에 넘길 입력 (cruise 옵션). */
export const cruiseInput = (request: CruiseRequest): { args: string[]; options: object } => {
  const tsConfig = path.join(request.root, 'tsconfig.json');
  return {
    args: ['.'],
    options: {
      baseDir: request.root,
      exclude: { path: request.exclude },
      // 타입 전용 · 동적 import도 TypeScript 구문 그대로 읽어 간선으로 둔다
      tsPreCompilationDeps: true,
      ...(existsSync(tsConfig) ? { tsConfig: { fileName: tsConfig } } : {}),
      ...(request.ruleSet === null ? {} : { ruleSet: request.ruleSet, validate: true }),
    },
  };
};

/** 실행기를 돌려 출력 글을 받는다. */
export const runCruiseProcess = (input: unknown, options: ProcessOptions = {}): Promise<string> => {
  const timeoutMs = options.timeoutMs ?? PARSER_LIMITS.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? PARSER_LIMITS.maxOutputBytes;
  const runner = options.runnerPath ?? RUNNER_PATH;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner], {
      cwd: path.dirname(runner),
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let failure: ParserError | null = null;
    const stop = (error: ParserError): void => {
      if (failure !== null) return;
      failure = error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      stop(
        new ParserError(
          'cruise_timeout',
          `dependency-cruiser가 ${String(timeoutMs)}ms 안에 끝나지 않았습니다`,
        ),
      );
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutputBytes) {
        stop(
          new ParserError(
            'cruise_output_too_large',
            `dependency-cruiser 출력이 ${String(maxOutputBytes)}바이트를 넘습니다`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2_000) stderr += chunk.toString('utf8');
    });
    child.stdin.on('error', () => {
      // 자식이 입력을 다 읽기 전에 끝나면 EPIPE가 난다. 결과는 종료 처리에서 정한다
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new ParserError('cruise_failed', 'dependency-cruiser 실행기를 띄우지 못했습니다'));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure !== null) {
        reject(failure);
      } else if (code !== 0) {
        const line = stderr.split('\n')[0]?.slice(0, 200) ?? '';
        reject(
          new ParserError(
            'cruise_failed',
            `dependency-cruiser 실행기가 실패했습니다 (종료 ${String(code ?? signal)}): ${line}`,
          ),
        );
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
};

/** 프로젝트를 한 번 분석한다. */
export const runCruise = async (
  request: CruiseRequest,
  options: ProcessOptions = {},
): Promise<CruiseOutput> =>
  parseCruiseOutput(await runCruiseProcess(cruiseInput(request), options));
