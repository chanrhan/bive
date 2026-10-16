// 화면 체크리스트 검사 (architecture.md 8장, screens.md 1.1, NFR-09).
//   1) checklists/의 상태별 요소 목록을 검사하고
//   2) 스크린샷을 artifacts/screens/<SCR-ID>/<state>.png에 저장한 뒤
//   3) 화면에 보이는 문구(텍스트 · title · aria-label · placeholder · alt · 문서 제목)에
//      PRD ID · 화면 코드 · 이모지가 있으면 실패한다.
// 요소 검사가 실패해도 스크린샷은 남긴다.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, type Locator, type Page } from '@playwright/test';

import { CHECKLISTS } from '../checklists/index.js';
import type { ElementCheck, ScreenChecklist, ScreenId, ScreenState } from '../checklists/types.js';

/** 저장소 루트의 `artifacts/screens`. */
export const SCREENSHOT_DIR = fileURLToPath(
  new URL('../../../../artifacts/screens/', import.meta.url),
);

/** 화면 문구 금지 패턴 (screens.md 1.1: PRD · 화면 정의서 코드 표기 금지, 이모지 금지). */
export const FORBIDDEN_TEXT: readonly { label: string; pattern: RegExp }[] = [
  { label: 'PRD ID', pattern: /\b(PRJ|NRM|RUN|JDG|DSN|TODO|COST|MET|COL|NFR)-\d\d\b/g },
  { label: '화면 코드', pattern: /\bSCR-\d\d\b/g },
  { label: '이모지', pattern: /\p{Extended_Pictographic}/gu },
];

export interface ExpectScreenOptions {
  /** 체크리스트를 직접 넘긴다 (기본: checklists/index.ts에서 ID로 찾음). */
  checklist?: ScreenChecklist;
  /** false면 스크린샷을 저장하지 않는다 (위반 예제처럼 화면을 일부러 망가뜨린 경우). */
  screenshot?: boolean;
  /** 요소 검사 하나의 대기 시간(ms). 기본은 Playwright expect 설정. */
  timeout?: number;
}

/** 화면에 보이는 문구 한 조각과 그 출처. */
interface VisibleText {
  source: string;
  text: string;
}

const SCREEN_ID = /^SCR-\d\d$/;

const describe = (check: ElementCheck): string =>
  [
    check.testId && `testId=${check.testId}`,
    check.role && `role=${check.role}`,
    check.name !== undefined && `name=${String(check.name)}`,
    check.text !== undefined && `text=${String(check.text)}`,
  ]
    .filter(Boolean)
    .join(' ');

const locate = (page: Page, check: ElementCheck): Locator => {
  let locator: Locator | null = null;
  if (check.testId !== undefined) locator = page.getByTestId(check.testId);
  if (check.role !== undefined) {
    const byRole = page.getByRole(check.role, {
      ...(check.name !== undefined && { name: check.name, exact: typeof check.name === 'string' }),
    });
    locator = locator === null ? byRole : locator.and(byRole);
  }
  if (locator === null) {
    if (check.text === undefined) {
      throw new Error(`체크리스트 항목 "${check.label}"에 testId · role · text가 모두 없음`);
    }
    locator = page.getByText(check.text, { exact: typeof check.text === 'string' });
  }
  return locator;
};

const checkElement = async (page: Page, check: ElementCheck, timeout?: number): Promise<void> => {
  const what = `"${check.label}" (${describe(check)})`;
  const opts = timeout === undefined ? {} : { timeout };
  const locator = locate(page, check);
  if (check.absent) {
    await expect(locator, `${what} 미노출`).toHaveCount(0, opts);
    return;
  }
  if (check.count !== undefined) {
    await expect(locator, `${what} ${check.count}개`).toHaveCount(check.count, opts);
  }
  if (check.count !== 0) {
    const first = locator.first();
    await expect(first, `${what} 보임`).toBeVisible(opts);
    // 선택자로 찾은 요소의 문구는 전체 일치로 검사한다 (text만 주면 이미 locate에서 일치)
    if (check.text !== undefined && (check.testId !== undefined || check.role !== undefined)) {
      await expect(first, `${what} 문구`).toHaveText(check.text, opts);
    }
    for (const [name, value] of Object.entries(check.attributes ?? {})) {
      await expect(first, `${what} 속성 ${name}`).toHaveAttribute(name, value, opts);
    }
  }
};

