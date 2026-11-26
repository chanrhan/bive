// SCR-21 설정의 변이 주입 역할 (M3-07 #52 수용 기준 4, COST-01 · NFR-07 · RUN-04, ADR-057 · ADR-139).
// 역할별 표에 변이 주입 행(모델 · 한도 USD · 턴)이 기존 역할과 같은 칸 · 저장 · 검증으로 있고, 그 칸이 비면 검증 결과
// (`settings.validateForRun`의 SETTINGS_INCOMPLETE, 서버 쪽은 orchestrator/test/mutation.test.ts)가 "예산 · 모델 미설정"과 빈 칸
// 표시로 보인다. 옛 설정(변이 주입 역할을 저장한 적 없음)은 그 칸만 빈 채로 읽힌다.
import type { Project, Settings, SettingsValidateResult } from '@bive/shared';
import { expect, type Locator, type Page, test } from '@playwright/test';

import { ROLE_ROWS, SETTINGS_TEXT } from './checklists/scr-21.js';
import { type BiveMock, mockBive } from './support/bive-mock.js';

const PROJECT_ID = '01JA00000000000000000000P1';
const PROJECT: Project = {
  id: PROJECT_ID,
  name: '샘플 앱',
  rootPath: '/work/sample-next-app',
  baseBranch: 'main',
  createdAt: '2026-10-16T09:00:00.000Z',
};
const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
const EMPTY_ROLE = { model: null, maxBudgetUsd: null, maxTurns: null };
const FULL_ROLE = { model: 'test-model', maxBudgetUsd: 2, maxTurns: 100 };

/** 변이 주입 칸만 빈 설정 (이 변경 전에 저장한 프로젝트의 설정과 같은 모양). */
const WITHOUT_MUTATOR: Settings = {
  projectId: PROJECT_ID,
  run: { maxBudgetUsd: 5, maxTurns: 200 },
  roles: {
    'rule-writer': FULL_ROLE,
    planner: EMPTY_ROLE,
    'test-writer': FULL_ROLE,
    implementer: FULL_ROLE,
    mutator: EMPTY_ROLE,
    chat: EMPTY_ROLE,
  },
  dailyBudgetUsd: null,
  approvalQueueLimit: 40,
  provisionalPolicy: 'off',
  autoMode: false,
  installAllowlist: [],
  ide: null,
  updatedAt: '2026-10-16T09:00:00.000Z',
  updatedBy: { kind: 'human' },
};
const MUTATOR_MISSING = [
  'roles.mutator.model',
  'roles.mutator.maxBudgetUsd',
  'roles.mutator.maxTurns',
] as const;
const INCOMPLETE = {
  ok: false,
  code: -32010,
  reason: 'SETTINGS_INCOMPLETE',
  message: '예산 · 모델 미설정',
  missing: [...MUTATOR_MISSING],
} as const satisfies SettingsValidateResult;

const dialog = (page: Page): Locator => page.getByRole('dialog', { name: SETTINGS_TEXT.title });
const field = (page: Page, name: string): Locator =>
  dialog(page).getByRole('textbox', { name, exact: true });

const openModal = async (page: Page): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'settings.get': { result: { settings: WITHOUT_MUTATOR } },
      'settings.validateForRun': { result: INCOMPLETE },
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId('settings-budget-model')).toHaveAttribute('data-state', 'ready');
  return bive;
};

const MUTATOR_FIELDS = ['변이 주입 모델', '변이 주입 한도 USD', '변이 주입 턴'] as const;

test('역할별 표에 변이 주입 행이 implementer 다음에 있고 모델 · 한도 USD · 턴 칸이 있다', async ({
  page,
}) => {
  await openModal(page);
  expect(ROLE_ROWS).toEqual(['rule-writer', 'test-writer', 'implementer', 'mutator']);
  const rows = dialog(page).locator('tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(3)).toHaveAttribute('data-testid', 'settings-role-mutator');
  await expect(rows.nth(3).getByRole('rowheader')).toHaveText('변이 주입');
  for (const name of MUTATOR_FIELDS) await expect(field(page, name)).toBeVisible();
});

test('변이 주입 칸이 비면 검증이 SETTINGS_INCOMPLETE라 "예산 · 모델 미설정"이고 그 세 칸만 빈 칸 표시다', async ({
  page,
}) => {
  const bive = await openModal(page);
  await expect(page.getByTestId('settings-validation')).toHaveText(SETTINGS_TEXT.incomplete);
  await expect(page.getByTestId('settings-validation')).toHaveAttribute('data-state', 'incomplete');
  for (const name of MUTATOR_FIELDS) {
    await expect(field(page, name)).toHaveValue('');
    await expect(field(page, name)).toHaveAttribute('data-state', 'missing');
    await expect(field(page, name)).toHaveAttribute('aria-invalid', 'true');
  }
  for (const name of ['implementer 모델', 'test-writer 턴', 'rule-writer 한도 USD']) {
    await expect(field(page, name)).toHaveAttribute('data-state', 'filled');
  }
  // 검증은 서버의 validateForRun 결과에서만 온다
  expect((await bive.calls()).map((call) => call.method)).toContain('settings.validateForRun');
});

test('변이 주입 칸을 채워 [저장]하면 같은 패치로 settings.update에 실리고, 다시 읽은 검증이 통과면 "설정 완료"', async ({
  page,
}) => {
  const bive = await openModal(page);
  await field(page, '변이 주입 모델').fill('mutator-model');
  await field(page, '변이 주입 한도 USD').fill('0.5');
  await field(page, '변이 주입 턴').fill('30');
  const saved: Settings = {
    ...WITHOUT_MUTATOR,
    roles: {
      ...WITHOUT_MUTATOR.roles,
      mutator: { model: 'mutator-model', maxBudgetUsd: 0.5, maxTurns: 30 },
    },
  };
  await bive.setResponse('settings.update', { result: { settings: saved } });
  await bive.setResponse('settings.validateForRun', { result: { ok: true } });
  await page.getByRole('button', { name: SETTINGS_TEXT.save, exact: true }).click();
  await expect(page.getByTestId('settings-validation')).toHaveText(SETTINGS_TEXT.complete);
  const update = (await bive.calls()).find((call) => call.method === 'settings.update');
  expect(update?.params).toEqual({
    projectId: PROJECT_ID,
    patch: {
      dailyBudgetUsd: null,
      run: { maxBudgetUsd: 5, maxTurns: 200 },
      roles: {
        'rule-writer': FULL_ROLE,
        'test-writer': FULL_ROLE,
        implementer: FULL_ROLE,
        mutator: { model: 'mutator-model', maxBudgetUsd: 0.5, maxTurns: 30 },
      },
    },
    author: { kind: 'human' },
  });
  for (const name of MUTATOR_FIELDS) {
    await expect(field(page, name)).toHaveAttribute('data-state', 'filled');
  }
});

test('변이 주입 칸의 형식 오류(0 USD · 소수 턴)는 "입력 오류"이고 저장을 부르지 않는다', async ({
  page,
}) => {
  const bive = await openModal(page);
  await field(page, '변이 주입 한도 USD').fill('0');
  await field(page, '변이 주입 턴').fill('1.5');
  await page.getByRole('button', { name: SETTINGS_TEXT.save, exact: true }).click();
  await expect(page.getByTestId('settings-save-status')).toHaveText('입력 오류');
  await expect(field(page, '변이 주입 한도 USD')).toHaveAttribute('data-state', 'invalid');
  await expect(field(page, '변이 주입 턴')).toHaveAttribute('data-state', 'invalid');
  expect((await bive.calls()).map((call) => call.method)).not.toContain('settings.update');
});
