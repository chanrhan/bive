// 제안 알림 → 할 일 배지 · 할 일 목록 다시 조회 (이슈 #164 M1-36 수용 기준 1 · 3의 렌더러 쪽, screens.md 6장 할 일 ·
// SCR-02 · SCR-17, TODO-01 · NRM-02, ADR-076).
// 1) 이 프로젝트의 event.proposal.changed를 받으면 화면 이동 없이 proposal.count를 다시 불러 배지를 갱신한다
//    (요구사항 저장 뒤 제안 2개 → 배지 2, 처리 → 배지 감소). 다른 프로젝트 알림은 무시한다
// 2) 연달아 온 알림은 합친다(동시 조회 1개 · 뒤따르는 조회 최대 1개)고 마지막 상태가 남는다
// 3) 할 일 화면(승인 대기 목록)이 열려 있으면 같은 알림으로 proposal.list도 다시 부르고, 떠나면 그 구독을 끊는다
// 오케스트레이터가 제안 생성 · 처리마다 알림을 보내는 것은 orchestrator/test/events.test.ts가 단언한다.
// 데이터는 가짜 브리지의 응답 · 알림으로만 만든다.
import type {
  Proposal,
  ProposalChangedEvent,
  ProposalCountResult,
  ProposalKind,
} from '@bive/shared';
import { expect, type Page, test } from '@playwright/test';

import { PROJECT, REQUIREMENTS } from './checklists/scr-02.js';
import { type BiveMock, mockBive, type MockResponses } from './support/bive-mock.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
const OTHER_PROJECT_ID = '01JCCCCCCCCCCCCCCCCCCCCCCC';
const REQ = REQUIREMENTS[0]?.id ?? '01JB0000000000000000000001';

const proposal = (n: number, state: Proposal['state'] = 'pending'): Proposal => ({
  id: `01JP00000000000000000000${String(n).padStart(2, '0')}`,
  displayId: `PRP-00${String(n)}`,
  kind: 'rule_new',
  targetRef: { entity: 'Requirement', id: REQ },
  payload: {
    title: `헬스 체크 규칙 ${String(n)}`,
    statement:
      'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 상태 코드 200을 돌려준다',
    kind: 'business',
    checkKinds: ['test'],
    parentRequirementId: REQ,
  },
  diff: { before: null, after: null },
  rationale: '요구사항 문장에서 검사 가능한 규칙을 뽑음',
  author: { kind: 'agent', role: 'rule-writer' },
  source: 'rule_generation',
  risk: null,
  readAt: null,
  state,
  decision:
    state === 'pending'
      ? null
      : { at: '2026-10-16T03:00:00.000Z', by: { kind: 'human' }, rejectReason: '범위 밖' },
  adrId: null,
  runId: null,
  createdAt: `2026-10-16T0${String(n)}:00:00.000Z`,
});

const KINDS: ProposalKind[] = [
  'requirement_new',
  'requirement_change',
  'rule_new',
  'rule_change',
  'contract_new',
  'design_change',
  'rule_title_change',
  'contract_change',
];

/** 대기 n건(모두 규칙 신규)의 proposal.count 응답. */
const countOf = (pending: number): ProposalCountResult => ({
  pending,
  pendingByKind: Object.fromEntries(
    KINDS.map((kind) => [kind, kind === 'rule_new' ? pending : 0]),
  ) as Record<ProposalKind, number>,
});

const changed = (n: number, patch: Partial<ProposalChangedEvent> = {}): ProposalChangedEvent => ({
  projectId: PROJECT.id,
  proposalId: proposal(n).id,
  displayId: proposal(n).displayId,
  kind: 'rule_new',
  state: 'pending',
  ...patch,
});

const open = async (page: Page, responses: MockResponses = {}): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'requirement.list': { result: { requirements: REQUIREMENTS } },
      'proposal.count': { result: countOf(0) },
      'proposal.list': { result: { proposals: [] } },
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

