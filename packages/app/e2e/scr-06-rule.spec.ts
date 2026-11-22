// SCR-06 규범 상세 · 규칙 (이슈 #41 수용 기준, screens.md SCR-03 상세 · SCR-06 · 1.4 상세 접힘, ADR-035 · ADR-073).
// 1) checklists/scr-06.ts의 규칙 기본 상태(진술, 테스트 실행 결과, 실행 이력)를 통과하고 변경 이력 영역이 미노출
// 2) 테스트 출력은 기본 접힘이고 최신 판정이 실패면 자동으로 펼쳐짐
// 3) 실패 원인에 실행기 출력(실패 케이스 이름, 메시지, file:line)이 보임
// 4) 실패 원인의 file:line에 코드 열기 링크(CodeLink)가 붙음 (#43 수용 기준 3, 모달 동작은 code-link.spec.ts)
// 5) 규칙 상세의 [편집]이 제목 · 진술 입력을 열고 [저장]하면 rule.update를 1회 부르며 바뀐 제목 · 진술 · 확인됨이 보임
//    (#215 수용 기준 3, ADR-109). 형식 거부 · 오류 응답 표시, 저장 중 중복 호출 방지, 취소, 목록 카드의 제목 갱신,
//    820 · 1280px 창의 머리줄 배치
// 규칙 화면(SCR-03)에서 카드를 눌러 들어온다. 데이터는 가짜 브리지의 rule.list · judgment.list · requirement.get ·
// rule.update 응답뿐이다.
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
import type { ApprovalLogEntry, RuleUpdateResult, RuleWithJudgment } from '@bive/shared';

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
  sameRow,
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

