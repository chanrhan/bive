// 설정 모달 열림 상태 (SCR-21, screens.md 7장 진입: 사이드바 하단 톱니 → 모달).
// 설정은 화면(경로)이 아니라 현재 화면 위에 겹치는 모달이므로 경로 상태와 따로 둔다 (ADR-044 수정, ADR-057).
// 렌더러 모듈 메모리에만 있다.
import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();

const setOpen = (value: boolean): void => {
  if (open === value) return;
  open = value;
  for (const listener of [...listeners]) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const openSettings = (): void => setOpen(true);
export const closeSettings = (): void => setOpen(false);

/** 설정 모달이 열려 있는지. */
export const useSettingsOpen = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => open,
    () => open,
  );
