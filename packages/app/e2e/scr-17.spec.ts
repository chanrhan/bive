// SCR-17 승인 대기: 목록 · 상세 · 수정 · 거절 · 승인 (이슈 #40 수용 기준 1~4, screens.md SCR-17, NRM-04 · TODO-01,
// ADR-029 · ADR-035 · ADR-050 · ADR-063).
// 앱을 열면 가짜 브리지의 project.current 응답으로 프로젝트가 열린 상태가 된다. 제안 · 요구사항 · 승인 기록 데이터도
// 가짜 브리지로 준다. 데이터:
//   대기  PRP-001 규칙 신규(부모 REQ-001, 안 읽음) · PRP-003 요구사항 신규(읽음)
//   처리됨 PRP-004 규칙 신규 거절(사유 "범위 밖") · PRP-005 규칙 신규 수정 후 승인(제목 수정)
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type {
  ApprovalLogEntry,
  ApprovalLogListResult,
  Proposal,
  ProposalCountResult,
  ProposalKind,
  Requirement,
  Rule,
} from '@bive/shared';
import { expect, type Locator, type Page, test } from '@playwright/test';

import {
  ACTION_LABELS,
  APPROVAL_FILTERS,
  DETAIL_SECTIONS,
  PROCESSED_DETAIL_SECTIONS,
} from './checklists/scr-17.js';
import { type BiveMock, mockBive } from './support/bive-mock.js';
import {
  collectVisibleText,
  expectScreen,
  findForbiddenText,
  SCREENSHOT_DIR,
} from './support/expectScreen.js';

const PROJECT_ID = '01JBVE0000000000000000000P';
const PROJECT = {
  id: PROJECT_ID,
  name: 'sample-next-app',
  rootPath: '/tmp/sample-next-app',
  baseBranch: 'main',
  createdAt: '2026-10-16T00:00:00.000Z',
} as const;
const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;

const ID = {
  p1: '01JBVE0000000000000000P001',
  p3: '01JBVE0000000000000000P003',
  p4: '01JBVE0000000000000000P004',
  p5: '01JBVE0000000000000000P005',
  req: '01JBVE000000000000000000R1',
  rule: '01JBVE000000000000000000U1',
} as const;
const HUMAN = { kind: 'human' } as const;

const rulePayload = (title: string): Record<string, unknown> => ({
  title,
  statement: `WHEN 클라이언트가 헬스 체크를 요청하면 THE SYSTEM SHALL ${title}`,
  kind: 'business',
  checkKinds: ['test'],
  parentRequirementId: ID.req,
});

