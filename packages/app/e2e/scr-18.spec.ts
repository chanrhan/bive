// SCR-18 검토 대기열: 목록 · 필터 · 상세 · 종류별 액션 (이슈 #54 수용 기준 1 · 2 · 4, screens.md SCR-18, TODO-02 · COST-01,
// ADR-100 명세 변경 SCR-18 · D8, ADR-145 · ADR-149 · ADR-153 · ADR-155 · ADR-157). 탭 · 배지 · 마지막 탭 기억(수용 기준 3)은
// todo-entry.spec.ts · todo-badge.spec.ts. 데이터는 가짜 브리지(e2e/checklists/scr-18.ts)로만 만든다.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { JsonRpcErrorObject, ReviewQueueListResult } from '@bive/shared';
import { expect, type Locator, type Page, test } from '@playwright/test';

import { FIXTURE_LIST, PROJECT } from './checklists/scr-17.js';
import {
  ENTRY_BUDGET,
  ENTRY_MUTANT,
  ENTRY_QUARANTINED,
  ENTRY_RAISED,
  QUARANTINE_RESULT,
  REVIEW_EMPTY,
  REVIEW_FILTERS,
  REVIEW_LIST,
  RULE_EXPORT,
  RULE_IMPORT,
  RULE_LOCK_SHOWN,
  RUN_GET_BUDGET,
  runGetOf,
  runOf,
} from './checklists/scr-18.js';
import { allSettled, type BiveMock, mockBive, type MockResponses } from './support/bive-mock.js';
import {
  collectVisibleText,
  expectScreen,
  findForbiddenText,
  SCREENSHOT_DIR,
} from './support/expectScreen.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
const HUMAN = { kind: 'human' } as const;

/** 화면에 날 코드 값(enum)이 보이면 안 된다 (1.1, ADR-157). */
const RAW_CODES =
  /\b(?:budget_exceeded|mutant_survived|raise_limit_resume|narrow_allowlist_resume|split_rule|reinforce|quarantine|open|resolved|step_unmet|budget_exhausted|implementer|test-writer)\b/;

const setup = async (
  page: Page,
  list: ReviewQueueListResult = REVIEW_LIST,
  extra: MockResponses = {},
): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'confirmation.list': { result: FIXTURE_LIST },
      'reviewQueue.list': { result: list },
      'run.get': { result: RUN_GET_BUDGET },
      ...extra,
    },
  });
  await page.goto('/');
  await expect(page.getByTestId('sidebar-project')).toHaveText(PROJECT.name);
  await page.getByTestId('todo-button').click();
  await page.getByRole('tab', { name: '검토 대기열', exact: true }).click();
  await expect(page.getByTestId('todo-review')).toBeVisible();
  return bive;
};

const cards = (page: Page): Locator => page.getByTestId('list-items').getByTestId('card');
const detail = (page: Page): Locator => page.getByTestId('todo-detail');
const callsOf = async (bive: BiveMock, method: string): Promise<unknown[]> =>
  (await bive.calls()).filter((c) => c.method === method).map((c) => c.params);
const action = (page: Page, name: string): Locator => page.getByTestId(`review-action-${name}`);
const confirmButton = (page: Page): Locator => page.getByTestId('review-form-confirm');
const selectCard = (page: Page, displayId: string): Promise<void> =>
  cards(page)
    .filter({ has: page.getByTestId('card-id').getByText(displayId) })
    .click();

const snapshot = async (page: Page, name: string): Promise<void> => {
  const file = path.join(SCREENSHOT_DIR, 'SCR-18', `${name}.png`);
  await mkdir(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: true });
  const texts = await collectVisibleText(page);
  expect(findForbiddenText(texts)).toEqual([]);
  expect(texts.filter(({ text }) => RAW_CODES.test(text))).toEqual([]);
};

const rejected = (error: JsonRpcErrorObject): { error: JsonRpcErrorObject } => ({ error });

