// SCR-05 검증 (이슈 #31 수용 기준 2 · 3 · 4, screens.md SCR-05, JDG-03 · COST-02, ADR-011 · ADR-029 · ADR-035 · ADR-072).
// 2) checklists/scr-05.ts의 기본(머리줄 · 준수 카드 · 실행당 비용 카드 · 파이프라인의 최근 실행 단계와 현재 단계 ·
//    규칙별 최신 판정과 실행 링크의 비용 합계 · 턴) · 빈("실행 없음") 상태
// 3) 잠정 · 변이 · 규칙화 불가 · 추적성 결함 카드 미노출, 실행당 비용 · 실행 링크 비용은 값이 없으면 '없음'
// 4) 준수 카드 → 규칙 화면 `준수 집계: 판정 가능`, 최근 실행이 중단이면 [재개] → run.resume
// 데이터는 가짜 브리지의 project.current · verification.summary · rule.list 응답으로만 만든다.
import { expect, type Page, test } from '@playwright/test';

import {
  EMPTY_SUMMARY,
  LINK_2,
  PROJECT,
  RULES,
  run,
  STAGE_LABELS,
  stages,
  SUMMARY,
} from './checklists/scr-05.js';
import { type BiveMock, type MockCall, mockBive, type MockResponses } from './support/bive-mock.js';
import { collectVisibleText, expectScreen, findForbiddenText } from './support/expectScreen.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;

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
    await openScreen(page, { 'verification.summary': { result: EMPTY_SUMMARY } });
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

  test('규칙별 최신 판정과 실행 링크: 판정 없는 규칙은 실행 링크가 없다', async ({ page }) => {
    await openScreen(page);
    const rows = page.getByTestId('verification-rule');
    await expect(rows).toHaveCount(5);
    const row = (displayId: string) => rows.filter({ hasText: displayId });
    await expect(row('RULE-001').getByTestId('run-link')).toHaveText('EXE-001$0.307턴');
    await expect(row('RULE-001').getByTestId('status-badge')).toHaveAttribute('title', '통과');
    await expect(row('RULE-002').getByTestId('status-badge')).toHaveText('실패');
    await expect(row('RULE-003').getByTestId('status-badge')).toHaveText('미판정');
    await expect(row('RULE-003').getByTestId('run-link')).toHaveCount(0);
    // 삭제된 규칙은 요약에 없으므로 보이지 않는다
    await expect(page.getByText('삭제된 규칙')).toHaveCount(0);
  });
});

test.describe('미노출 · 값 없음 (수용 기준 3)', () => {
  test('잠정 · 변이 · 규칙화 불가 · 추적성 결함 카드가 없고 지표 카드는 준수 · 실행당 비용 2개', async ({
    page,
  }) => {
    await openScreen(page);
    await expect(page.getByTestId('metric-label')).toHaveText(['준수', '실행당 비용']);
    for (const text of ['잠정', '변이', '규칙화 불가', '추적성 결함']) {
      await expect(page.getByTestId('metric-label').filter({ hasText: text })).toHaveCount(0);
    }
  });

  test('실행 링크 비용 · 턴은 값이 없으면 "없음" (0이 아님)', async ({ page }) => {
    await openScreen(page);
    const row = page.getByTestId('verification-rule').filter({ hasText: 'RULE-002' });
    await expect(row.getByTestId('run-link-id')).toHaveText(LINK_2.displayId);
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

test.describe('이동 · 재개 (수용 기준 4)', () => {
  test('준수 카드를 누르면 규칙 화면이 "준수 집계: 판정 가능" 필터로 열리고 분모 목록만 보인다', async ({
    page,
  }) => {
    await openScreen(page);
    await page.getByTestId('metric-compliance').click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await expect(
      page.getByTestId('filter-chip-compliance').getByTestId('filter-chip-button'),
    ).toHaveText('준수 집계: 판정 가능');
    const ids = SUMMARY.denominator.map(
      (id) => RULES.find(({ rule }) => rule.id === id)?.rule.displayId,
    );
    await expect(page.getByTestId('card')).toHaveCount(ids.length);
    expect((await page.getByTestId('card-id').allTextContents()).sort()).toEqual(ids.sort());
  });

  test('최근 실행이 진행 중이면 [재개]가 없다', async ({ page }) => {
    await openScreen(page);
    await expect(page.getByTestId('pipeline-run-status')).toHaveText('진행 중');
    await expect(page.getByRole('button', { name: '재개' })).toHaveCount(0);
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

    for (const response of [
      { result: SUMMARY },
      { result: EMPTY_SUMMARY },
      { error: { code: -32603, message: '내부 오류' } },
    ] as const) {
      await bive.setResponse('verification.summary', response);
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
