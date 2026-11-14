// 설정 모달 (SCR-21, screens.md 7장 X-02): 사이드바 하단 톱니 → 모달(820 × 600, 바깥 클릭 · Esc · × 닫기).
// 왼쪽 섹션 목록 · 오른쪽 섹션 내용. 섹션은 예산 · 모델과 IDE(코드 열기, ADR-018 · ADR-087)를 그린다. 목록 항목을 누르면
// 오른쪽 내용이 바뀐다(처음은 예산 · 모델). 잠정 승인 · 자동 모드 · 대기열 · 작성 규칙은 그 기능을 여는 이슈 전까지
// DOM에 두지 않는다 (ADR-010 · ADR-035).
import './SettingsModal.css';

import { useState } from 'react';

import { IDE_TEXT } from '../../components/IdeChoice/index.js';
import { Modal } from '../../components/Modal/index.js';
import { useProject } from '../../project/ProjectContext.js';
import { BudgetModelSection, SECTION_TEXT } from './BudgetModelSection.js';
import { IdeSection } from './IdeSection.js';
import { closeSettings, useSettingsOpen } from './settingsModalStore.js';

export const SETTINGS_TITLE = '설정';
/** 열린 프로젝트가 없을 때 본문 한 줄 (ADR-029 형식). 설정은 프로젝트별이다. */
export const NO_PROJECT_TEXT = '프로젝트 없음';

type SectionKey = 'budget-model' | 'ide';

const SECTIONS: readonly { key: SectionKey; title: string }[] = [
  { key: 'budget-model', title: SECTION_TEXT.title },
  { key: 'ide', title: IDE_TEXT.title },
];

export const SettingsModal = ({ onClose }: { onClose: () => void }): React.JSX.Element => {
  const { project } = useProject();
  const [current, setCurrent] = useState<SectionKey>('budget-model');
  const section = SECTIONS.find((item) => item.key === current) ?? SECTIONS[0];
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
          {SECTIONS.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                className="settings-nav-item"
                data-testid={`settings-nav-${item.key}`}
                aria-current={item.key === current ? 'page' : undefined}
                onClick={() => setCurrent(item.key)}
              >
                {item.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <section
        className="settings-content"
        data-testid={`settings-section-${current}`}
        aria-labelledby="settings-section-title"
      >
        <h3 className="settings-section-title" id="settings-section-title">
          {section?.title}
        </h3>
        {project === null ? (
          <p className="settings-message" data-testid="settings-no-project">
            {NO_PROJECT_TEXT}
          </p>
        ) : current === 'ide' ? (
          <IdeSection key={project.id} projectId={project.id} />
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
