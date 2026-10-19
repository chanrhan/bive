// 프로젝트 시작 (screens.md SCR-01, PRJ-01): [폴더 열기] → OS 폴더 선택(main) → `project.open`.
// 열리면 요구사항 화면으로 들어간다(App의 ProjectEntry). 빈 폴더 · 비어 있지 않은 미연결 폴더 모두 같다 (ADR-036).
// [BIVE 동기화](M4) · [요구사항 자동 생성](M6)은 이 단계에서 렌더링하지 않는다 (ADR-035 · ADR-036).
import { FolderOpen } from 'lucide-react';
import { useState } from 'react';

import { PICK_FOLDER_METHOD } from '../../../../common/bridge.js';
import { useProject } from '../../project/ProjectContext.js';
import './ProjectStartScreen.css';

/** 화면 문구 (screens.md 1.1 명사형). */
export const PROJECT_START_TEXT = {
  title: '프로젝트 시작',
  openFolder: '폴더 열기',
  openFailed: '폴더 열기 실패',
} as const;

export const ProjectStartScreen = (): React.JSX.Element => {
  const { open, loading } = useProject();
  const [picking, setPicking] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = picking || loading;

  const openFolder = async (): Promise<void> => {
    setFailed(false);
    setPicking(true);
    try {
      const { path } = await window.bive.invoke(PICK_FOLDER_METHOD);
      if (path === null) return;
      await open(path);
    } catch {
      setFailed(true);
    } finally {
      setPicking(false);
    }
  };

  return (
    <section
      className="project-start"
      data-testid="project-start"
      aria-labelledby="project-start-title"
    >
      <h1 className="project-start-title" id="project-start-title">
        {PROJECT_START_TEXT.title}
      </h1>
      <button
        type="button"
        className="primary-button"
        data-testid="open-folder"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void openFolder()}
      >
        <FolderOpen className="inline-icon" aria-hidden="true" />
        <span>{PROJECT_START_TEXT.openFolder}</span>
      </button>
      {failed && (
        <p className="project-start-error" role="alert" data-testid="project-start-error">
          {PROJECT_START_TEXT.openFailed}
        </p>
      )}
    </section>
  );
};
