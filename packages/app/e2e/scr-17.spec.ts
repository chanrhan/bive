// SCR-17 자리 확인할 것: 목록 · 상세 · [확인] · 판단 카드 · 필터 · 배치 (이슈 #226 수용 기준 1 · 2 · 4, screens.md 6장 할 일 · SCR-17,
// TODO-01 · NRM-04, ADR-100 명세 변경 SCR-17 · D2 · D3 · B⑦ · D8, ADR-113 · ADR-119).
// 옛 승인 대기의 승인 · 수정 · 거절 시험은 기능이 대체되어(ADR-063 · ADR-082 → ADR-119) 이 시험으로 바뀌었다.
// 데이터는 가짜 브리지 응답(e2e/checklists/scr-17.ts, shared 스키마 대조는 test/todo-confirmation.test.ts)으로만 만든다:
//   ① 대체 RULE-001(확인 풀림) · 폐기 RULE-002(미확인) ② 테스트 변경 RULE-004 2건(실행 2개) ③ 미확인 RULE-003 · RULE-005 · REQ-002
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { ConfirmationListResult, RuleWithJudgment } from '@bive/shared';
import { expect, type Locator, type Page, test } from '@playwright/test';

import { REQUIREMENTS } from './checklists/scr-02.js';
import { RULES } from './checklists/scr-03.js';
import { CODE_OPEN_SUMMARY, SUMMARY } from './checklists/scr-05.js';
import {
  CONFIRMATION_FILTERS,
  FIXTURE_CHANGE_LIST,
  FIXTURE_CHANGE_LIST_BROKEN,
  FIXTURE_CHANGE_LIST_MORE,
  FIXTURE_CONFIRM_RULE4,
  FIXTURE_LIST,
  FIXTURE_LIST_AFTER_RULE4,
  FIXTURE_TRUNCATED,
  ID,
  ITEM_RETIRED,
  ITEM_RETIRED_TRUNCATED,
  ITEM_SUPERSEDED,
  ITEM_TEST_2,
  LONG_PATH,
  LATER_OBJECTION_GROUNDS,
  LONG_TITLE,
  listOf,
  NEW_RULE_GROUNDS,
  OBJECTION_GROUNDS,
  PROJECT,
  REMOVED_ACTIONS,
  RLO_RATIONALE_SHOWN,
  RULE1_BEFORE,
  RULE3_AFTER,
  RULE5_RATIONALE,
  RULE5_STATEMENT,
  SUPERSEDE_GROUNDS,
} from './checklists/scr-17.js';
import {
  allSettled,
  type BiveMock,
  mockBive,
  type MockResponses,
  nextFrame,
} from './support/bive-mock.js';
import {
  collectVisibleText,
  expectScreen,
  findForbiddenText,
  SCREENSHOT_DIR,
} from './support/expectScreen.js';
import {
  DETAIL_PANE_MIN,
  hitProblems,
  LIST_PANE_MAX,
  LIST_PANE_MIN,
  listPaneOverflow,
  paneWidths,
  textClipping,
} from './support/overflow.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
const SERVER_ORDER = [
  'RULE-001',
  'RULE-002',
  'RULE-004',
  'RULE-004',
  'RULE-003',
  'RULE-005',
  'REQ-002',
] as const;

/** 화면에 날 코드 값(enum · 역할 ID)이 보이면 안 된다 (ADR-119, 1.1 코드 표기 금지). */
const RAW_CODES =
  /\b(?:no_contradiction|contradiction|upheld|superseded|retired|test_changed|unconfirmed_norm|unconfirmed|new_rule|supersede|objection|requirement_change|check_failure|rule-writer|test-writer|implementer|orchestrator|modified|removed)\b/;

const setup = async (
  page: Page,
  list: ConfirmationListResult = FIXTURE_LIST,
  extra: MockResponses = {},
): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'confirmation.list': { result: list },
      'normChange.list': { result: FIXTURE_CHANGE_LIST },
      'confirmation.set': { result: FIXTURE_CONFIRM_RULE4 },
      ...extra,
    },
  });
  await page.goto('/');
  await expect(page.getByTestId('sidebar-project')).toHaveText(PROJECT.name);
  await page.getByTestId('todo-button').click();
  await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'todo');
  return bive;
};

const cards = (page: Page): Locator => page.getByTestId('list-items').getByTestId('card');
const cardAt = (page: Page, index: number): Locator => cards(page).nth(index);
const detail = (page: Page): Locator => page.getByTestId('todo-detail');
const callsOf = async (bive: BiveMock, method: string): Promise<unknown[]> =>
  (await bive.calls()).filter((c) => c.method === method).map((c) => c.params);

/** 상세 구획을 DOM 순서대로. */
const sectionOrder = (page: Page): Promise<string[]> =>
  detail(page)
    .locator('[data-detail-section]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-detail-section') ?? ''));

/** 화면 상태 스크린샷 (artifacts/screens/SCR-17/<이름>.png) + 화면 문구 규칙 · 날 코드 값 검사. */
const snapshot = async (page: Page, name: string): Promise<void> => {
  const file = path.join(SCREENSHOT_DIR, 'SCR-17', `${name}.png`);
  await mkdir(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: true });
  const texts = await collectVisibleText(page);
  expect(findForbiddenText(texts)).toEqual([]);
  expect(texts.filter(({ text }) => RAW_CODES.test(text))).toEqual([]);
};

/** 필터 칩의 값 하나를 켠다. */
const choose = async (page: Page, criterion: string, value: string): Promise<void> => {
  const chip = page.getByTestId(`filter-chip-${criterion}`);
  await chip.getByTestId('filter-chip-button').click();
  await chip.locator(`[data-testid="filter-option"][data-value="${value}"] input`).check();
  await page.keyboard.press('Escape');
};

