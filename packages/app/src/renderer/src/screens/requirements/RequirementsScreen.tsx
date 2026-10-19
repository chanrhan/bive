// 요구사항 화면 (screens.md SCR-02): 중앙 목록 + 상세 2단.
// - 목록: requirement.list 결과만 그린다(NFR-03). 카드 · 필터 규칙은 requirementsView.ts
// - [+ 새 요구사항]: 목록 맨 위 입력 줄 → requirement.create 1회 → 목록 다시 불러오기
//   (저장 뒤 규칙 제안은 오케스트레이터 쪽 이슈 #21이 붙인다. 화면은 호출만 한다)
// - 상세 자리: 고른 항목의 상세 내용 · 직접 편집 · 삭제는 이슈 #38. 지금은 빈 틀이고 고른 항목이 없으면 "선택 항목 없음"
// - 상태(ADR-053): 프로젝트 조회 중 = 비움 · 프로젝트 없음 = "프로젝트 없음" · 로딩 = 목록 자리 비움(문구 · 스켈레톤 없음) ·
//   불러오기 실패 = 목록 자리에 "요구사항 불러오기 실패" · 0건 = "요구사항 없음"(ADR-029)
import './RequirementsScreen.css';

import type { Requirement } from '@bive/shared';
import { Plus } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { ListView } from '../../components/ListView/ListView.js';
import { EmptyState } from '../../layout/EmptyState.js';
import { useProject } from '../../project/ProjectContext.js';
import { NewRequirementInput } from './NewRequirementInput.js';
import {
  REQUIREMENT_CRITERIA,
  REQUIREMENTS_LIST_ID,
  requirementCard,
  requirementKey,
  TEXT,
} from './requirementsView.js';
import { useRequirements } from './useRequirements.js';

export const RequirementsScreen = (): React.JSX.Element => {
  const { project, loading } = useProject();
  if (project === null) {
    // 현재 프로젝트를 아직 조회 중이면 문구 없이 기다린다 ("프로젝트 없음"이 잠깐 보이지 않게)
    return (
      <div
        className="requirements-screen"
        data-testid="requirements-screen"
        data-state={loading ? 'project-loading' : 'no-project'}
      >
        {!loading && <EmptyState text={TEXT.noProject} />}
      </div>
    );
  }
  // 프로젝트가 바뀌면 고른 항목 · 입력 줄 · 목록을 새로 시작한다(이전 프로젝트 목록을 보이지 않음)
  return <RequirementsPanes key={project.id} projectId={project.id} />;
};

const RequirementsPanes = ({ projectId }: { projectId: string }): React.JSX.Element => {
  const { load, create } = useRequirements(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inputOpen, setInputOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const items = load.state === 'ready' ? load.items : [];
  // 목록에서 사라진 항목은 고른 것으로 보지 않는다
  const selected = items.find((item) => item.id === selectedId) ?? null;

  const submit = useCallback(
    async (text: string): Promise<void> => {
      await create(text);
      setInputOpen(false);
    },
    [create],
  );
  const select = useCallback((item: Requirement) => setSelectedId(item.id), []);

  return (
    <div className="requirements-screen" data-testid="requirements-screen" data-state={load.state}>
      <div className="requirements-list-pane" data-testid="requirements-list-pane">
        {load.state === 'loading' && (
          <div
            className="requirements-loading"
            data-testid="requirements-loading"
            aria-busy="true"
          />
        )}
        {load.state === 'error' && (
          <p className="empty-state" data-testid="requirements-load-error" role="alert">
            {TEXT.loadFailed}
          </p>
        )}
        {load.state === 'ready' && (
          <ListView
            listId={REQUIREMENTS_LIST_ID}
            label={TEXT.list}
            items={items}
            itemKey={requirementKey}
            card={requirementCard}
            criteria={REQUIREMENT_CRITERIA}
            emptyText={TEXT.empty}
            selectedKey={selected?.id ?? null}
            onSelect={select}
            actions={
              <button
                type="button"
                className="list-action"
                data-testid="new-requirement-button"
                aria-expanded={inputOpen}
                onClick={() => {
                  if (inputOpen) inputRef.current?.focus();
                  else setInputOpen(true);
                }}
              >
                <Plus className="inline-icon" aria-hidden="true" />
                <span>{TEXT.newButton}</span>
              </button>
            }
            leading={
              inputOpen && (
                <NewRequirementInput
                  inputRef={inputRef}
                  onSubmit={submit}
                  onCancel={() => setInputOpen(false)}
                />
              )
            }
          />
        )}
      </div>
      <section
        className="requirements-detail"
        data-testid="requirement-detail"
        aria-label={TEXT.detail}
        data-selected-id={selected?.id ?? ''}
      >
        {selected === null && <EmptyState text={TEXT.noSelection} />}
      </section>
    </div>
  );
};
