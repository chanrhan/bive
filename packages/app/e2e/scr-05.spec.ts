// SCR-05 검증 (이슈 #31 수용 기준 2 · 3 · 4, screens.md SCR-05, JDG-03 · COST-02, ADR-011 · ADR-029 · ADR-035 · ADR-072).
// 2) checklists/scr-05.ts의 기본(머리줄 · 준수 카드 · 실행당 비용 카드 · 파이프라인의 최근 실행 단계와 현재 단계 ·
//    규칙별 최신 판정과 실행 링크의 비용 합계 · 턴) · 빈("실행 없음") 상태
// 3) 잠정 · 변이 · 규칙화 불가 · 추적성 결함 카드 미노출, 실행당 비용 · 실행 링크 비용은 값이 없으면 '없음'
// 4) 준수 카드 → 규칙 화면 `준수 집계: 판정 가능`, 최근 실행이 중단이면 [재개] → run.resume
// 이슈 #44(M2-02) 수용 기준 1 · 2: "코드 열람" 영역의 사유별 건수, 기록이 없으면 영역 값 '없음' (MET-01, ADR-088)
// 데이터는 가짜 브리지의 project.current · verification.summary · codeOpen.summary · rule.list 응답으로만 만든다.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import {
  CODE_OPEN_SUMMARY,
  EMPTY_CODE_OPEN_SUMMARY,
  EMPTY_SUMMARY,
  LINK_1,
  NO_CONFIRMED_SUMMARY,
  PROJECT,
  RULES,
  run,
  SCREEN_UPDATE_FAILED_SUMMARY,
  SKIPPED_SUMMARY,
  STAGE_LABELS,
  stages,
  SUMMARY,
  TOOLTIPS,
  verificationScreenUpdateFailedChecklist,
  verificationSkippedChecklist,
} from './checklists/scr-05.js';
import { type BiveMock, type MockCall, mockBive, type MockResponses } from './support/bive-mock.js';
import {
  collectVisibleText,
  expectScreen,
  findForbiddenText,
  SCREENSHOT_DIR,
} from './support/expectScreen.js';
import { horizontalOverflow, textClipping } from './support/overflow.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;

/** 지표 카드 배치 스크린샷 (창 폭별). */
const SHOT = (width: number): string =>
  path.join(SCREENSHOT_DIR, 'SCR-05', `지표-카드-${String(width)}.png`);

const openScreen = async (
  page: Page,
  responses: MockResponses = {},
  { project = true }: { project?: boolean } = {},
): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: project ? PROJECT : null } },
      'verification.summary': { result: SUMMARY },
      'codeOpen.summary': { result: CODE_OPEN_SUMMARY },
      'rule.list': { result: { rules: RULES } },
      ...responses,
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '검증', exact: true }).click();
  return bive;
};

const callsOf = async (bive: BiveMock, method: string): Promise<MockCall[]> =>
  (await bive.calls()).filter((call) => call.method === method);

const interrupted = {
  ...SUMMARY,
  pipeline: {
    run: run({ status: 'interrupted', currentStep: 'implementation' }),
    stages: stages('implementation', 'pending'),
    queued: 0,
  },
} as const;

test.describe('체크리스트 (수용 기준 2)', () => {
  test('기본: 머리줄 · 준수 · 실행당 비용 · 파이프라인 · 규칙별 최신 판정과 실행 링크', async ({
    page,
  }) => {
    await openScreen(page);
    await expectScreen(page, 'SCR-05', '기본');
  });

  test('빈: 실행이 없으면 "실행 없음", 판정 기준 · 실행당 비용은 없음', async ({ page }) => {
    await openScreen(page, {
      'verification.summary': { result: EMPTY_SUMMARY },
      'codeOpen.summary': { result: EMPTY_CODE_OPEN_SUMMARY },
    });
    await expectScreen(page, 'SCR-05', '빈');
    await expect(page.getByTestId('pipeline').getByTestId('empty-state')).toHaveText('실행 없음');
  });

  test('로딩: 자리는 문구 없이 대기', async ({ page }) => {
    await openScreen(page, { 'verification.summary': { pending: true } });
    await expectScreen(page, 'SCR-05', '로딩');
    await expect(page.getByTestId('verification-loading')).toHaveText('');
  });

  test('에러: "검증 불러오기 실패", 사이드바 연결 상태와는 별개', async ({ page }) => {
    await openScreen(page, {
      'verification.summary': { error: { code: -32004, message: '프로젝트 없음' } },
    });
    await expectScreen(page, 'SCR-05', '에러');
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'connected');
  });

  test('열린 프로젝트가 없으면 "프로젝트 없음"이고 요약을 부르지 않는다', async ({ page }) => {
    const bive = await openScreen(page, {}, { project: false });
    const main = page.getByTestId('main-area');
    await expect(main.getByTestId('empty-state')).toHaveText('프로젝트 없음');
    await expect(main.getByText('검증 준비 중')).toHaveCount(0);
    expect(await callsOf(bive, 'verification.summary')).toEqual([]);
  });

  test('verification.summary를 현재 프로젝트로 부른다', async ({ page }) => {
    const bive = await openScreen(page);
    await expect(page.getByTestId('verification-basis')).toBeVisible();
    const calls = await callsOf(bive, 'verification.summary');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.params).toEqual({ projectId: PROJECT.id });
  });
});

