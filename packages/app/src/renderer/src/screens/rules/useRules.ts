// 규칙 목록 불러오기 (RPC `rule.list`, ADR-060). 요구사항 화면(useRequirements.ts)과 같은 규칙이다.
// - 프로젝트가 바뀌면 다시 불러오고, 그동안은 로딩이다(이전 프로젝트 목록을 보이지 않음)
// - 늦게 온 이전 요청의 결과는 버린다
import type { RuleWithJudgment } from '@bive/shared';
import { useEffect, useState } from 'react';

import { visibleRules } from './rulesView.js';

export type RulesLoad =
  { state: 'loading' } | { state: 'ready'; items: RuleWithJudgment[] } | { state: 'error' };

const LOADING: RulesLoad = { state: 'loading' };

export const useRules = (projectId: string): RulesLoad => {
  // 어느 프로젝트의 결과인지 함께 둬서 프로젝트가 바뀐 직후 이전 목록을 보이지 않게 한다
  const [loaded, setLoaded] = useState<{ projectId: string; load: RulesLoad } | null>(null);

  useEffect(() => {
    let active = true;
    window.bive.invoke('rule.list', { projectId }).then(
      ({ rules }) => {
        if (active) setLoaded({ projectId, load: { state: 'ready', items: visibleRules(rules) } });
      },
      () => {
        if (active) setLoaded({ projectId, load: { state: 'error' } });
      },
    );
    return () => {
      active = false;
    };
  }, [projectId]);

  return loaded !== null && loaded.projectId === projectId ? loaded.load : LOADING;
};
