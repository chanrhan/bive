// 개발용 CLI 본체 (Electron 없이 Node로): 오케스트레이터에 접속(없으면 기동)해 조회만 한다.
//   ping                 → 표준 출력 `pong`
//   rpc <method> [json]  → 이름이 .list · .get · .status · .summary로 끝나는 메서드만. 결과 JSON 출력
// 종료 코드: 0 성공, 1 접속 · 원격 오류, 2 사용법 위반 · 허용되지 않는 메서드.
import { PipeRpcError } from './main/pipe-client.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/** `cli rpc`가 허용하는 메서드 이름 끝 (조회 전용). */
export const READ_ONLY_SUFFIXES = ['.list', '.get', '.status', '.summary'] as const;

/** 조회 메서드인지: 허용 접미사로 끝나고 그 앞에 이름이 있어야 한다. */
export const isReadOnlyMethod = (method: string): boolean =>
  READ_ONLY_SUFFIXES.some((suffix) => method.length > suffix.length && method.endsWith(suffix));

export const USAGE = '사용법: cli ping | cli rpc <method> [json]';

export interface CliConnection {
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface CliDeps {
  connect: () => Promise<CliConnection>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
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
  deps.stderr(USAGE);
  return EXIT_USAGE;
};