test.describe('제안 알림 → 할 일 배지 (수용 기준 1)', () => {
  test('요구사항 화면에 머문 채 제안 2개의 알림을 받으면 배지가 2, 처리 알림을 받으면 1 (화면 이동 없음)', async ({
    page,
  }) => {
    const bive = await open(page);
    await expect.poll(() => countCalls(bive, 'proposal.count')).toBeGreaterThan(0);
    await expect(badge(page)).toHaveCount(0);

    // rule-writer가 제안 2개를 저장한 뒤의 알림 (오케스트레이터는 제안마다 1개)
    await bive.setResponse('proposal.count', { result: countOf(2) });
    await bive.emit('event.proposal.changed', changed(1));
    await bive.emit('event.proposal.changed', changed(2));
    await expect(badge(page)).toHaveText('2');
    await expect(page.getByTestId('todo-button')).toHaveAttribute('title', '규칙 신규 2');

    // 다른 연결(CLI 등)에서 1건을 처리함
    await bive.setResponse('proposal.count', { result: countOf(1) });
    await bive.emit('event.proposal.changed', changed(1, { state: 'approved' }));
    await expect(badge(page)).toHaveText('1');

    // 그동안 화면은 그대로다
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'requirements');
    for (const call of (await bive.calls()).filter((c) => c.method === 'proposal.count')) {
      expect(call.params).toEqual({ projectId: PROJECT.id });
    }
  });

  test('다른 프로젝트의 제안 알림 · 실행 알림으로는 다시 세지 않는다', async ({ page }) => {
    const bive = await open(page);
    await expect.poll(() => countCalls(bive, 'proposal.count')).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    const base = await countCalls(bive, 'proposal.count');
    await bive.setResponse('proposal.count', { result: countOf(5) });
    await bive.emit('event.proposal.changed', changed(1, { projectId: OTHER_PROJECT_ID }));
    await bive.emit('event.run.updated', { projectId: PROJECT.id });
    await page.waitForTimeout(500);
    expect(await countCalls(bive, 'proposal.count')).toBe(base);
    await expect(badge(page)).toHaveCount(0);
  });
});

test.describe('합치기 (수용 기준 3)', () => {
  test('조회 중에 연달아 온 제안 알림은 1번으로 합치고, 마지막 상태(배지 3)가 남는다', async ({
    page,
  }) => {
    const bive = await open(page);
    await expect.poll(() => countCalls(bive, 'proposal.count')).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    const base = await countCalls(bive, 'proposal.count');

    // 첫 알림의 조회는 늦게 끝나고 그때의 값(1)을 돌려준다
    await bive.setResponse('proposal.count', { result: countOf(1), delayMs: 1500 });
    await bive.emit('event.proposal.changed', changed(1));
    await expect.poll(() => countCalls(bive, 'proposal.count')).toBe(base + 1);
    // 그 조회 중에 제안이 더 생기고 알림이 이어진다
    await bive.setResponse('proposal.count', { result: countOf(3) });
    await bive.emit('event.proposal.changed', changed(2));
    await bive.emit('event.proposal.changed', changed(3));
    await bive.emit('event.proposal.changed', changed(2, { state: 'pending' }));
    expect(await countCalls(bive, 'proposal.count')).toBe(base + 1);

    // 첫 조회가 끝난 뒤 1번만 더 부르고 마지막 상태가 남는다
    await expect.poll(() => countCalls(bive, 'proposal.count')).toBe(base + 2);
    await expect(badge(page)).toHaveText('3');
    await page.waitForTimeout(500);
    expect(await countCalls(bive, 'proposal.count')).toBe(base + 2);
  });
});

test.describe('할 일 화면 목록 (수용 기준 1)', () => {
  test('승인 대기 목록이 열려 있으면 제안 알림으로 proposal.list도 다시 불러 새 카드를 보이고, 떠나면 그 구독을 끊는다', async ({
    page,
  }) => {
    const bive = await open(page, {
      'proposal.count': { result: countOf(1) },
      'proposal.list': { result: { proposals: [proposal(1)] } },
    });
    await page.getByTestId('todo-button').click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'todo');
    await expect(page.getByTestId('card')).toHaveCount(1);
    // 배지 1 + 목록 1
    await expect.poll(async () => (await bive.listenerCounts())['event.proposal.changed']).toBe(2);

    await bive.setResponse('proposal.count', { result: countOf(2) });
    await bive.setResponse('proposal.list', { result: { proposals: [proposal(1), proposal(2)] } });
    await bive.emit('event.proposal.changed', changed(2));
    await expect(page.getByTestId('card')).toHaveCount(2);
    await expect(badge(page)).toHaveText('2');
    for (const call of (await bive.calls()).filter((c) => c.method === 'proposal.list')) {
      expect(call.params).toEqual({ projectId: PROJECT.id });
    }

    // 다른 프로젝트 알림은 목록도 무시
    const lists = await countCalls(bive, 'proposal.list');
    await bive.emit('event.proposal.changed', changed(3, { projectId: OTHER_PROJECT_ID }));
    await page.waitForTimeout(300);
    expect(await countCalls(bive, 'proposal.list')).toBe(lists);

    // 할 일 화면을 떠나면 목록의 구독만 끊기고 배지의 구독은 남는다
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect.poll(async () => (await bive.listenerCounts())['event.proposal.changed']).toBe(1);
  });
});