const base = {
  targetRef: { entity: 'Requirement', id: ID.req },
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

const P1_PAYLOAD = rulePayload('헬스 응답에 서버 시각 포함');
const P1: Proposal = {
  ...base,
  id: ID.p1,
  displayId: 'PRP-001',
  kind: 'rule_new',
  payload: P1_PAYLOAD,
  diff: { before: null, after: P1_PAYLOAD },
  createdAt: '2026-10-16T01:00:00.000Z',
};
const P3: Proposal = {
  ...base,
  id: ID.p3,
  displayId: 'PRP-003',
  kind: 'requirement_new',
  targetRef: null,
  payload: { text: '헬스 응답에 호스트 이름을 포함한다' },
  diff: { before: null, after: { text: '헬스 응답에 호스트 이름을 포함한다' } },
  rationale: '채팅 지시에서 요구사항을 뽑음',
  source: 'chat',
  author: { kind: 'agent', role: 'chat' },
  readAt: '2026-10-16T03:30:00.000Z',
  createdAt: '2026-10-16T03:00:00.000Z',
};
const P4_PAYLOAD = rulePayload('헬스 응답에 메모리 사용량 포함');
const P4: Proposal = {
  ...base,
  id: ID.p4,
  displayId: 'PRP-004',
  kind: 'rule_new',
  payload: P4_PAYLOAD,
  diff: { before: null, after: P4_PAYLOAD },
  state: 'rejected',
  readAt: '2026-10-15T09:10:00.000Z',
  decision: { at: '2026-10-15T09:20:00.000Z', by: HUMAN, rejectReason: '범위 밖' },
  createdAt: '2026-10-15T09:00:00.000Z',
};
const P5_PAYLOAD = rulePayload('헬스 응답에 가동 시간 포함');
const P5_EDITED = { ...P5_PAYLOAD, title: '헬스 응답에 가동 시간(초) 포함' };
const P5: Proposal = {
  ...base,
  id: ID.p5,
  displayId: 'PRP-005',
  kind: 'rule_new',
  payload: P5_PAYLOAD,
  diff: { before: null, after: P5_PAYLOAD },
  state: 'approved',
  readAt: '2026-10-15T08:10:00.000Z',
  decision: {
    at: '2026-10-15T08:20:00.000Z',
    by: HUMAN,
    appliedRef: { entity: 'Rule', id: ID.rule },
    editedPayload: P5_EDITED,
  },
  createdAt: '2026-10-15T08:00:00.000Z',
};
const PROPOSALS = [P1, P3, P4, P5];

const REQUIREMENT: Requirement = {
  id: ID.req,
  displayId: 'REQ-001',
  text: '헬스 엔드포인트는 서버 상태를 알려 준다',
  author: HUMAN,
  normState: 'approved',
  unrulable: null,
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
  updatedBy: HUMAN,
  deletedAt: null,
};

const RULE: Rule = {
  id: ID.rule,
  displayId: 'RULE-001',
  title: String(P1_PAYLOAD.title),
  statement: String(P1_PAYLOAD.statement),
  kind: 'business',
  checkKinds: ['test'],
  parentRequirementId: ID.req,
  parentDetachedAt: null,
  builtin: false,
  targetBlockIds: [],
  risk: null,
  contractId: null,
  author: P1.author,
  normState: 'approved',
  createdAt: '2026-10-16T05:00:00.000Z',
  updatedAt: '2026-10-16T05:00:00.000Z',
  deletedAt: null,
};

const hash = (c: string): string => c.repeat(64);
const LOG_REJECT: ApprovalLogEntry = {
  seq: 1,
  at: '2026-10-15T09:20:00.000Z',
  action: 'reject',
  actor: HUMAN,
  targetRef: { entity: 'Proposal', id: ID.p4 },
  clientId: 'pipe-1',
  detail: { reason: '범위 밖' },
  prevHash: hash('0'),
  hash: hash('a'),
};
const LOG_EDITED: ApprovalLogEntry = {
  seq: 2,
  at: '2026-10-15T08:20:00.000Z',
  action: 'approve_edited',
  actor: HUMAN,
  targetRef: { entity: 'Proposal', id: ID.p5 },
  clientId: 'pipe-1',
  detail: {
    diff: { before: P5_PAYLOAD, after: P5_EDITED },
    appliedRef: { entity: 'Rule', id: ID.rule },
  },
  prevHash: hash('a'),
  hash: hash('b'),
};
const LOG_APPROVE: ApprovalLogEntry = {
  seq: 3,
  at: '2026-10-16T05:00:00.000Z',
  action: 'approve',
  actor: HUMAN,
  targetRef: { entity: 'Proposal', id: ID.p1 },
  clientId: 'pipe-1',
  detail: { appliedRef: { entity: 'Rule', id: ID.rule } },
  prevHash: hash('b'),
  hash: hash('c'),
};
const LOG_RESULT: ApprovalLogListResult = {
  entries: [LOG_REJECT, LOG_EDITED],
  chain: { valid: true, brokenAtSeq: null, reason: null },
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
const countOf = (proposals: readonly Proposal[]): ProposalCountResult => {
  const pending = proposals.filter((p) => p.state === 'pending');
  return {
    pending: pending.length,
    pendingByKind: Object.fromEntries(
      KINDS.map((kind) => [kind, pending.filter((p) => p.kind === kind).length]),
    ) as Record<ProposalKind, number>,
  };
};

const setup = async (page: Page, proposals: readonly Proposal[] = PROPOSALS): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'proposal.count': { result: countOf(proposals) },
      'proposal.list': { result: { proposals: [...proposals] } },
      'proposal.markRead': { result: { proposal: { ...P1, readAt: '2026-10-16T05:00:00.000Z' } } },
      'requirement.get': { result: { requirement: REQUIREMENT } },
      'approvalLog.list': { result: LOG_RESULT },
    },
  });
  await page.goto('/');
  await expect(page.getByTestId('sidebar-project')).toHaveText(PROJECT.name);
  await page.getByTestId('todo-button').click();
  await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'todo');
  return bive;
};

