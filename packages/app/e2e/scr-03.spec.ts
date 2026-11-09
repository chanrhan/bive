// SCR-03 규칙 (이슈 #24 수용 기준 2 · 3, screens.md SCR-03 · 1.4, ADR-029 · ADR-035 · ADR-060).
// 2) checklists/scr-03.ts의 기본(카드 1줄 제목, 2줄 ID · WHEN 조건 · 예외) · 빈("규칙 없음") 상태
// 3) 필터 칩 6종(판정 · 변이 · 준수 집계 · 블록 · 위험도 · 종류), 변이 · 블록 · 위험도는 값이 없어 0건 비활성
// 데이터는 가짜 브리지의 project.current · rule.list 응답과 project.opened 알림(PROJECT_OPENED_EVENT)으로만 만든다.
import { expect, type Locator, type Page, test } from '@playwright/test';

import type { Project } from '@bive/shared';

import { PROJECT_OPENED_EVENT } from '../src/common/bridge.js';
import { CHIPS, PROJECT, RULES, VISIBLE_ORDER } from './checklists/scr-03.js';
import { type BiveMock, type MockCall, mockBive, type MockResponses } from './support/bive-mock.js';
import { collectVisibleText, expectScreen, findForbiddenText } from './support/expectScreen.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
const OTHER_PROJECT: Project = {
  id: '01JCCCCCCCCCCCCCCCCCCCCCCC',
  name: 'other-app',
  rootPath: '/work/other-app',
  baseBranch: 'main',
  createdAt: '2026-10-15T00:00:00.000Z',
};
const LIVE = RULES.filter(({ rule }) => rule.deletedAt === null);

const openScreen = async (
  page: Page,
  responses: MockResponses = {},
  { project = true }: { project?: boolean } = {},
): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: project ? PROJECT : null } },
      'rule.list': { result: { rules: RULES } },
      ...responses,
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '규칙', exact: true }).click();
  return bive;
};

const callsOf = async (bive: BiveMock, method: string): Promise<MockCall[]> =>
  (await bive.calls()).filter((call) => call.method === method);

const cardIds = (page: Page): Promise<string[]> => page.getByTestId('card-id').allTextContents();
const chipButton = (page: Page, id: string): Locator =>
  page.getByTestId(`filter-chip-${id}`).getByTestId('filter-chip-button');

/** 칩 메뉴의 값별 [문구, 개수, 비활성]. */
const menuOptions = (page: Page): Promise<[string, string, boolean][]> =>
  page
    .getByTestId('filter-option')
    .evaluateAll((labels) =>
      labels.map((label) => [
        label.querySelector('.filter-option-label')?.textContent ?? '',
        label.querySelector('.filter-count')?.textContent ?? '',
        label.querySelector('input')?.disabled ?? false,
      ]),
    );

test.describe('체크리스트 (수용 기준 2)', () => {
  test('기본: 카드 1줄 제목 · 2줄 ID와 WHEN 조건과 예외, 상세 자리, [실행] 미노출', async ({
    page,
  }) => {
    await openScreen(page);
    await expectScreen(page, 'SCR-03', '기본');
  });

  test('빈: "규칙 없음" 한 줄, 칩은 전부 0건 비활성', async ({ page }) => {
    await openScreen(page, { 'rule.list': { result: { rules: [] } } });
    await expectScreen(page, 'SCR-03', '빈');
    for (const chip of CHIPS) await expect(chipButton(page, chip.id)).toBeDisabled();
  });

  test('로딩: 목록 자리는 문구 없이 대기', async ({ page }) => {
    await openScreen(page, { 'rule.list': { pending: true } });
    await expectScreen(page, 'SCR-03', '로딩');
    await expect(page.getByTestId('rules-loading')).toHaveText('');
  });

  test('에러: 목록 자리에 "규칙 불러오기 실패", 사이드바 연결 상태와는 별개', async ({ page }) => {
    await openScreen(page, { 'rule.list': { error: { code: -32004, message: '프로젝트 없음' } } });
    await expectScreen(page, 'SCR-03', '에러');
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'connected');
  });

  test('열린 프로젝트가 없으면 "프로젝트 없음"이고 목록을 부르지 않는다', async ({ page }) => {
    const bive = await openScreen(page, {}, { project: false });
    const main = page.getByTestId('main-area');
    await expect(main.getByTestId('empty-state')).toHaveText('프로젝트 없음');
    await expect(main.getByText('규칙 준비 중')).toHaveCount(0);
    await expect(page.getByTestId('list-view')).toHaveCount(0);
    expect(await callsOf(bive, 'rule.list')).toEqual([]);
  });
});

