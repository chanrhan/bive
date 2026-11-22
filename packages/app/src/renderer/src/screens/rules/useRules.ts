// 규칙 목록 불러오기 (RPC `rule.list`, ADR-060). 요구사항 화면(useRequirements.ts)과 같은 규칙이다.
// - 폐기된 규칙도 함께 읽는다(`includeRetired: true`). 기본 목록에서 숨기는 것은 목록의 [폐기 포함]이다(M7-15, ADR-114)
// - 프로젝트가 바뀌면 다시 불러오고, 그동안은 로딩이다(이전 프로젝트 목록을 보이지 않음)
// - 실행 알림을 받으면 지금 목록을 둔 채 다시 불러온다 (M1-19, ADR-076, useRunEventRefresh)
// - 늦게 온 이전 요청의 결과는 버린다(마지막으로 보낸 요청의 결과만 쓴다)
// - `replace`: 규칙 상세의 직접 편집이 저장되면 응답의 규칙으로 목록의 그 항목을 바꾼다(옛 제목 · 진술을 남기지 않음, M7-03).
//   그 전에 보낸 요청의 결과는 편집 전 값일 수 있어 버리고, 버린 요청이 있었으면 한 번 다시 읽는다(실행 알림의 새로고침을 잃지 않게)
import type { RuleWithJudgment } from '@bive/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useRunEventRefresh } from '../../runs/useRunEventRefresh.js';
import { replaceRuleItem, visibleRules } from './rulesView.js';

export type RulesLoad =
  { state: 'loading' } | { state: 'ready'; items: RuleWithJudgment[] } | { state: 'error' };

const LOADING: RulesLoad = { state: 'loading' };

export interface RulesState {
  load: RulesLoad;
  /** 목록의 같은 ID 항목을 바꾼다 (직접 편집 저장 뒤) */
  replace: (item: RuleWithJudgment) => void;
}

export const useRules = (projectId: string): RulesState => {
  // 어느 프로젝트의 결과인지 함께 둬서 프로젝트가 바뀐 직후 이전 목록을 보이지 않게 한다
  const [loaded, setLoaded] = useState<{ projectId: string; load: RulesLoad } | null>(null);
  // 마지막 요청 번호. 응답이 왔을 때 번호가 다르면 더 새 요청이 있으므로 버린다
  const seq = useRef(0);
  // 응답을 기다리는 요청 번호 (없으면 0)
  const inFlight = useRef(0);

  const fetchRules = useCallback((): Promise<void> => {
    seq.current += 1;
    const mine = seq.current;
    inFlight.current = mine;
    const settle = (): void => {
      if (inFlight.current === mine) inFlight.current = 0;
    };
    return window.bive.invoke('rule.list', { projectId, includeRetired: true }).then(
      ({ rules }) => {
        settle();
        if (seq.current === mine) {
          setLoaded({ projectId, load: { state: 'ready', items: visibleRules(rules) } });
        }
      },
      () => {
        settle();
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

  const replace = useCallback(
    (item: RuleWithJudgment): void => {
      // 이미 보낸 요청의 결과(편집 전 값일 수 있음)는 버리고, 버린 요청이 있었으면 아래에서 다시 읽는다
      const dropped = inFlight.current !== 0;
      seq.current += 1;
      inFlight.current = 0;
      setLoaded((current) =>
        current === null || current.projectId !== projectId || current.load.state !== 'ready'
          ? current
          : {
              projectId,
              load: {
                state: 'ready',
                items: visibleRules(replaceRuleItem(current.load.items, item)),
              },
            },
      );
      if (dropped) void fetchRules();
    },
    [projectId, fetchRules],
  );

  return {
    load: loaded !== null && loaded.projectId === projectId ? loaded.load : LOADING,
    replace,
  };
};
