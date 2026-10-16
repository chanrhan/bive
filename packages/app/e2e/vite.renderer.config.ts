// 화면 e2e 전용 Vite 설정: renderer만 일반 웹 페이지로 서빙한다 (architecture.md 8장 "브라우저 모드").
// preload가 없으므로 window.bive는 테스트가 support/bive-mock.ts로 주입한다.
// HMR을 끄면 React 플러그인이 인라인 스크립트(Fast Refresh 프리앰블)를 넣지 않아 index.html의 CSP
// (script-src 'self')를 그대로 둔 채 열 수 있다.
//
// 플레이그라운드: 화면이 아직 없는 공용 컴포넌트를 e2e로 검사하는 페이지(`e2e/playground/*.html`)를
// `/playground/<이름>.html`로 서빙한다 (ADR-048). 테스트 데이터는 플레이그라운드 파일 안에만 두고
// 제품 빌드(electron-vite)에는 들어가지 않는다.
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const PLAYGROUND_DIR = fileURLToPath(new URL('./playground/', import.meta.url));

/**
 * `/playground/<파일>` → `e2e/playground/<파일>` (Vite의 `/@fs/` 경로로 바꿔 HTML · 모듈 처리를 그대로 쓴다).
 * HTML이 상대 경로로 부르는 스크립트(`./list-playground.tsx`)도 같은 규칙으로 찾는다.
 */
const playground = (): Plugin => ({
  name: 'bive-e2e-playground',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const match = /^\/playground\/([a-z0-9-]+\.(?:html|tsx))(\?.*)?$/.exec(req.url ?? '');
      if (match !== null) req.url = `/@fs${PLAYGROUND_DIR}${match[1]}${match[2] ?? ''}`;
      next();
    });
  },
});

export default defineConfig({
  root: fileURLToPath(new URL('../src/renderer', import.meta.url)),
  plugins: [react(), playground()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    hmr: false,
    watch: null,
  },
});
