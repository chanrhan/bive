// SCR-06 규범 상세 · 요구사항 (이슈 #38 수용 기준, screens.md SCR-02 상세 · SCR-06 · 1.4, ADR-035 · ADR-078).
// 1) checklists/scr-06.ts의 요구사항 기본 상태(본문, 생성 주체 이름, 자식 규칙 목록)를 통과하고 변경 이력 영역이 미노출
// 2) 자식 규칙을 누르면 그 자리에서 진술, 속성, 테스트 출력이 펼쳐짐 (규칙 상세 RuleDetail 재사용)
// 3) 직접 편집 저장이 requirement.update를 1회 부르고, 삭제는 첫 클릭에서 호출 0회 · 두 번째 클릭에서 requirement.delete 1회
// 4) 이슈 #64(M3-19) 수용 기준 2: 구현 위치 = 효력 있는 자식 규칙의 대상 블록만, 중복 없이 선언 순서 (ADR-126)
// 5) 이슈 #283(M3-42): 규범 변경 알림 하나에 rule.list 한 번(화면 목록과 자식 규칙이 한 응답을 함께 씀), 블록 선언 알림 · 재접속
//    뒤 구현 위치 · 펼친 자식 규칙이 새 선언으로 "선언 외"를 판단 (ADR-135)
// 요구사항 화면(SCR-02)에서 카드를 눌러 들어온다. 데이터는 가짜 브리지의 requirement.list · rule.list · judgment.list 응답뿐이다.
import { expect, type Page, test } from '@playwright/test';

import type { Requirement, RuleWithJudgment } from '@bive/shared';

import { REQUIREMENTS } from './checklists/scr-02.js';
import {
  BLOCKS,
  FAILED_CASE,
  FAILING_HISTORY,
  FAILING_RULE,
  HISTORY,
  NO_BLOCKS,
  PARENT,
  PASSING_RULE,
  PROJECT,
  requirementDetailChecklist,
  RULES,
} from './checklists/scr-06.js';
import {
  allSettled,
  type BiveMock,
  type MockCall,
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

/** 다른 요구사항(REQ-002)의 규칙: REQ-001의 자식 규칙 목록에 보이면 안 된다 (테스트 전용 데이터). */
const OTHER_RULE: RuleWithJudgment = {
  rule: {
    ...FAILING_RULE,
    id: '01JC0000000000000000000009',
    displayId: 'RULE-009',
    title: '다른 요구사항의 규칙',
    parentRequirementId: (REQUIREMENTS[1] as Requirement).id,
  },
  judgment: { status: 'unjudged', latest: null },
};

const EDITED_TEXT = '로그인 5회 실패 시 계정 30분 잠금';
const EDITED: Requirement = {
  ...PARENT,
  text: EDITED_TEXT,
  updatedAt: '2026-10-17T00:00:00.000Z',
};
const DELETED: Requirement = {
  ...PARENT,
  updatedAt: '2026-10-17T00:00:00.000Z',
  deletedAt: '2026-10-17T00:00:00.000Z',
};

/**
 * 요구사항 화면을 열고 PARENT 카드를 고른다. `beforeSelect`는 목록이 그려진 뒤 · 카드를 고르기 전에 바꿀 응답이다(목록의 블록 칩이
 * rule.list를 먼저 한 번 읽으므로, 상세의 자식 규칙만 대기 · 실패로 두려면 그 뒤에 바꾼다, ADR-126).
 */
const openRequirement = async (
  page: Page,
  responses: MockResponses = {},
  beforeSelect: MockResponses = {},
): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'requirement.list': { result: { requirements: REQUIREMENTS } },
      'rule.list': { result: { rules: [...RULES, OTHER_RULE] } },
      'judgment.list': { result: { judgments: FAILING_HISTORY } },
      'requirement.update': { result: { requirement: EDITED } },
      'requirement.delete': { result: { requirement: DELETED } },
      'blocks.get': { result: BLOCKS },
      ...responses,
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '요구사항', exact: true }).click();
  const card = page.getByTestId('card').filter({ hasText: PARENT.displayId });
  await expect(card).toBeVisible();
  for (const [method, response] of Object.entries(beforeSelect)) {
    await bive.setResponse(method as keyof MockResponses, response as never);
  }
  await card.click();
  await expect(page.getByTestId('requirement-detail')).toHaveAttribute(
    'data-selected-id',
    PARENT.id,
  );
  return bive;
};

const callsOf = async (bive: BiveMock, method: string): Promise<MockCall[]> =>
  (await bive.calls()).filter((call) => call.method === method);

const childRule = (page: Page, displayId: string) =>
  page.getByTestId('child-rule').filter({ hasText: displayId });

const deleteButton = (page: Page) => page.getByTestId('requirement-delete');

/** 요구사항 상세 상태 검사. 스크린샷은 규칙 상세(`SCR-06/<상태>.png`)와 겹치지 않게 따로 저장한다. */
const expectRequirementDetail = async (
  page: Page,
  state: '기본' | '로딩' | '에러',
): Promise<void> => {
  await expectScreen(page, 'SCR-06', state, {
    checklist: requirementDetailChecklist,
    screenshot: false,
  });
  await page.screenshot({
    path: `${SCREENSHOT_DIR}SCR-06/요구사항-${state}.png`,
    fullPage: true,
  });
};

test.describe('체크리스트 (수용 기준 1)', () => {
  test('기본: 본문 · 생성 주체 이름 · 자식 규칙 목록 · 구현 위치, 변경 이력 미노출', async ({
    page,
  }) => {
    await openRequirement(page);
    await expectRequirementDetail(page, '기본');
    // 자식 규칙은 부모가 이 요구사항인 것만, 받은 순서(표시 ID 순)
    const rules = page.getByTestId('child-rule');
    await expect(rules).toHaveCount(RULES.length);
    for (const [index, { rule }] of RULES.entries()) {
      await expect(rules.nth(index)).toHaveAttribute('data-rule-id', rule.id);
      await expect(rules.nth(index)).toContainText(rule.displayId);
      await expect(rules.nth(index)).toContainText(rule.title);
    }
    await expect(childRule(page, OTHER_RULE.rule.displayId)).toHaveCount(0);
    // 변경 이력 영역 · 접힘이 없다 (ADR-035)
    const detail = page.getByTestId('requirement-detail');
    await expect(detail.getByTestId('collapsible')).toHaveCount(0);
    await expect(detail.getByText('변경 이력')).toHaveCount(0);
  });

  test('에이전트가 쓴 요구사항의 생성 주체는 "에이전트 · 역할명", 자식 규칙은 그 요구사항의 것만', async ({
    page,
  }) => {
    await openRequirement(page);
    const agentWritten = REQUIREMENTS[1] as Requirement;
    await page.getByTestId('card').filter({ hasText: agentWritten.displayId }).click();
    await expect(page.getByTestId('requirement-field-author')).toHaveText(
      '생성 주체에이전트 · 계획',
    );
    await expect(page.getByTestId('child-rule')).toHaveCount(1);
    await expect(page.getByTestId('child-rule')).toHaveAttribute(
      'data-rule-id',
      OTHER_RULE.rule.id,
    );
    // 자식 규칙이 없는 요구사항은 "없음"
    await page.getByTestId('card').filter({ hasText: 'REQ-003' }).click();
    await expect(page.getByTestId('requirement-rules-empty')).toHaveText('없음');
    await expect(page.getByTestId('child-rule')).toHaveCount(0);
  });

  test('로딩: 자식 규칙 자리만 비우고 나머지 상세는 보인다', async ({ page }) => {
    await openRequirement(page, {}, { 'rule.list': { pending: true } });
    await expectRequirementDetail(page, '로딩');
    await expect(page.getByTestId('requirement-rules-loading')).toHaveText('');
  });

  test('에러: 자식 규칙 자리에 "자식 규칙 불러오기 실패", 나머지 상세는 보인다', async ({
    page,
  }) => {
    await openRequirement(
      page,
      {},
      { 'rule.list': { error: { code: -32603, message: '내부 오류' } } },
    );
    await expectRequirementDetail(page, '에러');
  });

  test('카드를 고르면 그 프로젝트로 rule.list를 부르고, 상세 안에서 requirement.get은 부르지 않는다', async ({
    page,
  }) => {
    const bive = await openRequirement(page);
    await expect(page.getByTestId('child-rule')).toHaveCount(RULES.length);
    const lists = await callsOf(bive, 'rule.list');
    // 목록의 블록 칩(폐기 포함, ADR-126)과 상세의 자식 규칙(폐기 제외), 둘 다 이 프로젝트
    const params = new Set(lists.map((call) => JSON.stringify(call.params)));
    expect([...params].sort()).toEqual(
      [
        JSON.stringify({ projectId: PROJECT.id, includeRetired: true }),
        JSON.stringify({ projectId: PROJECT.id }),
      ].sort(),
    );
    await childRule(page, FAILING_RULE.displayId).getByTestId('child-rule-toggle').click();
    await expect(page.getByTestId('child-rule-detail')).toHaveCount(1);
    // 펼친 규칙의 부모는 이미 가진 요구사항이므로 다시 조회하지 않는다
    expect(await callsOf(bive, 'requirement.get')).toEqual([]);
  });
});

