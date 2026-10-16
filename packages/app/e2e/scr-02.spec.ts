// SCR-02 요구사항 (이슈 #17 수용 기준 1~3, screens.md SCR-02 · 1.4, ADR-029 · ADR-035 · ADR-053).
// 1) checklists/scr-02.ts의 기본(카드 1줄 문장, 2줄 ID · 예외 · 시각, 생성 주체 아이콘) · 빈("요구사항 없음") 상태
// 2) [+ 새 요구사항] → 목록 맨 위 입력 줄, Ctrl+Enter(⌘↵) → requirement.create 1회, Esc → 호출 없이 닫힘
// 3) 필터 칩 4종(상태 · 작성 · 승인 · 블록), 블록은 값이 없어 0건 비활성
// 데이터는 가짜 브리지의 project.current · requirement.list · requirement.create 응답과
// project.opened 알림(PROJECT_OPENED_EVENT)으로만 만든다.
import { expect, type Locator, type Page, test } from '@playwright/test';

import type { Project } from '@bive/shared';

import { PROJECT_OPENED_EVENT } from '../src/common/bridge.js';
import { CHIPS, PROJECT, REQUIREMENTS, VISIBLE_ORDER } from './checklists/scr-02.js';
import { type BiveMock, type MockCall, mockBive, type MockResponses } from './support/bive-mock.js';
import { collectVisibleText, expectScreen, findForbiddenText } from './support/expectScreen.js';

// 카드 시각(로컬 `YYYY-MM-DD HH:mm`)을 고정하려고 시간대를 정한다
test.use({ timezoneId: 'Asia/Seoul' });

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
/** 프로젝트 전환 검사용 다른 프로젝트. */
const OTHER_PROJECT: Project = {
  id: '01JCCCCCCCCCCCCCCCCCCCCCCC',
  name: 'other-app',
  rootPath: '/work/other-app',
  baseBranch: 'main',
  createdAt: '2026-10-15T00:00:00.000Z',
};

const NEW_TEXT = '비밀번호 재설정 링크는 30분 뒤 만료';
const NEW_REQUIREMENT = {
  id: '01JB0000000000000000000005',
  displayId: 'REQ-005',
  text: NEW_TEXT,
  author: { kind: 'human' },
  normState: 'approved',
  unrulable: null,
  createdAt: '2026-10-16T04:00:00.000Z',
  updatedAt: '2026-10-16T04:00:00.000Z',
  updatedBy: { kind: 'human' },
  deletedAt: null,
} as const;
const LIVE = REQUIREMENTS.filter((r) => r.deletedAt === null);

const openScreen = async (
  page: Page,
  responses: MockResponses = {},
  { project = true }: { project?: boolean } = {},
): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: project ? PROJECT : null } },
      'requirement.list': { result: { requirements: REQUIREMENTS } },
      ...responses,
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '요구사항', exact: true }).click();
  return bive;
};

const callsOf = async (bive: BiveMock, method: string): Promise<MockCall[]> =>
  (await bive.calls()).filter((call) => call.method === method);

const cardIds = (page: Page): Promise<string[]> => page.getByTestId('card-id').allTextContents();
const newButton = (page: Page): Locator => page.getByTestId('new-requirement-button');
const input = (page: Page): Locator => page.getByTestId('new-requirement-input');
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

