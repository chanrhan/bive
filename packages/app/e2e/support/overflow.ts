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

/**
 * 버튼 묶음 한 줄 검사 (#191): `testIds` 요소(한 묶음의 버튼들)가 모두 있고 같은 줄에 놓였는지 본다.
 * 같은 줄 = 경계 상자의 위쪽 좌표가 같고(0.5px 안) 왼쪽에서 오른쪽으로 받은 순서대로 놓인다.
 * `textClipping`은 요소마다 따로 보므로 묶음이 두 줄로 쌓여도 통과한다. 비어 있으면 통과.
 */
export const sameRow = (pane: Locator, testIds: readonly string[]): Promise<string[]> =>
  pane.evaluate((el, ids) => {
    const problems: string[] = [];
    const boxes: { id: string; box: DOMRect }[] = [];
    for (const id of ids) {
      const target = el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (target === null) {
        problems.push(`${id}: 없음`);
        continue;
      }
      boxes.push({ id, box: target.getBoundingClientRect() });
    }
    const first = boxes[0];
    if (first === undefined) return problems;
    for (let i = 1; i < boxes.length; i += 1) {
      const prev = boxes[i - 1];
      const cur = boxes[i];
      if (prev === undefined || cur === undefined) continue;
      if (Math.abs(cur.box.top - first.box.top) > 0.5) {
        problems.push(
          `${cur.id}: 다른 줄 (위 ${Math.round(cur.box.top)} · ${first.id} 위 ${Math.round(first.box.top)})`,
        );
      } else if (cur.box.left < prev.box.right - 0.5) {
        problems.push(`${cur.id}: ${prev.id}보다 왼쪽 또는 겹침`);
      }
    }
    return problems;
  }, testIds);

/**
 * 좁은 창 검사 폭 (#179): 채팅이 고정 360px로 남는 가장 좁은 창(1100px)부터 기본 창(1280px)까지
 * (PR #177 검토의 임시 확인 폭 1120 · 1150px 포함)와, 채팅이 44px 띠로 접히는 창(1024px). 높이는 800px.
 */
export const NARROW_WIDTHS = [1024, 1100, 1120, 1150, 1180, 1280] as const;
/** 목록 칸이 줄지 않는 창 (기존 e2e의 기본 뷰포트) */
export const WIDE_WIDTH = 1440;
/** 목록 칸 최대 폭(--list-pane-width) · 최소 폭과 상세 칸 최소 폭 (ADR-090) */
export const LIST_PANE_MAX = 400;
export const LIST_PANE_MIN = 220;
export const DETAIL_PANE_MIN = 288;

/**
 * 버튼 닿음 검사 (#179): `testIds` 요소마다 보이는 자리로 스크롤한 뒤, 요소 가운데 점에서 맨 위에 있는 요소가
 * 그 요소(또는 그 안)인지 본다. 다른 칸(목록 등)이 가로채면 문제로 돌려준다. 비어 있으면 통과.
 */
export const hitProblems = (pane: Locator, testIds: readonly string[]): Promise<string[]> =>
  pane.evaluate((el, ids) => {
    const problems: string[] = [];
    for (const id of ids) {
      const target = el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (target === null) {
        problems.push(`${id}: 없음`);
        continue;
      }
      // 가운데로: 스크롤 칸 아래 끝에 붙이면 떠 있는 버튼 줄(설계상 겹침)에 가린다
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      const box = target.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const top = document.elementFromPoint(x, y);
      if (top === null || !(top === target || target.contains(top))) {
        const name =
          top === null
            ? '없음'
            : (top.closest('[data-testid]')?.getAttribute('data-testid') ?? top.tagName);
        problems.push(`${id}: 가운데(${Math.round(x)}, ${Math.round(y)})가 ${name}에 가로채임`);
      }
    }
    return problems;
  }, testIds);

/**
 * 목록 칸 넘침 검사 (#179, screens.md 1.4): 목록 칸에 가로 스크롤이 없고, 도구 줄(검색 · 필터 칩 · 토글)과 카드가
 * 칸 안에 들어오며, 넘치는 카드 글자 · 칩 문구는 말줄임 + 툴팁(`title`)이다. 비어 있으면 통과.
 */
