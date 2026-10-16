// 할 일 진입 (이슈 #23 수용 기준 1~3, screens.md 6장 할 일 · SCR-17, TODO-01, ADR-035 · ADR-056).
// 프로젝트 열기(#14) 전이라 프로젝트가 열린 앱 셸을 플레이그라운드(e2e/playground/app.html)로 띄우고,
// 제안 데이터는 가짜 브리지로 준다 (proposal.count · proposal.list · proposal.markRead).
// 데이터: 대기 3건(PRP-001 규칙 신규 · 안 읽음, PRP-002 규칙 신규 · 구현 중 · 안 읽음,
//         PRP-003 요구사항 신규 · 읽음) + 거절 1건(PRP-004 규칙 신규).
import type { Proposal, ProposalCountResult, ProposalKind } from '@bive/shared';
import { expect, type Locator, type Page, test } from '@playwright/test';

import { APPROVAL_FILTERS, HIDDEN_TODO_TABS, TODO_TAB_LABELS } from './checklists/scr-17.js';
import { type BiveMock, mockBive } from './support/bive-mock.js';
import { expectScreen } from './support/expectScreen.js';

const PROJECT_ID = '01JBVE0000000000000000000P';
const URL = `/playground/app.html?projectId=${PROJECT_ID}&projectName=sample-next-app`;
const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;

const ID = {
  p1: '01JBVE0000000000000000P001',
  p2: '01JBVE0000000000000000P002',
  p3: '01JBVE0000000000000000P003',
  p4: '01JBVE0000000000000000P004',
  req: '01JBVE000000000000000000R1',
} as const;

const rulePayload = (title: string): Record<string, unknown> => ({
  title,
  statement: `${title} 요청을 받으면 시스템은 결과를 응답한다`,
  kind: 'business',
  checkKinds: ['test'],
  parentRequirementId: ID.req,
});

const base = {
  targetRef: null,
  diff: { before: null, after: null },
  rationale: '요구사항 문장에서 검사 가능한 규칙을 뽑음',
  author: { kind: 'agent', role: 'rule-writer' },
  source: 'rule_generation',
  risk: null,
  readAt: null,
  state: 'pending',
  decision: null,
  adrId: null,
  runId: null,
} as const satisfies Partial<Proposal>;

const P1: Proposal = {
  ...base,
  id: ID.p1,
  displayId: 'PRP-001',
  kind: 'rule_new',
  payload: rulePayload('헬스 응답에 서버 시각 포함'),
  createdAt: '2026-10-16T01:00:00.000Z',
};
const P2: Proposal = {
  ...base,
  id: ID.p2,
  displayId: 'PRP-002',
  kind: 'rule_new',
  payload: rulePayload('헬스 응답에 버전 포함'),
  source: 'implementation',
  author: { kind: 'agent', role: 'implementer' },
  createdAt: '2026-10-16T02:00:00.000Z',
};
const P3: Proposal = {
  ...base,
  id: ID.p3,
  displayId: 'PRP-003',
  kind: 'requirement_new',
  payload: { text: '헬스 응답에 호스트 이름을 포함한다' },
  rationale: '채팅 지시에서 요구사항을 뽑음',
  source: 'chat',
  author: { kind: 'agent', role: 'chat' },
  readAt: '2026-10-16T03:30:00.000Z',
  createdAt: '2026-10-16T03:00:00.000Z',
};
const P4: Proposal = {
  ...base,
  id: ID.p4,
  displayId: 'PRP-004',
  kind: 'rule_new',
  payload: rulePayload('헬스 응답에 메모리 사용량 포함'),
  state: 'rejected',
  readAt: '2026-10-15T09:10:00.000Z',
  decision: { at: '2026-10-15T09:20:00.000Z', by: { kind: 'human' }, rejectReason: '범위 밖' },
  createdAt: '2026-10-15T09:00:00.000Z',
};
const PROPOSALS = [P1, P2, P3, P4];