test.describe('목록 기본 · 빈 상태 (수용 기준 1)', () => {
  test('기본: 1줄 대상 규칙 제목, 2줄 원인 실행 ID · 종류 · 시각, 열린 항목 먼저 · 최신순', async ({
    page,
  }) => {
    const bive = await setup(page);
    await expectScreen(page, 'SCR-18', '기본');

    // 열린 항목(예외 있음) 먼저, 같은 묶음 안에서는 등록 시각 최신순 (서버는 등록 순)
    await expect(cards(page).getByTestId('card-id')).toHaveText([
      'EXE-012',
      'EXE-011',
      'EXE-010',
      'EXE-013',
    ]);
    await expect(cards(page).getByTestId('card-title')).toHaveText([
      `${RULE_EXPORT.title} 외 1`,
      RULE_LOCK_SHOWN,
      RULE_EXPORT.title,
      RULE_LOCK_SHOWN,
    ]);
    // 열린 항목의 종류는 예외(글자 + 색), 처리된 항목은 종류 · 처리한 액션의 보조 문구
    await expect(cards(page).getByTestId('card-exception')).toHaveText(['예산 초과', '변이 생존']);
    await expect(cards(page).nth(0).getByTestId('card-exception')).toHaveAttribute(
      'data-tone',
      'warning',
    );
    await expect(cards(page).nth(1).getByTestId('card-exception')).toHaveAttribute(
      'data-tone',
      'danger',
    );
    await expect(cards(page).getByTestId('card-note')).toHaveText([
      '예산 초과 · 한도 상향 재개',
      '변이 생존 · 판정 격리',
    ]);
    // 자리: 제목은 1줄, ID · 종류 · 시각은 2줄 이 순서
    const first = cards(page).nth(0);
    await expect(first.locator('.card-line-1').getByTestId('card-title')).toHaveText(
      `${RULE_EXPORT.title} 외 1`,
    );
    const line2 = first.getByTestId('card-line-2');
    await expect(line2.locator('time')).toHaveAttribute('datetime', ENTRY_BUDGET.item.createdAt);
    const order = await line2.evaluate((el) =>
      [...el.children].map((c) => c.getAttribute('data-testid') ?? c.tagName.toLowerCase()),
    );
    expect(order).toEqual(['card-id', 'card-exception', 'time']);
    expect(await callsOf(bive, 'reviewQueue.list')).toContainEqual({ projectId: PROJECT.id });
    await snapshot(page, '기본');
  });

  test('빈: 검토 항목 없음', async ({ page }) => {
    await setup(page, REVIEW_EMPTY);
    await expectScreen(page, 'SCR-18', '빈');
  });

  test('조회 실패: 목록 불러오기 실패', async ({ page }) => {
    await setup(page, REVIEW_EMPTY, {
      'reviewQueue.list': rejected({ code: -32603, message: '내부 오류' }),
    });
    await expect(page.getByTestId('todo-list-pane').getByTestId('empty-state')).toHaveText(
      '목록 불러오기 실패',
    );
  });

  test('event.reviewQueue.changed를 받으면 화면 이동 없이 목록이 다시 그려진다', async ({
    page,
  }) => {
    const bive = await setup(page, REVIEW_EMPTY);
    await bive.setResponse('reviewQueue.list', { result: { entries: [ENTRY_MUTANT] } });
    await bive.emit('event.reviewQueue.changed', { projectId: PROJECT.id });
    await expect(cards(page).getByTestId('card-id')).toHaveText(['EXE-011']);
  });
});

test.describe('필터 칩 2종 (수용 기준 4)', () => {
  test('종류 · 처리 상태 칩의 값과 개수, 처리됨만 고르면 처리된 항목만 · 결과 줄 · 초기화', async ({
    page,
  }) => {
    await setup(page);
    const chips = page.getByTestId('list-view').locator('[data-testid^="filter-chip-"]');
    await expect(chips.filter({ has: page.getByTestId('filter-chip-button') })).toHaveCount(2);
    for (const { id, label, values } of REVIEW_FILTERS) {
      const chip = page.getByTestId(`filter-chip-${id}`);
      await expect(chip.getByTestId('filter-chip-button')).toHaveText(label);
      await chip.getByTestId('filter-chip-button').click();
      await expect(chip.locator('.filter-option-label')).toHaveText([...values]);
      await expect(chip.getByTestId('filter-count')).toHaveText(['2', '2']);
      await page.keyboard.press('Escape');
    }

    const state = page.getByTestId('filter-chip-state');
    await state.getByTestId('filter-chip-button').click();
    await state.locator('[data-testid="filter-option"][data-value="resolved"] input').check();
    await page.keyboard.press('Escape');
    await expect(state.getByTestId('filter-chip-button')).toHaveText('처리 상태: 처리됨');
    await expect(cards(page).getByTestId('card-id')).toHaveText(['EXE-010', 'EXE-013']);
    await expect(page.getByTestId('list-result-count')).toHaveText('4개 중 2개');

    // 종류와 AND
    const kind = page.getByTestId('filter-chip-kind');
    await kind.getByTestId('filter-chip-button').click();
    await kind.locator('[data-testid="filter-option"][data-value="mutant_survived"] input').check();
    await page.keyboard.press('Escape');
    await expect(cards(page).getByTestId('card-id')).toHaveText(['EXE-013']);

    await page.getByTestId('list-reset').click();
    await expect(cards(page)).toHaveCount(4);
    await expect(page.getByTestId('list-result')).toHaveCount(0);
  });
});

