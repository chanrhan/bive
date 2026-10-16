// 목록별 필터 상태 저장소 (screens.md 1.4 "필터 상태는 목록별 유지", ADR-034).
// - 렌더러 모듈 메모리에만 둔다: 화면을 떠나 컴포넌트가 사라져도 유지, 앱 재시작(렌더러 재로드) 때 초기화
// - 디스크 · localStorage · sessionStorage에 저장하지 않는다
// - 프로젝트 전환 때는 resetAllListFilters(), 다른 화면에서 필터를 지정해 이동할 때는 setListFilter()
import { useCallback, useSyncExternalStore } from 'react';

import { EMPTY_FILTER, type FilterState } from './filter.js';

const states = new Map<string, FilterState>();
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of [...listeners]) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export type FilterUpdate = FilterState | ((previous: FilterState) => FilterState);

/** 목록 `listId`의 현재 필터 상태. 처음이면 빈 필터. */
export const getListFilter = (listId: string): FilterState => states.get(listId) ?? EMPTY_FILTER;

/** 목록 `listId`의 필터 상태를 바꾼다 (다른 화면에서 필터를 지정해 이동할 때도 쓴다, ADR-034). */
export const setListFilter = (listId: string, update: FilterUpdate): void => {
  const previous = getListFilter(listId);
  const next = typeof update === 'function' ? update(previous) : update;
  if (next === previous) return;
  states.set(listId, next);
  notify();
};

/** 목록 하나의 필터를 비운다. */
export const resetListFilter = (listId: string): void => {
  if (!states.delete(listId)) return;
  notify();
};

/** 모든 목록의 필터를 비운다 (프로젝트 전환, ADR-034). */
export const resetAllListFilters = (): void => {
  if (states.size === 0) return;
  states.clear();
  notify();
};

/** 목록 `listId`의 필터 상태와 변경 함수. */
export const useListFilter = (listId: string): [FilterState, (update: FilterUpdate) => void] => {
  const state = useSyncExternalStore(
    subscribe,
    () => getListFilter(listId),
    () => getListFilter(listId),
  );
  const update = useCallback((next: FilterUpdate) => setListFilter(listId, next), [listId]);
  return [state, update];
};