test.describe('자식 규칙 펼침 (수용 기준 2)', () => {
  test('자식 규칙을 누르면 그 자리에서 진술 · 속성 · 테스트 출력이 펼쳐지고, 다시 누르면 접힌다', async ({
    page,
  }) => {
    const bive = await openRequirement(page);
    await bive.setResponse('judgment.list', {
      result: { judgments: HISTORY[FAILING_RULE.id] ?? [] },
    });
    const row = childRule(page, FAILING_RULE.displayId);
    const toggle = row.getByTestId('child-rule-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // 펼침은 그 줄 안(그 자리)이고 다른 자식 규칙은 접힌 채다
    const body = row.getByTestId('child-rule-detail');
    await expect(body).toBeVisible();
    await expect(page.getByTestId('child-rule-detail')).toHaveCount(1);
    await expect(body.getByTestId('rule-detail-body')).toHaveAttribute(
      'data-rule-id',
      FAILING_RULE.id,
    );
    // 진술
    await expect(body.getByTestId('rule-field-statement')).toHaveText(
      `진술${FAILING_RULE.statement}`,
    );
    // 속성: 종류 · 검사 · 부모 요구사항 · 생성 주체
    await expect(body.getByTestId('rule-field-kind')).toHaveText('종류비즈니스');
    await expect(body.getByTestId('rule-field-checks')).toHaveText('검사인수 테스트');
    await expect(body.getByTestId('rule-field-parent')).toHaveText(
      `부모 요구사항${PARENT.displayId} · ${PARENT.text}`,
    );
    await expect(body.getByTestId('rule-field-author')).toHaveText('생성 주체에이전트 · 규칙 작성');
    // 테스트 출력: 최신 판정이 실패라 자동 펼침, 실패 원인은 실행기 출력 그대로
    const output = body.getByRole('button', { name: '테스트 출력' });
    await expect(output).toHaveAttribute('aria-expanded', 'true');
    await expect(body.getByTestId('failure-case-name')).toHaveText(FAILED_CASE.name);
    await expect(body.getByTestId('failure-case-location')).toHaveText(
      `${FAILED_CASE.file}:${FAILED_CASE.line}`,
    );
    await expect(body.getByTestId('history-row')).toHaveCount(FAILING_HISTORY.length);
    const history = await callsOf(bive, 'judgment.list');
    expect(history.at(-1)?.params).toEqual({ projectId: PROJECT.id, ruleId: FAILING_RULE.id });

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(row.getByTestId('child-rule-detail')).toHaveCount(0);
  });

  test('1280px 창: 펼친 자식 규칙의 실행 이력 줄 · 실패 원인 줄이 요구사항 상세 안에 들어오고 가로 스크롤이 없다 (#165)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const bive = await openRequirement(page);
    await bive.setResponse('judgment.list', {
      result: { judgments: HISTORY[FAILING_RULE.id] ?? [] },
    });
    const row = childRule(page, FAILING_RULE.displayId);
    await row.getByTestId('child-rule-toggle').click();
    await expect(row.getByTestId('history-row')).toHaveCount(FAILING_HISTORY.length);
    await expect(row.getByTestId('failure-case')).toBeVisible();
    const pane = page.getByTestId('requirement-detail');
    expect(await horizontalOverflow(pane, '[data-testid="history-row"]')).toEqual([]);
    expect(
      await horizontalOverflow(
        pane,
        '[data-testid="test-case"], [data-testid="failure-case"] > :not(pre)',
      ),
    ).toEqual([]);
  });

  test('통과 규칙을 펼치면 테스트 출력은 기본 접힘이고 눌러야 펼쳐진다', async ({ page }) => {
    const bive = await openRequirement(page);
    await bive.setResponse('judgment.list', {
      result: { judgments: HISTORY[PASSING_RULE.id] ?? [] },
    });
    const row = childRule(page, PASSING_RULE.displayId);
    await row.getByTestId('child-rule-toggle').click();
    const output = row.getByRole('button', { name: '테스트 출력' });
    await expect(output).toHaveAttribute('aria-expanded', 'false');
    await expect(row.getByTestId('test-case')).toBeHidden();
    await output.click();
    await expect(output).toHaveAttribute('aria-expanded', 'true');
    await expect(row.getByTestId('test-case')).toBeVisible();
    await expect(row.getByTestId('rule-field-statement')).toHaveText(
      `진술${PASSING_RULE.statement}`,
    );
  });
});

