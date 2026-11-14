// 가로 넘침 검사 (#165 M1-37): 상세 패널에 가로 스크롤이 없고, 줄(실행 이력 줄 등)의 칸이 패널 밖으로 나가거나
// 잘리지 않는지 본다. 자체 스크롤이 의도된 요소(테스트 출력의 `<pre>` 긴 메시지)는 줄 검사 대상에 넣지 않는다.
import type { Locator } from '@playwright/test';

/**
 * 패널(`pane`)의 가로 넘침 문제 목록. 비어 있으면 통과.
 * - 패널: `scrollWidth <= clientWidth` (가로 스크롤 없음)
 * - `rowSelector`에 맞는 줄마다: 줄과 그 자식 칸의 오른쪽 끝이 패널 내용 폭 안, 각 칸의 `scrollWidth <= clientWidth`(잘림 없음)
 */
export const horizontalOverflow = (pane: Locator, rowSelector: string): Promise<string[]> =>
  pane.evaluate((el, selector) => {
    const problems: string[] = [];
    if (el.scrollWidth > el.clientWidth) {
      problems.push(`패널 가로 스크롤 (내용 ${el.scrollWidth}px > 폭 ${el.clientWidth}px)`);
    }
    const paneBox = el.getBoundingClientRect();
    // 테두리 안쪽 오른쪽 끝 (세로 스크롤 막대 제외)
    const right = paneBox.left + el.clientLeft + el.clientWidth;
    const rows = [...el.querySelectorAll(selector)];
    if (rows.length === 0) problems.push(`줄 없음 (${selector})`);
    rows.forEach((row, i) => {
      const cells = [row, ...row.children];
      cells.forEach((cell, j) => {
        const name = j === 0 ? `줄 ${i + 1}` : `줄 ${i + 1} 칸 ${j}`;
        const box = cell.getBoundingClientRect();
        if (box.right > right + 0.5) {
          problems.push(
            `${name}: 패널 밖 (오른쪽 ${Math.round(box.right)} > ${Math.round(right)})`,
          );
        }
        if (cell.scrollWidth > cell.clientWidth + 0.5) {
          problems.push(`${name}: 잘림 (내용 ${cell.scrollWidth}px > 폭 ${cell.clientWidth}px)`);
        }
      });
    });
    return problems;
  }, rowSelector);

/**
 * 한 줄 문구 검사 (#175 M1-39): `testIds` 요소마다 글자가 한 줄이고 잘리지 않으며 패널(`pane`) 경계 안에 있는지.
 * 비어 있으면 통과. 요소를 못 찾으면 그것도 문제로 돌려준다.
 * - 한 줄: 글자 범위(Range)의 줄 조각 위쪽 좌표가 하나뿐
 * - 잘림 없음: `scrollHeight <= clientHeight`, `scrollWidth <= clientWidth`
 * - 패널 안: 요소의 경계 상자가 패널 테두리 안쪽에 들어온다
 */
export const textClipping = (pane: Locator, testIds: readonly string[]): Promise<string[]> =>
  pane.evaluate((el, ids) => {
    const problems: string[] = [];
    const paneBox = el.getBoundingClientRect();
    const inner = {
      left: paneBox.left + el.clientLeft,
      top: paneBox.top + el.clientTop,
      right: paneBox.left + el.clientLeft + el.clientWidth,
      bottom: paneBox.top + el.clientTop + el.clientHeight,
    };
    for (const id of ids) {
      const target = el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (target === null) {
        problems.push(`${id}: 없음`);
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(target);
      const tops = new Set(
        [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
      );
      if (tops.size !== 1) problems.push(`${id}: ${tops.size}줄`);
      if (target.scrollHeight > target.clientHeight + 0.5) {
        problems.push(
          `${id}: 세로 잘림 (내용 ${target.scrollHeight}px > 높이 ${target.clientHeight}px)`,
        );
      }
      if (target.scrollWidth > target.clientWidth + 0.5) {
        problems.push(
          `${id}: 가로 잘림 (내용 ${target.scrollWidth}px > 폭 ${target.clientWidth}px)`,
        );
      }
      const box = target.getBoundingClientRect();
      if (
        box.left < inner.left - 0.5 ||
        box.top < inner.top - 0.5 ||
        box.right > inner.right + 0.5 ||
        box.bottom > inner.bottom + 0.5
      ) {
        problems.push(
          `${id}: 패널 밖 (가로 ${Math.round(box.left)}~${Math.round(box.right)}, 세로 ${Math.round(box.top)}~${Math.round(box.bottom)} / 패널 가로 ${Math.round(inner.left)}~${Math.round(inner.right)}, 세로 ${Math.round(inner.top)}~${Math.round(inner.bottom)})`,
        );
      }
    }
    return problems;
  }, testIds);
