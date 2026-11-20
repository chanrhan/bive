// 카드 2줄 배치 (#179 검토 2회차, ADR-090, screens.md 1.4 카드): 스크롤바가 자리를 차지하는 실행.
// Playwright는 기본으로 `--hide-scrollbars`를 붙여 스크롤바가 폭을 차지하지 않는다. 이 파일은 그것을 빼고 돌아
// Linux · Windows의 Electron 창처럼 목록이 스크롤되면 스크롤바(약 15px)가 카드 폭을 줄인다.
// - 400px 목록(1280 · 1440px 창)의 카드는 이전 배치 그대로: 2줄째가 한 줄, ID 온전, ID · 보조 문구 · 예외가 간격 8px로
//   이어지고, 카드 높이가 이전과 같다
// - 좁은 목록(1024 ~ 1280px 창)에서도 ID는 말줄임되지 않고 예외 배지는 통째로 보인다(`listPaneOverflow`)
// - 시각이 있는 카드(요구사항 SCR-02 · 승인 대기 SCR-17, #191): 400px 목록에서 시각은 줄 오른쪽 끝(안 읽음 점이 있으면
//   점 앞 8px)이고 2줄째가 한 줄 · 카드 높이가 이전과 같다. 좁은 목록에서 보조 문구 · 시각은 최소 3em(모자라면 다음 줄로),
//   안 읽음 점은 혼자 다음 줄 왼쪽에 남지 않고 시각과 같은 줄 오른쪽 끝에 붙는다
// 데이터는 규칙 · 요구사항 · 승인 대기 화면의 가짜 브리지 응답뿐이다 (테스트 전용 데이터, NFR-03).
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type {
  Proposal,
  ProposalCountResult,
  ProposalKind,
  Requirement,
  Rule,
  RuleWithJudgment,
} from '@bive/shared';
import { expect, type Locator, type Page, test } from '@playwright/test';

import { REQUIREMENTS } from './checklists/scr-02.js';
import { PROJECT, RULES } from './checklists/scr-03.js';
import { mockBive } from './support/bive-mock.js';
import { SCREENSHOT_DIR } from './support/expectScreen.js';
import { listPaneOverflow, NARROW_WIDTHS, WIDE_WIDTH } from './support/overflow.js';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
test.use({
  launchOptions: {
    ...(executablePath === undefined || executablePath === '' ? {} : { executablePath }),
    ignoreDefaultArgs: ['--hide-scrollbars'],
  },
});

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;

/** 이전(`main`) 400px 목록에서 잰 규칙 카드 높이 (2줄 카드, 테두리 포함) */
const CARD_HEIGHT = 59;
/** 칸 사이 간격 (--space-2) */
const GAP = 8;

const STATUSES = ['pass', 'fail', 'unjudged', 'quarantined', 'needs_recheck'] as const;
const CONDITIONS = [
  'WHEN 사용자가 장바구니에서 상품을 삭제하면',
  'WHEN 결제가 실패하면',
  'WHEN 관리자가 주문 목록을 내려받으면',
  'WHEN 세션이 30분 동안 쓰이지 않으면',
] as const;

/** 목록이 스크롤되도록 더하는 규칙 14개 (RULE-101 ~ RULE-114). RULE-109는 재검증 필요 · 잠정. */
const EXTRA: RuleWithJudgment[] = Array.from({ length: 14 }, (_, i) => {
  const n = 101 + i;
  const sample = RULES[0]?.rule;
  if (sample === undefined) throw new Error('규칙 시험 데이터 없음');
  const rule: Rule = {
    ...sample,
    id: `01JC0000000000000000000${n}`,
    displayId: `RULE-${n}`,
    title: `시험 규칙 ${n}`,
    statement: `${CONDITIONS[i % CONDITIONS.length] ?? ''} THE SYSTEM SHALL 기록을 남긴다`,
    normState: n === 109 ? 'provisional' : 'approved',
  };
  const status = n === 109 ? 'needs_recheck' : (STATUSES[i % STATUSES.length] ?? 'pass');
  return { rule, judgment: { status, latest: null } };
});

const openRules = async (page: Page, rules: readonly RuleWithJudgment[]): Promise<void> => {
  await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'rule.list': { result: { rules: [...rules] } },
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '규칙', exact: true }).click();
  await expect(page.getByTestId('card').first()).toBeVisible();
};