/** 칩 메뉴를 열어 값 → 개수를 읽는다. */
const optionCounts = async (page: Page, criterion: string): Promise<Record<string, string>> => {
  const chip = page.getByTestId(`filter-chip-${criterion}`);
  await chip.getByTestId('filter-chip-button').click();
  const options = chip.getByTestId('filter-option');
  const values = await options.evaluateAll((els) =>
    els.map((el) => [
      el.getAttribute('data-value') ?? '',
      el.querySelector('[data-testid="filter-count"]')?.textContent ?? '',
    ]),
  );
  await page.keyboard.press('Escape');
  return Object.fromEntries(values);
};

test.describe('목록 기본 · 빈 상태 (수용 기준 1)', () => {
  test('기본: 서버 순서 그대로(폐기 · 대체 맨 위), 1줄 종류 태그 · 제목, 2줄 ID · 예외 · 시각, 처리 버튼 · 상한 없음', async ({
    page,
  }) => {
    await setup(page);
    await expectScreen(page, 'SCR-17', '기본');

    // 순서: 서버가 준 그대로 (문제 우선 · 시각 정렬을 하면 RULE-003(10:00)이 둘째로 올라온다)
    await expect(cards(page).getByTestId('card-id')).toHaveText([...SERVER_ORDER]);
    await expect(cards(page).getByTestId('card-tag')).toHaveText([
      '대체',
      '폐기',
      '변경',
      '변경',
      '신규',
      '신규',
      '요구사항',
    ]);
    await expect(cards(page).getByTestId('card-exception')).toHaveText([
      '확인 풀림',
      '미확인',
      '테스트 변경',
      '테스트 변경',
      '미확인',
      '미확인',
      '미확인',
    ]);
    await expect(cards(page).getByTestId('card-title')).toHaveText([
      RULE1_BEFORE.title,
      ITEM_RETIRED.before.title,
      ITEM_TEST_2.title,
      ITEM_TEST_2.title,
      RULE3_AFTER.title,
      LONG_TITLE,
      '헬스 응답에 리전 이름을 포함한다',
    ]);
    // 자리: 태그 · 제목은 1줄, ID · 예외 · 시각은 2줄
    const first = cardAt(page, 0);
    await expect(first.locator('.card-line-1').getByTestId('card-tag')).toHaveText('대체');
    await expect(first.locator('.card-line-1').getByTestId('card-title')).toHaveText(
      RULE1_BEFORE.title,
    );
    const line2 = first.getByTestId('card-line-2');
    await expect(line2.getByTestId('card-id')).toHaveText('RULE-001');
    await expect(line2.getByTestId('card-exception')).toHaveText('확인 풀림');
    await expect(line2.locator('time')).toHaveAttribute('datetime', ITEM_SUPERSEDED.at);
    const ids = await line2.evaluate((el) =>
      [...el.children].map((c) => c.getAttribute('data-testid') ?? c.tagName.toLowerCase()),
    );
    expect(ids.indexOf('card-id')).toBeLessThan(ids.indexOf('card-exception'));
    // 처리 버튼 · 상한 머리줄 없음 (D8)
    for (const name of REMOVED_ACTIONS) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    await expect(page.getByText(/상한/)).toHaveCount(0);
  });

  test('빈: 확인할 항목 없음', async ({ page }) => {
    await setup(page, listOf([]));
    await expectScreen(page, 'SCR-17', '빈');
  });

  test('잘린 목록: 전체 수와 보인 수 머리줄, 배지 = total, 툴팁은 자르기 전 종류별 수', async ({
    page,
  }) => {
    await setup(page, FIXTURE_TRUNCATED);
    await expect(page.getByTestId('confirmation-truncated')).toHaveText('250건 중 7건 표시');
    await expect(page.getByTestId('todo-badge')).toHaveText('250');
    await expect(page.getByTestId('todo-button')).toHaveAttribute(
      'title',
      '미확인 246 · 테스트 변경 2 · 폐기 1 · 대체 1',
    );
  });
});

