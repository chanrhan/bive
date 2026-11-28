// 할 일 진입 · 알림 배지 · 툴팁 (이슈 #226 수용 기준 3, screens.md 6장 할 일 · SCR-17 자리, TODO-01, ADR-100 A7 · D8 · 명세 변경
// "할 일 공통", ADR-035 · ADR-056 · ADR-113 · ADR-119).
// - 배지 = 확인할 것 `total` + 검토 대기열의 열린 항목 수(이슈 #54 수용 기준 3, ADR-157). 상한 표시 · 빨강 경고 없음. 툴팁에
//   종류별 건수(자르기 전 수). 어느 한쪽 조회가 실패하면 합계를 모르므로 배지 없음
// - 할 일 머리 탭은 [확인할 것] · [검토 대기열](옛 승인 대기 · 계약 변경 승인 탭 없음), 마지막 탭은 앱 실행 동안 기억(ADR-034)
// 옛 "배지 = proposal.count 대기 건수" · 안 읽음 점 · 처리 상태 기본 대기 시험은 확인할 것으로 대체되어(ADR-056 배지 규칙 ·
// ADR-063 대체, ADR-119) 이 시험으로 바뀌었다. 데이터는 가짜 브리지(e2e/checklists/scr-17.ts)로만 만든다.
import { expect, type Locator, type Page, test } from '@playwright/test';

import {
  FIXTURE_LIST,
  FIXTURE_TRUNCATED_ONE,
  HIDDEN_TODO_TABS,
  ITEM_SUPERSEDED,
  listOf,
  PROJECT,
  TODO_TAB_LABELS,
} from './checklists/scr-17.js';
import { REVIEW_EMPTY, REVIEW_LIST } from './checklists/scr-18.js';
import { allSettled, type BiveMock, mockBive, type MockResponses } from './support/bive-mock.js';
import { expectScreen } from './support/expectScreen.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;

const setup = async (
  page: Page,
  list = FIXTURE_LIST,
  review: MockResponses['reviewQueue.list'] = { result: REVIEW_EMPTY },
): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'confirmation.list': { result: list },
      ...(review !== undefined && { 'reviewQueue.list': review }),
    },
  });
  await page.goto('/');
  await expect(page.getByTestId('sidebar-project')).toHaveText(PROJECT.name);
  return bive;
};

const todoButton = (page: Page): Locator => page.getByTestId('todo-button');
const badge = (page: Page): Locator => page.getByTestId('todo-badge');
const callsOf = async (bive: BiveMock, method: string): Promise<unknown[]> =>
  (await bive.calls()).filter((c) => c.method === method).map((c) => c.params);

