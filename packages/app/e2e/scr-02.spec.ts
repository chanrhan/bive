// SCR-02 요구사항 (이슈 #17 수용 기준 1~3, screens.md SCR-02 · 1.4, ADR-029 · ADR-035 · ADR-053).
// 1) checklists/scr-02.ts의 기본(카드 1줄 문장, 2줄 ID · 예외 · 시각, 생성 주체 아이콘) · 빈("요구사항 없음") 상태
// 2) [+ 새 요구사항] → 목록 맨 위 입력 줄, Ctrl+Enter(⌘↵) → requirement.create 1회, Esc → 호출 없이 닫힘
// 3) 필터 칩 4종(상태 · 작성 · 확인 · 블록)
// 이슈 #64(M3-19) 수용 기준 3: 블록 칩이 구현 위치(효력 있는 자식 규칙의 대상 블록)의 값 개수와 함께 활성 (ADR-126)
// 이슈 #227(M7-15) 수용 기준 2: 요구사항 카드 2줄째에 미확인이면 예외 "미확인"(사람이 쓴 요구사항은 확인됨이라 예외 없음),
// 필터 칩 "승인"이 "확인"(미확인 · 확인됨)으로 바뀜 (ADR-100 I3 · B① · 명세 변경 목록 SCR-02, ADR-114)
// 데이터는 가짜 브리지의 project.current · requirement.list · rule.list · requirement.create 응답과
// project.opened 알림(PROJECT_OPENED_EVENT)으로만 만든다.
import { expect, type Locator, type Page, test } from '@playwright/test';

import type { Project, Requirement, RuleWithJudgment } from '@bive/shared';

