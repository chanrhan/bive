// 계약 화면 (screens.md SCR-04): 중앙 목록 + 상세 2단 (M3-05 #50 · ADR-133).
// - 목록: contract.list 결과와 검사 규칙의 최신 판정(rule.list)만 그린다(NFR-03). 카드 · 필터 규칙은 contractsView.ts
// - 상세(SCR-06 규범 상세, norm-detail/ContractDetail): 카드를 고르면 종류 · 원본 파일 · 연결 규칙 · 판정 · 부모 요구사항 ·
//   생성 주체 · 확인 상태. 고른 항목이 없으면 "선택 항목 없음"
// - 연결 규칙을 누르면 규칙 화면이 그 규칙을 고른 상태로 열린다(확인할 것의 대상 링크와 같은 방식, ADR-123)
// - [확인] · 신규 등록 지시 · 변경 지시는 없다(ADR-133)
// - 상태(ADR-060 · ADR-073과 같음): 프로젝트 조회 중 = 비움 · 프로젝트 없음 = "프로젝트 없음" ·
//   로딩 = 목록 자리 비움(문구 · 스켈레톤 없음) · 불러오기 실패 = "계약 불러오기 실패" · 0건 = "계약 없음"(ADR-029)
import './ContractsScreen.css';

import { useCallback, useState } from 'react';

import { EMPTY_FILTER, setListFilter } from '../../components/ListView/index.js';
import { ListView } from '../../components/ListView/ListView.js';
import { EmptyState } from '../../layout/EmptyState.js';
import { useNavigation } from '../../navigation/NavigationContext.js';
import { requestSelection } from '../../navigation/pendingSelection.js';
import { useProject } from '../../project/ProjectContext.js';
import { ContractDetail } from '../norm-detail/ContractDetail.js';
import { RULES_LIST_ID } from '../rules/rulesView.js';
import {
  CONTRACT_CRITERIA,
  type ContractItem,
  contractCard,
  contractKey,
  CONTRACTS_LIST_ID,
  contractSearchText,
  TEXT,
} from './contractsView.js';
import { useContracts } from './useContracts.js';

export const ContractsScreen = (): React.JSX.Element => {
  const { project, loading } = useProject();
  if (project === null) {
    // 현재 프로젝트를 아직 조회 중이면 문구 없이 기다린다 ("프로젝트 없음"이 잠깐 보이지 않게)
    return (
      <div
        className="contracts-screen"
        data-testid="contracts-screen"
        data-state={loading ? 'project-loading' : 'no-project'}
      >
        {!loading && <EmptyState text={TEXT.noProject} />}
      </div>
    );
  }
  // 프로젝트가 바뀌면 고른 항목 · 목록을 새로 시작한다(이전 프로젝트 목록을 보이지 않음)
  return <ContractsPanes key={project.id} projectId={project.id} />;
};

const ContractsPanes = ({ projectId }: { projectId: string }): React.JSX.Element => {
  const load = useContracts(projectId);
  const { navigate } = useNavigation();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const items = load.state === 'ready' ? load.items : [];
  // 목록에서 사라진 항목은 고른 것으로 보지 않는다
  const selected = items.find((item) => item.contract.id === selectedId) ?? null;
  const select = useCallback((item: ContractItem) => setSelectedId(item.contract.id), []);
  const openRule = useCallback(
    (rule: { displayId: string }) => {
      requestSelection(RULES_LIST_ID, rule.displayId);
      setListFilter(RULES_LIST_ID, { ...EMPTY_FILTER, query: rule.displayId });
      navigate('rules');
    },
    [navigate],
  );

  return (
    <div className="contracts-screen" data-testid="contracts-screen" data-state={load.state}>
      <div className="contracts-list-pane" data-testid="contracts-list-pane">
        {load.state === 'loading' && (
          <div className="contracts-loading" data-testid="contracts-loading" aria-busy="true" />
        )}
        {load.state === 'error' && (
          <p className="empty-state" data-testid="contracts-load-error" role="alert">
            {TEXT.loadFailed}
          </p>
        )}
        {load.state === 'ready' && (
          <ListView
            listId={CONTRACTS_LIST_ID}
            label={TEXT.list}
            items={items}
            itemKey={contractKey}
            card={contractCard}
            searchText={contractSearchText}
            criteria={CONTRACT_CRITERIA}
            emptyText={TEXT.empty}
            selectedKey={selected?.contract.id ?? null}
            onSelect={select}
          />
        )}
      </div>
      <section
        className="contracts-detail"
        data-testid="contract-detail"
        aria-label={TEXT.detail}
        data-selected-id={selected?.contract.id ?? ''}
      >
        {selected === null ? (
          <EmptyState text={TEXT.noSelection} />
        ) : (
          <ContractDetail
            key={selected.contract.id}
            projectId={projectId}
            item={selected}
            onOpenRule={openRule}
          />
        )}
      </section>
    </div>
  );
};
