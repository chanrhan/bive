// SCR-21 설정 (이슈 #18 수용 기준 3, screens.md 7장 X-02, ADR-010 · ADR-035 · ADR-057):
// 사이드바 하단 톱니 → 모달 820 × 600, 바깥 클릭 · Esc · ×로 닫기, 초점 가두기, 예산 · 모델 섹션만 노출,
// [저장] → settings.update(사람 주체) → 검증 상태 다시 읽기.
// 열린 프로젝트가 필요하므로 e2e 전용 플레이그라운드(`/playground/app.html`, 앱 전체 + 프로젝트)에서 연다.
import type { Settings, SettingsValidateResult } from '@bive/shared';
import { expect, type Locator, type Page, test } from '@playwright/test';

import { FIELD_NAMES, HIDDEN_SECTIONS, SETTINGS_TEXT } from './checklists/scr-21.js';
import { type BiveMock, mockBive, type MockResponses } from './support/bive-mock.js';
import { expectScreen, findForbiddenText } from './support/expectScreen.js';

const URL = '/playground/app.html';
/** e2e/playground/app-playground.tsx의 프로젝트 ID. */
const PROJECT_ID = '01JA00000000000000000000P1';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
const EMPTY_ROLE = { model: null, maxBudgetUsd: null, maxTurns: null };

const settingsWith = (overrides: Partial<Settings> = {}): Settings => ({
  projectId: PROJECT_ID,
  run: { maxBudgetUsd: null, maxTurns: null },
  roles: {
    'rule-writer': EMPTY_ROLE,
    planner: EMPTY_ROLE,
    'test-writer': EMPTY_ROLE,
    implementer: EMPTY_ROLE,
    chat: EMPTY_ROLE,
  },
  approvalQueueLimit: 40,
  provisionalPolicy: 'off',
  autoMode: false,
  installAllowlist: [],
  updatedAt: null,
  updatedBy: null,
  ...overrides,
});

const EMPTY = settingsWith();
const FULL_ROLE = { model: 'test-model', maxBudgetUsd: 2, maxTurns: 100 };
const FILLED = settingsWith({
  run: { maxBudgetUsd: 5, maxTurns: 200 },
  roles: {
    ...EMPTY.roles,
    'rule-writer': { model: 'test-model', maxBudgetUsd: 1, maxTurns: 20 },
    'test-writer': FULL_ROLE,
    implementer: FULL_ROLE,
  },
  updatedAt: '2026-10-16T09:00:00.000Z',
  updatedBy: { kind: 'human' },
});

const OK: SettingsValidateResult = { ok: true };
const INCOMPLETE = (missing: string[]): SettingsValidateResult =>
  ({
    ok: false,
    code: -32010,
    reason: 'SETTINGS_INCOMPLETE',
    message: '예산 · 모델 미설정',
    missing,
  }) as SettingsValidateResult;
const ALL_MISSING = [
  'run.maxBudgetUsd',
  'run.maxTurns',
  ...['rule-writer', 'test-writer', 'implementer'].flatMap((role) => [
    `roles.${role}.model`,
    `roles.${role}.maxBudgetUsd`,
    `roles.${role}.maxTurns`,
  ]),
];

const responses = (settings: Settings, validation: SettingsValidateResult): MockResponses => ({
  'system.status': { result: STATUS },
  'settings.get': { result: { settings } },
  'settings.validateForRun': { result: validation },
});

const gear = (page: Page): Locator => page.getByRole('button', { name: '설정', exact: true });
const dialog = (page: Page): Locator => page.getByRole('dialog', { name: SETTINGS_TEXT.title });
const field = (page: Page, name: string): Locator =>
  dialog(page).getByRole('textbox', { name, exact: true });

/** 플레이그라운드를 열고 톱니로 모달을 연 뒤 설정이 그려질 때까지 기다린다. */
const openModal = async (
  page: Page,
  settings: Settings = FILLED,
  validation: SettingsValidateResult = OK,
): Promise<BiveMock> => {
  const bive = await mockBive(page, { responses: responses(settings, validation) });
  await page.goto(URL);
  await gear(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId('settings-budget-model')).toHaveAttribute('data-state', 'ready');
  return bive;
};

