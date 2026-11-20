// 카드 2줄 배치 (#179 검토 2회차, ADR-090, screens.md 1.4 카드): 스크롤바가 자리를 차지하는 실행.
// Playwright는 기본으로 `--hide-scrollbars`를 붙여 스크롤바가 폭을 차지하지 않는다. 이 파일은 그것을 빼고 돌아
// Linux · Windows의 Electron 창처럼 목록이 스크롤되면 스크롤바(약 15px)가 카드 폭을 줄인다.
// - 400px 목록(1280 · 1440px 창)의 카드는 이전 배치 그대로: 2줄째가 한 줄, ID 온전, ID · 보조 문구 · 예외가 간격 8px로
//   이어지고, 카드 높이가 이전과 같다
// - 좁은 목록(1024 ~ 1280px 창)에서도 ID는 말줄임되지 않고 예외 배지는 통째로 보인다(`listPaneOverflow`)
// 데이터는 규칙 화면(SCR-03)의 가짜 브리지 응답뿐이다 (테스트 전용 데이터, NFR-03).
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { Rule, RuleWithJudgment } from '@bive/shared';
import { expect, type Page, test } from '@playwright/test';

import { PROJECT, RULES } from './checklists/scr-03.js';
import { mockBive } from './support/bive-mock.js';
import { SCREENSHOT_DIR } from './support/expectScreen.js';
import { listPaneOverflow, NARROW_WIDTHS, WIDE_WIDTH } from './support/overflow.js';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
test.use({
  launchOptions: {
    ...(executablePath === undefined || executablePath === '' ? {} : { executablePath }),
    ignoreDefaultArgs: ['--hide-scrollbars'],
  },
});

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;

/** 이전(`main`) 400px 목록에서 잰 규칙 카드 높이 (2줄 카드, 테두리 포함) */
const CARD_HEIGHT = 59;
/** 칸 사이 간격 (--space-2) */
const GAP = 8;

const STATUSES = ['pass', 'fail', 'unjudged', 'quarantined', 'needs_recheck'] as const;
const CONDITIONS = [
  'WHEN 사용자가 장바구니에서 상품을 삭제하면',
  'WHEN 결제가 실패하면',
  'WHEN 관리자가 주문 목록을 내려받으면',
  'WHEN 세션이 30분 동안 쓰이지 않으면',
] as const;

/** 목록이 스크롤되도록 더하는 규칙 14개 (RULE-101 ~ RULE-114). RULE-109는 재검증 필요 · 잠정. */
const EXTRA: RuleWithJudgment[] = Array.from({ length: 14 }, (_, i) => {
  const n = 101 + i;
  const sample = RULES[0]?.rule;
  if (sample === undefined) throw new Error('규칙 시험 데이터 없음');
  const rule: Rule = {
    ...sample,
    id: `01JC0000000000000000000${n}`,
    displayId: `RULE-${n}`,
    title: `시험 규칙 ${n}`,
    statement: `${CONDITIONS[i % CONDITIONS.length] ?? ''} THE SYSTEM SHALL 기록을 남긴다`,
    normState: n === 109 ? 'provisional' : 'approved',
  };
  const status = n === 109 ? 'needs_recheck' : (STATUSES[i % STATUSES.length] ?? 'pass');
  return { rule, judgment: { status, latest: null } };
});

const openRules = async (page: Page, rules: readonly RuleWithJudgment[]): Promise<void> => {
  await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'rule.list': { result: { rules: [...rules] } },
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '규칙', exact: true }).click();
  await expect(page.getByTestId('card').first()).toBeVisible();
};

const listPane = (page: Page) => page.getByTestId('rules-list-pane');

const shot = async (page: Page, name: string): Promise<void> => {
  const dir = path.join(SCREENSHOT_DIR, '..', 'layout');
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
};

/** 목록이 스크롤되고 스크롤바가 폭을 차지한다(이 파일의 전제). */
const expectScrollbar = async (page: Page): Promise<void> => {
  const items = page.getByTestId('list-items');
  const { bar, scrolls } = await items.evaluate((el: HTMLElement) => ({
    bar: el.offsetWidth - el.clientWidth - el.clientLeft * 2,
    scrolls: el.scrollHeight > el.clientHeight,
  }));
  expect(scrolls, '목록 스크롤').toBe(true);
  expect(bar, '스크롤바 폭').toBeGreaterThan(0);
};

