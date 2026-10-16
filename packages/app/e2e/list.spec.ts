// 공통 목록 · 카드 · 상태 배지 (이슈 #16 수용 기준 1~4, screens.md 1.4, ADR-029 · ADR-034 · ADR-048).
// 컴포넌트를 올릴 화면이 아직 없어 e2e 전용 플레이그라운드(e2e/playground/list.html)에서 검사한다.
// 플레이그라운드 데이터: 첫 목록 6건
//   RULE-001 통과 · 사람 · 10-01        RULE-002 실패 · 에이전트 · 10-02 (긴 제목)
//   RULE-003 통과 · 변이 미검증 · 에이전트 · 10-05
//   RULE-004 격리 · 사람 · 10-03        RULE-005 재검증 필요 · 변이 생존 · 에이전트 · 10-04
//   RULE-006 통과 · 변이 검증됨 · 사람 · 09-30
import { expect, type Locator, type Page, test } from '@playwright/test';

import { findForbiddenText } from './support/expectScreen.js';

const URL = '/playground/list.html';

const cardIds = (page: Page): Promise<string[]> => page.getByTestId('card-id').allInnerTexts();
const chip = (page: Page, id: string): Locator => page.getByTestId(`filter-chip-${id}`);
const option = (page: Page, criterion: string, value: string): Locator =>
  chip(page, criterion).locator(`[data-testid="filter-option"][data-value="${value}"]`);
const result = (page: Page): Locator => page.getByTestId('list-result');
const search = (page: Page): Locator => page.getByTestId('list-search');
const toggle = (page: Page): Locator => page.getByTestId('problem-toggle');
const view = (page: Page, name: string): Locator =>
  page
    .getByRole('navigation', { name: '플레이그라운드' })
    .getByRole('button', { name, exact: true });

/** 칩 메뉴를 연다 (이미 열려 있으면 그대로). */
const openChip = async (page: Page, id: string): Promise<void> => {
  const button = chip(page, id).getByTestId('filter-chip-button');
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  await expect(chip(page, id).getByTestId('filter-menu')).toBeVisible();
};

/** 칩 메뉴의 값별 개수 (값 → 개수). */
const counts = async (page: Page, id: string): Promise<Record<string, number>> => {
  await openChip(page, id);
  const options = chip(page, id).getByTestId('filter-option');
  const out: Record<string, number> = {};
  for (const element of await options.all()) {
    const value = (await element.getAttribute('data-value')) ?? '';
    out[value] = Number(await element.getByTestId('filter-count').innerText());
  }
  return out;
};

/** CSS 변수 값을 계산된 색으로 바꾼다 (비교용). */
const tokenColor = (page: Page, token: string): Promise<string> =>
  page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);