test.describe('파이프라인 · 목록 (수용 기준 2)', () => {
  test('최근 실행의 단계 순서와 현재 단계, 단계별 상태', async ({ page }) => {
    await openScreen(page);
    const stagesEl = page.getByTestId('pipeline-stage');
    await expect(stagesEl).toHaveText([...STAGE_LABELS]);
    const current = page.locator('[data-testid="pipeline-stage"][aria-current="step"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute('data-kind', 'implementation');
    await expect(current).toHaveAttribute('data-status', 'running');
    await expect(current).toHaveAttribute('title', '구현 · 진행 중');
    await expect(stagesEl.nth(2)).toHaveAttribute('data-status', 'passed');
    await expect(stagesEl.nth(4)).toHaveAttribute('data-status', 'pending');
  });

  test('생략 단계: 흐림 + 보이는 문구 "생략" (툴팁만이 아님), 다른 단계에는 없음 (#165)', async ({
    page,
  }) => {
    await openScreen(page, { 'verification.summary': { result: SKIPPED_SUMMARY } });
    await expectScreen(page, 'SCR-05', '기본', {
      checklist: verificationSkippedChecklist,
      screenshot: false,
    });
    const stagesEl = page.getByTestId('pipeline-stage');
    await expect(stagesEl).toHaveCount(STAGE_LABELS.length);
    const skipped = page.locator('[data-testid="pipeline-stage"][data-status="skipped"]');
    await expect(skipped).toHaveCount(1);
    await expect(skipped).toHaveAttribute('data-kind', 'mutation');
    // 보이는 글자: 단계 이름 아래 "생략"
    const note = skipped.getByTestId('pipeline-skip');
    await expect(note).toBeVisible();
    await expect(note).toHaveText('생략');
    await expect(skipped.locator('.pipeline-label')).toHaveText('변이 주입');
    await expect(skipped).toHaveAttribute('title', '변이 주입 · 생략');
    // 흐림
    expect(Number(await skipped.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
    // 생략 아닌 단계에는 문구가 없다
    await expect(page.getByTestId('pipeline-skip')).toHaveCount(1);
    await expect(
      page.locator('[data-testid="pipeline-stage"]:not([data-status="skipped"])'),
    ).not.toContainText(['생략']);
    const file = path.join(SCREENSHOT_DIR, 'SCR-05', '생략-단계.png');
    await mkdir(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true });
  });

  test('병합 뒤 화면 갱신만 실패한 실행: 상태 "병합 완료", 머리줄은 그 병합 커밋, 화면 갱신 단계만 실패 표시 (ADR-091)', async ({
    page,
  }) => {
    await openScreen(page, { 'verification.summary': { result: SCREEN_UPDATE_FAILED_SUMMARY } });
    await expectScreen(page, 'SCR-05', '기본', {
      checklist: verificationScreenUpdateFailedChecklist,
      screenshot: false,
    });
    const status = page.getByTestId('pipeline-run-status');
    await expect(status).toHaveText('병합 완료');
    await expect(status).toHaveAttribute('data-status', 'merged');
    await expect(page.locator('.pipeline')).toHaveAttribute('data-run-status', 'merged');
    // 실패는 화면 갱신 단계 한 칸에만: 점 색(예외 강조)과 툴팁, 병합 단계는 통과
    const failed = page.locator('[data-testid="pipeline-stage"][data-status="failed"]');
    await expect(failed).toHaveCount(1);
    await expect(failed).toHaveAttribute('data-kind', 'screen_update');
    await expect(failed).toHaveAttribute('title', '화면 갱신 · 실패');
    const merge = page.locator('[data-testid="pipeline-stage"][data-kind="merge"]');
    await expect(merge).toHaveAttribute('data-status', 'passed');
    const dotColor = (kind: string) =>
      page
        .locator(`[data-testid="pipeline-stage"][data-kind="${kind}"] .pipeline-dot`)
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await dotColor('screen_update')).not.toBe(await dotColor('merge'));
    await expect(page.getByRole('button', { name: '재개' })).toHaveCount(0);
    const file = path.join(SCREENSHOT_DIR, 'SCR-05', '화면-갱신-실패.png');
    await mkdir(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true });
  });

  test('좁은 창에서도 단계 8개의 이름 · "생략"이 각 칸 안에 있고 칸끼리 겹치지 않는다 (#165)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await openScreen(page, { 'verification.summary': { result: SKIPPED_SUMMARY } });
    await expect(page.getByTestId('pipeline-skip')).toBeVisible();
    const problems = await page.getByTestId('pipeline-stepper').evaluate((list) => {
      const out: string[] = [];
      const cells = [...list.querySelectorAll('[data-testid="pipeline-stage"]')];
      if (cells.length !== 8) out.push(`단계 ${cells.length}개`);
      let prevRight = -Infinity;
      for (const cell of cells) {
        const box = cell.getBoundingClientRect();
        const kind = cell.getAttribute('data-kind');
        if (box.left < prevRight - 0.5) out.push(`${kind}: 앞 칸과 겹침`);
        prevRight = box.right;
        for (const part of cell.querySelectorAll(
          '.pipeline-label, [data-testid="pipeline-skip"]',
        )) {
          const p = part.getBoundingClientRect();
          if (p.left < box.left - 0.5 || p.right > box.right + 0.5)
            out.push(`${kind}: 글자가 칸 밖`);
          if (part.scrollWidth > part.clientWidth + 0.5) out.push(`${kind}: 글자 잘림`);
        }
      }
      return out;
    });
    expect(problems).toEqual([]);
  });

  test('규칙별 최신 판정과 실행 링크: 기준 실행에서 판정되지 않은 규칙은 미판정 · 실행 링크 없음', async ({
    page,
  }) => {
    await openScreen(page);
    const rows = page.getByTestId('verification-rule');
    await expect(rows).toHaveCount(5);
    const row = (displayId: string) => rows.filter({ hasText: displayId });
    await expect(row('RULE-001').getByTestId('run-link')).toHaveText('EXE-001$0.307턴');
    await expect(row('RULE-001').getByTestId('status-badge')).toHaveAttribute('title', '통과');
    await expect(row('RULE-006').getByTestId('run-link-id')).toHaveText('EXE-001');
    for (const id of ['RULE-002', 'RULE-003', 'RULE-005']) {
      await expect(row(id).getByTestId('status-badge')).toHaveText('미판정');
      await expect(row(id).getByTestId('run-link')).toHaveCount(0);
    }
    // 삭제된 규칙은 요약에 없으므로 보이지 않는다
    await expect(page.getByText('삭제된 규칙')).toHaveCount(0);
  });
});