/** 목록이 스크롤되도록 만드는 요구사항 16개 (REQ-101 ~ REQ-116, 테스트 전용 데이터). 예외 조합을 돌려 가며 쓰고
 *  REQ-1234는 4자리 ID · 규칙화 불가 · 잠정(2줄째가 가장 긴 요구사항 카드). */
const MANY_REQUIREMENTS: Requirement[] = Array.from({ length: 16 }, (_, i) => {
  const sample = REQUIREMENTS[0];
  if (sample === undefined) throw new Error('요구사항 시험 데이터 없음');
  const n = 101 + i;
  const day = String(1 + i).padStart(2, '0');
  return {
    ...sample,
    id: `01JB0000000000000000000${n}`,
    displayId: i === 5 ? 'REQ-1234' : `REQ-${n}`,
    text: `시험 요구사항 ${n} 로그인 실패 잠금`,
    normState: i % 2 === 0 || i === 5 ? 'provisional' : 'approved',
    unrulable: i % 3 === 0 || i === 5 ? { reason: '측정 기준 없음' } : null,
    updatedAt: `2026-10-${day}T03:20:00.000Z`,
  };
});

const REQ_ID = '01JBVE000000000000000000R1';

/** 목록이 스크롤되도록 만드는 승인 대기 제안 16개 (PRP-101 ~ PRP-116, 테스트 전용 데이터).
 *  위험 높음 · 구현 중 제안 · 안 읽음을 돌려 가며 쓰고 PRP-1234는 4자리 ID · 위험 높음 · 구현 중 제안 · 안 읽음. */
const MANY_PROPOSALS: Proposal[] = Array.from({ length: 16 }, (_, i) => {
  const n = 101 + i;
  const day = String(1 + i).padStart(2, '0');
  const payload = {
    title: `헬스 응답 항목 ${n}`,
    statement: 'WHEN 클라이언트가 헬스 체크를 요청하면 THE SYSTEM SHALL 응답한다',
    kind: 'business',
    checkKinds: ['test'],
    parentRequirementId: REQ_ID,
  };
  return {
    id: `01JBVE0000000000000000P${n}`,
    displayId: i === 4 ? 'PRP-1234' : `PRP-${n}`,
    kind: 'rule_new',
    targetRef: { entity: 'Requirement', id: REQ_ID },
    payload,
    diff: { before: null, after: payload },
    rationale: '요구사항 문장에서 검사 가능한 규칙을 뽑음',
    author: { kind: 'agent', role: 'rule-writer' },
    source: i % 4 === 0 ? 'implementation' : 'rule_generation',
    risk: i % 3 === 0 || i === 4 ? 'high' : null,
    readAt: i % 2 === 0 ? null : '2026-10-20T03:30:00.000Z',
    state: 'pending',
    decision: null,
    adrId: null,
    runId: null,
    createdAt: `2026-10-${day}T01:00:00.000Z`,
  };
});

const PROPOSAL_KINDS: ProposalKind[] = [
  'requirement_new',
  'requirement_change',
  'rule_new',
  'rule_change',
  'contract_new',
  'design_change',
  'rule_title_change',
  'contract_change',
];

const proposalCount = (proposals: readonly Proposal[]): ProposalCountResult => ({
  pending: proposals.length,
  pendingByKind: Object.fromEntries(
    PROPOSAL_KINDS.map((kind) => [kind, proposals.filter((p) => p.kind === kind).length]),
  ) as Record<ProposalKind, number>,
});

const openRequirements = async (page: Page): Promise<Locator> => {
  await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'requirement.list': { result: { requirements: MANY_REQUIREMENTS } },
      'rule.list': { result: { rules: [] } },
      'judgment.list': { result: { judgments: [] } },
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '요구사항', exact: true }).click();
  await expect(page.getByTestId('card')).toHaveCount(MANY_REQUIREMENTS.length);
  return page.getByTestId('requirements-list-pane');
};

const openTodo = async (page: Page): Promise<Locator> => {
  await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: PROJECT } },
      'proposal.count': { result: proposalCount(MANY_PROPOSALS) },
      'proposal.list': { result: { proposals: MANY_PROPOSALS } },
      'approvalLog.list': {
        result: { entries: [], chain: { valid: true, brokenAtSeq: null, reason: null } },
      },
    },
  });
  await page.goto('/');
  await page.getByTestId('todo-button').click();
  await expect(page.getByTestId('card')).toHaveCount(MANY_PROPOSALS.length);
  return page.getByTestId('todo-list-pane');
};

