// 코드 열기 링크 · 사유 선택 (이슈 #43 수용 기준 1, screens.md 1.4 코드 열기 · 1.1, MET-01 · ADR-084).
// 1) 공통 CodeLink(`file:line`)를 누르면 사유 3종(화면 오류, 정보 부족, 디버깅) 모달이 열린다
// 2) 선택 없이 닫으면(취소 · Esc · 바깥 클릭 · ×) IDE 호출(`app.openInIde`)이 0회다
// 3) 사유를 고르면 `app.openInIde`를 1회, 출발 화면 · 항목 · 사유 · 파일 · 줄과 함께 부르고 모달을 닫는다. 키보드로도 고른다
// 4) 실패하면 모달에 "IDE 열기 실패", 부르는 동안은 사유 · 닫기를 막는다
// 5) 1280 × 800 창에서 링크 · 모달 문구가 잘리거나 가로 스크롤을 만들지 않는다
// 기록 · 열기 순서(기록 실패면 열지 않음)는 main의 test/code-opener.test.ts, 기록 저장은 orchestrator/test/code-open.test.ts.
// 데이터는 가짜 브리지의 rule.list · judgment.list · requirement.get 응답(규칙 상세의 실패 케이스)뿐이다.
import type { CodeOpenRecordResult } from '@bive/shared';
import { expect, type Locator, type Page, test } from '@playwright/test';

import {
  FAILED_CASE,
  FAILING_HISTORY,
  FAILING_RULE,
  PARENT,
  PROJECT,
  RULES,
} from './checklists/scr-06.js';
import { type BiveMock, type MockCall, mockBive, type MockResponses } from './support/bive-mock.js';
import { collectVisibleText, findForbiddenText } from './support/expectScreen.js';
import { horizontalOverflow, textClipping } from './support/overflow.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
const LOCATION = `${FAILED_CASE.file}:${String(FAILED_CASE.line)}`;

/** app.openInIde 가짜 성공 응답 (테스트 전용 데이터, 화면은 결과를 읽지 않는다). */
const OPENED: CodeOpenRecordResult = {
  record: {
    id: '01JF0000000000000000000001',
    at: '2026-11-14T09:00:00.000Z',
    reason: 'debugging',
    sourceScreen: 'SCR-03',
    itemRef: { entity: 'Rule', id: FAILING_RULE.id },
    file: FAILED_CASE.file,
    line: FAILED_CASE.line ?? 1,
  },
};

/** 규칙 화면(SCR-03)에서 실패 규칙을 골라 실패 원인을 펼친 상태로 연다. */
const openFailingRule = async (page: Page, responses: MockResponses = {}): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'rule.list': { result: { rules: RULES } },
      'judgment.list': { result: { judgments: FAILING_HISTORY } },
      'requirement.get': { result: { requirement: PARENT } },
      'app.openInIde': { result: OPENED },
      ...responses,
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '규칙', exact: true }).click();
  await page.getByTestId('card').filter({ hasText: 'RULE-002' }).click();
  await expect(page.getByTestId('rule-detail')).toHaveAttribute(
    'data-selected-id',
    FAILING_RULE.id,
  );
  await expect(page.getByTestId('failure-case')).toBeVisible();
  return bive;
};

const ideCalls = async (bive: BiveMock): Promise<MockCall[]> =>
  (await bive.calls()).filter((call) => call.method === 'app.openInIde');

const codeLink = (page: Page): Locator => page.getByTestId('failure-case').getByTestId('code-link');

const dialog = (page: Page): Locator => page.getByTestId('code-open-dialog');

const openDialog = async (page: Page): Promise<Locator> => {
  await codeLink(page).click();
  await expect(dialog(page)).toBeVisible();
  return dialog(page);
};

const REASONS = [
  ['screen_error', '화면 오류'],
  ['info_lacking', '정보 부족'],
  ['debugging', '디버깅'],
] as const;

test.describe('사유 모달 (수용 기준 1)', () => {
  test('file:line 링크를 누르면 사유 3종(화면 오류 · 정보 부족 · 디버깅) 모달이 열리고 대상 위치가 보인다', async ({
    page,
  }) => {
    const bive = await openFailingRule(page);
    await expect(codeLink(page)).toHaveText(LOCATION);
    await expect(dialog(page)).toHaveCount(0);
    const modal = await openDialog(page);
    await expect(modal).toHaveAttribute('role', 'dialog');
    await expect(modal.getByRole('heading', { name: '코드 열기 사유' })).toBeVisible();
    await expect(modal.getByTestId('code-open-target')).toHaveText(LOCATION);
    for (const [reason, label] of REASONS) {
      await expect(modal.getByTestId(`code-open-reason-${reason}`)).toHaveText(label);
    }
    await expect(modal.getByRole('group').getByRole('button')).toHaveText(
      REASONS.map(([, label]) => label),
    );
    // 모달을 여는 것만으로는 IDE를 부르지 않는다
    expect(await ideCalls(bive)).toEqual([]);
  });

  for (const [how, close] of [
    ['취소', (page: Page) => dialog(page).getByTestId('code-open-cancel').click()],
    ['Esc', (page: Page) => page.keyboard.press('Escape')],
    [
      '바깥 클릭',
      (page: Page) =>
        page.getByTestId('code-open-dialog-backdrop').click({ position: { x: 5, y: 5 } }),
    ],
    ['×', (page: Page) => dialog(page).getByTestId('code-open-dialog-close').click()],
  ] as const) {
    test(`선택 없이 닫으면(${how}) IDE 호출이 0회다`, async ({ page }) => {
      const bive = await openFailingRule(page);
      await openDialog(page);
      await close(page);
      await expect(dialog(page)).toHaveCount(0);
      // 다시 열고 닫아도 0회
      await openDialog(page);
      await close(page);
      await expect(dialog(page)).toHaveCount(0);
      expect(await ideCalls(bive)).toEqual([]);
      // 키보드 · 버튼으로 닫으면 초점이 링크로 돌아온다 (바깥 클릭은 누른 곳으로 초점이 가는 브라우저 기본 동작을 따른다)
      if (how !== '바깥 클릭') await expect(codeLink(page)).toBeFocused();
    });
  }
});

