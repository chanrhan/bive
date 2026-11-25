// 카드 2줄 배치 (#179 검토 2회차, ADR-090, screens.md 1.4 카드): 스크롤바가 자리를 차지하는 실행.
// Playwright는 기본으로 `--hide-scrollbars`를 붙여 스크롤바가 폭을 차지하지 않는다. 이 파일은 그것을 빼고 돌아
// Linux · Windows의 Electron 창처럼 목록이 스크롤되면 스크롤바(약 15px)가 카드 폭을 줄인다.
// - 400px 목록(1280 · 1440px 창)의 카드는 이전 배치 그대로: 2줄째가 한 줄, ID 온전, ID · 보조 문구 · 예외가 간격 8px로
//   이어지고, 카드 높이가 이전과 같다
// - 좁은 목록(1024 ~ 1280px 창)에서도 ID는 말줄임되지 않고 예외 배지는 통째로 보인다(`listPaneOverflow`)
// - 시각이 있는 카드(요구사항 SCR-02 · 확인할 것 SCR-17 자리, #191 · M7-14): 400px 목록에서 시각은 줄 오른쪽 끝이고 2줄째가
//   한 줄 · 카드 높이가 이전과 같다. 좁은 목록에서 보조 문구 · 시각은 최소 3em(모자라면 다음 줄로). 공용 카드의 안 읽음 점은
//   쓰는 화면이 없어져 지웠다(ADR-119 · ADR-123)
// 데이터는 규칙 · 요구사항 · 확인할 것 화면의 가짜 브리지 응답뿐이다 (테스트 전용 데이터, NFR-03).
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { ConfirmationListResult, Requirement, Rule, RuleWithJudgment } from '@bive/shared';
import { expect, type Locator, type Page, test } from '@playwright/test';

import { REQUIREMENTS } from './checklists/scr-02.js';
import { PROJECT, RULES } from './checklists/scr-03.js';
import { mockBive, nextFrame } from './support/bive-mock.js';
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

/** 목록이 스크롤되도록 만드는 요구사항 16개 (REQ-101 ~ REQ-116, 테스트 전용 데이터). 예외 조합을 돌려 가며 쓰고
 *  REQ-1234는 4자리 ID · 규칙화 불가 · 잠정(2줄째가 가장 긴 요구사항 카드). */
const MANY_REQUIREMENTS: Requirement[] = Array.from({ length: 16 }, (_, i) => {
  const sample = REQUIREMENTS[0];
  if (sample === undefined) throw new Error('요구사항 시험 데이터 없음');
  const n = 101 + i;
  const day = String(1 + i).padStart(2, '0');
  return {
    ...sample,
    id: `01JB0000000000000000000${n}`,
    displayId: i === 5 ? 'REQ-1234' : `REQ-${n}`,
    text: `시험 요구사항 ${n} 로그인 실패 잠금`,
    normState: i % 2 === 0 || i === 5 ? 'provisional' : 'approved',
    unrulable: i % 3 === 0 || i === 5 ? { reason: '측정 기준 없음' } : null,
    updatedAt: `2026-10-${day}T03:20:00.000Z`,
  };
});

/** 목록이 스크롤되도록 만드는 확인할 것 항목 16개 (RULE-101 ~ RULE-116, 테스트 전용 데이터).
 *  미확인 규칙 · 확인 풀림 대체 · 테스트 변경을 돌려 가며 쓰고 RULE-1234는 4자리 ID. */