/** 시각이 있는 카드의 화면: 요구사항(시각) · 승인 대기(시각 · 안 읽음 점) */
const TIMED_SCREENS = [
  ['요구사항', openRequirements],
  ['승인 대기', openTodo],
] as const;

const listPane = (page: Page) => page.getByTestId('rules-list-pane');

const shot = async (page: Page, name: string): Promise<void> => {
  const dir = path.join(SCREENSHOT_DIR, '..', 'layout');
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
};

/** 목록이 스크롤되고 스크롤바가 폭을 차지한다(이 파일의 전제). */
const expectScrollbar = async (page: Page): Promise<void> => {
  const items = page.getByTestId('list-items');
  const { bar, scrolls } = await items.evaluate((el: HTMLElement) => ({
    bar: el.offsetWidth - el.clientWidth - el.clientLeft * 2,
    scrolls: el.scrollHeight > el.clientHeight,
  }));
  expect(scrolls, '목록 스크롤').toBe(true);
  expect(bar, '스크롤바 폭').toBeGreaterThan(0);
};

/**
 * 400px 목록의 이전 배치: 카드마다 2줄째가 한 줄이고 카드 높이가 이전과 같으며, ID가 온전하고,
 * ID → 보조 문구 → 예외가 간격 8px로 바로 이어진다(보조 문구가 남는 폭을 다 차지해 예외를 오른쪽으로 밀지 않음).
 * 시각 · 안 읽음 점은 줄 오른쪽 끝에 붙는다: 마지막 칸의 오른쪽 끝 = 줄 오른쪽 끝, 시각 → 점은 간격 8px,
 * 시각은 앞 칸과 8px 이상 떨어지고 말줄임되지 않는다 (#191).
 */
const wideLayoutProblems = (pane: Locator): Promise<string[]> =>
  pane.evaluate(
    (el, { height, gap }) => {
      const problems: string[] = [];
      el.querySelectorAll<HTMLElement>('[data-testid="card"]').forEach((card) => {
        const name = card.getAttribute('data-id') ?? '';
        const cardBox = card.getBoundingClientRect();
        if (Math.abs(cardBox.height - height) > 0.5) {
          problems.push(`${name}: 카드 높이 ${cardBox.height} (이전 ${height})`);
        }
        const line = card.querySelector<HTMLElement>('[data-testid="card-line-2"]');
        if (line === null) return;
        // 칸: 감싸는 요소가 있어도 보이는 칸(ID · 보조 문구 · 예외 · 시각 · 안 읽음 점)만 DOM 순서로
        const cells = [
          ...line.querySelectorAll<HTMLElement>(
            '.card-id, .card-note, [data-testid="card-exception"], .card-time, [data-testid="card-unread"]',
          ),
        ];
        // 한 줄: 칸들의 세로 가운데가 한 줄 높이(18px) 안에서 맞는다
        const middles = cells.map((c) => {
          const box = c.getBoundingClientRect();
          return box.top + box.height / 2;
        });
        if (Math.max(...middles) - Math.min(...middles) > 1) {
          problems.push(`${name}: 2줄째가 여러 줄 (가운데 ${middles.map(Math.round).join(', ')})`);
        }
        const fullText = (cell: HTMLElement, label: string): void => {
          // 말줄임은 1/64px만 모자라도 생기므로 글자 범위의 실수 폭으로 잰다
          const range = document.createRange();
          range.selectNodeContents(cell);
          const text = range.getBoundingClientRect().width;
          const box = cell.getBoundingClientRect().width;
          if (text > box + 0.01) problems.push(`${name}: ${label} 말줄임 (${box} < ${text})`);
        };
        const id = line.querySelector<HTMLElement>('.card-id');
        if (id !== null) fullText(id, 'ID');
        const lineBox = line.getBoundingClientRect();
        const lineRight = lineBox.left + line.clientLeft + line.clientWidth;
        // 앞쪽 칸(ID · 보조 문구 · 예외)은 8px 간격으로 잇고, 시각 · 안 읽음 점은 끝에 붙인다
        const tailStart = cells.findIndex((c) =>
          c.matches('.card-time, [data-testid="card-unread"]'),
        );
        const headEnd = tailStart === -1 ? cells.length : tailStart;
        for (let i = 1; i < headEnd; i += 1) {
          const prev = cells[i - 1]?.getBoundingClientRect();
          const cur = cells[i]?.getBoundingClientRect();
          if (prev === undefined || cur === undefined) continue;
          if (Math.abs(cur.left - (prev.right + gap)) > 0.5) {
            problems.push(
              `${name}: ${cells[i]?.className ?? ''} 위치 ${cur.left} (앞 칸 끝 ${prev.right} + ${gap})`,
            );
          }
        }
        if (tailStart === -1) return;
        const tail = cells.slice(tailStart);
        const last = tail.at(-1)?.getBoundingClientRect();
        if (last !== undefined && Math.abs(last.right - lineRight) > 0.5) {
          problems.push(
            `${name}: ${tail.at(-1)?.className ?? ''} 오른쪽 끝 ${last.right} (줄 오른쪽 끝 ${lineRight})`,
          );
        }
        for (let i = 1; i < tail.length; i += 1) {
          const prev = tail[i - 1]?.getBoundingClientRect();
          const cur = tail[i]?.getBoundingClientRect();
          if (prev === undefined || cur === undefined) continue;
          if (Math.abs(cur.left - (prev.right + gap)) > 0.5) {
            problems.push(
              `${name}: ${tail[i]?.className ?? ''} 위치 ${cur.left} (시각 끝 ${prev.right} + ${gap})`,
            );
          }
        }
        const head = cells[headEnd - 1]?.getBoundingClientRect();
        const first = tail[0]?.getBoundingClientRect();
        if (head !== undefined && first !== undefined && first.left < head.right + gap - 0.5) {
          problems.push(`${name}: 시각이 앞 칸에 붙음 (${first.left} < ${head.right} + ${gap})`);
        }
        const time = line.querySelector<HTMLElement>('.card-time');
        if (time !== null) fullText(time, '시각');
      });
      return problems;
    },
    { height: CARD_HEIGHT, gap: GAP },
  );