const card = (page: Page, displayId: string): Locator =>
  page.locator(`[data-testid="card"][data-id="${displayId}"]`);
const detail = (page: Page): Locator => page.getByTestId('todo-detail');
const action = (page: Page, id: 'reject' | 'edit' | 'approve'): Locator =>
  page.getByTestId(`action-${id}`);
const callsOf = async (bive: BiveMock, method: string): Promise<unknown[]> =>
  (await bive.calls()).filter((c) => c.method === method).map((c) => c.params);

/** 상세 구획 testId를 DOM 순서대로. */
const sectionOrder = (page: Page): Promise<string[]> =>
  detail(page)
    .locator('[data-detail-section]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-detail-section') ?? ''));

/** 화면 상태 스크린샷 (artifacts/screens/SCR-17/<이름>.png) + 화면 문구 규칙 검사 (screens.md 1.1). */
const snapshot = async (page: Page, name: string): Promise<void> => {
  const file = path.join(SCREENSHOT_DIR, 'SCR-17', `${name}.png`);
  await mkdir(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: true });
  expect(findForbiddenText(await collectVisibleText(page))).toEqual([]);
};

/** 처리 상태 필터 값을 고른다 (기본 '대기'). */
const chooseStates = async (page: Page, states: readonly string[]): Promise<void> => {
  const chip = page.getByTestId('filter-chip-state');
  await chip.getByTestId('filter-chip-button').click();
  for (const value of ['pending', 'approved', 'rejected']) {
    const box = chip.locator(`[data-testid="filter-option"][data-value="${value}"] input`);
    if (states.includes(value)) await box.check();
    else await box.uncheck();
  }
  await page.keyboard.press('Escape');
};

test.describe('목록 기본 · 빈 상태 (수용 기준 1)', () => {
  test('기본: 카드 1줄 종류 태그 · 제목, 2줄 ID · 예외 · 시각, 안 읽음 점', async ({ page }) => {
    await setup(page);
    await expectScreen(page, 'SCR-17', '기본');

    const rule = card(page, 'PRP-001');
    await expect(rule.getByTestId('card-tag')).toHaveText('신규');
    await expect(rule.getByTestId('card-title')).toHaveText(String(P1_PAYLOAD.title));
    await expect(rule.getByTestId('card-id')).toHaveText('PRP-001');
    await expect(rule.locator('time')).toHaveAttribute('datetime', P1.createdAt);
    await expect(rule.getByTestId('card-unread')).toBeVisible();
    await expect(card(page, 'PRP-003').getByTestId('card-tag')).toHaveText('요구사항');
    await expect(card(page, 'PRP-003').getByTestId('card-unread')).toHaveCount(0);
    // 처리됨은 기본 '대기' 필터에서 빠진다
    await expect(page.getByTestId('card-id')).toHaveText(['PRP-003', 'PRP-001']);
  });

  test('빈: 대기 항목 없음', async ({ page }) => {
    await setup(page, []);
    await expectScreen(page, 'SCR-17', '빈');
  });
});