test.describe('체크리스트 (수용 기준 1)', () => {
  test('기본: 카드 1줄 문장 · 2줄 ID와 예외와 시각 · 생성 주체 아이콘, 상세 자리', async ({
    page,
  }) => {
    await openScreen(page);
    await expectScreen(page, 'SCR-02', '기본');
  });

  test('빈: "요구사항 없음" 한 줄, [+ 새 요구사항]은 그대로, 칩은 전부 0건 비활성', async ({
    page,
  }) => {
    await openScreen(page, { 'requirement.list': { result: { requirements: [] } } });
    await expectScreen(page, 'SCR-02', '빈');
    for (const chip of CHIPS) await expect(chipButton(page, chip.id)).toBeDisabled();
    await expect(newButton(page)).toBeEnabled();
  });

  test('로딩: 목록 자리는 문구 없이 대기', async ({ page }) => {
    await openScreen(page, { 'requirement.list': { pending: true } });
    await expectScreen(page, 'SCR-02', '로딩');
    await expect(page.getByTestId('requirements-loading')).toHaveText('');
  });

  test('에러: 목록 자리에 "요구사항 불러오기 실패", 사이드바 연결 상태와는 별개', async ({
    page,
  }) => {
    await openScreen(page, {
      'requirement.list': { error: { code: -32004, message: '프로젝트 없음' } },
    });
    await expectScreen(page, 'SCR-02', '에러');
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'connected');
  });

  test('열린 프로젝트가 없으면 "프로젝트 없음"이고 목록을 부르지 않는다', async ({ page }) => {
    const bive = await openScreen(page, {}, { project: false });
    const main = page.getByTestId('main-area');
    await expect(main.getByTestId('empty-state')).toHaveText('프로젝트 없음');
    await expect(main.getByText('요구사항 준비 중')).toHaveCount(0);
    await expect(page.getByTestId('list-view')).toHaveCount(0);
    expect(await callsOf(bive, 'requirement.list')).toEqual([]);
  });
});

test.describe('목록', () => {
  test('requirement.list를 현재 프로젝트로 부르고, 삭제 항목을 빼고 문제 항목 먼저 보인다', async ({
    page,
  }) => {
    const bive = await openScreen(page);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    expect(await cardIds(page)).toEqual([...VISIBLE_ORDER]);
    // 개발 서버의 StrictMode는 처음 그릴 때 효과를 두 번 돌리므로 횟수가 아니라 파라미터만 본다
    const listCalls = await callsOf(bive, 'requirement.list');
    expect(listCalls.length).toBeGreaterThan(0);
    for (const call of listCalls) expect(call.params).toEqual({ projectId: PROJECT.id });

    const lines = page.getByTestId('card-line-2');
    await expect(lines.nth(0)).toHaveText('REQ-002잠정2026-10-15 12:20');
    await expect(lines.nth(1)).toHaveText('REQ-003규칙화 불가2026-10-14 14:05');
    // 정상 항목은 2줄째 예외가 비어 있다 (1.4 카드)
    await expect(lines.nth(2)).toHaveText('REQ-0012026-10-15 10:00');
    await expect(lines.nth(2).getByTestId('card-exception')).toHaveCount(0);
    // 생성 주체는 아이콘만(SVG, 이모지 아님), 이름은 접근 가능한 이름 · 툴팁
    for (const mark of await page.getByTestId('author-mark').all()) {
      await expect(mark.locator('svg')).toHaveCount(1);
      await expect(mark).toHaveText('');
    }
  });

  test('카드를 고르면 선택 표시되고 상세 자리의 "선택 항목 없음"이 사라진다', async ({ page }) => {
    await openScreen(page);
    const card = page.getByTestId('card').filter({ hasText: 'REQ-001' });
    await card.click();
    await expect(card).toHaveAttribute('aria-current', 'true');
    const detail = page.getByTestId('requirement-detail');
    await expect(detail).toHaveAttribute('data-selected-id', LIVE[0]?.id ?? '');
    await expect(detail.getByText('선택 항목 없음')).toHaveCount(0);
  });

  test('[+ 새 요구사항] 버튼은 표준 아이콘(SVG)과 문구', async ({ page }) => {
    await openScreen(page);
    await expect(newButton(page)).toHaveText('새 요구사항');
    await expect(newButton(page).locator('svg')).toHaveCount(1);
  });
});

