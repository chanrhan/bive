// 할 일 탭과 마지막 탭 기억 (screens.md 6장 할 일 "마지막 탭 기억", ADR-034 · ADR-035 · ADR-056).
// - 렌더러 모듈 메모리에만 둔다: 화면을 떠났다 와도 유지, 앱 재시작 때 초기화, 디스크에 쓰지 않음
// - M1에는 [승인 대기] 탭 하나뿐이다. 검토 대기열(M3 SCR-18) · 계약 변경 승인(M3 SCR-19) 탭은 그 이슈가
//   TODO_TABS에 더한다(그 전에는 DOM에 없음, ADR-035)
import { useCallback, useSyncExternalStore } from 'react';

export const TODO_TABS = [{ id: 'approval', label: '승인 대기' }] as const;

export type TodoTabId = (typeof TODO_TABS)[number]['id'];

const FIRST_TAB: TodoTabId = TODO_TABS[0].id;

let lastTab: TodoTabId = FIRST_TAB;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getTodoTab = (): TodoTabId => lastTab;

/** 마지막 탭을 바꾼다. 없는 탭이면 무시한다. */
export const setTodoTab = (tab: TodoTabId): void => {
  if (tab === lastTab || !TODO_TABS.some((t) => t.id === tab)) return;
  lastTab = tab;
  for (const listener of [...listeners]) listener();
};

/** 첫 탭으로 되돌린다 (프로젝트 전환 등). */
export const resetTodoTab = (): void => setTodoTab(FIRST_TAB);

export const useTodoTab = (): [TodoTabId, (tab: TodoTabId) => void] => {
  const tab = useSyncExternalStore(subscribe, getTodoTab, getTodoTab);
  const update = useCallback((next: TodoTabId) => setTodoTab(next), []);
  return [tab, update];
};