test.describe('직접 편집 (수용 기준 3)', () => {
  test('[편집] → 본문 수정 → [저장]이 requirement.update를 1회 부르고, 목록 · 상세를 다시 읽는다', async ({
    page,
  }) => {
    const bive = await openRequirement(page);
    await expect(page.getByTestId('child-rule')).toHaveCount(RULES.length);
    const listsBefore = (await callsOf(bive, 'requirement.list')).length;
    const rulesBefore = (await callsOf(bive, 'rule.list')).length;
    // 다시 읽는 목록은 바뀐 본문을 돌려준다
    await bive.setResponse('requirement.list', {
      result: { requirements: REQUIREMENTS.map((r) => (r.id === PARENT.id ? EDITED : r)) },
    });

    await page.getByTestId('requirement-edit').click();
    const input = page.getByRole('textbox', { name: '요구사항 본문 편집' });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(PARENT.text);
    // 바뀌지 않은 본문은 저장할 수 없다
    await expect(page.getByTestId('requirement-save')).toBeDisabled();
    await input.fill(EDITED_TEXT);
    await page.getByTestId('requirement-save').click();

    await expect(page.getByTestId('requirement-editor')).toHaveCount(0);
    await expect(page.getByTestId('requirement-field-text')).toHaveText(`본문${EDITED_TEXT}`);
    expect(await callsOf(bive, 'requirement.update')).toEqual([
      {
        method: 'requirement.update',
        params: {
          projectId: PROJECT.id,
          id: PARENT.id,
          text: EDITED_TEXT,
          author: { kind: 'human' },
        },
      },
    ]);
    // 목록(카드 문장)과 상세(자식 규칙)를 다시 읽는다
    await expect
      .poll(async () => (await callsOf(bive, 'requirement.list')).length)
      .toBe(listsBefore + 1);
    await expect.poll(async () => (await callsOf(bive, 'rule.list')).length).toBe(rulesBefore + 1);
    await expect(page.getByTestId('card').filter({ hasText: PARENT.displayId })).toContainText(
      EDITED_TEXT,
    );
    expect(await callsOf(bive, 'requirement.delete')).toEqual([]);
  });

  test('저장 중 [저장] 연속 클릭 · Ctrl+Enter는 호출을 하나만 만든다', async ({ page }) => {
    const bive = await openRequirement(page, {
      'requirement.update': { result: { requirement: EDITED }, delayMs: 500 },
    });
    await page.getByTestId('requirement-edit').click();
    const input = page.getByTestId('requirement-edit-input');
    await input.fill(EDITED_TEXT);
    // 같은 틱에 두 번 누른다 (버튼이 비활성화되기 전)
    await page.getByTestId('requirement-save').evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(page.getByTestId('requirement-save')).toBeDisabled();
    await expect(input).toHaveAttribute('aria-busy', 'true');
    await input.press('Control+Enter');
    await expect(page.getByTestId('requirement-editor')).toHaveCount(0);
    expect(await callsOf(bive, 'requirement.update')).toHaveLength(1);
  });

  test('Ctrl+Enter로 저장, [취소] · Esc는 호출 없이 닫고 공백만 있는 본문은 저장하지 않는다', async ({
    page,
  }) => {
    const bive = await openRequirement(page);
    const edit = page.getByTestId('requirement-edit');
    const input = page.getByTestId('requirement-edit-input');

    await edit.click();
    await input.fill('   ');
    await expect(page.getByTestId('requirement-save')).toBeDisabled();
    await input.press('Control+Enter');
    await expect(page.getByTestId('requirement-editor')).toBeVisible();
    await page.getByTestId('requirement-cancel').click();
    await expect(page.getByTestId('requirement-editor')).toHaveCount(0);
    await expect(page.getByTestId('requirement-field-text')).toHaveText(`본문${PARENT.text}`);

    await edit.click();
    await input.fill(EDITED_TEXT);
    await input.press('Escape');
    await expect(page.getByTestId('requirement-editor')).toHaveCount(0);
    expect(await callsOf(bive, 'requirement.update')).toEqual([]);

    await edit.click();
    // 다시 열면 지금 본문에서 시작한다
    await expect(input).toHaveValue(PARENT.text);
    await input.fill(EDITED_TEXT);
    await input.press('Control+Enter');
    await expect(page.getByTestId('requirement-editor')).toHaveCount(0);
    expect(await callsOf(bive, 'requirement.update')).toHaveLength(1);
  });

  test('저장이 거부되면 입력을 남긴 채 "요구사항 저장 실패"이고 목록은 다시 읽지 않는다', async ({
    page,
  }) => {
    const bive = await openRequirement(page, {
      'requirement.update': { error: { code: -32009, message: '삭제된 요구사항' } },
    });
    const listsBefore = (await callsOf(bive, 'requirement.list')).length;
    await page.getByTestId('requirement-edit').click();
    const input = page.getByTestId('requirement-edit-input');
    await input.fill(EDITED_TEXT);
    await page.getByTestId('requirement-save').click();
    await expect(page.getByTestId('requirement-action-error')).toHaveText('요구사항 저장 실패');
    await expect(page.getByRole('alert').filter({ hasText: '요구사항 저장 실패' })).toBeVisible();
    await expect(input).toHaveValue(EDITED_TEXT);
    await expect(page.getByTestId('requirement-save')).toBeEnabled();
    expect(await callsOf(bive, 'requirement.update')).toHaveLength(1);
    expect(await callsOf(bive, 'requirement.list')).toHaveLength(listsBefore);
    // 고쳐 쓰면 실패 문구가 사라진다
    await input.fill(`${EDITED_TEXT} `);
    await expect(page.getByTestId('requirement-action-error')).toHaveCount(0);
  });
});