import { PROJECT_OPENED_EVENT } from '../src/common/bridge.js';
import {
  CHIPS,
  PROJECT,
  REQUIREMENT_RULES,
  REQUIREMENTS,
  VISIBLE_ORDER,
} from './checklists/scr-02.js';
import {
  allSettled,
  type BiveMock,
  type MockCall,
  mockBive,
  type MockResponses,
  nextFrame,
} from './support/bive-mock.js';
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
  confirmation: {
    state: 'confirmed',
    at: '2026-10-16T04:00:00.000Z',
    by: { kind: 'human' },
    basis: { kind: 'requirement_record', at: '2026-10-16T04:00:00.000Z' },
  },
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
      'rule.list': { result: { rules: REQUIREMENT_RULES } },
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
    // 에이전트가 쓴 미확인 요구사항: 2줄째 예외 자리(ID와 시각 사이)에 "미확인"
    await expect(lines.nth(0)).toHaveText('REQ-002미확인2026-10-15 12:20');
    await expect(lines.nth(0).getByTestId('card-exception')).toHaveText(['미확인']);
    // 사람이 쓴 요구사항은 확인됨: 미확인 예외 없음 (규칙화 불가만)
    await expect(lines.nth(1)).toHaveText('REQ-003규칙화 불가2026-10-14 14:05');
    await expect(lines.nth(1).getByTestId('card-exception')).toHaveText(['규칙화 불가']);
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
  test('칩 4종(상태 · 작성 · 확인 · 블록)이 모두 활성이고 옛 "승인" 칩 · 위험도 칩은 없다', async ({
    page,
  }) => {
    await openScreen(page);
    const chips = page.getByTestId('list-view').getByTestId('filter-chip-button');
    await expect(chips).toHaveText(['상태', '작성', '확인', '블록']);
    await expect(chips).toHaveText(CHIPS.map((chip) => chip.label));
    await expect(page.getByTestId('filter-chip-approval')).toHaveCount(0);
    // SCR-02 필터에는 위험도가 없다 (ADR-126)
    await expect(page.getByTestId('filter-chip-risk')).toHaveCount(0);
    for (const id of ['status', 'author', 'confirmation', 'block']) {
      await expect(chipButton(page, id)).toBeEnabled();
    }
  });

  test('블록: 값은 구현 위치(효력 있는 자식 규칙의 대상 블록)에서, 블록마다 한 번씩 센다. 폐기 · 잠정 규칙의 블록은 값이 아니다 (#64, ADR-126)', async ({
    page,
  }) => {
    const bive = await openScreen(page);
    await chipButton(page, 'block').click();
    // REQ-001 auth · lib, REQ-002 auth · legacy-mail
    expect(await menuOptions(page)).toEqual([
      ['auth', '2', false],
      ['legacy-mail', '1', false],
      ['lib', '1', false],
    ]);
    await page.getByTestId('filter-option').filter({ hasText: 'lib' }).click();
    await page.keyboard.press('Escape');
    expect(await cardIds(page)).toEqual(['REQ-001']);
    await chipButton(page, 'block').click();
    await page.getByTestId('filter-option').filter({ hasText: 'legacy-mail' }).click();
    await page.keyboard.press('Escape');
    await expect(chipButton(page, 'block')).toHaveText('블록: legacy-mail, lib');
    // 하나라도 가진 요구사항 (OR). 구현 위치가 없는 REQ-003은 남지 않는다
    expect(await cardIds(page)).toEqual(['REQ-002', 'REQ-001']);
    await expect(page.getByTestId('list-result')).toHaveText('3개 중 2개 · 초기화');
    // 규칙 목록은 이 프로젝트를 폐기 포함으로 읽는다
    const lists = await callsOf(bive, 'rule.list');
    expect(lists.length).toBeGreaterThan(0);
    for (const call of lists) {
      expect(call.params).toEqual({ projectId: PROJECT.id, includeRetired: true });
    }
  });

  test('블록: 규칙 목록은 실행 알림으로는 다시 읽지 않고 규범 변경 알림 하나에 정확히 한 번 다시 읽는다 (ADR-126)', async ({
    page,
  }) => {
    const bive = await openScreen(page);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await expect(page.getByTestId('requirement-detail')).toHaveAttribute('data-selected-id', '');
    await nextFrame(page);
    await allSettled(bive, 'rule.list');
    const before = (await callsOf(bive, 'rule.list')).length;

    // 실행 알림(이 프로젝트): 블록 · 폐기는 실행으로 바뀌지 않으므로 다시 읽지 않는다
    await bive.emit('event.run.updated', {
      projectId: PROJECT.id,
      runId: '01JE0000000000000000000001',
    });
    await bive.emit('event.step.updated', {
      projectId: PROJECT.id,
      runId: '01JE0000000000000000000001',
    });
    await nextFrame(page);
    await allSettled(bive, 'rule.list');
    expect((await callsOf(bive, 'rule.list')).length).toBe(before);

    // 규범 변경 알림 하나: 정확히 한 번
    await bive.emit('event.normChange.appended', { projectId: PROJECT.id, lastSeq: 7 });
    await expect.poll(async () => (await callsOf(bive, 'rule.list')).length).toBe(before + 1);
    await nextFrame(page);
    await allSettled(bive, 'rule.list');
    expect((await callsOf(bive, 'rule.list')).length).toBe(before + 1);
  });

  test('블록: 규칙 목록을 읽는 동안은 목록 자리가 로딩이다', async ({ page }) => {
    await openScreen(page, {
      'rule.list': { result: { rules: REQUIREMENT_RULES }, delayMs: 800 },
    });
    await expect(page.getByTestId('requirements-loading')).toBeVisible();
    await expect(page.getByTestId('list-view')).toHaveCount(0);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await expect(chipButton(page, 'block')).toBeEnabled();
  });

  test('블록: 규칙 목록을 못 읽으면 목록은 보이고 블록 칩만 0건 비활성이다', async ({ page }) => {
    await openScreen(page, { 'rule.list': { error: { code: -32603, message: '내부 오류' } } });
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await expect(chipButton(page, 'block')).toBeDisabled();
    await expect(chipButton(page, 'status')).toBeEnabled();
    await chipButton(page, 'block').click({ force: true });
    await expect(page.getByTestId('filter-menu')).toHaveCount(0);
  });

  test('블록: 고른 값은 다른 화면에 갔다 와도 유지되고(규칙 목록을 다시 읽는 동안 지워지지 않음), 규범 변경 알림으로 값을 다시 센다', async ({
    page,
  }) => {
    const bive = await openScreen(page);
    await chipButton(page, 'block').click();
    await page.getByTestId('filter-option').filter({ hasText: 'lib' }).click();
    await page.keyboard.press('Escape');
    expect(await cardIds(page)).toEqual(['REQ-001']);
    await bive.setResponse('rule.list', { result: { rules: REQUIREMENT_RULES }, delayMs: 500 });
    await page.getByRole('button', { name: '계약', exact: true }).click();
    await page.getByRole('button', { name: '요구사항', exact: true }).click();
    await expect(chipButton(page, 'block')).toHaveText('블록: lib');
    expect(await cardIds(page)).toEqual(['REQ-001']);
    // 새 규칙이 REQ-003에 lib를 더하면 알림 뒤 다시 센다
    const added: RuleWithJudgment = {
      rule: {
        ...(REQUIREMENT_RULES[0] as RuleWithJudgment).rule,
        id: '01JC0000000000000000000299',
        displayId: 'RULE-299',
        parentRequirementId: (REQUIREMENTS[2] as Requirement).id,
        targetBlockIds: ['lib'],
      },
      judgment: { status: 'unjudged', latest: null },
    };
    await bive.setResponse('rule.list', { result: { rules: [...REQUIREMENT_RULES, added] } });
    await bive.emit('event.normChange.appended', { projectId: PROJECT.id, lastSeq: 3 });
    await expect.poll(() => cardIds(page)).toEqual(['REQ-003', 'REQ-001']);
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
      ['미확인', '1', false],
      ['실패', '0', true],
    ]);
    await page.keyboard.press('Escape');

    await chipButton(page, 'author').click();
    expect(await menuOptions(page)).toEqual([
      ['사람', '2', false],
      ['에이전트', '1', false],
    ]);
    await page.keyboard.press('Escape');

    // 확인: 미확인 1(에이전트가 쓴 REQ-002) · 확인됨 2(사람이 쓴 REQ-001 · 003)
    await chipButton(page, 'confirmation').click();
    expect(await menuOptions(page)).toEqual([
      ['미확인', '1', false],
      ['확인됨', '2', false],
    ]);
    await page.keyboard.press('Escape');

    // 확인됨을 고르면 사람이 쓴 요구사항만 남는다
    await chipButton(page, 'confirmation').click();
    await page.getByTestId('filter-option').filter({ hasText: '확인됨' }).click();
    await page.keyboard.press('Escape');
    await expect(chipButton(page, 'confirmation')).toHaveText('확인: 확인됨');
    expect(await cardIds(page)).toEqual(['REQ-003', 'REQ-001']);
    await expect(page.getByTestId('list-result')).toHaveText('3개 중 2개 · 초기화');
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

