import { defineConfig } from 'vitest/config';

// 판정 러너 테스트는 픽스처를 실제로 next build 하므로 CPU를 오래 쓴다. 다른 테스트(짧은 제한 시간의
// 프로세스 · 소켓 테스트)와 동시에 돌면 그쪽이 흔들리므로 groupOrder로 나머지가 끝난 뒤 따로 돌린다.
const JUDGE_TESTS = ['test/judge-runner.test.ts'];

export default defineConfig({
  // 워크스페이스 패키지(@bive/*)를 빌드 없이 src로 해석한다 (architecture.md 2장 끝).
  // conditions는 기본값을 대체하므로 Vite 서버 기본 조건을 함께 적는다
  ssr: { resolve: { conditions: ['@bive/source', 'module', 'node', 'development|production'] } },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: JUDGE_TESTS },
      },
      {
        extends: true,
        test: { name: 'judge', include: JUDGE_TESTS, sequence: { groupOrder: 1 } },
      },
    ],
  },
});
