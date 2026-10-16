// e2e 전용 플레이그라운드: 프로젝트가 열린 상태의 앱 셸 전체를 그린다 (ADR-056, e2e/todo-entry.spec.ts).
// 프로젝트 열기(#14 M1-01)가 들어오기 전이라 현재 프로젝트를 주소 인자로 받는다:
//   /playground/app.html?projectId=<ULID>&projectName=<이름>
// 제품 코드 경로에는 두지 않는다 (NFR-03). 제안 데이터는 테스트가 가짜 브리지(support/bive-mock.ts)로 준다.
import '../../src/renderer/styles/tokens.css';
import '../../src/renderer/styles/app.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AppLayout } from '../../src/renderer/src/layout/AppLayout.js';
import { NavigationProvider } from '../../src/renderer/src/navigation/NavigationContext.js';
import {
  type OpenProject,
  ProjectProvider,
} from '../../src/renderer/src/project/ProjectContext.js';

const params = new URLSearchParams(window.location.search);
const projectId = params.get('projectId');
const project: OpenProject | null =
  projectId === null ? null : { id: projectId, name: params.get('projectName') ?? '' };

const container = document.getElementById('root');
if (container === null) throw new Error('#root 요소 없음');

createRoot(container).render(
  <StrictMode>
    <NavigationProvider>
      <ProjectProvider initialProject={project}>
        <AppLayout />
      </ProjectProvider>
    </NavigationProvider>
  </StrictMode>,
);