test.describe('목록: 검색 · 필터 칩 · 결과 줄 (수용 기준 1)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL);
    await expect(page.getByTestId('card')).toHaveCount(6);
  });

  test('/ 키로 검색 입력으로 이동하고, 검색 입력 안의 / 는 글자로 들어간다', async ({ page }) => {
    await expect(search(page)).not.toBeFocused();
    await page.keyboard.press('/');
    await expect(search(page)).toBeFocused();
    await expect(search(page)).toHaveValue('');
    await page.keyboard.type('주문');
    await expect(search(page)).toHaveValue('주문');
    expect(await cardIds(page)).toEqual(['RULE-002', 'RULE-003']);
    await page.keyboard.type('/');
    await expect(search(page)).toHaveValue('주문/');
  });

  test('기준 안 여러 값은 OR, 기준끼리는 AND', async ({ page }) => {
    await openChip(page, 'judgment');
    await option(page, 'judgment', 'fail').locator('input').check();
    expect(await cardIds(page)).toEqual(['RULE-002']);
    await option(page, 'judgment', 'quarantined').locator('input').check();
    // OR: 실패 또는 격리 (문제 항목끼리 시각 최신순)
    expect(await cardIds(page)).toEqual(['RULE-004', 'RULE-002']);

    // AND: (실패 또는 격리) 그리고 에이전트
    await openChip(page, 'author');
    await option(page, 'author', 'agent').locator('input').check();
    expect(await cardIds(page)).toEqual(['RULE-002']);
  });

  test('칩 값마다 개수를 보이고 0건 값은 비활성, 다른 기준을 고르면 개수가 바뀐다', async ({
    page,
  }) => {
    expect(await counts(page, 'judgment')).toEqual({
      pass: 3,
      fail: 1,
      unjudged: 0,
      quarantined: 1,
      needs_recheck: 1,
    });
    await expect(option(page, 'judgment', 'unjudged').locator('input')).toBeDisabled();
    await expect(option(page, 'judgment', 'pass').locator('input')).toBeEnabled();

    await openChip(page, 'author');
    await option(page, 'author', 'agent').locator('input').check();
    expect(await counts(page, 'judgment')).toEqual({
      pass: 1,
      fail: 1,
      unjudged: 0,
      quarantined: 0,
      needs_recheck: 1,
    });
    await expect(option(page, 'judgment', 'quarantined').locator('input')).toBeDisabled();

    // 검색 결과가 0건이면 모든 값이 0이라 기준 칩 자체가 비활성 (ADR-035)
    await search(page).fill('없는 문구');
    await expect(chip(page, 'mutation').getByTestId('filter-chip-button')).toBeDisabled();
  });

  test('고른 값을 칩에 보이고 ×로 그 기준을 해제한다', async ({ page }) => {
    const button = chip(page, 'judgment').getByTestId('filter-chip-button');
    await expect(button).toHaveText('상태');
    await expect(chip(page, 'judgment').getByTestId('filter-chip-clear')).toHaveCount(0);

    await openChip(page, 'judgment');
    await option(page, 'judgment', 'fail').locator('input').check();
    await option(page, 'judgment', 'quarantined').locator('input').check();
    await expect(button).toHaveText('상태: 실패, 격리');
    await expect(chip(page, 'judgment')).toHaveAttribute('data-selected', 'true');

    const clear = chip(page, 'judgment').getByRole('button', { name: '상태 해제' });
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(button).toHaveText('상태');
    await expect(chip(page, 'judgment').getByTestId('filter-chip-clear')).toHaveCount(0);
    await expect(page.getByTestId('card')).toHaveCount(6);
  });

  test('필터 사용 중에만 결과 줄 "n개 중 m개 · 초기화", 초기화로 전부 해제', async ({ page }) => {
    await expect(result(page)).toHaveCount(0);

    await openChip(page, 'judgment');
    await option(page, 'judgment', 'fail').locator('input').check();
    await option(page, 'judgment', 'quarantined').locator('input').check();
    await expect(result(page)).toHaveText('6개 중 2개 · 초기화');

    await search(page).fill('주문');
    await expect(result(page)).toHaveText('6개 중 1개 · 초기화');

    await search(page).fill('없는 문구');
    // 필터 결과 0건은 결과 줄로만 보인다 (ADR-029)
    await expect(result(page)).toHaveText('6개 중 0개 · 초기화');
    await expect(page.getByTestId('card')).toHaveCount(0);
    await expect(page.getByTestId('empty-state')).toHaveCount(0);

    await result(page).getByRole('button', { name: '초기화', exact: true }).click();
    await expect(result(page)).toHaveCount(0);
    await expect(search(page)).toHaveValue('');
    await expect(chip(page, 'judgment').getByTestId('filter-chip-button')).toHaveText('상태');
    await expect(page.getByTestId('card')).toHaveCount(6);
  });

  test('칩 메뉴는 값 글자를 눌러도 열린 채 여러 값을 고르고, Esc · 바깥 누르기로 닫힌다', async ({
    page,
  }) => {
    await openChip(page, 'judgment');
    const menu = chip(page, 'judgment').getByTestId('filter-menu');
    await option(page, 'judgment', 'quarantined').locator('.filter-option-label').click();
    await option(page, 'judgment', 'fail').locator('.filter-option-label').click();
    await expect(menu).toBeVisible();
    await expect(option(page, 'judgment', 'quarantined').locator('input')).toBeChecked();
    await expect(option(page, 'judgment', 'fail').locator('input')).toBeChecked();

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(chip(page, 'judgment').getByTestId('filter-chip-button')).toBeFocused();

    await openChip(page, 'judgment');
    await page.getByTestId('list-items').click({ position: { x: 5, y: 300 } });
    await expect(menu).toHaveCount(0);
  });

  test('항목이 0건인 목록은 "<대상> 없음" 한 줄, 칩은 0건 비활성', async ({ page }) => {
    await view(page, '빈 목록').click();
    await expect(page.getByTestId('empty-state')).toHaveText('규칙 없음');
    await expect(page.getByTestId('card')).toHaveCount(0);
    for (const id of ['judgment', 'author', 'mutation']) {
      await expect(chip(page, id).getByTestId('filter-chip-button')).toBeDisabled();
    }
  });
});