const MANY_ITEMS: ConfirmationListResult['items'] = Array.from({ length: 16 }, (_, i) => {
  const n = 101 + i;
  const day = String(1 + i).padStart(2, '0');
  const rule = {
    id: `01JBVE00000000000000000${n}`,
    displayId: i === 4 ? 'RULE-1234' : `RULE-${n}`,
  };
  const at = `2026-10-${day}T01:00:00.000Z`;
  const title = `헬스 응답 항목 ${n}`;
  const statement = 'WHEN 클라이언트가 헬스 체크를 요청하면 THE SYSTEM SHALL 응답한다';
  if (i % 4 === 0) {
    return {
      kind: 'superseded',
      seq: n,
      at,
      actor: { kind: 'agent', role: 'rule-writer' },
      sessionId: '01JBVE00000000000000000S01',
      rule,
      before: { title, statement },
      after: {
        title,
        statement,
        rule: { id: '01JBVE00000000000000000999', displayId: 'RULE-999' },
      },
      grounds: '근거',
      rationale: '사유',
      released: { seq: n + 1, at },
      textTruncated: false,
    };
  }
  if (i % 3 === 0) {
    return {
      kind: 'test_changed',
      seq: n,
      at,
      rule,
      title,
      runId: '01JBVE00000000000000000E01',
      runDisplayId: 'EXE-001',
      sessionId: null,
      files: [{ path: 'bive-acceptance/a.acc.ts', change: 'modified' }],
      fileCount: 1,
      textTruncated: false,
    };
  }
  return {
    kind: 'unconfirmed_norm',
    at,
    target: { entity: 'Rule', id: rule.id },
    displayId: rule.displayId,
    text: title,
    author: { kind: 'agent', role: 'rule-writer' },
    textTruncated: false,
  };
});

const openRequirements = async (page: Page): Promise<Locator> => {
  await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'requirement.list': { result: { requirements: MANY_REQUIREMENTS } },
      'rule.list': { result: { rules: [] } },
      'judgment.list': { result: { judgments: [] } },
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '요구사항', exact: true }).click();
  await expect(page.getByTestId('card')).toHaveCount(MANY_REQUIREMENTS.length);
  return page.getByTestId('requirements-list-pane');
};

const openTodo = async (page: Page): Promise<Locator> => {
  await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'confirmation.list': {
        result: { items: MANY_ITEMS, total: MANY_ITEMS.length, truncated: false },
      },
    },
  });
  await page.goto('/');
  await page.getByTestId('todo-button').click();
  await expect(page.getByTestId('card')).toHaveCount(MANY_ITEMS.length);
  return page.getByTestId('todo-list-pane');
};

/** 시각이 있는 카드의 화면: 요구사항(시각) · 확인할 것(종류 태그 · 예외 · 시각) */
const TIMED_SCREENS = [
  ['요구사항', openRequirements],
  ['확인할 것', openTodo],
] as const;

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
 * 시각은 줄 오른쪽 끝에 붙는다: 시각의 오른쪽 끝 = 줄 오른쪽 끝, 시각은 앞 칸과 8px 이상 떨어지고 말줄임되지 않는다 (#191).
 */
const wideLayoutProblems = (pane: Locator): Promise<string[]> =>
  pane.evaluate(
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
        // 칸: 감싸는 요소가 있어도 보이는 칸(ID · 보조 문구 · 예외 · 시각)만 DOM 순서로
        const cells = [
          ...line.querySelectorAll<HTMLElement>(
            '.card-id, .card-note, [data-testid="card-exception"], .card-time',
          ),
        ];
        // 한 줄: 칸들의 세로 가운데가 한 줄 높이(18px) 안에서 맞는다
        const middles = cells.map((c) => {
          const box = c.getBoundingClientRect();
          return box.top + box.height / 2;
        });
        if (Math.max(...middles) - Math.min(...middles) > 1) {
          problems.push(`${name}: 2줄째가 여러 줄 (가운데 ${middles.map(Math.round).join(', ')})`);
        }
        const fullText = (cell: HTMLElement, label: string): void => {
          // 말줄임은 1/64px만 모자라도 생기므로 글자 범위의 실수 폭으로 잰다
          const range = document.createRange();
          range.selectNodeContents(cell);
          const text = range.getBoundingClientRect().width;
          const box = cell.getBoundingClientRect().width;
          if (text > box + 0.01) problems.push(`${name}: ${label} 말줄임 (${box} < ${text})`);
        };
        const id = line.querySelector<HTMLElement>('.card-id');
        if (id !== null) fullText(id, 'ID');
        const lineBox = line.getBoundingClientRect();
        const lineRight = lineBox.left + line.clientLeft + line.clientWidth;
        // 앞쪽 칸(ID · 보조 문구 · 예외)은 8px 간격으로 잇고, 시각은 끝에 붙인다
        const tailStart = cells.findIndex((c) => c.matches('.card-time'));
        const headEnd = tailStart === -1 ? cells.length : tailStart;
        for (let i = 1; i < headEnd; i += 1) {
          const prev = cells[i - 1]?.getBoundingClientRect();
          const cur = cells[i]?.getBoundingClientRect();
          if (prev === undefined || cur === undefined) continue;
          if (Math.abs(cur.left - (prev.right + gap)) > 0.5) {
            problems.push(
              `${name}: ${cells[i]?.className ?? ''} 위치 ${cur.left} (앞 칸 끝 ${prev.right} + ${gap})`,
            );
          }
        }
        if (tailStart === -1) return;
        const tail = cells.slice(tailStart);
        const last = tail.at(-1)?.getBoundingClientRect();
        if (last !== undefined && Math.abs(last.right - lineRight) > 0.5) {
          problems.push(
            `${name}: ${tail.at(-1)?.className ?? ''} 오른쪽 끝 ${last.right} (줄 오른쪽 끝 ${lineRight})`,
          );
        }
        for (let i = 1; i < tail.length; i += 1) {
          const prev = tail[i - 1]?.getBoundingClientRect();
          const cur = tail[i]?.getBoundingClientRect();
          if (prev === undefined || cur === undefined) continue;
          if (Math.abs(cur.left - (prev.right + gap)) > 0.5) {
            problems.push(
              `${name}: ${tail[i]?.className ?? ''} 위치 ${cur.left} (시각 끝 ${prev.right} + ${gap})`,
            );
          }
        }
        const head = cells[headEnd - 1]?.getBoundingClientRect();
        const first = tail[0]?.getBoundingClientRect();
        if (head !== undefined && first !== undefined && first.left < head.right + gap - 0.5) {
          problems.push(`${name}: 시각이 앞 칸에 붙음 (${first.left} < ${head.right} + ${gap})`);
        }
        const time = line.querySelector<HTMLElement>('.card-time');
        if (time !== null) fullText(time, '시각');
      });
      return problems;
    },
    { height: CARD_HEIGHT, gap: GAP },
  );