test.describe('상세 (수용 기준 2)', () => {
  test('대체: 변경 전후 diff · 사유(숨은 글자 표기) · 근거 · 생성 주체 · 판단 카드(모순) · 대상과 대체 규칙 링크', async ({
    page,
  }) => {
    const bive = await setup(page);
    await cardAt(page, 0).click();
    await expect(detail(page)).toHaveAttribute('data-selected-id', 'RULE-001');
    await expect
      .poll(() => sectionOrder(page))
      .toEqual(['head', 'diff', 'facts', 'judgments', 'links']);
    await expect(page.getByTestId('detail-tag')).toHaveText('대체');
    await expect(page.getByTestId('detail-title')).toHaveText(RULE1_BEFORE.title);
    await expect(page.getByTestId('detail-exception')).toHaveText('확인 풀림');

    const rows = page.getByTestId('detail-diff-row');
    await expect(rows.locator('dt')).toHaveText(['제목', '진술']);
    await expect(rows.nth(0).getByTestId('diff-before')).toHaveText(`이전${RULE1_BEFORE.title}`);
    await expect(rows.nth(0).getByTestId('diff-after')).toHaveText(`이후${RULE3_AFTER.title}`);
    await expect(rows.nth(1).getByTestId('diff-before')).toHaveText(
      `이전${RULE1_BEFORE.statement}`,
    );
    await expect(rows.nth(1).getByTestId('diff-after')).toHaveText(`이후${RULE3_AFTER.statement}`);

    // 사유의 U+202E는 표기로 (원문 글자가 화면에 남지 않음), 이미 표시 값인 근거는 그대로(역슬래시 하나)
    await expect(page.getByTestId('detail-rationale').locator('dd')).toHaveText(
      RLO_RATIONALE_SHOWN,
    );
    const rationale = await page.getByTestId('detail-rationale').locator('dd').innerText();
    expect(rationale.includes('\u202e')).toBe(false);
    await expect(page.getByTestId('detail-grounds').locator('dd')).toHaveText(SUPERSEDE_GROUNDS);
    await expect(page.getByTestId('detail-author').locator('dd')).toHaveText(
      '에이전트 · 규칙 작성',
    );

    // 판단 카드: 대체는 새 규칙(RULE-003)을 대상으로 남은 모순 판단
    const card = page.getByTestId('judgment-card');
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId('judgment-subject')).toHaveText('모순 판단');
    await expect(card.getByTestId('judgment-verdict')).toHaveText('모순');
    await expect(card.getByTestId('judgment-contradicts')).toHaveText('모순 대상 · RULE-001');
    await expect(card.getByTestId('judgment-grounds')).toHaveText(SUPERSEDE_GROUNDS);

    await expect(page.getByTestId('detail-link')).toHaveText([
      '대상 · RULE-001',
      '대체 규칙 · RULE-003',
    ]);
    // 대상(옛 규칙)과 대체 규칙의 기록을 읽는다
    await expect
      .poll(() => callsOf(bive, 'normChange.list'))
      .toEqual(
        expect.arrayContaining([
          { projectId: PROJECT.id, targetRef: { entity: 'Rule', id: ID.rule1 } },
          { projectId: PROJECT.id, targetRef: { entity: 'Rule', id: ID.rule3 } },
        ]),
      );
    await snapshot(page, '상세-대체');
  });

  test('미확인 규칙: 이후 값만(제목 · 진술), 사유, 판단 카드 모순 판단 · 모순 없음과 이의 판단 · 유지', async ({
    page,
  }) => {
    await setup(page);
    await cardAt(page, 5).click();
    await expect(detail(page)).toHaveAttribute('data-selected-id', 'RULE-005');
    await expect(page.getByTestId('detail-tag')).toHaveText('신규');
    await expect(page.getByTestId('detail-exception')).toHaveText('미확인');
    const rows = page.getByTestId('detail-diff-row');
    await expect(rows.locator('dt')).toHaveText(['제목', '진술']);
    await expect(page.getByTestId('diff-before')).toHaveCount(0);
    await expect(rows.nth(0).getByTestId('diff-after')).toHaveText(`이후${LONG_TITLE}`);
    await expect(rows.nth(1).getByTestId('diff-after')).toHaveText(`이후${RULE5_STATEMENT}`);
    await expect(page.getByTestId('detail-rationale').locator('dd')).toHaveText(RULE5_RATIONALE);
    await expect(page.getByTestId('detail-grounds')).toHaveCount(0);

    const judgment = page.getByTestId('judgment-card');
    await expect(judgment.getByTestId('judgment-subject')).toHaveText(['모순 판단', '이의 판단']);
    await expect(judgment.getByTestId('judgment-verdict')).toHaveText(['모순 없음', '유지']);
    await expect(judgment.getByTestId('judgment-grounds')).toHaveText([
      NEW_RULE_GROUNDS,
      OBJECTION_GROUNDS,
    ]);
    await expect(judgment.getByTestId('judgment-actor')).toHaveText([
      '에이전트 · 규칙 작성',
      '에이전트 · 규칙 작성',
    ]);
    await expect(judgment.getByTestId('judgment-contradicts')).toHaveCount(0);
    await snapshot(page, '상세-미확인-판단');
  });

  test('폐기: 이전 값만 · 판단 기록 없음, 요구사항: 본문 · 생성 주체 역할', async ({ page }) => {
    await setup(page);
    await cardAt(page, 1).click();
    await expect(page.getByTestId('detail-tag')).toHaveText('폐기');
    await expect(page.getByTestId('diff-after')).toHaveCount(0);
    await expect(page.getByTestId('diff-before')).toHaveText([
      `이전${ITEM_RETIRED.before.title}`,
      `이전${ITEM_RETIRED.before.statement}`,
    ]);
    await expect(page.getByTestId('detail-grounds').locator('dd')).toHaveText(ITEM_RETIRED.grounds);
    await expect(page.getByTestId('judgments-empty')).toHaveText('판단 기록 없음');

    await cardAt(page, 6).click();
    await expect(page.getByTestId('detail-tag')).toHaveText('요구사항');
    await expect(page.getByTestId('detail-diff-row').locator('dt')).toHaveText(['본문']);
    await expect(page.getByTestId('detail-author').locator('dd')).toHaveText('에이전트 · 채팅');
    await expect(page.getByTestId('detail-link')).toHaveText(['대상 · REQ-002']);
  });

  test('테스트 변경: 바뀐 파일(경로 · 바뀜/지움) · 전체 수 · 실행, 같은 대상 항목 함께 확인 문구', async ({
    page,
  }) => {
    await setup(page);
    await cardAt(page, 3).click();
    await expect(page.getByTestId('detail-tag')).toHaveText('변경');
    await expect(page.getByTestId('detail-exception')).toHaveText('테스트 변경');
    await expect(page.getByTestId('detail-diff')).toHaveCount(0);
    await expect(page.getByTestId('detail-file-path')).toHaveText([
      LONG_PATH,
      'bive-acceptance/RULE-004/old-helper.acc.ts',
    ]);
    await expect(page.getByTestId('detail-file-change')).toHaveText(['바뀜', '지움']);
    await expect(page.getByTestId('detail-file-count')).toHaveText('전체 3개 중 2개');
    await expect(page.getByTestId('detail-run').locator('dd')).toHaveText('EXE-003');
    await expect(page.getByTestId('detail-author').locator('dd')).toHaveText('오케스트레이터');
    await expect(page.getByTestId('confirm-same-target')).toHaveText(
      '같은 대상 항목 1건 함께 확인',
    );
    // 다른 대상의 항목에는 그 문구가 없다
    await cardAt(page, 1).click();
    await expect(page.getByTestId('confirm-same-target')).toHaveCount(0);
  });
});

