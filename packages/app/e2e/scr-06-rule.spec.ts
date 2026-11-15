// SCR-06 규범 상세 · 규칙 (이슈 #41 수용 기준, screens.md SCR-03 상세 · SCR-06 · 1.4 상세 접힘, ADR-035 · ADR-073).
// 1) checklists/scr-06.ts의 규칙 기본 상태(진술, 테스트 실행 결과, 실행 이력)를 통과하고 변경 이력 영역이 미노출
// 2) 테스트 출력은 기본 접힘이고 최신 판정이 실패면 자동으로 펼쳐짐
// 3) 실패 원인에 실행기 출력(실패 케이스 이름, 메시지, file:line)이 보임
// 4) 실패 원인의 file:line에 코드 열기 링크(CodeLink)가 붙음 (#43 수용 기준 3, 모달 동작은 code-link.spec.ts)
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
import type { RuleWithJudgment } from '@bive/shared';

import { type BiveMock, type MockCall, mockBive, type MockResponses } from './support/bive-mock.js';
import {
  collectVisibleText,
  expectScreen,
  findForbiddenText,
  SCREENSHOT_DIR,
} from './support/expectScreen.js';
import {
  DETAIL_PANE_MIN,
  hitProblems,
  horizontalOverflow,
  LIST_PANE_MAX,
  LIST_PANE_MIN,
  listPaneOverflow,
  NARROW_WIDTHS,
  paneWidths,
  textClipping,
  WIDE_WIDTH,
} from './support/overflow.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;