test.describe('변이 생존 액션 (수용 기준 2)', () => {
  test('[테스트 보강] · [판정 격리] · 꺼진 [이의 제기](까닭은 툴팁), 예산 초과 버튼 없음', async ({
    page,
  }) => {
    await setup(page);
    await selectCard(page, 'EXE-011');
    await expect(detail(page).getByTestId('detail-kind')).toHaveText('변이 생존');
    await expect(detail(page).getByTestId('detail-title')).toHaveText(RULE_LOCK_SHOWN);
    await expect(page.getByTestId('review-actions').getByRole('button')).toHaveText([
      '테스트 보강',
      '판정 격리',
      '이의 제기',
    ]);
    await expect(action(page, 'objection')).toBeDisabled();
    await expect(action(page, 'reinforce')).toBeEnabled();
    await expect(action(page, 'raise_limit_resume')).toHaveCount(0);
    // 꺼진 까닭: 누르면 툴팁 (요청 · 입력 없음). 꺼진 버튼이라 사용자 누름을 그대로 보낸다
    await action(page, 'objection').click({ force: true });
    await expect(page.getByRole('tooltip')).toHaveText('동작 정의 전');
    await expect(page.getByTestId('review-form')).toHaveCount(0);
    // 원인 실행 · 대상 규칙
    await expect(detail(page).getByTestId('detail-run-id')).toContainText('EXE-011');
    await expect(detail(page).getByTestId('detail-run-reason')).toContainText(
      '단계 종료 조건 미충족',
    );
    await expect(detail(page).getByTestId('detail-link')).toHaveText([
      `RULE-011 · ${RULE_LOCK_SHOWN}`,
    ]);
  });

  test('판정 격리: 사유가 비면(공백뿐 포함) [확인]이 꺼지고, 사유가 있으면 1회 호출 뒤 목록을 다시 읽는다', async ({
    page,
  }) => {
    const bive = await setup(page);
    await selectCard(page, 'EXE-011');
    await action(page, 'quarantine').click();
    const reason = page.getByTestId('review-quarantine-reason');
    await expect(confirmButton(page)).toBeDisabled();
    await reason.fill('   \n  ');
    await expect(confirmButton(page)).toBeDisabled();
    await reason.fill('외부 시계 의존');
    await expect(confirmButton(page)).toBeEnabled();

    await bive.setResponse('reviewQueue.quarantine', { result: QUARANTINE_RESULT, delayMs: 300 });
    await allSettled(bive, 'reviewQueue.list');
    const lists = (await callsOf(bive, 'reviewQueue.list')).length;
    await confirmButton(page).click();
    // 요청 중: 버튼이 꺼져 두 번 보내지 않는다
    await expect(confirmButton(page)).toHaveText('저장 중');
    await expect(confirmButton(page)).toBeDisabled();
    await expect(action(page, 'reinforce')).toBeDisabled();
    await expect.poll(async () => (await callsOf(bive, 'reviewQueue.list')).length).toBe(lists + 1);
    expect(await callsOf(bive, 'reviewQueue.quarantine')).toEqual([
      { projectId: PROJECT.id, seq: 1, reason: '외부 시계 의존', author: HUMAN },
    ]);
    // 성공하면 입력이 닫히고 그 자리에 머문다
    await expect(page.getByTestId('review-form')).toHaveCount(0);
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'todo');
  });

  test('테스트 보강: [확인] 1회 · 거부 문구 (이미 처리됨이면 다시 읽기)', async ({ page }) => {
    const bive = await setup(page, REVIEW_LIST, {
      'reviewQueue.reinforce': rejected({
        code: -32009,
        message: 'x',
        data: { reason: 'already_resolved' },
      }),
    });
    await selectCard(page, 'EXE-011');
    await action(page, 'reinforce').click();
    await expect(confirmButton(page)).toBeEnabled();
    await allSettled(bive, 'reviewQueue.list');
    const lists = (await callsOf(bive, 'reviewQueue.list')).length;
    // 같은 틱에 두 번 눌러도 요청은 1회
    await confirmButton(page).evaluate((el) => {
      (el as HTMLButtonElement).click();
      (el as HTMLButtonElement).click();
    });
    await expect(page.getByTestId('review-error')).toHaveText('처리 실패 · 이미 처리됨');
    await page.waitForTimeout(300);
    expect(await callsOf(bive, 'reviewQueue.reinforce')).toEqual([
      { projectId: PROJECT.id, seq: 1, author: HUMAN },
    ]);
    await expect.poll(async () => (await callsOf(bive, 'reviewQueue.list')).length).toBe(lists + 1);
  });
});