/**
 * 좁은 목록의 2줄째 (#191, ADR-090): 보조 문구 · 시각은 보이면 폭이 최소 3em 이상이다(남는 폭이 모자라면 줄지 않고
 * 다음 줄로 넘어간다).
 */
const narrowLineProblems = (pane: Locator): Promise<string[]> =>
  pane.evaluate((el) => {
    const problems: string[] = [];
    el.querySelectorAll<HTMLElement>('[data-testid="card-line-2"]').forEach((line) => {
      const name = line.closest('[data-testid="card"]')?.getAttribute('data-id') ?? '';
      line.querySelectorAll<HTMLElement>('.card-note, .card-time').forEach((cell) => {
        const width = cell.getBoundingClientRect().width;
        const min = 3 * Number.parseFloat(getComputedStyle(cell).fontSize);
        if (width > 0 && width < min - 0.01) {
          problems.push(`${name}: ${cell.className} 폭 ${width.toFixed(2)}px < 최소 ${min}px`);
        }
      });
    });
    return problems;
  });

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
      expect(await wideLayoutProblems(listPane(page))).toEqual([]);
      expect(await listPaneOverflow(listPane(page))).toEqual([]);
      await shot(page, `카드-스크롤바-${width}`);
    });
  }

  for (const [screen, open] of TIMED_SCREENS) {
    for (const width of [1280, WIDE_WIDTH]) {
      test(`${screen} ${width}px 창: 시각은 줄 오른쪽 끝, 2줄째가 한 줄, 카드 높이가 같다 (#191)`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        const pane = await open(page);
        expect((await pane.boundingBox())?.width).toBe(400);
        await expectScrollbar(page);
        // 시각이 있는 카드를 실제로 본다 (확인할 것은 예외가 있는 카드)
        expect(await pane.locator('.card-time').count()).toBeGreaterThan(0);
        if (screen === '확인할 것') {
          expect(await pane.getByTestId('card-exception').count()).toBeGreaterThan(0);
        }
        expect(await wideLayoutProblems(pane)).toEqual([]);
        expect(await narrowLineProblems(pane)).toEqual([]);
        expect(await listPaneOverflow(pane)).toEqual([]);
        await shot(page, `카드-스크롤바-${screen}-${width}`);
      });
    }
  }
});

