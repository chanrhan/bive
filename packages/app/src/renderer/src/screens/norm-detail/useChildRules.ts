// 요구사항 상세의 자식 규칙 (RPC `rule.list` → 부모가 이 요구사항인 규칙, NFR-03: 값은 RPC 결과에서만).
// - 요구사항이 바뀌면 다시 읽고, 그동안은 로딩이다(다른 요구사항의 자식을 보이지 않음)
// - 같은 요구사항이 바뀌면(`updatedAt`, 직접 편집 저장 뒤) 지금 목록을 둔 채 다시 읽는다
// - 늦게 온 이전 응답은 버린다
// - `replace`: 펼친 자식 규칙의 직접 편집이 저장되면 응답의 규칙으로 그 항목을 바꾼다(옛 제목을 남기지 않음, M7-03).
//   그 전에 보낸 요청의 결과는 편집 전 값일 수 있어 버리고, 버린 요청이 있었으면 한 번 다시 읽는다
// - 규범 변경 알림(규칙 작성 세션의 새 규칙 · 폐기 · 대체, M7-14 · ADR-119) · 재접속에는 스스로 읽지 않는다: 요구사항 화면의 규칙
//   목록(`listed`, `rule.list {includeRetired: true}`, 블록 칩)이 그 알림에 다시 읽은 결과에서 폐기되지 않은 자식 규칙을 골라 쓴다
//   (알림 하나에 `rule.list` 한 번, M3-42 #283 · ADR-135). 폐기 포함 목록의 폐기되지 않은 항목(`retirement` 칸 없음)은 기본 조회
//   (`rule.list {projectId}`)의 항목과 같다. 그 결과를 쓰면 기다리던 요청(열 때 · 편집 뒤)의 응답은 버리고 한 번 다시 읽는다
// 실행 알림은 구독하지 않는다: 펼친 자식 규칙의 판정은 다시 들어올 때까지 낡을 수 있다(ADR-078 한계)
import type { RuleWithJudgment } from '@bive/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { replaceRuleItem } from '../rules/rulesView.js';
import type { RulesLoad } from '../rules/useRules.js';

import { childRulesOf } from './requirementDetailView.js';

export type ChildRulesLoad =
  { state: 'loading' } | { state: 'ready'; items: RuleWithJudgment[] } | { state: 'error' };

const LOADING: ChildRulesLoad = { state: 'loading' };

export interface ChildRulesState {
  load: ChildRulesLoad;
  /** 같은 ID의 자식 규칙을 바꾼다 (직접 편집 저장 뒤) */
  replace: (item: RuleWithJudgment) => void;
}

/** 폐기 포함 규칙 목록에서 폐기되지 않은 것 (기본 `rule.list`가 돌려주는 항목, ADR-114). */
const unretired = (items: readonly RuleWithJudgment[]): RuleWithJudgment[] =>
  items.filter((item) => item.retirement === undefined);

/**
 * `listed`: 요구사항 화면이 읽는 규칙 목록(폐기 포함, 규범 변경 알림 · 재접속 때 다시 읽음). 상세가 열린 뒤 이 값이 바뀌면 그것을
 * 자식 규칙으로 쓴다(상세가 열릴 때 이미 있던 값은 쓰지 않고 직접 읽는다).
 */
export const useChildRules = (
  projectId: string,
  requirementId: string,
  updatedAt: string,
  listed: RulesLoad,
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

  // 화면의 규칙 목록이 다시 읽혔으면(규범 변경 알림 · 재접속) 그 결과에서 자식 규칙을 고른다. 상세가 열릴 때의 값은 건너뛴다
  const seenListed = useRef(listed);
  useEffect(() => {
    if (seenListed.current === listed) return;
    seenListed.current = listed;
    if (listed.state === 'loading') return;
    // 기다리던 요청(열 때 · 편집 뒤)의 응답은 이 목록보다 옛 값일 수 있어 버린다: 바꾼 횟수를 올려 다시 렌더되기 전에 그 응답이
    // 도착해도 그리지 않고, 위 효과를 다시 돌려 한 번 더 읽는다(다시 읽은 값이 마지막에 남는다)
    replaced.current += 1;
    const dropped = inFlight.current;
    setLoaded({
      requirementId,
      load:
        listed.state === 'error'
          ? { state: 'error' }
          : { state: 'ready', items: childRulesOf(requirementId, unretired(listed.items)) },
    });
    if (dropped) setReload((n) => n + 1);
  }, [listed, requirementId]);

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
