// 현재 열린 프로젝트 (최소 버전). 프로젝트 열기(#14 M1-01)가 정식 제공자를 맡고, 그 구현이 들어오면 이 파일을 대신한다.
// 화면은 useProject()로 현재 프로젝트 ID를 읽는다. 프로젝트를 열기 전에는 null이다 (NFR-03: 근거 없는 값 미표시).
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

/** 열린 프로젝트. `id`는 저장소의 프로젝트 ID(ULID). */
export interface OpenProject {
  id: string;
  name: string;
}

export interface ProjectContextValue {
  /** 현재 프로젝트. 열기 전이면 null */
  project: OpenProject | null;
  setProject(project: OpenProject | null): void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export const ProjectProvider = ({
  initialProject = null,
  children,
}: {
  initialProject?: OpenProject | null;
  children: ReactNode;
}): React.JSX.Element => {
  const [project, setProject] = useState<OpenProject | null>(initialProject);
  const value = useMemo<ProjectContextValue>(() => ({ project, setProject }), [project]);
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
};

export const useProject = (): ProjectContextValue => {
  const value = useContext(ProjectContext);
  if (value === null) throw new Error('ProjectProvider 밖에서 useProject 호출');
  return value;
};