test.describe('추적성 결함 · 규칙화 불가 (M3-11 #56 수용 기준 3, NRM-06 · NRM-08 · ADR-137)', () => {
  /**
   * 서버의 추적성 결함 (테스트 전용 데이터): 규칙 없는 요구사항 REQ-002. REQ-003은 규칙화 불가로 표시한 직후 아직 다시 읽지 않은
   * 옛 목록에 남은 경우다(서버는 규칙화 불가를 빼지만 화면이 늦게 받은 목록에 있을 수 있다).
   */
  const traceability = {
    requirementsWithoutRules: [REQUIREMENTS[1], REQUIREMENTS[2]].map((item) => ({
      id: (item as Requirement).id,
      displayId: (item as Requirement).displayId,
    })),
    parentlessRules: [],
  };
  const withDefects: MockResponses = {
    'rule.list': { result: { rules: REQUIREMENT_RULES, traceability } },
  };
  const exceptionsOf = (page: Page, displayId: string): Promise<string[]> =>
    page
      .getByTestId('card')
      .filter({ hasText: displayId })
      .getByTestId('card-exception')
      .allTextContents();

  test('카드 2줄째에 "추적성 결함"(위험 색)과 "규칙화 불가"(경고 색)를 구분해 보이고, 규칙화 불가인 요구사항은 결함으로 보이지 않는다', async ({
    page,
  }) => {
    await openScreen(page, withDefects);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    // 순서: 추적성 결함 · 규칙화 불가 · 미확인 · 실패 (ADR-114)
    await expect.poll(() => exceptionsOf(page, 'REQ-002')).toEqual(['추적성 결함', '미확인']);
    expect(await exceptionsOf(page, 'REQ-003')).toEqual(['규칙화 불가']);
    expect(await exceptionsOf(page, 'REQ-001')).toEqual([]);
    const card = (id: string) => page.getByTestId('card').filter({ hasText: id });
    await expect(
      card('REQ-002').getByTestId('card-exception').filter({ hasText: '추적성 결함' }),
    ).toHaveAttribute('data-tone', 'danger');
    await expect(card('REQ-003').getByTestId('card-exception')).toHaveAttribute(
      'data-tone',
      'warning',
    );
  });

  test('상태 칩에 추적성 결함 · 규칙화 불가가 따로 세어지고, 추적성 결함을 고르면 규칙 없는 요구사항만 남는다', async ({
    page,
  }) => {
    await openScreen(page, withDefects);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await chipButton(page, 'status').click();
    expect(await menuOptions(page)).toEqual([
      ['정상', '1', false],
      ['추적성 결함', '1', false],
      ['규칙화 불가', '1', false],
      ['미확인', '1', false],
      ['실패', '0', true],
    ]);
    await page.getByTestId('filter-option').filter({ hasText: '추적성 결함' }).click();
    await page.keyboard.press('Escape');
    await expect(chipButton(page, 'status')).toHaveText('상태: 추적성 결함');
    expect(await cardIds(page)).toEqual(['REQ-002']);
    await expect(page.getByTestId('list-result')).toHaveText('3개 중 1개 · 초기화');
  });

  test('응답에 추적성 결함이 없으면(옛 응답) 결함을 보이지 않는다 (규칙이 없다고 지어내지 않음)', async ({
    page,
  }) => {
    await openScreen(page, { 'rule.list': { result: { rules: [] } } });
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await expect(page.getByTestId('card-exception').filter({ hasText: '추적성 결함' })).toHaveCount(
      0,
    );
  });

  test('규칙 작성 알림 하나에 rule.list를 한 번 다시 읽어 규칙 없이 끝난 요구사항이 결함으로 보인다 (다른 프로젝트의 알림은 무시)', async ({
    page,
  }) => {
    const bive = await openScreen(page);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await allSettled(bive, 'rule.list');
    const before = (await callsOf(bive, 'rule.list')).length;
    await bive.setResponse('rule.list', {
      result: {
        rules: REQUIREMENT_RULES,
        traceability: {
          ...traceability,
          requirementsWithoutRules: traceability.requirementsWithoutRules.slice(0, 1),
        },
      },
    });
    await bive.emit('event.ruleWriter.changed', {
      projectId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      requirementId: (REQUIREMENTS[1] as Requirement).id,
    });
    await bive.emit('event.ruleWriter.changed', {
      projectId: PROJECT.id,
      requirementId: (REQUIREMENTS[1] as Requirement).id,
    });
    await expect.poll(() => exceptionsOf(page, 'REQ-002')).toEqual(['추적성 결함', '미확인']);
    await nextFrame(page);
    await allSettled(bive, 'rule.list');
    expect((await callsOf(bive, 'rule.list')).length).toBe(before + 1);
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