test.describe('목록', () => {
  test('rule.list를 현재 프로젝트로 부르고, 삭제 항목을 빼고 문제 항목 먼저 보인다', async ({
    page,
  }) => {
    const bive = await openScreen(page);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    expect(await cardIds(page)).toEqual([...VISIBLE_ORDER]);
    // 개발 서버의 StrictMode는 처음 그릴 때 효과를 두 번 돌리므로 횟수가 아니라 파라미터만 본다
    const listCalls = await callsOf(bive, 'rule.list');
    expect(listCalls.length).toBeGreaterThan(0);
    for (const call of listCalls) expect(call.params).toEqual({ projectId: PROJECT.id });
  });

  test('2줄은 ID · WHEN 조건 · 예외이고 시각은 없다, 정상 항목은 예외가 비어 있다', async ({
    page,
  }) => {
    await openScreen(page);
    const lines = page.getByTestId('card-line-2');
    await expect(lines.nth(0)).toHaveText(
      'RULE-002WHEN 결제 후 24시간이 지난 주문의 취소를 요청하면실패',
    );
    // WHEN 조건이 없는 진술은 조건 자리가 비어 있다
    await expect(lines.nth(1)).toHaveText('RULE-003미판정');
    await expect(lines.nth(1).getByTestId('card-note')).toHaveCount(0);
    await expect(lines.nth(2)).toHaveText('RULE-005WHEN API 라우트가 데이터를 읽으면재검증 필요');
    await expect(lines.nth(3)).toHaveText('RULE-006WHEN 재설정 링크가 발급 후 30분을 넘기면잠정');
    await expect(lines.nth(4)).toHaveText('RULE-001WHEN 같은 계정으로 로그인이 5회 연속 실패하면');
    await expect(lines.nth(4).getByTestId('card-exception')).toHaveCount(0);
    await expect(page.getByTestId('list-items').locator('time')).toHaveCount(0);
    // 통과는 1줄 앞 흐린 점(글자 없음), 이름은 접근 가능한 이름 · 툴팁
    const normal = page
      .getByTestId('card')
      .filter({ hasText: 'RULE-001' })
      .getByTestId('status-badge');
    await expect(normal).toHaveAttribute('data-tone', 'normal');
    await expect(normal).toHaveText('');
    await expect(normal).toHaveAttribute('title', '통과');
    // 말줄임 툴팁: 2줄 전체 문구
    await expect(lines.nth(0)).toHaveAttribute(
      'title',
      'RULE-002 · WHEN 결제 후 24시간이 지난 주문의 취소를 요청하면 · 실패',
    );
  });

  test('[문제만]은 예외가 있는 규칙만 보인다', async ({ page }) => {
    await openScreen(page);
    await page.getByTestId('problem-toggle').click();
    expect(await cardIds(page)).toEqual(['RULE-002', 'RULE-003', 'RULE-005', 'RULE-006']);
    await expect(page.getByTestId('list-result')).toHaveText('5개 중 4개 · 초기화');
  });

  test('검색은 제목 · ID · WHEN 조건에서 찾는다', async ({ page }) => {
    await openScreen(page);
    await page.getByTestId('list-search').fill('서비스 계층');
    expect(await cardIds(page)).toEqual(['RULE-005']);
    await page.getByTestId('list-search').fill('24시간이 지난');
    expect(await cardIds(page)).toEqual(['RULE-002']);
  });

  test('카드를 고르면 선택 표시되고 상세 자리의 "선택 항목 없음"이 사라진다', async ({ page }) => {
    await openScreen(page);
    const card = page.getByTestId('card').filter({ hasText: 'RULE-001' });
    await card.click();
    await expect(card).toHaveAttribute('aria-current', 'true');
    const detail = page.getByTestId('rule-detail');
    await expect(detail).toHaveAttribute('data-selected-id', RULES[0]?.rule.id ?? '');
    await expect(detail.getByText('선택 항목 없음')).toHaveCount(0);
  });
});

