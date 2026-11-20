// 앱 창의 최소 크기 (이슈 #191 수용 기준 4, ADR-093): 창 안쪽 최소 크기(`MIN_CONTENT_SIZE`, 820 × 600)의 뷰포트에서
// 요구사항(SCR-02) · 규칙(SCR-03) · 승인 대기(SCR-17)의 목록 + 상세 본문에 가로 스크롤이 없고, 목록 · 상세 칸이 최소 폭
// 이상이며, 설정 모달(SCR-21)이 820 × 600 그대로 들어간다. 채팅은 1100px 미만이라 44px 띠다.
// 대조: 최소보다 좁은 760px에서는 같은 검사가 본문 가로 스크롤을 잡는다(최소 크기가 필요한 이유, ADR-090 한계).
// 창이 실제로 그 크기 아래로 줄지 않는 것은 스모크(smoke/run-smoke.ts)와 test/window.test.ts가 본다.
// 데이터는 가짜 브리지 응답뿐이다 (테스트 전용 데이터, NFR-03).
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { Proposal, ProposalCountResult, ProposalKind, Settings } from '@bive/shared';
import { expect, type Locator, type Page, test } from '@playwright/test';

import { MIN_CONTENT_SIZE } from '../src/main/window-size.js';
import { FAILING_HISTORY, FAILING_RULE, PARENT, PROJECT, RULES } from './checklists/scr-06.js';
import { mockBive } from './support/bive-mock.js';
import { SCREENSHOT_DIR } from './support/expectScreen.js';
import {
  DETAIL_PANE_MIN,
  LIST_PANE_MIN,
  listPaneOverflow,
  paneWidths,
} from './support/overflow.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
const EMPTY_ROLE = { model: null, maxBudgetUsd: null, maxTurns: null };
const SETTINGS: Settings = {
  projectId: PROJECT.id,
  run: { maxBudgetUsd: null, maxTurns: null },
  roles: {
    'rule-writer': EMPTY_ROLE,
    planner: EMPTY_ROLE,
    'test-writer': EMPTY_ROLE,
    implementer: EMPTY_ROLE,
    chat: EMPTY_ROLE,
  },
  approvalQueueLimit: 40,
  provisionalPolicy: 'off',
  autoMode: false,
  installAllowlist: [],
  ide: null,
  updatedAt: null,
  updatedBy: null,
};

const PAYLOAD = {
  title: '헬스 응답에 서버 시각 포함',
  statement: 'WHEN 클라이언트가 헬스 체크를 요청하면 THE SYSTEM SHALL 헬스 응답에 서버 시각 포함',
  kind: 'business',
  checkKinds: ['test'],
  parentRequirementId: PARENT.id,
};
/** 승인 대기 제안 하나 (테스트 전용 데이터): 위험 높음 · 구현 중 제안 · 안 읽음 */
const PROPOSAL: Proposal = {
  id: '01JBVE0000000000000000P001',
  displayId: 'PRP-001',
  kind: 'rule_new',
  targetRef: { entity: 'Requirement', id: PARENT.id },
  payload: PAYLOAD,
  diff: { before: null, after: PAYLOAD },
  rationale: '요구사항 문장에서 검사 가능한 규칙을 뽑음',
  author: { kind: 'agent', role: 'rule-writer' },
  source: 'implementation',
  risk: 'high',
  readAt: null,
  state: 'pending',
  decision: null,
  adrId: null,
  runId: null,
  createdAt: '2026-10-16T01:00:00.000Z',
};
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
const COUNT: ProposalCountResult = {
  pending: 1,
  pendingByKind: Object.fromEntries(
    KINDS.map((kind) => [kind, kind === 'rule_new' ? 1 : 0]),
  ) as Record<ProposalKind, number>,
};

const open = async (page: Page): Promise<void> => {
  await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'requirement.list': { result: { requirements: [PARENT] } },
      'requirement.get': { result: { requirement: PARENT } },
      'rule.list': { result: { rules: RULES } },
      'judgment.list': { result: { judgments: FAILING_HISTORY } },
      'proposal.count': { result: COUNT },
      'proposal.list': { result: { proposals: [PROPOSAL] } },
      'proposal.markRead': {
        result: { proposal: { ...PROPOSAL, readAt: '2026-10-16T05:00:00.000Z' } },
      },
      'approvalLog.list': {
        result: { entries: [], chain: { valid: true, brokenAtSeq: null, reason: null } },
      },
      'settings.get': { result: { settings: SETTINGS } },
      'settings.validateForRun': { result: { ok: true } },
    },
  });
  await page.goto('/');
};