export const listPaneOverflow = (pane: Locator): Promise<string[]> =>
  pane.evaluate((el) => {
    const problems: string[] = [];
    if (el.scrollWidth > el.clientWidth) {
      problems.push(`목록 칸 가로 스크롤 (내용 ${el.scrollWidth}px > 폭 ${el.clientWidth}px)`);
    }
    const paneBox = el.getBoundingClientRect();
    const left = paneBox.left + el.clientLeft;
    const right = left + el.clientWidth;
    const parts = el.querySelectorAll<HTMLElement>(
      [
        '.list-toolbar-row > *',
        '[data-testid="list-search"]',
        '[data-testid^="filter-chip-"]',
        '[data-testid="problem-toggle"]',
        '[data-testid="list-result"]',
        '[data-testid="card"]',
        '[data-testid="card-line-2"]',
      ].join(', '),
    );
    if (parts.length === 0) problems.push('목록 요소 없음');
    parts.forEach((part) => {
      const id = part.getAttribute('data-testid') ?? part.className;
      const box = part.getBoundingClientRect();
      if (box.width === 0) return;
      if (box.left < left - 0.5 || box.right > right + 0.5) {
        problems.push(
          `${id}: 칸 밖 (가로 ${Math.round(box.left)}~${Math.round(box.right)} / 칸 ${Math.round(left)}~${Math.round(right)})`,
        );
      }
    });
    // 카드 줄의 칸은 줄 밖으로 밀려 잘리지 않는다(넘치면 칸 안에서 말줄임)
    el.querySelectorAll<HTMLElement>('.card-line').forEach((line) => {
      const lineRight = line.getBoundingClientRect().left + line.clientLeft + line.clientWidth;
      [...line.children].forEach((cell) => {
        const box = cell.getBoundingClientRect();
        if (box.width > 0 && box.right > lineRight + 0.5) {
          problems.push(
            `${cell.className}: 카드 줄 밖으로 잘림 (${cell.textContent ?? ''}, 오른쪽 ${Math.round(box.right)} > ${Math.round(lineRight)})`,
          );
        }
      });
    });
    // 예외 배지 · 안 읽음 점은 통째로 보인다: 말줄임도 잘림도 없고, 카드 안에서 overflow를 자르는 조상(카드 줄 등)의
    // 보이는 영역 안에 경계 상자가 다 들어온다 (1.1 "예외만 강조")
    el.querySelectorAll<HTMLElement>(
      '[data-testid="card-exception"], [data-testid="card-unread"]',
    ).forEach((mark) => {
      const id = mark.getAttribute('data-testid') ?? '';
      const name = `${id}(${mark.textContent ?? ''})`;
      const box = mark.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) {
        problems.push(`${name}: 보이지 않음 (폭 ${box.width} · 높이 ${box.height})`);
        return;
      }
      if (mark.scrollWidth > mark.clientWidth + 0.5) {
        problems.push(`${name}: 글자 잘림 (내용 ${mark.scrollWidth}px > 폭 ${mark.clientWidth}px)`);
      }
      const card = mark.closest('[data-testid="card"]');
      for (let up = mark.parentElement; up !== null; up = up.parentElement) {
        const style = getComputedStyle(up);
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible' || up === card) {
          const outer = up.getBoundingClientRect();
          const inner = {
            left: outer.left + up.clientLeft,
            top: outer.top + up.clientTop,
            right: outer.left + up.clientLeft + up.clientWidth,
            bottom: outer.top + up.clientTop + up.clientHeight,
          };
          if (
            box.left < inner.left - 0.5 ||
            box.top < inner.top - 0.5 ||
            box.right > inner.right + 0.5 ||
            box.bottom > inner.bottom + 0.5
          ) {
            problems.push(
              `${name}: ${up.className} 밖으로 잘림 (가로 ${Math.round(box.left)}~${Math.round(box.right)} / ${Math.round(inner.left)}~${Math.round(inner.right)})`,
            );
            break;
          }
        }
        if (up === card) break;
      }
    });
    // ID는 줄 폭보다 길 때만 말줄임된다. 보조 문구 · 시각이 보이는 동안(또는 그것들이 다음 줄로 넘어가도) 온전하다
    el.querySelectorAll<HTMLElement>('.card-id').forEach((cardId) => {
      const line = cardId.parentElement;
      if (line === null) return;
      // 말줄임은 1/64px만 모자라도 끝 글자를 "…"로 바꾸므로 정수인 scrollWidth가 아니라 글자 범위의 실수 폭으로 잰다
      const range = document.createRange();
      range.selectNodeContents(cardId);
      const textWidth = range.getBoundingClientRect().width;
      const boxWidth = cardId.getBoundingClientRect().width;
      if (textWidth > boxWidth + 0.01 && textWidth <= line.clientWidth) {
        const others = [...line.querySelectorAll<HTMLElement>('.card-note, .card-time')]
          .map((o) => `${o.className} ${Math.round(o.getBoundingClientRect().width)}px`)
          .join(', ');
        problems.push(
          `card-id(${cardId.textContent ?? ''}): 줄 폭 ${line.clientWidth}px 안인데 말줄임 (폭 ${boxWidth.toFixed(3)}px < 글자 ${textWidth.toFixed(3)}px${others === '' ? '' : `, ${others}`})`,
        );
      }
    });
    const texts = el.querySelectorAll<HTMLElement>(
      '.card-title, .card-id, .card-note, .card-time, .filter-chip-text',
    );
    texts.forEach((text) => {
      if (text.scrollWidth <= text.clientWidth + 0.5) return;
      const id = text.className;
      if (getComputedStyle(text).textOverflow !== 'ellipsis') {
        problems.push(`${id}: 넘치는데 말줄임 없음 (${text.textContent ?? ''})`);
      }
      const tip = text.closest('[title]')?.getAttribute('title') ?? '';
      if (tip.trim() === '') problems.push(`${id}: 넘치는데 툴팁 없음 (${text.textContent ?? ''})`);
    });
    return problems;
  });

/**
 * 낱말 끊김 검사 (#179): 요소 글자의 낱말(공백으로 나눈 조각)마다 한 줄 안에 있는지 본다.
 * "Esc 취 / 소"처럼 낱말 중간에서 줄이 바뀌면 그 낱말을 돌려준다. 비어 있으면 통과.
 */
export const brokenWords = (target: Locator): Promise<string[]> =>
  target.evaluate((el) => {
    const broken: string[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      for (const match of text.matchAll(/\S+/gu)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const tops = new Set(
          [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
        );
        if (tops.size > 1) broken.push(match[0]);
      }
    }
    return broken;
  });

/** 목록 칸 · 상세 칸 폭 (테두리 포함 경계 상자). */
export const paneWidths = async (
  list: Locator,
  detail: Locator,
): Promise<{ list: number; detail: number }> => {
  const listBox = await list.boundingBox();
  const detailBox = await detail.boundingBox();
  if (listBox === null || detailBox === null) throw new Error('목록 · 상세 칸 없음');
  return { list: listBox.width, detail: detailBox.width };
};