test.describe('목록: [문제만] · 문제 우선 정렬 (수용 기준 2)', () => {
  test('[문제만]은 기본 꺼짐이고 문제 항목(2줄째 예외 1개 이상)이 먼저, 묶음 안은 최신순', async ({
    page,
  }) => {
    await page.goto(URL);
    await expect(toggle(page)).toHaveText('문제만');
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('card')).toHaveCount(6);

    expect(await cardIds(page)).toEqual([
      'RULE-005',
      'RULE-004',
      'RULE-002',
      'RULE-003',
      'RULE-001',
      'RULE-006',
    ]);
    const problems = await page
      .getByTestId('card')
      .evaluateAll((cards) =>
        cards.map((card) => [
          card.getAttribute('data-problem'),
          card.querySelectorAll('[data-testid="card-exception"]').length,
        ]),
      );
    expect(problems).toEqual([
      ['true', 2],
      ['true', 1],
      ['true', 1],
      ['false', 0],
      ['false', 0],
      ['false', 0],
    ]);

    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    expect(await cardIds(page)).toEqual(['RULE-005', 'RULE-004', 'RULE-002']);
    await expect(result(page)).toHaveText('6개 중 3개 · 초기화');
  });
});

test.describe('목록: 필터 상태 유지 범위 (수용 기준 3, ADR-034)', () => {
  /** 첫 목록에 검색어 · 칩 · [문제만]을 건다. */
  const applyFirstFilter = async (page: Page): Promise<void> => {
    await search(page).fill('주문');
    await openChip(page, 'author');
    await option(page, 'author', 'agent').locator('input').check();
    await toggle(page).click();
    await expect(result(page)).toHaveText('6개 중 1개 · 초기화');
    expect(await cardIds(page)).toEqual(['RULE-002']);
  };

  const expectFirstFilter = async (page: Page): Promise<void> => {
    await expect(search(page)).toHaveValue('주문');
    await expect(chip(page, 'author').getByTestId('filter-chip-button')).toHaveText(
      '생성 주체: 에이전트',
    );
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(result(page)).toHaveText('6개 중 1개 · 초기화');
    expect(await cardIds(page)).toEqual(['RULE-002']);
  };

  const expectCleared = async (page: Page): Promise<void> => {
    await expect(page.getByTestId('card')).toHaveCount(6);
    await expect(search(page)).toHaveValue('');
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(result(page)).toHaveCount(0);
    await expect(chip(page, 'author').getByTestId('filter-chip-button')).toHaveText('생성 주체');
  };

  test('다른 화면에 갔다 와도 목록별로 그대로이고, 다른 목록과 섞이지 않는다', async ({ page }) => {
    await page.goto(URL);
    await applyFirstFilter(page);

    await view(page, '다른 화면').click();
    await expect(page.getByTestId('list-view')).toHaveCount(0);
    await view(page, '첫 목록').click();
    await expectFirstFilter(page);

    // 둘째 목록은 자기 상태(빈 필터)로 시작하고, 거기서 바꾼 필터는 첫 목록에 영향이 없다
    await view(page, '둘째 목록').click();
    await expect(page.getByTestId('card')).toHaveCount(3);
    await expect(search(page)).toHaveValue('');
    await expect(result(page)).toHaveCount(0);
    await toggle(page).click();
    await expect(result(page)).toHaveText('3개 중 1개 · 초기화');

    await view(page, '첫 목록').click();
    await expectFirstFilter(page);
    await view(page, '둘째 목록').click();
    await expect(result(page)).toHaveText('3개 중 1개 · 초기화');

    // 디스크(브라우저 저장소)에 남기지 않는다
    const stored = await page.evaluate(() => [localStorage.length, sessionStorage.length]);
    expect(stored).toEqual([0, 0]);
  });

  test('앱을 다시 띄우면(렌더러 재로드 · 새 창) 초기화된다', async ({ page, browser }) => {
    await page.goto(URL);
    await applyFirstFilter(page);

    await page.reload();
    await expectCleared(page);

    await applyFirstFilter(page);
    const context = await browser.newContext();
    try {
      const fresh = await context.newPage();
      await fresh.goto(URL);
      await expectCleared(fresh);
    } finally {
      await context.close();
    }
  });
});