test.describe('미노출 · 값 없음 (수용 기준 3)', () => {
  test('잠정 · 변이 · 규칙화 불가 · 추적성 결함 카드가 없고 지표 카드는 준수 · 에이전트 폐기 규칙 · 실행당 비용 3개', async ({
    page,
  }) => {
    await openScreen(page);
    await expect(page.getByTestId('metric-label')).toHaveText([
      '준수',
      '에이전트 폐기 규칙',
      '실행당 비용',
    ]);
    for (const text of ['잠정', '변이', '규칙화 불가', '추적성 결함']) {
      await expect(page.getByTestId('metric-label').filter({ hasText: text })).toHaveCount(0);
    }
  });

  test('실행 링크 비용 · 턴은 값이 없으면 "없음" (0이 아님)', async ({ page }) => {
    const unknown = { ...LINK_1, costUsd: null, turns: null };
    await openScreen(page, {
      'verification.summary': {
        result: {
          ...SUMMARY,
          rules: SUMMARY.rules.map((r) => (r.run === null ? r : { ...r, run: unknown })),
        },
      },
    });
    const row = page.getByTestId('verification-rule').filter({ hasText: 'RULE-001' });
    await expect(row.getByTestId('run-link-id')).toHaveText(LINK_1.displayId);
    await expect(row.getByTestId('run-link-cost')).toHaveText('없음');
    await expect(row.getByTestId('run-link-turns')).toHaveText('없음');
  });

  test('실행당 비용은 값이 없으면 "없음", 0이면 "$0"', async ({ page }) => {
    const bive = await openScreen(page, {
      'verification.summary': { result: { ...SUMMARY, costPerRunUsd: null } },
    });
    const cost = page.getByTestId('metric-cost-per-run').getByTestId('metric-value');
    await expect(cost).toHaveText('없음');
    await bive.setResponse('verification.summary', { result: { ...SUMMARY, costPerRunUsd: 0 } });
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await page.getByRole('button', { name: '검증', exact: true }).click();
    await expect(cost).toHaveText('$0');
  });
});

test.describe('코드 열람 영역 (#44 수용 기준 1 · 2, MET-01 · ADR-088)', () => {
  const area = (page: Page) => page.getByTestId('code-open');
  const debuggingOnce: typeof CODE_OPEN_SUMMARY = {
    reasons: [
      { reason: 'screen_error', count: 0 },
      { reason: 'info_lacking', count: 0 },
      { reason: 'debugging', count: 1 },
    ],
    total: 1,
  };

  test('사유별 건수: 화면 오류 · 정보 부족 · 디버깅 순서, 0건도 0', async ({ page }) => {
    const bive = await openScreen(page);
    const items = area(page).getByTestId('code-open-reason');
    await expect(items).toHaveText(['화면 오류 2', '정보 부족 0', '디버깅 5']);
    expect(
      await items.evaluateAll((els) => els.map((el) => el.getAttribute('data-reason'))),
    ).toEqual(['screen_error', 'info_lacking', 'debugging']);
    await expect(area(page).getByTestId('code-open-count')).toHaveText(['2', '0', '5']);
    await expect(area(page).getByTestId('code-open-none')).toHaveCount(0);
    const calls = await callsOf(bive, 'codeOpen.summary');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.params).toEqual({ projectId: PROJECT.id });
  });

  test('"디버깅"으로 1번 연 기록이면 "디버깅 1" (로드맵 2.2 흐름 2)', async ({ page }) => {
    await openScreen(page, { 'codeOpen.summary': { result: debuggingOnce } });
    await expect(area(page).getByText('디버깅 1', { exact: true })).toBeVisible();
    await expect(area(page).getByTestId('code-open-reason')).toHaveText([
      '화면 오류 0',
      '정보 부족 0',
      '디버깅 1',
    ]);
  });

  test('기록이 없으면 영역 값 "없음", 사유 칸 없음', async ({ page }) => {
    await openScreen(page, { 'codeOpen.summary': { result: EMPTY_CODE_OPEN_SUMMARY } });
    await expect(area(page).getByTestId('code-open-none')).toHaveText('없음');
    await expect(area(page).getByTestId('code-open-reason')).toHaveCount(0);
    // 다른 영역은 그대로
    await expect(page.getByTestId('verification-basis')).toHaveText('판정 기준 main@a1f26b1');
  });

  test('한계 문구 "링크 경유 열기 시도 수 · 링크 밖 열람 미집계"는 제목의 공통 툴팁이고 키보드 초점으로 닿는다 (#191 · #201)', async ({
    page,
  }) => {
    await openScreen(page);
    const heading = area(page).getByRole('heading', { name: '코드 열람' });
    await expect(heading).toBeVisible();
    const hint = heading.getByTestId('code-open-hint');
    // 준수 카드와 같은 방식: 초점을 받는 버튼, 이름은 제목 글자, 한계 문구는 공통 툴팁 · 접근 가능한 설명 (title 속성 없음)
    await expect(hint).toHaveRole('button');
    await expect(hint).toHaveAccessibleName('코드 열람');
    await expect(hint).not.toHaveAttribute('title');
    // 지표 카드의 버튼(준수 두 기준 → 에이전트 폐기 규칙) 다음 Tab 한 번으로 닿는다 (실행당 비용 카드는 초점을 받지 않는다)
    await page.getByTestId('metric-compliance-all').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('metric-compliance-confirmed')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('metric-agent-retired')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(hint).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveText(TOOLTIPS['code-open-hint'].text);
    await expect(hint).toHaveAccessibleDescription(TOOLTIPS['code-open-hint'].text);
    // 영역 안에 보이는 문구는 더하지 않는다 (ADR-088: 화면 정의서에 없는 문구. 툴팁은 영역 밖 한 곳에 뜬다)
    await expect(area(page).getByText('링크 경유 열기 시도 수', { exact: false })).toHaveCount(0);
  });

  test('영역 순서: 지표 카드 → 코드 열람 → 파이프라인 → 규칙별 최신 판정', async ({ page }) => {
    await openScreen(page);
    await expect(area(page)).toBeVisible();
    const order = await page
      .locator('.verification-content > section')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
    expect(order).toEqual(['지표', '코드 열람', '파이프라인', '규칙별 최신 판정']);
  });

  test('영역 조회가 실패하면 영역에만 "코드 열람 불러오기 실패", 나머지 영역은 그대로', async ({
    page,
  }) => {
    await openScreen(page, {
      'codeOpen.summary': { error: { code: -32603, message: '내부 오류' } },
    });
    const error = area(page).getByTestId('code-open-load-error');
    await expect(error).toHaveText('코드 열람 불러오기 실패');
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(area(page).getByTestId('code-open-reason')).toHaveCount(0);
    await expect(page.getByTestId('verification-screen')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('verification-load-error')).toHaveCount(0);
    await expect(page.getByTestId('metric-label')).toHaveText([
      '준수',
      '에이전트 폐기 규칙',
      '실행당 비용',
    ]);
    await expect(page.getByTestId('pipeline-stage')).toHaveCount(STAGE_LABELS.length);
    await expect(page.getByTestId('verification-rule')).toHaveCount(5);
  });

  test('영역 조회 중에는 영역 자리만 문구 없이 대기, 나머지 영역은 보인다', async ({ page }) => {
    await openScreen(page, { 'codeOpen.summary': { pending: true } });
    const loading = area(page).getByTestId('code-open-loading');
    await expect(loading).toHaveAttribute('aria-busy', 'true');
    await expect(loading).toHaveText('');
    await expect(page.getByTestId('pipeline-stage')).toHaveCount(STAGE_LABELS.length);
    await expect(area(page).getByTestId('code-open-none')).toHaveCount(0);
  });

  test('검증 화면에 다시 들어오면 새 건수를 다시 읽는다 (기록 없음 → 디버깅 1)', async ({
    page,
  }) => {
    const bive = await openScreen(page, {
      'codeOpen.summary': { result: EMPTY_CODE_OPEN_SUMMARY },
    });
    await expect(area(page).getByTestId('code-open-none')).toHaveText('없음');
    const before = (await callsOf(bive, 'codeOpen.summary')).length;
    await bive.setResponse('codeOpen.summary', { result: debuggingOnce });
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await page.getByRole('button', { name: '검증', exact: true }).click();
    await expect(area(page).getByTestId('code-open-reason').nth(2)).toHaveText('디버깅 1');
    await expect(area(page).getByTestId('code-open-none')).toHaveCount(0);
    expect((await callsOf(bive, 'codeOpen.summary')).length).toBeGreaterThan(before);
  });

  test('오케스트레이터에 다시 붙으면 영역도 다시 읽어 조회 실패가 풀린다 (구독은 화면당 1개)', async ({
    page,
  }) => {
    const bive = await openScreen(page, {
      'codeOpen.summary': { error: { code: -32603, message: '내부 오류' } },
    });
    await expect(area(page).getByTestId('code-open-load-error')).toBeVisible();
    await bive.setResponse('codeOpen.summary', { result: debuggingOnce });
    await bive.emit('system.connection', { state: 'disconnected' });
    await bive.emit('system.connection', { state: 'connected', status: STATUS });
    await expect(area(page).getByTestId('code-open-reason').nth(2)).toHaveText('디버깅 1');
    await expect(area(page).getByTestId('code-open-load-error')).toHaveCount(0);
  });

  test('1280×800에서 영역이 잘리거나 가로 스크롤을 만들지 않는다', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const bigger: typeof CODE_OPEN_SUMMARY = {
      reasons: [
        { reason: 'screen_error', count: 12_345 },
        { reason: 'info_lacking', count: 67_890 },
        { reason: 'debugging', count: 1_234_567 },
      ],
      total: 1_314_802,
    };
    await openScreen(page, { 'codeOpen.summary': { result: bigger } });
    await expect(area(page).getByTestId('code-open-reason')).toHaveCount(3);
    const screen = page.getByTestId('verification-screen');
    expect(await horizontalOverflow(screen, '[data-testid="code-open-reason"]')).toEqual([]);
    for (const reason of ['screen_error', 'info_lacking', 'debugging']) {
      const item = area(page).locator(`[data-reason="${reason}"]`);
      expect(await textClipping(item, ['code-open-label', 'code-open-count']), reason).toEqual([]);
    }
    expect(await textClipping(area(page), ['code-open-reason'])).toEqual([]);
  });
});

