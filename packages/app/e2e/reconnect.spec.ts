// 재접속 → 열린 화면 · 할 일 배지 다시 조회 (이슈 #164 M1-36 수용 기준 2 · 3, screens.md 1.2 연결 상태 · SCR-03 ·
// SCR-05 · 할 일, RUN-02 · NFR-06, ADR-045 · ADR-076).
// 1) 연결 상태가 끊김 → 연결됨으로 바뀌면 열려 있는 규칙 화면(rule.list) · 검증 화면(verification.summary) · 할 일 배지
//    (proposal.count) · 할 일 목록(proposal.list)이 한 번 다시 조회한다. 끊긴 동안 잃은 알림을 회복한다
//    (예: 오케스트레이터가 죽었다 다시 뜬 뒤 실행이 중단으로 보이고 [재개]가 생김)
// 2) 앱 시작의 첫 연결됨 · 연결됨이 이어지는 동안에는 다시 조회하지 않는다(전이 때만)
// 3) 재접속이 연달아 와도 합친다(동시 조회 1개 · 뒤따르는 조회 최대 1개)
// 연결 상태 전이는 main이 보내는 system.connection 알림을 가짜 브리지로 흉내 낸다(layout.spec.ts와 같은 방법).
import { expect, type Page, test } from '@playwright/test';

import { run, stages, SUMMARY } from './checklists/scr-05.js';
import { PROJECT, RULES } from './checklists/scr-06.js';
import { type BiveMock, mockBive, type MockResponses } from './support/bive-mock.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
const CONNECTED = { state: 'connected', status: STATUS } as const;
const DISCONNECTED = { state: 'disconnected' } as const;

const COUNT = {
  pending: 0,
  pendingByKind: {
    requirement_new: 0,
    requirement_change: 0,
    rule_new: 0,
    rule_change: 0,
    contract_new: 0,
    design_change: 0,
    rule_title_change: 0,
    contract_change: 0,
  },
} as const;

/** 오케스트레이터가 다시 뜬 뒤의 검증 요약: 최근 실행이 중단(구현 단계에서 끊김). */
const INTERRUPTED = {
  ...SUMMARY,
  pipeline: {
    run: run({ status: 'interrupted', currentStep: 'implementation' }),
    stages: stages('implementation', 'pending'),
  },
} as const;

const open = async (page: Page, menu: string, responses: MockResponses = {}): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'requirement.list': { result: { requirements: [] } },
      'rule.list': { result: { rules: RULES } },
      'verification.summary': { result: SUMMARY },
      'proposal.count': { result: COUNT },
      'proposal.list': { result: { proposals: [] } },
      ...responses,
    },
  });
  await page.goto('/');
  await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'requirements');
  await page.getByRole('button', { name: menu, exact: true }).click();
  return bive;
};

const countCalls = async (bive: BiveMock, method: string): Promise<number> =>
  (await bive.calls()).filter((call) => call.method === method).length;

const connection = (page: Page) => page.getByTestId('connection-status');

/** 끊김 → 연결됨. 사이드바 표시가 바뀌는 것까지 기다린다. */
const reconnect = async (page: Page, bive: BiveMock): Promise<void> => {
  await bive.emit('system.connection', DISCONNECTED);
  await expect(connection(page)).toHaveAttribute('data-state', 'disconnected');
  await bive.emit('system.connection', CONNECTED);
  await expect(connection(page)).toHaveAttribute('data-state', 'connected');
};

