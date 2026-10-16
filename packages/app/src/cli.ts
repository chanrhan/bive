// CLI 진입점: `pnpm --filter @bive/app cli <명령>` (tsx, `@bive/source` 조건으로 빌드 없이 실행).
// 오케스트레이터는 같은 저장소의 packages/orchestrator를 현재 Node로 띄운다(개발 실행 방식).
// 환경 변수: BIVE_HOME (기본 ~/.bive), BIVE_ORCHESTRATOR_MODE (source | dist, 기본 source).
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
