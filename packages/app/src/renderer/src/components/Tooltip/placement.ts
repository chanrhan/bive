// 공통 툴팁의 자리 (이슈 #201 · ADR-124): 대상 아래(모자라면 위), 왼쪽 끝을 대상에 맞추고 창 가장자리 8px 안으로 당긴다.
// 툴팁은 `position: fixed`라 문서 폭에 들어가지 않으므로 가로 스크롤을 만들지 않고, 이 계산으로 창 밖으로 잘리지 않는다.
// DOM · React에 의존하지 않는다 (test/tooltip-placement.test.ts).

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface TooltipPlacement {
  left: number;
  top: number;
  side: 'below' | 'above';
}

/** 대상과 툴팁 사이 간격 (--space-1) */
export const TOOLTIP_GAP = 4;
/** 창 가장자리와 툴팁 사이 최소 간격 (--space-2) */
export const VIEWPORT_MARGIN = 8;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

export const placeTooltip = (anchor: Box, size: Size, viewport: Size): TooltipPlacement => {
  const below = anchor.bottom + TOOLTIP_GAP;
  const above = anchor.top - TOOLTIP_GAP - size.height;
  const fitsBelow = below + size.height <= viewport.height - VIEWPORT_MARGIN;
  const side = fitsBelow || above < VIEWPORT_MARGIN ? 'below' : 'above';
  return {
    left: clamp(anchor.left, VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN - size.width),
    top: clamp(
      side === 'below' ? below : above,
      VIEWPORT_MARGIN,
      viewport.height - VIEWPORT_MARGIN - size.height,
    ),
    side,
  };
};