test.describe('예산 초과 액션 (수용 기준 2)', () => {
  test('버튼 셋, 원인 실행의 멈춘 단계, 한도 상향 재개: 지금 한도가 처음 값 · 빈 칸이면 꺼짐 · 거부 문구', async ({
    page,
  }) => {
    const bive = await setup(page, REVIEW_LIST, {
      'reviewQueue.resumeWithBudget': rejected({
        code: -32001,
        message: 'x',
        data: {
          reason: 'BUDGET_LOWERED',
          fields: ['run.maxBudgetUsd', 'roles.implementer.maxTurns'],
        },
      }),
    });
    await selectCard(page, 'EXE-012');
    await expect(page.getByTestId('review-actions').getByRole('button')).toHaveText([
      '한도 상향 재개',
      '허용 목록 축소 재개',
      '규칙 분할',
    ]);
    await expect(action(page, 'objection')).toHaveCount(0);
    await expect(detail(page).getByTestId('detail-run-step')).toContainText('구현');
    expect(await callsOf(bive, 'run.get')).toContainEqual({
      projectId: PROJECT.id,
      id: ENTRY_BUDGET.run.id,
    });

    await action(page, 'raise_limit_resume').click();
    const inputs = page.getByTestId('review-budget').locator('input');
    await expect(inputs).toHaveCount(6);
    await expect(page.getByTestId('review-budget').locator('label > span')).toHaveText([
      '실행 전체 USD',
      '실행 전체 턴',
      '테스트 작성 USD',
      '테스트 작성 턴',
      '구현 USD',
      '구현 턴',
    ]);
    const values = ['5', '200', '2', '100', '3', '100'];
    for (const [index, value] of values.entries())
      await expect(inputs.nth(index)).toHaveValue(value);
    const runUsd = page.getByTestId('review-budget-run.maxBudgetUsd');
    await expect(runUsd).toHaveValue('5');
    await runUsd.fill('');
    await expect(confirmButton(page)).toBeDisabled();
    await runUsd.fill('8');
    await expect(confirmButton(page)).toBeEnabled();
    await confirmButton(page).click();
    await expect(page.getByTestId('review-error')).toHaveText(
      '처리 실패 · 지금 한도보다 낮은 값 · 실행 전체 USD · 구현 턴',
    );
    expect(await callsOf(bive, 'reviewQueue.resumeWithBudget')).toEqual([
      {
        projectId: PROJECT.id,
        seq: 2,
        budget: {
          run: { maxBudgetUsd: 8, maxTurns: 200 },
          roles: {
            'test-writer': { maxBudgetUsd: 2, maxTurns: 100 },
            implementer: { maxBudgetUsd: 3, maxTurns: 100 },
          },
        },
        author: HUMAN,
      },
    ]);
    // 거부되면 입력은 열린 채 남는다
    await expect(page.getByTestId('review-form')).toBeVisible();
    await snapshot(page, '예산 초과 상세');
  });

  test('허용 목록 축소 재개: 제외 경로 안내 · 자리 표시 글, 경로가 없으면 꺼짐, 줄마다 다듬어 보냄, 형식 거부의 줄 번호', async ({
    page,
  }) => {
    const bive = await setup(page, REVIEW_LIST, {
      'reviewQueue.resumeNarrowed': rejected({
        code: -32001,
        message: 'x',
        data: { reason: 'WRITE_SCOPE_EXCLUDE_INVALID', fields: ['exclude.1'] },
      }),
    });
    await selectCard(page, 'EXE-012');
    await action(page, 'narrow_allowlist_resume').click();
    await expect(page.getByTestId('review-budget-run.maxTurns')).toHaveValue('200');
    const exclude = page.getByTestId('review-exclude');
    await expect(exclude).toHaveAttribute('placeholder', 'src/legacy/**');
    await expect(page.getByTestId('review-exclude-hint')).toHaveText(
      '한 줄에 경로 하나 · 폴더 아래 전체는 끝에 /**',
    );
    await expect(confirmButton(page)).toBeDisabled();
    await exclude.fill('  \n');
    await expect(confirmButton(page)).toBeDisabled();
    await exclude.fill(' src/legacy/** \n\nsrc/x y\n');
    await confirmButton(page).click();
    await expect(page.getByTestId('review-error')).toHaveText(
      '처리 실패 · 제외 경로 형식 오류 · 2번째 경로',
    );
    const [call] = (await callsOf(bive, 'reviewQueue.resumeNarrowed')) as {
      exclude: string[];
      seq: number;
    }[];
    expect(call?.exclude).toEqual(['src/legacy/**', 'src/x y']);
    expect(call?.seq).toBe(2);
  });

  test('규칙 분할: 대상 규칙이 여럿이면 하나를 고르기 전까지 꺼짐, 고른 규칙으로 1회, 분할 진행 중 거부', async ({
    page,
  }) => {
    const bive = await setup(page, REVIEW_LIST, {
      'reviewQueue.splitRule': rejected({
        code: -32009,
        message: 'x',
        data: { reason: 'split_in_progress' },
      }),
    });
    await selectCard(page, 'EXE-012');
    await action(page, 'split_rule').click();
    const radios = page.getByTestId('review-split-rule');
    await expect(radios).toHaveCount(2);
    await expect(page.getByTestId('review-split').locator('label > span')).toHaveText([
      `RULE-012 · ${RULE_EXPORT.title}`,
      `RULE-013 · ${RULE_IMPORT.title}`,
    ]);
    await expect(confirmButton(page)).toBeDisabled();
    await radios.nth(1).check();
    await confirmButton(page).click();
    await expect(page.getByTestId('review-error')).toHaveText('처리 실패 · 분할 진행 중');
    expect(await callsOf(bive, 'reviewQueue.splitRule')).toEqual([
      { projectId: PROJECT.id, seq: 2, ruleId: RULE_IMPORT.id, author: HUMAN },
    ]);
  });
});

test.describe('처리된 항목', () => {
  test('액션 버튼 없음, 처리 결과(액션 · 시각 · 만든 실행 표시 ID / 격리 사유)', async ({
    page,
  }) => {
    await setup(page, REVIEW_LIST, {
      'run.get': { result: runGetOf(runOf({ id: ENTRY_RAISED.run.id, displayId: 'EXE-021' })) },
    });
    await selectCard(page, 'EXE-010');
    await expect(detail(page).getByTestId('detail-state')).toHaveText('처리됨');
    await expect(page.getByTestId('review-actions')).toHaveCount(0);
    await expect(detail(page).getByTestId('detail-result-action')).toContainText('한도 상향 재개');
    await expect(detail(page).getByTestId('detail-result-run')).toContainText('EXE-021');

    await selectCard(page, 'EXE-013');
    await expect(detail(page).getByTestId('detail-result-action')).toContainText('판정 격리');
    await expect(detail(page).getByTestId('detail-result-reason')).toContainText(
      ENTRY_QUARANTINED.item.resolution?.reason ?? '',
    );
    await expect(page.getByTestId('review-actions')).toHaveCount(0);
  });
});
