// 설정 모달 (SCR-21, screens.md 7장 X-02): 사이드바 하단 톱니 → 모달(820 × 600, 바깥 클릭 · Esc · × 닫기).
// 왼쪽 섹션 목록 · 오른쪽 섹션 내용. 섹션은 예산 · 모델만 그린다. 잠정 승인 · 자동 모드 · 대기열 · 작성 규칙은
// 그 기능을 여는 이슈 전까지 DOM에 두지 않는다 (ADR-010 · ADR-035).
import './SettingsModal.css';

import { Modal } from '../../components/Modal/index.js';
import { useProject } from '../../project/ProjectContext.js';
import { BudgetModelSection, SECTION_TEXT } from './BudgetModelSection.js';
import { closeSettings, useSettingsOpen } from './settingsModalStore.js';

export const SETTINGS_TITLE = '설정';
/** 열린 프로젝트가 없을 때 본문 한 줄 (ADR-029 형식). 설정은 프로젝트별이다. */
export const NO_PROJECT_TEXT = '프로젝트 없음';

export const SettingsModal = ({ onClose }: { onClose: () => void }): React.JSX.Element => {
  const { project } = useProject();
  return (
    <Modal
      labelledBy="settings-title"
      onClose={onClose}
      testId="settings-modal"
      className="settings-modal"
    >
      <nav className="settings-nav" aria-label="설정 섹션">
        <h2 className="settings-title" id="settings-title">
          {SETTINGS_TITLE}
        </h2>
        <ul className="settings-nav-list">
          <li>
            <span
              className="settings-nav-item"
              data-testid="settings-nav-budget-model"
              aria-current="page"
            >
              {SECTION_TEXT.title}
            </span>
          </li>
        </ul>
      </nav>
      <section
        className="settings-content"
        data-testid="settings-section-budget-model"
        aria-labelledby="settings-section-title"
      >
        <h3 className="settings-section-title" id="settings-section-title">
          {SECTION_TEXT.title}
        </h3>
        {project === null ? (
          <p className="settings-message" data-testid="settings-no-project">
            {NO_PROJECT_TEXT}
          </p>
        ) : (
          <BudgetModelSection key={project.id} projectId={project.id} />
        )}
      </section>
    </Modal>
  );
};

/** 열림 상태를 따라 설정 모달을 그린다. 사이드바(톱니 버튼 옆)에 하나만 둔다. */
export const SettingsModalHost = (): React.JSX.Element | null => {
  const open = useSettingsOpen();
  return open ? <SettingsModal onClose={closeSettings} /> : null;
};