/** 목록 응답에서 센 대기 건수 (proposal.count가 돌려줄 값과 같게 만든다). */
const countOf = (proposals: readonly Proposal[]): ProposalCountResult => {
  const kinds: ProposalKind[] = [
    'requirement_new',
    'requirement_change',
    'rule_new',
    'rule_change',
    'contract_new',
    'design_change',
    'rule_title_change',
    'contract_change',
  ];
  const pending = proposals.filter((p) => p.state === 'pending');
  return {
    pending: pending.length,
    pendingByKind: Object.fromEntries(
      kinds.map((kind) => [kind, pending.filter((p) => p.kind === kind).length]),
    ) as Record<ProposalKind, number>,
  };
};

const setup = async (page: Page, proposals: readonly Proposal[] = PROPOSALS): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'proposal.count': { result: countOf(proposals) },
      'proposal.list': { result: { proposals: [...proposals] } },
      'proposal.markRead': {
        result: { proposal: { ...P1, readAt: '2026-10-16T05:00:00.000Z' } },
      },
    },
  });
  await page.goto(URL);
  return bive;
};

const todoButton = (page: Page): Locator => page.getByTestId('todo-button');
const badge = (page: Page): Locator => page.getByTestId('todo-badge');
const card = (page: Page, displayId: string): Locator =>
  page.locator(`[data-testid="card"][data-id="${displayId}"]`);
const callsOf = async (bive: BiveMock, method: string): Promise<unknown[]> =>
  (await bive.calls()).filter((c) => c.method === method).map((c) => c.params);

test.describe('알림 배지 · 툴팁 (수용 기준 1)', () => {
  test('배지 숫자 = proposal.list 대기 건수, 툴팁에 종류별 건수', async ({ page }) => {
    const bive = await setup(page);
    const pending = PROPOSALS.filter((p) => p.state === 'pending').length;

    await expect(badge(page)).toHaveText(String(pending));
    await expect(todoButton(page)).toHaveAttribute('title', '규칙 신규 2 · 요구사항 신규 1');
    // 접근 가능한 이름은 그대로 "할 일"
    await expect(page.getByRole('button', { name: '할 일', exact: true })).toBeVisible();
    expect(await callsOf(bive, 'proposal.count')).toContainEqual({ projectId: PROJECT_ID });

    // 아이콘을 누르면 할 일 화면, 목록의 대기 카드 수 = 배지 숫자
    await todoButton(page).click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'todo');
    await expect(page.getByTestId('card')).toHaveCount(pending);
    await expect(badge(page)).toHaveText(String(pending));
    expect(await callsOf(bive, 'proposal.list')).toContainEqual({ projectId: PROJECT_ID });
  });

  test('대기 0건이면 배지 없음, 툴팁은 이름', async ({ page }) => {
    const bive = await setup(page, [P4]);
    await expect.poll(() => callsOf(bive, 'proposal.count')).not.toHaveLength(0);
    await expect(badge(page)).toHaveCount(0);
    await expect(todoButton(page)).toHaveAttribute('title', '할 일');
  });

  test('화면에 들어갈 때 다시 조회해 배지를 갱신 (폴링 없음)', async ({ page }) => {
    const bive = await setup(page);
    await expect(badge(page)).toHaveText('3');
    await bive.setResponse('proposal.count', { result: countOf([P1, P4]) });

    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(badge(page)).toHaveText('1');
    await expect(todoButton(page)).toHaveAttribute('title', '규칙 신규 1');

    // 화면 이동이 없으면 다시 부르지 않는다
    const before = (await callsOf(bive, 'proposal.count')).length;
    await page.waitForTimeout(1500);
    expect(await callsOf(bive, 'proposal.count')).toHaveLength(before);
  });

  test('프로젝트가 없으면 proposal.count를 부르지 않고 배지 없음', async ({ page }) => {
    const bive = await mockBive(page, { responses: { 'system.status': { result: STATUS } } });
    await page.goto('/playground/app.html');
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'connected');
    await todoButton(page).click();
    await expect(page.getByTestId('main-area').getByTestId('empty-state')).toHaveText(
      '프로젝트 없음',
    );
    await expect(badge(page)).toHaveCount(0);
    expect(await callsOf(bive, 'proposal.count')).toEqual([]);
    expect(await callsOf(bive, 'proposal.list')).toEqual([]);
  });
});