/**
 * 400px 목록의 이전 배치: 카드마다 2줄째가 한 줄이고 카드 높이가 이전과 같으며, ID가 온전하고,
 * ID → 보조 문구 → 예외가 간격 8px로 바로 이어진다(보조 문구가 남는 폭을 다 차지해 예외를 오른쪽으로 밀지 않음).
 */
const wideLayoutProblems = (page: Page): Promise<string[]> =>
  listPane(page).evaluate(
    (el, { height, gap }) => {
      const problems: string[] = [];
      el.querySelectorAll<HTMLElement>('[data-testid="card"]').forEach((card) => {
        const name = card.getAttribute('data-id') ?? '';
        const cardBox = card.getBoundingClientRect();
        if (Math.abs(cardBox.height - height) > 0.5) {
          problems.push(`${name}: 카드 높이 ${cardBox.height} (이전 ${height})`);
        }
        const line = card.querySelector<HTMLElement>('[data-testid="card-line-2"]');
        if (line === null) return;
        const cells = [...line.children] as HTMLElement[];
        // 한 줄: 칸들의 세로 가운데가 한 줄 높이(18px) 안에서 맞는다
        const middles = cells.map((c) => {
          const box = c.getBoundingClientRect();
          return box.top + box.height / 2;
        });
        if (Math.max(...middles) - Math.min(...middles) > 1) {
          problems.push(`${name}: 2줄째가 여러 줄 (가운데 ${middles.map(Math.round).join(', ')})`);
        }
        const id = line.querySelector<HTMLElement>('.card-id');
        if (id !== null) {
          // 말줄임은 1/64px만 모자라도 생기므로 글자 범위의 실수 폭으로 잰다
          const range = document.createRange();
          range.selectNodeContents(id);
          const text = range.getBoundingClientRect().width;
          const box = id.getBoundingClientRect().width;
          if (text > box + 0.01) problems.push(`${name}: ID 말줄임 (${box} < ${text})`);
        }
        for (let i = 1; i < cells.length; i += 1) {
          const prev = cells[i - 1]?.getBoundingClientRect();
          const cur = cells[i]?.getBoundingClientRect();
          if (prev === undefined || cur === undefined) continue;
          if (Math.abs(cur.left - (prev.right + gap)) > 0.5) {
            problems.push(
              `${name}: ${cells[i]?.className ?? ''} 위치 ${cur.left} (앞 칸 끝 ${prev.right} + ${gap})`,
            );
          }
        }
      });
      return problems;
    },
    { height: CARD_HEIGHT, gap: GAP },
  );

test.describe('스크롤바가 있는 400px 목록: 카드는 이전 배치 그대로 (#179, ADR-090)', () => {
  for (const width of [1280, WIDE_WIDTH]) {
    test(`${width}px 창: 모든 카드의 ID가 온전하고 2줄째가 한 줄, 칸이 8px 간격으로 이어지며 카드 높이가 같다`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await openRules(page, [...RULES, ...EXTRA]);
      await expect(page.locator('[data-testid="card"][data-id="RULE-109"]')).toBeVisible();
      expect((await listPane(page).boundingBox())?.width).toBe(400);
      await expectScrollbar(page);
      expect(await wideLayoutProblems(page)).toEqual([]);
      expect(await listPaneOverflow(listPane(page))).toEqual([]);
      await shot(page, `카드-스크롤바-${width}`);
    });
  }
});

test.describe('스크롤바가 있는 좁은 목록: ID는 말줄임되지 않고 예외는 통째로 (#179, ADR-090)', () => {
  for (const width of NARROW_WIDTHS) {
    test(`${width}px 창`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openRules(page, [...RULES, ...EXTRA]);
      await expectScrollbar(page);
      expect(await listPaneOverflow(listPane(page))).toEqual([]);
      await shot(page, `카드-스크롤바-${width}`);
    });
  }

  test('1100px 창, 기본 데이터(스크롤 없음): RULE-002 등 보조 문구가 보이는 카드의 ID가 온전하다', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await openRules(page, RULES);
    const ids = page.getByTestId('card-id');
    await expect(ids.first()).toBeVisible();
    for (const id of await ids.all()) {
      const { textWidth, boxWidth, text } = await id.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return {
          textWidth: range.getBoundingClientRect().width,
          boxWidth: el.getBoundingClientRect().width,
          text: el.textContent ?? '',
        };
      });
      expect(textWidth, `${text} 말줄임`).toBeLessThanOrEqual(boxWidth + 0.01);
    }
    expect(await listPaneOverflow(listPane(page))).toEqual([]);
    await shot(page, '카드-1100-기본');
  });
});