test.describe('상세 (수용 기준 2)', () => {
  test('출처 → 에이전트 제안(변경 내용 · 근거 · 생성 주체) → 승인하면 → 거절하면, 오른쪽 아래 떠 있는 버튼', async ({
    page,
  }) => {
    const bive = await setup(page);
    await card(page, 'PRP-001').click();
    await expect(detail(page)).toHaveAttribute('data-selected-id', 'PRP-001');

    // 구획 순서와 제목
    await expect.poll(() => sectionOrder(page)).toEqual(DETAIL_SECTIONS.map((s) => s.id));
    for (const { id, title } of DETAIL_SECTIONS) {
      await expect(page.getByRole('region', { name: title, exact: true })).toHaveAttribute(
        'data-testid',
        `detail-${id}`,
      );
    }
    await expect(page.getByTestId('detail-title')).toHaveText(String(P1_PAYLOAD.title));
    await expect(page.getByTestId('detail-id')).toHaveText('PRP-001');

    // 출처: 생성 경로 + 부모 요구사항(requirement.get 결과)
    await expect(page.getByTestId('source-path')).toContainText('규칙 자동 생성');
    await expect(page.getByTestId('source-parent')).toContainText(`REQ-001 · ${REQUIREMENT.text}`);
    expect(await callsOf(bive, 'requirement.get')).toContainEqual({
      projectId: PROJECT_ID,
      id: ID.req,
    });

    // 에이전트 제안: 변경 내용(신규 → 추가만) · 근거 · 생성 주체(에이전트 · 역할명)
    const diff = page.getByTestId('proposal-diff');
    await expect(diff.getByTestId('diff-row')).toHaveCount(5);
    await expect(diff.locator('[data-key="title"] [data-testid="diff-after"]')).toHaveText(
      String(P1_PAYLOAD.title),
    );
    await expect(diff.locator('[data-key="kind"]')).toContainText('비즈니스');
    await expect(diff.locator('[data-key="checkKinds"]')).toContainText('인수 테스트');
    await expect(diff.locator('[data-key="parentRequirementId"]')).toContainText('REQ-001');
    await expect(diff.getByTestId('diff-before')).toHaveCount(0);
    await expect(page.getByTestId('proposal-rationale')).toContainText(P1.rationale);
    await expect(page.getByTestId('proposal-author')).toContainText('에이전트 · 규칙 작성');
    await expect(page.getByTestId('detail-if-approve')).toContainText('규칙 추가');
    await expect(page.getByTestId('detail-if-reject')).toContainText('규범 변경 없음');
    // 예상 비용 미표시
    await expect(detail(page).getByText(/비용/)).toHaveCount(0);

    // [거절] [수정] [승인] 순서, 상세 오른쪽 아래에 떠 있음
    const bar = page.getByTestId('floating-actions');
    await expect(bar.getByRole('button')).toHaveText([...ACTION_LABELS]);
    await expect(bar).toHaveCSS('position', 'absolute');
    const pane = await detail(page).boundingBox();
    const box = await bar.boundingBox();
    if (pane === null || box === null) throw new Error('상세 · 버튼 영역 없음');
    const right = pane.x + pane.width - (box.x + box.width);
    const bottom = pane.y + pane.height - (box.y + box.height);
    expect(right).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThan(40);
    expect(bottom).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThan(40);
    // 버튼 묶음의 가운데가 상세의 오른쪽 아래 사분면에 있다
    expect(box.x + box.width / 2).toBeGreaterThan(pane.x + pane.width / 2);
    expect(box.y + box.height / 2).toBeGreaterThan(pane.y + pane.height / 2);
    await snapshot(page, '상세');

    // 처리하지 않으면 처리 RPC를 부르지 않는다
    for (const method of ['proposal.approve', 'proposal.amend', 'proposal.reject']) {
      expect(await callsOf(bive, method)).toEqual([]);
    }
  });

  test('요구사항 제안: 부모 없음, 변경 내용은 문장', async ({ page }) => {
    const bive = await setup(page);
    await card(page, 'PRP-003').click();
    await expect.poll(() => sectionOrder(page)).toEqual(DETAIL_SECTIONS.map((s) => s.id));
    await expect(page.getByTestId('source-path')).toContainText('채팅 지시');
    await expect(page.getByTestId('source-parent')).toHaveCount(0);
    await expect(page.getByTestId('proposal-author')).toContainText('에이전트 · 채팅');
    await expect(
      page.getByTestId('proposal-diff').locator('[data-key="text"] [data-testid="diff-after"]'),
    ).toHaveText('헬스 응답에 호스트 이름을 포함한다');
    await expect(page.getByTestId('detail-if-approve')).toContainText('요구사항 추가');
    expect(await callsOf(bive, 'requirement.get')).toEqual([]);
  });
});