test.describe('[확인] (수용 기준 2)', () => {
  test('confirmation.set을 사람 주체로 정확히 1회 부르고, 같은 대상의 항목이 함께 내려가며 목록 · 배지가 줄어든다', async ({
    page,
  }) => {
    const bive = await setup(page, FIXTURE_LIST, {
      'confirmation.set': { result: FIXTURE_CONFIRM_RULE4, delayMs: 300 },
    });
    await expect(page.getByTestId('todo-badge')).toHaveText('7');
    await cardAt(page, 2).click();
    await expect(detail(page)).toHaveAttribute('data-selected-id', 'RULE-004');
    // 서버는 그 규칙의 테스트 변경 2건을 함께 내린다
    await bive.setResponse('confirmation.list', { result: FIXTURE_LIST_AFTER_RULE4 });
    const button = page.getByTestId('confirm-button');
    await button.click();
    // 저장 중에는 꺼진다(두 번 눌러도 1회)
    await expect(button).toBeDisabled();
    await expect(button).toHaveText('저장 중');
    await button.click({ force: true });

    await expect(cards(page)).toHaveCount(5);
    await expect(cards(page).getByTestId('card-id')).toHaveText([
      'RULE-001',
      'RULE-002',
      'RULE-003',
      'RULE-005',
      'REQ-002',
    ]);
    await expect(page.getByTestId('todo-badge')).toHaveText('5');
    await expect(page.getByTestId('todo-button')).toHaveAttribute(
      'title',
      '미확인 3 · 폐기 1 · 대체 1',
    );
    // 고른 항목이 내려가 상세는 빈 자리
    await expect(detail(page).getByTestId('empty-state')).toHaveText('선택 항목 없음');
    expect(await callsOf(bive, 'confirmation.set')).toEqual([
      {
        projectId: PROJECT.id,
        target: { entity: 'Rule', id: ID.rule4 },
        author: { kind: 'human' },
      },
    ]);
  });

  test('폐기된 규칙도 이 화면에서 [확인]한다 (규칙 상세에는 그 버튼이 없다)', async ({ page }) => {
    const bive = await setup(page);
    await cardAt(page, 1).click();
    await page.getByTestId('confirm-button').click();
    await expect
      .poll(() => callsOf(bive, 'confirmation.set'))
      .toEqual([
        {
          projectId: PROJECT.id,
          target: { entity: 'Rule', id: ID.rule2 },
          author: { kind: 'human' },
        },
      ]);
  });

  test('이미 확인됨 · 삭제된 대상(-32009): 오류 없이 목록을 다시 읽는다, 그 밖의 실패는 한 줄', async ({
    page,
  }) => {
    const bive = await setup(page, FIXTURE_LIST, {
      'confirmation.set': { error: { code: -32009, message: '상태 충돌' } },
    });
    await cardAt(page, 4).click();
    const before = (await callsOf(bive, 'confirmation.list')).length;
    await bive.setResponse('confirmation.list', {
      result: listOf(FIXTURE_LIST.items.filter((_, i) => i !== 4)),
    });
    await page.getByTestId('confirm-button').click();
    await expect
      .poll(async () => (await callsOf(bive, 'confirmation.list')).length)
      .toBe(before + 1);
    await expect(cards(page)).toHaveCount(6);
    await expect(page.getByTestId('confirm-error')).toHaveCount(0);

    await bive.setResponse('confirmation.set', { error: { code: -32603, message: '내부 오류' } });
    await cardAt(page, 0).click();
    await page.getByTestId('confirm-button').click();
    await expect(page.getByTestId('confirm-error')).toHaveText('확인 실패');
    await expect(page.getByTestId('confirm-button')).toBeEnabled();
    await expect(cards(page)).toHaveCount(6);
  });
});

test.describe('판단 기록 · 일부 생략 · 상세 다시 읽기', () => {
  test('변경 기록 검증이 깨졌으면 판단 구역 안에 "변경 기록 검증 실패", 판단 카드는 그대로', async ({
    page,
  }) => {
    await setup(page, FIXTURE_LIST, { 'normChange.list': { result: FIXTURE_CHANGE_LIST_BROKEN } });
    await cardAt(page, 5).click();
    const section = page.getByTestId('detail-section-judgments');
    await expect(section.getByTestId('chain-broken')).toHaveText('변경 기록 검증 실패');
    await expect(page.getByTestId('chain-broken')).toHaveCount(1);
    await expect(section.getByTestId('judgment-card')).toHaveCount(2);
    // 판단이 없는 항목에서도 검증 실패는 보인다 (판단 기록 없음과 함께)
    await cardAt(page, 1).click();
    await expect(section.getByTestId('chain-broken')).toHaveText('변경 기록 검증 실패');
    await expect(section.getByTestId('judgments-empty')).toHaveText('판단 기록 없음');
  });

  test('검증이 정상이면 "변경 기록 검증 실패"가 없다', async ({ page }) => {
    await setup(page);
    await cardAt(page, 5).click();
    await expect(page.getByTestId('judgment-card')).toHaveCount(2);
    await expect(page.getByTestId('chain-broken')).toHaveCount(0);
  });

  test('판단 기록을 못 읽으면 판단 구역 안에 "판단 기록 불러오기 실패", 나머지 상세와 [확인]은 그대로 쓸 수 있다', async ({
    page,
  }) => {
    const bive = await setup(page, FIXTURE_LIST, {
      'normChange.list': { error: { code: -32603, message: '내부 오류' } },
    });
    await cardAt(page, 0).click();
    const section = page.getByTestId('detail-section-judgments');
    await expect(section.getByTestId('judgments-failed')).toHaveText('판단 기록 불러오기 실패');
    await expect(page.getByTestId('judgments-failed')).toHaveCount(1);
    await expect(section.getByTestId('judgment-card')).toHaveCount(0);
    await expect(section.getByTestId('judgments-empty')).toHaveCount(0);
    // 목록 항목에서 온 칸은 그대로 보인다
    await expect(page.getByTestId('detail-grounds').locator('dd')).toHaveText(SUPERSEDE_GROUNDS);
    // 판단 기록을 못 읽어도 [확인]은 막지 않는다 (ADR-119)
    const button = page.getByTestId('confirm-button');
    await expect(button).toBeEnabled();
    await button.click();
    await expect.poll(() => callsOf(bive, 'confirmation.set')).toHaveLength(1);
  });

  test('글이 상한에서 잘린 항목은 기록 구역 안에 "일부 생략"', async ({ page }) => {
    await setup(page, listOf([ITEM_RETIRED_TRUNCATED, ITEM_SUPERSEDED]));
    await cardAt(page, 0).click();
    await expect(
      page.getByTestId('detail-section-facts').getByTestId('detail-truncated'),
    ).toHaveText('일부 생략');
    await cardAt(page, 1).click();
    await expect(page.getByTestId('detail-truncated')).toHaveCount(0);
  });

  test('상세가 열린 동안 규범 변경 알림이 오면 판단 기록을 다시 읽어 새 판단 카드를 보인다', async ({
    page,
  }) => {
    const bive = await setup(page);
    await cardAt(page, 5).click();
    await expect(page.getByTestId('judgment-card')).toHaveCount(2);
    const before = (await callsOf(bive, 'normChange.list')).length;
    await bive.setResponse('normChange.list', { result: FIXTURE_CHANGE_LIST_MORE });
    await bive.emit('event.normChange.appended', { projectId: PROJECT.id, lastSeq: 12 });
    await expect(page.getByTestId('judgment-card')).toHaveCount(3);
    await expect(page.getByTestId('judgment-grounds').last()).toHaveText(LATER_OBJECTION_GROUNDS);
    expect((await callsOf(bive, 'normChange.list')).length).toBeGreaterThan(before);
    // 다른 프로젝트 알림으로는 다시 읽지 않는다
    await page.waitForTimeout(300);
    const after = (await callsOf(bive, 'normChange.list')).length;
    await bive.emit('event.normChange.appended', {
      projectId: '01JCCCCCCCCCCCCCCCCCCCCCCC',
      lastSeq: 13,
    });
    await page.waitForTimeout(500);
    expect((await callsOf(bive, 'normChange.list')).length).toBe(after);
  });
});