test.describe('새 요구사항 입력 줄 (수용 기준 2)', () => {
  test('목록 맨 위에 입력 줄을 열고 Ctrl+Enter에 requirement.create를 1회 부른 뒤 목록을 갱신한다', async ({
    page,
  }) => {
    const bive = await openScreen(page, {
      'requirement.create': { result: { requirement: NEW_REQUIREMENT } },
    });
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await expect(page.getByTestId('new-requirement')).toHaveCount(0);

    await newButton(page).click();
    await expect(newButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(input(page)).toBeFocused();
    // 입력 줄이 목록 맨 위(첫 카드 위)에 있다
    const inputBox = await page.getByTestId('new-requirement').boundingBox();
    const firstCard = await page.getByTestId('card').first().boundingBox();
    if (inputBox === null || firstCard === null) throw new Error('입력 줄 · 카드가 화면에 없음');
    expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(firstCard.y);
    // 여러 줄 입력
    await expect(input(page)).toHaveJSProperty('tagName', 'TEXTAREA');

    await input(page).fill(NEW_TEXT);
    await bive.setResponse('requirement.list', {
      result: { requirements: [...REQUIREMENTS, NEW_REQUIREMENT] },
    });
    const listBefore = (await callsOf(bive, 'requirement.list')).length;
    await input(page).press('Control+Enter');

    await expect(page.getByTestId('new-requirement')).toHaveCount(0);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length + 1);
    await expect(page.getByTestId('card-title').filter({ hasText: NEW_TEXT })).toHaveCount(1);
    expect(await callsOf(bive, 'requirement.create')).toEqual([
      {
        method: 'requirement.create',
        params: { projectId: PROJECT.id, text: NEW_TEXT, author: { kind: 'human' } },
      },
    ]);
    // 저장 뒤 목록을 한 번 다시 불러온다
    expect(await callsOf(bive, 'requirement.list')).toHaveLength(listBefore + 1);
  });

  test('⌘↵(Meta+Enter)도 저장이다', async ({ page }) => {
    const bive = await openScreen(page, {
      'requirement.create': { result: { requirement: NEW_REQUIREMENT } },
    });
    await newButton(page).click();
    await input(page).fill(NEW_TEXT);
    await input(page).press('Meta+Enter');
    await expect(page.getByTestId('new-requirement')).toHaveCount(0);
    expect(await callsOf(bive, 'requirement.create')).toHaveLength(1);
  });

  test('Esc는 호출 없이 닫고, 다시 열면 비어 있다', async ({ page }) => {
    const bive = await openScreen(page, {
      'requirement.create': { result: { requirement: NEW_REQUIREMENT } },
    });
    await newButton(page).click();
    await input(page).fill(NEW_TEXT);
    await input(page).press('Escape');
    await expect(page.getByTestId('new-requirement')).toHaveCount(0);
    await expect(newButton(page)).toHaveAttribute('aria-expanded', 'false');
    expect(await callsOf(bive, 'requirement.create')).toEqual([]);

    await newButton(page).click();
    await expect(input(page)).toHaveValue('');
    expect(await callsOf(bive, 'requirement.create')).toEqual([]);
  });

  test('공백만 있는 본문은 보내지 않고 입력 줄을 둔다', async ({ page }) => {
    const bive = await openScreen(page, {
      'requirement.create': { result: { requirement: NEW_REQUIREMENT } },
    });
    await newButton(page).click();
    await input(page).press('Control+Enter');
    await input(page).fill('   \n  ');
    await input(page).press('Control+Enter');
    await expect(input(page)).toBeVisible();
    expect(await callsOf(bive, 'requirement.create')).toEqual([]);
  });

  test('Enter만 누르면 줄바꿈이고 저장하지 않는다', async ({ page }) => {
    const bive = await openScreen(page, {
      'requirement.create': { result: { requirement: NEW_REQUIREMENT } },
    });
    await newButton(page).click();
    await input(page).fill('첫 줄');
    await input(page).press('Enter');
    await input(page).pressSequentially('둘째 줄');
    await expect(input(page)).toHaveValue('첫 줄\n둘째 줄');
    expect(await callsOf(bive, 'requirement.create')).toEqual([]);
  });

  test('한글 조합 중의 Ctrl+Enter · Esc는 가로채지 않는다 (저장 · 닫기 없음)', async ({ page }) => {
    const bive = await openScreen(page, {
      'requirement.create': { result: { requirement: NEW_REQUIREMENT } },
    });
    await newButton(page).click();
    await input(page).fill(NEW_TEXT);
    await input(page).evaluate((element) => {
      const keydown = (init: KeyboardEventInit): void => {
        element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
      };
      keydown({ key: 'Enter', ctrlKey: true, isComposing: true });
      keydown({ key: 'Enter', metaKey: true, isComposing: true });
      keydown({ key: 'Escape', isComposing: true });
      // 조합 상태를 keyCode 229로만 알리는 환경
      keydown({ key: 'Enter', ctrlKey: true, keyCode: 229 });
      keydown({ key: 'Escape', keyCode: 229 });
    });
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toHaveValue(NEW_TEXT);
    expect(await callsOf(bive, 'requirement.create')).toEqual([]);

    // 조합이 끝난 뒤의 Ctrl+Enter는 저장한다
    await input(page).press('Control+Enter');
    await expect(page.getByTestId('new-requirement')).toHaveCount(0);
    expect(await callsOf(bive, 'requirement.create')).toHaveLength(1);
  });

  test('저장 중에 다시 눌러도 1회만 부른다', async ({ page }) => {
    const bive = await openScreen(page, {
      'requirement.create': { result: { requirement: NEW_REQUIREMENT }, delayMs: 400 },
    });
    await newButton(page).click();
    await input(page).fill(NEW_TEXT);
    await input(page).press('Control+Enter');
    await input(page).press('Control+Enter');
    await expect(page.getByTestId('new-requirement')).toHaveCount(0);
    expect(await callsOf(bive, 'requirement.create')).toHaveLength(1);
  });

  test('저장 실패: 입력 줄과 문구를 남기고 "요구사항 저장 실패" 한 줄', async ({ page }) => {
    const bive = await openScreen(page, {
      'requirement.create': { error: { code: -32603, message: '내부 오류' } },
    });
    await newButton(page).click();
    await input(page).fill(NEW_TEXT);
    const listBefore = (await callsOf(bive, 'requirement.list')).length;
    await input(page).press('Control+Enter');
    await expect(page.getByTestId('new-requirement-error')).toHaveText('요구사항 저장 실패');
    await expect(input(page)).toHaveValue(NEW_TEXT);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    expect(await callsOf(bive, 'requirement.create')).toHaveLength(1);
    expect(await callsOf(bive, 'requirement.list')).toHaveLength(listBefore);
  });

  test('빈 목록에서 저장하면 빈 상태가 카드로 바뀐다', async ({ page }) => {
    const bive = await openScreen(page, {
      'requirement.list': { result: { requirements: [] } },
      'requirement.create': { result: { requirement: NEW_REQUIREMENT } },
    });
    await expect(page.getByText('요구사항 없음')).toBeVisible();
    await newButton(page).click();
    await input(page).fill(NEW_TEXT);
    await bive.setResponse('requirement.list', { result: { requirements: [NEW_REQUIREMENT] } });
    await input(page).press('Control+Enter');
    await expect(page.getByTestId('card')).toHaveCount(1);
    await expect(page.getByText('요구사항 없음')).toHaveCount(0);
  });
});