/** 세 화면(목록 + 상세)을 차례로 열어 `check`를 부른다. 상세는 항목을 고른 상태(요구사항은 자식 규칙 펼침). */
const eachScreen = async (
  page: Page,
  check: (name: string, list: Locator, detail: Locator) => Promise<void>,
): Promise<void> => {
  await page.getByRole('button', { name: '요구사항', exact: true }).click();
  await page.getByTestId('card').filter({ hasText: PARENT.displayId }).click();
  await expect(page.getByTestId('requirement-detail')).toHaveAttribute(
    'data-selected-id',
    PARENT.id,
  );
  const child = page.getByTestId('child-rule').filter({ hasText: FAILING_RULE.displayId });
  await child.getByTestId('child-rule-toggle').click();
  await expect(child.getByTestId('failure-case')).toBeVisible();
  await check(
    '요구사항',
    page.getByTestId('requirements-list-pane'),
    page.getByTestId('requirement-detail'),
  );

  await page.getByRole('button', { name: '규칙', exact: true }).click();
  await page.getByTestId('card').filter({ hasText: FAILING_RULE.displayId }).click();
  await expect(page.getByTestId('rule-detail')).toHaveAttribute(
    'data-selected-id',
    FAILING_RULE.id,
  );
  await expect(page.getByTestId('failure-case')).toBeVisible();
  await check('규칙', page.getByTestId('rules-list-pane'), page.getByTestId('rule-detail'));

  await page.getByTestId('todo-button').click();
  await page.locator(`[data-testid="card"][data-id="${PROPOSAL.displayId}"]`).click();
  await expect(page.getByTestId('detail-if-reject')).toBeVisible();
  await check('승인 대기', page.getByTestId('todo-list-pane'), page.getByTestId('todo-detail'));
};

/** 본문(중앙 영역)과 상세 칸의 가로 넘침 (내용 폭 − 보이는 폭, 0이면 없음). */
const overflowOf = (locator: Locator): Promise<number> =>
  locator.evaluate((el) => el.scrollWidth - el.clientWidth);

const shot = async (page: Page, name: string): Promise<void> => {
  const dir = path.join(SCREENSHOT_DIR, '..', 'layout');
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
};

test.describe(`최소 창 ${MIN_CONTENT_SIZE.width} × ${MIN_CONTENT_SIZE.height} (#191, ADR-093)`, () => {
  test.use({ viewport: { ...MIN_CONTENT_SIZE } });

  test('요구사항 · 규칙 · 승인 대기의 본문 · 상세에 가로 스크롤이 없고 목록 · 상세 칸은 최소 폭 이상, 채팅은 44px 띠', async ({
    page,
  }) => {
    await open(page);
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-mode', 'strip');
    expect((await page.getByTestId('chat-panel').boundingBox())?.width).toBe(44);
    await eachScreen(page, async (name, list, detail) => {
      expect(await overflowOf(page.getByTestId('main-area')), `${name} 본문 가로 스크롤`).toBe(0);
      expect(await overflowOf(detail), `${name} 상세 가로 스크롤`).toBeLessThanOrEqual(0);
      const widths = await paneWidths(list, detail);
      expect(widths.list, `${name} 목록 폭`).toBeGreaterThanOrEqual(LIST_PANE_MIN);
      expect(widths.detail, `${name} 상세 폭`).toBeGreaterThanOrEqual(DETAIL_PANE_MIN);
      expect(await listPaneOverflow(list), `${name} 목록 넘침`).toEqual([]);
      await shot(page, `최소-창-${name}`);
    });
  });

  test('설정 모달은 820 × 600 그대로 창 안에 들어가고 모달 안에 가로 스크롤이 없다', async ({
    page,
  }) => {
    await open(page);
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const modal = page.getByTestId('settings-modal');
    await expect(page.getByTestId('settings-budget-model')).toHaveAttribute('data-state', 'ready');
    const box = await modal.boundingBox();
    expect(box).toEqual({ x: 0, y: 0, width: 820, height: 600 });
    expect(await overflowOf(modal)).toBe(0);
    const inner = await modal.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>('*')]
        .filter((child) => child.scrollWidth > child.clientWidth + 0.5)
        .filter((child) => getComputedStyle(child).overflowX !== 'visible')
        .map((child) => child.getAttribute('data-testid') ?? child.className),
    );
    expect(inner).toEqual([]);
    await shot(page, '최소-창-설정');
  });
});

test.describe('대조: 최소보다 좁은 창 (760 × 600)', () => {
  test.use({ viewport: { width: 760, height: 600 } });

  test('목록 220 + 상세 288이 본문보다 넓어 본문에 가로 스크롤이 생긴다 (최소 크기가 막는 상태)', async ({
    page,
  }) => {
    await open(page);
    await eachScreen(page, async (name) => {
      expect(await overflowOf(page.getByTestId('main-area')), `${name} 본문`).toBeGreaterThan(0);
    });
  });
});