test.describe('규칙 직접 편집 (#215 수용 기준 3, ADR-100 B② · ADR-109)', () => {
  const NEW_TITLE = '결제 24시간 뒤 주문 취소 거절 (409)';
  const NEW_STATEMENT =
    'WHEN 결제 후 24시간이 지난 주문의 취소를 요청하면 THE SYSTEM SHALL 409 상태 코드로 요청을 거절한다';
  const EDITED_AT = '2026-10-16T09:30:00.000Z';
  const HUMAN = { kind: 'human' } as const;

  /** rule.update 가짜 응답 (테스트 전용 데이터): 바뀐 제목 · 진술, 확인됨(근거 = 승인 기록 7번). */
  const updated = (
    change: { title?: string; statement?: string },
    autoStart: RuleUpdateResult['autoStart'],
  ): RuleUpdateResult => {
    const failing = RULES.find((item) => item.rule.id === FAILING_RULE.id);
    if (failing === undefined) throw new Error('실패 규칙 없음');
    const after = {
      title: change.title ?? FAILING_RULE.title,
      statement: change.statement ?? FAILING_RULE.statement,
    };
    const approvalLog: ApprovalLogEntry = {
      seq: 7,
      at: EDITED_AT,
      action: 'rule_edit',
      actor: HUMAN,
      targetRef: { entity: 'Rule', id: FAILING_RULE.id },
      clientId: 'pipe-1',
      detail: {
        diff: { before: { title: FAILING_RULE.title, statement: FAILING_RULE.statement }, after },
      },
      prevHash: '0'.repeat(64),
      hash: 'a'.repeat(64),
    };
    return {
      rule: {
        ...FAILING_RULE,
        ...after,
        updatedAt: EDITED_AT,
        confirmation: {
          state: 'confirmed',
          at: EDITED_AT,
          by: HUMAN,
          basis: { kind: 'approval_log', seq: 7 },
        },
      },
      judgment: failing.judgment,
      approvalLog,
      autoStart,
    };
  };
  const STARTED = {
    state: 'started',
    runId: '01JE0000000000000000000003',
    runDisplayId: 'EXE-003',
  } as const;

  const openFailing = async (page: Page, responses: MockResponses = {}): Promise<BiveMock> => {
    const bive = await openRules(page, responses);
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    return bive;
  };
  const detail = (page: Page) => page.getByTestId('rule-detail');
  const titleInput = (page: Page) => page.getByTestId('rule-edit-title');
  const statementInput = (page: Page) => page.getByTestId('rule-edit-statement');
  const saveButton = (page: Page) => page.getByTestId('rule-edit-save');

  test('[편집]은 지금 제목 · 진술이 든 입력을 열고, [저장]은 rule.update를 1회(바뀐 칸 · 본 수정 시각 · 사람 주체) 부른다. 상세 · 목록 카드에 새 제목 · 진술 · 확인됨이 보인다', async ({
    page,
  }) => {
    const bive = await openFailing(page, {
      'rule.update': {
        result: updated({ title: NEW_TITLE, statement: NEW_STATEMENT }, STARTED),
      },
    });
    await expect(page.getByTestId('rule-field-confirmation')).toHaveText('확인미확인');
    await page.getByTestId('rule-edit').click();
    // 입력이 열리고 [편집]은 사라진다. 제목 입력에 초점, 값은 지금 값
    await expect(page.getByTestId('rule-editor')).toBeVisible();
    await expect(page.getByTestId('rule-edit')).toHaveCount(0);
    await expect(titleInput(page)).toBeFocused();
    await expect(titleInput(page)).toHaveValue(FAILING_RULE.title);
    await expect(statementInput(page)).toHaveValue(FAILING_RULE.statement);
    await expect(page.getByTestId('rule-field-title')).toContainText('제목');
    // 바뀐 것이 없으면 저장할 수 없다
    await expect(saveButton(page)).toBeDisabled();
    await titleInput(page).fill(NEW_TITLE);
    await statementInput(page).fill(NEW_STATEMENT);
    await expect(saveButton(page)).toBeEnabled();
    const listCalls = (await callsOf(bive, 'rule.list')).length;
    await saveButton(page).click();

    await expect(page.getByTestId('rule-editor')).toHaveCount(0);
    expect(await callsOf(bive, 'rule.update')).toEqual([
      {
        method: 'rule.update',
        params: {
          projectId: PROJECT.id,
          id: FAILING_RULE.id,
          author: HUMAN,
          title: NEW_TITLE,
          statement: NEW_STATEMENT,
          expectedUpdatedAt: FAILING_RULE.updatedAt,
        },
      },
    ]);
    // 상세: 머리 제목 · 진술 · 확인됨, 자동 시작 결과 한 줄. [편집]이 다시 보인다
    await expect(page.getByTestId('rule-detail-title')).toHaveText(NEW_TITLE);
    await expect(page.getByTestId('rule-field-statement')).toHaveText(`진술${NEW_STATEMENT}`);
    await expect(page.getByTestId('rule-field-confirmation')).toHaveText('확인확인됨');
    await expect(page.getByTestId('rule-edit-result')).toHaveText('실행 자동 시작 · EXE-003');
    await expect(page.getByTestId('rule-edit')).toBeVisible();
    await expect(detail(page)).toHaveAttribute('data-selected-id', FAILING_RULE.id);
    // 목록 카드도 새 제목이다 (옛 제목이 남지 않는다). 다른 카드는 그대로
    const card = page.getByTestId('card').filter({ hasText: 'RULE-002' });
    await expect(card).toContainText(NEW_TITLE);
    await expect(page.getByTestId('card')).toHaveCount(RULES.length);
    await expect(page.getByTestId('card').filter({ hasText: PASSING_RULE.title })).toHaveCount(1);
    // 목록을 다시 읽지 않았다 (응답의 규칙으로 바꿈)
    expect(await callsOf(bive, 'rule.list')).toHaveLength(listCalls);
    await page.screenshot({ path: `${SCREENSHOT_DIR}SCR-06/규칙-편집-저장.png`, fullPage: true });
  });

  test('제목만 바꾸면 rule.update에 진술이 없고 자동 시작 결과 줄이 없다. 생략이면 사유가 보인다', async ({
    page,
  }) => {
    const bive = await openFailing(page, {
      'rule.update': { result: updated({ title: NEW_TITLE }, null) },
    });
    await page.getByTestId('rule-edit').click();
    await titleInput(page).fill(NEW_TITLE);
    await titleInput(page).press('Control+Enter');
    await expect(page.getByTestId('rule-detail-title')).toHaveText(NEW_TITLE);
    const [call] = await callsOf(bive, 'rule.update');
    expect(call?.params).toEqual({
      projectId: PROJECT.id,
      id: FAILING_RULE.id,
      author: HUMAN,
      title: NEW_TITLE,
      expectedUpdatedAt: FAILING_RULE.updatedAt,
    });
    await expect(page.getByTestId('rule-edit-result')).toHaveCount(0);

    await bive.setResponse('rule.update', {
      result: updated(
        { title: NEW_TITLE, statement: NEW_STATEMENT },
        { state: 'skipped', reason: 'project_daily_budget_unset', missing: [] },
      ),
    });
    await page.getByTestId('rule-edit').click();
    await statementInput(page).fill(NEW_STATEMENT);
    await saveButton(page).click();
    await expect(page.getByTestId('rule-edit-result')).toHaveText(
      '실행 자동 시작 생략 · 프로젝트 하루 한도 없음',
    );
  });

  test('저장 중에는 입력이 읽기 전용이고 [저장] · [취소]가 꺼져 두 번 눌러도 1회만 부른다', async ({
    page,
  }) => {
    const bive = await openFailing(page, { 'rule.update': { pending: true } });
    await page.getByTestId('rule-edit').click();
    await statementInput(page).fill(NEW_STATEMENT);
    await saveButton(page).click();
    await expect(saveButton(page)).toBeDisabled();
    await expect(saveButton(page)).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('rule-edit-cancel')).toBeDisabled();
    await expect(statementInput(page)).toHaveAttribute('readonly', '');
    await statementInput(page).press('Control+Enter');
    await saveButton(page).click({ force: true });
    expect(await callsOf(bive, 'rule.update')).toHaveLength(1);
    // 아직 응답 전: 상세는 옛 값 그대로
    await expect(page.getByTestId('rule-detail-title')).toHaveText(FAILING_RULE.title);
  });

  test('EARS 형식 거부(-32001)는 "진술 형식 오류"와 서버 사유를 보이고 입력을 남긴다. 고치면 오류 줄이 사라진다', async ({
    page,
  }) => {
    const problem =
      '진술은 대문자 WHEN와 공백 한 칸으로 시작해야 함 (WHEN <조건> THE SYSTEM SHALL <응답>)';
    const bive = await openFailing(page, {
      'rule.update': {
        error: {
          code: -32001,
          message: '규칙 편집 형식 오류',
          data: { reason: 'RULE_EDIT_INVALID', issues: [{ path: 'statement', message: problem }] },
        },
      },
    });
    await page.getByTestId('rule-edit').click();
    await statementInput(page).fill('주문 취소를 거절한다');
    await saveButton(page).click();
    const error = page.getByTestId('rule-edit-error');
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('rule-edit-error-label')).toHaveText('진술 형식 오류');
    await expect(page.getByTestId('rule-edit-error-detail')).toHaveText(problem);
    // 입력은 그대로 남고 상세 머리 · 확인 상태는 바뀌지 않는다
    await expect(statementInput(page)).toHaveValue('주문 취소를 거절한다');
    await expect(page.getByTestId('rule-detail-title')).toHaveText(FAILING_RULE.title);
    await expect(page.getByTestId('rule-field-confirmation')).toHaveText('확인미확인');
    expect(await callsOf(bive, 'rule.update')).toHaveLength(1);
    await statementInput(page).fill(NEW_STATEMENT);
    await expect(error).toHaveCount(0);
  });

  test('오류 응답의 사유별 문구: 제목 형식 · 다른 변경 먼저 저장됨 · 삭제된 규칙 · 권한 · 알 수 없는 오류', async ({
    page,
  }) => {
    const bive = await openFailing(page);
    const titleProblem = '제목은 한 줄이어야 함 (줄바꿈 · 제어 문자 불가)';
    const cases = [
      {
        error: {
          code: -32001,
          message: 'x',
          data: { reason: 'RULE_EDIT_INVALID', issues: [{ path: 'title', message: titleProblem }] },
        },
        label: '제목 형식 오류',
        detail: titleProblem,
      },
      {
        error: { code: -32009, message: 'x', data: { reason: 'rule_changed' } },
        label: '규칙 저장 실패 · 다른 변경 먼저 저장됨',
        detail: null,
      },
      {
        error: { code: -32009, message: 'x', data: { reason: 'rule_deleted' } },
        label: '규칙 저장 실패 · 삭제된 규칙',
        detail: null,
      },
      {
        error: { code: -32020, message: 'x' },
        label: '규칙 저장 실패 · 편집 권한 없음',
        detail: null,
      },
      { error: { code: -32603, message: '내부 오류' }, label: '규칙 저장 실패', detail: null },
    ];
    await page.getByTestId('rule-edit').click();
    await titleInput(page).fill(NEW_TITLE);
    for (const item of cases) {
      await bive.setResponse('rule.update', { error: item.error });
      await saveButton(page).click();
      await expect(page.getByTestId('rule-edit-error-label')).toHaveText(item.label);
      await expect(page.getByTestId('rule-edit-error-detail')).toHaveCount(
        item.detail === null ? 0 : 1,
      );
      if (item.detail !== null) {
        await expect(page.getByTestId('rule-edit-error-detail')).toHaveText(item.detail);
      }
    }
    expect(await callsOf(bive, 'rule.update')).toHaveLength(cases.length);
    await expect(titleInput(page)).toHaveValue(NEW_TITLE);
  });

  test('[취소] · Esc는 부르지 않고 입력을 닫으며 지금 값을 그대로 보인다. 다시 열면 지금 값부터다. 공백만이면 저장할 수 없다', async ({
    page,
  }) => {
    const bive = await openFailing(page);
    await page.getByTestId('rule-edit').click();
    await titleInput(page).fill('   ');
    await expect(saveButton(page)).toBeDisabled();
    await page.getByTestId('rule-edit-cancel').click();
    await expect(page.getByTestId('rule-editor')).toHaveCount(0);
    await expect(page.getByTestId('rule-detail-title')).toHaveText(FAILING_RULE.title);
    await page.getByTestId('rule-edit').click();
    await expect(titleInput(page)).toHaveValue(FAILING_RULE.title);
    await statementInput(page).fill(NEW_STATEMENT);
    await statementInput(page).press('Escape');
    await expect(page.getByTestId('rule-editor')).toHaveCount(0);
    await expect(page.getByTestId('rule-field-statement')).toHaveText(
      `진술${FAILING_RULE.statement}`,
    );
    // 진술 입력의 Enter는 줄바꿈을 넣지 않는다 (한 줄)
    await page.getByTestId('rule-edit').click();
    await statementInput(page).press('End');
    await statementInput(page).press('Enter');
    await expect(statementInput(page)).toHaveValue(FAILING_RULE.statement);
    expect(await callsOf(bive, 'rule.update')).toEqual([]);
  });

  for (const width of [820, 1280] as const) {
    test(`${width}×800: 머리줄의 [편집] · [실행]이 한 줄로 상세 안에 있고 눌리며 제목이 눌려 좁아지지 않는다. 편집 입력 · [취소] · [저장]도 상세 안에 들어온다`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      const bive = await openFailing(page);
      const pane = detail(page);
      expect(await sameRow(pane, ['rule-edit', 'run-start'])).toEqual([]);
      expect(await textClipping(pane, ['rule-edit', 'run-start', 'rule-detail-id'])).toEqual([]);
      expect(await hitProblems(pane, ['rule-edit', 'run-start'])).toEqual([]);
      // 제목은 글자 몇 개 폭의 기둥으로 눌리지 않는다 (줄을 바꾸더라도 상세 폭의 절반 이상을 쓴다)
      const paneBox = await pane.boundingBox();
      const titleBox = await page.getByTestId('rule-detail-title').boundingBox();
      const actionsBox = await page.getByTestId('rule-detail-actions').boundingBox();
      if (paneBox === null || titleBox === null || actionsBox === null)
        throw new Error('상자 없음');
      expect(titleBox.width).toBeGreaterThan(paneBox.width / 2);
      // 동작 묶음은 상세 안 오른쪽에 붙는다
      expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width);
      expect(actionsBox.x + actionsBox.width).toBeGreaterThan(paneBox.x + paneBox.width - 48);
      await page.screenshot({
        path: `${SCREENSHOT_DIR}SCR-06/규칙-편집-머리-${width}.png`,
        fullPage: true,
      });
      await page.getByTestId('rule-edit').click();
      // 편집 입력은 이름 아래 상세 전체 폭을 쓴다 (값 칸 폭으로 눌리지 않는다)
      for (const id of ['rule-edit-title', 'rule-edit-statement']) {
        const box = await page.getByTestId(id).boundingBox();
        if (box === null) throw new Error('상자 없음');
        expect(box.width, id).toBeGreaterThan(paneBox.width * 0.8);
      }
      expect(await textClipping(pane, ['rule-edit-cancel', 'rule-edit-save'])).toEqual([]);
      expect(await sameRow(pane, ['rule-edit-cancel', 'rule-edit-save'])).toEqual([]);
      expect(
        await hitProblems(pane, ['rule-edit-title', 'rule-edit-statement', 'rule-edit-save']),
      ).toEqual([]);
      expect(await callsOf(bive, 'rule.update')).toEqual([]);
      await page.screenshot({
        path: `${SCREENSHOT_DIR}SCR-06/규칙-편집-입력-${width}.png`,
        fullPage: true,
      });
    });
  }

  test('편집 입력 · 오류 · 결과 줄에 금지 문구(코드 표기 · 이모지)가 없다', async ({ page }) => {
    const bive = await openFailing(page, {
      'rule.update': {
        error: {
          code: -32001,
          message: 'x',
          data: {
            reason: 'RULE_EDIT_INVALID',
            issues: [{ path: 'statement', message: '진술 앞뒤에 공백을 둘 수 없음' }],
          },
        },
      },
    });
    await page.getByTestId('rule-edit').click();
    await statementInput(page).fill(` ${FAILING_RULE.statement}`);
    await saveButton(page).click();
    await expect(page.getByTestId('rule-edit-error')).toBeVisible();
    expect(findForbiddenText(await collectVisibleText(page))).toEqual([]);
    await bive.setResponse('rule.update', {
      result: updated({ statement: NEW_STATEMENT }, STARTED),
    });
    await statementInput(page).fill(NEW_STATEMENT);
    await saveButton(page).click();
    await expect(page.getByTestId('rule-edit-result')).toBeVisible();
    expect(findForbiddenText(await collectVisibleText(page))).toEqual([]);
  });
});
