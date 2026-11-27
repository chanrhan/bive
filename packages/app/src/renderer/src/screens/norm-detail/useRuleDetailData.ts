// 규칙 상세가 목록 항목 밖에서 더 읽는 값 (SCR-03 상세 · SCR-06, NFR-03: 값은 RPC 결과에서만).
// - 실행 이력: `judgment.list` 1회 → 판정 기록(최신부터) + 실행 표시 ID (ADR-073), `run.list {ruleId}` 1회 → 그 규칙이
//   대상이거나 그 규칙을 판정한 실행의 상태 · 종료 사유와 판정 없이 끝난 실행 (실행 하나가 한 줄, runHistoryView.ts, ADR-123 ·
//   규칙 기준 조회 ADR-135), 같은 응답의 종료 사유 보조 표시(겹친 파일 · 내장 구조 규칙 없음 안내, ADR-144)
// - 부모 요구사항: 부모가 있으면 `requirement.get` 1회 → 표시 ID · 문장. 실패하면 보이지 않는다
// - 변경 이력: `normChange.list` 1회 → 이 규칙이 대상인 규범 변경 기록 (M7-15, ADR-114)
// - 최신 실행 링크: `rule.get` 1회 → 이 규칙이 대상인 최신 실행의 표시 ID · 실행 합계 비용 · 턴 (M3-16, ADR-134)
// 규칙이 바뀌면 다시 읽고, 늦게 온 이전 응답은 버린다. 실행 이력은 규칙의 최신 판정이 바뀌어도(실행 알림으로 규칙
// 목록을 다시 읽어 새 판정이 생김, M1-19 · ADR-076) 다시 읽는다. 다시 읽는 동안은 지금 이력을 그대로 보인다.
import type {
  NormChangeView,
  Requirement,
  RuleJudgmentEntry,
  RuleLatestRun,
  Run,
  RunFailureNote,
} from '@bive/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { RUN_EVENT_NAMES } from '../../runs/refreshCoalescer.js';
import { useEventRefresh } from '../../runs/useEventRefresh.js';

export type RuleHistoryLoad =
  { state: 'loading' } | { state: 'ready'; entries: RuleJudgmentEntry[] } | { state: 'error' };

const LOADING: RuleHistoryLoad = { state: 'loading' };

/**
 * 규칙의 실행 이력. `latestJudgmentId`(목록 항목의 최신 판정 ID, 없으면 `null`)가 바뀌면 다시 읽는다: 새 판정은
 * 이력의 첫 줄이 되고, 결과의 실행 ID도 이력에서 찾기 때문이다.
 */