test.describe('필터 칩 (수용 기준 3)', () => {
  test('칩 6종이 있고 변이 · 블록 · 위험도는 값이 없어 0건 비활성', async ({ page }) => {
    await openScreen(page);
    const chips = page.getByTestId('list-view').getByTestId('filter-chip-button');
    await expect(chips).toHaveText(CHIPS.map((chip) => chip.label));
    for (const chip of CHIPS) {
      if (chip.enabled) await expect(chipButton(page, chip.id)).toBeEnabled();
      else await expect(chipButton(page, chip.id)).toBeDisabled();
    }
    expect(CHIPS.filter((chip) => !chip.enabled).map((chip) => chip.label)).toEqual([
      '변이',
      '블록',
      '위험도',
    ]);
    // 비활성 칩은 눌러도 메뉴가 열리지 않는다
    for (const id of ['mutation', 'block', 'risk']) {
      await chipButton(page, id).click({ force: true });
      await expect(page.getByTestId('filter-menu')).toHaveCount(0);
    }
  });

  test('값별 개수는 최신 판정 · 규칙 필드에서 나오고 근거 데이터가 없는 값은 0건 비활성', async ({
    page,
  }) => {
    await openScreen(page);
    await chipButton(page, 'judgment').click();
    expect(await menuOptions(page)).toEqual([
      ['통과', '2', false],
      ['실패', '1', false],
      ['미판정', '1', false],
      ['격리', '0', true],
      ['재검증 필요', '1', false],
    ]);
    await page.keyboard.press('Escape');

    await chipButton(page, 'compliance').click();
    expect(await menuOptions(page)).toEqual([
      ['판정 가능', '4', false],
      ['잠정', '1', false],
      ['격리', '0', true],
    ]);
    await page.keyboard.press('Escape');

    await chipButton(page, 'kind').click();
    expect(await menuOptions(page)).toEqual([
      ['아키텍처', '1', false],
      ['기술 제약', '1', false],
      ['비즈니스', '3', false],
    ]);
  });

  test('준수 집계: 판정 가능을 고르면 분모 목록만 보이고 다른 화면에 갔다 와도 유지된다', async ({
    page,
  }) => {
    await openScreen(page);
    await chipButton(page, 'compliance').click();
    await page.getByTestId('filter-option').filter({ hasText: '판정 가능' }).click();
    await page.keyboard.press('Escape');
    await expect(chipButton(page, 'compliance')).toHaveText('준수 집계: 판정 가능');
    expect(await cardIds(page)).toEqual(['RULE-002', 'RULE-003', 'RULE-005', 'RULE-001']);
    await expect(page.getByTestId('list-result')).toHaveText('5개 중 4개 · 초기화');

    await page.getByRole('button', { name: '계약', exact: true }).click();
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(chipButton(page, 'compliance')).toHaveText('준수 집계: 판정 가능');

    await page.getByTestId('list-reset').click();
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await expect(page.getByTestId('list-result')).toHaveCount(0);
  });
});

test.describe('프로젝트 전환 (ADR-034 · ADR-060)', () => {
  test('다른 프로젝트가 열리면 이전 목록 없이 로딩부터 하고 새 프로젝트로 다시 부른다', async ({
    page,
  }) => {
    const bive = await openScreen(page);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await bive.setResponse('rule.list', { result: { rules: [] }, delayMs: 1500 });
    await bive.emit(PROJECT_OPENED_EVENT, { project: OTHER_PROJECT, created: false, empty: false });
    // 프로젝트가 열리면 요구사항 화면으로 이동하므로(ADR-055) 다시 규칙으로 간다
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(page.getByTestId('rules-loading')).toBeVisible();
    await expect(page.getByTestId('card')).toHaveCount(0);
    await expect(page.getByTestId('list-view').getByTestId('empty-state')).toHaveText('규칙 없음');
    const listCalls = await callsOf(bive, 'rule.list');
    expect(listCalls.at(-1)?.params).toEqual({ projectId: OTHER_PROJECT.id });
  });
});

test.describe('화면 문구', () => {
  /** 화면 정의서 1.1 금지 패턴(PRD ID · 화면 코드 · 이모지) + 개발 단계 · 미구현 문구(ADR-035). */
  const STAGE_TEXT = [/\bM\d\b/, /준비 중/, /로딩/, /Loading/i];

  const expectCleanText = async (page: Page): Promise<void> => {
    const texts = await collectVisibleText(page);
    expect(findForbiddenText(texts)).toEqual([]);
    const stage = texts.filter(({ text }) => STAGE_TEXT.some((pattern) => pattern.test(text)));
    expect(stage).toEqual([]);
  };

  test('칩 메뉴를 연 상태와 로딩 · 에러 상태에도 금지 문구가 없다', async ({ page }) => {
    const bive = await openScreen(page);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await chipButton(page, 'judgment').click();
    await expect(page.getByTestId('filter-menu')).toBeVisible();
    await expectCleanText(page);
    await page.keyboard.press('Escape');

    await bive.setResponse('rule.list', { pending: true });
    await page.getByRole('button', { name: '검증', exact: true }).click();
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(page.getByTestId('rules-loading')).toBeVisible();
    await expectCleanText(page);
  });

  test('에러 상태에도 금지 문구가 없다', async ({ page }) => {
    await openScreen(page, { 'rule.list': { error: { code: -32603, message: '내부 오류' } } });
    await expect(page.getByTestId('rules-load-error')).toBeVisible();
    await expectCleanText(page);
  });
});