test.describe('알림 배지 · 툴팁 (수용 기준 3)', () => {
  test('배지 숫자 = 확인할 것 total, 툴팁에 종류별 건수, 상한 표시 · 빨강 경고 없음', async ({
    page,
  }) => {
    const bive = await setup(page);

    await expect(badge(page)).toHaveText(String(FIXTURE_LIST.total));
    await expect(todoButton(page)).toHaveAttribute(
      'title',
      '미확인 3 · 테스트 변경 2 · 폐기 1 · 대체 1',
    );
    // 접근 가능한 이름은 그대로 "할 일"
    await expect(page.getByRole('button', { name: '할 일', exact: true })).toBeVisible();
    expect(await callsOf(bive, 'confirmation.list')).toContainEqual({ projectId: PROJECT.id });
    // 옛 승인 대기 건수는 부르지 않는다
    expect(await callsOf(bive, 'proposal.count')).toEqual([]);
    // 상한 표시 · 빨강 경고 없음: 배지는 숫자뿐이고 위험 색이 아니다
    await expect(badge(page)).toHaveText(/^\d+$/);
    const colors = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="todo-badge"]');
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-danger)';
      document.body.append(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      return { background: el === null ? '' : getComputedStyle(el).backgroundColor, danger };
    });
    expect(colors.background).not.toBe(colors.danger);

    // 아이콘을 누르면 할 일 화면, 목록 카드 수 = 배지 숫자 (잘리지 않은 목록)
    await todoButton(page).click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'todo');
    await expect(page.getByTestId('card')).toHaveCount(FIXTURE_LIST.total);
    await expect(page.getByText(/상한/)).toHaveCount(0);
    expect(await callsOf(bive, 'proposal.list')).toEqual([]);
  });

  test('잘린 목록에서도 배지 = total, 툴팁 합 = 배지 (자르기 전 종류별 수)', async ({ page }) => {
    await setup(page, FIXTURE_TRUNCATED_ONE);
    await expect(badge(page)).toHaveText('250');
    await expect(todoButton(page)).toHaveAttribute('title', '미확인 249 · 대체 1');
  });

  test('0건이면 배지 없음, 툴팁은 이름', async ({ page }) => {
    const bive = await setup(page, listOf([]));
    await expect.poll(() => callsOf(bive, 'confirmation.list')).not.toHaveLength(0);
    await expect(badge(page)).toHaveCount(0);
    await expect(todoButton(page)).toHaveAttribute('title', '할 일');
  });

  test('화면에 들어갈 때 다시 조회해 배지를 갱신 (폴링 없음)', async ({ page }) => {
    const bive = await setup(page);
    await expect(badge(page)).toHaveText('7');
    await bive.setResponse('confirmation.list', { result: listOf([ITEM_SUPERSEDED]) });

    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(badge(page)).toHaveText('1');
    await expect(todoButton(page)).toHaveAttribute('title', '대체 1');

    // 화면 이동이 없으면 다시 부르지 않는다
    const before = (await callsOf(bive, 'confirmation.list')).length;
    await page.waitForTimeout(1500);
    expect(await callsOf(bive, 'confirmation.list')).toHaveLength(before);
  });

  test('조회 실패면 배지 없음, 할 일 화면은 목록 불러오기 실패', async ({ page }) => {
    await mockBive(page, {
      responses: {
        'system.status': { result: STATUS },
        'project.current': { result: { project: PROJECT } },
        'confirmation.list': { error: { code: -32603, message: '내부 오류' } },
      },
    });
    await page.goto('/');
    await expect(page.getByTestId('sidebar-project')).toHaveText(PROJECT.name);
    await todoButton(page).click();
    await expect(page.getByTestId('todo-list-pane').getByTestId('empty-state')).toHaveText(
      '목록 불러오기 실패',
    );
    await expect(badge(page)).toHaveCount(0);
  });

  test('프로젝트가 없으면 confirmation.list를 부르지 않고 배지 없음', async ({ page }) => {
    const bive = await mockBive(page, {
      responses: {
        'system.status': { result: STATUS },
        'project.current': { result: { project: null } },
      },
    });
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'connected');
    await todoButton(page).click();
    await expect(page.getByTestId('main-area').getByTestId('empty-state')).toHaveText(
      '프로젝트 없음',
    );
    await expect(badge(page)).toHaveCount(0);
    expect(await callsOf(bive, 'confirmation.list')).toEqual([]);
  });
});