const settingsCalls = async (bive: BiveMock) =>
  (await bive.calls()).filter((call) => call.method.startsWith('settings.'));

test.describe('체크리스트', () => {
  test('기본: 저장된 설정 · 검증 통과 · 예산 · 모델 섹션만', async ({ page }) => {
    await openModal(page);
    await expectScreen(page, 'SCR-21', '기본');
    await expect(field(page, '실행 전체 한도 USD')).toHaveValue('5');
    await expect(field(page, '실행 전체 턴')).toHaveValue('200');
    await expect(field(page, 'rule-writer 모델')).toHaveValue('test-model');
    await expect(field(page, 'rule-writer 한도 USD')).toHaveValue('1');
    await expect(field(page, 'rule-writer 턴')).toHaveValue('20');
    await expect(field(page, 'implementer 턴')).toHaveValue('100');
    for (const name of FIELD_NAMES) {
      await expect(field(page, name)).toHaveAttribute('aria-invalid', 'false');
    }
  });

  test('빈: 미설정이면 모든 칸이 비어 있고 필수 표시 · "예산 · 모델 미설정"', async ({ page }) => {
    await openModal(page, EMPTY, INCOMPLETE(ALL_MISSING));
    await expectScreen(page, 'SCR-21', '빈');
    for (const name of FIELD_NAMES) {
      await expect(field(page, name)).toHaveValue('');
      await expect(field(page, name)).toHaveAttribute('aria-invalid', 'true');
      // 자리 표시 글자 없이 레이블만
      await expect(field(page, name)).not.toHaveAttribute('placeholder', /.+/);
    }
  });

  test('나머지 섹션(잠정 승인 · 자동 모드 · 대기열 · 작성 규칙)은 DOM에 없다 (ADR-035)', async ({
    page,
  }) => {
    await openModal(page);
    for (const text of HIDDEN_SECTIONS) {
      await expect(page.getByText(text)).toHaveCount(0);
    }
    // 섹션 목록 항목은 예산 · 모델 하나뿐
    await expect(
      dialog(page).getByRole('navigation', { name: '설정 섹션' }).locator('li'),
    ).toHaveText([SETTINGS_TEXT.section]);
    await expect(page.getByTestId('settings-role-planner')).toHaveCount(0);
    await expect(page.getByTestId('settings-role-chat')).toHaveCount(0);
  });
});

