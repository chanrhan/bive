import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 워크스페이스 패키지(@bive/*)를 빌드 없이 src로 해석한다 (architecture.md 2장 끝).
  // conditions는 기본값을 대체하므로 Vite 서버 기본 조건을 함께 적는다
  ssr: { resolve: { conditions: ['@bive/source', 'module', 'node', 'development|production'] } },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