test.describe('이동 · 재개 (수용 기준 4)', () => {
  test('준수 카드의 전체 기준을 누르면 규칙 화면이 "준수 집계: 판정 가능" 필터로 열리고 분모 목록만 보인다', async ({
    page,
  }) => {
    await openScreen(page);
    await page.getByTestId('metric-compliance-all').click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await expect(
      page.getByTestId('filter-chip-compliance').getByTestId('filter-chip-button'),
    ).toHaveText('준수 집계: 판정 가능');
    const ids = SUMMARY.denominator.map(
      (id) => RULES.find(({ rule }) => rule.id === id)?.rule.displayId,
    );
    await expect(page.getByTestId('card')).toHaveCount(ids.length);
    expect((await page.getByTestId('card-id').allTextContents()).sort()).toEqual(ids.sort());
    // 확인 칩은 고르지 않았다 (미확인 RULE-006도 전체 기준 분모)
    await expect(
      page.getByTestId('filter-chip-confirmation').getByTestId('filter-chip-button'),
    ).toHaveText('확인');
    await expect(page.getByTestId('hidden-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  test('준수 카드에 전체 기준과 사람 확인 기준이 한 카드 안에 나란히 보인다 (M7-16 수용 기준 3)', async ({
    page,
  }) => {
    await openScreen(page);
    const card = page.getByTestId('metric-compliance');
    await expect(card.getByTestId('metric-part-label')).toHaveText(['전체 기준', '사람 확인 기준']);
    await expect(card.getByTestId('metric-compliance-all').getByTestId('metric-value')).toHaveText(
      '2 / 5',
    );
    const confirmed = card.getByTestId('metric-compliance-confirmed');
    await expect(confirmed.getByTestId('metric-value')).toHaveText('1 / 3');
    await expect(confirmed).toHaveAttribute('data-state', 'value');
    // 넓은 창(1280)에서는 같은 줄, 전체 기준이 왼쪽
    const all = await card.getByTestId('metric-compliance-all').boundingBox();
    const human = await confirmed.boundingBox();
    expect(all !== null && human !== null && Math.abs(all.y - human.y) < 1).toBe(true);
    expect(all !== null && human !== null && all.x < human.x).toBe(true);
  });

  test('사람 확인 기준을 누르면 규칙 화면이 "준수 집계: 판정 가능" + "확인: 확인됨"으로 열리고 카드 수가 사람 확인 기준 분모와 같다 (M7-16 수용 기준 3)', async ({
    page,
  }) => {
    await openScreen(page);
    await page.getByTestId('metric-compliance-confirmed').click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await expect(
      page.getByTestId('filter-chip-compliance').getByTestId('filter-chip-button'),
    ).toHaveText('준수 집계: 판정 가능');
    await expect(
      page.getByTestId('filter-chip-confirmation').getByTestId('filter-chip-button'),
    ).toHaveText('확인: 확인됨');
    await expect(page.getByTestId('hidden-toggle')).toHaveAttribute('aria-pressed', 'false');
    const ids = SUMMARY.confirmedDenominator.map(
      (id) => RULES.find(({ rule }) => rule.id === id)?.rule.displayId,
    );
    expect(ids).toEqual(['RULE-001', 'RULE-003', 'RULE-005']);
    await expect(page.getByTestId('card')).toHaveCount(
      SUMMARY.confirmedCompliance?.judgeable ?? -1,
    );
    expect((await page.getByTestId('card-id').allTextContents()).sort()).toEqual(ids.sort());
    await expect(page.getByTestId('list-result')).toHaveText('5개 중 3개 · 초기화');
  });

  test('효력 있는 확인됨 규칙이 없으면 사람 확인 기준은 "없음"(0 / 0이 아님), 전체 기준은 그대로 (M7-16 수용 기준 2)', async ({
    page,
  }) => {
    await openScreen(page, { 'verification.summary': { result: NO_CONFIRMED_SUMMARY } });
    const confirmed = page.getByTestId('metric-compliance-confirmed');
    await expect(confirmed.getByTestId('metric-value')).toHaveText('없음');
    await expect(confirmed).toHaveAttribute('data-state', 'none');
    await expect(page.getByTestId('metric-compliance').getByText('0 / 0')).toHaveCount(0);
    await expect(page.getByTestId('metric-compliance-all').getByTestId('metric-value')).toHaveText(
      '2 / 5',
    );
    // 에이전트 폐기 0은 센 값이라 "0"
    await expect(page.getByTestId('metric-agent-retired').getByTestId('metric-value')).toHaveText(
      '0',
    );
  });

  test('사람 확인 기준 "없음"(확인됨 규칙 없음)을 누르면 규칙 화면이 빈 목록이다 (M3-35 #263)', async ({
    page,
  }) => {
    // 요약과 규칙 목록이 서로 맞는 가짜 데이터: 효력 있는 규칙이 모두 미확인이라 사람 확인 기준이 null이다
    const unconfirmed = RULES.map((item) => ({
      ...item,
      rule: { ...item.rule, confirmation: { state: 'unconfirmed' as const } },
    }));
    await openScreen(page, {
      'verification.summary': {
        result: {
          ...NO_CONFIRMED_SUMMARY,
          rules: NO_CONFIRMED_SUMMARY.rules.map((row) => ({
            ...row,
            rule: { ...row.rule, confirmation: { state: 'unconfirmed' as const } },
          })),
        },
      },
      'rule.list': { result: { rules: unconfirmed } },
    });
    const confirmed = page.getByTestId('metric-compliance-confirmed');
    await expect(confirmed.getByTestId('metric-value')).toHaveText('없음');
    await confirmed.click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await expect(
      page.getByTestId('filter-chip-confirmation').getByTestId('filter-chip-button'),
    ).toHaveText('확인: 확인됨');
    await expect(page.getByTestId('card')).toHaveCount(0);
    // 목록에 보이는 규칙(폐기 포함 꺼짐) 5개 가운데 0개 (위 "사람 확인 기준" 시험의 "5개 중 3개"와 같은 목록)
    await expect(page.getByTestId('list-result-count')).toHaveText('5개 중 0개');
  });

  test('확인됨 규칙은 있는데 판정 가능한 것이 없으면 사람 확인 기준 "없음"이고 상태로 구분된다', async ({
    page,
  }) => {
    await openScreen(page, {
      'verification.summary': {
        result: {
          ...SUMMARY,
          confirmedCompliance: { passed: 0, judgeable: 0, confirmed: 2 },
          confirmedDenominator: [],
        },
      },
    });
    const confirmed = page.getByTestId('metric-compliance-confirmed');
    await expect(confirmed.getByTestId('metric-value')).toHaveText('없음');
    await expect(confirmed).toHaveAttribute('data-state', 'unjudgeable');
  });

  test('에이전트 폐기 규칙 수가 보이고 누르면 규칙 화면이 [폐기 포함]으로 열려 폐기된 규칙이 함께 보인다 (M7-16 수용 기준 4)', async ({
    page,
  }) => {
    await openScreen(page);
    const retired = page.getByTestId('metric-agent-retired');
    await expect(retired.getByTestId('metric-label')).toHaveText('에이전트 폐기 규칙');
    await expect(retired.getByTestId('metric-value')).toHaveText(String(SUMMARY.agentRetiredRules));
    await expect(retired.getByTestId('metric-value')).toHaveText('1');
    await retired.click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await expect(page.getByTestId('hidden-toggle')).toHaveAttribute('aria-pressed', 'true');
    // 칩은 고르지 않았다: 폐기되지 않은 5개 + 폐기된 RULE-007
    await expect(
      page.getByTestId('filter-chip-compliance').getByTestId('filter-chip-button'),
    ).toHaveText('준수 집계');
    await expect(page.getByTestId('card')).toHaveCount(6);
    const card = page.getByTestId('card').filter({ hasText: 'RULE-007' });
    await expect(card.getByTestId('card-exception')).toHaveText(['폐기', '미확인']);
    await expect(page.getByTestId('list-result')).toHaveText('6개 중 6개 · 초기화');
  });

  test('준수 카드의 기준을 차례로 눌러도 앞 필터가 남지 않는다 (사람 확인 → 전체 → 폐기)', async ({
    page,
  }) => {
    await openScreen(page);
    const back = () => page.getByRole('button', { name: '검증', exact: true }).click();
    await page.getByTestId('metric-compliance-confirmed').click();
    await expect(page.getByTestId('card')).toHaveCount(3);
    await back();
    await page.getByTestId('metric-compliance-all').click();
    await expect(
      page.getByTestId('filter-chip-confirmation').getByTestId('filter-chip-button'),
    ).toHaveText('확인');
    await expect(page.getByTestId('card')).toHaveCount(SUMMARY.denominator.length);
    await back();
    await page.getByTestId('metric-agent-retired').click();
    await expect(
      page.getByTestId('filter-chip-compliance').getByTestId('filter-chip-button'),
    ).toHaveText('준수 집계');
    await expect(page.getByTestId('card')).toHaveCount(6);
  });

  for (const width of [820, 1280]) {
    test(`창 폭 ${String(width)}에서 지표 카드의 이름 · 값이 한 줄로 잘리지 않고 가로 스크롤이 없다`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      // 긴 값: 큰 수에서도 깨지지 않는지
      await openScreen(page, {
        'verification.summary': {
          result: {
            ...SUMMARY,
            agentRetiredRules: 12_345,
            costPerRunUsd: 1234.5,
          },
        },
      });
      await expect(page.getByTestId('metric-agent-retired')).toBeVisible();
      const screen = page.getByTestId('verification-screen');
      expect(await horizontalOverflow(screen, '.verification-metrics > .metric-card')).toEqual([]);
      const problems = await page.locator('.verification-metrics').evaluate((metrics) => {
        const out: string[] = [];
        const area = metrics.getBoundingClientRect();
        for (const el of metrics.querySelectorAll<HTMLElement>(
          '.metric-label, .metric-part-label, .metric-value',
        )) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const tops = new Set(
            [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)),
          );
          const name = el.textContent ?? '';
          if (tops.size !== 1) out.push(`${name}: ${String(tops.size)}줄`);
          if (el.scrollWidth > el.clientWidth + 0.5) out.push(`${name}: 잘림`);
          const box = el.getBoundingClientRect();
          if (box.left < area.left - 0.5 || box.right > area.right + 0.5) out.push(`${name}: 밖`);
        }
        return out;
      });
      expect(problems).toEqual([]);
      await mkdir(path.dirname(SHOT(width)), { recursive: true });
      await page.getByTestId('verification-screen').screenshot({ path: SHOT(width) });
    });
  }

  test('규칙 목록의 제목은 숨은 글자를 보이는 표기로 그린다 (에이전트가 쓴 글, U+202E)', async ({
    page,
  }) => {
    const tricky = `계정 잠금${String.fromCharCode(0x202e)}해제`;
    await openScreen(page, {
      'verification.summary': {
        result: {
          ...SUMMARY,
          rules: SUMMARY.rules.map((row, index) =>
            index === 0 ? { ...row, rule: { ...row.rule, title: tricky } } : row,
          ),
        },
      },
    });
    await expect(page.getByTestId('verification-rule-title').first()).toHaveText(
      '계정 잠금\\u202e해제',
    );
  });

  test('최근 실행이 진행 중이면 [재개]가 없다', async ({ page }) => {
    await openScreen(page);
    await expect(page.getByTestId('pipeline-run-status')).toHaveText('진행 중');
    await expect(page.getByRole('button', { name: '재개' })).toHaveCount(0);
  });

  test('자리를 차지한 실행이 없고 최근 실행이 실행 대기면(시작 직전) 상태 "실행 대기", 현재 단계 표시 없음, [재개] · 대기 건수 없음, 금지 문구 없음 (ADR-105)', async ({
    page,
  }) => {
    // 승인 단계만 통과하고 아직 시작하지 않은 실행 (워크트리 · 기준 커밋 · 시작 시각 없음)
    const queued = {
      ...SUMMARY,
      pipeline: {
        run: run({
          status: 'queued',
          currentStep: 'test_writing',
          lastCompletedStep: 'approval',
          branch: null,
          worktreePath: null,
          baseCommit: null,
          startedAt: null,
          costUsd: null,
          turns: null,
        }),
        stages: stages('test_writing', 'pending'),
        queued: 0,
      },
    } as const;
    await openScreen(page, { 'verification.summary': { result: queued } });
    await expect(page.getByTestId('pipeline-run-status')).toHaveText('실행 대기');
    await expect(page.getByTestId('pipeline-run-status')).toHaveAttribute('data-status', 'queued');
    await expect(page.getByTestId('pipeline-run')).toHaveText(queued.pipeline.run.displayId);
    // 아직 시작하지 않았으므로 현재 단계 글자 · 현재 단계 표시(aria-current)가 없다
    await expect(page.getByTestId('pipeline-current')).toHaveCount(0);
    await expect(page.locator('[data-testid="pipeline-stage"][aria-current]')).toHaveCount(0);
    const stagesEl = page.getByTestId('pipeline-stage');
    await expect(stagesEl.first()).toHaveAttribute('data-status', 'passed');
    await expect(stagesEl.nth(1)).toHaveAttribute('data-status', 'pending');
    await expect(page.getByRole('button', { name: '재개' })).toHaveCount(0);
    await expect(page.getByTestId('pipeline-queued')).toHaveCount(0);
    const texts = await collectVisibleText(page);
    expect(findForbiddenText(texts)).toEqual([]);
  });

  test('중단된 실행이 자리를 지키고 뒤에 실행 대기 2건: 파이프라인은 중단된 실행과 [재개], 같은 줄에 "실행 대기 2", [재개]는 그 실행 ID로 run.resume (ADR-105)', async ({
    page,
  }) => {
    // 요약이 보일 실행으로 중단된 실행을 고르고(최근에 만든 실행 대기가 아님) 뒤 실행 대기 건수를 싣는다
    const blocked = { ...interrupted, pipeline: { ...interrupted.pipeline, queued: 2 } } as const;
    const bive = await openScreen(page, { 'verification.summary': { result: blocked } });
    await expect(page.getByTestId('pipeline-run')).toHaveText(blocked.pipeline.run.displayId);
    await expect(page.getByTestId('pipeline-run-status')).toHaveText('중단');
    await expect(page.getByTestId('pipeline-queued')).toHaveText('실행 대기 2');
    await expect(page.getByTestId('pipeline-queued')).toBeVisible();
    await expect(page.getByTestId('pipeline-resume')).toBeVisible();
    expect(findForbiddenText(await collectVisibleText(page))).toEqual([]);
    await bive.setResponse('run.resume', {
      result: { run: run({ status: 'running' }), steps: [] },
    });
    await page.getByRole('button', { name: '재개', exact: true }).click();
    await expect.poll(async () => (await callsOf(bive, 'run.resume')).length).toBe(1);
    expect((await callsOf(bive, 'run.resume'))[0]?.params).toEqual({
      projectId: PROJECT.id,
      id: blocked.pipeline.run.id,
      author: { kind: 'human' },
    });
  });

  test('재개할 수 없어 실행이 실패로 끝났다는 거부면 "<표시 ID> 재개 불가 · 실패 처리"이고 요약을 다시 읽는다 (ADR-105)', async ({
    page,
  }) => {
    const blocked = { ...interrupted, pipeline: { ...interrupted.pipeline, queued: 1 } } as const;
    const bive = await openScreen(page, {
      'verification.summary': { result: blocked },
      'run.resume': {
        error: {
          code: -32009,
          message: '재개할 수 없어 실행을 실패로 끝냈습니다',
          data: { reason: 'resume_unrecoverable', code: 'worktree_missing' },
        },
      },
    });
    const before = (await callsOf(bive, 'verification.summary')).length;
    await page.getByRole('button', { name: '재개', exact: true }).click();
    await expect(page.getByTestId('pipeline-resume-error')).toHaveText(
      `${blocked.pipeline.run.displayId} 재개 불가 · 실패 처리`,
    );
    await expect
      .poll(async () => (await callsOf(bive, 'verification.summary')).length)
      .toBeGreaterThan(before);
    expect(findForbiddenText(await collectVisibleText(page))).toEqual([]);
  });

  test('이미 병합된 중단 실행을 재개할 수 없어 병합 완료로 끝났다는 거부면 "<표시 ID> 재개 불가 · 병합 완료"(실패라고 하지 않음) (ADR-105)', async ({
    page,
  }) => {
    await openScreen(page, {
      'verification.summary': { result: interrupted },
      'run.resume': {
        error: {
          code: -32009,
          message:
            '재개할 수 없어 남은 단계를 끝내지 못했습니다. 실행은 이미 병합돼 병합 완료로 끝냈습니다',
          data: { reason: 'resume_unrecoverable', code: 'worktree_missing', runStatus: 'merged' },
        },
      },
    });
    await page.getByRole('button', { name: '재개', exact: true }).click();
    await expect(page.getByTestId('pipeline-resume-error')).toHaveText(
      `${interrupted.pipeline.run.displayId} 재개 불가 · 병합 완료`,
    );
    expect(findForbiddenText(await collectVisibleText(page))).toEqual([]);
  });

  test('최근 실행이 중단이면 [재개]가 run.resume(사람 주체)을 부르고 요약을 다시 읽는다', async ({
    page,
  }) => {
    const bive = await openScreen(page, { 'verification.summary': { result: interrupted } });
    await expect(page.getByTestId('pipeline-run-status')).toHaveText('중단');
    await expect(page.getByTestId('pipeline-current')).toHaveText('구현');
    const before = (await callsOf(bive, 'verification.summary')).length;
    await bive.setResponse('run.resume', {
      result: { run: run({ status: 'running' }), steps: [] },
    });
    await bive.setResponse('verification.summary', { result: SUMMARY });
    await page.getByRole('button', { name: '재개', exact: true }).click();

    await expect(page.getByTestId('pipeline-run-status')).toHaveText('진행 중');
    await expect(page.getByRole('button', { name: '재개' })).toHaveCount(0);
    expect(await callsOf(bive, 'run.resume')).toEqual([
      {
        method: 'run.resume',
        params: {
          projectId: PROJECT.id,
          id: interrupted.pipeline.run.id,
          author: { kind: 'human' },
        },
      },
    ]);
    expect((await callsOf(bive, 'verification.summary')).length).toBeGreaterThan(before);
  });

  test('재개가 실패하면 "재개 실패"이고 버튼은 남는다', async ({ page }) => {
    const bive = await openScreen(page, {
      'verification.summary': { result: interrupted },
      'run.resume': { error: { code: -32009, message: '상태 충돌' } },
    });
    await page.getByRole('button', { name: '재개', exact: true }).click();
    await expect(page.getByTestId('pipeline-resume-error')).toHaveText('재개 실패');
    await expect(page.getByRole('button', { name: '재개', exact: true })).toBeEnabled();
    expect(await callsOf(bive, 'run.resume')).toHaveLength(1);
  });
});

