// 할 일 목록 둘: 확인할 것(`confirmation.list`)과 검토 대기열(`reviewQueue.list`). 할 일 배지 · 툴팁과 두 탭이 같은 결과를 쓴다
// (screens.md 6장 할 일 · SCR-17 자리 · SCR-18, TODO-01 · TODO-02, ADR-100 A7 · 명세 변경 "할 일 공통", ADR-113 · ADR-119 ·
// ADR-157). 옛 승인 대기 건수(`proposal.count`)를 대신한다.
// - 현재 프로젝트의 두 목록을 부른다. 프로젝트가 없으면 부르지 않는다
// - 조회 시점: 프로젝트가 바뀔 때 · 화면(경로)에 들어갈 때 · 명시적 refresh() / refreshReview() (처리 뒤) · 오케스트레이터에 다시
//   붙을 때(useEventRefresh). 확인할 것은 이 프로젝트의 규범 변경 알림(`event.normChange.appended`), 검토 대기열은 검토 대기열 알림
//   (`event.reviewQueue.changed`)에 다시 읽는다. 알림 · 재접속 조회는 목록마다 합친다(동시 조회 1개 · 뒤따르는 조회 최대 1개).
//   폴링은 하지 않는다
// - 늦게 도착한 이전 조회 결과는 버린다. 실패하면 'error'(배지 없음, 근거 없는 값 미표시, NFR-03)
import type { ConfirmationListResult, ReviewQueueListResult } from '@bive/shared';
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
import { NORM_CHANGE_EVENT_NAMES, REVIEW_QUEUE_EVENT_NAMES } from '../runs/refreshCoalescer.js';
import { useEventRefresh } from '../runs/useEventRefresh.js';

export type ListLoad<R> =
  { status: 'loading' } | { status: 'ready'; result: R } | { status: 'error' };
export type TodoListLoad = ListLoad<ConfirmationListResult>;
export type ReviewListLoad = ListLoad<ReviewQueueListResult>;

export interface TodoListView {
  /** 확인할 것: 현재 프로젝트의 마지막 조회 결과 (프로젝트가 없으면 'loading'으로 두고 부르지 않는다) */
  load: TodoListLoad;
  /** 검토 대기열: 현재 프로젝트의 마지막 조회 결과 (열림 · 처리됨 모두) */
  review: ReviewListLoad;
  /** 확인할 것을 지금 다시 조회한다. 끝나면(성공 · 실패 모두) 풀린다. 거부하지 않는다 */
  refresh(): Promise<void>;
  /** 검토 대기열을 지금 다시 조회한다. 끝나면(성공 · 실패 모두) 풀린다. 거부하지 않는다 */
  refreshReview(): Promise<void>;
}

const LOADING = { status: 'loading' } as const;

/** 프로젝트 하나의 목록 조회 (늦게 온 응답은 버린다). */
const useProjectList = <R,>(
  projectId: string | null,
  fetch: (projectId: string) => Promise<R>,
): [ListLoad<R>, () => Promise<void>] => {
  const [stored, setStored] = useState<{ projectId: string; load: ListLoad<R> } | null>(null);
  // 마지막 요청 번호. 응답이 왔을 때 번호가 다르면 더 새 요청이 있으므로 버린다
  const seq = useRef(0);

  // `fetch`는 모듈 상수라 바뀌지 않는다
  const refresh = useCallback(async (): Promise<void> => {
    seq.current += 1;
    const mine = seq.current;
    if (projectId === null) {
      setStored(null);
      return;
    }
    try {
      const result = await fetch(projectId);
      if (seq.current === mine) setStored({ projectId, load: { status: 'ready', result } });
    } catch {
      if (seq.current === mine) setStored({ projectId, load: { status: 'error' } });
    }
  }, [projectId, fetch]);

  // 사라진 뒤 도착한 응답은 버린다
  useEffect(
    () => () => {
      seq.current += 1;
    },
    [],
  );

  const load = stored !== null && stored.projectId === projectId ? stored.load : LOADING;
  return [load, refresh];
};

const fetchConfirmations = (projectId: string): Promise<ConfirmationListResult> =>
  window.bive.invoke('confirmation.list', { projectId });
const fetchReviewQueue = (projectId: string): Promise<ReviewQueueListResult> =>
  window.bive.invoke('reviewQueue.list', { projectId });

const TodoListContext = createContext<TodoListView | null>(null);

export const TodoListProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const { project } = useProject();
  const { route } = useNavigation();
  const projectId = project?.id ?? null;
  const [load, refresh] = useProjectList(projectId, fetchConfirmations);
  const [review, refreshReview] = useProjectList(projectId, fetchReviewQueue);

  // 프로젝트가 바뀌거나 화면에 들어갈 때 다시 조회한다 (route는 조회 계기로만 쓴다)
  useEffect(() => {
    void refresh();
    void refreshReview();
  }, [refresh, refreshReview, route]);

  // 에이전트가 규범을 바꾸면 · 검토 대기열 항목이 생기거나 처리되면 · 다시 붙으면 다시 읽는다 (화면 이동 없이 배지 · 목록 갱신)
  useEventRefresh(projectId, NORM_CHANGE_EVENT_NAMES, refresh);
  useEventRefresh(projectId, REVIEW_QUEUE_EVENT_NAMES, refreshReview);

  const value = useMemo<TodoListView>(
    () => ({ load, review, refresh, refreshReview }),
    [load, review, refresh, refreshReview],
  );
  return <TodoListContext.Provider value={value}>{children}</TodoListContext.Provider>;
};

/** 할 일 목록과 재조회 함수. TodoListProvider(AppLayout) 안에서만 부른다. */
export const useTodoList = (): TodoListView => {
  const value = useContext(TodoListContext);
  if (value === null) throw new Error('TodoListProvider 밖에서 useTodoList 호출');
  return value;
};
