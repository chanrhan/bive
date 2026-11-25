// 계약 목록 불러오기 (RPC `contract.list` + `rule.list`, M3-05 #50 · ADR-133). 규칙 목록(useRules.ts)과 같은 규칙이다.
// - 계약과 그 검사 규칙의 최신 판정을 함께 읽는다. 둘 중 하나라도 실패하면 불러오기 실패다(판정을 모른 채 결함 없는 목록처럼
//   보이지 않게)
// - 프로젝트가 바뀌면 다시 불러오고, 그동안은 로딩이다(이전 프로젝트 목록을 보이지 않음)
// - 실행 알림 · 규범 변경 알림(계약 등록의 검사 규칙 생성 기록 포함)과 재접속 때 지금 목록을 둔 채 다시 불러온다
// - 늦게 온 이전 요청의 결과는 버린다(마지막으로 보낸 요청의 결과만 쓴다)
import { useCallback, useEffect, useRef, useState } from 'react';

import { NORM_VIEW_EVENT_NAMES } from '../../runs/refreshCoalescer.js';
import { useEventRefresh } from '../../runs/useEventRefresh.js';
import { type ContractItem, contractItems } from './contractsView.js';

export type ContractsLoad =
  { state: 'loading' } | { state: 'ready'; items: ContractItem[] } | { state: 'error' };

const LOADING: ContractsLoad = { state: 'loading' };

export const useContracts = (projectId: string): ContractsLoad => {
  // 어느 프로젝트의 결과인지 함께 둬서 프로젝트가 바뀐 직후 이전 목록을 보이지 않게 한다
  const [loaded, setLoaded] = useState<{ projectId: string; load: ContractsLoad } | null>(null);
  // 마지막 요청 번호. 응답이 왔을 때 번호가 다르면 더 새 요청이 있으므로 버린다
  const seq = useRef(0);

  const fetchContracts = useCallback((): Promise<void> => {
    seq.current += 1;
    const mine = seq.current;
    return Promise.all([
      window.bive.invoke('contract.list', { projectId }),
      window.bive.invoke('rule.list', { projectId }),
    ]).then(
      ([{ contracts }, { rules }]) => {
        if (seq.current === mine) {
          setLoaded({
            projectId,
            load: { state: 'ready', items: contractItems(contracts, rules) },
          });
        }
      },
      () => {
        if (seq.current === mine) setLoaded({ projectId, load: { state: 'error' } });
      },
    );
  }, [projectId]);

  useEffect(() => {
    void fetchContracts();
    return () => {
      // 프로젝트가 바뀌거나 사라진 뒤 도착한 응답은 버린다
      seq.current += 1;
    };
  }, [fetchContracts]);

  useEventRefresh(projectId, NORM_VIEW_EVENT_NAMES, fetchContracts);

  return loaded !== null && loaded.projectId === projectId ? loaded.load : LOADING;
};
