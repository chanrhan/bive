// 현재 프로젝트 (렌더러). 화면은 useProject()로 현재 프로젝트 ID를 읽는다.
//
// 결합부는 이 파일 하나다 (ADR-053). 프로젝트 열기(SCR-01, 이슈 #14)가 정식으로 값을 채운다:
// - 지금은 main이 보내는 알림 `project.current`({ project: { id, name } | null })만 듣는다.
//   main은 아직 이 알림을 보내지 않으므로 앱에서는 늘 "프로젝트 없음"이고, 화면 e2e는 가짜 브리지로 보낸다.
// - #14는 알림 이름 · 값 모양을 bridge.ts로 옮기거나 `project.current` 같은 조회 RPC를 처음 한 번 부르도록
//   이 파일만 고치면 된다. 화면은 useProject()의 반환 모양만 쓴다.
// 프로젝트가 바뀌면 목록별 필터 상태를 비운다 (ADR-034).
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';

import { resetAllListFilters } from '../components/ListView/filterStore.js';

/** main → renderer 알림: 현재 프로젝트 (임시 계약, #14가 확정). */
export const PROJECT_EVENT = 'project.current';

/** 화면이 쓰는 현재 프로젝트 값. */
export interface CurrentProject {
  /** 프로젝트 ID (ULID). RPC의 `projectId` */
  id: string;
  /** 프로젝트 이름 */
  name: string;
}

/** {@link PROJECT_EVENT}의 값. */
export interface ProjectEventParams {
  project: CurrentProject | null;
}

const isProject = (value: unknown): value is CurrentProject => {
  if (typeof value !== 'object' || value === null) return false;
  const { id, name } = value as { id?: unknown; name?: unknown };
  return typeof id === 'string' && id !== '' && typeof name === 'string';
};

/** 알림 값 → 현재 프로젝트. 모양이 틀리면 undefined(무시). */
export const parseProjectEvent = (params: unknown): CurrentProject | null | undefined => {
  if (typeof params !== 'object' || params === null || !('project' in params)) return undefined;
  const { project } = params as { project: unknown };
  if (project === null) return null;
  return isProject(project) ? { id: project.id, name: project.name } : undefined;
};

const ProjectContext = createContext<CurrentProject | null>(null);

export const ProjectProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [project, setProject] = useState<CurrentProject | null>(null);

  useEffect(
    () =>
      window.bive.on(PROJECT_EVENT, (params) => {
        const next = parseProjectEvent(params);
        if (next === undefined) return;
        setProject((prev) => (prev?.id === next?.id && prev?.name === next?.name ? prev : next));
      }),
    [],
  );

  // 열려 있던 프로젝트에서 다른 프로젝트(또는 없음)로 바뀌면 목록 필터를 비운다
  const previousId = useRef<string | null>(null);
  const id = project?.id ?? null;
  useEffect(() => {
    if (previousId.current !== null && previousId.current !== id) resetAllListFilters();
    previousId.current = id;
  }, [id]);

  return <ProjectContext.Provider value={project}>{children}</ProjectContext.Provider>;
};

/** 현재 프로젝트. 열린 프로젝트가 없으면 null. */
export const useProject = (): CurrentProject | null => useContext(ProjectContext);
