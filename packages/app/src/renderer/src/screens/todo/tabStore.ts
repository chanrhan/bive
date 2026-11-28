// 할 일 탭과 마지막 탭 기억 (screens.md 6장 할 일 "마지막 탭 기억", ADR-034 · ADR-035 · ADR-056 · ADR-119).
// - 렌더러 모듈 메모리에만 둔다: 화면을 떠났다 와도 유지, 앱 재시작 때 초기화, 디스크에 쓰지 않음
// - 탭은 확인할 것 · 검토 대기열 둘이다(ADR-100 명세 변경 "할 일 공통", 계약 변경 승인 탭은 없어짐). 검토 대기열(SCR-18)은
//   M3-09가 [확인할 것] 옆에 더했다(ADR-157). 마지막 탭 기억은 두 탭에 같게 걸린다
import { useCallback, useSyncExternalStore } from 'react';

export const TODO_TABS = [
  { id: 'confirmation', label: '확인할 것' },
  { id: 'review', label: '검토 대기열' },
] as const;

export type TodoTabId = (typeof TODO_TABS)[number]['id'];

let lastTab: TodoTabId = TODO_TABS[0].id;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getTodoTab = (): TodoTabId => lastTab;

/** 마지막 탭을 바꾼다. 없는 탭이면 무시한다. */
const setTodoTab = (tab: TodoTabId): void => {
  if (tab === lastTab || !TODO_TABS.some((t) => t.id === tab)) return;
  lastTab = tab;
  for (const listener of [...listeners]) listener();
};

export const useTodoTab = (): [TodoTabId, (tab: TodoTabId) => void] => {
  const tab = useSyncExternalStore(subscribe, getTodoTab, getTodoTab);
  const update = useCallback((next: TodoTabId) => setTodoTab(next), []);
  return [tab, update];
};
