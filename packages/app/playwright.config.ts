// 화면 e2e (`pnpm e2e`, architecture.md 8장): renderer를 Vite 개발 서버로 띄워 브라우저 모드로 연다.
// 브라우저: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH가 있으면 그 실행 파일, 없으면 Playwright 기본 번들.
// 이 VM은 기본 번들이 없어 /opt/pw-browsers/chromium-1194/chrome-linux/chrome을 지정한다 (ADR-028, ADR-043).
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.BIVE_E2E_PORT ?? 5179);
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