test.describe('사유 선택', () => {
  test('"디버깅"을 고르면 app.openInIde를 1회(출발 화면 · 항목 · 사유 · 파일 · 줄) 부르고 모달을 닫는다', async ({
    page,
  }) => {
    const bive = await openFailingRule(page);
    const modal = await openDialog(page);
    await modal.getByTestId('code-open-reason-debugging').click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await ideCalls(bive)).toEqual([
      {
        method: 'app.openInIde',
        params: {
          projectId: PROJECT.id,
          reason: 'debugging',
          sourceScreen: 'SCR-03',
          itemRef: { entity: 'Rule', id: FAILING_RULE.id },
          file: FAILED_CASE.file,
          line: FAILED_CASE.line,
        },
      },
    ]);
  });

  test('키보드만으로: Enter로 링크 → Tab으로 사유 이동 → Enter로 "정보 부족"', async ({ page }) => {
    const bive = await openFailingRule(page);
    await codeLink(page).focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(dialog(page).getByTestId('code-open-reason-screen_error')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog(page).getByTestId('code-open-reason-info_lacking')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toHaveCount(0);
    const calls = await ideCalls(bive);
    expect(calls.map((call) => (call.params as { reason: string }).reason)).toEqual([
      'info_lacking',
    ]);
  });

  test('부르는 동안은 사유 · 취소가 막히고 Esc로 닫히지 않아 두 번 부르지 않는다', async ({
    page,
  }) => {
    const bive = await openFailingRule(page, { 'app.openInIde': { pending: true } });
    const modal = await openDialog(page);
    await modal.getByTestId('code-open-reason-screen_error').click();
    for (const [reason] of REASONS) {
      await expect(modal.getByTestId(`code-open-reason-${reason}`)).toBeDisabled();
    }
    await expect(modal.getByTestId('code-open-cancel')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(modal).toBeVisible();
    expect(await ideCalls(bive)).toHaveLength(1);
  });

  test('실패하면 모달에 머물러 "IDE 열기 실패"를 보이고, 닫을 수 있다', async ({ page }) => {
    const bive = await openFailingRule(page, {
      'app.openInIde': { error: { code: -32603, message: '내부 오류' } },
    });
    const modal = await openDialog(page);
    await modal.getByTestId('code-open-reason-debugging').click();
    await expect(modal.getByTestId('code-open-error')).toHaveText('IDE 열기 실패');
    await expect(modal.getByTestId('code-open-reason-debugging')).toBeEnabled();
    expect(await ideCalls(bive)).toHaveLength(1);
    await modal.getByTestId('code-open-cancel').click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await ideCalls(bive)).toHaveLength(1);
  });
});

test.describe('1280 × 800 창 (#175와 같은 기준)', () => {
  test('링크는 상세 패널 안에 들어오고, 모달의 제목 · 사유 · 취소 · 오류 문구가 한 줄로 잘리지 않는다', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openFailingRule(page, {
      'app.openInIde': { error: { code: -32603, message: '내부 오류' } },
    });
    const pane = page.getByTestId('rule-detail');
    expect(await horizontalOverflow(pane, '[data-testid="code-link"]')).toEqual([]);
    expect(await horizontalOverflow(pane, '[data-testid="failure-case"] > :not(pre)')).toEqual([]);

    const modal = await openDialog(page);
    await modal.getByTestId('code-open-reason-debugging').click();
    await expect(modal.getByTestId('code-open-error')).toBeVisible();
    expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(
      await textClipping(modal, [
        'code-open-reason-screen_error',
        'code-open-reason-info_lacking',
        'code-open-reason-debugging',
        'code-open-cancel',
        'code-open-error',
        'code-open-target',
      ]),
    ).toEqual([]);
    // 모달이 창 안에 있다
    const box = await modal.boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(1280);
      expect(box.y + box.height).toBeLessThanOrEqual(800);
    }
  });

  test('모달 문구에 금지 문구(화면 코드 등)가 없다', async ({ page }) => {
    await openFailingRule(page);
    await openDialog(page);
    const texts = await collectVisibleText(page);
    expect(findForbiddenText(texts)).toEqual([]);
  });
});