test.describe('[확인] 중복 방지', () => {
  test('같은 틱에 두 번 눌러도 confirmation.set은 1회', async ({ page }) => {
    const bive = await setup(page);
    await cardAt(page, 1).click();
    await page.getByTestId('confirm-button').evaluate((el) => {
      (el as HTMLButtonElement).click();
      (el as HTMLButtonElement).click();
    });
    await expect.poll(() => callsOf(bive, 'confirmation.set')).toHaveLength(1);
    await page.waitForTimeout(500);
    expect(await callsOf(bive, 'confirmation.set')).toHaveLength(1);
  });

  test('성공 뒤 목록 다시 읽기가 끝날 때까지 [확인]은 꺼져 있고 두 번째 요청은 가지 않는다', async ({
    page,
  }) => {
    const bive = await setup(page);
    await cardAt(page, 1).click();
    // 성공 뒤 다시 읽기는 늦게 끝난다 (그 사이 목록은 아직 옛 항목)
    await bive.setResponse('confirmation.list', { result: FIXTURE_LIST, delayMs: 1500 });
    const button = page.getByTestId('confirm-button');
    await button.click();
    await expect.poll(() => callsOf(bive, 'confirmation.set')).toHaveLength(1);
    await page.waitForTimeout(500);
    await expect(button).toBeDisabled();
    await expect(button).toHaveText('저장 중');
    await button.evaluate((el) => (el as HTMLButtonElement).click());
    expect(await callsOf(bive, 'confirmation.set')).toHaveLength(1);
    // 다시 읽기가 끝나면 다시 켜진다 (항목이 그대로 남은 응답)
    await expect(button).toBeEnabled({ timeout: 5000 });
    expect(await callsOf(bive, 'confirmation.set')).toHaveLength(1);
  });
});

test.describe('[확인] 뒤 버튼 복구', () => {
  test('-32009인데 다시 읽은 목록에 그 항목이 남아 있으면 오류 없이 버튼이 다시 "확인"으로 켜진다', async ({
    page,
  }) => {
    const bive = await setup(page, FIXTURE_LIST, {
      'confirmation.set': { error: { code: -32009, message: '상태 충돌' }, delayMs: 300 },
    });
    await cardAt(page, 1).click();
    const before = (await callsOf(bive, 'confirmation.list')).length;
    const button = page.getByTestId('confirm-button');
    await button.click();
    await expect(button).toBeDisabled();
    await expect(button).toHaveText('저장 중');
    // 다시 읽기는 끝나고 그 항목은 그대로 남아 있다
    await expect
      .poll(async () => (await callsOf(bive, 'confirmation.list')).length)
      .toBe(before + 1);
    await expect(cards(page)).toHaveCount(FIXTURE_LIST.items.length);
    await expect(detail(page)).toHaveAttribute('data-selected-id', 'RULE-002');
    await expect(button).toBeEnabled();
    await expect(button).toHaveText('확인');
    await expect(page.getByTestId('confirm-error')).toHaveCount(0);
    // 다시 누를 수 있다
    await button.click();
    await expect.poll(() => callsOf(bive, 'confirmation.set')).toHaveLength(2);
  });

  test('성공 뒤 다시 읽기가 실패하면 목록 불러오기 실패를 보이고, 다음 다시 읽기에서 그 항목의 버튼은 켜져 있다', async ({
    page,
  }) => {
    const bive = await setup(page);
    await cardAt(page, 1).click();
    await bive.setResponse('confirmation.list', { error: { code: -32603, message: '내부 오류' } });
    await page.getByTestId('confirm-button').click();
    await expect.poll(() => callsOf(bive, 'confirmation.set')).toHaveLength(1);
    // 지금 동작: 목록 자리는 "목록 불러오기 실패", 항목이 없어 상세는 빈 자리, 배지는 없다
    await expect(page.getByTestId('todo-list-pane').getByTestId('empty-state')).toHaveText(
      '목록 불러오기 실패',
    );
    await expect(detail(page).getByTestId('empty-state')).toHaveText('선택 항목 없음');
    await expect(page.getByTestId('todo-badge')).toHaveCount(0);
    // 다음 다시 읽기(규범 변경 알림)에서 같은 항목이 돌아오면 고른 그대로이고 버튼은 꺼진 채 남지 않는다
    await bive.setResponse('confirmation.list', { result: FIXTURE_LIST });
    await bive.emit('event.normChange.appended', { projectId: PROJECT.id, lastSeq: 20 });
    await expect(cards(page)).toHaveCount(FIXTURE_LIST.items.length);
    await expect(detail(page)).toHaveAttribute('data-selected-id', 'RULE-002');
    const button = page.getByTestId('confirm-button');
    await expect(button).toBeEnabled();
    await expect(button).toHaveText('확인');
  });
});