/**
 * 좁은 목록의 2줄째 (#191, ADR-090): 보조 문구 · 시각은 보이면 폭이 최소 3em 이상이다(남는 폭이 모자라면 줄지 않고
 * 다음 줄로 넘어간다). 안 읽음 점은 줄 오른쪽 끝에 붙고, 시각이 있는 카드면 시각과 같은 줄에서 시각 뒤 8px이다
 * (점만 다음 줄 왼쪽에 혼자 남지 않음).
 */
const narrowLineProblems = (pane: Locator): Promise<string[]> =>
  pane.evaluate(
    (el, { gap }) => {
      const problems: string[] = [];
      el.querySelectorAll<HTMLElement>('[data-testid="card-line-2"]').forEach((line) => {
        const name = line.closest('[data-testid="card"]')?.getAttribute('data-id') ?? '';
        line.querySelectorAll<HTMLElement>('.card-note, .card-time').forEach((cell) => {
          const width = cell.getBoundingClientRect().width;
          const min = 3 * Number.parseFloat(getComputedStyle(cell).fontSize);
          if (width > 0 && width < min - 0.01) {
            problems.push(`${name}: ${cell.className} 폭 ${width.toFixed(2)}px < 최소 ${min}px`);
          }
        });
        const dot = line.querySelector<HTMLElement>('[data-testid="card-unread"]');
        if (dot === null) return;
        const dotBox = dot.getBoundingClientRect();
        const lineRight = line.getBoundingClientRect().left + line.clientLeft + line.clientWidth;
        if (Math.abs(dotBox.right - lineRight) > 0.5) {
          problems.push(
            `${name}: 안 읽음 점 오른쪽 끝 ${dotBox.right} (줄 오른쪽 끝 ${lineRight})`,
          );
        }
        const time = line.querySelector<HTMLElement>('.card-time');
        if (time === null) return;
        const timeBox = time.getBoundingClientRect();
        const middle = (box: DOMRect): number => box.top + box.height / 2;
        if (Math.abs(middle(dotBox) - middle(timeBox)) > 1) {
          problems.push(
            `${name}: 안 읽음 점이 시각과 다른 줄 (가운데 ${Math.round(middle(dotBox))} · ${Math.round(middle(timeBox))})`,
          );
        }
        if (Math.abs(dotBox.left - (timeBox.right + gap)) > 0.5) {
          problems.push(
            `${name}: 안 읽음 점 위치 ${dotBox.left} (시각 끝 ${timeBox.right} + ${gap})`,
          );
        }
      });
      return problems;
    },
    { gap: GAP },
  );

