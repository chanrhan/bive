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
