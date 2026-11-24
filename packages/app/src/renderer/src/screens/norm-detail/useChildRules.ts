// 요구사항 상세의 자식 규칙 (RPC `rule.list` → 부모가 이 요구사항인 규칙, NFR-03: 값은 RPC 결과에서만).
// - 요구사항이 바뀌면 다시 읽고, 그동안은 로딩이다(다른 요구사항의 자식을 보이지 않음)
// - 같은 요구사항이 바뀌면(`updatedAt`, 직접 편집 저장 뒤) 지금 목록을 둔 채 다시 읽는다
// - 늦게 온 이전 응답은 버린다
// - `replace`: 펼친 자식 규칙의 직접 편집이 저장되면 응답의 규칙으로 그 항목을 바꾼다(옛 제목을 남기지 않음, M7-03).
//   그 전에 보낸 요청의 결과는 편집 전 값일 수 있어 버리고, 버린 요청이 있었으면 한 번 다시 읽는다
// - 규범 변경 알림(규칙 작성 세션의 새 규칙 · 폐기 · 대체, M7-14 · ADR-119)을 받으면 지금 목록을 둔 채 다시 읽는다
// 실행 알림은 구독하지 않는다: 펼친 자식 규칙의 판정은 다시 들어올 때까지 낡을 수 있다(ADR-078 한계)
import type { RuleWithJudgment } from '@bive/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { NORM_CHANGE_EVENT_NAMES } from '../../runs/refreshCoalescer.js';
import { useEventRefresh } from '../../runs/useEventRefresh.js';
import { replaceRuleItem } from '../rules/rulesView.js';

import { childRulesOf } from './requirementDetailView.js';

export type ChildRulesLoad =
  { state: 'loading' } | { state: 'ready'; items: RuleWithJudgment[] } | { state: 'error' };

const LOADING: ChildRulesLoad = { state: 'loading' };

export interface ChildRulesState {
  load: ChildRulesLoad;
  /** 같은 ID의 자식 규칙을 바꾼다 (직접 편집 저장 뒤) */
  replace: (item: RuleWithJudgment) => void;
}

export const useChildRules = (
  projectId: string,
  requirementId: string,
  updatedAt: string,
): ChildRulesState => {
  const [loaded, setLoaded] = useState<{ requirementId: string; load: ChildRulesLoad } | null>(
    null,
  );
  // 바꾼 횟수. 요청을 보낸 뒤 바뀌었으면 그 응답은 편집 전 값일 수 있어 버린다
  const replaced = useRef(0);
  // 응답을 기다리는 요청이 있는지, 다시 읽기 계기
  const inFlight = useRef(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    const mine = replaced.current;
    inFlight.current = true;
    window.bive.invoke('rule.list', { projectId }).then(
      ({ rules }) => {
        if (live) inFlight.current = false;
        if (live && replaced.current === mine) {
          setLoaded({
            requirementId,
            load: { state: 'ready', items: childRulesOf(requirementId, rules) },
          });
        }
      },
      () => {
        if (live) inFlight.current = false;
        if (live) setLoaded({ requirementId, load: { state: 'error' } });
      },
    );
    return () => {
      live = false;
    };
    // 수정 시각 · 다시 읽기 번호는 다시 읽는 계기로만 쓴다
  }, [projectId, requirementId, updatedAt, reload]);

  // 규범 변경 알림: 다시 읽기 번호만 올린다(위 효과가 읽는다. 늦게 온 이전 응답은 위에서 버린다)
  const refreshOnNormChange = useCallback((): Promise<void> => {
    setReload((n) => n + 1);
    return Promise.resolve();
  }, []);
  useEventRefresh(projectId, NORM_CHANGE_EVENT_NAMES, refreshOnNormChange);

  const replace = useCallback(
    (item: RuleWithJudgment): void => {
      replaced.current += 1;
      const dropped = inFlight.current;
      setLoaded((current) =>
        current === null ||
        current.requirementId !== requirementId ||
        current.load.state !== 'ready'
          ? current
          : {
              requirementId,
              load: {
                state: 'ready',
                items: childRulesOf(requirementId, replaceRuleItem(current.load.items, item)),
              },
            },
      );
      if (dropped) setReload((n) => n + 1);
    },
    [requirementId],
  );

  return {
    load: loaded !== null && loaded.requirementId === requirementId ? loaded.load : LOADING,
    replace,
  };
};
