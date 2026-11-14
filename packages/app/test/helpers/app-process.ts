// 시험용 "앱 프로세스" (M1-20, ADR-074). Electron 창 없이 앱 main과 같은 코드 경로로 오케스트레이터를 띄우거나 붙는다:
// `orchestratorCommand` → `startMainSession`(app.pid 기록 · 잠금 pid가 없으면 분리 프로세스 기동) → `link.connect`.
// 렌더러 요청 대신 표준 입력의 줄(JSON `{id, method, params}`)을 같은 링크로 보내고 결과를 표준 출력에 한 줄씩 쓴다.
// 표준 입력이 닫히면 앱의 `will-quit`처럼 `session.dispose()`(연결 종료 · app.pid 삭제) 뒤 종료 코드 0으로 끝난다.
// 오케스트레이터는 그대로 둔다(종료는 오케스트레이터의 유휴 종료가 맡는다, ADR-042).
// 실행: packages/app에서 `node --conditions=@bive/source --import tsx test/helpers/app-process.ts`.
// 환경 변수: BIVE_HOME(필수) · 나머지(BIVE_AGENT · BIVE_SCENARIO · BIVE_IDLE_SHUTDOWN_MS)는 오케스트레이터에 그대로 물려준다.
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  orchestratorCommand,
  readPidFile,
  resolveOrchestratorMode,
} from '../../src/main/orchestrator-launch.js';
import { PipeRpcError } from '../../src/main/pipe-client.js';
import { appRunPaths } from '../../src/main/run-paths.js';
import { startMainSession } from '../../src/main/session.js';

const APP_DIR = fileURLToPath(new URL('../../', import.meta.url));

const write = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const main = async (): Promise<void> => {
  const biveHome = process.env.BIVE_HOME;
  if (biveHome === undefined || biveHome === '') throw new Error('BIVE_HOME 필요');
  // 개발 실행의 앱 main과 같다(src/main/index.ts): 저장소의 packages/orchestrator, 실행 방식은 환경 변수 또는 source
  const command = orchestratorCommand({
    mode: resolveOrchestratorMode(process.env, false),
    orchestratorDir: path.resolve(APP_DIR, '../orchestrator'),
    nodePath: process.execPath,
    biveHome,
    env: process.env,
  });
  const session = startMainSession({ biveHome, command, timeoutMs: 30_000 });
  const { launched, spawnedPid } = await session.link.connect();
  write({
    event: 'ready',
    appPid: process.pid,
    launched,
    spawnedPid,
    orchestratorPid: readPidFile(appRunPaths(biveHome).orchestratorPid),
  });

  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    const { id, method, params } = JSON.parse(line) as {
      id: number;
      method: string;
      params?: unknown;
    };
    try {
      write({ id, result: await session.link.request(method, params) });
    } catch (error) {
      write({
        id,
        error:
          error instanceof PipeRpcError
            ? error.toErrorObject()
            : { code: -1, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  // 표준 입력이 닫힘 = 앱 종료
  session.dispose();
  write({ event: 'exit' });
};

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('앱 프로세스 오류:', error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
