// 현재 열린 프로젝트 (PRJ-01). 프로젝트 열기(#14)가 값을 채운다. 그 전에는 값이 없다(`null`).
// 화면은 `useProject().project?.id`를 RPC의 `projectId`로 쓴다.
import { createContext, type ReactNode, useContext, useMemo } from 'react';

export interface CurrentProject {
  id: string;
  name: string;
}

export interface ProjectState {
  /** 열린 프로젝트. 없으면 null */
  project: CurrentProject | null;
}

const ProjectContext = createContext<ProjectState>({ project: null });

export const ProjectProvider = ({
  project,
  children,
}: {
  project: CurrentProject | null;
  children: ReactNode;
}): React.JSX.Element => {
  const value = useMemo<ProjectState>(() => ({ project }), [project]);
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
};

/** 현재 프로젝트. ProjectProvider 밖이면 `{ project: null }`. */
export const useProject = (): ProjectState => useContext(ProjectContext);
