// 공통 툴팁을 그리는 곳 (이슈 #201 · ADR-124). 앱 틀(AppLayout)에 하나만 둔다. 열린 툴팁이 있을 때만 요소 하나를 `body`에 그리고,
// 그동안만 문서 리스너(Esc · 밖 누름 · 스크롤 · 창 크기)와 대상이 사라졌는지 보는 관찰자를 단다. 닫히면 모두 뗀다.
// - 접근성: 문구 요소는 `role="tooltip"`, 열린 동안 대상의 `aria-describedby`에 그 id를 더하고 닫을 때 뺀다
// - 문구: 줄마다 `visibleDisplayText`(숨은 글자를 보이는 표기로, 이미 표시 값인 글은 그대로)를 거쳐 글자 노드로만 넣는다
// - Esc로 닫아도 초점은 옮기지 않는다(대상에 남는다)
import './Tooltip.css';

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { visibleDisplayText } from '../VisibleText/visibleText.js';
import { placeTooltip, type TooltipPlacement } from './placement.js';
import {
  getTooltip,
  hideTooltip,
  subscribeTooltip,
  TOOLTIP_ID,
  type TooltipState,
} from './tooltipStore.js';

export const TooltipHost = (): React.JSX.Element | null => {
  const state = useSyncExternalStore(subscribeTooltip, getTooltip);
  if (state === null) return null;
  return createPortal(<TooltipBubble state={state} />, document.body);
};

const addToken = (anchor: HTMLElement): void => {
  const tokens = (anchor.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  if (!tokens.includes(TOOLTIP_ID)) {
    anchor.setAttribute('aria-describedby', [...tokens, TOOLTIP_ID].join(' '));
  }
};

const removeToken = (anchor: HTMLElement): void => {
  const tokens = (anchor.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter((token) => token !== '' && token !== TOOLTIP_ID);
  if (tokens.length === 0) anchor.removeAttribute('aria-describedby');
  else anchor.setAttribute('aria-describedby', tokens.join(' '));
};

const TooltipBubble = ({ state }: { state: TooltipState }): React.JSX.Element => {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<TooltipPlacement | null>(null);
  const { anchor } = state;

  useLayoutEffect(() => {
    const update = (): void => {
      const bubble = ref.current;
      if (bubble === null) return;
      if (!anchor.isConnected) {
        hideTooltip(anchor);
        return;
      }
      const box = bubble.getBoundingClientRect();
      const root = document.documentElement;
      setPlace(
        placeTooltip(
          anchor.getBoundingClientRect(),
          { width: box.width, height: box.height },
          { width: root.clientWidth, height: root.clientHeight },
        ),
      );
    };
    update();
    addToken(anchor);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hideTooltip(anchor);
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || !anchor.contains(event.target)) hideTooltip(anchor);
    };
    // 대상이 DOM에서 빠지면(화면 이동 · 목록 갱신) 닫는다
    const observer = new MutationObserver(() => {
      if (!anchor.isConnected) hideTooltip(anchor);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      removeToken(anchor);
    };
  }, [state, anchor]);

  return (
    <div
      ref={ref}
      id={TOOLTIP_ID}
      className="tooltip"
      role="tooltip"
      data-testid="tooltip"
      data-reason={state.reason}
      data-side={place?.side}
      style={
        place === null
          ? { left: 0, top: 0, visibility: 'hidden' }
          : { left: place.left, top: place.top }
      }
    >
      {state.lines.map((line, index) => (
        <span key={index} className="tooltip-line" data-testid="tooltip-line">
          {visibleDisplayText(line)}
        </span>
      ))}
    </div>
  );
};