test.describe('스크롤바가 있는 400px 목록: 카드는 이전 배치 그대로 (#179, ADR-090)', () => {
  for (const width of [1280, WIDE_WIDTH]) {
    test(`${width}px 창: 모든 카드의 ID가 온전하고 2줄째가 한 줄, 칸이 8px 간격으로 이어지며 카드 높이가 같다`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await openRules(page, [...RULES, ...EXTRA]);
      await expect(page.locator('[data-testid="card"][data-id="RULE-109"]')).toBeVisible();
      expect((await listPane(page).boundingBox())?.width).toBe(400);
      await expectScrollbar(page);
      expect(await wideLayoutProblems(listPane(page))).toEqual([]);
      expect(await listPaneOverflow(listPane(page))).toEqual([]);
      await shot(page, `카드-스크롤바-${width}`);
    });
  }

  for (const [screen, open] of TIMED_SCREENS) {
    for (const width of [1280, WIDE_WIDTH]) {
      test(`${screen} ${width}px 창: 시각은 줄 오른쪽 끝(안 읽음 점이 있으면 점 앞), 2줄째가 한 줄, 카드 높이가 같다 (#191)`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        const pane = await open(page);
        expect((await pane.boundingBox())?.width).toBe(400);
        await expectScrollbar(page);
        // 시각이 있는 카드를 실제로 본다 (승인 대기는 안 읽음 점이 있는 카드 포함)
        expect(await pane.locator('.card-time').count()).toBeGreaterThan(0);
        if (screen === '승인 대기') {
          expect(await pane.getByTestId('card-unread').count()).toBeGreaterThan(0);
        }
        expect(await wideLayoutProblems(pane)).toEqual([]);
        expect(await narrowLineProblems(pane)).toEqual([]);
        expect(await listPaneOverflow(pane)).toEqual([]);
        await shot(page, `카드-스크롤바-${screen}-${width}`);
      });
    }
  }
});

test.describe('스크롤바가 있는 좁은 목록: ID는 말줄임되지 않고 예외는 통째로 (#179, ADR-090)', () => {
  for (const width of NARROW_WIDTHS) {
    test(`${width}px 창`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openRules(page, [...RULES, ...EXTRA]);
      await expectScrollbar(page);
      expect(await listPaneOverflow(listPane(page))).toEqual([]);
      expect(await narrowLineProblems(listPane(page))).toEqual([]);
      await shot(page, `카드-스크롤바-${width}`);
    });

    for (const [screen, open] of TIMED_SCREENS) {
      test(`${width}px 창 ${screen}: 보조 문구 · 시각은 최소 3em, 안 읽음 점은 시각과 같은 줄 오른쪽 끝 (#191)`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        const pane = await open(page);
        await expectScrollbar(page);
        expect(await narrowLineProblems(pane)).toEqual([]);
        expect(await listPaneOverflow(pane)).toEqual([]);
        await shot(page, `카드-스크롤바-${screen}-${width}`);
      });
    }
  }

  test('1100px 창, 기본 데이터(스크롤 없음): RULE-002 등 보조 문구가 보이는 카드의 ID가 온전하다', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await openRules(page, RULES);
    const ids = page.getByTestId('card-id');
    await expect(ids.first()).toBeVisible();
    for (const id of await ids.all()) {
      const { textWidth, boxWidth, text } = await id.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return {
          textWidth: range.getBoundingClientRect().width,
          boxWidth: el.getBoundingClientRect().width,
          text: el.textContent ?? '',
        };
      });
      expect(textWidth, `${text} 말줄임`).toBeLessThanOrEqual(boxWidth + 0.01);
    }
    expect(await listPaneOverflow(listPane(page))).toEqual([]);
    await shot(page, '카드-1100-기본');
  });
});

/** 창 최소 폭 근처(채팅이 44px 띠로 접힘, ADR-093)와 좁은 목록 폭 */
const TRAILING_WIDTHS = [820, 830, ...NARROW_WIDTHS] as const;

/**
 * 2줄째 끝 칸(시각, 안 읽음 점이 있으면 시각 + 점)이 다음 줄로 넘어가는 때 (#173, ADR-090): 앞 칸들 뒤에 남는 폭이 그 칸의
 * 최소 폭보다 작을 때만이다. 최소 폭은 시각만 있으면 시각 최소 3em, 점이 있으면 3em + 간격 8px + 점 폭이다.
 * 남는 폭 = 줄 폭 - 마지막 앞 칸이 있는 줄의 앞 칸들 폭(보조 문구는 줄바꿈 판단 때의 최소 폭 3em) - 칸 사이 간격.
 * 남는 폭이 최소 폭에 0.5px 안으로 붙은 경우는 판단하지 않는다(소수 폭 반올림).
 */
