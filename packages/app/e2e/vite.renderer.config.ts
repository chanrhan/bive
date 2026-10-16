// 화면 e2e 전용 Vite 설정: renderer만 일반 웹 페이지로 서빙한다 (architecture.md 8장 "브라우저 모드").
// preload가 없으므로 window.bive는 테스트가 support/bive-mock.ts로 주입한다.
// HMR을 끄면 React 플러그인이 인라인 스크립트(Fast Refresh 프리앰블)를 넣지 않아 index.html의 CSP
// (script-src 'self')를 그대로 둔 채 열 수 있다.
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('../src/renderer', import.meta.url)),
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    hmr: false,
    watch: null,
  },
});