test.describe('검토 대기열을 더한 배지 (이슈 #54 수용 기준 3)', () => {
  test('배지 = 확인할 것 total + 검토 대기열 열린 항목 수, 툴팁에 검토 대기열 종류, 처리된 항목은 세지 않음', async ({
    page,
  }) => {
    // 확인할 것 7 + 검토 대기열 열림 2 (예산 초과 1 · 변이 생존 1, 처리됨 2는 세지 않음)
    const bive = await setup(page, FIXTURE_LIST, { result: REVIEW_LIST });
    await expect(badge(page)).toHaveText('9');
    await expect(todoButton(page)).toHaveAttribute(
      'title',
      '미확인 3 · 테스트 변경 2 · 폐기 1 · 대체 1 · 예산 초과 1 · 변이 생존 1',
    );
    expect(await callsOf(bive, 'reviewQueue.list')).toContainEqual({ projectId: PROJECT.id });
    // 상한 표시 없음: 숫자뿐
    await expect(badge(page)).toHaveText(/^\d+$/);
  });

  test('검토 대기열만 있으면 그 수, 확인할 것 0건이어도 배지가 보인다', async ({ page }) => {
    await setup(page, listOf([]), { result: REVIEW_LIST });
    await expect(badge(page)).toHaveText('2');
    await expect(todoButton(page)).toHaveAttribute('title', '예산 초과 1 · 변이 생존 1');
  });

  test('한쪽 조회만 실패해도 합계를 모르므로 배지 없음 · 툴팁은 이름', async ({ page }) => {
    const bive = await setup(page, FIXTURE_LIST, {
      error: { code: -32603, message: '내부 오류' },
    });
    await expect.poll(() => callsOf(bive, 'reviewQueue.list')).not.toHaveLength(0);
    await expect.poll(() => callsOf(bive, 'confirmation.list')).not.toHaveLength(0);
    await expect(badge(page)).toHaveCount(0);
    await expect(todoButton(page)).toHaveAttribute('title', '할 일');
    // 확인할 것 쪽만 실패해도 같다
    await bive.setResponse('reviewQueue.list', { result: REVIEW_LIST });
    await bive.setResponse('confirmation.list', { error: { code: -32603, message: '내부 오류' } });
    const before = (await callsOf(bive, 'reviewQueue.list')).length;
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect
      .poll(async () => (await callsOf(bive, 'reviewQueue.list')).length)
      .toBe(before + 1);
    await allSettled(bive, 'reviewQueue.list');
    await allSettled(bive, 'confirmation.list');
    await expect(badge(page)).toHaveCount(0);
  });
});

test.describe('할 일 머리 탭', () => {
  test('탭은 확인할 것 · 검토 대기열 순서, 승인 대기 · 계약 변경 승인 탭은 없다', async ({
    page,
  }) => {
    await setup(page);
    await todoButton(page).click();
    // 스크린샷은 scr-17.spec.ts가 남긴다 (같은 파일을 병렬로 쓰지 않게)
    await expectScreen(page, 'SCR-17', '기본', { screenshot: false });

    const tabs = page.getByRole('tablist', { name: '할 일 종류' }).getByRole('tab');
    await expect(tabs).toHaveText([...TODO_TAB_LABELS]);
    for (const name of HIDDEN_TODO_TABS) {
      await expect(page.getByRole('tab', { name, includeHidden: true })).toHaveCount(0);
      await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    }
  });

  test('빈 상태: 확인할 항목 없음', async ({ page }) => {
    await setup(page, listOf([]));
    await todoButton(page).click();
    await expectScreen(page, 'SCR-17', '빈', { screenshot: false });
  });

  test('마지막 탭을 앱 실행 동안 기억한다: 다른 화면에 갔다 와도 검토 대기열, 다시 띄우면 확인할 것 (ADR-034)', async ({
    page,
  }) => {
    await setup(page, FIXTURE_LIST, { result: REVIEW_LIST });
    await todoButton(page).click();
    const tab = (name: string): Locator => page.getByRole('tab', { name, exact: true });
    await expect(tab('확인할 것')).toHaveAttribute('aria-selected', 'true');
    await tab('검토 대기열').click();
    await expect(tab('검토 대기열')).toHaveAttribute('aria-selected', 'true');
    await expect(tab('확인할 것')).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByTestId('todo-review')).toBeVisible();
    await expect(page.getByTestId('todo-confirmation')).toHaveCount(0);

    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await todoButton(page).click();
    await expect(tab('검토 대기열')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('todo-review')).toBeVisible();

    // 확인할 것으로 돌아가도 기억한다
    await tab('확인할 것').click();
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await todoButton(page).click();
    await expect(tab('확인할 것')).toHaveAttribute('aria-selected', 'true');
    await tab('검토 대기열').click();

    // 앱을 다시 띄우면(새 문서) 처음 탭
    await page.reload();
    await expect(page.getByTestId('sidebar-project')).toHaveText(PROJECT.name);
    await todoButton(page).click();
    await expect(tab('확인할 것')).toHaveAttribute('aria-selected', 'true');
  });
});