test.describe('수정 · 거절 입력 카드 (수용 기준 3)', () => {
  test('[수정]: 대화 끝 카드 · 자동 스크롤 · 포커스, 빈 문장은 문구와 확인 비활성, 수정 후 승인 1회', async ({
    page,
  }) => {
    // 상세가 화면보다 길어 스크롤이 필요한 높이
    await page.setViewportSize({ width: 1440, height: 560 });
    const bive = await setup(page);
    await card(page, 'PRP-001').click();
    await expect(page.getByTestId('detail-if-reject')).toBeVisible();
    const scroller = page.getByTestId('proposal-detail');
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);

    await action(page, 'edit').click();
    const editCard = page.getByTestId('edit-card');
    await expect(editCard).toBeVisible();
    await expect(action(page, 'edit')).toHaveAttribute('aria-pressed', 'true');
    // 대화 끝 카드: 상세 내용의 마지막 요소
    expect(await editCard.evaluate((el) => el.parentElement?.lastElementChild === el)).toBe(true);
    await expect(editCard).toBeInViewport({ ratio: 1 });
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // 자동 스크롤은 카드 끝을 떠 있는 버튼 위에 둔다 (카드의 확인 버튼이 가려지지 않음)
    const cardBox = await editCard.boundingBox();
    const barBox = await page.getByTestId('floating-actions').boundingBox();
    if (cardBox === null || barBox === null) throw new Error('카드 · 버튼 영역 없음');
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(barBox.y);
    const title = page.getByTestId('edit-title');
    await expect(title).toBeFocused();
    await expect(title).toHaveValue(String(P1_PAYLOAD.title));
    await expect(page.getByTestId('edit-statement')).toHaveValue(String(P1_PAYLOAD.statement));
    await snapshot(page, '수정');

    // 빈 문장: 화면 문구 + 확인 비활성
    const confirm = page.getByTestId('edit-confirm');
    await title.fill('   ');
    await expect(page.getByTestId('edit-error')).toHaveText('제목 비어 있음');
    await expect(title).toHaveAttribute('aria-invalid', 'true');
    await expect(confirm).toBeDisabled();
    await title.fill('헬스 응답에 UTC 서버 시각 포함');
    await expect(page.getByTestId('edit-error')).toHaveCount(0);
    await expect(confirm).toBeEnabled();

    // 고친 진술이 EARS 형식이 아니면 화면 문구 + 확인 비활성 (조건 안 낱말 shall · 여러 줄 · 형식 없음)
    const statement = page.getByTestId('edit-statement');
    for (const bad of [
      'WHEN A PAYMENT THAT THE BUYER SHALL CONFIRM EXPIRES THE SYSTEM SHALL CANCEL',
      'WHEN 결제\n취소 THE SYSTEM SHALL 환불',
      '헬스 요청을 받으면 시스템은 시각을 응답한다',
    ]) {
      await statement.fill(bad);
      await expect(page.getByTestId('edit-error')).toHaveText(
        '진술 형식 오류 (WHEN 조건 THE SYSTEM SHALL 응답)',
      );
      await expect(statement).toHaveAttribute('aria-invalid', 'true');
      await expect(confirm).toBeDisabled();
      await statement.press('Control+Enter');
    }
    expect(await callsOf(bive, 'proposal.amend')).toEqual([]);
    await statement.fill(String(P1_PAYLOAD.statement));
    await expect(page.getByTestId('edit-error')).toHaveCount(0);
    await expect(confirm).toBeEnabled();

    // 처리 뒤 목록 · 배지 응답
    const approved: Proposal = {
      ...P1,
      readAt: '2026-10-16T05:00:00.000Z',
      state: 'approved',
      decision: {
        at: '2026-10-16T05:00:00.000Z',
        by: HUMAN,
        appliedRef: { entity: 'Rule', id: ID.rule },
      },
    };
    await bive.setResponse('proposal.amend', {
      result: {
        proposal: approved,
        applied: { entity: 'Rule', rule: RULE },
        approvalLog: LOG_APPROVE,
      },
      delayMs: 1500,
    });
    await bive.setResponse('proposal.list', { result: { proposals: [approved, P3, P4, P5] } });
    await bive.setResponse('proposal.count', { result: countOf([approved, P3, P4, P5]) });
    const listCalls = (await callsOf(bive, 'proposal.list')).length;
    const countCalls = (await callsOf(bive, 'proposal.count')).length;

    // 저장 중 재전송 없음: 두 번 눌러도 1회
    await confirm.click();
    await expect(page.getByTestId('floating-actions-busy')).toHaveText('처리 중');
    await expect(action(page, 'approve')).toBeDisabled();
    await confirm.click({ force: true });
    await expect(detail(page)).toHaveAttribute('data-selected-id', 'none');
    expect(await callsOf(bive, 'proposal.amend')).toEqual([
      {
        projectId: PROJECT_ID,
        id: ID.p1,
        author: HUMAN,
        edited: { ...P1_PAYLOAD, title: '헬스 응답에 UTC 서버 시각 포함' },
      },
    ]);
    expect(await callsOf(bive, 'proposal.approve')).toEqual([]);

    // 처리된 항목은 대기 필터에서 빠지고 목록 · 배지를 다시 읽는다
    await expect(page.getByTestId('card-id')).toHaveText(['PRP-003']);
    await expect(page.getByTestId('todo-badge')).toHaveText('1');
    expect((await callsOf(bive, 'proposal.list')).length).toBeGreaterThan(listCalls);
    expect((await callsOf(bive, 'proposal.count')).length).toBeGreaterThan(countCalls);
    await expect(detail(page).getByTestId('empty-state')).toHaveText('선택 항목 없음');
  });

  test('[거절]: 대화 끝 카드 · 포커스, 사유가 비면 확인 비활성, 조합 중 키는 가로채지 않음, 거절 1회', async ({
    page,
  }) => {
    const bive = await setup(page);
    await card(page, 'PRP-001').click();
    await action(page, 'reject').click();

    const rejectCard = page.getByTestId('reject-card');
    await expect(rejectCard).toBeVisible();
    expect(await rejectCard.evaluate((el) => el.parentElement?.lastElementChild === el)).toBe(true);
    await expect(rejectCard).toBeInViewport();
    const reason = page.getByTestId('reject-reason');
    await expect(reason).toBeFocused();
    const confirm = page.getByTestId('reject-confirm');
    await expect(confirm).toBeDisabled();
    await reason.fill('  \n ');
    await expect(confirm).toBeDisabled();
    // 공백만이면 단축키로도 보내지 않는다
    await reason.press('Control+Enter');
    expect(await callsOf(bive, 'proposal.reject')).toEqual([]);
    await snapshot(page, '거절');

    await reason.fill('헬스 응답 범위 밖');
    await expect(confirm).toBeEnabled();

    // 한글 조합 중의 Enter · Esc는 조합 확정용이라 확인 · 닫기로 쓰지 않는다
    const composing = (key: string, ctrlKey: boolean): Promise<void> =>
      reason.evaluate(
        (el, init) =>
          void el.dispatchEvent(
            new KeyboardEvent('keydown', {
              ...init,
              bubbles: true,
              cancelable: true,
              isComposing: true,
            }),
          ),
        { key, ctrlKey },
      );
    await composing('Enter', true);
    await composing('Escape', false);
    await expect(rejectCard).toBeVisible();
    expect(await callsOf(bive, 'proposal.reject')).toEqual([]);

    const rejected: Proposal = {
      ...P1,
      state: 'rejected',
      decision: { at: '2026-10-16T05:00:00.000Z', by: HUMAN, rejectReason: '헬스 응답 범위 밖' },
    };
    await bive.setResponse('proposal.reject', {
      result: {
        proposal: rejected,
        approvalLog: { ...LOG_APPROVE, action: 'reject', detail: { reason: '헬스 응답 범위 밖' } },
      },
      delayMs: 1500,
    });
    await bive.setResponse('proposal.list', { result: { proposals: [rejected, P3, P4, P5] } });
    await bive.setResponse('proposal.count', { result: countOf([rejected, P3, P4, P5]) });
    // 단축키 확인 + 버튼 재클릭: 1회만
    await reason.press('Control+Enter');
    await confirm.click({ force: true });
    await expect(detail(page)).toHaveAttribute('data-selected-id', 'none');
    expect(await callsOf(bive, 'proposal.reject')).toEqual([
      { projectId: PROJECT_ID, id: ID.p1, author: HUMAN, reason: '헬스 응답 범위 밖' },
    ]);
    await expect(page.getByTestId('card-id')).toHaveText(['PRP-003']);
    await expect(page.getByTestId('todo-badge')).toHaveText('1');
  });

  test('처리 중 다른 카드를 골라도 그 선택은 유지되고, 돌아와도 같은 제안을 다시 보내지 않는다', async ({
    page,
  }) => {
    const bive = await setup(page);
    const approved: Proposal = {
      ...P1,
      state: 'approved',
      decision: {
        at: '2026-10-16T05:00:00.000Z',
        by: HUMAN,
        appliedRef: { entity: 'Rule', id: ID.rule },
      },
    };
    await bive.setResponse('proposal.approve', {
      result: {
        proposal: approved,
        applied: { entity: 'Rule', rule: RULE },
        approvalLog: LOG_APPROVE,
      },
      delayMs: 2500,
    });
    await bive.setResponse('proposal.list', { result: { proposals: [approved, P3, P4, P5] } });
    await bive.setResponse('proposal.count', { result: countOf([approved, P3, P4, P5]) });

    await card(page, 'PRP-001').click();
    await action(page, 'approve').click();
    await expect(page.getByTestId('floating-actions-busy')).toBeVisible();

    // 처리 중 다른 카드 → 그 상세는 처리 중이 아님
    await card(page, 'PRP-003').click();
    await expect(detail(page)).toHaveAttribute('data-selected-id', 'PRP-003');
    await expect(action(page, 'approve')).toBeEnabled();
    await expect(page.getByTestId('floating-actions-busy')).toHaveCount(0);

    // 처리 중인 제안으로 돌아오면 여전히 처리 중이고 다시 보낼 수 없다
    await card(page, 'PRP-001').click();
    await expect(page.getByTestId('floating-actions-busy')).toBeVisible();
    await expect(action(page, 'approve')).toBeDisabled();
    await action(page, 'approve').click({ force: true });

    // 다시 다른 카드를 고른 채로 앞 요청이 끝나면 그 선택은 풀리지 않는다
    await card(page, 'PRP-003').click();
    await expect(page.getByTestId('card-id')).toHaveText(['PRP-003']);
    await expect(page.getByTestId('todo-badge')).toHaveText('1');
    await expect(detail(page)).toHaveAttribute('data-selected-id', 'PRP-003');
    await expect(page.getByTestId('detail-title')).toHaveText('헬스 응답에 호스트 이름을 포함한다');
    expect(await callsOf(bive, 'proposal.approve')).toEqual([
      { projectId: PROJECT_ID, id: ID.p1, author: HUMAN },
    ]);
  });

  test('Esc로 입력 카드 닫기, [승인]은 바로 사람 주체 승인 1회', async ({ page }) => {
    const bive = await setup(page);
    await card(page, 'PRP-003').click();
    await action(page, 'edit').click();
    await expect(page.getByTestId('edit-text')).toBeFocused();
    await page.getByTestId('edit-text').press('Escape');
    await expect(page.getByTestId('edit-card')).toHaveCount(0);

    const approved: Proposal = {
      ...P3,
      state: 'approved',
      decision: {
        at: '2026-10-16T05:00:00.000Z',
        by: HUMAN,
        appliedRef: { entity: 'Requirement', id: ID.req },
      },
    };
    await bive.setResponse('proposal.approve', {
      result: {
        proposal: approved,
        applied: { entity: 'Requirement', requirement: REQUIREMENT },
        approvalLog: { ...LOG_APPROVE, targetRef: { entity: 'Proposal', id: ID.p3 } },
      },
      delayMs: 1500,
    });
    await bive.setResponse('proposal.list', { result: { proposals: [P1, approved, P4, P5] } });
    await bive.setResponse('proposal.count', { result: countOf([P1, approved, P4, P5]) });
    await action(page, 'approve').click();
    await action(page, 'approve').click({ force: true });
    await expect(detail(page)).toHaveAttribute('data-selected-id', 'none');
    expect(await callsOf(bive, 'proposal.approve')).toEqual([
      { projectId: PROJECT_ID, id: ID.p3, author: HUMAN },
    ]);
    await expect(page.getByTestId('card-id')).toHaveText(['PRP-001']);
    await expect(page.getByTestId('todo-badge')).toHaveText('1');
  });

  test('이미 처리된 제안(-32009): 문구를 보이고 목록 · 배지를 다시 읽어 처리 기록을 보인다', async ({
    page,
  }) => {
    const bive = await setup(page);
    await card(page, 'PRP-001').click();
    await bive.setResponse('proposal.approve', {
      error: { code: -32009, message: '이미 처리된 제안입니다' },
    });
    const elsewhere: Proposal = {
      ...P1,
      state: 'rejected',
      decision: { at: '2026-10-16T04:00:00.000Z', by: HUMAN, rejectReason: '중복' },
    };
    await bive.setResponse('proposal.list', { result: { proposals: [elsewhere, P3, P4, P5] } });
    await bive.setResponse('approvalLog.list', {
      result: {
        entries: [
          {
            ...LOG_REJECT,
            targetRef: { entity: 'Proposal', id: ID.p1 },
            detail: { reason: '중복' },
          },
        ],
        chain: { valid: true, brokenAtSeq: null, reason: null },
      },
    });
    const listCalls = (await callsOf(bive, 'proposal.list')).length;
    await action(page, 'approve').click();

    await expect(page.getByTestId('detail-error')).toHaveText('처리 불가 (상태 변경)');
    await expect
      .poll(async () => (await callsOf(bive, 'proposal.list')).length)
      .toBeGreaterThan(listCalls);
    await expect(page.getByTestId('floating-actions')).toHaveCount(0);
    await expect(page.getByTestId('record-reason')).toContainText('중복');
    expect(await callsOf(bive, 'proposal.approve')).toHaveLength(1);
  });
});