test.describe('스크롤바가 있는 좁은 목록: ID는 말줄임되지 않고 예외는 통째로 (#179, ADR-090)', () => {
  for (const width of NARROW_WIDTHS) {
    test(`${width}px 창`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openRules(page, [...RULES, ...EXTRA]);
      await expectScrollbar(page);
      expect(await listPaneOverflow(listPane(page))).toEqual([]);
      expect(await narrowLineProblems(listPane(page))).toEqual([]);
      await shot(page, `카드-스크롤바-${width}`);
    });

    for (const [screen, open] of TIMED_SCREENS) {
      test(`${width}px 창 ${screen}: 보조 문구 · 시각은 최소 3em (#191)`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        const pane = await open(page);
        await expectScrollbar(page);
        expect(await narrowLineProblems(pane)).toEqual([]);
        expect(await listPaneOverflow(pane)).toEqual([]);
        await shot(page, `카드-스크롤바-${screen}-${width}`);
      });
    }
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

/** 창 최소 폭 근처(채팅이 44px 띠로 접힘, ADR-093)와 좁은 목록 폭 */
const TRAILING_WIDTHS = [820, 830, ...NARROW_WIDTHS] as const;

/**
 * 2줄째 끝 칸(시각)이 다음 줄로 넘어가는 때 (#173, ADR-090): 앞 칸들 뒤에 남는 폭이 시각의 최소 폭(3em)보다 작을 때만이다.
 * 남는 폭 = 줄 폭 - 마지막 앞 칸이 있는 줄의 앞 칸들 폭(보조 문구는 줄바꿈 판단 때의 최소 폭 3em) - 칸 사이 간격.
 * 남는 폭이 최소 폭에 0.5px 안으로 붙은 경우는 판단하지 않는다(소수 폭 반올림).
 */
const trailingWrapProblems = (pane: Locator): Promise<string[]> =>
  pane.evaluate(
    (el, { gap }) => {
      const problems: string[] = [];
      const middle = (cell: HTMLElement): number => {
        const box = cell.getBoundingClientRect();
        return box.top + box.height / 2;
      };
      el.querySelectorAll<HTMLElement>('[data-testid="card-line-2"]').forEach((line) => {
        const name = line.closest('[data-testid="card"]')?.getAttribute('data-id') ?? '';
        const time = line.querySelector<HTMLElement>('.card-time');
        if (time === null) return;
        const head = [
          ...line.querySelectorAll<HTMLElement>(
            '.card-id, .card-note, [data-testid="card-exception"]',
          ),
        ];
        const last = head.at(-1);
        if (last === undefined) return;
        const em = Number.parseFloat(getComputedStyle(time).fontSize);
        const row = head.filter((cell) => Math.abs(middle(cell) - middle(last)) <= 1);
        const used =
          row.reduce(
            (sum, cell) =>
              sum + (cell.matches('.card-note') ? 3 * em : cell.getBoundingClientRect().width),
            0,
          ) +
          gap * (row.length - 1);
        const lineWidth = line.getBoundingClientRect().width;
        const available = lineWidth - used - gap;
        const need = 3 * em;
        const sameRow = Math.abs(middle(time) - middle(last)) <= 1;
        const label = '시각';
        if (!sameRow && available >= need + 0.5) {
          problems.push(
            `${name}: ${label}이 남는 폭 ${available.toFixed(2)}px ≥ 최소 ${need}px인데 다음 줄`,
          );
        }
        if (sameRow && available < need - 0.5) {
          problems.push(
            `${name}: ${label}이 남는 폭 ${available.toFixed(2)}px < 최소 ${need}px인데 같은 줄`,
          );
        }
      });
      return problems;
    },
    { gap: GAP },
  );

/** 시각이 있는 카드 수 */
const timedCards = (pane: Locator): Promise<number> =>
  pane.evaluate(
    (el) =>
      [...el.querySelectorAll('[data-testid="card-line-2"]')].filter(
        (line) => line.querySelector('.card-time') !== null,
      ).length,
  );

/** 스크롤바를 숨긴다(Playwright 기본 `--hide-scrollbars`와 같이 폭을 차지하지 않음). 이 파일은 그 인자를 빼고 돈다 */
const hideScrollbars = async (page: Page): Promise<void> => {
  await page.addStyleTag({ content: '* { scrollbar-width: none !important; }' });
};

test.describe('2줄째 끝 칸은 남는 폭이 최소 폭보다 작을 때만 다음 줄로 (#173, ADR-090)', () => {
  for (const scrollbar of ['보임', '숨김'] as const) {
    for (const width of TRAILING_WIDTHS) {
      for (const [screen, open] of TIMED_SCREENS) {
        test(`스크롤바 ${scrollbar} · ${width}px 창 ${screen}: 시각이 있는 카드`, async ({
          page,
        }) => {
          await page.setViewportSize({ width, height: 800 });
          const pane = await open(page);
          if (scrollbar === '숨김') await hideScrollbars(page);
          const bar = await page
            .getByTestId('list-items')
            .evaluate((items: HTMLElement) => items.offsetWidth - items.clientWidth);
          if (scrollbar === '보임') await expectScrollbar(page);
          else expect(bar, '스크롤바 폭').toBe(0);
          // 시각이 있는 카드를 실제로 본다 (요구사항 · 확인할 것 카드 전부)
          expect(await timedCards(pane)).toBeGreaterThan(0);
          expect(await trailingWrapProblems(pane)).toEqual([]);
          expect(await narrowLineProblems(pane)).toEqual([]);
          expect(await listPaneOverflow(pane)).toEqual([]);
        });
      }
    }
  }
});

/** 제목이 400px 목록에서 말줄임되는 규칙 (테스트 전용 데이터) */
const LONG_TITLE =
  '주문 취소는 결제 승인 후 24시간 이내에만 허용하고 부분 환불은 관리자 승인 뒤에만 처리하며 기록을 남긴다';
const LONG_RULE: RuleWithJudgment = (() => {
  const sample = EXTRA[1];
  if (sample === undefined) throw new Error('규칙 시험 데이터 없음');
  return {
    ...sample,
    rule: {
      ...sample.rule,
      id: '01JC0000000000000000000199',
      displayId: 'RULE-199',
      title: LONG_TITLE,
    },
  };
})();

const tooltip = (page: Page) => page.getByRole('tooltip');
const cardOf = (page: Page, id: string) => page.locator(`[data-testid="card"][data-id="${id}"]`);

/** 키보드로 카드에 초점을 옮긴다: 목록에서 바로 앞 카드에 초점을 두고 Tab 한 번. */
const tabToCard = async (page: Page, id: string): Promise<void> => {
  await page.getByTestId('list-items').evaluate((list, target) => {
    const cards = [...list.querySelectorAll<HTMLElement>('[data-testid="card"]')];
    const index = cards.findIndex((card) => card.getAttribute('data-id') === target);
    if (index < 1) throw new Error(`앞 카드 없음: ${target}`);
    cards[index - 1]?.focus();
  }, id);
  await page.keyboard.press('Tab');
  await expect(cardOf(page, id)).toBeFocused();
};

/** 카드 높이 · 줄 위치 (카드 기준 상대 좌표). 툴팁이 열려도 같아야 한다. */
const cardGeometry = (pane: Locator): Promise<number[][]> =>
  pane.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>('[data-testid="card"]')].map((card) => {
      const box = card.getBoundingClientRect();
      const lines = [...card.querySelectorAll<HTMLElement>('.card-line')].map(
        (line) => line.getBoundingClientRect().top - box.top,
      );
      return [box.height, ...lines];
    }),
  );

