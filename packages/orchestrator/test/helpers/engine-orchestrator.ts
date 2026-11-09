// 시험 전용 오케스트레이터 진입점 (engine.test.ts의 비정상 종료 · 재기동 시험, M1-14).
// 제품 CLI(`src/cli.ts`)와 같이 기동하되, 시험용 단계 실행기와 시험 시나리오 폴더(`test/fixtures/scenarios`)를 쓴다.
// 환경 변수: BIVE_HOME · BIVE_IDLE_SHUTDOWN_MS · BIVE_SCENARIO (BIVE_AGENT는 scripted로 고정).
import { selectAgent } from '../../src/agent/select.js';
import { parseIdleShutdownMs } from '../../src/lifecycle.js';
import { startOrchestrator } from '../../src/orchestrator.js';
import { resolveBiveHome } from '../../src/run-paths.js';
import { TEST_SCENARIOS_DIR, testExecutors } from './engine-harness.js';

const main = async (): Promise<number> => {
  const biveHome = resolveBiveHome();
  const agent = selectAgent(
    { ...process.env, BIVE_AGENT: 'scripted' },
    { biveHome, scenariosDir: TEST_SCENARIOS_DIR, pollIntervalMs: 20 },
  );
  const result = await startOrchestrator({
    biveHome,
    idleShutdownMs: parseIdleShutdownMs(process.env.BIVE_IDLE_SHUTDOWN_MS) ?? 60_000,
    agent,
    executors: testExecutors(),
  });
  if (result.status === 'already-running') return 1;
  const { orchestrator } = result;
  console.log(
    `오케스트레이터 기동 (pid ${process.pid}, 중단으로 표시 ${String(orchestrator.interruptedRuns.length)})`,
  );
  await orchestrator.closed;
  return 0;
};

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error('오케스트레이터 오류:', error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
