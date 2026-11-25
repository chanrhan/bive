// 규범 변경 알림 → 할 일 배지 · 확인할 것 · 규칙 · 요구사항 상세의 자식 규칙 · 검증 화면 다시 조회 (이슈 #226 해야 할 것 4, M7-14,
// screens.md 6장 할 일 · SCR-02 · SCR-03 · SCR-05 · SCR-17 자리, ADR-076 · ADR-119).
// 1) 이 프로젝트의 event.normChange.appended를 받으면 화면 이동 없이 confirmation.list를 다시 불러 배지를 갱신한다.
//    다른 프로젝트 알림 · 실행 알림으로는 배지를 다시 세지 않는다
// 2) 연달아 온 알림은 합친다(동시 조회 1개 · 뒤따르는 조회 최대 1개)고 마지막 상태가 남는다
// 3) 할 일 화면이 열려 있으면 같은 알림으로 목록 카드가 바뀐다(배지와 같은 조회 하나)
// 4) 규칙 화면(rule.list) · 요구사항 상세의 자식 규칙(화면의 rule.list 한 번을 함께 씀) · 검증 화면(verification.summary)도 같은
//    알림으로 다시 읽는다
// 오케스트레이터가 규범 변경 기록이 늘 때 알림을 보내는 것은 orchestrator/test/events.test.ts가 단언한다.
// 옛 제안 알림(event.proposal.changed) → proposal.count 시험은 배지가 확인할 것으로 바뀌어(ADR-119) 이 시험으로 바뀌었다.
import type { NormChangeAppendedEvent } from '@bive/shared';
import { expect, type Page, test } from '@playwright/test';

import { REQUIREMENTS } from './checklists/scr-02.js';
import { RULES } from './checklists/scr-03.js';
import { SUMMARY } from './checklists/scr-05.js';
import {
  FIXTURE_LIST,
  ITEM_RETIRED,
  ITEM_RULE3,
  ITEM_SUPERSEDED,
  listOf,
  PROJECT,
} from './checklists/scr-17.js';
import {
  allSettled,
  type BiveMock,
  mockBive,
  type MockResponses,
  nextFrame,
} from './support/bive-mock.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
const OTHER_PROJECT_ID = '01JCCCCCCCCCCCCCCCCCCCCCCC';

const appended = (lastSeq: number, projectId: string = PROJECT.id): NormChangeAppendedEvent => ({
  projectId,
  lastSeq,
});

const open = async (page: Page, responses: MockResponses = {}): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'requirement.list': { result: { requirements: REQUIREMENTS } },
      'confirmation.list': { result: listOf([]) },
      ...responses,
    },
  });
  await page.goto('/');
  await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'requirements');
  return bive;
};

const badge = (page: Page) => page.getByTestId('todo-badge');
const countCalls = async (bive: BiveMock, method: string): Promise<number> =>
  (await bive.calls()).filter((call) => call.method === method).length;

test.describe('규범 변경 알림 → 할 일 배지', () => {
  test('요구사항 화면에 머문 채 알림을 받으면 배지가 늘고 줄며 툴팁도 바뀐다 (화면 이동 없음)', async ({
    page,
  }) => {
    const bive = await open(page);
    await expect.poll(() => countCalls(bive, 'confirmation.list')).toBeGreaterThan(0);
    await expect(badge(page)).toHaveCount(0);

    // 규칙 작성 세션이 규칙을 만들고 폐기함 (커밋 뒤 알림)
    await bive.setResponse('confirmation.list', { result: listOf([ITEM_RETIRED, ITEM_RULE3]) });
    await bive.emit('event.normChange.appended', appended(3));
    await expect(badge(page)).toHaveText('2');
    await expect(page.getByTestId('todo-button')).toHaveAttribute('title', '폐기 1 · 미확인 1');

    await bive.setResponse('confirmation.list', { result: listOf([ITEM_SUPERSEDED]) });
    await bive.emit('event.normChange.appended', appended(5));
    await expect(badge(page)).toHaveText('1');

    // 그동안 화면은 그대로다
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'requirements');
    for (const call of (await bive.calls()).filter((c) => c.method === 'confirmation.list')) {
      expect(call.params).toEqual({ projectId: PROJECT.id });
    }
  });

  test('다른 프로젝트의 규범 변경 알림 · 실행 알림 · 옛 제안 알림으로는 배지를 다시 세지 않는다', async ({
    page,
  }) => {
    const bive = await open(page);
    await expect.poll(() => countCalls(bive, 'confirmation.list')).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    const base = await countCalls(bive, 'confirmation.list');
    await bive.setResponse('confirmation.list', { result: FIXTURE_LIST });
    await bive.emit('event.normChange.appended', appended(9, OTHER_PROJECT_ID));
    await bive.emit('event.run.updated', { projectId: PROJECT.id });
    await bive.emit('event.proposal.changed', { projectId: PROJECT.id });
    await page.waitForTimeout(500);
    expect(await countCalls(bive, 'confirmation.list')).toBe(base);
    await expect(badge(page)).toHaveCount(0);
  });

  test('조회 중에 연달아 온 알림은 1번으로 합치고, 마지막 상태(배지 7)가 남는다', async ({
    page,
  }) => {
    const bive = await open(page);
    await expect.poll(() => countCalls(bive, 'confirmation.list')).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    const base = await countCalls(bive, 'confirmation.list');

    // 첫 알림의 조회는 늦게 끝나고 그때의 값(1)을 돌려준다
    await bive.setResponse('confirmation.list', {
      result: listOf([ITEM_SUPERSEDED]),
      delayMs: 1500,
    });
    await bive.emit('event.normChange.appended', appended(1));
    await expect.poll(() => countCalls(bive, 'confirmation.list')).toBe(base + 1);
    // 그 조회 중에 기록이 더 늘고 알림이 이어진다
    await bive.setResponse('confirmation.list', { result: FIXTURE_LIST });
    await bive.emit('event.normChange.appended', appended(2));
    await bive.emit('event.normChange.appended', appended(3));
    expect(await countCalls(bive, 'confirmation.list')).toBe(base + 1);

    // 첫 조회가 끝난 뒤 1번만 더 부르고 마지막 상태가 남는다
    await expect.poll(() => countCalls(bive, 'confirmation.list')).toBe(base + 2);
    await expect(badge(page)).toHaveText('7');
    await page.waitForTimeout(500);
    expect(await countCalls(bive, 'confirmation.list')).toBe(base + 2);
  });
});

