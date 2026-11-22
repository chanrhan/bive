// SCR-06 규범 상세 · 규칙 (이슈 #41 수용 기준, screens.md SCR-03 상세 · SCR-06 · 1.4 상세 접힘, ADR-035 · ADR-073).
// 1) checklists/scr-06.ts의 규칙 기본 상태(진술, 테스트 실행 결과, 실행 이력)를 통과하고 변경 이력은 접혀 있음
// 2) 테스트 출력은 기본 접힘이고 최신 판정이 실패면 자동으로 펼쳐짐
// 3) 실패 원인에 실행기 출력(실패 케이스 이름, 메시지, file:line)이 보임
// 4) 실패 원인의 file:line에 코드 열기 링크(CodeLink)가 붙음 (#43 수용 기준 3, 모달 동작은 code-link.spec.ts)
// 5) 규칙 상세의 [편집]이 제목 · 진술 입력을 열고 [저장]하면 rule.update를 1회 부르며 바뀐 제목 · 진술 · 확인됨이 보임
//    (#215 수용 기준 3, ADR-109). 형식 거부 · 오류 응답 표시, 저장 중 중복 호출 방지, 취소, 목록 카드의 제목 갱신,
//    820 · 1280px 창의 머리줄 배치
// 6) 이슈 #227(M7-15) 수용 기준 3: 확인 상태와 [확인](confirmation.set 1회 · 사람 주체, 성공하면 상세 · 목록 카드가 확인됨),
//    폐기된 규칙의 "폐기"와 대체 규칙 링크(옛 규칙 → 새 규칙, 새 규칙의 판단 기록 → 옛 규칙), 규범 변경 기록의 사유와 근거.
//    제목 · 진술의 숨은 글자(U+202E 등)는 보이는 표기로, 편집 입력에는 원문. 820 · 1280px 창의 머리줄 · 속성 줄 배치
// 규칙 화면(SCR-03)에서 카드를 눌러 들어온다. 데이터는 가짜 브리지의 rule.list · judgment.list · requirement.get ·
// rule.update · normChange.list · confirmation.set 응답뿐이다.
import { expect, type Page, test } from '@playwright/test';

import {
  CREATE_REASON,
  FAILED_CASE,
  FAILING_CHANGES,
  FAILING_HISTORY,
  FAILING_RULE,
  HISTORY,
  NO_CHANGES,
  PARENT,
  PASSING_HISTORY,
  PASSING_RULE,
  PROJECT,
  RETIRED_CHANGES,
  RETIRED_ITEM,
  RETIRED_RULE,
  RULES,
  SUPERSEDE_GROUNDS,
  UNJUDGED_RULE,
} from './checklists/scr-06.js';
import type {
  NormChangeView,
  ApprovalLogEntry,
  ConfirmationSetResult,
  RuleUpdateResult,
  RuleWithJudgment,
} from '@bive/shared';