test.describe('필터 칩 (수용 기준 3)', () => {
  test('칩 4종(상태 · 작성 · 승인 · 블록)이 있고 블록은 값이 없어 0건 비활성', async ({ page }) => {
    await openScreen(page);
    const chips = page.getByTestId('list-view').getByTestId('filter-chip-button');
    await expect(chips).toHaveText(CHIPS.map((chip) => chip.label));
    await expect(chipButton(page, 'block')).toBeDisabled();
    for (const id of ['status', 'author', 'approval']) {
      await expect(chipButton(page, id)).toBeEnabled();
    }
    // 비활성 칩은 눌러도 메뉴가 열리지 않는다
    await chipButton(page, 'block').click({ force: true });
    await expect(page.getByTestId('filter-menu')).toHaveCount(0);
  });

  test('값별 개수는 요구사항 필드에서 나오고 근거 데이터가 없는 값은 0건 비활성', async ({
    page,
  }) => {
    await openScreen(page);
    await chipButton(page, 'status').click();
    expect(await menuOptions(page)).toEqual([
      ['정상', '1', false],
      ['추적성 결함', '0', true],
      ['규칙화 불가', '1', false],
      ['잠정', '1', false],
      ['실패', '0', true],
    ]);
    await page.keyboard.press('Escape');

    await chipButton(page, 'author').click();
    expect(await menuOptions(page)).toEqual([
      ['사람', '2', false],
      ['에이전트', '1', false],
    ]);
    await page.keyboard.press('Escape');

    await chipButton(page, 'approval').click();
    expect(await menuOptions(page)).toEqual([
      ['승인', '2', false],
      ['대기', '0', true],
      ['잠정', '1', false],
    ]);
  });

  test('값을 고르면 칩에 값이 보이고 결과 줄이 생기며, 다른 화면에 갔다 와도 유지된다', async ({
    page,
  }) => {
    await openScreen(page);
    await chipButton(page, 'author').click();
    await page.getByTestId('filter-option').filter({ hasText: '에이전트' }).click();
    await page.keyboard.press('Escape');
    await expect(chipButton(page, 'author')).toHaveText('작성: 에이전트');
    expect(await cardIds(page)).toEqual(['REQ-002']);
    await expect(page.getByTestId('list-result')).toHaveText('3개 중 1개 · 초기화');

    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await page.getByRole('button', { name: '요구사항', exact: true }).click();
    await expect(chipButton(page, 'author')).toHaveText('작성: 에이전트');
    expect(await cardIds(page)).toEqual(['REQ-002']);

    await page.getByTestId('list-reset').click();
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await expect(page.getByTestId('list-result')).toHaveCount(0);
  });
});

