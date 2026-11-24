// 확인할 것 목록 (`confirmation.list`): 할 일 배지 · 툴팁과 확인할 것 탭이 같은 결과를 쓴다 (screens.md 6장 할 일 · SCR-17 자리,
// TODO-01, ADR-100 A7 · 명세 변경 "할 일 공통", ADR-113 · ADR-119). 옛 승인 대기 건수(`proposal.count`)를 대신한다.
// - 현재 프로젝트의 `confirmation.list`를 부른다. 프로젝트가 없으면 부르지 않는다
// - 조회 시점: 프로젝트가 바뀔 때 · 화면(경로)에 들어갈 때 · 명시적 refresh() ([확인] 뒤) · 이 프로젝트의 규범 변경 알림
//   (`event.normChange.appended`, 에이전트의 새 규칙 · 폐기 · 대체 · 확인 풀림 · 테스트 변경) · 오케스트레이터에 다시 붙을 때
//   (useEventRefresh). 알림 · 재접속 조회는 합친다(동시 조회 1개 · 뒤따르는 조회 최대 1개). 폴링은 하지 않는다
// - 늦게 도착한 이전 조회 결과는 버린다. 실패하면 'error'(배지 없음, 근거 없는 값 미표시, NFR-03)
import type { ConfirmationListResult } from '@bive/shared';
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
import { NORM_CHANGE_EVENT_NAMES } from '../runs/refreshCoalescer.js';
import { useEventRefresh } from '../runs/useEventRefresh.js';

export type TodoListLoad =
  { status: 'loading' } | { status: 'ready'; result: ConfirmationListResult } | { status: 'error' };

export interface TodoListView {
  /** 현재 프로젝트의 마지막 조회 결과 (프로젝트가 없으면 'loading'으로 두고 부르지 않는다) */
  load: TodoListLoad;
  /** 지금 다시 조회한다. 끝나면(성공 · 실패 모두) 풀린다. 거부하지 않는다 */
  refresh(): Promise<void>;
}

const LOADING: TodoListLoad = { status: 'loading' };

const TodoListContext = createContext<TodoListView | null>(null);

export const TodoListProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const { project } = useProject();
  const { route } = useNavigation();
  const projectId = project?.id ?? null;
  const [stored, setStored] = useState<{ projectId: string; load: TodoListLoad } | null>(null);
  // 마지막 요청 번호. 응답이 왔을 때 번호가 다르면 더 새 요청이 있으므로 버린다
  const seq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    seq.current += 1;
    const mine = seq.current;
    if (projectId === null) {
      setStored(null);
      return;
    }
    try {
      const result = await window.bive.invoke('confirmation.list', { projectId });
      if (seq.current === mine) setStored({ projectId, load: { status: 'ready', result } });
    } catch {
      if (seq.current === mine) setStored({ projectId, load: { status: 'error' } });
    }
  }, [projectId]);

  // 프로젝트가 바뀌거나 화면에 들어갈 때 다시 조회한다 (route는 조회 계기로만 쓴다)
  useEffect(() => {
    void refresh();
  }, [refresh, route]);

  // 에이전트가 규범을 바꾸면 · 다시 붙으면 다시 읽는다 (화면 이동 없이 배지 · 목록 갱신)
  useEventRefresh(projectId, NORM_CHANGE_EVENT_NAMES, refresh);

  // 사라진 뒤 도착한 응답은 버린다
  useEffect(
    () => () => {
      seq.current += 1;
    },
    [],
  );

  const load = stored !== null && stored.projectId === projectId ? stored.load : LOADING;
  const value = useMemo<TodoListView>(() => ({ load, refresh }), [load, refresh]);
  return <TodoListContext.Provider value={value}>{children}</TodoListContext.Provider>;
};

/** 확인할 것 목록과 재조회 함수. TodoListProvider(AppLayout) 안에서만 부른다. */
export const useTodoList = (): TodoListView => {
  const value = useContext(TodoListContext);
  if (value === null) throw new Error('TodoListProvider 밖에서 useTodoList 호출');
  return value;
};
