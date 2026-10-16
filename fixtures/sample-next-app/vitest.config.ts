import { defineConfig } from 'vitest/config';

// 프로젝트 자체 HTTP 테스트. 서버는 globalSetup이 빌드 · 기동하고 테스트는 HTTP로만 호출한다.
// BIVE 인수 테스트(bive-acceptance/**/*.acc.ts)는 BIVE 판정 러너 전용이라 여기서 줍지 않는다(ADR-026).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'bive-acceptance/**'],
    globalSetup: ['tests/support/server.ts'],
    testTimeout: 15_000,
  },
});
