// 규칙 화면 (screens.md SCR-03): 중앙 목록 + 상세 2단.
// - 목록: rule.list 결과(승인된 규칙 + 최신 판정)만 그린다(NFR-03). 카드 · 필터 규칙은 rulesView.ts
// - 상세 자리: 진술 · 테스트 실행 결과 · 실행 이력은 이슈 #41. 지금은 빈 틀이고 고른 항목이 없으면 "선택 항목 없음"
// - [실행]은 실행 시작 확인 이슈(#32)가 연다. 그 전에는 미노출 (ADR-035)
// - 상태(ADR-060, ADR-053과 같음): 프로젝트 조회 중 = 비움 · 프로젝트 없음 = "프로젝트 없음" ·
//   로딩 = 목록 자리 비움(문구 · 스켈레톤 없음) · 불러오기 실패 = "규칙 불러오기 실패" · 0건 = "규칙 없음"(ADR-029)
import './RulesScreen.css';

import type { RuleWithJudgment } from '@bive/shared';
import { useCallback, useState } from 'react';

import { ListView } from '../../components/ListView/ListView.js';
import { EmptyState } from '../../layout/EmptyState.js';
import { useProject } from '../../project/ProjectContext.js';
import {
  RULE_CRITERIA,
  RULES_LIST_ID,
  ruleCard,
  ruleKey,
  ruleSearchText,
  TEXT,
} from './rulesView.js';
import { useRules } from './useRules.js';

export const RulesScreen = (): React.JSX.Element => {
  const { project, loading } = useProject();
  if (project === null) {
    // 현재 프로젝트를 아직 조회 중이면 문구 없이 기다린다 ("프로젝트 없음"이 잠깐 보이지 않게)
    return (
      <div
        className="rules-screen"
        data-testid="rules-screen"
        data-state={loading ? 'project-loading' : 'no-project'}
      >
        {!loading && <EmptyState text={TEXT.noProject} />}
      </div>
    );
  }
  // 프로젝트가 바뀌면 고른 항목 · 목록을 새로 시작한다(이전 프로젝트 목록을 보이지 않음)
  return <RulesPanes key={project.id} projectId={project.id} />;
};

const RulesPanes = ({ projectId }: { projectId: string }): React.JSX.Element => {
  const load = useRules(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const items = load.state === 'ready' ? load.items : [];
  // 목록에서 사라진 항목은 고른 것으로 보지 않는다
  const selected = items.find((item) => item.rule.id === selectedId) ?? null;
  const select = useCallback((item: RuleWithJudgment) => setSelectedId(item.rule.id), []);

  return (
    <div className="rules-screen" data-testid="rules-screen" data-state={load.state}>
      <div className="rules-list-pane" data-testid="rules-list-pane">
        {load.state === 'loading' && (
          <div className="rules-loading" data-testid="rules-loading" aria-busy="true" />
        )}
        {load.state === 'error' && (
          <p className="empty-state" data-testid="rules-load-error" role="alert">
            {TEXT.loadFailed}
          </p>
        )}
        {load.state === 'ready' && (
          <ListView
            listId={RULES_LIST_ID}
            label={TEXT.list}
            items={items}
            itemKey={ruleKey}
            card={ruleCard}
            searchText={ruleSearchText}
            criteria={RULE_CRITERIA}
            emptyText={TEXT.empty}
            selectedKey={selected?.rule.id ?? null}
            onSelect={select}
          />
        )}
      </div>
      <section
        className="rules-detail"
        data-testid="rule-detail"
        aria-label={TEXT.detail}
        data-selected-id={selected?.rule.id ?? ''}
      >
        {selected === null && <EmptyState text={TEXT.noSelection} />}
      </section>
    </div>
  );
};
