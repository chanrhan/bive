// 오케스트레이터 실행 진입점: `pnpm --filter @bive/orchestrator start` (개발) · `node dist/cli.js` (빌드 후).
// 환경 변수: BIVE_HOME (기본 ~/.bive), BIVE_IDLE_SHUTDOWN_MS (기본 300000).
// 종료 코드: 0 = 정상 종료 또는 이미 실행 중, 1 = 기동 · 실행 오류, 2 = 환경 변수 오류.
import { parseIdleShutdownMs } from './lifecycle.js';
import { startOrchestrator } from './orchestrator.js';
import { resolveBiveHome } from './run-paths.js';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_BAD_ENV = 2;

const main = async (): Promise<number> => {
  const idleShutdownMs = parseIdleShutdownMs(process.env.BIVE_IDLE_SHUTDOWN_MS);
  if (idleShutdownMs === null) {
    console.error(
      `BIVE_IDLE_SHUTDOWN_MS는 양의 정수(ms)여야 함: ${process.env.BIVE_IDLE_SHUTDOWN_MS ?? ''}`,
    );
    return EXIT_BAD_ENV;
  }
  const result = await startOrchestrator({ biveHome: resolveBiveHome(), idleShutdownMs });
  if (result.status === 'already-running') {
    console.log(`오케스트레이터 이미 실행 중 (pid ${result.pid})`);
    return EXIT_OK;
  }
  const { orchestrator } = result;
  const onSignal = (): void => void orchestrator.stop('signal');
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  console.log(
    `오케스트레이터 기동 (pid ${process.pid}, 버전 ${orchestrator.version}, ${orchestrator.paths.pipe})`,
  );
  const reason = await orchestrator.closed;
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
  console.log(`오케스트레이터 종료 (${reason})`);
  return EXIT_OK;
};

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error('오케스트레이터 오류:', error instanceof Error ? error.message : error);
    process.exit(EXIT_ERROR);
  },
);