const openRules = async (
  page: Page,
  responses: MockResponses = {},
  cardCount = RULES.length,
): Promise<BiveMock> => {
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
  await expect(page.getByTestId('card')).toHaveCount(cardCount);
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
  test('기본: 진술 · 테스트 실행 결과 · 실행 이력 · [실행], 변경 이력 · 변이 미노출', async ({
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

test.describe('실패 케이스의 코드 열기 링크 (#43 수용 기준 3, MET-01)', () => {
  test('실패 원인의 file:line(판정 기록의 케이스 위치)에 CodeLink가 붙고, 누르면 사유 모달이 열린다', async ({
    page,
  }) => {
    const bive = await openRules(page);
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    const failure = page.getByTestId('rule-failures').getByTestId('failure-case');
    const link = failure.getByTestId('failure-case-location').getByTestId('code-link');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText(`${FAILED_CASE.file}:${FAILED_CASE.line}`);
    await expect(link).toHaveAttribute('type', 'button');
    // 링크는 실패 원인에만: 전체 케이스 목록에는 없다
    await expect(page.getByTestId('rule-cases').getByTestId('code-link')).toHaveCount(0);
    await link.click();
    await expect(page.getByTestId('code-open-dialog')).toBeVisible();
    // 사유를 고르지 않았으므로 IDE 호출은 없다
    expect(await callsOf(bive, 'app.openInIde')).toEqual([]);
  });

  test('줄이 없는 실패 케이스는 링크 없이 파일만 글자로 보인다', async ({ page }) => {
    // 실패 규칙의 최신 판정에서 실패 케이스의 줄만 지운다 (테스트 전용 데이터)
    const rules = RULES.map((item) =>
      item.rule.id !== FAILING_RULE.id || item.judgment.latest === null
        ? item
        : {
            ...item,
            judgment: {
              ...item.judgment,
              latest: {
                ...item.judgment.latest,
                cases: item.judgment.latest.cases.map((c) =>
                  c.status === 'failed' ? { ...c, line: null } : c,
                ),
              },
            },
          },
    );
    const bive = await openRules(page, { 'rule.list': { result: { rules } } });
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    const location = page.getByTestId('failure-case').getByTestId('failure-case-location');
    await expect(location).toHaveText(FAILED_CASE.file);
    await expect(location.getByTestId('code-link')).toHaveCount(0);
  });
});

test.describe('1280px 창의 상세 폭 (#165)', () => {
  test('규칙 상세 패널에 가로 스크롤이 없고 실행 이력 줄 · 실패 원인 줄이 패널 안에 들어온다', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const bive = await openRules(page);
    // 실패 규칙: 테스트 출력이 펼쳐져 실패 원인 · 전체 케이스 줄까지 보인다
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    await expect(page.getByTestId('history-row')).toHaveCount(FAILING_HISTORY.length);
    await expect(page.getByTestId('failure-case')).toBeVisible();
    const pane = page.getByTestId('rule-detail');
    expect(await horizontalOverflow(pane, '[data-testid="history-row"]')).toEqual([]);
    expect(
      await horizontalOverflow(
        pane,
        '[data-testid="test-case"], [data-testid="failure-case"] > :not(pre)',
      ),
    ).toEqual([]);
    // 실패 원인의 코드 열기 링크도 패널 안에 들어온다 (#43)
    expect(await horizontalOverflow(pane, '[data-testid="code-link"]')).toEqual([]);
    // 실행 이력 줄의 값(시각 · 실행 ID · 커밋)은 줄임 없이 그대로 보인다
    const row = page.getByTestId('history-row').first();
    await expect(row.getByTestId('history-run')).toHaveText('EXE-002');
    await expect(row).toContainText('b2c3d4e');
  });
});

test.describe('좁은 창의 목록 · 상세 배치 (#179, ADR-090)', () => {
  const listPane = (page: Page) => page.getByTestId('rules-list-pane');
  const detailPane = (page: Page) => page.getByTestId('rule-detail');
  // 2줄째가 가장 긴 규칙 카드 (테스트 전용 데이터): 4자리 ID · WHEN 조건 · 판정 예외(재검증 필요) · 규범 예외(잠정)
  const MANY_RULE: RuleWithJudgment = {
    rule: {
      ...FAILING_RULE,
      id: '01JC0000000000000000001234',
      displayId: 'RULE-1234',
      normState: 'provisional',
    },
    judgment: { status: 'needs_recheck', latest: null },
  };

  for (const width of NARROW_WIDTHS) {
    test(`${width}×800: 상세 칸은 최소 폭 이상이고 목록 칸은 넘치지 않는다, 규칙 상세에 가로 스크롤이 없고 [실행] · 코드 열기 링크는 상세 안에서 눌린다`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      const bive = await openRules(
        page,
        { 'rule.list': { result: { rules: [...RULES, MANY_RULE] } } },
        RULES.length + 1,
      );
      await expect(
        page.locator('[data-testid="card"][data-id="RULE-1234"] [data-testid="card-exception"]'),
      ).toHaveText(['재검증 필요', '잠정']);
      await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
      await expect(page.getByTestId('history-row')).toHaveCount(FAILING_HISTORY.length);
      await expect(page.getByTestId('failure-case')).toBeVisible();

      const widths = await paneWidths(listPane(page), detailPane(page));
      expect(widths.list).toBeGreaterThanOrEqual(LIST_PANE_MIN);
      expect(widths.list).toBeLessThanOrEqual(LIST_PANE_MAX);
      expect(widths.detail).toBeGreaterThanOrEqual(DETAIL_PANE_MIN);
      expect(await listPaneOverflow(listPane(page))).toEqual([]);

      const pane = detailPane(page);
      expect(await horizontalOverflow(pane, '[data-testid="history-row"]')).toEqual([]);
      expect(
        await horizontalOverflow(
          pane,
          '[data-testid="test-case"], [data-testid="failure-case"] > :not(pre)',
        ),
      ).toEqual([]);
      expect(await horizontalOverflow(pane, '[data-testid="code-link"]')).toEqual([]);
      expect(await textClipping(pane, ['run-start'])).toEqual([]);
      expect(await hitProblems(pane, ['run-start', 'code-link'])).toEqual([]);
      await pane.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.screenshot({
        path: `${SCREENSHOT_DIR}SCR-06/규칙-좁은-${width}.png`,
        fullPage: true,
      });
    });
  }

  test(`${WIDE_WIDTH}px 창: 목록 칸은 ${LIST_PANE_MAX}px 그대로다`, async ({ page }) => {
    await page.setViewportSize({ width: WIDE_WIDTH, height: 900 });
    const bive = await openRules(page);
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    const widths = await paneWidths(listPane(page), detailPane(page));
    expect(widths.list).toBe(LIST_PANE_MAX);
    expect(widths.detail).toBe(WIDE_WIDTH - 232 - 360 - LIST_PANE_MAX);
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