test.describe('재접속 → 다시 조회 (수용 기준 2)', () => {
  test('검증 화면: 다시 붙으면 verification.summary를 다시 불러 실행 "중단"과 [재개]를 보인다 (화면 이동 없음)', async ({
    page,
  }) => {
    const bive = await open(page, '검증');
    await expect(page.getByTestId('pipeline-run-status')).toHaveText('진행 중');
    await expect(page.getByTestId('pipeline-current')).toHaveText('구현');
    await expect(page.getByRole('button', { name: '재개' })).toHaveCount(0);
    await page.waitForTimeout(300);
    const summaries = await countCalls(bive, 'verification.summary');
    const counts = await countCalls(bive, 'proposal.count');

    // 연결됨이 이어지는 동안은 다시 부르지 않는다 (main은 1초마다 연결됨을 보낸다)
    await bive.emit('system.connection', CONNECTED);
    await bive.emit('system.connection', CONNECTED);
    await page.waitForTimeout(300);
    expect(await countCalls(bive, 'verification.summary')).toBe(summaries);
    expect(await countCalls(bive, 'proposal.count')).toBe(counts);

    // 오케스트레이터가 죽고(끊김) 다시 뜨는 사이 실행은 중단이 됐다. 끊긴 동안에는 다시 부르지 않는다
    await bive.setResponse('verification.summary', { result: INTERRUPTED });
    await bive.emit('system.connection', DISCONNECTED);
    await expect(connection(page)).toHaveAttribute('data-state', 'disconnected');
    await bive.emit('system.connection', DISCONNECTED);
    await page.waitForTimeout(300);
    expect(await countCalls(bive, 'verification.summary')).toBe(summaries);

    await bive.emit('system.connection', CONNECTED);
    await expect(page.getByTestId('pipeline-run-status')).toHaveText('중단');
    await expect(page.getByRole('button', { name: '재개', exact: true })).toBeVisible();
    expect(await countCalls(bive, 'verification.summary')).toBe(summaries + 1);
    // 할 일 배지도 한 번 다시 센다
    await expect.poll(() => countCalls(bive, 'proposal.count')).toBe(counts + 1);
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'verification');

    // 그 뒤 연결됨이 이어져도 더 부르지 않는다
    await bive.emit('system.connection', CONNECTED);
    await page.waitForTimeout(300);
    expect(await countCalls(bive, 'verification.summary')).toBe(summaries + 1);
    expect(await countCalls(bive, 'proposal.count')).toBe(counts + 1);
  });

  test('규칙 화면: 다시 붙으면 rule.list를 다시 부른다', async ({ page }) => {
    const bive = await open(page, '규칙');
    await expect(page.getByTestId('card')).toHaveCount(RULES.length);
    await page.waitForTimeout(300);
    const rules = await countCalls(bive, 'rule.list');
    await bive.setResponse('rule.list', { result: { rules: RULES.slice(0, 1) } });
    await reconnect(page, bive);
    await expect(page.getByTestId('card')).toHaveCount(1);
    expect(await countCalls(bive, 'rule.list')).toBe(rules + 1);
    for (const call of (await bive.calls()).filter((c) => c.method === 'rule.list')) {
      expect(call.params).toEqual({ projectId: PROJECT.id });
    }
  });

  test('할 일 화면: 다시 붙으면 배지(proposal.count)와 목록(proposal.list)을 다시 부른다', async ({
    page,
  }) => {
    const bive = await open(page, '할 일');
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'todo');
    await expect(page.getByTestId('todo-approval')).toHaveAttribute('data-state', 'ready');
    await page.waitForTimeout(300);
    const counts = await countCalls(bive, 'proposal.count');
    const lists = await countCalls(bive, 'proposal.list');
    await reconnect(page, bive);
    await expect.poll(() => countCalls(bive, 'proposal.count')).toBe(counts + 1);
    await expect.poll(() => countCalls(bive, 'proposal.list')).toBe(lists + 1);
  });

  test('앱 시작 때 처음 받은 연결됨으로는 다시 조회하지 않는다 (처음 불러오기와 중복 없음)', async ({
    page,
  }) => {
    const bive = await open(page, '검증');
    await expect(page.getByTestId('pipeline-current')).toHaveText('구현');
    await page.waitForTimeout(300);
    const summaries = await countCalls(bive, 'verification.summary');
    const counts = await countCalls(bive, 'proposal.count');
    // 화면에 들어온 뒤 처음 오는 main의 연결됨 알림
    await bive.emit('system.connection', CONNECTED);
    await page.waitForTimeout(500);
    expect(await countCalls(bive, 'verification.summary')).toBe(summaries);
    expect(await countCalls(bive, 'proposal.count')).toBe(counts);
  });
});

test.describe('합치기 (수용 기준 3)', () => {
  test('조회 중에 재접속이 연달아 와도 1번으로 합치고, 마지막 상태가 남는다', async ({ page }) => {
    const bive = await open(page, '검증');
    await expect(page.getByTestId('pipeline-current')).toHaveText('구현');
    await page.waitForTimeout(300);
    const base = await countCalls(bive, 'verification.summary');

    // 첫 재접속의 조회는 늦게 끝나고 그때의 값(진행 중)을 돌려준다
    await bive.setResponse('verification.summary', { result: SUMMARY, delayMs: 1500 });
    await reconnect(page, bive);
    await expect.poll(() => countCalls(bive, 'verification.summary')).toBe(base + 1);
    // 그 조회 중에 연결이 두 번 더 흔들리고, 그사이 실행이 중단이 됐다
    await bive.setResponse('verification.summary', { result: INTERRUPTED });
    await reconnect(page, bive);
    await reconnect(page, bive);
    expect(await countCalls(bive, 'verification.summary')).toBe(base + 1);

    await expect.poll(() => countCalls(bive, 'verification.summary')).toBe(base + 2);
    await expect(page.getByTestId('pipeline-run-status')).toHaveText('중단');
    await page.waitForTimeout(500);
    expect(await countCalls(bive, 'verification.summary')).toBe(base + 2);
  });

  test('화면을 떠나면 재접속 구독도 끊는다 (배지의 구독 1개만 남음)', async ({ page }) => {
    const bive = await open(page, '검증');
    await expect(page.getByTestId('pipeline-current')).toHaveText('구현');
    // 사이드바 연결 표시 1 + 배지 1 + 검증 화면 1
    await expect.poll(async () => (await bive.listenerCounts())['system.connection']).toBe(3);
    await page.getByRole('button', { name: '요구사항', exact: true }).click();
    await expect.poll(async () => (await bive.listenerCounts())['system.connection']).toBe(2);
  });
});
