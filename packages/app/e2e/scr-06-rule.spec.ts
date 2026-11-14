// SCR-06 규범 상세 · 규칙 (이슈 #41 수용 기준, screens.md SCR-03 상세 · SCR-06 · 1.4 상세 접힘, ADR-035 · ADR-073).
// 1) checklists/scr-06.ts의 규칙 기본 상태(진술, 테스트 실행 결과, 실행 이력)를 통과하고 변경 이력 영역이 미노출
// 2) 테스트 출력은 기본 접힘이고 최신 판정이 실패면 자동으로 펼쳐짐
// 3) 실패 원인에 실행기 출력(실패 케이스 이름, 메시지, file:line)이 보임
// 규칙 화면(SCR-03)에서 카드를 눌러 들어온다. 데이터는 가짜 브리지의 rule.list · judgment.list · requirement.get 응답뿐이다.
import { expect, type Page, test } from '@playwright/test';

import {
  FAILED_CASE,
  FAILING_HISTORY,
  FAILING_RULE,
  HISTORY,
  PARENT,
  PASSING_HISTORY,
  PASSING_RULE,
  PROJECT,
  RULES,
  UNJUDGED_RULE,
} from './checklists/scr-06.js';
import { type BiveMock, type MockCall, mockBive, type MockResponses } from './support/bive-mock.js';
import { collectVisibleText, expectScreen, findForbiddenText } from './support/expectScreen.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;

const openRules = async (page: Page, responses: MockResponses = {}): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'rule.list': { result: { rules: RULES } },
      'judgment.list': { result: { judgments: FAILING_HISTORY } },
      'requirement.get': { result: { requirement: PARENT } },
      ...responses,
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '규칙', exact: true }).click();
  await expect(page.getByTestId('card')).toHaveCount(RULES.length);
  return bive;
};

/** 규칙 카드를 고른다. 이력 응답은 그 규칙의 것으로 먼저 바꾼다. */
const selectRule = async (
  page: Page,
  bive: BiveMock,
  displayId: string,
  ruleId: string,
): Promise<void> => {
  await bive.setResponse('judgment.list', { result: { judgments: HISTORY[ruleId] ?? [] } });
  await page.getByTestId('card').filter({ hasText: displayId }).click();
  await expect(page.getByTestId('rule-detail')).toHaveAttribute('data-selected-id', ruleId);
};

const callsOf = async (bive: BiveMock, method: string): Promise<MockCall[]> =>
  (await bive.calls()).filter((call) => call.method === method);

const outputToggle = (page: Page) => page.getByRole('button', { name: '테스트 출력' });

test.describe('체크리스트 (수용 기준 1)', () => {
  test('기본: 진술 · 테스트 실행 결과 · 실행 이력, 변경 이력 · 변이 · [실행] 미노출', async ({
    page,
  }) => {
    const bive = await openRules(page);
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    await expectScreen(page, 'SCR-06', '기본');
    // 규칙 상세 안에도 변경 이력 영역 · 접힘이 없다 (ADR-035)
    const detail = page.getByTestId('rule-detail');
    await expect(detail.getByTestId('collapsible')).toHaveCount(1);
    await expect(detail.getByText('변경 이력')).toHaveCount(0);
  });

  test('로딩: 실행 이력 자리만 비우고 나머지 상세는 보인다', async ({ page }) => {
    const bive = await openRules(page);
    await bive.setResponse('judgment.list', { pending: true });
    await page.getByTestId('card').filter({ hasText: 'RULE-002' }).click();
    await expectScreen(page, 'SCR-06', '로딩');
    await expect(page.getByTestId('rule-history-loading')).toHaveText('');
  });

  test('에러: 실행 이력 자리에 "실행 이력 불러오기 실패", 나머지 상세는 보인다', async ({
    page,
  }) => {
    const bive = await openRules(page);
    await bive.setResponse('judgment.list', {
      error: { code: -32603, message: '내부 오류' },
    });
    await page.getByTestId('card').filter({ hasText: 'RULE-002' }).click();
    await expectScreen(page, 'SCR-06', '에러');
  });

  test('SCR-03에서 카드를 누르면 그 규칙으로 judgment.list · requirement.get을 부른다', async ({
    page,
  }) => {
    const bive = await openRules(page);
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    await expect(page.getByTestId('history-row')).toHaveCount(FAILING_HISTORY.length);
    const history = await callsOf(bive, 'judgment.list');
    expect(history.length).toBeGreaterThan(0);
    for (const call of history) {
      expect(call.params).toEqual({ projectId: PROJECT.id, ruleId: FAILING_RULE.id });
    }
    const parent = await callsOf(bive, 'requirement.get');
    expect(parent.length).toBeGreaterThan(0);
    for (const call of parent)
      expect(call.params).toEqual({ projectId: PROJECT.id, id: PARENT.id });
  });

  test('실행 이력은 최신부터 판정 · 실행 ID · 커밋을 보인다', async ({ page }) => {
    const bive = await openRules(page);
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    const rows = page.getByTestId('history-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-status', 'fail');
    await expect(rows.nth(0).getByTestId('history-run')).toHaveText('EXE-002');
    await expect(rows.nth(0)).toContainText('b2c3d4e');
    await expect(rows.nth(0).locator('time')).toHaveAttribute(
      'datetime',
      FAILING_HISTORY[0]?.judgment.judgedAt ?? '',
    );
    await expect(rows.nth(1)).toHaveAttribute('data-status', 'pass');
    await expect(rows.nth(1).getByTestId('history-run')).toHaveText('EXE-001');
    await expect(rows.nth(1)).toContainText('a1f26b1');
  });
});