test.describe('프로젝트 전환 (ADR-034 · ADR-053)', () => {
  test('다른 프로젝트가 열리면 이전 목록 없이 로딩부터 하고, 필터를 비우고 새 프로젝트로 다시 부른다', async ({
    page,
  }) => {
    const bive = await openScreen(page);
    await chipButton(page, 'author').click();
    await page.getByTestId('filter-option').filter({ hasText: '에이전트' }).click();
    await page.keyboard.press('Escape');
    expect(await cardIds(page)).toEqual(['REQ-002']);
    await expect(page.getByTestId('list-result')).toBeVisible();

    // 새 프로젝트의 목록은 잠시 대기한다. 이전 필터가 남아 있으면 에이전트 항목만 보이는 데이터다
    await bive.setResponse('requirement.list', {
      result: { requirements: REQUIREMENTS },
      delayMs: 1500,
    });
    await bive.emit(PROJECT_OPENED_EVENT, { project: OTHER_PROJECT, created: false, empty: false });

    await expect(page.getByTestId('requirements-loading')).toBeVisible();
    await expect(page.getByTestId('card')).toHaveCount(0);
    await expect(page.getByTestId('list-view')).toHaveCount(0);

    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await expect(chipButton(page, 'author')).toHaveText('작성');
    await expect(page.getByTestId('filter-chip-author')).toHaveAttribute('data-selected', 'false');
    await expect(page.getByTestId('list-result')).toHaveCount(0);
    const listCalls = await callsOf(bive, 'requirement.list');
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

  test('입력 줄 · 칩 메뉴를 연 상태와 로딩 · 에러 상태에도 금지 문구가 없다', async ({ page }) => {
    const bive = await openScreen(page);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await newButton(page).click();
    await input(page).fill(NEW_TEXT);
    await expectCleanText(page);
    await input(page).press('Escape');
    await chipButton(page, 'status').click();
    await expect(page.getByTestId('filter-menu')).toBeVisible();
    await expectCleanText(page);
    await page.keyboard.press('Escape');

    // 다른 화면에 갔다 오면 다시 불러온다: 응답 대기(로딩) 상태
    await bive.setResponse('requirement.list', { pending: true });
    await page.getByRole('button', { name: '검증', exact: true }).click();
    await page.getByRole('button', { name: '요구사항', exact: true }).click();
    await expect(page.getByTestId('requirements-loading')).toBeVisible();
    await expectCleanText(page);
  });

  test('에러 상태에도 금지 문구가 없다', async ({ page }) => {
    await openScreen(page, {
      'requirement.list': { error: { code: -32603, message: '내부 오류' } },
    });
    await expect(page.getByTestId('requirements-load-error')).toBeVisible();
    await expectCleanText(page);
  });
});
