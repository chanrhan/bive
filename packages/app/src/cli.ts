// CLI 진입점: `pnpm --filter @bive/app cli <명령>` (tsx, `@bive/source` 조건으로 빌드 없이 실행).
// 오케스트레이터는 같은 저장소의 packages/orchestrator를 현재 Node로 띄운다(개발 실행 방식).
// 환경 변수: BIVE_HOME (기본 ~/.bive), BIVE_ORCHESTRATOR_MODE (source | dist, 기본 source). 인자의 상대 경로는 INIT_CWD(pnpm이
// 남기는 명령을 친 폴더) 기준이다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT_ERROR, runCli } from './cli-core.js';
import {
  ensureOrchestrator,
  orchestratorCommand,
  resolveOrchestratorMode,
} from './main/orchestrator-launch.js';
import { resolveBiveHome } from './main/run-paths.js';

const orchestratorDir = fileURLToPath(new URL('../../orchestrator', import.meta.url));

const main = async (): Promise<number> => {
  const biveHome = resolveBiveHome();
  const command = orchestratorCommand({
    mode: resolveOrchestratorMode(process.env, false),
    orchestratorDir,
    nodePath: process.execPath,
    biveHome,
    env: process.env,
  });
  return runCli(process.argv.slice(2), {
    connect: async () => (await ensureOrchestrator({ biveHome, command })).client,
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    readFile: (file) => readFileSync(file, 'utf8'),
    // `pnpm --filter`는 패키지 폴더에서 돌린다: 상대 경로는 사용자가 명령을 친 폴더(INIT_CWD) 기준으로 푼다
    resolvePath: (value) => path.resolve(process.env.INIT_CWD ?? process.cwd(), value),
  });
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error('오류:', error instanceof Error ? error.message : error);
    process.exitCode = EXIT_ERROR;
  },
);
