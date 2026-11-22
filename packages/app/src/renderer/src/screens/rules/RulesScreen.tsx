// 규칙 화면 (screens.md SCR-03): 중앙 목록 + 상세 2단.
// - 목록: rule.list 결과(효력 있는 규칙 + 폐기된 규칙 + 최신 판정)만 그린다(NFR-03). 카드 · 필터 규칙은 rulesView.ts.
//   폐기된 규칙은 [폐기 포함]을 켜야 목록에 보인다(ADR-100 명세 변경 목록 SCR-03, M7-15 · ADR-114)
// - 상세(SCR-06 규범 상세, norm-detail/RuleDetail): 카드를 고르면 진술 · 테스트 실행 결과 · 테스트 출력(접힘) · 실행 이력.
//   고른 항목이 없으면 "선택 항목 없음"
// - [실행](RunStart): 고른 규칙의 상세 머리에 있다. 누르면 실행 시작 확인 대화 → [시작]이면 run.create (ADR-076).
//   고른 항목이 없으면 없다
// - 실행 알림(event.run.updated · event.step.updated)을 받으면 목록을 다시 읽는다(useRules, ADR-076)
// - 상세의 [편집] · [확인]이 저장되면 응답으로 목록 항목을 바꾼다(카드의 옛 제목 · 미확인을 남기지 않음, M7-03 · M7-15)
// - 상세의 대체 규칙 · 판단 대상 링크를 누르면 그 규칙을 고른다. 폐기된 규칙이면 [폐기 포함]을 켜서 카드도 보이게 한다.
//   폐기된 규칙의 상세에는 [실행]이 없다(효력 없는 규칙의 실행은 승인 단계에서 끝난다, ADR-107)
// - 상태(ADR-060, ADR-053과 같음): 프로젝트 조회 중 = 비움 · 프로젝트 없음 = "프로젝트 없음" ·
//   로딩 = 목록 자리 비움(문구 · 스켈레톤 없음) · 불러오기 실패 = "규칙 불러오기 실패" · 0건 = "규칙 없음"(ADR-029)
import './RulesScreen.css';

import type { RuleWithJudgment } from '@bive/shared';
import { useCallback, useState } from 'react';

import { useListFilter } from '../../components/ListView/filterStore.js';
import { ListView } from '../../components/ListView/ListView.js';
import { EmptyState } from '../../layout/EmptyState.js';
import { useProject } from '../../project/ProjectContext.js';
import { RuleDetail } from '../norm-detail/RuleDetail.js';
import { CreatedRunStatus } from './CreatedRunStatus.js';
import { type CreatedRun, RunStart } from './RunStart.js';
import {
  isRetiredRule,
  RETIRED_HIDDEN,
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
  const { load, replace } = useRules(projectId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // [실행]으로 만든 마지막 실행과 그 대상 규칙 (그 규칙의 상세에서만 보인다, ADR-105)
  const [created, setCreated] = useState<{ ruleId: string; run: CreatedRun } | null>(null);

  const items = load.state === 'ready' ? load.items : [];
  // 목록에서 사라진 항목은 고른 것으로 보지 않는다
  const selected = items.find((item) => item.rule.id === selectedId) ?? null;
  const select = useCallback((item: RuleWithJudgment) => setSelectedId(item.rule.id), []);
  const [, setFilter] = useListFilter(RULES_LIST_ID);
  const openRule = useCallback(
    (ruleId: string) => {
      const target = items.find((item) => item.rule.id === ruleId);
      if (target !== undefined && isRetiredRule(target)) {
        setFilter((prev) => (prev.includeHidden ? prev : { ...prev, includeHidden: true }));
      }
      setSelectedId(ruleId);
    },
    [items, setFilter],
  );

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
            hidden={RETIRED_HIDDEN}
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
        {selected === null ? (
          <EmptyState text={TEXT.noSelection} />
        ) : (
          // 규칙이 바뀌면 접힘 상태 · 불러온 이력을 새로 시작한다
          <RuleDetail
            key={selected.rule.id}
            projectId={projectId}
            item={selected}
            sourceScreen="SCR-03"
            onEdited={replace}
            onOpenRule={openRule}
            {...(!isRetiredRule(selected) && {
              actions: (
                <RunStart
                  projectId={projectId}
                  rule={selected.rule}
                  onCreated={(run) => setCreated({ ruleId: selected.rule.id, run })}
                />
              ),
            })}
            notice={
              created !== null && created.ruleId === selected.rule.id ? (
                <CreatedRunStatus key={created.run.id} projectId={projectId} run={created.run} />
              ) : null
            }
          />
        )}
      </section>
    </div>
  );
};
