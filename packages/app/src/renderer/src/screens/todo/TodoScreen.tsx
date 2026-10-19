// 할 일 화면 (screens.md 6장 할 일 · SCR-17, TODO-01). 사이드바 알림 아이콘으로 들어온다.
// 머리에 탭(M1은 [승인 대기]만, ADR-035), 마지막 탭은 tabStore가 앱 실행 동안 기억한다.
// 프로젝트를 열기 전에는 목록을 부르지 않는다.
import './TodoScreen.css';

import { EmptyState } from '../../layout/EmptyState.js';
import { useProject } from '../../project/ProjectContext.js';
import { ApprovalTab } from './ApprovalTab.js';
import { TODO_TABS, useTodoTab } from './tabStore.js';

export const TodoScreen = (): React.JSX.Element => {
  const { project, loading } = useProject();
  const [tab, setTab] = useTodoTab();
  const panelId = `todo-panel-${tab}`;
  return (
    <section className="todo" data-testid="todo-screen" aria-label="할 일">
      <div className="todo-tabs" role="tablist" aria-label="할 일 종류">
        {TODO_TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`todo-tab-${id}`}
            className="todo-tab"
            data-testid={`todo-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={tab === id ? panelId : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="todo-panel" role="tabpanel" id={panelId} aria-labelledby={`todo-tab-${tab}`}>
        {project === null ? (
          // 프로젝트 조회 중에는 문구 없이 비운다 (ADR-053과 같음)
          !loading && <EmptyState text="프로젝트 없음" />
        ) : (
          // 프로젝트가 바뀌면 선택 · 읽음 요청 기록을 새로 시작한다
          <ApprovalTab key={project.id} projectId={project.id} />
        )}
      </div>
    </section>
  );
};