const clippedOf = (locator: Locator): Promise<boolean> =>
  locator.evaluate((el) => el.scrollWidth > el.clientWidth);

test.describe('카드의 잘린 제목 · 2줄째 툴팁 (#201, ADR-124, screens.md 1.4 "말줄임 + 툴팁")', () => {
  test('400px 목록: 키보드 초점이 닿은 카드의 잘린 제목이 공통 툴팁으로 보이고 Esc로 닫힌다. 잘리지 않은 카드는 툴팁이 없고 탭은 카드마다 한 번이다. 카드 배치는 그대로다', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openRules(page, [...RULES, ...EXTRA, LONG_RULE]);
    const pane = listPane(page);
    expect((await pane.boundingBox())?.width).toBe(400);
    await expectScrollbar(page);
    // 바꾸기 전과 같은 배치 (카드 높이 59px · 2줄째 한 줄 · 칸 간격, 이전 main에서 잰 값)
    expect(await wideLayoutProblems(pane)).toEqual([]);
    // 잘린 카드 글자는 모두 툴팁에 전체가 보인다 (올림으로 열어 보고 닫는다)
    expect(await listPaneOverflow(pane)).toEqual([]);
    await expect(tooltip(page)).toHaveCount(0);
    const before = await cardGeometry(pane);
    for (const [height] of before) expect(height).toBeCloseTo(CARD_HEIGHT, 1);

    const long = cardOf(page, 'RULE-199');
    // title 속성은 없다 (공통 툴팁으로 바꿈)
    await expect(long.getByTestId('card-title')).not.toHaveAttribute('title');
    await expect(long.getByTestId('card-line-2')).not.toHaveAttribute('title');
    expect(await clippedOf(long.getByTestId('card-title'))).toBe(true);
    await tabToCard(page, 'RULE-199');
    await expect(tooltip(page)).toHaveCount(1);
    await expect(tooltip(page).getByTestId('tooltip-line')).toHaveText([LONG_TITLE]);
    await expect(long).toHaveAttribute('aria-describedby', 'bive-tooltip');
    await expect(long).toHaveAccessibleDescription(LONG_TITLE);
    // 툴팁이 열려도 카드 배치는 그대로다
    expect(await cardGeometry(pane)).toEqual(before);
    expect(await wideLayoutProblems(pane)).toEqual([]);
    await shot(page, '카드-툴팁-1280');

    await page.keyboard.press('Escape');
    await expect(tooltip(page)).toHaveCount(0);
    await expect(long).toBeFocused();
    await expect(long).not.toHaveAttribute('aria-describedby');

    // 다음 Tab은 다음 카드로 간다(카드 안 줄에는 멈추지 않는다). 잘리지 않은 카드에는 툴팁이 없다
    const next = await page.getByTestId('list-items').evaluate((list) => {
      const cards = [...list.querySelectorAll<HTMLElement>('[data-testid="card"]')];
      const index = cards.findIndex((card) => card.getAttribute('data-id') === 'RULE-199');
      return cards[index + 1]?.getAttribute('data-id') ?? '';
    });
    expect(next).not.toBe('');
    await page.keyboard.press('Tab');
    await expect(cardOf(page, next)).toBeFocused();
    await expect(tooltip(page)).toHaveCount(0);
    await expect(cardOf(page, next)).not.toHaveAttribute('aria-describedby');
    expect(await clippedOf(cardOf(page, next).getByTestId('card-title'))).toBe(false);
  });

  test('400px 목록: 마우스를 잘린 제목에 올리면 보이고 떠나면 닫힌다. 잘리지 않은 제목 · 2줄째에는 뜨지 않는다. 마우스 누름 초점으로는 열지 않는다', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openRules(page, [...RULES, ...EXTRA, LONG_RULE]);
    const long = cardOf(page, 'RULE-199');
    await long.getByTestId('card-title').hover();
    await expect(tooltip(page)).toHaveText(LONG_TITLE);
    await expect(tooltip(page)).toHaveAttribute('data-reason', 'hover');
    await expect(long.getByTestId('card-title')).toHaveAttribute(
      'aria-describedby',
      'bive-tooltip',
    );
    await page.mouse.move(0, 0);
    await expect(tooltip(page)).toHaveCount(0);

    const short = cardOf(page, 'RULE-001');
    await short.getByTestId('card-title').hover();
    await short.getByTestId('card-line-2').hover();
    await long.getByTestId('card-line-2').hover();
    await expect(tooltip(page)).toHaveCount(0);

    // 마우스로 누른 카드(선택): 제목이 잘린 카드라도 누름 초점에는 열지 않는다 (마우스는 올림이 연다. 잘리지 않은 2줄째를 누름)
    await long.getByTestId('card-line-2').click();
    await expect(long).toHaveAttribute('aria-current', 'true');
    await expect(long).toBeFocused();
    await expect(tooltip(page)).toHaveCount(0);
  });

  test('220px 목록(1100px 창): 잘린 2줄째에 마우스를 올리면 2줄째 전체가, 키보드 초점이면 잘린 줄 전부가 한 툴팁에 보이고 창 안에 있다', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await openRules(page, [...RULES, ...EXTRA, LONG_RULE]);
    const card = cardOf(page, 'RULE-199');
    expect(await clippedOf(card.getByTestId('card-note'))).toBe(true);
    const note = (await card.getByTestId('card-note').textContent()) ?? '';
    const exceptions = await card.getByTestId('card-exception').allTextContents();
    const line2 = ['RULE-199', note, ...exceptions].join(' · ');
    await card.getByTestId('card-line-2').hover();
    await expect(tooltip(page).getByTestId('tooltip-line')).toHaveText([line2]);
    await page.mouse.move(0, 0);
    await expect(tooltip(page)).toHaveCount(0);

    await tabToCard(page, 'RULE-199');
    await expect(tooltip(page).getByTestId('tooltip-line')).toHaveText([LONG_TITLE, line2]);
    const place = await tooltip(page).evaluate((el) => {
      const box = el.getBoundingClientRect();
      const root = document.documentElement;
      return {
        left: box.left,
        right: box.right,
        width: root.clientWidth,
        scroll: root.scrollWidth - root.clientWidth,
      };
    });
    expect(place.left).toBeGreaterThanOrEqual(0);
    expect(place.right).toBeLessThanOrEqual(place.width);
    expect(place.scroll).toBe(0);
    await shot(page, '카드-툴팁-1100');
  });

  test('카드 수만큼 툴팁 요소 · DOM 리스너가 늘지 않는다: 카드에는 리스너가 없고, 툴팁은 열린 것 하나만 있다', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openRules(page, [...RULES, ...EXTRA, LONG_RULE]);
    await expect(tooltip(page)).toHaveCount(0);
    await expect(
      page
        .getByTestId('list-items')
        .locator('[data-testid="card-title"][title], [data-testid="card-line-2"][title]'),
    ).toHaveCount(0);
    const session = await page.context().newCDPSession(page);
    const listenersOf = async (expression: string): Promise<string[]> => {
      const { result } = await session.send('Runtime.evaluate', { expression });
      if (result.objectId === undefined) throw new Error(`대상 없음: ${expression}`);
      const { listeners } = await session.send('DOMDebugger.getEventListeners', {
        objectId: result.objectId,
      });
      return listeners.map((listener) => listener.type);
    };
    // 카드 · 카드 안 줄에는 툴팁용 DOM 리스너(올림 · 초점 · 키)가 없다 (React 이벤트 속성은 뿌리에서 한 번 받는다. 선택 버튼의
    // click은 React가 원래 다는 것이라 세지 않는다)
    const TOOLTIP_EVENTS = /^(mouse|pointer|focus|blur|key)/;
    for (const testId of ['card', 'card-title', 'card-line-2']) {
      const types = await listenersOf(
        `document.querySelector('[data-id="RULE-199"] [data-testid="${testId}"], [data-id="RULE-199"][data-testid="${testId}"]')`,
      );
      expect(
        types.filter((type) => TOOLTIP_EVENTS.test(type)),
        testId,
      ).toEqual([]);
    }
    // 창 · 문서 리스너(Esc · 밖 누름 · 스크롤 · 창 크기)는 툴팁이 열린 동안만 하나씩 더해지고 닫히면 빠진다
    // 툴팁이 다는 자리: 창의 keydown(캡처) · scroll(캡처) · resize, 문서의 pointerdown(캡처)
    const ADDED = ['window:keydown', 'window:scroll', 'window:resize', 'document:pointerdown'];
    const documentListeners = async (): Promise<Record<string, number>> => {
      const win = await listenersOf('window');
      const doc = await listenersOf('document');
      return Object.fromEntries(
        ADDED.map((key) => {
          const [target, type] = key.split(':');
          const list = target === 'window' ? win : doc;
          return [key, list.filter((listener) => listener === type).length];
        }),
      );
    };
    const closed = await documentListeners();
    await tabToCard(page, 'RULE-199');
    await expect(tooltip(page)).toHaveCount(1);
    expect(await documentListeners()).toEqual(
      Object.fromEntries(ADDED.map((key) => [key, (closed[key] ?? 0) + 1])),
    );
    // 여러 카드를 오가도 툴팁은 하나
    for (const id of ['RULE-101', 'RULE-199', 'RULE-102']) {
      await cardOf(page, id).getByTestId('card-title').hover();
      expect(await page.getByRole('tooltip').count()).toBeLessThanOrEqual(1);
    }
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    await expect(tooltip(page)).toHaveCount(0);
    expect(await documentListeners()).toEqual(closed);
  });

  test('대상이 보이는 영역 밖으로 스크롤되면 닫히고, 창 크기가 바뀌어도 닫힌다. 보이는 영역 밖의 대상에는 열지 않는다 (#275 검토 B2)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 500 });
    await openRules(page, [...RULES, ...EXTRA, LONG_RULE]);
    const long = cardOf(page, 'RULE-199');
    const items = page.getByTestId('list-items');
    await tabToCard(page, 'RULE-199');
    await expect(tooltip(page)).toHaveText(LONG_TITLE);
    await expect(long).toHaveAttribute('aria-describedby', 'bive-tooltip');

    // 목록 칸 안에서 스크롤해도 대상이 보이면 툴팁은 남고 대상을 따라간다
    const before = await tooltip(page).boundingBox();
    const delta = await items.evaluate((el) => {
      const start = el.scrollTop;
      el.scrollTop = start + 4;
      if (el.scrollTop === start) el.scrollTop = start - 4;
      return el.scrollTop - start;
    });
    expect(delta).not.toBe(0);
    await expect
      .poll(async () => (await tooltip(page).boundingBox())?.y)
      .toBeCloseTo((before?.y ?? 0) - delta, 0);
    await expect(long).toHaveAttribute('aria-describedby', 'bive-tooltip');

    // 대상이 목록 칸 밖으로 나가게 스크롤하면 닫히고 연결도 지워진다
    const away = await items.evaluate((el, id) => {
      const card = el.querySelector(`[data-id="${id}"]`);
      el.scrollTop =
        card instanceof HTMLElement && card.offsetTop > el.clientHeight ? 0 : el.scrollHeight;
      return el.scrollTop;
    }, 'RULE-199');
    expect(away).toBeGreaterThanOrEqual(0);
    await expect(tooltip(page)).toHaveCount(0);
    await expect(long).not.toHaveAttribute('aria-describedby');
    expect(
      await long.evaluate((card) => {
        const box = card.getBoundingClientRect();
        const list = card.closest('[data-testid="list-items"]')?.getBoundingClientRect();
        return list !== undefined && (box.bottom <= list.top || box.top >= list.bottom);
      }),
    ).toBe(true);

    // 보이는 영역 밖의 카드에 마우스 이벤트가 와도 열지 않는다
    await long
      .getByTestId('card-title')
      .dispatchEvent('mouseover', { relatedTarget: null, bubbles: true });
    await nextFrame(page);
    await expect(tooltip(page)).toHaveCount(0);

    // 다시 보이게 하고 열어 둔 뒤 창 크기를 바꾸면 닫힌다
    await long.scrollIntoViewIfNeeded();
    await long.getByTestId('card-title').hover();
    await expect(tooltip(page)).toHaveText(LONG_TITLE);
    await page.setViewportSize({ width: 1240, height: 500 });
    await expect(tooltip(page)).toHaveCount(0);
    await expect(long.getByTestId('card-title')).not.toHaveAttribute('aria-describedby');
  });

  test('툴팁 문구는 표시 값 도우미를 거친 글자 노드다: 숨은 글자는 보이는 표기, 꺾쇠 글은 글자 그대로 (요구사항 카드)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const sample = REQUIREMENTS[0];
    if (sample === undefined) throw new Error('요구사항 시험 데이터 없음');
    const text =
      '로그인 실패가 다섯 번 이어지면 계정을 잠그고 \u202E관리자에게 알린다 <b>굵게</b> <img src=x onerror="window.__xss=1"> 끝까지 긴 요구사항 본문';
    await mockBive(page, {
      responses: {
        'system.status': { result: STATUS },
        'project.current': { result: { project: PROJECT } },
        'requirement.list': { result: { requirements: [{ ...sample, text }] } },
        'rule.list': { result: { rules: [] } },
        'judgment.list': { result: { judgments: [] } },
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: '요구사항', exact: true }).click();
    const title = page.getByTestId('card-title');
    await expect(title).toHaveCount(1);
    expect(await clippedOf(title)).toBe(true);
    await title.hover();
    await expect(tooltip(page)).toHaveText(text.replace('\u202E', '\\u202e'));
    const inner = await tooltip(page).evaluate((el) => ({
      elements: [...el.querySelectorAll('*')].map((child) => child.tagName.toLowerCase()),
      hidden: /[\u202a-\u202e\u2066-\u2069]/.test(el.textContent ?? ''),
    }));
    expect(inner).toEqual({ elements: ['span'], hidden: false });
    expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
  });
});