export const useRuleHistory = (
  projectId: string,
  ruleId: string,
  latestJudgmentId: string | null,
): RuleHistoryLoad => {
  const [loaded, setLoaded] = useState<{ ruleId: string; load: RuleHistoryLoad } | null>(null);

  useEffect(() => {
    let live = true;
    window.bive.invoke('judgment.list', { projectId, ruleId }).then(
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
    // 최신 판정 ID는 다시 읽는 계기로만 쓴다
  }, [projectId, ruleId, latestJudgmentId]);

  return loaded !== null && loaded.ruleId === ruleId ? loaded.load : LOADING;
};

/**
 * `notes`: 응답의 종료 사유 보조 표시(`failureNotes`, 선택 칸, M3-51 #296 · ADR-144). 칸이 없는 옛 응답 · 못 읽음은 빈 목록.
 */
export type RuleRunsLoad =
  { state: 'loading' } | { state: 'ready'; runs: Run[] | null; notes: RunFailureNote[] };

/**
 * 규칙의 실행 이력에 드는 실행 (`run.list {projectId, ruleId}` 1회, M3-42 #283 · ADR-135): 그 규칙이 대상인 실행과 그 규칙을
 * 판정한 실행만 받는다(프로젝트의 모든 실행을 읽지 않는다). 실행 이력 줄의 실행 상태 · 종료 사유와 판정 기록 없이 끝난 실행.
 * 실행 상태 알림(`event.run.updated`) · 재접속 때 다시 읽는다(실행이 판정 없이 끝나도 줄이 바뀐다). 다시 읽는 동안은 지금 값을
 * 그대로 보이고, 늦게 온 이전 요청의 응답은 요청 순번으로 버린다. 못 읽으면 `runs: null`(실행 이력은 판정 기록만으로 그린다).
 */
export const useRuleRuns = (projectId: string, ruleId: string): RuleRunsLoad => {
  const [loaded, setLoaded] = useState<{ key: string; load: RuleRunsLoad } | null>(null);
  const seq = useRef(0);
  const key = `${projectId}\n${ruleId}`;
  const fetchRuns = useCallback((): Promise<void> => {
    seq.current += 1;
    const mine = seq.current;
    const settle = (runs: Run[] | null, notes: RunFailureNote[]): void => {
      if (seq.current === mine) {
        setLoaded({ key: `${projectId}\n${ruleId}`, load: { state: 'ready', runs, notes } });
      }
    };
    return window.bive.invoke('run.list', { projectId, ruleId }).then(
      ({ runs, failureNotes }) => settle(runs, failureNotes ?? []),
      () => settle(null, []),
    );
  }, [projectId, ruleId]);
  useEffect(() => {
    void fetchRuns();
    return () => {
      seq.current += 1;
    };
  }, [fetchRuns]);
  useEventRefresh(projectId, RUN_STATUS_EVENT_NAMES, fetchRuns);
  return loaded !== null && loaded.key === key ? loaded.load : LOADING_RUNS;
};

const LOADING_RUNS: RuleRunsLoad = { state: 'loading' };

/** 실행 목록을 다시 읽는 알림: 실행 상태 바뀜만 (단계 알림마다 다시 읽지 않는다). */
const RUN_STATUS_EVENT_NAMES = ['event.run.updated'] as const;

export type RuleLatestRunLoad =
  { state: 'loading' } | { state: 'ready'; latestRun: RuleLatestRun | null } | { state: 'error' };

const LATEST_RUN_LOADING: RuleLatestRunLoad = { state: 'loading' };

/**
 * 규칙의 최신 실행 링크 (`rule.get` 1회의 `latestRun`, COST-02 · M3-16 · ADR-134). 실행 알림(`event.run.updated` ·
 * `event.step.updated`: 세션이 끝나 단계 · 실행 합계가 바뀜) · 재접속 때 다시 읽는다. 다시 읽는 동안은 지금 값을 그대로
 * 보이고, 늦게 온 이전 요청의 응답은 요청 순번으로 버린다(새 값을 덮지 않는다, M3-35). 응답에 `latestRun` 칸이 없으면(옛
 * 오케스트레이터) "없음"으로 보이지 않게 실패로 다룬다.
 */
export const useRuleLatestRun = (projectId: string, ruleId: string): RuleLatestRunLoad => {
  const [loaded, setLoaded] = useState<{ key: string; load: RuleLatestRunLoad } | null>(null);
  const seq = useRef(0);
  const key = `${projectId}\n${ruleId}`;
  const fetchLatest = useCallback((): Promise<void> => {
    seq.current += 1;
    const mine = seq.current;
    const settle = (load: RuleLatestRunLoad): void => {
      if (seq.current === mine) setLoaded({ key: `${projectId}\n${ruleId}`, load });
    };
    return window.bive.invoke('rule.get', { projectId, id: ruleId }).then(
      ({ latestRun }) =>
        settle(latestRun === undefined ? { state: 'error' } : { state: 'ready', latestRun }),
      () => settle({ state: 'error' }),
    );
  }, [projectId, ruleId]);
  useEffect(() => {
    void fetchLatest();
    return () => {
      seq.current += 1;
    };
  }, [fetchLatest]);
  useEventRefresh(projectId, RUN_EVENT_NAMES, fetchLatest);
  return loaded !== null && loaded.key === key ? loaded.load : LATEST_RUN_LOADING;
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

export type RuleNormChangesLoad =
  | { state: 'loading' }
  | { state: 'ready'; entries: NormChangeView[]; chainValid: boolean }
  | { state: 'error' };

const CHANGES_LOADING: RuleNormChangesLoad = { state: 'loading' };

/**
 * 규칙의 규범 변경 기록 (`normChange.list {targetRef: 이 규칙}` 1회, M7-15 · ADR-114). `version`(규칙의 수정 시각 · 폐기 기록
 * 순번 등)이 바뀌면 다시 읽는다. 다시 읽는 동안은 지금 기록을 그대로 보인다.
 */
export const useRuleNormChanges = (
  projectId: string,
  ruleId: string,
  version: string,
): RuleNormChangesLoad => {
  const [loaded, setLoaded] = useState<{ ruleId: string; load: RuleNormChangesLoad } | null>(null);

  useEffect(() => {
    let live = true;
    window.bive
      .invoke('normChange.list', { projectId, targetRef: { entity: 'Rule', id: ruleId } })
      .then(
        ({ entries, chain }) => {
          if (live) {
            setLoaded({ ruleId, load: { state: 'ready', entries, chainValid: chain.valid } });
          }
        },
        () => {
          if (live) setLoaded({ ruleId, load: { state: 'error' } });
        },
      );
    return () => {
      live = false;
    };
    // version은 다시 읽는 계기로만 쓴다
  }, [projectId, ruleId, version]);

  return loaded !== null && loaded.ruleId === ruleId ? loaded.load : CHANGES_LOADING;
};
