// 개발용 CLI 본체 (Electron 없이 Node로): 오케스트레이터에 접속(없으면 기동)해 조회한다. 쓰기는 정해진 명령만 사람 주체로 한다.
//   ping                     → 표준 출력 `pong`
//   rpc <method> [json]      → 이름이 .list · .get · .status · .summary로 끝나는 메서드만. 결과 JSON 출력
//   blocks set <dir> <json>  → 프로젝트 폴더(`.bive.json`의 프로젝트 ID)의 블록 선언을 JSON 파일 내용으로 저장(`blocks.set`, 주체 사람.
//                              M3-01 #46, ADR-122). 결과 JSON 출력. `rpc`로는 쓰기 메서드를 부를 수 없다(그대로 조회 전용)
// 종료 코드: 0 성공, 1 접속 · 원격 오류, 2 사용법 위반 · 허용되지 않는 메서드 · 읽을 수 없는 입력 파일.
import path from 'node:path';

import { PROJECT_FILE_NAME, ProjectFile } from '@bive/shared';

import { PipeRpcError } from './main/pipe-client.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/** `cli rpc`가 허용하는 메서드 이름 끝 (조회 전용). */
export const READ_ONLY_SUFFIXES = ['.list', '.get', '.status', '.summary'] as const;

/** 조회 메서드인지: 허용 접미사로 끝나고 그 앞에 이름이 있어야 한다. */
export const isReadOnlyMethod = (method: string): boolean =>
  READ_ONLY_SUFFIXES.some((suffix) => method.length > suffix.length && method.endsWith(suffix));

export const USAGE =
  '사용법: cli ping | cli rpc <method> [json] | cli blocks set <프로젝트 폴더> <블록 선언 JSON 파일>';

export interface CliConnection {
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface CliDeps {
  connect: () => Promise<CliConnection>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** 파일 읽기 (UTF-8). 경로는 CLI를 부른 폴더 기준으로 이미 풀린 것이다. `blocks set`만 쓴다 */
  readFile?: (path: string) => string;
  /** 인자의 경로를 CLI를 부른 폴더 기준 절대 경로로 (`pnpm --filter`는 패키지 폴더에서 돌므로). 생략하면 그대로 */
  resolvePath?: (path: string) => string;
}

const describeError = (error: unknown): string => {
  if (error instanceof PipeRpcError) return `오류 ${error.code}: ${error.message}`;
  return `오류: ${error instanceof Error ? error.message : String(error)}`;
};

const call = async (deps: CliDeps, method: string, params: unknown): Promise<unknown> => {
  const connection = await deps.connect();
  try {
    return await connection.request(method, params);
  } finally {
    await connection.close();
  }
};

export const runCli = async (argv: readonly string[], deps: CliDeps): Promise<number> => {
  const [command, ...rest] = argv;
  if (command === 'ping' && rest.length === 0) {
    try {
      await call(deps, 'ping', undefined);
    } catch (error) {
      deps.stderr(describeError(error));
      return EXIT_ERROR;
    }
    deps.stdout('pong');
    return EXIT_OK;
  }
  if (command === 'rpc' && (rest.length === 1 || rest.length === 2)) {
    const [method = '', rawParams] = rest;
    if (!isReadOnlyMethod(method)) {
      deps.stderr(
        `허용되지 않는 메서드: ${method} (이름이 ${READ_ONLY_SUFFIXES.join(' · ')}로 끝나는 조회 메서드만 허용)`,
      );
      return EXIT_USAGE;
    }
    let params: unknown;
    if (rawParams !== undefined) {
      try {
        params = JSON.parse(rawParams);
      } catch {
        deps.stderr(`JSON 해석 실패: ${rawParams}`);
        return EXIT_USAGE;
      }
    }
    try {
      const result = await call(deps, method, params);
      deps.stdout(JSON.stringify(result, null, 2));
      return EXIT_OK;
    } catch (error) {
      deps.stderr(describeError(error));
      return EXIT_ERROR;
    }
  }
  if (command === 'blocks' && rest[0] === 'set' && rest.length === 3) {
    return setBlocks(rest[1] ?? '', rest[2] ?? '', deps);
  }
  deps.stderr(USAGE);
  return EXIT_USAGE;
};

/** `blocks set <dir> <json>`: 프로젝트 ID는 폴더의 `.bive.json`에서, 선언은 JSON 파일에서 읽어 사람 주체로 `blocks.set`. */
const setBlocks = async (dirArg: string, jsonArg: string, deps: CliDeps): Promise<number> => {
  const resolve = deps.resolvePath ?? ((value: string) => value);
  const readFile = deps.readFile;
  if (readFile === undefined) {
    deps.stderr('파일을 읽을 수 없는 환경입니다');
    return EXIT_USAGE;
  }
  const readJson = (file: string, what: string): { ok: true; value: unknown } | { ok: false } => {
    let text: string;
    try {
      text = readFile(file);
    } catch (error) {
      deps.stderr(
        `${what} 읽기 실패: ${file} (${error instanceof Error ? error.message : String(error)})`,
      );
      return { ok: false };
    }
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      deps.stderr(`JSON 해석 실패: ${file}`);
      return { ok: false };
    }
  };
  const projectFile = readJson(path.join(resolve(dirArg), PROJECT_FILE_NAME), '프로젝트 식별 파일');
  if (!projectFile.ok) return EXIT_USAGE;
  const project = ProjectFile.safeParse(projectFile.value);
  if (!project.success) {
    deps.stderr(`프로젝트 식별 파일 형식 오류: ${path.join(resolve(dirArg), PROJECT_FILE_NAME)}`);
    return EXIT_USAGE;
  }
  const declaration = readJson(resolve(jsonArg), '블록 선언 파일');
  if (!declaration.ok) return EXIT_USAGE;
  try {
    const result = await call(deps, 'blocks.set', {
      projectId: project.data.projectId,
      author: { kind: 'human' },
      declaration: declaration.value,
    });
    deps.stdout(JSON.stringify(result, null, 2));
    return EXIT_OK;
  } catch (error) {
    deps.stderr(describeError(error));
    return EXIT_ERROR;
  }
};
