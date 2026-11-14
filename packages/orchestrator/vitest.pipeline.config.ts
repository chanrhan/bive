import { defineConfig } from 'vitest/config';

// 파이프라인 e2e (M1-21, architecture.md 8장, ADR-071): 픽스처 복사본 · 실제 git · 실제 판정 러너 · ScriptedAdapter.
// 단위 테스트(`vitest.config.ts`, `pnpm test`)와 따로 `pnpm e2e:pipeline`으로 돈다. 시험마다 실제 설치 · next build를
// 여러 번 하므로 파일을 하나씩 돌린다(빌드가 겹치면 부하로 제한 시간에 걸리기 쉽다, ADR-064).
export default defineConfig({
  // 워크스페이스 패키지(@bive/*)를 빌드 없이 src로 해석한다 (vitest.config.ts와 같음)
  ssr: { resolve: { conditions: ['@bive/source', 'module', 'node', 'development|production'] } },
  test: {
    name: 'pipeline',
    include: ['e2e/pipeline/**/*.test.ts'],
    fileParallelism: false,
    // 정리(오케스트레이터 종료 · 판정이 설치한 node_modules 삭제)가 부하에서 기본 10초를 넘는다
    hookTimeout: 120_000,
  },
});