test.describe('카드 · 상태 배지 · 상세 접힘 (수용 기준 4)', () => {
  test('2줄 카드: 1줄 제목 · 2줄 ID · 예외 · 시각, 긴 텍스트는 말줄임 + 툴팁', async ({ page }) => {
    await page.goto(URL);
    const long = page.locator('[data-testid="card"][data-id="RULE-002"]');
    const fullTitle =
      '주문 취소는 결제 승인 후 24시간 이내에만 허용하고 부분 환불은 관리자 승인 뒤에만 처리한다';
    const title = long.getByTestId('card-title');
    await expect(title).toHaveAttribute('title', fullTitle);
    const overflow = await title.evaluate((el) => ({
      ellipsis: getComputedStyle(el).textOverflow,
      whiteSpace: getComputedStyle(el).whiteSpace,
      clipped: el.scrollWidth > el.clientWidth,
    }));
    expect(overflow).toEqual({ ellipsis: 'ellipsis', whiteSpace: 'nowrap', clipped: true });

    // 2줄: 제목 줄 아래에 ID · 예외 · 시각 줄
    const line1 = await long.locator('.card-line-1').boundingBox();
    const line2Box = await long.getByTestId('card-line-2').boundingBox();
    if (line1 === null || line2Box === null) throw new Error('카드 줄이 화면에 없음');
    expect(line2Box.y).toBeGreaterThanOrEqual(line1.y + line1.height - 1);
    await expect(long.getByTestId('card-id')).toHaveText('RULE-002');
    await expect(long.getByTestId('card-exception')).toHaveText(['실패']);
    await expect(long.locator('time')).toHaveText('2026-10-02 09:00');
    await expect(long.getByTestId('card-line-2')).toHaveAttribute(
      'title',
      'RULE-002 · 실패 · 2026-10-02 09:00',
    );
    // 생성 주체는 아이콘만 (접근 가능한 이름 = 주체 이름)
    const author = long.getByTestId('author-mark');
    await expect(author).toHaveAttribute('aria-label', '에이전트');
    await expect(author).toHaveText('');

    // 정상 항목은 2줄째 예외가 비어 있다
    const normal = page.locator('[data-testid="card"][data-id="RULE-001"]');
    await expect(normal.getByTestId('card-exception')).toHaveCount(0);
    await expect(normal.getByTestId('card-id')).toHaveText('RULE-001');
    await expect(normal.locator('time')).toHaveText('2026-10-01 09:00');
    await expect(normal.getByTestId('card-line-2')).toHaveAttribute(
      'title',
      'RULE-001 · 2026-10-01 09:00',
    );
    await expect(normal.getByRole('img', { name: '통과' })).toBeVisible();
    await expect(normal.getByRole('img', { name: '사람' })).toBeVisible();

    // 카드를 누르면 선택 표시
    await normal.click();
    await expect(normal).toHaveAttribute('aria-current', 'true');

    const text = await page.evaluate(() => document.body.innerText);
    expect(findForbiddenText([{ source: '본문', text }])).toEqual([]);
  });

  test('상태 배지: 정상은 글자 없는 흐린 점, 예외는 글자와 색', async ({ page }) => {
    await page.goto(URL);
    await view(page, '배지').click();
    const badges = page.getByTestId('badge-list').getByTestId('status-badge');
    await expect(badges).toHaveCount(8);

    const dot = await tokenColor(page, '--status-normal-dot-color');
    const normals = [
      ['judgment', 'pass', '통과'],
      ['mutation', 'verified', '변이 검증됨'],
      ['mutation', 'unverified', '변이 미검증'],
    ] as const;
    for (const [kind, status, label] of normals) {
      const badge = page.locator(`[data-kind="${kind}"][data-status="${status}"]`);
      await expect(badge).toHaveAttribute('data-tone', 'normal');
      await expect(badge).toHaveText('');
      await expect(badge).toHaveAttribute('aria-label', label);
      await expect(badge).toHaveAttribute('role', 'img');
      const background = await badge
        .locator('.status-dot')
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(background).toBe(dot);
    }

    const exceptions = [
      ['judgment', 'fail', '실패', '--color-danger'],
      ['judgment', 'unjudged', '미판정', '--color-accent'],
      ['judgment', 'quarantined', '격리', '--color-warning'],
      ['judgment', 'needs_recheck', '재검증 필요', '--color-warning'],
      ['mutation', 'survived', '변이 생존', '--color-danger'],
    ] as const;
    const muted = await tokenColor(page, '--color-text-muted');
    for (const [kind, status, label, token] of exceptions) {
      const badge = page.locator(`[data-kind="${kind}"][data-status="${status}"]`);
      await expect(badge).toHaveText(label);
      const color = await badge.evaluate((el) => getComputedStyle(el).color);
      expect(color).toBe(await tokenColor(page, token));
      expect(color).not.toBe(muted);
    }
  });

  test('상세 접힘: 기본 접힘, 판정 실패면 테스트 출력만 자동 펼침', async ({ page }) => {
    await page.goto(URL);
    await view(page, '배지').click();
    const history = page.getByRole('button', { name: '변경 이력' });
    const output = page.getByRole('button', { name: '테스트 출력' });
    await expect(history).toHaveAttribute('aria-expanded', 'false');
    await expect(output).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('출력 본문')).toBeHidden();

    await page.getByTestId('judge-fail').click();
    await expect(output).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('출력 본문')).toBeVisible();
    await expect(history).toHaveAttribute('aria-expanded', 'false');

    // 펼친 뒤에도 사람이 접을 수 있다
    await output.click();
    await expect(output).toHaveAttribute('aria-expanded', 'false');
    await history.click();
    await expect(page.getByText('이력 본문')).toBeVisible();
  });
});