test.describe('필터 · 처리 기록 (수용 기준 4)', () => {
  test('필터 칩 4종, 위험도 0건 비활성, 처리됨 필터에서 승인 · 거절 기록(수정 내용 · 주체 · 사유)', async ({
    page,
  }) => {
    const bive = await setup(page);
    for (const { id, label } of APPROVAL_FILTERS) {
      await expect(page.getByTestId(`filter-chip-${id}`)).toContainText(label);
    }
    await expect(
      page.getByTestId('filter-chip-risk').getByTestId('filter-chip-button'),
    ).toBeDisabled();

    await chooseStates(page, ['approved', 'rejected']);
    await expect(page.getByTestId('card-id')).toHaveText(['PRP-004', 'PRP-005']);
    await expect(card(page, 'PRP-004').getByTestId('card-exception')).toHaveText('거절');

    // 거절 기록: 처리 · 주체 · 시각 · 사유, 처리 버튼 없음
    await card(page, 'PRP-004').click();
    await expect.poll(() => sectionOrder(page)).toEqual(PROCESSED_DETAIL_SECTIONS.map((s) => s.id));
    const record = page.getByTestId('decision-record');
    await expect(record).toHaveAttribute('data-action', 'reject');
    await expect(page.getByTestId('record-action')).toContainText('거절');
    await expect(page.getByTestId('record-actor')).toContainText('사람');
    await expect(page.getByTestId('record-time').locator('time')).toHaveAttribute(
      'datetime',
      LOG_REJECT.at,
    );
    await expect(page.getByTestId('record-reason')).toContainText('범위 밖');
    await expect(page.getByTestId('record-diff')).toHaveCount(0);
    await expect(page.getByTestId('floating-actions')).toHaveCount(0);
    await expect(page.getByTestId('record-chain-broken')).toHaveCount(0);
    expect(await callsOf(bive, 'approvalLog.list')).toContainEqual({
      projectId: PROJECT_ID,
      targetRef: { entity: 'Proposal', id: ID.p4 },
    });

    // 수정 후 승인 기록: 수정 내용(바뀐 제목만 이전 · 이후) · 주체
    await card(page, 'PRP-005').click();
    await expect(record).toHaveAttribute('data-action', 'approve_edited');
    await expect(page.getByTestId('record-action')).toContainText('수정 후 승인');
    await expect(page.getByTestId('record-actor')).toContainText('사람');
    await expect(page.getByTestId('record-reason')).toHaveCount(0);
    const recordDiff = page.getByTestId('record-diff');
    await expect(recordDiff.getByTestId('diff-row')).toHaveCount(1);
    await expect(recordDiff.getByTestId('diff-before')).toContainText(String(P5_PAYLOAD.title));
    await expect(recordDiff.getByTestId('diff-after')).toContainText(P5_EDITED.title);
    await expect(page.getByTestId('floating-actions')).toHaveCount(0);
    await snapshot(page, '처리됨');
  });

  test('승인 기록 체인 검증이 깨졌으면 처리 기록에 예외 글자', async ({ page }) => {
    const bive = await setup(page);
    await bive.setResponse('approvalLog.list', {
      result: { ...LOG_RESULT, chain: { valid: false, brokenAtSeq: 2, reason: 'hash_mismatch' } },
    });
    await chooseStates(page, ['rejected']);
    await card(page, 'PRP-004').click();
    await expect(page.getByTestId('record-reason')).toContainText('범위 밖');
    await expect(page.getByTestId('record-chain-broken')).toHaveText('승인 기록 검증 실패');
  });
});
