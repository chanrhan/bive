// e2e 전용 플레이그라운드: 열린 프로젝트가 있는 앱 전체(App)를 그린다 (ADR-048 · ADR-057, e2e/scr-21.spec.ts).
// 프로젝트 열기(#14) 전에는 제품 앱에 열린 프로젝트를 넣을 경로가 없어, 여기서 ProjectProvider로 감싼다.
// 테스트 데이터(프로젝트 ID · 이름)는 이 파일 안에만 둔다 (제품 코드 경로 금지, NFR-03). `/playground/app.html`로 연다.
import '../../src/renderer/styles/tokens.css';
import '../../src/renderer/styles/app.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '../../src/renderer/src/App.js';
import { ProjectProvider } from '../../src/renderer/src/project/ProjectContext.js';

/** e2e/scr-21.spec.ts의 PLAYGROUND_PROJECT_ID와 같은 값. */
const PROJECT = { id: '01JA00000000000000000000P1', name: '샘플 앱' };

const container = document.getElementById('root');
if (container === null) throw new Error('#root 요소 없음');

createRoot(container).render(
  <StrictMode>
    <ProjectProvider project={PROJECT}>
      <App />
    </ProjectProvider>
  </StrictMode>,
);
