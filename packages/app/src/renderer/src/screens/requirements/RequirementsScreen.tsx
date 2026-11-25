// 요구사항 화면 (screens.md SCR-02): 중앙 목록 + 상세 2단.
// - 목록: requirement.list 결과만 그린다(NFR-03). 카드 · 필터 규칙은 requirementsView.ts. 블록 칩의 값(구현 위치)은 rule.list
//   1회(규칙 화면과 같은 읽기 · 다시 읽기, useRules)에서 만든다. 규칙 목록을 읽는 동안은 목록 자리가 로딩이고(칩 값이 늦게 생겨
//   다른 화면이 정한 필터가 지워지지 않게), 읽지 못하면 블록 칩만 0건 비활성이다 (ADR-126)
// - [+ 새 요구사항]: 목록 맨 위 입력 줄 → requirement.create 1회 → 목록 다시 불러오기
//   (저장 뒤 규칙 제안은 오케스트레이터 쪽 이슈 #21이 붙인다. 화면은 호출만 한다)
// - 상세(SCR-06 규범 상세, norm-detail/RequirementDetail): 본문 · 생성 주체 · 자식 규칙(그 자리에서 펼침) · 직접 편집 ·
//   삭제(두 번 눌러 확인). 편집 · 삭제 뒤 목록을 다시 불러온다. 고른 항목이 없거나 삭제되면 "선택 항목 없음" (ADR-078)
// - 확인할 것 상세의 대상 링크로 열리면 그 요구사항의 카드를 고른 상태다(navigation/pendingSelection.ts, ADR-123)
// - 상태(ADR-053): 프로젝트 조회 중 = 비움 · 프로젝트 없음 = "프로젝트 없음" · 로딩 = 목록 자리 비움(문구 · 스켈레톤 없음) ·
//   불러오기 실패 = 목록 자리에 "요구사항 불러오기 실패" · 0건 = "요구사항 없음"(ADR-029)
import './RequirementsScreen.css';

import type { Requirement } from '@bive/shared';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ListView } from '../../components/ListView/ListView.js';
import { EmptyState } from '../../layout/EmptyState.js';
import { clearPendingSelection, peekPendingSelection } from '../../navigation/pendingSelection.js';
import { useProject } from '../../project/ProjectContext.js';
import { RequirementDetail } from '../norm-detail/RequirementDetail.js';
import { implementationBlocksByRequirement } from '../rules/blockView.js';
import { useRules } from '../rules/useRules.js';
import { NewRequirementInput } from './NewRequirementInput.js';
import {
  REQUIREMENTS_LIST_ID,
  requirementCard,
  requirementCriteria,
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
  const { load: requirementsLoad, create, update, remove } = useRequirements(projectId);
  const { load: rulesLoad } = useRules(projectId);
  // 규칙 목록을 읽는 동안은 목록 전체를 로딩으로 둔다(블록 칩 값이 아직 없어 지정된 선택이 지워지지 않게)
  const load =
    requirementsLoad.state === 'ready' && rulesLoad.state === 'loading'
      ? rulesLoad
      : requirementsLoad;
  const criteria = useMemo(
    () =>
      requirementCriteria(
        implementationBlocksByRequirement(rulesLoad.state === 'ready' ? rulesLoad.items : []),
      ),
    [rulesLoad],
  );
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
  // 다른 화면의 대상 링크로 열렸으면(이 이동 한 번만) 목록을 다 읽은 뒤 그 표시 ID의 카드를 고른다. 목록에 없으면(지워진
  // 요구사항) 고르지 않고, 읽기가 실패하거나 화면을 떠나면 버린다(ADR-123)
  const [wanted, setWanted] = useState(() => peekPendingSelection(REQUIREMENTS_LIST_ID));
  useEffect(() => {
    clearPendingSelection(REQUIREMENTS_LIST_ID);
  }, []);
  useEffect(() => {
    if (wanted === null || load.state === 'loading') return;
    if (load.state === 'ready') {
      setSelectedId(load.items.find((item) => item.displayId === wanted)?.id ?? null);
    }
    setWanted(null);
  }, [load, wanted]);

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
            criteria={criteria}
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
        {selected === null ? (
          <EmptyState text={TEXT.noSelection} />
        ) : (
          // 요구사항이 바뀌면 편집 · 삭제 확인 대기 · 펼침 상태를 새로 시작한다
          <RequirementDetail
            key={selected.id}
            projectId={projectId}
            requirement={selected}
            onUpdate={(text) => update(selected.id, text)}
            onDelete={() => remove(selected.id)}
          />
        )}
      </section>
    </div>
  );
};
