// 현재 프로젝트 (M1-01, PRJ-01). 화면은 useProject()로 열린 프로젝트(ID · 이름 · 경로)를 읽는다.
// - 처음 한 번 `project.current`를 부르고(오케스트레이터가 마지막으로 연 프로젝트), 이후는 main이 보내는
//   `project.opened` 알림을 따른다. 알림이 먼저 오면 늦게 온 첫 조회 결과로 덮지 않는다
// - `open(path)`는 `project.open`을 부르고 결과의 프로젝트로 바꾼다. 실패하면 JSON-RPC 오류 객체로 거부된다
// 화면 데이터는 오케스트레이터 응답에서만 만든다 (NFR-03).
import type { Project, ProjectOpenResult } from '@bive/shared';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { PROJECT_OPENED_EVENT } from '../../../common/bridge.js';

export interface ProjectState {
  /** 열린 프로젝트. 없으면 null (프로젝트 시작 화면) */
  project: Project | null;
  /** 첫 조회(`project.current`) 또는 `open` 진행 중 */
  loading: boolean;
  /** 폴더를 연다 (`project.open`). 성공하면 `project`가 바뀐다 */
  open(path: string): Promise<ProjectOpenResult>;
}

const ProjectContext = createContext<ProjectState | null>(null);

const isProject = (value: unknown): value is Project => {
  if (typeof value !== 'object' || value === null) return false;
  const { id, name, rootPath } = value as Record<string, unknown>;
  return typeof id === 'string' && typeof name === 'string' && typeof rootPath === 'string';
};

const isOpenedEvent = (value: unknown): value is ProjectOpenResult =>
  typeof value === 'object' &&
  value !== null &&
  isProject((value as { project?: unknown }).project);

export const ProjectProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [project, setProject] = useState<Project | null>(null);
  /** 진행 중인 조회 · 열기 수 (첫 조회 1건으로 시작) */
  const [pending, setPending] = useState(1);

  useEffect(() => {
    let active = true;
    let heard = false;
    const off = window.bive.on(PROJECT_OPENED_EVENT, (params) => {
      if (!active || !isOpenedEvent(params)) return;
      heard = true;
      setProject(params.project);
    });
    window.bive
      .invoke('project.current')
      .then(
        (result) => {
          if (active && !heard) setProject(result.project);
        },
        // 조회 실패(연결 끊김 등)는 프로젝트 없음으로 둔다. 연결 상태는 사이드바 하단이 보여 준다
        () => undefined,
      )
      .finally(() => {
        if (active) setPending((n) => n - 1);
      });
    return () => {
      active = false;
      off();
    };
  }, []);

  const open = useCallback(async (path: string): Promise<ProjectOpenResult> => {
    setPending((n) => n + 1);
    try {
      const result = await window.bive.invoke('project.open', { path });
      setProject(result.project);
      return result;
    } finally {
      setPending((n) => n - 1);
    }
  }, []);

  const value = useMemo<ProjectState>(
    () => ({ project, loading: pending > 0, open }),
    [project, pending, open],
  );
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
};

export const useProject = (): ProjectState => {
  const value = useContext(ProjectContext);
  if (value === null) throw new Error('ProjectProvider 밖에서 useProject 호출');
  return value;
};