import { type BiveMock, type MockCall, mockBive, type MockResponses } from './support/bive-mock.js';
import {
  collectVisibleText,
  expectScreen,
  findForbiddenText,
  SCREENSHOT_DIR,
} from './support/expectScreen.js';
import {
  brokenWords,
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
      'normChange.list': { result: NO_CHANGES },
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
  test('기본: 진술 · 테스트 실행 결과 · 실행 이력 · [실행], 변경 이력은 접힘 · 변이 미노출', async ({
    page,
  }) => {
    const bive = await openRules(page);
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    await expectScreen(page, 'SCR-06', '기본');
    // 접힘은 테스트 출력(실패라 펼침)과 변경 이력(기본 접힘, 1.4) 둘이고 변경 이력이 맨 아래다
    const detail = page.getByTestId('rule-detail');
    const collapsibles = detail.getByTestId('collapsible');
    await expect(collapsibles).toHaveCount(2);
    await expect(collapsibles.nth(1)).toHaveAttribute('data-open', 'false');
    await expect(collapsibles.nth(1).getByRole('button')).toHaveText('변경 이력');
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
  // 2줄째가 가장 긴 규칙 카드 (테스트 전용 데이터): 4자리 ID · WHEN 조건 · 판정 예외(재검증 필요) · 규범 예외(미확인)
  const MANY_RULE: RuleWithJudgment = {
    rule: {
      ...FAILING_RULE,
      id: '01JC0000000000000000001234',
      displayId: 'RULE-1234',
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
      ).toHaveText(['재검증 필요', '미확인']);
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
    await expect(page.getByTestId('rule-field-confirmation')).toHaveText('확인미확인확인');
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
    await expect(page.getByTestId('rule-confirm')).toHaveCount(0);
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
    // 편집 입력이 열려 있는 동안은 [확인]이 없다 (검토 1회차 N4)
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

test.describe('확인 상태 · 폐기 · 변경 이력 (#227 수용 기준 3, ADR-100 D2 · I3 · B⑦, ADR-114)', () => {
  const HUMAN = { kind: 'human' } as const;
  const CONFIRMED_AT = '2026-10-16T10:00:00.000Z';
  /** confirmation.set 가짜 응답 (테스트 전용 데이터): 확인됨, 근거 = 승인 기록 8번. */
  const confirmed: ConfirmationSetResult = {
    target: { entity: 'Rule', id: FAILING_RULE.id },
    confirmation: {
      state: 'confirmed',
      at: CONFIRMED_AT,
      by: HUMAN,
      basis: { kind: 'approval_log', seq: 8 },
    },
    approvalLog: {
      seq: 8,
      at: CONFIRMED_AT,
      action: 'confirm',
      actor: HUMAN,
      targetRef: { entity: 'Rule', id: FAILING_RULE.id },
      clientId: 'pipe-1',
      detail: {},
      prevHash: '0'.repeat(64),
      hash: 'b'.repeat(64),
    },
  };
  const WITH_RETIRED = [...RULES, RETIRED_ITEM];
  const card = (page: Page, displayId: string) =>
    page.locator(`[data-testid="card"][data-id="${displayId}"]`);

  test('[확인]은 confirmation.set을 사람 주체로 1회 부르고, 저장 중에는 꺼지며, 성공하면 상세는 확인됨(버튼 없음) · 목록 카드의 미확인이 사라진다', async ({
    page,
  }) => {
    const bive = await openRules(page, { 'confirmation.set': { result: confirmed, delayMs: 600 } });
    await expect(card(page, 'RULE-002').getByTestId('card-exception')).toHaveText([
      '실패',
      '미확인',
    ]);
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    const button = page.getByTestId('rule-confirm');
    await expect(button).toHaveText('확인');
    // [확인]은 속성 줄 "확인"의 값 옆에 있다
    await expect(
      page.getByTestId('rule-field-confirmation').getByTestId('rule-confirm'),
    ).toHaveCount(1);
    await button.click();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await button.click({ force: true });
    await expect(page.getByTestId('rule-confirmation-state')).toHaveText('확인됨');
    await expect(page.getByTestId('rule-confirm')).toHaveCount(0);
    expect(await callsOf(bive, 'confirmation.set')).toEqual([
      {
        method: 'confirmation.set',
        params: {
          projectId: PROJECT.id,
          target: { entity: 'Rule', id: FAILING_RULE.id },
          author: HUMAN,
        },
      },
    ]);
    // 목록 카드: 판정 예외만 남는다 (다시 읽지 않고 응답으로 바꿈)
    await expect(card(page, 'RULE-002').getByTestId('card-exception')).toHaveText(['실패']);
    // 다른 규칙을 골랐다 돌아와도 확인됨 (목록 항목이 바뀌었다)
    await selectRule(page, bive, 'RULE-001', PASSING_RULE.id);
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    await expect(page.getByTestId('rule-confirmation-state')).toHaveText('확인됨');
    await expect(page.getByTestId('rule-confirm')).toHaveCount(0);
  });

  test('[확인] 실패는 사유 한 줄을 보이고 미확인 · 버튼을 그대로 둔다', async ({ page }) => {
    const bive = await openRules(page, {
      'confirmation.set': { error: { code: -32009, message: '이미 확인됨입니다' } },
    });
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    await page.getByTestId('rule-confirm').click();
    const error = page.getByTestId('rule-confirm-error');
    await expect(error).toHaveText('확인 실패 · 이미 확인됨 또는 삭제된 규칙');
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('rule-confirmation-state')).toHaveText('미확인');
    await expect(page.getByTestId('rule-confirm')).toBeEnabled();
    await expect(card(page, 'RULE-002').getByTestId('card-exception')).toHaveText([
      '실패',
      '미확인',
    ]);
  });

  test('이미 확인됨인 규칙에는 [확인]이 없고 카드에도 미확인 예외가 없다', async ({ page }) => {
    // 확인됨인 규칙 (테스트 전용 데이터)
    const rules = RULES.map((item) =>
      item.rule.id === PASSING_RULE.id
        ? { ...item, rule: { ...item.rule, confirmation: confirmed.confirmation } }
        : item,
    );
    const bive = await openRules(page, { 'rule.list': { result: { rules } } });
    await expect(card(page, 'RULE-001').getByTestId('card-exception')).toHaveCount(0);
    await selectRule(page, bive, 'RULE-001', PASSING_RULE.id);
    await expect(page.getByTestId('rule-confirmation-state')).toHaveText('확인됨');
    await expect(page.getByTestId('rule-confirm')).toHaveCount(0);
    expect(await callsOf(bive, 'confirmation.set')).toEqual([]);
  });

  test('폐기된 규칙: 머리에 "폐기"(판정 배지 대신)와 대체 규칙 링크, 폐기 시각, [편집] · [실행] · [확인] 없음, 변경 이력은 펼쳐져 대체 근거가 보인다', async ({
    page,
  }) => {
    const bive = await openRules(page, { 'rule.list': { result: { rules: WITH_RETIRED } } });
    // 기본 목록에는 없다
    await expect(card(page, 'RULE-009')).toHaveCount(0);
    await page.getByTestId('hidden-toggle').click();
    await expect(card(page, 'RULE-009').getByTestId('card-exception')).toHaveText([
      '폐기',
      '미확인',
    ]);
    await bive.setResponse('normChange.list', { result: RETIRED_CHANGES });
    await selectRule(page, bive, 'RULE-009', RETIRED_RULE.id);

    await expect(page.getByTestId('rule-detail-title')).toHaveText(RETIRED_RULE.title);
    await expect(page.getByTestId('rule-detail-retired')).toHaveText('폐기');
    await expect(page.locator('.rule-detail-head [data-testid="status-badge"]')).toHaveCount(0);
    await expect(page.getByTestId('rule-detail-successor')).toHaveText('대체 규칙 RULE-002');
    // 시각은 카드와 같은 로컬 `YYYY-MM-DD HH:mm` (이 spec은 시간대를 고정하지 않는다)
    await expect(page.getByTestId('rule-field-retired-at')).toHaveText(
      /^폐기 시각2026-10-1[45] \d\d:30$/,
    );
    await expect(page.getByTestId('rule-field-retired-at').locator('time')).toHaveAttribute(
      'datetime',
      RETIRED_ITEM.retirement?.retiredAt ?? '',
    );
    for (const id of ['rule-edit', 'run-start', 'rule-confirm', 'rule-detail-actions']) {
      await expect(page.getByTestId(id), id).toHaveCount(0);
    }
    await expect(page.getByTestId('rule-confirmation-state')).toHaveText('미확인');
    // 변경 이력: 폐기된 규칙은 처음부터 펼침. 대체 기록의 종류 · 주체 · 대체 규칙 · 근거
    const changes = page.getByTestId('rule-changes');
    await expect(changes.getByTestId('collapsible')).toHaveAttribute('data-open', 'true');
    const row = changes.getByTestId('change-row');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('change-kind')).toHaveText('대체');
    await expect(row.getByTestId('change-actor')).toHaveText('에이전트 · 규칙 작성');
    await expect(row.getByTestId('change-subject')).toHaveText('대체 규칙RULE-002');
    await expect(row.getByTestId('change-text-label')).toHaveText('근거');
    await expect(row.getByTestId('change-text-value')).toHaveText(SUPERSEDE_GROUNDS);
    const calls = await callsOf(bive, 'normChange.list');
    expect(calls.at(-1)?.params).toEqual({
      projectId: PROJECT.id,
      targetRef: { entity: 'Rule', id: RETIRED_RULE.id },
    });
    await page.screenshot({ path: `${SCREENSHOT_DIR}SCR-06/규칙-폐기.png`, fullPage: true });
  });

  test('대체 규칙 링크는 새 규칙의 상세로 가고, 새 규칙의 판단 기록(대체 대상)에서 옛 규칙으로 돌아온다. [폐기 포함]이 꺼져 있으면 켠다', async ({
    page,
  }) => {
    const bive = await openRules(page, { 'rule.list': { result: { rules: WITH_RETIRED } } });
    await page.getByTestId('hidden-toggle').click();
    await bive.setResponse('normChange.list', { result: RETIRED_CHANGES });
    await selectRule(page, bive, 'RULE-009', RETIRED_RULE.id);
    // 옛 규칙 → 새 규칙 (머리줄 링크)
    await bive.setResponse('normChange.list', { result: FAILING_CHANGES });
    await bive.setResponse('judgment.list', { result: { judgments: FAILING_HISTORY } });
    await page.getByTestId('rule-detail-successor').getByTestId('rule-ref').click();
    await expect(page.getByTestId('rule-detail')).toHaveAttribute(
      'data-selected-id',
      FAILING_RULE.id,
    );
    await expect(card(page, 'RULE-002')).toHaveAttribute('aria-current', 'true');
    // 새 규칙의 변경 이력: 신규(사유) · 대체 판단(모순, 대상 RULE-009, 근거). 효력 있는 규칙이라 접혀 있다
    await page.getByRole('button', { name: '변경 이력' }).click();
    const rows = page.getByTestId('rule-changes').getByTestId('change-row');
    await expect(rows.getByTestId('change-kind')).toHaveText(['신규', '판단']);
    await expect(rows.nth(0).getByTestId('change-text')).toHaveText(`사유${CREATE_REASON}`);
    await expect(rows.nth(1).getByTestId('change-subject')).toHaveText('모순RULE-009');
    await expect(rows.nth(1).getByTestId('change-text')).toHaveText(`근거${SUPERSEDE_GROUNDS}`);

    // [폐기 포함]을 끄면 옛 규칙 카드는 빠진다. 판단 기록의 RULE-009를 누르면 [폐기 포함]이 켜지고 옛 규칙을 고른다
    await page.getByTestId('hidden-toggle').click();
    await expect(card(page, 'RULE-009')).toHaveCount(0);
    await bive.setResponse('normChange.list', { result: RETIRED_CHANGES });
    await rows.nth(1).getByTestId('rule-ref').click();
    await expect(page.getByTestId('rule-detail')).toHaveAttribute(
      'data-selected-id',
      RETIRED_RULE.id,
    );
    await expect(page.getByTestId('hidden-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(card(page, 'RULE-009')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('rule-detail-retired')).toHaveText('폐기');
  });

  test('변경 이력: 기록 없음 · 불러오기 실패 · 기록 검증 실패 · 잘림 표시', async ({ page }) => {
    const bive = await openRules(page);
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    await page.getByRole('button', { name: '변경 이력' }).click();
    await expect(page.getByTestId('rule-changes-empty')).toHaveText('변경 이력 없음');

    await bive.setResponse('normChange.list', { error: { code: -32603, message: '내부 오류' } });
    await selectRule(page, bive, 'RULE-001', PASSING_RULE.id);
    await page.getByRole('button', { name: '변경 이력' }).click();
    await expect(page.getByTestId('rule-changes-error')).toHaveText('변경 이력 불러오기 실패');

    // 확인 풀림 · 테스트 변경 기록(M7-13, 오케스트레이터 주체): 상세 칸(`unconfirm` · `testChange`)을 읽지 않아도 줄이 그려진다
    const hash = (n: number) => String(n).repeat(64);
    await bive.setResponse('normChange.list', {
      result: {
        entries: [
          {
            seq: 7,
            at: '2026-10-16T05:00:00.000Z',
            kind: 'unconfirmed',
            actor: { kind: 'orchestrator' },
            targetRef: { entity: 'Rule', id: FAILING_RULE.id },
            sessionId: null,
            runId: null,
            reason: null,
            detail: {
              unconfirm: {
                causeSeq: 6,
                previous: {
                  state: 'confirmed',
                  at: '2026-10-16T04:00:00.000Z',
                  by: { kind: 'human' },
                  basis: { kind: 'approval_log', seq: 2 },
                },
              },
            },
            textTruncated: false,
            prevHash: hash(6),
            hash: hash(7),
          },
          {
            seq: 8,
            at: '2026-10-16T06:00:00.000Z',
            kind: 'test_changed',
            actor: { kind: 'orchestrator' },
            targetRef: { entity: 'Rule', id: FAILING_RULE.id },
            sessionId: null,
            runId: '01JE0000000000000000000002',
            reason: null,
            detail: {
              testChange: {
                files: [{ path: 'bive-acceptance/RULE-002/cancel.acc.ts', change: 'modified' }],
                fileCount: 1,
                baseCommit: 'a'.repeat(40),
                headCommit: 'b'.repeat(40),
              },
            },
            textTruncated: false,
            prevHash: hash(7),
            hash: hash(8),
          },
        ],
        chain: { valid: true, brokenAtSeq: null, reason: null },
      },
    });
    await selectRule(page, bive, 'RULE-003', UNJUDGED_RULE.id);
    await page.getByRole('button', { name: '변경 이력' }).click();
    const kinds = page.getByTestId('rule-changes').getByTestId('change-row');
    await expect(kinds.getByTestId('change-kind')).toHaveText(['확인 풀림', '테스트 변경']);
    await expect(kinds.getByTestId('change-actor')).toHaveText([
      '오케스트레이터',
      '오케스트레이터',
    ]);
    await expect(kinds.getByTestId('change-subject')).toHaveCount(0);
    await expect(kinds.getByTestId('change-text')).toHaveCount(0);

    const [first] = FAILING_CHANGES.entries;
    if (first === undefined) throw new Error('기록 없음');
    await bive.setResponse('normChange.list', {
      result: {
        entries: [{ ...first, textTruncated: true }],
        chain: { valid: false, brokenAtSeq: 3, reason: 'hash_mismatch' },
      },
    });
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    // 검증 실패는 펼치지 않아도 보인다 (효력 있는 규칙이어도 변경 이력이 처음부터 펼쳐진다, 검토 1회차 N1)
    await expect(page.getByTestId('rule-changes').getByTestId('collapsible')).toHaveAttribute(
      'data-open',
      'true',
    );
    await expect(page.getByTestId('rule-changes-broken')).toBeVisible();
    await expect(page.getByTestId('rule-changes-broken')).toHaveText('변경 기록 검증 실패');
    await expect(page.getByTestId('change-truncated')).toHaveText('일부 생략');
    // 날 사유 값(hash_mismatch 등)은 화면에 없다
    expect(findForbiddenText(await collectVisibleText(page))).toEqual([]);
    await expect(page.getByText('hash_mismatch')).toHaveCount(0);
  });

  test('변경 이력: 이의 판단(유지 · 폐기 · 판단 없음)은 "이의 판단 · 결과"로 그리고 모순 없음으로 보이지 않으며, 판단 없음의 사정은 표시명이다 (M7-11, ADR-115)', async ({
    page,
  }) => {
    const bive = await openRules(page);
    const hash = (n: number) => String(n).repeat(64);
    const judgment = (
      seq: number,
      verdict: string,
      extra: Record<string, unknown> = {},
    ): NormChangeView =>
      ({
        seq,
        at: `2026-10-16T0${String(seq)}:00:00.000Z`,
        kind: 'judgment',
        actor: { kind: 'agent', role: 'rule-writer' },
        targetRef: { entity: 'Rule', id: FAILING_RULE.id },
        sessionId: '01JS0000000000000000000009',
        runId: '01JE0000000000000000000002',
        reason: '요구사항에 맞아 유지한다',
        detail: {
          judgment: {
            subject: 'objection',
            verdict,
            contradicts: [],
            causeSeq: 1,
            input: { requirements: { total: 1, included: 1 }, rules: { total: 2, included: 2 } },
          },
        },
        textTruncated: false,
        prevHash: hash(seq - 1),
        hash: hash(seq),
        ...extra,
      }) as unknown as NormChangeView;
    await bive.setResponse('normChange.list', {
      result: {
        entries: [
          judgment(2, 'upheld'),
          judgment(3, 'retired', { reason: '진술이 요구사항과 달라 폐기한다' }),
          judgment(4, 'upheld', {
            actor: { kind: 'orchestrator' },
            sessionId: null,
            reason:
              '판단 세션이 이 규칙을 판단하지 못하고 끝나 유지로 봄. 판단 없음은 폐기가 아니다',
            detail: {
              judgment: {
                subject: 'objection',
                verdict: 'upheld',
                contradicts: [],
                causeSeq: 1,
                undecided: { endReason: 'error_max_turns' },
                input: {
                  requirements: { total: 0, included: 0 },
                  rules: { total: 0, included: 0 },
                },
              },
            },
          }),
        ],
        chain: { valid: true, brokenAtSeq: null, reason: null },
      },
    });
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    await page.getByRole('button', { name: '변경 이력' }).click();
    const rows = page.getByTestId('rule-changes').getByTestId('change-row');
    await expect(rows.getByTestId('change-kind')).toHaveText(['판단', '판단', '판단']);
    await expect(rows.getByTestId('change-subject')).toHaveText([
      '이의 판단 · 유지',
      '이의 판단 · 폐기',
      '이의 판단 · 유지 · 판단 없음 (턴 한도 초과)',
    ]);
    await expect(rows.getByTestId('change-actor')).toHaveText([
      '에이전트 · 규칙 작성',
      '에이전트 · 규칙 작성',
      '오케스트레이터',
    ]);
    await expect(page.getByTestId('rule-changes').getByText('모순 없음')).toHaveCount(0);
    // 날 값(종료 사유 · 결과 값)과 문서 번호가 화면에 없다
    for (const raw of ['error_max_turns', 'upheld', 'retired', 'ADR-']) {
      await expect(page.getByTestId('rule-changes').getByText(raw)).toHaveCount(0);
    }
    expect(findForbiddenText(await collectVisibleText(page))).toEqual([]);
  });

  test('제목 · 진술 · 케이스 이름 · 실패 메시지 · [실행] 대화의 대상 줄의 방향 제어 · 영폭 글자는 보이는 표기로 그리고(카드 제목 포함), 편집 입력에는 원문을 넣는다. 편집 중에는 [확인]이 없다', async ({
    page,
  }) => {
    // 테스트 전용 데이터: U+202E(오른쪽에서 왼쪽 덮어쓰기)로 "거절"이 "절거"처럼 뒤집혀 보이게 만든 글
    const title = '주문 취소 \u202e절거\u202c';
    const statement =
      'WHEN 결제 후 24시간이 지난 주문의 취소를 요청하면 THE SYSTEM SHALL \u202e다한락허\u202c\u200b 요청을';
    // 실패 케이스 이름 · 메시지도 에이전트 · 실행기의 글이다 (메시지는 여러 줄)
    const caseName = '취소 요청 \u202e다준려돌\u202c';
    const message = 'AssertionError: expected 200\u200b\nto be 409';
    const rules = RULES.map((item) =>
      item.rule.id === FAILING_RULE.id && item.judgment.latest !== null
        ? {
            ...item,
            rule: { ...item.rule, title, statement },
            judgment: {
              ...item.judgment,
              latest: {
                ...item.judgment.latest,
                cases: item.judgment.latest.cases.map((c) =>
                  c.status === 'failed' ? { ...c, name: caseName, message } : c,
                ),
              },
            },
          }
        : item,
    );
    const bive = await openRules(page, { 'rule.list': { result: { rules } } });
    await expect(card(page, 'RULE-002').getByTestId('card-title')).toHaveText(
      '주문 취소 \\u202e절거\\u202c',
    );
    await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
    await expect(page.getByTestId('rule-detail-title')).toHaveText('주문 취소 \\u202e절거\\u202c');
    await expect(page.getByTestId('rule-detail-statement')).toHaveText(
      'WHEN 결제 후 24시간이 지난 주문의 취소를 요청하면 THE SYSTEM SHALL \\u202e다한락허\\u202c\\u200b 요청을',
    );
    // 그린 글에는 방향 제어 글자가 남지 않는다
    const drawn = await page.getByTestId('rule-detail-statement').textContent();
    expect(drawn?.includes('\u202e')).toBe(false);
    // 실패 원인 · 전체 케이스의 이름은 표기, 메시지는 줄을 살리고 숨은 글자만 표기
    await expect(page.getByTestId('failure-case-name')).toHaveText(
      '취소 요청 \\u202e다준려돌\\u202c',
    );
    const drawnMessage = await page.getByTestId('failure-case-message').textContent();
    expect(drawnMessage).toBe('AssertionError: expected 200\\u200b\nto be 409');
    expect((await page.getByTestId('rule-cases').textContent())?.includes('\u202e')).toBe(false);
    // [실행] 확인 대화의 대상 줄도 표기 (사람이 실행할 규칙을 마지막으로 확인하는 자리, 검토 1회차 B1)
    await page.getByTestId('run-start').click();
    const target = page.getByTestId('run-start-target');
    await expect(target).toHaveText('RULE-002 · 주문 취소 \\u202e절거\\u202c');
    expect((await target.textContent())?.includes('\u202e')).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('run-start-dialog')).toHaveCount(0);
    await expect(page.getByTestId('rule-confirm')).toBeVisible();
    await page.getByTestId('rule-edit').click();
    await expect(page.getByTestId('rule-edit-title')).toHaveValue(title);
    await expect(page.getByTestId('rule-edit-statement')).toHaveValue(statement);
    // 편집 중에는 [확인]을 숨긴다 (저장되지 않은 입력을 둔 채 확인하지 않게, 검토 1회차 N4). 닫으면 다시 보인다
    await expect(page.getByTestId('rule-confirm')).toHaveCount(0);
    await page.getByTestId('rule-edit-cancel').click();
    await expect(page.getByTestId('rule-confirm')).toBeVisible();
  });

  test('폐기된 규칙을 고른 뒤 [폐기 포함]을 끄면 카드와 함께 상세도 빈 상태로 돌아간다 (검토 1회차 N5)', async ({
    page,
  }) => {
    const bive = await openRules(page, {
      'rule.list': { result: { rules: WITH_RETIRED } },
      'normChange.list': { result: RETIRED_CHANGES },
    });
    await page.getByTestId('hidden-toggle').click();
    await selectRule(page, bive, 'RULE-009', RETIRED_RULE.id);
    await expect(page.getByTestId('rule-detail-retired')).toHaveText('폐기');
    await page.getByTestId('hidden-toggle').click();
    await expect(card(page, 'RULE-009')).toHaveCount(0);
    await expect(page.getByTestId('rule-detail')).toHaveAttribute('data-selected-id', '');
    await expect(page.getByTestId('rule-detail').getByText('선택 항목 없음')).toBeVisible();
    await expect(page.getByTestId('rule-detail-body')).toHaveCount(0);
  });

  for (const width of [820, 1280] as const) {
    test(`${width}×800: 폐기된 규칙(긴 제목)의 머리줄과 미확인 규칙의 [확인] · 속성 줄 · 변경 이력이 상세 안에 들어오고 눌린다`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      const longTitle = `${RETIRED_RULE.title} · 결제 시각 기준 12시간 초과 주문의 부분 환불 · 전액 환불 요청 모두 포함`;
      const retired = { ...RETIRED_ITEM, rule: { ...RETIRED_ITEM.rule, title: longTitle } };
      const bive = await openRules(page, {
        'rule.list': { result: { rules: [...RULES, retired] } },
        'normChange.list': { result: RETIRED_CHANGES },
      });
      await page.getByTestId('hidden-toggle').click();
      await selectRule(page, bive, 'RULE-009', RETIRED_RULE.id);
      const pane = page.getByTestId('rule-detail');
      expect(await horizontalOverflow(pane, '[data-testid="change-row"]')).toEqual([]);
      expect(
        await textClipping(pane, ['rule-detail-id', 'rule-detail-retired', 'rule-ref']),
      ).toEqual([]);
      expect(await sameRow(pane, ['rule-detail-retired', 'rule-detail-successor'])).toEqual([]);
      expect(await hitProblems(pane, ['rule-ref'])).toEqual([]);
      // 긴 제목은 글자 몇 개 폭으로 눌리지 않는다
      const paneBox = await pane.boundingBox();
      const titleBox = await page.getByTestId('rule-detail-title').boundingBox();
      if (paneBox === null || titleBox === null) throw new Error('상자 없음');
      expect(titleBox.width).toBeGreaterThan(paneBox.width / 2);
      expect(await brokenWords(page.getByTestId('rule-detail-title'))).toEqual([]);
      await pane.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.screenshot({
        path: `${SCREENSHOT_DIR}SCR-06/규칙-폐기-머리-${width}.png`,
        fullPage: true,
      });

      // 미확인 규칙: 머리 [편집] · [실행]은 한 줄, [확인]은 속성 줄 안에서 눌린다
      await bive.setResponse('normChange.list', { result: FAILING_CHANGES });
      await selectRule(page, bive, 'RULE-002', FAILING_RULE.id);
      await pane.evaluate((el) => {
        el.scrollTop = 0;
      });
      expect(await sameRow(pane, ['rule-edit', 'run-start'])).toEqual([]);
      // [확인]은 확인 상태 값의 오른쪽, 같은 줄(값의 세로 가운데가 버튼 높이 안)
      const stateBox = await page.getByTestId('rule-confirmation-state').boundingBox();
      const confirmBox = await page.getByTestId('rule-confirm').boundingBox();
      if (stateBox === null || confirmBox === null) throw new Error('상자 없음');
      expect(confirmBox.x).toBeGreaterThan(stateBox.x + stateBox.width);
      const middle = stateBox.y + stateBox.height / 2;
      expect(middle).toBeGreaterThan(confirmBox.y);
      expect(middle).toBeLessThan(confirmBox.y + confirmBox.height);
      expect(await textClipping(pane, ['rule-edit', 'run-start', 'rule-confirm'])).toEqual([]);
      expect(await hitProblems(pane, ['rule-edit', 'run-start', 'rule-confirm'])).toEqual([]);
      await page.getByRole('button', { name: '변경 이력' }).click();
      expect(await horizontalOverflow(pane, '[data-testid="change-row"]')).toEqual([]);
      await pane.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.screenshot({
        path: `${SCREENSHOT_DIR}SCR-06/규칙-확인-${width}.png`,
        fullPage: true,
      });
    });
  }
});