test.describe('공통 툴팁: 준수 카드의 기준 · 코드 열람 한계 문구 (#201, ADR-124)', () => {
  type Target = keyof typeof TOOLTIPS;
  const TARGETS = Object.keys(TOOLTIPS) as Target[];
  const tooltip = (page: Page) => page.getByRole('tooltip');

  /** 키보드로 대상에 초점을 옮긴다: 탭 순서의 이웃에서 Tab · Shift+Tab 한 번 (마우스 누름 초점이 아닌 키보드 초점). */
  const NEIGHBOR: Record<Target, { from: string; key: 'Tab' | 'Shift+Tab' }> = {
    'metric-compliance-all': { from: 'metric-compliance-confirmed', key: 'Shift+Tab' },
    'metric-compliance-confirmed': { from: 'metric-compliance-all', key: 'Tab' },
    'code-open-hint': { from: 'metric-agent-retired', key: 'Tab' },
  };
  const keyboardFocus = async (page: Page, target: Target): Promise<void> => {
    const { from, key } = NEIGHBOR[target];
    await page.getByTestId(from).focus();
    await page.keyboard.press(key);
    await expect(page.getByTestId(target)).toBeFocused();
  };

  test('문구는 체크리스트와 글자까지 같고 명사형 · 코드 표기 없음 (화면 정의서 1.1)', () => {
    for (const { text } of Object.values(TOOLTIPS)) {
      expect(findForbiddenText([{ source: '툴팁', text }])).toEqual([]);
      // 서술형 문장 끝맺음이 없다
      expect(text).not.toMatch(/(다|요)\.?$/);
    }
  });

  for (const target of TARGETS) {
    test(`${target}: 키보드 초점으로 보이고 aria-describedby로 이어지며, Esc로 닫히고 초점은 대상에 남는다. title 속성은 없다`, async ({
      page,
    }) => {
      await openScreen(page);
      const anchor = page.getByTestId(target);
      await expect(anchor).not.toHaveAttribute('title');
      await expect(tooltip(page)).toHaveCount(0);
      await expect(anchor).not.toHaveAttribute('aria-describedby');

      await keyboardFocus(page, target);
      await expect(tooltip(page)).toHaveCount(1);
      await expect(tooltip(page)).toHaveText(TOOLTIPS[target].text);
      await expect(tooltip(page)).toHaveAttribute('data-reason', 'focus');
      const id = await tooltip(page).getAttribute('id');
      expect(id).not.toBeNull();
      await expect(anchor).toHaveAttribute('aria-describedby', id ?? '');
      await expect(anchor).toHaveAccessibleDescription(TOOLTIPS[target].text);

      await page.keyboard.press('Escape');
      await expect(tooltip(page)).toHaveCount(0);
      await expect(anchor).toBeFocused();
      await expect(anchor).not.toHaveAttribute('aria-describedby');
      // Esc는 원래 동작을 부르지 않는다 (검증 화면 그대로)
      await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'verification');
    });
  }

  test('초점이 떠나면(Tab) 닫히고 다음 대상의 툴팁이 열린다. 한 번에 하나만 열린다', async ({
    page,
  }) => {
    await openScreen(page);
    await keyboardFocus(page, 'metric-compliance-all');
    await expect(tooltip(page)).toHaveText(TOOLTIPS['metric-compliance-all'].text);
    await page.keyboard.press('Tab');
    await expect(tooltip(page)).toHaveCount(1);
    await expect(tooltip(page)).toHaveText(TOOLTIPS['metric-compliance-confirmed'].text);
    await expect(page.getByTestId('metric-compliance-all')).not.toHaveAttribute('aria-describedby');
    // 초점 툴팁이 열린 채 다른 대상에 마우스를 올리면 그 대상 것 하나로 바뀐다
    await page.getByTestId('code-open-hint').hover();
    await expect(tooltip(page)).toHaveCount(1);
    await expect(tooltip(page)).toHaveText(TOOLTIPS['code-open-hint'].text);
    await expect(page.getByTestId('metric-compliance-confirmed')).not.toHaveAttribute(
      'aria-describedby',
    );
    await expect(page.getByTestId('code-open-hint')).toHaveAttribute(
      'aria-describedby',
      'bive-tooltip',
    );
    // 초점이 버튼 밖(머리줄 글자)으로 가면 닫힌다
    await page.getByTestId('verification-basis').click();
    await expect(tooltip(page)).toHaveCount(0);
  });

  test('코드 열람(원래 동작 없음): 누르면 열리고 밖을 누르면 닫힌다. Enter · Space로도 열린다', async ({
    page,
  }) => {
    await openScreen(page);
    const hint = page.getByTestId('code-open-hint');
    await hint.click();
    await expect(tooltip(page)).toHaveText(TOOLTIPS['code-open-hint'].text);
    await expect(tooltip(page)).toHaveAttribute('data-reason', 'press');
    // 누름으로 연 툴팁은 마우스가 떠나도 남는다
    await page.mouse.move(0, 0);
    await expect(tooltip(page)).toHaveCount(1);
    await page.getByTestId('verification-basis').click();
    await expect(tooltip(page)).toHaveCount(0);

    for (const key of ['Enter', 'Space']) {
      await keyboardFocus(page, 'code-open-hint');
      await page.keyboard.press('Escape');
      await expect(tooltip(page)).toHaveCount(0);
      await page.keyboard.press(key);
      await expect(tooltip(page), key).toHaveText(TOOLTIPS['code-open-hint'].text);
      await expect(tooltip(page)).toHaveAttribute('data-reason', 'press');
      await page.keyboard.press('Escape');
      await expect(tooltip(page)).toHaveCount(0);
      await expect(hint).toBeFocused();
    }
  });

  test('준수 기준(원래 동작 있음): 마우스를 올리면 열리고 떠나면 닫힌다. 누름은 툴팁이 아니라 규칙 화면 이동이다', async ({
    page,
  }) => {
    await openScreen(page);
    const all = page.getByTestId('metric-compliance-all');
    await all.hover();
    await expect(tooltip(page)).toHaveText(TOOLTIPS['metric-compliance-all'].text);
    await expect(tooltip(page)).toHaveAttribute('data-reason', 'hover');
    await page.mouse.move(0, 0);
    await expect(tooltip(page)).toHaveCount(0);

    await all.click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    // 대상이 사라지면 툴팁도 남지 않는다
    await expect(tooltip(page)).toHaveCount(0);

    // 키보드: 초점으로 열린 뒤 Enter는 원래 동작(이동)
    await page.getByRole('button', { name: '검증', exact: true }).click();
    await keyboardFocus(page, 'metric-compliance-confirmed');
    await expect(tooltip(page)).toHaveText(TOOLTIPS['metric-compliance-confirmed'].text);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await expect(
      page.getByTestId('filter-chip-confirmation').getByTestId('filter-chip-button'),
    ).toHaveText('확인: 확인됨');
    await expect(tooltip(page)).toHaveCount(0);
  });

  for (const width of [820, 1100, 1280, 1440] as const) {
    test(`${width}×800: 툴팁은 창 안에 있고 가로 스크롤을 만들지 않는다`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openScreen(page);
      for (const target of TARGETS) {
        await keyboardFocus(page, target);
        await expect(tooltip(page)).toHaveText(TOOLTIPS[target].text);
        const place = await tooltip(page).evaluate((el) => {
          const box = el.getBoundingClientRect();
          const root = document.documentElement;
          return {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
            width: root.clientWidth,
            height: root.clientHeight,
            scroll: root.scrollWidth - root.clientWidth,
            // 글자가 툴팁 안에서 잘리지 않는다
            clipped: el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight,
          };
        });
        expect(place.left, target).toBeGreaterThanOrEqual(0);
        expect(place.top, target).toBeGreaterThanOrEqual(0);
        expect(place.right, target).toBeLessThanOrEqual(place.width);
        expect(place.bottom, target).toBeLessThanOrEqual(place.height);
        expect(place.scroll, target).toBe(0);
        expect(place.clipped, target).toBe(false);
        await page.keyboard.press('Escape');
      }
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, 'SCR-05', `툴팁-${String(width)}.png`),
      });
    });
  }
});

