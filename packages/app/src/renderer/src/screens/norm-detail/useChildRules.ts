// 요구사항 상세의 자식 규칙 (RPC `rule.list` → 부모가 이 요구사항인 규칙, NFR-03: 값은 RPC 결과에서만).
// - 요구사항이 바뀌면 다시 읽고, 그동안은 로딩이다(다른 요구사항의 자식을 보이지 않음)
// - 같은 요구사항이 바뀌면(`updatedAt`, 직접 편집 저장 뒤) 지금 목록을 둔 채 다시 읽는다
// - 늦게 온 이전 응답은 버린다
// 실행 알림은 구독하지 않는다: 펼친 자식 규칙의 판정은 다시 들어올 때까지 낡을 수 있다(ADR-078 한계)
import type { RuleWithJudgment } from '@bive/shared';
import { useEffect, useState } from 'react';

import { childRulesOf } from './requirementDetailView.js';

export type ChildRulesLoad =
  { state: 'loading' } | { state: 'ready'; items: RuleWithJudgment[] } | { state: 'error' };

const LOADING: ChildRulesLoad = { state: 'loading' };

export const useChildRules = (
  projectId: string,
  requirementId: string,
  updatedAt: string,
): ChildRulesLoad => {
  const [loaded, setLoaded] = useState<{ requirementId: string; load: ChildRulesLoad } | null>(
    null,
  );

  useEffect(() => {
    let live = true;
    window.bive.invoke('rule.list', { projectId }).then(
      ({ rules }) => {
        if (live) {
          setLoaded({
            requirementId,
            load: { state: 'ready', items: childRulesOf(requirementId, rules) },
          });
        }
      },
      () => {
        if (live) setLoaded({ requirementId, load: { state: 'error' } });
      },
    );
    return () => {
      live = false;
    };
    // 수정 시각은 다시 읽는 계기로만 쓴다
  }, [projectId, requirementId, updatedAt]);

  return loaded !== null && loaded.requirementId === requirementId ? loaded.load : LOADING;
};
