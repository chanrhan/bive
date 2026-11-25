// 공통 툴팁의 상태 (screens.md 1.4 카드 "말줄임 + 툴팁", 이슈 #201 · ADR-124).
// 앱 전체에 열린 툴팁은 하나뿐이다: 상태는 이 모듈 하나가 들고, 그리는 것은 `TooltipHost` 하나다. 대상(버튼 · 카드)은 React 이벤트
// 속성(`tooltipTrigger`)만 달아 대상 수만큼 DOM 리스너 · 툴팁 요소 · 구독이 늘지 않는다(React는 이벤트를 뿌리에서 한 번 받는다).
// - 열림: 마우스 올림(`hover`) · 키보드 초점(`focus`, `:focus-visible`일 때만) · 누름(`press`, 원래 동작이 없는 대상만)
// - 닫힘: Esc · 초점이 떠남 · 대상 밖을 누름 · 올림으로 연 것은 마우스가 떠날 때 · 대상이 DOM에서 사라짐(`TooltipHost`)
// DOM에만 의존하고 React에 의존하지 않는다.

/** 열린 이유. 올림으로 연 툴팁만 마우스가 떠날 때 닫는다(초점 · 누름으로 연 것은 Esc · 초점 떠남 · 밖 누름까지). */
export type TooltipReason = 'hover' | 'focus' | 'press';

export interface TooltipState {
  /** 툴팁을 붙인 대상 (위치 기준 · `aria-describedby`를 다는 요소) */
  anchor: HTMLElement;
  /** 문구 줄. 그릴 때 `visibleDisplayText`를 거쳐 글자 노드로만 넣는다(`TooltipHost`) */
  lines: readonly string[];
  reason: TooltipReason;
}

/** 툴팁 요소의 id (한 번에 하나뿐이라 고정). 대상의 `aria-describedby`가 이 값을 가리킨다. */
export const TOOLTIP_ID = 'bive-tooltip';

let current: TooltipState | null = null;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

export const getTooltip = (): TooltipState | null => current;

export const subscribeTooltip = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** 툴팁을 연다. 다른 대상의 툴팁이 열려 있으면 그것을 닫고 이것을 연다(한 번에 하나). 줄이 없으면 아무것도 하지 않는다. */
export const showTooltip = (
  anchor: HTMLElement,
  lines: readonly string[],
  reason: TooltipReason,
): void => {
  if (lines.length === 0) return;
  current = { anchor, lines, reason };
  emit();
};

/** 툴팁을 닫는다. `anchor`를 주면 그 대상의 툴팁일 때만 닫는다. */
export const hideTooltip = (anchor?: HTMLElement): void => {
  if (current === null) return;
  if (anchor !== undefined && current.anchor !== anchor) return;
  current = null;
  emit();
};

/** 올림으로 연 그 대상의 툴팁만 닫는다 (마우스가 떠날 때). */
const hideHover = (anchor: HTMLElement): void => {
  if (current?.anchor === anchor && current.reason === 'hover') hideTooltip(anchor);
};

/** 키보드 초점인지 (마우스 누름으로 받은 초점에는 열지 않는다. 누름은 `press` 대상만 연다). */
const isKeyboardFocus = (element: HTMLElement): boolean => element.matches(':focus-visible');

/**
 * 대상이 원래 동작을 갖는지에 따라 누름의 뜻이 갈린다.
 * - `action`: 원래 동작이 있는 대상(예: 준수 카드의 기준 버튼 → 규칙 화면 이동). 누름은 원래 동작만 하고 툴팁은 올림 · 초점으로 연다
 * - `press`: 원래 동작이 없는 대상(예: 코드 열람 제목의 한계 문구 버튼). 누르면(Enter · Space 포함) 툴팁을 연다
 */
export type TooltipTriggerKind = 'action' | 'press';

export interface TooltipTriggerProps {
  onMouseEnter: (event: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave: (event: React.MouseEvent<HTMLElement>) => void;
  onFocus: (event: React.FocusEvent<HTMLElement>) => void;
  onBlur: (event: React.FocusEvent<HTMLElement>) => void;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
}

/**
 * 고정 문구 툴팁을 여는 이벤트 속성. 대상 요소에 펼쳐 넣는다. `action` 대상은 `onClick`을 돌려주지 않으므로 대상의 원래
 * `onClick`이 그대로 남는다.
 */
export const tooltipTrigger = (text: string, kind: TooltipTriggerKind): TooltipTriggerProps => ({
  onMouseEnter: (event) => showTooltip(event.currentTarget, [text], 'hover'),
  onMouseLeave: (event) => hideHover(event.currentTarget),
  onFocus: (event) => {
    if (isKeyboardFocus(event.currentTarget)) showTooltip(event.currentTarget, [text], 'focus');
  },
  onBlur: (event) => hideTooltip(event.currentTarget),
  ...(kind === 'press' && {
    onClick: (event: React.MouseEvent<HTMLElement>) =>
      showTooltip(event.currentTarget, [text], 'press'),
  }),
});

/** 말줄임 등으로 글자가 칸 밖으로 잘렸는지 (화면 정의서 1.4 "긴 텍스트는 말줄임 + 툴팁": 잘린 것만 툴팁). */
export const isClipped = (element: Element): boolean => element.scrollWidth > element.clientWidth;

export { hideHover, isKeyboardFocus };
