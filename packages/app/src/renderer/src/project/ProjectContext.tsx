// 현재 프로젝트. 계약은 프로젝트 열기(#14 M1-01)의 정식 제공자와 같다: useProject() → { project, loading, open }.
// #14가 머지되면 이 파일은 그쪽 구현(첫 `project.current` 조회 + `project.opened` 알림 + `project.open`)으로 바뀐다.
// 그 전까지는 RPC가 없으므로 main의 `project.opened` 알림만 따르고, `open`은 메서드 없음(-32601)으로 거부한다.
// 화면 데이터는 오케스트레이터 응답에서만 만든다 (NFR-03).
import type { JsonRpcErrorObject, Project } from '@bive/shared';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

import { PROJECT_OPENED_EVENT } from '../../../common/bridge.js';

export interface ProjectState {
  /** 열린 프로젝트. 없으면 null */
  project: Project | null;
  /** 첫 조회 또는 `open` 진행 중 */
  loading: boolean;
  /** 폴더를 연다 (`project.open`). 성공하면 `project`가 바뀐다 */
  open(path: string): Promise<{ project: Project }>;
}

const ProjectContext = createContext<ProjectState | null>(null);

const isProject = (value: unknown): value is Project => {
  if (typeof value !== 'object' || value === null) return false;
  const { id, name, rootPath } = value as Record<string, unknown>;
  return typeof id === 'string' && typeof name === 'string' && typeof rootPath === 'string';
};

const isOpenedEvent = (value: unknown): value is { project: Project } =>
  typeof value === 'object' &&
  value !== null &&
  isProject((value as { project?: unknown }).project);

const METHOD_NOT_FOUND: JsonRpcErrorObject = { code: -32601, message: '메서드 없음' };

/** `project.open` RPC가 생기기 전(#14)의 열기: 실제 브리지가 모르는 메서드에 주는 오류와 같게 거부한다. */
const open: ProjectState['open'] = () => Promise.reject(METHOD_NOT_FOUND);

export const ProjectProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    let active = true;
    const off = window.bive.on(PROJECT_OPENED_EVENT, (params) => {
      if (active && isOpenedEvent(params)) setProject(params.project);
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  const value = useMemo<ProjectState>(() => ({ project, loading: false, open }), [project]);
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
};

export const useProject = (): ProjectState => {
  const value = useContext(ProjectContext);
  if (value === null) throw new Error('ProjectProvider 밖에서 useProject 호출');
  return value;
};
