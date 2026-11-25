// 공통 툴팁을 그리는 곳 (이슈 #201 · ADR-124). 앱 틀(AppLayout)에 하나만 둔다. 열린 툴팁이 있을 때만 요소 하나를 `body`에 그리고,
// 그동안만 리스너(창 캡처 Esc · 문서 밖 누름 · 창 캡처 스크롤 · 창 크기)와 대상이 사라졌는지 보는 관찰자를 단다. 닫히면 모두 뗀다.
// - 닫힘: Esc(이때만 키를 삼킨다) · 밖 누름 · 대상이 보이는 영역 밖으로 스크롤됨 · 창 크기 변경 · 대상이 DOM에서 빠짐.
//   대상이 처음부터 보이는 영역 밖이면 열지 않는다
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

/**
 * 대상 상자가 보이는 영역 안에 조금이라도 있는지: 창과, 넘침을 자르는 조상(목록 스크롤 칸 등)의 상자를 모두 겹친 영역.
 */
const isAnchorVisible = (anchor: HTMLElement): boolean => {
  const box = anchor.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return false;
  const root = document.documentElement;
  let left = 0;
  let top = 0;
  let right = root.clientWidth;
  let bottom = root.clientHeight;
  for (let up = anchor.parentElement; up !== null && up !== document.body; up = up.parentElement) {
    const style = getComputedStyle(up);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const clip = up.getBoundingClientRect();
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
  }
  return box.right > left && box.left < right && box.bottom > top && box.top < bottom;
};

const TooltipBubble = ({ state }: { state: TooltipState }): React.JSX.Element => {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<TooltipPlacement | null>(null);
  const { anchor } = state;

  useLayoutEffect(() => {
    /** 자리를 다시 잡는다. 대상이 DOM에 없거나 보이는 영역 밖이면 닫고 거짓 */
    const update = (): boolean => {
      const bubble = ref.current;
      if (bubble === null) return false;
      if (!anchor.isConnected || !isAnchorVisible(anchor)) {
        hideTooltip(anchor);
        return false;
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
      return true;
    };
    // 대상이 보이는 영역 밖이면 열지 않는다
    if (!update()) return undefined;
    addToken(anchor);
    // Esc: 툴팁을 실제로 닫을 때만 키를 삼킨다(창 캡처 단계라 채팅 겹침 · 모달의 Esc보다 먼저 받는다). 툴팁이 닫혀 있을 때는
    // 이 리스너가 없으므로 Esc는 평소대로 모달 · 채팅을 닫는다 (#275 검토 B1)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      hideTooltip(anchor);
    };
    // 스크롤(대상의 조상 스크롤 칸 포함): 대상이 보이는 영역 밖으로 나가면 닫고, 보이면 자리를 다시 잡는다.
    // 키보드 초점이 닿은 카드를 브라우저가 보이게 스크롤하는 것도 스크롤이라 그때는 닫지 않는다 (#275 검토 B2)
    const onScroll = (): void => {
      update();
    };
    // 창 크기 변경: 닫는다 (#275 검토 B2)
    const onResize = (): void => hideTooltip(anchor);
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || !anchor.contains(event.target)) hideTooltip(anchor);
    };
    // 대상이 DOM에서 빠지면(화면 이동 · 목록 갱신) 닫는다
    const observer = new MutationObserver(() => {
      if (!anchor.isConnected) hideTooltip(anchor);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
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
