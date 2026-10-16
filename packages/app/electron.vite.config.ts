// electron-vite 빌드: main · preload · renderer → dist/{main,preload,renderer}.
// 워크스페이스 패키지는 `@bive/source` 조건 없이 dist를 읽는다(ADR-039). 그래서 app 빌드 전에
// shared가 빌드돼 있어야 하고, `pnpm -r build`는 의존 순서대로 빌드한다.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      // shared(와 그 의존성 zod)를 번들에 넣어 main이 electron · Node 내장 모듈 밖을 찾지 않게 한다
      externalizeDeps: { exclude: ['@bive/shared'] },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      // 샌드박스 preload는 CommonJS 한 파일이어야 한다. shared는 타입만 쓰므로 런타임 의존성이 없다
      externalizeDeps: false,
      rolldownOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    build: { outDir: 'dist/renderer' },
    plugins: [react()],
  },
});