test.describe('테스트 출력 접힘 (수용 기준 2)', () => {
  test('최신 판정이 통과면 테스트 출력은 기본 접힘이고 눌러야 펼쳐진다', async ({ page }) => {
    const bive = await openRules(page);
    await selectRule(page, bive, 'RULE-001', PASSING_RULE.id);
    await expect(
      page.getByTestId('rule-field-result-status').getByTestId('status-badge'),
    ).toHaveAttribute('data-status', 'pass');
    const toggle = outputToggle(page);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('test-case')).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('test-case')).toHaveCount(1);
    await expect(page.getByTestId('test-case')).toBeVisible();
    // 통과만 있으면 실패 원인이 없다
    await expect(page.getByTestId('rule-failures')).toHaveCount(0);
    await expect(page.getByTestId('history-row')).toHaveCount(PASSING_HISTORY.length);
  });

  test('최신 판정이 실패면 자동으로 펼쳐지고, 사람이 다시 접을 수 있다', async ({ page }) => {
    const bive = await openRules(page);
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    const toggle = outputToggle(page);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('failure-case')).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('failure-case')).toBeHidden();
  });

  test('통과 규칙 → 실패 규칙으로 바꾸면 펼쳐지고, 다시 통과 규칙으로 오면 접혀 있다', async ({
    page,
  }) => {
    const bive = await openRules(page);
    await selectRule(page, bive, 'RULE-001', PASSING_RULE.id);
    await expect(outputToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    await expect(outputToggle(page)).toHaveAttribute('aria-expanded', 'true');
    await selectRule(page, bive, 'RULE-001', PASSING_RULE.id);
    await expect(outputToggle(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('판정 기록이 없는 규칙은 "판정 기록 없음"이고 테스트 출력 · 실행 이력 행이 없다', async ({
    page,
  }) => {
    const bive = await openRules(page);
    await selectRule(page, bive, 'RULE-003', UNJUDGED_RULE.id);
    await expect(page.getByTestId('rule-no-judgment')).toHaveText('판정 기록 없음');
    await expect(outputToggle(page)).toHaveCount(0);
    await expect(page.getByTestId('rule-history-empty')).toHaveText('실행 이력 없음');
    await expect(page.getByTestId('history-row')).toHaveCount(0);
    // 사람이 쓴 규칙은 생성 주체 이름이 사람
    await expect(page.getByTestId('rule-field-author')).toHaveText('생성 주체사람');
  });
});

test.describe('실패 원인 (수용 기준 3)', () => {
  test('실패 원인에 실행기 출력(케이스 이름 · 메시지 · file:line)이 그대로 보인다', async ({
    page,
  }) => {
    const bive = await openRules(page);
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    const failures = page.getByTestId('rule-failures');
    await expect(failures).toBeVisible();
    await expect(failures.getByRole('heading', { name: '실패 원인' })).toBeVisible();
    const failure = failures.getByTestId('failure-case');
    await expect(failure).toHaveCount(1);
    await expect(failure).toHaveAttribute('data-status', 'failed');
    await expect(failure.getByTestId('failure-case-name')).toHaveText(FAILED_CASE.name);
    await expect(failure.getByTestId('failure-case-message')).toHaveText(FAILED_CASE.message ?? '');
    await expect(failure.getByTestId('failure-case-location')).toHaveText(
      `${FAILED_CASE.file}:${FAILED_CASE.line}`,
    );
    // 통과 케이스는 실패 원인에 들지 않고 전체 케이스에만 있다
    await expect(failures).not.toContainText('200을 돌려준다');
    await expect(page.getByTestId('rule-cases').getByTestId('test-case')).toHaveCount(2);
  });
});

test.describe('화면 문구', () => {
  test('상세(펼친 테스트 출력 · 실행 이력)에 금지 문구가 없다', async ({ page }) => {
    const bive = await openRules(page);
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    await expect(page.getByTestId('history-row')).toHaveCount(2);
    const texts = await collectVisibleText(page);
    expect(findForbiddenText(texts)).toEqual([]);
    const stage = texts.filter(({ text }) => /\bM\d\b|준비 중|로딩|Loading/i.test(text));
    expect(stage).toEqual([]);
  });
});
