// SCR-06 규범 상세 · 요구사항 (이슈 #38 수용 기준, screens.md SCR-02 상세 · SCR-06 · 1.4, ADR-035 · ADR-078).
// 1) checklists/scr-06.ts의 요구사항 기본 상태(본문, 생성 주체 이름, 자식 규칙 목록)를 통과하고 변경 이력 영역이 미노출
// 2) 자식 규칙을 누르면 그 자리에서 진술, 속성, 테스트 출력이 펼쳐짐 (규칙 상세 RuleDetail 재사용)
// 3) 직접 편집 저장이 requirement.update를 1회 부르고, 삭제는 첫 클릭에서 호출 0회 · 두 번째 클릭에서 requirement.delete 1회
// 요구사항 화면(SCR-02)에서 카드를 눌러 들어온다. 데이터는 가짜 브리지의 requirement.list · rule.list · judgment.list 응답뿐이다.
import { expect, type Page, test } from '@playwright/test';

import type { Requirement, RuleWithJudgment } from '@bive/shared';

import { REQUIREMENTS } from './checklists/scr-02.js';
import {
  FAILED_CASE,
  FAILING_HISTORY,
  FAILING_RULE,
  HISTORY,
  PARENT,
  PASSING_RULE,
  PROJECT,
  requirementDetailChecklist,
  RULES,
} from './checklists/scr-06.js';
import { type BiveMock, type MockCall, mockBive, type MockResponses } from './support/bive-mock.js';
import {
  collectVisibleText,
  expectScreen,
  findForbiddenText,
  SCREENSHOT_DIR,
} from './support/expectScreen.js';

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

const openRequirement = async (page: Page, responses: MockResponses = {}): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'requirement.list': { result: { requirements: REQUIREMENTS } },
      'rule.list': { result: { rules: [...RULES, OTHER_RULE] } },
      'judgment.list': { result: { judgments: FAILING_HISTORY } },
      'requirement.update': { result: { requirement: EDITED } },
      'requirement.delete': { result: { requirement: DELETED } },
      ...responses,
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '요구사항', exact: true }).click();
  await page.getByTestId('card').filter({ hasText: PARENT.displayId }).click();
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
  test('기본: 본문 · 생성 주체 이름 · 자식 규칙 목록, 변경 이력 · 구현 위치 미노출', async ({
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
    await openRequirement(page, { 'rule.list': { pending: true } });
    await expectRequirementDetail(page, '로딩');
    await expect(page.getByTestId('requirement-rules-loading')).toHaveText('');
  });

  test('에러: 자식 규칙 자리에 "자식 규칙 불러오기 실패", 나머지 상세는 보인다', async ({
    page,
  }) => {
    await openRequirement(page, {
      'rule.list': { error: { code: -32603, message: '내부 오류' } },
    });
    await expectRequirementDetail(page, '에러');
  });

  test('카드를 고르면 그 프로젝트로 rule.list를 부르고, 상세 안에서 requirement.get은 부르지 않는다', async ({
    page,
  }) => {
    const bive = await openRequirement(page);
    await expect(page.getByTestId('child-rule')).toHaveCount(RULES.length);
    const lists = await callsOf(bive, 'rule.list');
    expect(lists.length).toBeGreaterThan(0);
    for (const call of lists) expect(call.params).toEqual({ projectId: PROJECT.id });
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