test.describe('할 일 머리 탭 (수용 기준 2)', () => {
  test('승인 대기 탭만 있고 검토 대기열 · 계약 변경 승인 탭은 미노출', async ({ page }) => {
    await setup(page);
    await todoButton(page).click();
    await expectScreen(page, 'SCR-17', '기본');

    const tabs = page.getByRole('tablist', { name: '할 일 종류' }).getByRole('tab');
    await expect(tabs).toHaveText([...TODO_TAB_LABELS]);
    for (const name of HIDDEN_TODO_TABS) {
      await expect(page.getByRole('tab', { name, includeHidden: true })).toHaveCount(0);
      await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    }
  });

  test('빈 상태: 대기 항목 없음', async ({ page }) => {
    await setup(page, []);
    await todoButton(page).click();
    await expectScreen(page, 'SCR-17', '빈');
  });
});

test.describe('승인 대기 목록 · 안 읽음 점 (수용 기준 3)', () => {
  test('카드를 열면 proposal.markRead 1회 호출 · 안 읽음 점 제거', async ({ page }) => {
    const bive = await setup(page);
    await todoButton(page).click();

    const first = card(page, 'PRP-001');
    await expect(first.getByTestId('card-unread')).toBeVisible();
    await first.click();
    await expect(first).toHaveAttribute('aria-current', 'true');
    await expect(first.getByTestId('card-unread')).toHaveCount(0);
    await expect(page.getByTestId('todo-detail')).toHaveAttribute('data-selected-id', 'PRP-001');
    expect(await callsOf(bive, 'proposal.markRead')).toEqual([
      { projectId: PROJECT_ID, id: ID.p1 },
    ]);

    // 다시 골라도 · 이미 읽은 카드를 골라도 부르지 않는다
    await card(page, 'PRP-003').click();
    await first.click();
    await expect(page.getByTestId('todo-detail')).toHaveAttribute('data-selected-id', 'PRP-001');
    expect(await callsOf(bive, 'proposal.markRead')).toHaveLength(1);
    // 다른 안 읽은 카드의 점은 그대로
    await expect(card(page, 'PRP-002').getByTestId('card-unread')).toBeVisible();
  });

  test('카드: 1줄 종류 태그 + 제목, 2줄 ID · 예외 · 시각', async ({ page }) => {
    await setup(page);
    await todoButton(page).click();

    const rule = card(page, 'PRP-001');
    await expect(rule.getByTestId('card-tag')).toHaveText('신규');
    await expect(rule.getByTestId('card-title')).toHaveText('헬스 응답에 서버 시각 포함');
    await expect(rule.getByTestId('card-exception')).toHaveCount(0);
    await expect(rule.locator('time')).toHaveAttribute('datetime', P1.createdAt);

    const requirement = card(page, 'PRP-003');
    await expect(requirement.getByTestId('card-tag')).toHaveText('요구사항');
    await expect(requirement.getByTestId('card-title')).toHaveText(
      '헬스 응답에 호스트 이름을 포함한다',
    );
    await expect(requirement.getByTestId('card-unread')).toHaveCount(0);

    // 구현 중 제안은 예외(문제 항목)라 맨 위
    const during = card(page, 'PRP-002');
    await expect(during.getByTestId('card-exception')).toHaveText('구현 중 제안');
    await expect(page.getByTestId('card-id')).toHaveText(['PRP-002', 'PRP-003', 'PRP-001']);
  });

  test('필터: 처리 상태 기본 대기, 거절을 고르면 거절 예외 카드 · 위험도 칩 0건 비활성', async ({
    page,
  }) => {
    await setup(page);
    await todoButton(page).click();

    for (const { id, label } of APPROVAL_FILTERS) {
      await expect(page.getByTestId(`filter-chip-${id}`)).toContainText(label);
    }
    const state = page.getByTestId('filter-chip-state');
    await expect(state.getByTestId('filter-chip-button')).toHaveText('처리 상태: 대기');
    await expect(
      page.getByTestId('filter-chip-risk').getByTestId('filter-chip-button'),
    ).toBeDisabled();

    await state.getByTestId('filter-chip-button').click();
    await state.locator('[data-testid="filter-option"][data-value="rejected"] input').check();
    await state.locator('[data-testid="filter-option"][data-value="pending"] input').uncheck();
    await expect(page.getByTestId('card-id')).toHaveText(['PRP-004']);
    await expect(card(page, 'PRP-004').getByTestId('card-exception')).toHaveText('거절');
  });
});