test.describe('모달 열기 · 닫기', () => {
  test('톱니를 누르면 820 × 600 모달이 창 가운데에 열리고 그 프로젝트의 설정 · 검증 상태를 읽는다', async ({
    page,
  }) => {
    const bive = await openModal(page);
    const box = await dialog(page).boundingBox();
    const viewport = page.viewportSize();
    if (box === null || viewport === null) throw new Error('모달 · 뷰포트 없음');
    expect(box.width).toBe(820);
    expect(box.height).toBe(600);
    expect(Math.round(box.x + box.width / 2)).toBe(viewport.width / 2);
    expect(Math.round(box.y + box.height / 2)).toBe(viewport.height / 2);
    await expect(gear(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog(page)).toHaveAttribute('aria-modal', 'true');
    // 개발 서버의 StrictMode는 효과를 두 번 실행하므로 횟수가 아니라 종류 · 파라미터를 본다
    const reads = await settingsCalls(bive);
    expect(new Set(reads.map((call) => call.method))).toEqual(
      new Set(['settings.get', 'settings.validateForRun']),
    );
    for (const call of reads) expect(call.params).toEqual({ projectId: PROJECT_ID });
  });

  test('× 버튼으로 닫으면 초점이 톱니로 돌아간다', async ({ page }) => {
    await openModal(page);
    await page.getByRole('button', { name: SETTINGS_TEXT.close, exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(gear(page)).toBeFocused();
    await expect(gear(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('Esc로 닫는다 (입력 칸에 초점이 있어도)', async ({ page }) => {
    await openModal(page);
    await field(page, 'rule-writer 모델').focus();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(gear(page)).toBeFocused();
  });

  test('바깥을 누르면 닫히고, 모달 안을 누르면 닫히지 않는다', async ({ page }) => {
    await openModal(page);
    await dialog(page).click({ position: { x: 400, y: 300 } });
    await expect(dialog(page)).toBeVisible();
    await page.getByTestId('settings-modal-backdrop').click({ position: { x: 10, y: 10 } });
    await expect(dialog(page)).toHaveCount(0);
  });

  test('열려 있는 동안 Tab · Shift+Tab 초점이 모달 안에서만 돈다', async ({ page }) => {
    await openModal(page);
    const inside = () =>
      page.evaluate(() => {
        const modal = document.querySelector('[data-testid="settings-modal"]');
        return modal !== null && modal.contains(document.activeElement);
      });
    // 입력 11칸 + 저장 + 닫기 = 13개보다 많이 눌러 한 바퀴 이상 돈다
    for (let i = 0; i < 16; i += 1) {
      await page.keyboard.press('Tab');
      expect(await inside()).toBe(true);
    }
    for (let i = 0; i < 16; i += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await inside()).toBe(true);
    }
    // 마지막(닫기) 다음은 첫 칸
    await page.getByRole('button', { name: SETTINGS_TEXT.close, exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(field(page, '실행 전체 한도 USD')).toBeFocused();
  });

  test('열린 프로젝트가 없으면 "프로젝트 없음"만 보이고 설정을 읽지 않는다', async ({ page }) => {
    const bive = await mockBive(page, { responses: responses(EMPTY, OK) });
    await page.goto('/');
    await gear(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByTestId('settings-no-project')).toHaveText(SETTINGS_TEXT.noProject);
    await expect(dialog(page).getByRole('textbox')).toHaveCount(0);
    expect(await settingsCalls(bive)).toEqual([]);
  });

  test('설정을 읽지 못하면 "설정 불러오기 실패"', async ({ page }) => {
    await mockBive(page, {
      responses: {
        ...responses(EMPTY, OK),
        'settings.get': { error: { code: -32603, message: '오케스트레이터 연결 실패' } },
      },
    });
    await page.goto(URL);
    await gear(page).click();
    await expect(page.getByTestId('settings-load-error')).toHaveText('설정 불러오기 실패');
    await expect(dialog(page).getByRole('textbox')).toHaveCount(0);
  });
});

test.describe('저장', () => {
  test('[저장]이 보이는 칸 전부를 사람 주체로 settings.update에 보내고 검증 상태를 다시 읽는다', async ({
    page,
  }) => {
    const bive = await openModal(page, EMPTY, INCOMPLETE(ALL_MISSING));
    await field(page, '실행 전체 한도 USD').fill('5');
    await field(page, '실행 전체 턴').fill('200');
    await field(page, 'rule-writer 모델').fill('  test-model  ');
    await field(page, 'rule-writer 한도 USD').fill('1');
    await field(page, 'rule-writer 턴').fill('20');

    const saved = settingsWith({
      run: { maxBudgetUsd: 5, maxTurns: 200 },
      roles: {
        ...EMPTY.roles,
        'rule-writer': { model: 'test-model', maxBudgetUsd: 1, maxTurns: 20 },
      },
      updatedAt: '2026-10-16T09:00:00.000Z',
      updatedBy: { kind: 'human' },
    });
    const stillMissing = ALL_MISSING.filter(
      (path) => path.startsWith('roles.test-writer') || path.startsWith('roles.implementer'),
    );
    await bive.setResponse('settings.update', { result: { settings: saved } });
    await bive.setResponse('settings.validateForRun', { result: INCOMPLETE(stillMissing) });
    await page.getByRole('button', { name: SETTINGS_TEXT.save, exact: true }).click();

    await expect(page.getByTestId('settings-save-status')).toHaveText(SETTINGS_TEXT.saved);
    await expect(page.getByTestId('settings-validation')).toHaveText(SETTINGS_TEXT.incomplete);
    // 열 때 읽은 호출(StrictMode로 두 번일 수 있음) 뒤의 저장 · 재검증 2건
    const calls = await settingsCalls(bive);
    expect(calls.slice(calls.findIndex((call) => call.method === 'settings.update'))).toEqual([
      {
        method: 'settings.update',
        params: {
          projectId: PROJECT_ID,
          patch: {
            run: { maxBudgetUsd: 5, maxTurns: 200 },
            roles: {
              'rule-writer': { model: 'test-model', maxBudgetUsd: 1, maxTurns: 20 },
              'test-writer': EMPTY_ROLE,
              implementer: EMPTY_ROLE,
            },
          },
          author: { kind: 'human' },
        },
      },
      { method: 'settings.validateForRun', params: { projectId: PROJECT_ID } },
    ]);
    // 저장된 칸은 필수 표시가 풀리고 아직 빈 칸만 남는다
    await expect(field(page, 'rule-writer 모델')).toHaveValue('test-model');
    await expect(field(page, 'rule-writer 모델')).toHaveAttribute('aria-invalid', 'false');
    await expect(field(page, '실행 전체 턴')).toHaveAttribute('aria-invalid', 'false');
    await expect(field(page, 'implementer 모델')).toHaveAttribute('aria-invalid', 'true');

    // 나머지 역할을 채워 저장하면 "설정 완료"
    await bive.setResponse('settings.update', { result: { settings: FILLED } });
    await bive.setResponse('settings.validateForRun', { result: OK });
    for (const role of ['test-writer', 'implementer']) {
      await field(page, `${role} 모델`).fill('test-model');
      await field(page, `${role} 한도 USD`).fill('2');
      await field(page, `${role} 턴`).fill('100');
    }
    await expect(page.getByTestId('settings-save-status')).toHaveCount(0);
    await page.getByRole('button', { name: SETTINGS_TEXT.save, exact: true }).click();
    await expect(page.getByTestId('settings-validation')).toHaveText(SETTINGS_TEXT.complete);
    await expect(page.getByTestId('settings-save-status')).toHaveText(SETTINGS_TEXT.saved);
    expect(findForbiddenText([{ source: '저장 뒤', text: await page.innerText('body') }])).toEqual(
      [],
    );
  });

  test('형식이 틀린 칸(0 USD · 소수 턴 · 글자)은 "입력 오류"이고 저장을 부르지 않는다', async ({
    page,
  }) => {
    const bive = await openModal(page);
    await field(page, '실행 전체 한도 USD').fill('0');
    await field(page, 'implementer 턴').fill('2.5');
    await field(page, 'test-writer 한도 USD').fill('abc');
    await page.getByRole('button', { name: SETTINGS_TEXT.save, exact: true }).click();
    await expect(page.getByTestId('settings-save-status')).toHaveText('입력 오류');
    for (const name of ['실행 전체 한도 USD', 'implementer 턴', 'test-writer 한도 USD']) {
      await expect(field(page, name)).toHaveAttribute('data-state', 'invalid');
    }
    await expect(field(page, 'rule-writer 모델')).toHaveAttribute('data-state', 'filled');
    expect((await settingsCalls(bive)).map((call) => call.method)).not.toContain('settings.update');
    // 고치면 오류 표시가 풀린다
    await field(page, '실행 전체 한도 USD').fill('0.01');
    await expect(field(page, '실행 전체 한도 USD')).toHaveAttribute('data-state', 'filled');
  });

  test('저장 요청이 실패하면 "저장 실패"이고 입력 값은 그대로다', async ({ page }) => {
    const bive = await openModal(page);
    await bive.setResponse('settings.update', {
      error: { code: -32603, message: '오케스트레이터 연결 실패' },
    });
    await field(page, 'rule-writer 모델').fill('model-b');
    await page.getByRole('button', { name: SETTINGS_TEXT.save, exact: true }).click();
    await expect(page.getByTestId('settings-save-status')).toHaveText('저장 실패');
    await expect(field(page, 'rule-writer 모델')).toHaveValue('model-b');
  });
});