test.describe('대상 링크 (M3-35 #263: 카드를 고른 상태로 열림)', () => {
  /** 규칙 화면 목록: RULE-001은 폐기된 규칙(RULE-003이 대체, 테스트 전용 데이터). */
  const RULES_WITH_RETIRED: RuleWithJudgment[] = RULES.map((item) =>
    item.rule.displayId === 'RULE-001'
      ? {
          ...item,
          retirement: {
            retiredAt: '2026-11-23T09:00:00.000Z',
            supersededBy: {
              id: RULES.find(({ rule }) => rule.displayId === 'RULE-003')?.rule.id ?? '',
              displayId: 'RULE-003',
            },
            normChangeSeq: 3,
          },
        }
      : item,
  );
  const ruleIdOf = (displayId: string): string =>
    RULES.find(({ rule }) => rule.displayId === displayId)?.rule.id ?? '';
  const selectedCard = (page: Page): Locator =>
    page.getByTestId('list-items').locator('[data-testid="card"][aria-current="true"]');
  const links: MockResponses = {
    'rule.list': { result: { rules: RULES_WITH_RETIRED } },
    'requirement.list': { result: { requirements: REQUIREMENTS } },
  };

  /** 규칙 목록 읽기가 모두 끝나고 그린 뒤까지 기다린다. */
  const rulesSettled = async (bive: BiveMock, page: Page): Promise<void> => {
    await allSettled(bive, 'rule.list');
    await nextFrame(page);
  };

  test('폐기된 규칙 링크: 규칙 화면이 [폐기 포함] · 그 표시 ID 검색으로 열리고 그 카드가 골라져 상세가 열린다', async ({
    page,
  }) => {
    await setup(page, FIXTURE_LIST, links);
    await cardAt(page, 0).click();
    await page.getByTestId('detail-link').first().click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await expect(page.getByTestId('list-search')).toHaveValue('RULE-001');
    await expect(page.getByTestId('hidden-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(selectedCard(page)).toHaveCount(1);
    await expect(selectedCard(page)).toHaveAttribute('data-id', 'RULE-001');
    await expect(page.getByTestId('rule-detail')).toHaveAttribute(
      'data-selected-id',
      ruleIdOf('RULE-001'),
    );
    await expect(page.getByTestId('rule-detail-retired')).toHaveText('폐기');
  });

  test('대체 규칙 링크: 폐기 포함 없이 그 카드가 골라진다', async ({ page }) => {
    await setup(page, FIXTURE_LIST, links);
    await cardAt(page, 0).click();
    await page.getByTestId('detail-link').nth(1).click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await expect(page.getByTestId('hidden-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(selectedCard(page)).toHaveAttribute('data-id', 'RULE-003');
    await expect(page.getByTestId('rule-detail')).toHaveAttribute(
      'data-selected-id',
      ruleIdOf('RULE-003'),
    );
  });

  test('요구사항 링크: 요구사항 화면이 그 표시 ID 검색으로 열리고 그 카드가 골라져 상세가 열린다', async ({
    page,
  }) => {
    const bive = await setup(page, FIXTURE_LIST, links);
    await cardAt(page, 6).click();
    await page.getByTestId('detail-link').click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'requirements');
    await expect(page.getByTestId('list-search')).toHaveValue('REQ-002');
    await expect(selectedCard(page)).toHaveAttribute('data-id', 'REQ-002');
    await expect(page.getByTestId('requirement-detail')).toHaveAttribute(
      'data-selected-id',
      REQUIREMENTS.find(({ displayId }) => displayId === 'REQ-002')?.id ?? '',
    );
    // 고를 항목은 그 이동 한 번만: 사이드바로 다시 들어오면 고른 카드가 없다
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await page.getByRole('button', { name: '요구사항', exact: true }).click();
    await expect(cards(page).first()).toBeVisible();
    await allSettled(bive, 'requirement.list');
    await nextFrame(page);
    await expect(selectedCard(page)).toHaveCount(0);
  });

  test('목록 읽기가 실패하면 고를 항목을 버린다: 뒤의 알림으로 목록을 다시 읽어도 링크 대상이 골라지지 않는다', async ({
    page,
  }) => {
    const bive = await setup(page, FIXTURE_LIST, {
      ...links,
      'rule.list': { error: { code: -32603, message: '내부 오류' } },
    });
    await cardAt(page, 0).click();
    await page.getByTestId('detail-link').nth(1).click();
    await expect(page.getByTestId('rules-load-error')).toBeVisible();
    await bive.setResponse('rule.list', { result: { rules: RULES_WITH_RETIRED } });
    await bive.emit('event.normChange.appended', { projectId: PROJECT.id, lastSeq: 13 });
    await expect(cards(page).filter({ hasText: 'RULE-003' })).toHaveCount(1);
    await rulesSettled(bive, page);
    await expect(selectedCard(page)).toHaveCount(0);
  });

  test('고를 항목은 그 이동 한 번만: 다른 카드를 고른 뒤 알림으로 목록을 다시 읽어도, 사이드바로 다시 들어와도 링크 대상이 다시 골라지지 않는다', async ({
    page,
  }) => {
    const bive = await setup(page, FIXTURE_LIST, links);
    await cardAt(page, 0).click();
    await page.getByTestId('detail-link').nth(1).click();
    await expect(selectedCard(page)).toHaveAttribute('data-id', 'RULE-003');
    await page.getByTestId('list-search').fill('');
    await page
      .getByTestId('list-items')
      .locator('[data-testid="card"][data-id="RULE-002"]')
      .click();
    await expect(page.getByTestId('rule-detail')).toHaveAttribute(
      'data-selected-id',
      ruleIdOf('RULE-002'),
    );
    const listCalls = async (): Promise<number> => (await callsOf(bive, 'rule.list')).length;
    const before = await listCalls();
    await bive.emit('event.run.updated', {
      projectId: PROJECT.id,
      runId: '01JBVE00000000000000000E09',
      displayId: 'EXE-009',
      status: 'running',
      currentStep: 'implementation',
      regressionCount: 0,
      costUsd: null,
    });
    await bive.emit('event.normChange.appended', { projectId: PROJECT.id, lastSeq: 13 });
    await expect.poll(listCalls).toBeGreaterThan(before);
    await rulesSettled(bive, page);
    await expect(selectedCard(page)).toHaveAttribute('data-id', 'RULE-002');
    await expect(page.getByTestId('rule-detail')).toHaveAttribute(
      'data-selected-id',
      ruleIdOf('RULE-002'),
    );
    // 사이드바로 나갔다 다시 들어오면 새로 고른 것이 없다 (링크 대상도 다시 골라지지 않는다)
    await page.getByRole('button', { name: '요구사항', exact: true }).click();
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await expect(cards(page).first()).toBeVisible();
    await rulesSettled(bive, page);
    await expect(selectedCard(page)).toHaveCount(0);
    await expect(page.getByTestId('rule-detail').getByTestId('empty-state')).toHaveText(
      '선택 항목 없음',
    );
  });

  test('링크를 누른 뒤 목록 읽기가 끝나기 전에 프로젝트가 바뀌면 새 프로젝트의 규칙 화면에서 아무 카드도 골라지지 않는다 (같은 표시 ID가 있어도)', async ({
    page,
  }) => {
    const bive = await setup(page, FIXTURE_LIST, links);
    await bive.setResponse('rule.list', { result: { rules: RULES_WITH_RETIRED }, delayMs: 1500 });
    await cardAt(page, 0).click();
    await page.getByTestId('detail-link').nth(1).click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await bive.setResponse('rule.list', { result: { rules: RULES } });
    const other = {
      ...PROJECT,
      id: '01JAAAAAAAAAAAAAAAAAAAAAAB',
      name: 'other-app',
      rootPath: '/work/other-app',
    };
    await bive.emit('project.opened', { project: other, created: false, empty: false });
    await expect(page.getByTestId('sidebar-project')).toHaveText('other-app');
    // 새 프로젝트를 열면 요구사항 화면으로 간다. 사이드바로 규칙 화면을 연다
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(cards(page).filter({ hasText: 'RULE-003' })).toHaveCount(1);
    await rulesSettled(bive, page);
    await expect(selectedCard(page)).toHaveCount(0);
    await expect(page.getByTestId('rule-detail').getByTestId('empty-state')).toHaveText(
      '선택 항목 없음',
    );
  });

  test('링크를 누른 뒤 목록 읽기 전에 다른 화면으로 갔다가 검증 화면 카드로 규칙 화면에 들어오면 링크 대상이 골라지지 않는다', async ({
    page,
  }) => {
    const bive = await setup(page, FIXTURE_LIST, {
      ...links,
      'verification.summary': { result: SUMMARY },
      'codeOpen.summary': { result: CODE_OPEN_SUMMARY },
    });
    await bive.setResponse('rule.list', { result: { rules: RULES_WITH_RETIRED }, delayMs: 1500 });
    await cardAt(page, 0).click();
    await page.getByTestId('detail-link').nth(1).click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await page.getByRole('button', { name: '검증', exact: true }).click();
    await bive.setResponse('rule.list', { result: { rules: RULES_WITH_RETIRED } });
    await page.getByTestId('metric-agent-retired').click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await expect(page.getByTestId('hidden-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(cards(page).filter({ hasText: 'RULE-003' })).toHaveCount(1);
    await rulesSettled(bive, page);
    await expect(selectedCard(page)).toHaveCount(0);
    await expect(page.getByTestId('rule-detail').getByTestId('empty-state')).toHaveText(
      '선택 항목 없음',
    );
  });

  test('없는 대상(지워진 요구사항): 검색 결과 0개, 아무 카드도 고르지 않고 상세는 "선택 항목 없음"', async ({
    page,
  }) => {
    const remaining = REQUIREMENTS.filter(({ displayId }) => displayId !== 'REQ-002');
    await setup(page, FIXTURE_LIST, {
      ...links,
      'requirement.list': { result: { requirements: remaining } },
    });
    await cardAt(page, 6).click();
    await page.getByTestId('detail-link').click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'requirements');
    await expect(page.getByTestId('list-search')).toHaveValue('REQ-002');
    // 목록에 보이는 요구사항(삭제된 것 제외) 가운데 0개
    const listed = remaining.filter(({ deletedAt }) => deletedAt === null).length;
    await expect(page.getByTestId('list-result-count')).toHaveText(`${String(listed)}개 중 0개`);
    await expect(selectedCard(page)).toHaveCount(0);
    await expect(page.getByTestId('requirement-detail').getByTestId('empty-state')).toHaveText(
      '선택 항목 없음',
    );
  });
});

test.describe('[문제만] 토글 (M3-35 #263, ADR-123: 감춤)', () => {
  test('확인할 것 목록에는 [문제만]이 없고, 다른 목록(규칙)에는 그대로 있다', async ({ page }) => {
    await setup(page, FIXTURE_LIST, { 'rule.list': { result: { rules: RULES } } });
    await expect(cards(page)).toHaveCount(SERVER_ORDER.length);
    await expect(page.getByTestId('todo-confirmation').getByTestId('problem-toggle')).toHaveCount(
      0,
    );
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await expect(page.getByTestId('problem-toggle')).toHaveCount(1);
  });
});

test.describe('상세 다시 읽기 횟수 (M3-35 #263)', () => {
  test('규범 변경 알림 한 번에 상세의 규범 변경 기록 읽기는 정확히 한 번이다 (목록 · 배지를 다시 읽어도 더 부르지 않는다)', async ({
    page,
  }) => {
    const bive = await setup(page);
    // RULE-005(미확인 규칙): 판단 대상이 그 규칙 하나다
    await cardAt(page, 5).click();
    await expect(page.getByTestId('judgment-card')).toHaveCount(2);
    const changes = async (): Promise<number> => (await callsOf(bive, 'normChange.list')).length;
    // 처음 읽기가 모두 끝난 뒤의 수에서 센다
    await allSettled(bive, 'normChange.list');
    const before = await changes();
    await bive.setResponse('normChange.list', { result: FIXTURE_CHANGE_LIST_MORE });
    // 목록 다시 읽기는 상세 읽기보다 늦게 끝나고(새 항목 객체가 상세 읽기 뒤에 들어온다) 카드 수가 바뀐다(그려진 것을 확인)
    await bive.setResponse('confirmation.list', { result: FIXTURE_LIST_AFTER_RULE4, delayMs: 300 });
    await bive.emit('event.normChange.appended', { projectId: PROJECT.id, lastSeq: 12 });
    await expect(page.getByTestId('judgment-card')).toHaveCount(3);
    await expect(cards(page)).toHaveCount(FIXTURE_LIST_AFTER_RULE4.items.length);
    await expect(detail(page)).toHaveAttribute('data-selected-id', 'RULE-005');
    // 그린 뒤의 효과가 돌고(다음 프레임) 그 사이 나간 읽기도 끝날 때까지 기다린 뒤 센다
    await nextFrame(page);
    await allSettled(bive, 'normChange.list');
    expect(await changes()).toBe(before + 1);
    expect((await callsOf(bive, 'normChange.list')).at(-1)).toEqual({
      projectId: PROJECT.id,
      targetRef: { entity: 'Rule', id: ID.rule5 },
    });
  });
});

test.describe('필터 칩 (수용 기준 4)', () => {
  test('확인 상태 · 종류 · 위험도 · 생성 주체, 값별 개수는 항목에서, 켜면 남는 카드와 결과 줄', async ({
    page,
  }) => {
    await setup(page);
    // 칩은 이 4개뿐이고 이 순서다 (옛 "처리 상태" · "제안자" 칩 없음)
    const chips = page.getByRole('group', { name: '필터' }).locator('.filter-chip');
    expect(
      await chips.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? '')),
    ).toEqual(CONFIRMATION_FILTERS.map(({ id }) => `filter-chip-${id}`));
    await expect(chips).toHaveText(CONFIRMATION_FILTERS.map(({ label }) => label));
    // 위험도: 항목에 근거가 없어 값이 없다 (0건 비활성)
    await expect(
      page.getByTestId('filter-chip-risk').getByTestId('filter-chip-button'),
    ).toBeDisabled();
    expect(await optionCounts(page, 'confirm')).toEqual({
      unconfirmed: '4',
      released: '1',
      confirmed: '2',
    });
    expect(await optionCounts(page, 'kind')).toEqual({
      retired: '1',
      superseded: '1',
      test_changed: '2',
      rule: '2',
      requirement: '1',
    });
    expect(await optionCounts(page, 'author')).toEqual({
      'rule-writer': '4',
      planner: '0',
      'test-writer': '0',
      implementer: '0',
      chat: '1',
      human: '0',
      orchestrator: '2',
    });

    await choose(page, 'confirm', 'released');
    await expect(cards(page).getByTestId('card-id')).toHaveText(['RULE-001']);
    await expect(page.getByTestId('list-result-count')).toHaveText('7개 중 1개');
    await page.getByTestId('list-reset').click();

    await choose(page, 'kind', 'test_changed');
    await expect(cards(page).getByTestId('card-id')).toHaveText(['RULE-004', 'RULE-004']);
    await page.getByTestId('list-reset').click();

    await choose(page, 'author', 'chat');
    await expect(cards(page).getByTestId('card-id')).toHaveText(['REQ-002']);
    await snapshot(page, '필터-생성주체');
  });
});

test.describe('창 폭에 따른 배치 (ADR-090 · ADR-093)', () => {
  for (const width of [820, 1100, 1280] as const) {
    test.describe(`${String(width)}×800`, () => {
      test.use({ viewport: { width, height: 800 } });

      test('목록 칸 · 상세 칸 · 판단 카드 · 긴 제목 · 긴 파일 경로가 칸 안에 있다', async ({
        page,
      }) => {
        await setup(page);
        expect(await listPaneOverflow(page.getByTestId('todo-list-pane'))).toEqual([]);

        const noHorizontalScroll = async (): Promise<void> => {
          for (const id of ['todo-detail', 'confirmation-detail']) {
            const { scroll, client } = await page
              .getByTestId(id)
              .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
            expect(scroll, `${id} 가로 스크롤`).toBeLessThanOrEqual(client);
          }
        };

        // 긴 제목 · 판단 카드
        await cardAt(page, 5).click();
        await expect(page.getByTestId('judgment-card')).toHaveCount(2);
        const widths = await paneWidths(page.getByTestId('todo-list-pane'), detail(page));
        expect(widths.list).toBeGreaterThanOrEqual(LIST_PANE_MIN);
        expect(widths.list).toBeLessThanOrEqual(LIST_PANE_MAX);
        expect(widths.detail).toBeGreaterThanOrEqual(DETAIL_PANE_MIN);
        await noHorizontalScroll();
        expect(await textClipping(detail(page), ['confirm-button'])).toEqual([]);
        expect(await hitProblems(detail(page), ['confirm-button'])).toEqual([]);
        const cardBoxes = await page
          .getByTestId('judgment-card')
          .evaluateAll((els) => els.map((el) => el.scrollWidth <= el.clientWidth));
        expect(cardBoxes).toEqual([true, true]);
        await snapshot(page, `폭-${String(width)}-판단`);

        // 긴 파일 경로
        await cardAt(page, 3).click();
        await expect(page.getByTestId('detail-file-path').first()).toHaveText(LONG_PATH);
        await noHorizontalScroll();
        const paths = await page
          .getByTestId('detail-file')
          .evaluateAll((els) => els.map((el) => el.scrollWidth <= el.clientWidth));
        expect(paths).toEqual([true, true]);
        expect(await hitProblems(detail(page), ['confirm-button'])).toEqual([]);
        await snapshot(page, `폭-${String(width)}-테스트변경`);
      });
    });
  }
});
