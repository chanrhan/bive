// 앱 셸: 경로 상태 + 현재 프로젝트 + 레이아웃 (사이드바 · 중앙 영역 · 채팅). 화면은 screens/registry.ts에 꽂는다 (ADR-044).
// 시작 화면은 프로젝트 시작(SCR-01)이고, 프로젝트가 열리면 요구사항(SCR-02)으로 들어간다 (PRJ-01, ADR-036).
import { useEffect } from 'react';

import { AppLayout } from './layout/AppLayout.js';
import { NavigationProvider, useNavigation } from './navigation/NavigationContext.js';
import type { RouteId } from './navigation/routes.js';
import { ProjectProvider, useProject } from './project/ProjectContext.js';

/** 프로젝트를 열면 들어가는 화면. */
export const PROJECT_ENTRY_ROUTE: RouteId = 'requirements';

/** 열린 프로젝트가 바뀌면(처음 열림 포함) 요구사항 화면으로 이동한다. */
const ProjectEntry = (): null => {
  const { project } = useProject();
  const { navigate } = useNavigation();
  const projectId = project?.id ?? null;
  useEffect(() => {
    if (projectId !== null) navigate(PROJECT_ENTRY_ROUTE);
  }, [projectId, navigate]);
  return null;
};

export const App = (): React.JSX.Element => (
  <NavigationProvider initialRoute="start">
    <ProjectProvider>
      <ProjectEntry />
      <AppLayout />
    </ProjectProvider>
  </NavigationProvider>
);
