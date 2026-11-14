// 규칙 상세가 목록 항목 밖에서 더 읽는 값 (SCR-03 상세 · SCR-06, NFR-03: 값은 RPC 결과에서만).
// - 실행 이력: `rule.judgments` 1회 → 판정 기록(최신부터) + 실행 표시 ID (ADR-073)
// - 부모 요구사항: 부모가 있으면 `requirement.get` 1회 → 표시 ID · 문장. 실패하면 보이지 않는다
// 규칙이 바뀌면 다시 읽고, 늦게 온 이전 응답은 버린다.
import type { Requirement, RuleJudgmentEntry } from '@bive/shared';
import { useEffect, useState } from 'react';

export type RuleHistoryLoad =
  { state: 'loading' } | { state: 'ready'; entries: RuleJudgmentEntry[] } | { state: 'error' };

const LOADING: RuleHistoryLoad = { state: 'loading' };

export const useRuleHistory = (projectId: string, ruleId: string): RuleHistoryLoad => {
  const [loaded, setLoaded] = useState<{ ruleId: string; load: RuleHistoryLoad } | null>(null);

  useEffect(() => {
    let live = true;
    window.bive.invoke('rule.judgments', { projectId, id: ruleId }).then(
      ({ judgments }) => {
        if (live) setLoaded({ ruleId, load: { state: 'ready', entries: judgments } });
      },
      () => {
        if (live) setLoaded({ ruleId, load: { state: 'error' } });
      },
    );
    return () => {
      live = false;
    };
  }, [projectId, ruleId]);

  return loaded !== null && loaded.ruleId === ruleId ? loaded.load : LOADING;
};

/** 규칙의 부모 요구사항. 부모가 없거나(해제됨) 조회 전 · 실패면 null. */
export const useRuleParent = (projectId: string, parentId: string | null): Requirement | null => {
  const [loaded, setLoaded] = useState<Requirement | null>(null);

  useEffect(() => {
    if (parentId === null) return undefined;
    let live = true;
    window.bive.invoke('requirement.get', { projectId, id: parentId }).then(
      ({ requirement }) => {
        if (live) setLoaded(requirement);
      },
      () => {
        // 실패하면 부모 줄을 보이지 않는다
      },
    );
    return () => {
      live = false;
    };
  }, [projectId, parentId]);

  return loaded !== null && loaded.id === parentId ? loaded : null;
};