test.describe('[규칙화 불가] (#56 M3-11 수용 기준 2, NRM-08 · ADR-137)', () => {
  /** 규칙 없는 요구사항 = REQ-002 (서버가 정한 추적성 결함, 테스트 전용 데이터). 자식 규칙은 없다. */
  const BARE = REQUIREMENTS[1] as Requirement;
  const UNRULABLE = REQUIREMENTS[2] as Requirement;
  const traceability = {
    requirementsWithoutRules: [{ id: BARE.id, displayId: BARE.displayId }],
    parentlessRules: [],
  };
  const REASON = '측정 기준 없음 · 체감 속도';
  const MARKED: Requirement = {
    ...BARE,
    unrulable: { reason: REASON },
    updatedAt: '2026-10-17T00:00:00.000Z',
    updatedBy: { kind: 'human' },
    confirmation: {
      state: 'confirmed',
      at: '2026-10-17T00:00:00.000Z',
      by: { kind: 'human' },
      basis: { kind: 'requirement_record', at: '2026-10-17T00:00:00.000Z' },
    },
  };

  /** 요구사항 화면을 열고 그 표시 ID의 카드를 고른다 (규칙 목록에는 PARENT의 자식 규칙만, 추적성 결함은 REQ-002). */
  const openOne = async (
    page: Page,
    requirement: Requirement,
    responses: MockResponses = {},
  ): Promise<BiveMock> => {
    const bive = await mockBive(page, {
      responses: {
        'system.status': { result: STATUS },
        'project.current': { result: { project: PROJECT } },
        'requirement.list': { result: { requirements: REQUIREMENTS } },
        'rule.list': { result: { rules: RULES, traceability } },
        'judgment.list': { result: { judgments: [] } },
        'requirement.markUnrulable': { result: { requirement: MARKED } },
        'blocks.get': { result: BLOCKS },
        ...responses,
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: '요구사항', exact: true }).click();
    await page.getByTestId('card').filter({ hasText: requirement.displayId }).click();
    await expect(page.getByTestId('requirement-detail')).toHaveAttribute(
      'data-selected-id',
      requirement.id,
    );
    return bive;
  };
  const markButton = (page: Page) => page.getByTestId('requirement-unrulable');
  const reasonInput = (page: Page) => page.getByTestId('requirement-unrulable-input');
  const confirmButton = (page: Page) => page.getByTestId('requirement-unrulable-confirm');

  test('[규칙화 불가]는 서버가 규칙 없는 요구사항으로 정한 것에만 있다 (규칙 있는 요구사항 · 이미 규칙화 불가인 요구사항에는 없음)', async ({
    page,
  }) => {
    await openOne(page, BARE);
    await expect(markButton(page)).toHaveText('규칙화 불가');
    await page.getByTestId('card').filter({ hasText: PARENT.displayId }).click();
    await expect(page.getByTestId('requirement-detail')).toHaveAttribute(
      'data-selected-id',
      PARENT.id,
    );
    await expect(page.getByTestId('requirement-edit')).toBeVisible();
    await expect(markButton(page)).toHaveCount(0);
    await page.getByTestId('card').filter({ hasText: UNRULABLE.displayId }).click();
    await expect(page.getByTestId('requirement-edit')).toBeVisible();
    await expect(markButton(page)).toHaveCount(0);
    // 이미 규칙화 불가: 상세에 "규칙화 불가" 줄과 사유
    await expect(page.getByTestId('requirement-field-unrulable')).toContainText('규칙화 불가');
    await expect(page.getByTestId('requirement-unrulable-reason')).toHaveText('측정 기준 없음');
  });

  test('누르면 사유 입력이 열리고, 빈 사유(공백만)면 [확인]이 꺼져 Ctrl+Enter로도 보내지 않는다. 사유를 쓰면 [확인] 1회가 requirement.markUnrulable(사람, 사유 원문)을 부르고 상세 · 카드에 규칙화 불가와 사유가 보인다', async ({
    page,
  }) => {
    const bive = await openOne(page, BARE);
    await expect(
      page.getByTestId('card').filter({ hasText: BARE.displayId }).getByTestId('card-exception'),
    ).toHaveText(['추적성 결함', '미확인']);
    await markButton(page).click();
    await expect(reasonInput(page)).toBeFocused();
    await expect(reasonInput(page)).toHaveAccessibleName('규칙화 불가 사유');
    // 편집 · 삭제 버튼은 입력 중 숨는다 (본문 편집과 같은 틀)
    await expect(page.getByTestId('requirement-edit')).toHaveCount(0);
    await expect(confirmButton(page)).toBeDisabled();
    for (const blank of ['   ', '　\t', '\n']) {
      await reasonInput(page).fill(blank);
      await expect(confirmButton(page)).toBeDisabled();
      await reasonInput(page).press('Control+Enter');
    }
    expect(await callsOf(bive, 'requirement.markUnrulable')).toHaveLength(0);

    await reasonInput(page).fill(REASON);
    await expect(confirmButton(page)).toBeEnabled();
    await bive.setResponse('requirement.list', {
      result: { requirements: REQUIREMENTS.map((item) => (item.id === BARE.id ? MARKED : item)) },
    });
    await confirmButton(page).click();
    await expect(page.getByTestId('requirement-unrulable-reason')).toHaveText(REASON);
    expect(await callsOf(bive, 'requirement.markUnrulable')).toEqual([
      {
        method: 'requirement.markUnrulable',
        params: { projectId: PROJECT.id, id: BARE.id, reason: REASON, author: { kind: 'human' } },
      },
    ]);
    await expect(reasonInput(page)).toHaveCount(0);
    await expect(markButton(page)).toHaveCount(0);
    // 카드: 규칙화 불가만(아직 다시 읽지 않은 규칙 목록의 결함 표시는 앞서지 못한다), 확인됨이라 미확인 없음
    await expect(
      page.getByTestId('card').filter({ hasText: BARE.displayId }).getByTestId('card-exception'),
    ).toHaveText(['규칙화 불가']);
    await expect(page.getByTestId('requirement-action-error')).toHaveCount(0);
  });

  test('[취소] · Esc는 호출 없이 닫는다', async ({ page }) => {
    const bive = await openOne(page, BARE);
    await markButton(page).click();
    await reasonInput(page).fill(REASON);
    await page.getByTestId('requirement-unrulable-cancel').click();
    await expect(reasonInput(page)).toHaveCount(0);
    await markButton(page).click();
    await expect(reasonInput(page)).toHaveValue('');
    await reasonInput(page).fill(REASON);
    await reasonInput(page).press('Escape');
    await expect(reasonInput(page)).toHaveCount(0);
    await expect(markButton(page)).toBeVisible();
    expect(await callsOf(bive, 'requirement.markUnrulable')).toHaveLength(0);
  });

  test('표시 중 [확인] 연속 클릭(같은 틱) · Ctrl+Enter 두 번은 requirement.markUnrulable을 한 번만 부르고, 응답 뒤 실패 문구가 없다', async ({
    page,
  }) => {
    const bive = await openOne(page, BARE, {
      'requirement.markUnrulable': { result: { requirement: MARKED }, delayMs: 500 },
    });
    await markButton(page).click();
    await reasonInput(page).fill(REASON);
    await bive.setResponse('requirement.list', {
      result: { requirements: REQUIREMENTS.map((item) => (item.id === BARE.id ? MARKED : item)) },
    });
    // 같은 틱에 두 번 누른다 (버튼이 비활성화되기 전)
    await confirmButton(page).evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(confirmButton(page)).toBeDisabled();
    await expect(reasonInput(page)).toHaveAttribute('aria-busy', 'true');
    await reasonInput(page).press('Control+Enter');
    await reasonInput(page).press('Control+Enter');
    await expect(page.getByTestId('requirement-unrulable-reason')).toHaveText(REASON);
    await allSettled(bive, 'requirement.markUnrulable');
    expect(await callsOf(bive, 'requirement.markUnrulable')).toHaveLength(1);
    await expect(page.getByTestId('requirement-action-error')).toHaveCount(0);
  });

  test('거부되면 입력을 남긴 채 "규칙화 불가 표시 실패"이고 목록은 다시 읽지 않는다', async ({
    page,
  }) => {
    const bive = await openOne(page, BARE, {
      'requirement.markUnrulable': {
        error: { code: -32009, message: '충돌', data: { reason: 'has_rules' } },
      },
    });
    await allSettled(bive, 'requirement.list');
    const listsBefore = (await callsOf(bive, 'requirement.list')).length;
    await markButton(page).click();
    await reasonInput(page).fill(REASON);
    await reasonInput(page).press('Control+Enter');
    await expect(page.getByTestId('requirement-action-error')).toHaveText('규칙화 불가 표시 실패');
    await expect(
      page.getByRole('alert').filter({ hasText: '규칙화 불가 표시 실패' }),
    ).toBeVisible();
    await expect(reasonInput(page)).toHaveValue(REASON);
    await expect(confirmButton(page)).toBeEnabled();
    expect(await callsOf(bive, 'requirement.markUnrulable')).toHaveLength(1);
    expect(await callsOf(bive, 'requirement.list')).toHaveLength(listsBefore);
  });

  test('사유의 숨은 글자는 보이는 표기로 그린다 (U+202E)', async ({ page }) => {
    const hidden = { ...UNRULABLE, unrulable: { reason: '측정\u202e기준 없음' } };
    await openOne(page, hidden, {
      'requirement.list': {
        result: {
          requirements: REQUIREMENTS.map((item) => (item.id === UNRULABLE.id ? hidden : item)),
        },
      },
    });
    await expect(page.getByTestId('requirement-unrulable-reason')).toHaveText(
      '측정\\u202e기준 없음',
    );
  });
});

test.describe('1280×800 창의 버튼 문구 (#175)', () => {
  // 기본 창: 사이드바 · 목록 · 오른쪽 채팅(360px 고정)을 빼면 상세 폭이 가장 좁다
  test.use({ viewport: { width: 1280, height: 800 } });

  /** 요구사항 상세에 가로 스크롤이 없고, 받은 요소가 한 줄 · 잘림 없음 · 상세 안. */
  const expectOneLine = async (page: Page, testIds: readonly string[]): Promise<void> => {
    const pane = page.getByTestId('requirement-detail');
    const { scroll, client } = await pane.evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
    }));
    expect(scroll, '요구사항 상세 가로 스크롤').toBeLessThanOrEqual(client);
    expect(await textClipping(pane, testIds)).toEqual([]);
  };

  test('[편집] · [삭제] · [삭제 확인], 편집 줄의 [취소] · [저장](저장 거부 문구와 함께)이 한 줄로 잘리지 않고 상세 안에 있다', async ({
    page,
  }) => {
    await openRequirement(page, {
      'requirement.update': { error: { code: -32009, message: '삭제된 요구사항' } },
    });
    await expectOneLine(page, ['requirement-edit', 'requirement-delete']);
    await deleteButton(page).click();
    await expect(deleteButton(page)).toHaveText('삭제 확인');
    await expectOneLine(page, ['requirement-edit', 'requirement-delete']);
    await page.keyboard.press('Escape');

    await page.getByTestId('requirement-edit').click();
    await page.getByTestId('requirement-edit-input').fill(EDITED_TEXT);
    await expectOneLine(page, ['requirement-cancel', 'requirement-save']);
    // 편집 줄의 [취소] · [저장]은 한 묶음으로 같은 줄 (#191)
    expect(
      await sameRow(page.getByTestId('requirement-detail'), [
        'requirement-cancel',
        'requirement-save',
      ]),
    ).toEqual([]);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}SCR-06/요구사항-1280-편집.png`,
      fullPage: true,
    });

    // 저장 거부: 오류 문구와 입력 · 버튼이 함께 보이는 상태
    await page.getByTestId('requirement-save').click();
    await expect(page.getByTestId('requirement-action-error')).toHaveText('요구사항 저장 실패');
    await expectOneLine(page, [
      'requirement-action-error',
      'requirement-cancel',
      'requirement-save',
    ]);
    await page.screenshot({
      path: `${SCREENSHOT_DIR}SCR-06/요구사항-1280-저장-실패.png`,
      fullPage: true,
    });
  });
});

test.describe('좁은 창의 목록 · 상세 배치 (#179, ADR-090)', () => {
  const listPane = (page: Page) => page.getByTestId('requirements-list-pane');
  const detailPane = (page: Page) => page.getByTestId('requirement-detail');
  // 2줄째가 가장 긴 요구사항 카드 (테스트 전용 데이터): 4자리 ID · 예외 2개(규칙화 불가 · 미확인) · 시각
  const MANY: Requirement = {
    ...PARENT,
    id: '01JB0000000000000000001234',
    displayId: 'REQ-1234',
    text: '모든 화면은 사용자가 체감하기에 빠르게 전환될 것',
    unrulable: { reason: '측정 기준 없음' },
    confirmation: { state: 'unconfirmed' },
  };

  /** 상세에 가로 스크롤이 없고, 받은 버튼이 한 줄 · 잘림 없음 · 상세 안이며, 가운데를 누르면 그 버튼에 닿는다. */
  const expectDetailLayout = async (page: Page, testIds: readonly string[]): Promise<void> => {
    const pane = detailPane(page);
    const { scroll, client } = await pane.evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
    }));
    expect(scroll, '요구사항 상세 가로 스크롤').toBeLessThanOrEqual(client);
    expect(await textClipping(pane, testIds)).toEqual([]);
    expect(await hitProblems(pane, testIds)).toEqual([]);
  };

  for (const width of NARROW_WIDTHS) {
    test(`${width}×800: 상세 칸은 최소 폭 이상이고 목록 칸은 넘치지 않는다, [편집] · [삭제] · 편집 줄 버튼은 상세 안에서 눌리고 단축키 안내는 낱말 중간에서 끊기지 않는다`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      const bive = await openRequirement(page, {
        'requirement.list': { result: { requirements: [...REQUIREMENTS, MANY] } },
        'requirement.update': { error: { code: -32009, message: '삭제된 요구사항' } },
      });
      await expect(
        page.locator('[data-testid="card"][data-id="REQ-1234"] [data-testid="card-exception"]'),
      ).toHaveText(['규칙화 불가', '미확인']);

      const widths = await paneWidths(listPane(page), detailPane(page));
      expect(widths.list).toBeGreaterThanOrEqual(LIST_PANE_MIN);
      expect(widths.list).toBeLessThanOrEqual(LIST_PANE_MAX);
      expect(widths.detail).toBeGreaterThanOrEqual(DETAIL_PANE_MIN);
      expect(await listPaneOverflow(listPane(page))).toEqual([]);
      await expectDetailLayout(page, ['requirement-edit', 'requirement-delete']);

      // 펼친 자식 규칙의 실행 이력 줄 · 실패 원인 줄도 상세 안
      await bive.setResponse('judgment.list', {
        result: { judgments: HISTORY[FAILING_RULE.id] ?? [] },
      });
      const row = childRule(page, FAILING_RULE.displayId);
      await row.getByTestId('child-rule-toggle').click();
      await expect(row.getByTestId('history-row')).toHaveCount(FAILING_HISTORY.length);
      expect(await horizontalOverflow(detailPane(page), '[data-testid="history-row"]')).toEqual([]);
      await row.getByTestId('child-rule-toggle').click();

      // 편집 줄: [취소] · [저장], 단축키 안내
      await page.getByTestId('requirement-edit').click();
      await page.getByTestId('requirement-edit-input').fill(EDITED_TEXT);
      await expectDetailLayout(page, ['requirement-cancel', 'requirement-save']);
      expect(await brokenWords(page.getByTestId('requirement-editor-hint'))).toEqual([]);
      await page.screenshot({
        path: `${SCREENSHOT_DIR}SCR-06/요구사항-좁은-${width}-편집.png`,
        fullPage: true,
      });

      // 저장 거부 문구와 함께
      await page.getByTestId('requirement-save').click();
      await expect(page.getByTestId('requirement-action-error')).toHaveText('요구사항 저장 실패');
      await expectDetailLayout(page, ['requirement-cancel', 'requirement-save']);
    });
  }

  test(`${WIDE_WIDTH}px 창: 목록 칸은 ${LIST_PANE_MAX}px 그대로다`, async ({ page }) => {
    await page.setViewportSize({ width: WIDE_WIDTH, height: 900 });
    await openRequirement(page);
    const widths = await paneWidths(listPane(page), detailPane(page));
    expect(widths.list).toBe(LIST_PANE_MAX);
    expect(widths.detail).toBe(WIDE_WIDTH - 232 - 360 - LIST_PANE_MAX);
  });
});

test.describe('삭제 (수용 기준 3)', () => {
  test('첫 클릭은 호출 0회로 [삭제 확인]이 되고, 두 번째 클릭에서 requirement.delete 1회 → 목록에서 빠진다', async ({
    page,
  }) => {
    const bive = await openRequirement(page);
    const listsBefore = (await callsOf(bive, 'requirement.list')).length;
    await bive.setResponse('requirement.list', {
      result: { requirements: REQUIREMENTS.map((r) => (r.id === PARENT.id ? DELETED : r)) },
    });

    await deleteButton(page).click();
    await expect(deleteButton(page)).toHaveText('삭제 확인');
    await expect(deleteButton(page)).toHaveAttribute('data-armed', 'true');
    expect(await callsOf(bive, 'requirement.delete')).toEqual([]);

    await deleteButton(page).click();
    // 삭제된 요구사항은 목록에서 빠지고 상세는 "선택 항목 없음"
    await expect(page.getByTestId('requirement-detail')).toHaveAttribute('data-selected-id', '');
    await expect(page.getByTestId('requirement-detail')).toContainText('선택 항목 없음');
    await expect(page.getByTestId('card').filter({ hasText: PARENT.displayId })).toHaveCount(0);
    expect(await callsOf(bive, 'requirement.delete')).toEqual([
      {
        method: 'requirement.delete',
        params: { projectId: PROJECT.id, id: PARENT.id, author: { kind: 'human' } },
      },
    ]);
    await expect
      .poll(async () => (await callsOf(bive, 'requirement.list')).length)
      .toBe(listsBefore + 1);
    expect(await callsOf(bive, 'requirement.update')).toEqual([]);
  });

  test('확인 대기 중 다른 곳을 누르면 풀리고, 다음 클릭은 다시 첫 클릭이다', async ({ page }) => {
    const bive = await openRequirement(page);
    await deleteButton(page).click();
    await expect(deleteButton(page)).toHaveText('삭제 확인');
    await page.getByTestId('requirement-field-text').click();
    await expect(deleteButton(page)).toHaveText('삭제');
    await deleteButton(page).click();
    await expect(deleteButton(page)).toHaveText('삭제 확인');
    // Esc도 확인 대기를 푼다
    await deleteButton(page).press('Escape');
    await expect(deleteButton(page)).toHaveText('삭제');
    // 다른 요구사항을 고르면 새로 시작한다
    await deleteButton(page).click();
    await page.getByTestId('card').filter({ hasText: 'REQ-003' }).click();
    await expect(deleteButton(page)).toHaveText('삭제');
    expect(await callsOf(bive, 'requirement.delete')).toEqual([]);
  });

  test('삭제 중 연속 클릭은 호출을 하나만 만든다', async ({ page }) => {
    const bive = await openRequirement(page, {
      'requirement.delete': { result: { requirement: DELETED }, delayMs: 500 },
    });
    await bive.setResponse('requirement.list', {
      result: { requirements: REQUIREMENTS.map((r) => (r.id === PARENT.id ? DELETED : r)) },
    });
    await deleteButton(page).click();
    await expect(deleteButton(page)).toHaveText('삭제 확인');
    await deleteButton(page).evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
      button.click();
    });
    await expect(deleteButton(page)).toBeDisabled();
    await expect(deleteButton(page)).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('requirement-detail')).toHaveAttribute('data-selected-id', '');
    expect(await callsOf(bive, 'requirement.delete')).toHaveLength(1);
  });

  test('삭제가 거부되면 "요구사항 삭제 실패"이고 항목은 남으며 다시 첫 클릭부터다', async ({
    page,
  }) => {
    const bive = await openRequirement(page, {
      'requirement.delete': { error: { code: -32009, message: '이미 삭제됨' } },
    });
    await deleteButton(page).click();
    await deleteButton(page).click();
    await expect(page.getByTestId('requirement-action-error')).toHaveText('요구사항 삭제 실패');
    await expect(deleteButton(page)).toHaveText('삭제');
    await expect(deleteButton(page)).toBeEnabled();
    await expect(page.getByTestId('requirement-detail')).toHaveAttribute(
      'data-selected-id',
      PARENT.id,
    );
    expect(await callsOf(bive, 'requirement.delete')).toHaveLength(1);
    // 다시 누르면 확인 대기부터이고 실패 문구는 사라진다
    await deleteButton(page).click();
    await expect(deleteButton(page)).toHaveText('삭제 확인');
    await expect(page.getByTestId('requirement-action-error')).toHaveCount(0);
    expect(await callsOf(bive, 'requirement.delete')).toHaveLength(1);
  });
});

test.describe('화면 문구', () => {
  test('상세(편집 입력 · 삭제 확인 · 펼친 자식 규칙)에 금지 문구가 없다', async ({ page }) => {
    await openRequirement(page);
    await childRule(page, FAILING_RULE.displayId).getByTestId('child-rule-toggle').click();
    await expect(page.getByTestId('history-row')).toHaveCount(FAILING_HISTORY.length);
    await deleteButton(page).click();
    await page.getByTestId('requirement-edit').click();
    const texts = await collectVisibleText(page);
    expect(findForbiddenText(texts)).toEqual([]);
    const stage = texts.filter(({ text }) => /\bM\d\b|준비 중|로딩|Loading/i.test(text));
    expect(stage).toEqual([]);
  });
});

test.describe('펼친 자식 규칙의 직접 편집 (#215 수용 기준 3, ADR-109)', () => {
  test('자식 규칙 상세의 [편집] 저장은 rule.update 1회이고, 자식 규칙 줄 · 펼친 상세에 새 제목 · 확인됨이 보인다 (자식 규칙 목록을 다시 읽지 않아도 옛 제목이 남지 않음)', async ({
    page,
  }) => {
    const newTitle = '결제 취소 기한 초과 거절';
    const failing = RULES.find((item) => item.rule.id === FAILING_RULE.id);
    if (failing === undefined) throw new Error('실패 규칙 없음');
    const at = '2026-10-17T01:00:00.000Z';
    const bive = await openRequirement(page, {
      'rule.update': {
        result: {
          rule: {
            ...FAILING_RULE,
            title: newTitle,
            updatedAt: at,
            confirmation: {
              state: 'confirmed',
              at,
              by: { kind: 'human' },
              basis: { kind: 'approval_log', seq: 3 },
            },
          },
          judgment: failing.judgment,
          approvalLog: {
            seq: 3,
            at,
            action: 'rule_edit',
            actor: { kind: 'human' },
            targetRef: { entity: 'Rule', id: FAILING_RULE.id },
            clientId: 'pipe-1',
            detail: {
              diff: {
                before: { title: FAILING_RULE.title, statement: FAILING_RULE.statement },
                after: { title: newTitle, statement: FAILING_RULE.statement },
              },
            },
            prevHash: '0'.repeat(64),
            hash: 'b'.repeat(64),
          },
          autoStart: null,
        },
      },
    });
    const row = childRule(page, FAILING_RULE.displayId);
    await row.getByTestId('child-rule-toggle').click();
    const opened = row.getByTestId('child-rule-detail');
    await opened.getByTestId('rule-edit').click();
    await opened.getByTestId('rule-edit-title').fill(newTitle);
    const listCalls = (await callsOf(bive, 'rule.list')).length;
    await opened.getByTestId('rule-edit-save').click();
    await expect(opened.getByTestId('rule-editor')).toHaveCount(0);
    expect((await callsOf(bive, 'rule.update')).map((call) => call.params)).toEqual([
      {
        projectId: PROJECT.id,
        id: FAILING_RULE.id,
        author: { kind: 'human' },
        title: newTitle,
        expectedUpdatedAt: FAILING_RULE.updatedAt,
      },
    ]);
    // 자식 규칙 줄의 제목이 새 제목이고 옛 제목은 어디에도 없다
    await expect(row.getByTestId('child-rule-toggle')).toContainText(newTitle);
    await expect(page.getByTestId('requirement-rules')).not.toContainText(FAILING_RULE.title);
    await expect(opened.getByTestId('rule-detail-title')).toHaveText(newTitle);
    await expect(opened.getByTestId('rule-field-confirmation')).toHaveText('확인 상태확인됨');
    // 펼침 상태는 그대로이고 다른 자식 규칙 줄은 바뀌지 않는다
    await expect(row.getByTestId('child-rule-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(childRule(page, PASSING_RULE.displayId)).toContainText(PASSING_RULE.title);
    expect(await callsOf(bive, 'rule.list')).toHaveLength(listCalls);
  });
});

test.describe('구현 위치 (#64 수용 기준 2, SCR-02 상세, ADR-126)', () => {
  const implementation = (page: Page) => page.getByTestId('requirement-implementation');
  const names = (page: Page) => implementation(page).getByTestId('block-name');
  /** 폐기된 자식 규칙 · 잠정 자식 규칙 (효력 없음, 테스트 전용 데이터): 그 블록은 구현 위치에 들지 않는다 */
  const RETIRED_CHILD: RuleWithJudgment = {
    rule: {
      ...FAILING_RULE,
      id: '01JC0000000000000000000010',
      displayId: 'RULE-010',
      title: '폐기된 자식 규칙',
      targetBlockIds: ['retired-only', 'auth'],
    },
    judgment: { status: 'unjudged', latest: null },
    retirement: { retiredAt: '2026-10-16T00:00:00.000Z', supersededBy: null, normChangeSeq: 2 },
  };
  const PROVISIONAL_CHILD: RuleWithJudgment = {
    rule: {
      ...FAILING_RULE,
      id: '01JC0000000000000000000011',
      displayId: 'RULE-011',
      title: '잠정 자식 규칙',
      normState: 'provisional',
      targetBlockIds: ['provisional-only'],
    },
    judgment: { status: 'unjudged', latest: null },
  };
  const WITH_INEFFECTIVE = [...RULES, RETIRED_CHILD, PROVISIONAL_CHILD, OTHER_RULE];

  test('효력 있는 자식 규칙의 대상 블록만, 중복 없이 지금 선언 순서(선언에 없는 이름은 뒤, "선언 외"). 다른 요구사항 · 폐기 · 잠정 규칙의 블록은 없다', async ({
    page,
  }) => {
    const bive = await openRequirement(page, {
      'rule.list': { result: { rules: WITH_INEFFECTIVE } },
    });
    // 자식 규칙: RULE-001 auth, RULE-002 lib · auth · legacy-mail, RULE-003 없음. 선언 순서 health · auth · lib
    await expect(names(page)).toHaveText(['auth', 'lib', 'legacy-mail']);
    await expect(implementation(page).getByTestId('block-item')).toHaveText([
      'auth',
      'lib',
      'legacy-mail선언 외',
    ]);
    await expect(implementation(page).getByTestId('block-note')).toHaveCount(0);
    // 구역 순서: 자식 규칙 다음
    const sections = await page
      .getByTestId('requirement-detail')
      .locator('section')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
    expect(sections.slice(0, 2)).toEqual(['requirement-rules', 'requirement-implementation']);
    // 펼친 자식 규칙 상세는 읽은 선언을 받아 blocks.get을 다시 부르지 않는다
    await allSettled(bive, 'blocks.get');
    const before = await callsOf(bive, 'blocks.get');
    expect(before.length).toBeGreaterThan(0);
    for (const call of before) expect(call.params).toEqual({ projectId: PROJECT.id });
    await childRule(page, FAILING_RULE.displayId).getByTestId('child-rule-toggle').click();
    await expect(
      page
        .getByTestId('child-rule-detail')
        .getByTestId('rule-field-blocks')
        .getByTestId('block-undeclared'),
    ).toHaveText('선언 외');
    await nextFrame(page);
    expect(await callsOf(bive, 'blocks.get')).toHaveLength(before.length);
  });

  test('선언이 없으면 이름 순이고 "블록 선언 없음" 한 번', async ({ page }) => {
    await openRequirement(page, { 'blocks.get': { result: NO_BLOCKS } });
    await expect(names(page)).toHaveText(['auth', 'legacy-mail', 'lib']);
    await expect(implementation(page).getByTestId('block-note')).toHaveText('블록 선언 없음');
    await expect(implementation(page).getByTestId('block-undeclared')).toHaveCount(0);
  });

  test('자식 규칙이 없거나 블록이 하나도 없으면 "없음"', async ({ page }) => {
    await openRequirement(page);
    // REQ-003: 자식 규칙 없음
    await page.getByTestId('card').filter({ hasText: 'REQ-003' }).click();
    await expect(page.getByTestId('requirement-blocks-none')).toHaveText('없음');
    await expect(names(page)).toHaveCount(0);
  });

  test('효력 있는 자식 규칙에 블록이 없으면(옛 규칙 · 폐기 규칙만 블록을 가짐) "없음"', async ({
    page,
  }) => {
    const old = RULES.map((item) => ({ ...item, rule: { ...item.rule, targetBlockIds: [] } }));
    await openRequirement(page, { 'rule.list': { result: { rules: [...old, RETIRED_CHILD] } } });
    await expect(page.getByTestId('requirement-blocks-none')).toHaveText('없음');
  });
});

test.describe('다시 읽기 다듬기 (#283 M3-42, SCR-02 상세 · NRM-09, ADR-135)', () => {
  const appended = (lastSeq: number) => ({ projectId: PROJECT.id, lastSeq });
  const OTHER_PROJECT_ID = '01JA00000000000000000000FF';
  const names = (page: Page) => page.getByTestId('child-rule').getByTestId('child-rule-toggle');
  const implementation = (page: Page) =>
    page.getByTestId('requirement-implementation').getByTestId('block-item');
  /** 알림 뒤 새로 생긴 자식 규칙(대상 블록 health) · 폐기된 자식 규칙 (테스트 전용 데이터) */
  const ADDED_CHILD: RuleWithJudgment = {
    rule: {
      ...PASSING_RULE,
      id: '01JC0000000000000000000012',
      displayId: 'RULE-012',
      title: '알림 뒤 생긴 자식 규칙',
      targetBlockIds: ['health'],
    },
    judgment: { status: 'unjudged', latest: null },
  };
  const RETIRED_CHILD: RuleWithJudgment = {
    rule: {
      ...FAILING_RULE,
      id: '01JC0000000000000000000013',
      displayId: 'RULE-013',
      title: '폐기된 자식 규칙',
      targetBlockIds: ['retired-only'],
    },
    judgment: { status: 'unjudged', latest: null },
    retirement: { retiredAt: '2026-10-16T00:00:00.000Z', supersededBy: null, normChangeSeq: 2 },
  };
  const AFTER = [...RULES, ADDED_CHILD, RETIRED_CHILD, OTHER_RULE];

  /** 요구사항 화면만 연다(상세 닫힘). */
  const openScreen = async (page: Page, responses: MockResponses = {}): Promise<BiveMock> => {
    const bive = await mockBive(page, {
      responses: {
        'system.status': { result: STATUS },
        'project.current': { result: { project: PROJECT } },
        'requirement.list': { result: { requirements: REQUIREMENTS } },
        'rule.list': { result: { rules: [...RULES, OTHER_RULE] } },
        'judgment.list': { result: { judgments: FAILING_HISTORY } },
        'blocks.get': { result: BLOCKS },
        ...responses,
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: '요구사항', exact: true }).click();
    await expect(page.getByTestId('card').filter({ hasText: PARENT.displayId })).toBeVisible();
    return bive;
  };
  const selectParent = async (page: Page): Promise<void> => {
    await page.getByTestId('card').filter({ hasText: PARENT.displayId }).click();
    await expect(names(page)).toHaveCount(RULES.length);
  };
  const settledCount = async (page: Page, bive: BiveMock, method: string): Promise<number> => {
    await allSettled(bive, method);
    await nextFrame(page);
    return (await callsOf(bive, method)).length;
  };

  test('규범 변경 알림 하나에 rule.list는 정확히 한 번(폐기 포함 한 조회)이고, 그 응답으로 목록 칩 · 자식 규칙 · 구현 위치가 바뀐다. 상세가 닫혀 있어도 한 번이다', async ({
    page,
  }) => {
    const bive = await openScreen(page);
    // 상세가 닫힌 화면: 알림 하나에 한 번
    const closed = await settledCount(page, bive, 'rule.list');
    await bive.emit('event.normChange.appended', appended(2));
    await expect.poll(async () => (await callsOf(bive, 'rule.list')).length).toBe(closed + 1);
    expect(await settledCount(page, bive, 'rule.list')).toBe(closed + 1);

    // 상세가 열린 화면: 그래도 한 번이고, 그 응답 하나를 두 자리가 함께 쓴다
    await selectParent(page);
    await expect(implementation(page)).toHaveText(['auth', 'lib', 'legacy-mail선언 외']);
    const opened = await settledCount(page, bive, 'rule.list');
    await bive.setResponse('rule.list', { result: { rules: AFTER } });
    await bive.emit('event.normChange.appended', appended(3));
    // 자식 규칙: 새 규칙이 받은 순서(표시 ID 순)로 더해지고, 폐기된 자식 규칙 · 다른 요구사항의 규칙은 없다
    await expect(names(page)).toHaveCount(RULES.length + 1);
    await expect(page.getByTestId('child-rule').last()).toHaveAttribute(
      'data-rule-id',
      ADDED_CHILD.rule.id,
    );
    await expect(page.getByTestId('requirement-rules')).toContainText(ADDED_CHILD.rule.title);
    await expect(page.getByTestId('requirement-rules')).not.toContainText(RETIRED_CHILD.rule.title);
    // 구현 위치: 새 규칙의 health가 선언 순서 맨 앞, 폐기 규칙의 블록은 없다
    await expect(implementation(page)).toHaveText(['health', 'auth', 'lib', 'legacy-mail선언 외']);
    // 목록의 블록 칩도 같은 응답에서 health를 센다
    await page.getByTestId('filter-chip-block').getByTestId('filter-chip-button').click();
    await expect(page.getByTestId('filter-option').filter({ hasText: 'health' })).toHaveCount(1);
    await page.keyboard.press('Escape');
    expect(await settledCount(page, bive, 'rule.list')).toBe(opened + 1);
    expect((await callsOf(bive, 'rule.list')).at(-1)?.params).toEqual({
      projectId: PROJECT.id,
      includeRetired: true,
    });
  });

  test('다시 붙으면(끊김 → 연결됨) 화면의 rule.list 한 번으로 열린 상세의 자식 규칙도 바뀐다', async ({
    page,
  }) => {
    const bive = await openScreen(page);
    await selectParent(page);
    const before = await settledCount(page, bive, 'rule.list');
    await bive.setResponse('rule.list', { result: { rules: AFTER } });
    const connection = page.getByTestId('connection-status');
    await bive.emit('system.connection', { state: 'disconnected' });
    await expect(connection).toHaveAttribute('data-state', 'disconnected');
    await bive.emit('system.connection', { state: 'connected', status: STATUS });
    await expect(connection).toHaveAttribute('data-state', 'connected');
    await expect(names(page)).toHaveCount(RULES.length + 1);
    await expect(page.getByTestId('requirement-rules')).toContainText(ADDED_CHILD.rule.title);
    expect(await settledCount(page, bive, 'rule.list')).toBe(before + 1);
  });

  test('상세를 열 때의 늦은 자식 규칙 응답은 알림 뒤 먼저 온 새 목록을 덮지 않는다', async ({
    page,
  }) => {
    const bive = await openScreen(page);
    // 상세를 열 때 읽기(옛 목록)는 늦게 온다
    await bive.setResponse('rule.list', {
      result: { rules: [...RULES, OTHER_RULE] },
      delayMs: 1500,
    });
    await page.getByTestId('card').filter({ hasText: PARENT.displayId }).click();
    await expect(page.getByTestId('requirement-detail')).toHaveAttribute(
      'data-selected-id',
      PARENT.id,
    );
    // 그동안 알림 → 새 목록이 바로 온다. 기다리던 상세 요청을 버리고 한 번 더 읽는 요청도 이 응답을 받는다(가짜 브리지는 인자로
    // 폐기를 거르지 않으므로 이 시험의 새 목록에는 폐기된 규칙을 넣지 않는다)
    await bive.setResponse('rule.list', { result: { rules: [...RULES, ADDED_CHILD, OTHER_RULE] } });
    await bive.emit('event.normChange.appended', appended(2));
    await expect(names(page)).toHaveCount(RULES.length + 1);
    // 옛 응답이 도착해 그린 뒤에도 새 목록 그대로다
    await allSettled(bive, 'rule.list');
    await nextFrame(page);
    await expect(names(page)).toHaveCount(RULES.length + 1);
    await expect(page.getByTestId('requirement-rules')).toContainText(ADDED_CHILD.rule.title);
  });

  test('상세를 열 때의 옛 자식 규칙 응답은 알림 뒤 새 목록을 반영한 다음 한 번도 그려지지 않는다 (그 자리의 글을 바뀔 때마다 기록)', async ({
    page,
  }) => {
    const bive = await openScreen(page);
    // 자식 규칙 자리의 줄 수를 바뀔 때마다 페이지 안에 기록한다(잠깐 그려졌다 사라지는 값도 놓치지 않게)
    await page.evaluate(() => {
      const log: number[] = [];
      (window as unknown as { __childRuleCounts: number[] }).__childRuleCounts = log;
      const record = (): void => {
        const section = document.querySelector('[data-testid="requirement-rules"]');
        if (section === null) return;
        const count = section.querySelectorAll('[data-testid="child-rule"]').length;
        if (log.at(-1) !== count) log.push(count);
      };
      new MutationObserver(record).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    // 상세를 열 때 읽기(옛 목록: 자식 규칙 3개)는 쥐고 있다가 늦게 풀린다
    await bive.setResponse('rule.list', {
      result: { rules: [...RULES, OTHER_RULE] },
      delayMs: 1500,
    });
    await page.getByTestId('card').filter({ hasText: PARENT.displayId }).click();
    await expect(page.getByTestId('requirement-rules-loading')).toHaveCount(1);
    // 알림 → 화면 목록이 새 값(자식 규칙 4개)을 반영한다
    await bive.setResponse('rule.list', { result: { rules: [...RULES, ADDED_CHILD, OTHER_RULE] } });
    await bive.emit('event.normChange.appended', appended(2));
    await expect(names(page)).toHaveCount(RULES.length + 1);
    // 옛 응답이 풀려 도착한 뒤
    await allSettled(bive, 'rule.list');
    await nextFrame(page);
    await expect(names(page)).toHaveCount(RULES.length + 1);
    const counts = await page.evaluate(
      () => (window as unknown as { __childRuleCounts: number[] }).__childRuleCounts,
    );
    // 기록 전체에 옛 값(자식 규칙 3개)이 없다: 로딩(0) 다음 바로 새 값(4)
    expect(counts).not.toContain(RULES.length);
    expect(counts.at(-1)).toBe(RULES.length + 1);
  });

  test.describe('블록 선언이 바뀐 뒤 다시 읽기', () => {
    /** 선언 이름만 바꾼 `blocks.get` 응답 (테스트 전용 데이터) */
    const declared = (version: number, blockNames: readonly string[]): typeof BLOCKS => ({
      current: {
        ...(BLOCKS.current as NonNullable<typeof BLOCKS.current>),
        version,
        declaration: {
          blocks: blockNames.map((name) => ({
            name,
            kind: 'domain' as const,
            include: [`src/${name}/**`],
            public: [],
            dependsOn: [],
            risk: 'low' as const,
          })),
        },
      },
    });
    const changed = (version: number, projectId: string = PROJECT.id) => ({ projectId, version });
    /** 펼친 자식 규칙(RULE-002) 상세의 대상 블록 */
    const childBlocks = (page: Page) =>
      page
        .getByTestId('child-rule-detail')
        .getByTestId('rule-field-blocks')
        .getByTestId('block-item');

    test('알림 뒤 화면을 다시 열지 않고 구현 위치와 펼친 자식 규칙이 새 선언으로 "선언 외"를 판단한다. 알림 하나에 blocks.get 한 번(펼친 규칙은 다시 읽지 않음)', async ({
      page,
    }) => {
      const bive = await openScreen(page);
      await selectParent(page);
      await childRule(page, FAILING_RULE.displayId).getByTestId('child-rule-toggle').click();
      await expect(implementation(page)).toHaveText(['auth', 'lib', 'legacy-mail선언 외']);
      await expect(childBlocks(page)).toHaveText(['lib', 'auth', 'legacy-mail선언 외']);
      const before = await settledCount(page, bive, 'blocks.get');

      // legacy-mail이 선언에 생김: 선언 순서(맨 뒤)로 들어가고 "선언 외"가 사라진다
      await bive.setResponse('blocks.get', {
        result: declared(2, ['health', 'auth', 'lib', 'legacy-mail']),
      });
      await bive.emit('event.blocks.changed', changed(2));
      await expect(implementation(page)).toHaveText(['auth', 'lib', 'legacy-mail']);
      await expect(childBlocks(page)).toHaveText(['lib', 'auth', 'legacy-mail']);

      // auth가 선언에서 빠짐: 선언에 없는 이름은 뒤에 이름 순, "선언 외"
      await bive.setResponse('blocks.get', {
        result: declared(3, ['health', 'lib', 'legacy-mail']),
      });
      await bive.emit('event.blocks.changed', changed(3));
      await expect(implementation(page)).toHaveText(['lib', 'legacy-mail', 'auth선언 외']);
      await expect(childBlocks(page)).toHaveText(['lib', 'auth선언 외', 'legacy-mail']);
      await expect(page.getByTestId('requirement-detail')).toHaveAttribute(
        'data-selected-id',
        PARENT.id,
      );
      expect(await settledCount(page, bive, 'blocks.get')).toBe(before + 2);
    });

    test('다른 프로젝트의 블록 선언 알림으로는 다시 읽지 않는다', async ({ page }) => {
      const bive = await openScreen(page);
      await selectParent(page);
      await expect(implementation(page)).toHaveText(['auth', 'lib', 'legacy-mail선언 외']);
      const before = await settledCount(page, bive, 'blocks.get');
      await bive.setResponse('blocks.get', {
        result: declared(2, ['health', 'auth', 'lib', 'legacy-mail']),
      });
      await bive.emit('event.blocks.changed', changed(2, OTHER_PROJECT_ID));
      // 다른 프로젝트 알림 뒤 이 프로젝트 알림의 결과가 그려지면 센다: 앞 알림이 읽었다면 하나 더 많다
      await bive.emit('event.blocks.changed', changed(2));
      await expect(implementation(page)).toHaveText(['auth', 'lib', 'legacy-mail']);
      expect(await settledCount(page, bive, 'blocks.get')).toBe(before + 1);
    });

    test('늦게 온 옛 선언 응답은 알림 뒤 먼저 온 새 선언을 덮지 않는다', async ({ page }) => {
      const bive = await openScreen(page, { 'blocks.get': { result: BLOCKS, delayMs: 1500 } });
      await page.getByTestId('card').filter({ hasText: PARENT.displayId }).click();
      await bive.setResponse('blocks.get', {
        result: declared(2, ['health', 'auth', 'lib', 'legacy-mail']),
      });
      await bive.emit('event.blocks.changed', changed(2));
      await expect(implementation(page)).toHaveText(['auth', 'lib', 'legacy-mail']);
      await allSettled(bive, 'blocks.get');
      await nextFrame(page);
      await expect(implementation(page)).toHaveText(['auth', 'lib', 'legacy-mail']);
    });

    test('다시 붙으면(끊김 → 연결됨) 선언을 다시 읽는다', async ({ page }) => {
      const bive = await openScreen(page);
      await selectParent(page);
      await expect(implementation(page)).toHaveText(['auth', 'lib', 'legacy-mail선언 외']);
      await bive.setResponse('blocks.get', {
        result: declared(2, ['health', 'auth', 'lib', 'legacy-mail']),
      });
      const connection = page.getByTestId('connection-status');
      await bive.emit('system.connection', { state: 'disconnected' });
      await expect(connection).toHaveAttribute('data-state', 'disconnected');
      await bive.emit('system.connection', { state: 'connected', status: STATUS });
      await expect(connection).toHaveAttribute('data-state', 'connected');
      await expect(implementation(page)).toHaveText(['auth', 'lib', 'legacy-mail']);
    });
  });
});