test.describe('화면 문구', () => {
  /** 화면 정의서 1.1 금지 패턴(PRD ID · 화면 코드 · 이모지) + 개발 단계 · 미구현 문구(ADR-035). */
  const STAGE_TEXT = [/\bM\d\b/, /준비 중/, /로딩/, /Loading/i];

  const expectCleanText = async (page: Page): Promise<void> => {
    const texts = await collectVisibleText(page);
    expect(findForbiddenText(texts)).toEqual([]);
    const stage = texts.filter(({ text }) => STAGE_TEXT.some((pattern) => pattern.test(text)));
    expect(stage).toEqual([]);
  };

  test('기본 · 중단 · 빈 · 에러 상태에 금지 문구가 없다', async ({ page }) => {
    const bive = await openScreen(page, { 'verification.summary': { result: interrupted } });
    await expect(page.getByTestId('pipeline-resume')).toBeVisible();
    await expectCleanText(page);

    for (const [response, codeOpen] of [
      [{ result: SUMMARY }, { result: CODE_OPEN_SUMMARY }],
      [{ result: EMPTY_SUMMARY }, { result: EMPTY_CODE_OPEN_SUMMARY }],
      [{ result: SUMMARY }, { error: { code: -32603, message: '내부 오류' } }],
      [{ error: { code: -32603, message: '내부 오류' } }, { result: CODE_OPEN_SUMMARY }],
    ] as const) {
      await bive.setResponse('verification.summary', response);
      await bive.setResponse('codeOpen.summary', codeOpen);
      await page.getByRole('button', { name: '규칙', exact: true }).click();
      await page.getByRole('button', { name: '검증', exact: true }).click();
      await expect(page.getByTestId('verification-screen')).not.toHaveAttribute(
        'data-state',
        'loading',
      );
      await expectCleanText(page);
    }
  });
});
