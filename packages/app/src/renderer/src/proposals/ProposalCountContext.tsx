// 할 일 배지용 승인 대기 건수 (screens.md 6장 할 일, TODO-01, ADR-056).
// - 현재 프로젝트의 `proposal.count`를 부른다. 프로젝트가 없으면 부르지 않고 null
// - 조회 시점: 프로젝트가 바뀔 때 · 화면(경로)에 들어갈 때 · 명시적 refresh() (승인 · 거절 처리 뒤, #40)
// - 폴링 · 이벤트 구독은 하지 않는다 (제안 알림 이벤트가 생기면 그 이슈가 구독을 더한다)
// - 늦게 도착한 이전 조회 결과는 버린다. 실패하면 null (근거 없는 값 미표시, NFR-03)
import type { ProposalCountResult } from '@bive/shared';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useNavigation } from '../navigation/NavigationContext.js';
import { useProject } from '../project/ProjectContext.js';

export interface ProposalCountView {
  /** 현재 프로젝트의 마지막 조회 결과. 프로젝트 없음 · 조회 전 · 실패면 null */
  count: ProposalCountResult | null;
  /** 지금 다시 조회한다. 끝나면(성공 · 실패 모두) 풀린다. 거부하지 않는다 */
  refresh(): Promise<void>;
}

const ProposalCountContext = createContext<ProposalCountView | null>(null);

interface Stored {
  projectId: string;
  value: ProposalCountResult;
}

export const ProposalCountProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const { project } = useProject();
  const { route } = useNavigation();
  const projectId = project?.id ?? null;
  const [stored, setStored] = useState<Stored | null>(null);
  // 마지막 요청 번호. 응답이 왔을 때 번호가 다르면 더 새 요청이 있으므로 버린다
  const seq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    seq.current += 1;
    const mine = seq.current;
    if (projectId === null) {
      setStored(null);
      return;
    }
    try {
      const value = await window.bive.invoke('proposal.count', { projectId });
      if (seq.current === mine) setStored({ projectId, value });
    } catch {
      if (seq.current === mine) setStored(null);
    }
  }, [projectId]);

  // 프로젝트가 바뀌거나 화면에 들어갈 때 다시 조회한다 (route는 조회 계기로만 쓴다)
  useEffect(() => {
    void refresh();
  }, [refresh, route]);

  // 사라진 뒤 도착한 응답은 버린다
  useEffect(
    () => () => {
      seq.current += 1;
    },
    [],
  );

  const count = stored !== null && stored.projectId === projectId ? stored.value : null;
  const value = useMemo<ProposalCountView>(() => ({ count, refresh }), [count, refresh]);
  return <ProposalCountContext.Provider value={value}>{children}</ProposalCountContext.Provider>;
};

/** 승인 대기 건수와 재조회 함수. ProposalCountProvider(AppLayout) 안에서만 부른다. */
export const useProposalCount = (): ProposalCountView => {
  const value = useContext(ProposalCountContext);
  if (value === null) throw new Error('ProposalCountProvider 밖에서 useProposalCount 호출');
  return value;
};