/** 브라우저 문맥: 보이는 요소의 텍스트와 사람이 읽는 속성을 모은다. */
const collectVisibleText = (page: Page): Promise<VisibleText[]> =>
  page.evaluate(() => {
    const out: { source: string; text: string }[] = [
      { source: '문서 제목', text: document.title },
      // innerText는 display:none · visibility:hidden 요소를 뺀 렌더된 문구다
      { source: '본문', text: document.body.innerText },
    ];
    const attributes = ['title', 'aria-label', 'placeholder', 'alt', 'aria-description'];
    for (const element of document.body.querySelectorAll('*')) {
      if (!element.checkVisibility({ visibilityProperty: true })) continue;
      for (const name of attributes) {
        const value = element.getAttribute(name);
        if (value) out.push({ source: `${element.tagName.toLowerCase()}[${name}]`, text: value });
      }
      // 입력 값(value)은 사용자가 보는 문구다
      if (
        (element instanceof HTMLInputElement && element.type !== 'hidden') ||
        element instanceof HTMLTextAreaElement
      ) {
        if (element.value)
          out.push({ source: `${element.tagName.toLowerCase()}[value]`, text: element.value });
      }
    }
    return out;
  });

/** 금지 문구 위반 목록 (출처 · 종류 · 일치 문자열). 비어 있으면 통과. */
export const findForbiddenText = (texts: readonly VisibleText[]): string[] => {
  const violations: string[] = [];
  for (const { source, text } of texts) {
    for (const { label, pattern } of FORBIDDEN_TEXT) {
      for (const match of text.matchAll(pattern)) {
        violations.push(`${label} "${match[0]}" (${source})`);
      }
    }
  }
  return violations;
};

/**
 * 화면 `scr`가 상태 `state`의 체크리스트대로 보이는지 검사한다. 실패하면 거부(throw)한다.
 * 예: `await expectScreen(page, 'SCR-02', '기본')`
 */
export const expectScreen = async (
  page: Page,
  scr: ScreenId,
  state: ScreenState,
  options: ExpectScreenOptions = {},
): Promise<void> => {
  if (!SCREEN_ID.test(scr)) throw new Error(`화면 ID 형식 아님: ${scr}`);
  const checklist = options.checklist ?? CHECKLISTS[scr];
  if (checklist === undefined) throw new Error(`${scr} 체크리스트 없음 (checklists/index.ts)`);
  if (checklist.id !== scr) throw new Error(`체크리스트 ID ${checklist.id} ≠ ${scr}`);
  const stateList = checklist.states[state];
  if (stateList === undefined) throw new Error(`${scr} 체크리스트에 상태 "${state}" 없음`);

  try {
    if (stateList.title !== undefined) {
      await expect(page, `${scr} ${state}: 문서 제목`).toHaveTitle(
        stateList.title,
        options.timeout === undefined ? {} : { timeout: options.timeout },
      );
    }
    for (const check of stateList.elements) await checkElement(page, check, options.timeout);
  } finally {
    if (options.screenshot !== false) {
      const file = path.join(SCREENSHOT_DIR, scr, `${state}.png`);
      await mkdir(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file, fullPage: true });
    }
  }

  const violations = findForbiddenText(await collectVisibleText(page));
  if (violations.length > 0) {
    throw new Error(
      `${scr} ${state}: 화면 문구 규칙 위반 ${violations.length}건 (screens.md 1.1)\n- ${violations.join('\n- ')}`,
    );
  }
};