test.describe('규범 변경 알림 → 화면 다시 읽기', () => {
  test('할 일 화면이 열려 있으면 같은 조회 하나로 목록 카드와 배지가 함께 바뀐다', async ({
    page,
  }) => {
    const bive = await open(page, { 'confirmation.list': { result: listOf([ITEM_RETIRED]) } });
    await page.getByTestId('todo-button').click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'todo');
    await expect(page.getByTestId('card')).toHaveCount(1);
    // 배지와 목록이 같은 구독 하나를 쓴다
    await expect
      .poll(async () => (await bive.listenerCounts())['event.normChange.appended'])
      .toBe(1);

    const before = await countCalls(bive, 'confirmation.list');
    await bive.setResponse('confirmation.list', {
      result: listOf([ITEM_SUPERSEDED, ITEM_RETIRED]),
    });
    await bive.emit('event.normChange.appended', appended(4));
    await expect(page.getByTestId('card-id')).toHaveText(['RULE-001', 'RULE-002']);
    await expect(badge(page)).toHaveText('2');
    expect(await countCalls(bive, 'confirmation.list')).toBe(before + 1);
  });

  test('규칙 화면 · 검증 화면 · 요구사항 상세의 자식 규칙이 알림으로 다시 읽고, 떠나면 그 구독을 끊는다', async ({
    page,
  }) => {
    const bive = await open(page, {
      'rule.list': { result: { rules: RULES } },
      'verification.summary': { result: SUMMARY },
    });

    // 규칙 화면
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(page.getByTestId('rules-screen')).toHaveAttribute('data-state', 'ready');
    const rules = await countCalls(bive, 'rule.list');
    await bive.emit('event.normChange.appended', appended(2));
    await expect.poll(() => countCalls(bive, 'rule.list')).toBe(rules + 1);
    // 다른 프로젝트 알림은 무시
    await bive.emit('event.normChange.appended', appended(3, OTHER_PROJECT_ID));
    await page.waitForTimeout(300);
    expect(await countCalls(bive, 'rule.list')).toBe(rules + 1);

    // 검증 화면
    await page.getByRole('button', { name: '검증', exact: true }).click();
    await expect.poll(() => countCalls(bive, 'verification.summary')).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    const summaries = await countCalls(bive, 'verification.summary');
    await bive.emit('event.normChange.appended', appended(4));
    await expect.poll(() => countCalls(bive, 'verification.summary')).toBe(summaries + 1);

    // 요구사항 상세의 자식 규칙
    await page.getByRole('button', { name: '요구사항', exact: true }).click();
    await page.getByTestId('card').first().click();
    await expect.poll(() => countCalls(bive, 'rule.list')).toBeGreaterThan(rules + 1);
    await page.waitForTimeout(300);
    const children = await countCalls(bive, 'rule.list');
    await bive.emit('event.normChange.appended', appended(5));
    // 목록의 블록 칩(구현 위치, ADR-126)이 한 번 다시 읽고 상세의 자식 규칙은 그 결과를 함께 쓴다(알림 하나에 한 번, M3-42 #283 ·
    // ADR-135. 이전에는 두 번)
    await expect.poll(() => countCalls(bive, 'rule.list')).toBe(children + 1);
    await allSettled(bive, 'rule.list');
    await nextFrame(page);
    expect(await countCalls(bive, 'rule.list')).toBe(children + 1);

    // 요구사항 화면을 떠나면 자식 규칙의 구독이 끊기고 배지의 구독만 남는다
    await page.getByTestId('todo-button').click();
    await expect
      .poll(async () => (await bive.listenerCounts())['event.normChange.appended'])
      .toBe(1);
  });
});