const trailingWrapProblems = (pane: Locator): Promise<string[]> =>
  pane.evaluate(
    (el, { gap }) => {
      const problems: string[] = [];
      const middle = (cell: HTMLElement): number => {
        const box = cell.getBoundingClientRect();
        return box.top + box.height / 2;
      };
      el.querySelectorAll<HTMLElement>('[data-testid="card-line-2"]').forEach((line) => {
        const name = line.closest('[data-testid="card"]')?.getAttribute('data-id') ?? '';
        const time = line.querySelector<HTMLElement>('.card-time');
        if (time === null) return;
        const dot = line.querySelector<HTMLElement>('[data-testid="card-unread"]');
        const head = [
          ...line.querySelectorAll<HTMLElement>(
            '.card-id, .card-note, [data-testid="card-exception"]',
          ),
        ];
        const last = head.at(-1);
        if (last === undefined) return;
        const em = Number.parseFloat(getComputedStyle(time).fontSize);
        const row = head.filter((cell) => Math.abs(middle(cell) - middle(last)) <= 1);
        const used =
          row.reduce(
            (sum, cell) =>
              sum + (cell.matches('.card-note') ? 3 * em : cell.getBoundingClientRect().width),
            0,
          ) +
          gap * (row.length - 1);
        const lineWidth = line.getBoundingClientRect().width;
        const available = lineWidth - used - gap;
        const need = 3 * em + (dot === null ? 0 : gap + dot.getBoundingClientRect().width);
        const sameRow = Math.abs(middle(time) - middle(last)) <= 1;
        const label = dot === null ? '시각' : '시각 + 안 읽음 점';
        if (!sameRow && available >= need + 0.5) {
          problems.push(
            `${name}: ${label}이 남는 폭 ${available.toFixed(2)}px ≥ 최소 ${need}px인데 다음 줄`,
          );
        }
        if (sameRow && available < need - 0.5) {
          problems.push(
            `${name}: ${label}이 남는 폭 ${available.toFixed(2)}px < 최소 ${need}px인데 같은 줄`,
          );
        }
      });
      return problems;
    },
    { gap: GAP },
  );

/** 시각은 있고 안 읽음 점은 없는 카드 수 */
const timeOnlyCards = (pane: Locator): Promise<number> =>
  pane.evaluate(
    (el) =>
      [...el.querySelectorAll('[data-testid="card-line-2"]')].filter(
        (line) =>
          line.querySelector('.card-time') !== null &&
          line.querySelector('[data-testid="card-unread"]') === null,
      ).length,
  );

/** 스크롤바를 숨긴다(Playwright 기본 `--hide-scrollbars`와 같이 폭을 차지하지 않음). 이 파일은 그 인자를 빼고 돈다 */
const hideScrollbars = async (page: Page): Promise<void> => {
  await page.addStyleTag({ content: '* { scrollbar-width: none !important; }' });
};

test.describe('2줄째 끝 칸은 남는 폭이 최소 폭보다 작을 때만 다음 줄로 (#173, ADR-090)', () => {
  for (const scrollbar of ['보임', '숨김'] as const) {
    for (const width of TRAILING_WIDTHS) {
      for (const [screen, open] of TIMED_SCREENS) {
        test(`스크롤바 ${scrollbar} · ${width}px 창 ${screen}: 시각만 있는 카드 · 시각과 안 읽음 점이 있는 카드`, async ({
          page,
        }) => {
          await page.setViewportSize({ width, height: 800 });
          const pane = await open(page);
          if (scrollbar === '숨김') await hideScrollbars(page);
          const bar = await page
            .getByTestId('list-items')
            .evaluate((items: HTMLElement) => items.offsetWidth - items.clientWidth);
          if (scrollbar === '보임') await expectScrollbar(page);
          else expect(bar, '스크롤바 폭').toBe(0);
          // 시각만 있는 카드를 실제로 본다 (요구사항 카드 전부, 승인 대기는 읽은 제안)
          expect(await timeOnlyCards(pane)).toBeGreaterThan(0);
          expect(await trailingWrapProblems(pane)).toEqual([]);
          expect(await narrowLineProblems(pane)).toEqual([]);
          expect(await listPaneOverflow(pane)).toEqual([]);
        });
      }
    }
  }
});
