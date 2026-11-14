// 규칙 목록 불러오기 (RPC `rule.list`, ADR-060). 요구사항 화면(useRequirements.ts)과 같은 규칙이다.
// - 프로젝트가 바뀌면 다시 불러오고, 그동안은 로딩이다(이전 프로젝트 목록을 보이지 않음)
// - 실행 알림을 받으면 지금 목록을 둔 채 다시 불러온다 (M1-19, ADR-076, useRunEventRefresh)
// - 늦게 온 이전 요청의 결과는 버린다(마지막으로 보낸 요청의 결과만 쓴다)
import type { RuleWithJudgment } from '@bive/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useRunEventRefresh } from '../../runs/useRunEventRefresh.js';
import { visibleRules } from './rulesView.js';

export type RulesLoad =
  { state: 'loading' } | { state: 'ready'; items: RuleWithJudgment[] } | { state: 'error' };

const LOADING: RulesLoad = { state: 'loading' };

export const useRules = (projectId: string): RulesLoad => {
  // 어느 프로젝트의 결과인지 함께 둬서 프로젝트가 바뀐 직후 이전 목록을 보이지 않게 한다
  const [loaded, setLoaded] = useState<{ projectId: string; load: RulesLoad } | null>(null);
  // 마지막 요청 번호. 응답이 왔을 때 번호가 다르면 더 새 요청이 있으므로 버린다
  const seq = useRef(0);

  const fetchRules = useCallback((): Promise<void> => {
    seq.current += 1;
    const mine = seq.current;
    return window.bive.invoke('rule.list', { projectId }).then(
      ({ rules }) => {
        if (seq.current === mine) {
          setLoaded({ projectId, load: { state: 'ready', items: visibleRules(rules) } });
        }
      },
      () => {
        if (seq.current === mine) setLoaded({ projectId, load: { state: 'error' } });
      },
    );
  }, [projectId]);

  useEffect(() => {
    void fetchRules();
    return () => {
      // 프로젝트가 바뀌거나 사라진 뒤 도착한 응답은 버린다
      seq.current += 1;
    };
  }, [fetchRules]);

  useRunEventRefresh(projectId, fetchRules);

  return loaded !== null && loaded.projectId === projectId ? loaded.load : LOADING;
};
