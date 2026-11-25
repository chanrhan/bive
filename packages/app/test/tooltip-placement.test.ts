// 공통 툴팁의 자리 (이슈 #201 · ADR-124): 대상 아래, 모자라면 위. 왼쪽 끝은 대상에 맞추되 창 가장자리 8px 안으로 당긴다.
import { describe, expect, it } from 'vitest';

import {
  placeTooltip,
  TOOLTIP_GAP,
  VIEWPORT_MARGIN,
} from '../src/renderer/src/components/Tooltip/placement.js';

const VIEWPORT = { width: 820, height: 600 };
const SIZE = { width: 200, height: 40 };
const box = (left: number, top: number, width = 80, height = 24) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe('툴팁 자리', () => {
  it('넉넉하면 대상 바로 아래, 왼쪽 끝이 대상과 같다', () => {
    expect(placeTooltip(box(100, 100), SIZE, VIEWPORT)).toEqual({
      left: 100,
      top: 124 + TOOLTIP_GAP,
      side: 'below',
    });
  });

  it('아래가 모자라면 위로', () => {
    expect(placeTooltip(box(100, 550), SIZE, VIEWPORT)).toEqual({
      left: 100,
      top: 550 - TOOLTIP_GAP - SIZE.height,
      side: 'above',
    });
  });

  it('위아래 모두 모자라면 아래로 두고 창 안으로 당긴다', () => {
    const place = placeTooltip(box(100, 20, 80, 560), SIZE, VIEWPORT);
    expect(place.side).toBe('below');
    expect(place.top).toBe(VIEWPORT.height - VIEWPORT_MARGIN - SIZE.height);
  });

  it('오른쪽 가장자리의 대상: 툴팁 오른쪽 끝이 창 오른쪽 8px 안', () => {
    const place = placeTooltip(box(780, 100, 30), SIZE, VIEWPORT);
    expect(place.left).toBe(VIEWPORT.width - VIEWPORT_MARGIN - SIZE.width);
    expect(place.left + SIZE.width).toBeLessThanOrEqual(VIEWPORT.width - VIEWPORT_MARGIN);
  });

  it('왼쪽 밖의 대상: 툴팁 왼쪽 끝은 8px', () => {
    expect(placeTooltip(box(-40, 100), SIZE, VIEWPORT).left).toBe(VIEWPORT_MARGIN);
  });

  it('창보다 넓은 툴팁은 왼쪽 8px에 둔다(음수 자리 없음)', () => {
    expect(placeTooltip(box(300, 100), { width: 900, height: 40 }, VIEWPORT).left).toBe(
      VIEWPORT_MARGIN,
    );
  });
});
