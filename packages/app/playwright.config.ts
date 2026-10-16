// 화면 e2e (`pnpm e2e`, architecture.md 8장): renderer를 Vite 개발 서버로 띄워 브라우저 모드로 연다.
// 브라우저: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH가 있으면 그 실행 파일, 없으면 Playwright 기본 번들.
// 이 VM은 기본 번들이 없어 /opt/pw-browsers/chromium-1194/chrome-linux/chrome을 지정한다 (ADR-028, ADR-043).
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

/**
 * 기본 포트: 작업 트리 경로 해시로 5179~5678 중 하나를 고른다. 같은 VM의 여러 작업 트리가 동시에 돌아도
 * 포트가 겹치지 않게 한다(겹치면 strictPort로 실패). `BIVE_E2E_PORT`가 있으면 그 값.
 * 정한 값을 환경 변수에 다시 써서 worker 프로세스가 같은 포트를 본다.
 */
const defaultPort = (): number => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const hash = createHash('sha256').update(dir).digest().readUInt32BE(0);
  return 5179 + (hash % 500);
};
const PORT = Number(process.env.BIVE_E2E_PORT || defaultPort());
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  throw new Error(`BIVE_E2E_PORT가 포트 번호가 아님: ${process.env.BIVE_E2E_PORT}`);
}
process.env.BIVE_E2E_PORT = String(PORT);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ARTIFACTS = fileURLToPath(new URL('../../artifacts/', import.meta.url));
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  outputDir: `${ARTIFACTS}playwright/results`,
  fullyParallel: true,
  forbidOnly: isCI,
  retries: 0,
  reporter: isCI
    ? [['list'], ['html', { outputFolder: `${ARTIFACTS}playwright/report`, open: 'never' }]]
    : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
    locale: 'ko-KR',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: executablePath === undefined ? {} : { executablePath },
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: `vite --config e2e/vite.renderer.config.ts --port ${PORT} --strictPort`,
    url: BASE_URL,
    // 다른 작업 트리의 서버를 잘못 재사용하지 않도록 항상 새로 띄운다 (포트가 차 있으면 실패, BIVE_E2E_PORT로 변경)
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
