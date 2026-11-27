// SCR-03 규칙 (이슈 #24 수용 기준 2 · 3, screens.md SCR-03 · 1.4, ADR-029 · ADR-035 · ADR-060).
// 2) checklists/scr-03.ts의 기본(카드 1줄 제목, 2줄 ID · WHEN 조건 · 예외) · 빈("규칙 없음") 상태
// 3) 필터 칩 7종(판정 · 변이 · 준수 집계 · 확인 · 블록 · 위험도 · 종류), 변이는 값이 없어 0건 비활성
// 이슈 #64(M3-19) 수용 기준 3: 블록 · 위험도 칩이 값 개수와 함께 활성(블록마다 셈 · 여러 블록 OR · 프로젝트 전환 때 비움, ADR-126)
// 이슈 #227(M7-15) 수용 기준 1 · 4: 미확인 규칙 카드 2줄째에 예외 "미확인"(판정 예외 다음), 확인됨은 예외 없음, 필터 칩 "확인"
// (미확인 · 확인됨)이 값 개수와 함께 활성, 준수 집계 칩에 "사람 확인". 폐기된 규칙은 기본 목록에서 빠지고 [폐기 포함]에서만
// 보이며 그 카드의 예외는 "폐기" (ADR-100 I3 · D7 · 명세 변경 목록 SCR-03, ADR-114)
// 이슈 #218(M7-06): [실행]으로 만든 실행이 프로젝트의 진행 중 실행 때문에 실행 대기면 [실행] 옆에 "표시 ID · 실행 대기"
// (run.create · run.get 응답과 event.run.updated 알림으로만, ADR-105)
// 이슈 #60(M3-15) 수용 기준 3: 서버가 실은 변이 상태로 변이 칩이 활성이 되고, 카드 예외 "변이 생존"(판정 예외 바로 뒤)이 보인다.
// 검증 화면 변이 카드에서 넘어오면 "변이: 생존"이 걸려 있다 (ADR-146). 변이 칸이 없는 옛 응답(RULES)은 칩 0건 비활성 그대로
// 데이터는 가짜 브리지의 project.current · rule.list 응답과 project.opened 알림(PROJECT_OPENED_EVENT)으로만 만든다.
import path from 'node:path';

import { expect, type Locator, type Page, test } from '@playwright/test';

import type {
  Project,
  Run,
  RunCreateResult,
  RunGetResult,
  RunStatus,
  RunUpdatedEvent,
  StepKind,
} from '@bive/shared';

import { PROJECT_OPENED_EVENT } from '../src/common/bridge.js';
import { CHIPS, PROJECT, RETIRED_RULE, RULES, VISIBLE_ORDER } from './checklists/scr-03.js';
import {
  CODE_OPEN_SUMMARY,
  MUTATION_RULES,
  MUTATION_TRACEABILITY,
  run as summaryRun,
  SUMMARY,
  TREND,
} from './checklists/scr-05.js';
import { type BiveMock, type MockCall, mockBive, type MockResponses } from './support/bive-mock.js';
import {
  collectVisibleText,
  expectScreen,
  findForbiddenText,
  SCREENSHOT_DIR,
} from './support/expectScreen.js';
import { brokenWords, horizontalOverflow } from './support/overflow.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
const OTHER_PROJECT: Project = {
  id: '01JCCCCCCCCCCCCCCCCCCCCCCC',
  name: 'other-app',
  rootPath: '/work/other-app',
  baseBranch: 'main',
  createdAt: '2026-10-15T00:00:00.000Z',
};
/** 기본 목록에 보이는 규칙: 삭제 · 폐기되지 않은 것 */
const LIVE = RULES.filter(({ rule, retirement }) => rule.deletedAt === null && !retirement);

const openScreen = async (
  page: Page,
  responses: MockResponses = {},
  { project = true }: { project?: boolean } = {},
): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: project ? PROJECT : null } },
      'rule.list': { result: { rules: RULES } },
      ...responses,
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '규칙', exact: true }).click();
  return bive;
};

const callsOf = async (bive: BiveMock, method: string): Promise<MockCall[]> =>
  (await bive.calls()).filter((call) => call.method === method);

const cardIds = (page: Page): Promise<string[]> => page.getByTestId('card-id').allTextContents();
const chipButton = (page: Page, id: string): Locator =>
  page.getByTestId(`filter-chip-${id}`).getByTestId('filter-chip-button');

/** 칩 메뉴의 값별 [문구, 개수, 비활성]. */
const menuOptions = (page: Page): Promise<[string, string, boolean][]> =>
  page
    .getByTestId('filter-option')
    .evaluateAll((labels) =>
      labels.map((label) => [
        label.querySelector('.filter-option-label')?.textContent ?? '',
        label.querySelector('.filter-count')?.textContent ?? '',
        label.querySelector('input')?.disabled ?? false,
      ]),
    );

test.describe('체크리스트 (수용 기준 2)', () => {
  test('기본: 카드 1줄 제목 · 2줄 ID와 WHEN 조건과 예외, 상세 자리, [실행] 미노출', async ({
    page,
  }) => {
    await openScreen(page);
    await expectScreen(page, 'SCR-03', '기본');
  });

  test('빈: "규칙 없음" 한 줄, 칩은 전부 0건 비활성', async ({ page }) => {
    await openScreen(page, { 'rule.list': { result: { rules: [] } } });
    await expectScreen(page, 'SCR-03', '빈');
    for (const chip of CHIPS) await expect(chipButton(page, chip.id)).toBeDisabled();
  });

  test('로딩: 목록 자리는 문구 없이 대기', async ({ page }) => {
    await openScreen(page, { 'rule.list': { pending: true } });
    await expectScreen(page, 'SCR-03', '로딩');
    await expect(page.getByTestId('rules-loading')).toHaveText('');
  });

  test('에러: 목록 자리에 "규칙 불러오기 실패", 사이드바 연결 상태와는 별개', async ({ page }) => {
    await openScreen(page, { 'rule.list': { error: { code: -32004, message: '프로젝트 없음' } } });
    await expectScreen(page, 'SCR-03', '에러');
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'connected');
  });

  test('열린 프로젝트가 없으면 "프로젝트 없음"이고 목록을 부르지 않는다', async ({ page }) => {
    const bive = await openScreen(page, {}, { project: false });
    const main = page.getByTestId('main-area');
    await expect(main.getByTestId('empty-state')).toHaveText('프로젝트 없음');
    await expect(main.getByText('규칙 준비 중')).toHaveCount(0);
    await expect(page.getByTestId('list-view')).toHaveCount(0);
    expect(await callsOf(bive, 'rule.list')).toEqual([]);
  });
});

test.describe('목록', () => {
  test('rule.list를 현재 프로젝트로 부르고, 삭제 항목을 빼고 문제 항목 먼저 보인다', async ({
    page,
  }) => {
    const bive = await openScreen(page);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    expect(await cardIds(page)).toEqual([...VISIBLE_ORDER]);
    // 개발 서버의 StrictMode는 처음 그릴 때 효과를 두 번 돌리므로 횟수가 아니라 파라미터만 본다
    const listCalls = await callsOf(bive, 'rule.list');
    expect(listCalls.length).toBeGreaterThan(0);
    // 폐기된 규칙도 함께 읽고(읽기 전용 옵션) 숨기는 것은 목록이다 (ADR-114)
    for (const call of listCalls) {
      expect(call.params).toEqual({ projectId: PROJECT.id, includeRetired: true });
    }
  });

  test('2줄은 ID · WHEN 조건 · 예외이고 시각은 없다, 정상 항목은 예외가 비어 있다', async ({
    page,
  }) => {
    await openScreen(page);
    const lines = page.getByTestId('card-line-2');
    // 예외가 겹치면 판정 예외 다음 미확인 (ADR-060 순서: 상태 예외 → 화면 예외)
    await expect(lines.nth(0)).toHaveText(
      'RULE-002WHEN 결제 후 24시간이 지난 주문의 취소를 요청하면실패미확인',
    );
    await expect(lines.nth(0).getByTestId('card-exception')).toHaveText(['실패', '미확인']);
    // WHEN 조건이 없는 진술은 조건 자리가 비어 있다
    await expect(lines.nth(1)).toHaveText('RULE-003미판정');
    await expect(lines.nth(1).getByTestId('card-note')).toHaveCount(0);
    await expect(lines.nth(2)).toHaveText('RULE-005WHEN API 라우트가 데이터를 읽으면재검증 필요');
    // 미확인(통과)은 2줄째 예외 자리에 "미확인" 하나
    await expect(lines.nth(3)).toHaveText('RULE-006WHEN 재설정 링크가 발급 후 30분을 넘기면미확인');
    await expect(lines.nth(3).getByTestId('card-exception')).toHaveText(['미확인']);
    // 확인됨 · 통과는 예외 없음
    await expect(lines.nth(4)).toHaveText('RULE-001WHEN 같은 계정으로 로그인이 5회 연속 실패하면');
    await expect(lines.nth(4).getByTestId('card-exception')).toHaveCount(0);
    // 예외는 카드 2줄째에만 있다 (모든 예외가 2줄 안: 002 둘 · 003 · 005 · 006 하나씩)
    await expect(page.getByTestId('card-exception')).toHaveCount(5);
    await expect(page.getByTestId('card-line-2').getByTestId('card-exception')).toHaveCount(5);
    await expect(page.getByTestId('list-items').locator('time')).toHaveCount(0);
    // 통과는 1줄 앞 흐린 점(글자 없음), 이름은 접근 가능한 이름 · 툴팁
    const normal = page
      .getByTestId('card')
      .filter({ hasText: 'RULE-001' })
      .getByTestId('status-badge');
    await expect(normal).toHaveAttribute('data-tone', 'normal');
    await expect(normal).toHaveText('');
    await expect(normal).toHaveAttribute('title', '통과');
    // 말줄임 툴팁: 2줄째가 잘렸으면 마우스를 올릴 때 2줄 전체 문구, 잘리지 않았으면 툴팁 없음 (공통 툴팁, #201 · ADR-124).
    // 잘림 여부는 글꼴에 따라 다르다(CI와 이 VM의 한글 글꼴 폭이 다름). 잘리는 경우는 card-line.spec.ts가 데이터로 고정한다
    const clipped = await lines
      .nth(0)
      .getByTestId('card-note')
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    await expect(lines.nth(0)).not.toHaveAttribute('title');
    await lines.nth(0).hover();
    if (clipped) {
      await expect(page.getByRole('tooltip')).toHaveText(
        'RULE-002 · WHEN 결제 후 24시간이 지난 주문의 취소를 요청하면 · 실패 · 미확인',
      );
    } else {
      await expect(page.getByRole('tooltip')).toHaveCount(0);
    }
  });

  test('폐기된 규칙은 기본 목록에 없고 [폐기 포함]을 켜면 예외 "폐기"와 함께 보인다, 끄면 다시 빠진다 (수용 기준 4)', async ({
    page,
  }) => {
    await openScreen(page);
    const toggle = page.getByTestId('hidden-toggle');
    await expect(toggle).toHaveText('폐기 포함');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await cardIds(page)).toEqual([...VISIBLE_ORDER]);
    await expect(page.getByTestId('list-result')).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // 문제 항목(받은 순서) 안에 RULE-007이 들어가고 정상 RULE-001은 맨 뒤
    expect(await cardIds(page)).toEqual([
      'RULE-002',
      'RULE-003',
      'RULE-005',
      'RULE-006',
      'RULE-007',
      'RULE-001',
    ]);
    const retired = page.getByTestId('card').filter({ hasText: 'RULE-007' });
    await expect(retired.getByTestId('card-title')).toHaveText('비밀번호 재설정 링크 1시간 만료');
    // 폐기 전 판정(실패)은 카드 예외가 아니다: 폐기 · 미확인만, 2줄째에
    await expect(retired.getByTestId('card-line-2').getByTestId('card-exception')).toHaveText([
      '폐기',
      '미확인',
    ]);
    await expect(retired.getByTestId('status-badge')).toHaveCount(0);
    await expect(page.getByTestId('list-result')).toHaveText('6개 중 6개 · 초기화');

    // 다른 화면에 갔다 와도 유지 (목록별 필터 상태)
    await page.getByRole('button', { name: '계약', exact: true }).click();
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(page.getByTestId('hidden-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('card')).toHaveCount(6);

    await page.getByTestId('hidden-toggle').click();
    expect(await cardIds(page)).toEqual([...VISIBLE_ORDER]);
    await expect(page.getByTestId('list-result')).toHaveCount(0);
  });

  test('폐기된 규칙만 있으면 기본은 "규칙 없음", [폐기 포함]으로 그 규칙이 보인다', async ({
    page,
  }) => {
    await openScreen(page, { 'rule.list': { result: { rules: [RETIRED_RULE] } } });
    await expect(page.getByTestId('list-view').getByTestId('empty-state')).toHaveText('규칙 없음');
    await page.getByTestId('hidden-toggle').click();
    expect(await cardIds(page)).toEqual(['RULE-007']);
  });

  test('[문제만]은 예외가 있는 규칙만 보인다', async ({ page }) => {
    await openScreen(page);
    await page.getByTestId('problem-toggle').click();
    expect(await cardIds(page)).toEqual(['RULE-002', 'RULE-003', 'RULE-005', 'RULE-006']);
    await expect(page.getByTestId('list-result')).toHaveText('5개 중 4개 · 초기화');
  });

  test('검색은 제목 · ID · WHEN 조건에서 찾는다', async ({ page }) => {
    await openScreen(page);
    await page.getByTestId('list-search').fill('서비스 계층');
    expect(await cardIds(page)).toEqual(['RULE-005']);
    await page.getByTestId('list-search').fill('24시간이 지난');
    expect(await cardIds(page)).toEqual(['RULE-002']);
  });

  test('카드를 고르면 선택 표시되고 상세 자리의 "선택 항목 없음"이 사라진다', async ({ page }) => {
    await openScreen(page);
    const card = page.getByTestId('card').filter({ hasText: 'RULE-001' });
    await card.click();
    await expect(card).toHaveAttribute('aria-current', 'true');
    const detail = page.getByTestId('rule-detail');
    await expect(detail).toHaveAttribute('data-selected-id', RULES[0]?.rule.id ?? '');
    await expect(detail.getByText('선택 항목 없음')).toHaveCount(0);
  });
});

test.describe('부모 없는 규칙의 추적성 결함 (M3-11 #56 수용 기준 3, NRM-06 · ADR-137)', () => {
  const traceability = {
    requirementsWithoutRules: [],
    parentlessRules: [{ id: RULES[0]?.rule.id ?? '', displayId: 'RULE-001' }],
  };

  test('서버가 부모 없는 규칙으로 정한 규칙의 카드 2줄째에 "추적성 결함"(위험 색)이 보이고 [문제만]에 잡힌다. 다른 카드에는 없다', async ({
    page,
  }) => {
    await openScreen(page, { 'rule.list': { result: { rules: RULES, traceability } } });
    const card = page.getByTestId('card').filter({ hasText: 'RULE-001' });
    // 통과 · 확인됨이라 다른 예외가 없던 카드
    await expect(card.getByTestId('card-exception')).toHaveText(['추적성 결함']);
    await expect(card.getByTestId('card-exception')).toHaveAttribute('data-tone', 'danger');
    await expect(page.getByTestId('card-exception').filter({ hasText: '추적성 결함' })).toHaveCount(
      1,
    );
    await page.getByTestId('problem-toggle').click();
    // 정상이던 RULE-001도 문제 항목이 되어 모든 카드가 남는다
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    expect(await cardIds(page)).toContain('RULE-001');
  });

  test('응답에 추적성 결함이 없으면(옛 응답) 어느 카드에도 "추적성 결함"이 없고 [문제만]은 RULE-001을 뺀다', async ({
    page,
  }) => {
    await openScreen(page);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await expect(page.getByTestId('card-exception').filter({ hasText: '추적성 결함' })).toHaveCount(
      0,
    );
    await page.getByTestId('problem-toggle').click();
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length - 1);
    expect(await cardIds(page)).not.toContain('RULE-001');
  });
});

test.describe('필터 칩 (수용 기준 3)', () => {
  test('칩 7종이 있고 변이만 값이 없어 0건 비활성, 블록 · 위험도는 활성 (#64)', async ({
    page,
  }) => {
    await openScreen(page);
    const chips = page.getByTestId('list-view').getByTestId('filter-chip-button');
    await expect(chips).toHaveText(CHIPS.map((chip) => chip.label));
    for (const chip of CHIPS) {
      if (chip.enabled) await expect(chipButton(page, chip.id)).toBeEnabled();
      else await expect(chipButton(page, chip.id)).toBeDisabled();
    }
    expect(CHIPS.filter((chip) => !chip.enabled).map((chip) => chip.label)).toEqual(['변이']);
    // 비활성 칩은 눌러도 메뉴가 열리지 않는다
    await chipButton(page, 'mutation').click({ force: true });
    await expect(page.getByTestId('filter-menu')).toHaveCount(0);
  });

  test('블록 · 위험도: 값별 개수와 함께 활성, 블록은 규칙마다가 아니라 블록마다 센다. 선언에 없는 이름도 값이다 (#64, ADR-126)', async ({
    page,
  }) => {
    await openScreen(page);
    // 보이는 규칙(폐기 제외): RULE-001 auth, RULE-002 auth · lib, RULE-003 없음, RULE-005 lib, RULE-006 auth · legacy-mail
    await chipButton(page, 'block').click();
    expect(await menuOptions(page)).toEqual([
      ['auth', '3', false],
      ['legacy-mail', '1', false],
      ['lib', '2', false],
    ]);
    await page.keyboard.press('Escape');
    await chipButton(page, 'risk').click();
    expect(await menuOptions(page)).toEqual([
      ['낮음', '1', false],
      ['보통', '1', false],
      ['높음', '2', false],
    ]);
    await page.keyboard.press('Escape');
    // [폐기 포함]: 폐기된 RULE-007(auth · 보통)이 더해진다
    await page.getByTestId('hidden-toggle').click();
    await chipButton(page, 'block').click();
    expect(await menuOptions(page)).toEqual([
      ['auth', '4', false],
      ['legacy-mail', '1', false],
      ['lib', '2', false],
    ]);
    await page.keyboard.press('Escape');
    await chipButton(page, 'risk').click();
    expect((await menuOptions(page)).find(([label]) => label === '보통')).toEqual([
      '보통',
      '2',
      false,
    ]);
  });

  test('블록 여러 개를 고르면 하나라도 가진 규칙이 남고(OR), 위험도와는 AND, ×로 풀린다 (#64)', async ({
    page,
  }) => {
    await openScreen(page);
    await chipButton(page, 'block').click();
    await page.getByTestId('filter-option').filter({ hasText: 'lib' }).click();
    await page.keyboard.press('Escape');
    expect(await cardIds(page)).toEqual(['RULE-002', 'RULE-005']);
    await expect(page.getByTestId('list-result')).toHaveText('5개 중 2개 · 초기화');
    await chipButton(page, 'block').click();
    await page.getByTestId('filter-option').filter({ hasText: 'legacy-mail' }).click();
    await page.keyboard.press('Escape');
    await expect(chipButton(page, 'block')).toHaveText('블록: legacy-mail, lib');
    expect(await cardIds(page)).toEqual(['RULE-002', 'RULE-005', 'RULE-006']);
    // 위험도 높음과 AND: legacy-mail · lib 가운데 높음은 RULE-006
    await chipButton(page, 'risk').click();
    await page.getByTestId('filter-option').filter({ hasText: '높음' }).click();
    await page.keyboard.press('Escape');
    expect(await cardIds(page)).toEqual(['RULE-006']);
    // 블록이 없는 옛 규칙(RULE-003)은 어떤 블록 값에도 남지 않는다
    await page.getByTestId('filter-chip-block').getByTestId('filter-chip-clear').click();
    await page.getByTestId('filter-chip-risk').getByTestId('filter-chip-clear').click();
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await chipButton(page, 'block').click();
    for (const name of ['auth', 'legacy-mail', 'lib']) {
      const option = page.getByTestId('filter-option').filter({ hasText: name });
      await option.click();
    }
    await page.keyboard.press('Escape');
    expect(await cardIds(page)).not.toContain('RULE-003');
    expect(await cardIds(page)).toHaveLength(LIVE.length - 1);
  });

  test('값별 개수는 최신 판정 · 규칙 필드에서 나오고 근거 데이터가 없는 값은 0건 비활성', async ({
    page,
  }) => {
    await openScreen(page);
    await chipButton(page, 'judgment').click();
    expect(await menuOptions(page)).toEqual([
      ['통과', '2', false],
      ['실패', '1', false],
      ['미판정', '1', false],
      ['격리', '0', true],
      ['재검증 필요', '1', false],
    ]);
    await page.keyboard.press('Escape');

    // 준수 집계: 판정 가능 = 효력 · 격리 아님 5건, 사람 확인 = 그 가운데 확인됨 3건(RULE-001 · 003 · 005, ADR-100 D7)
    await chipButton(page, 'compliance').click();
    expect(await menuOptions(page)).toEqual([
      ['판정 가능', '5', false],
      ['사람 확인', '3', false],
      ['격리', '0', true],
    ]);
    await page.keyboard.press('Escape');

    // 확인: 미확인 2(RULE-002 · 006) · 확인됨 3, 둘 다 활성 (수용 기준 1)
    await expect(chipButton(page, 'confirmation')).toBeEnabled();
    await chipButton(page, 'confirmation').click();
    expect(await menuOptions(page)).toEqual([
      ['미확인', '2', false],
      ['확인됨', '3', false],
    ]);
    await page.keyboard.press('Escape');

    await chipButton(page, 'kind').click();
    expect(await menuOptions(page)).toEqual([
      ['아키텍처', '1', false],
      ['기술 제약', '1', false],
      ['비즈니스', '3', false],
    ]);
    await page.keyboard.press('Escape');

    // [폐기 포함]: 폐기된 RULE-007은 확인 · 종류에 더해지고 판정 · 준수 집계(두 분모)에서는 빠진다 (ADR-112 · ADR-114)
    await page.getByTestId('hidden-toggle').click();
    await chipButton(page, 'compliance').click();
    expect(await menuOptions(page)).toEqual([
      ['판정 가능', '5', false],
      ['사람 확인', '3', false],
      ['격리', '0', true],
    ]);
    await page.keyboard.press('Escape');
    await chipButton(page, 'judgment').click();
    expect((await menuOptions(page)).find(([label]) => label === '실패')).toEqual([
      '실패',
      '1',
      false,
    ]);
    await page.keyboard.press('Escape');
    await chipButton(page, 'confirmation').click();
    expect(await menuOptions(page)).toEqual([
      ['미확인', '3', false],
      ['확인됨', '3', false],
    ]);
  });

  test('확인: 미확인을 고르면 미확인 카드만 남고, 칩에 값이 보인다', async ({ page }) => {
    await openScreen(page);
    await chipButton(page, 'confirmation').click();
    await page.getByTestId('filter-option').filter({ hasText: '미확인' }).click();
    await page.keyboard.press('Escape');
    await expect(chipButton(page, 'confirmation')).toHaveText('확인: 미확인');
    expect(await cardIds(page)).toEqual(['RULE-002', 'RULE-006']);
    await expect(page.getByTestId('list-result')).toHaveText('5개 중 2개 · 초기화');
    // [폐기 포함]을 켜면 폐기된 미확인 규칙도 남는다
    await page.getByTestId('hidden-toggle').click();
    expect(await cardIds(page)).toEqual(['RULE-002', 'RULE-006', 'RULE-007']);
    await expect(page.getByTestId('list-result')).toHaveText('6개 중 3개 · 초기화');
  });

  test('준수 집계: 사람 확인을 고르면 확인됨인 분모 규칙만 남는다 (폐기 포함이어도 폐기 규칙은 없음)', async ({
    page,
  }) => {
    await openScreen(page);
    await page.getByTestId('hidden-toggle').click();
    await chipButton(page, 'compliance').click();
    await page.getByTestId('filter-option').filter({ hasText: '사람 확인' }).click();
    await page.keyboard.press('Escape');
    await expect(chipButton(page, 'compliance')).toHaveText('준수 집계: 사람 확인');
    expect(await cardIds(page)).toEqual(['RULE-003', 'RULE-005', 'RULE-001']);
    await expect(page.getByTestId('list-result')).toHaveText('6개 중 3개 · 초기화');
  });

  test('준수 집계: 판정 가능을 고르면 분모 목록만 보이고 다른 화면에 갔다 와도 유지된다', async ({
    page,
  }) => {
    await openScreen(page);
    await chipButton(page, 'compliance').click();
    await page.getByTestId('filter-option').filter({ hasText: '판정 가능' }).click();
    await page.keyboard.press('Escape');
    await expect(chipButton(page, 'compliance')).toHaveText('준수 집계: 판정 가능');
    expect(await cardIds(page)).toEqual([
      'RULE-002',
      'RULE-003',
      'RULE-005',
      'RULE-006',
      'RULE-001',
    ]);
    await expect(page.getByTestId('list-result')).toHaveText('5개 중 5개 · 초기화');

    await page.getByRole('button', { name: '계약', exact: true }).click();
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(chipButton(page, 'compliance')).toHaveText('준수 집계: 판정 가능');

    await page.getByTestId('list-reset').click();
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await expect(page.getByTestId('list-result')).toHaveCount(0);
  });
});

test.describe('변이 상태: 필터 칩 · 카드 예외 "변이 생존" (#60 수용 기준 3, JDG-04 · ADR-146)', () => {
  const openMutation = (page: Page) =>
    openScreen(page, { 'rule.list': { result: { rules: MUTATION_RULES } } });
  const exceptionsOf = (page: Page, displayId: string) =>
    page.getByTestId('card').filter({ hasText: displayId }).getByTestId('card-exception');

  test('서버가 변이 상태를 실으면 변이 칩이 활성이고 값별 개수는 그 값에서 센다(폐기 규칙은 값 없음)', async ({
    page,
  }) => {
    await openMutation(page);
    await expect(chipButton(page, 'mutation')).toBeEnabled();
    await chipButton(page, 'mutation').click();
    // 값 이름은 칩 이름 "변이" 뒤에 붙는 짧은 이름 (검증됨 · 미검증 · 생존)
    expect(await menuOptions(page)).toEqual([
      ['검증됨', '2', false],
      ['미검증', '1', false],
      ['생존', '2', false],
    ]);
    await page.keyboard.press('Escape');
    // [폐기 포함]: 폐기된 RULE-007(생존 기록)은 변이 값을 갖지 않는다
    await page.getByTestId('hidden-toggle').click();
    await chipButton(page, 'mutation').click();
    expect((await menuOptions(page)).find(([label]) => label === '생존')).toEqual([
      '생존',
      '2',
      false,
    ]);
  });

  test('변이 생존을 고르면 칩에 값이 보이고 변이 생존 규칙만 남는다. ×로 풀린다', async ({
    page,
  }) => {
    await openMutation(page);
    await chipButton(page, 'mutation').click();
    await page.getByTestId('filter-option').filter({ hasText: '생존' }).click();
    await page.keyboard.press('Escape');
    await expect(chipButton(page, 'mutation')).toHaveText('변이: 생존');
    expect(await cardIds(page)).toEqual(['RULE-001', 'RULE-002']);
    await expect(page.getByTestId('list-result')).toHaveText('5개 중 2개 · 초기화');
    await page.getByTestId('filter-chip-mutation').getByTestId('filter-chip-clear').click();
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
  });

  test('카드 예외 "변이 생존"(위험 색)은 판정 예외 바로 뒤 · 규범 예외 앞이고, 정상 변이 상태는 아무것도 더하지 않는다', async ({
    page,
  }) => {
    await openMutation(page);
    // 실패 → 변이 생존 → 미확인 (SCR-03 카드 예외 순서 "실패 · 재검증 필요 · 변이 생존 · 잠정")
    await expect(exceptionsOf(page, 'RULE-002')).toHaveText(['실패', '변이 생존', '미확인']);
    const survived = exceptionsOf(page, 'RULE-002').filter({ hasText: '변이 생존' });
    await expect(survived).toHaveAttribute('data-tone', 'danger');
    // 통과 + 생존: 1줄 흐린 점(통과)은 그대로이고 2줄에 변이 생존 하나
    const passCard = page.getByTestId('card').filter({ hasText: 'RULE-001' });
    await expect(exceptionsOf(page, 'RULE-001')).toHaveText(['변이 생존']);
    await expect(passCard.getByTestId('status-badge')).toHaveCount(1);
    await expect(passCard.getByTestId('status-badge')).toHaveAttribute('aria-label', '통과');
    // 검증됨 · 미검증: 변이 예외 · 점이 더해지지 않는다
    await expect(exceptionsOf(page, 'RULE-005')).toHaveText(['재검증 필요']);
    await expect(exceptionsOf(page, 'RULE-003')).toHaveText(['미판정']);
    await expect(exceptionsOf(page, 'RULE-006')).toHaveText(['미확인']);
    await expect(
      page.getByTestId('card').filter({ hasText: 'RULE-006' }).getByTestId('status-badge'),
    ).toHaveCount(1);
    await expect(page.getByTestId('card-exception').filter({ hasText: '변이 생존' })).toHaveCount(
      2,
    );
    // 폐기된 규칙은 생존 기록이 있어도 변이 예외가 없다 (판정 예외와 같다)
    await page.getByTestId('hidden-toggle').click();
    await expect(exceptionsOf(page, 'RULE-007')).toHaveText(['폐기', '미확인']);
    // [문제만]: 통과 · 확인됨이던 RULE-001도 변이 생존으로 문제 항목이다
    await page.getByTestId('hidden-toggle').click();
    await page.getByTestId('problem-toggle').click();
    expect(await cardIds(page)).toContain('RULE-001');
  });

  test('변이 생존과 추적성 결함을 함께 가진 카드: 실패 → 변이 생존 → 추적성 결함 → 미확인 순서', async ({
    page,
  }) => {
    await openScreen(page, {
      'rule.list': { result: { rules: MUTATION_RULES, traceability: MUTATION_TRACEABILITY } },
    });
    await expect(exceptionsOf(page, 'RULE-002')).toHaveText([
      '실패',
      '변이 생존',
      '추적성 결함',
      '미확인',
    ]);
    // 추적성 결함이 없는 생존 카드는 그대로
    await expect(exceptionsOf(page, 'RULE-001')).toHaveText(['변이 생존']);
  });

  test('변이 상태 칸이 없는 옛 응답이면 칩은 0건 비활성이고 어느 카드에도 "변이 생존"이 없다', async ({
    page,
  }) => {
    await openScreen(page);
    await expect(chipButton(page, 'mutation')).toBeDisabled();
    await expect(page.getByText('변이 생존')).toHaveCount(0);
  });

  test('검증 화면의 변이 검증됨 카드에서 넘어오면 "변이: 생존"이 걸린 채 열리고 다른 화면에 갔다 와도 유지된다', async ({
    page,
  }) => {
    await mockBive(page, {
      responses: {
        'system.status': { result: STATUS },
        'project.current': { result: { project: PROJECT } },
        'rule.list': { result: { rules: MUTATION_RULES } },
        'verification.summary': { result: SUMMARY },
        'verification.trend': { result: TREND },
        'codeOpen.summary': { result: CODE_OPEN_SUMMARY },
      },
    });
    await page.goto('/');
    await page.getByRole('button', { name: '검증', exact: true }).click();
    await page.getByTestId('metric-mutation').click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await expect(chipButton(page, 'mutation')).toHaveText('변이: 생존');
    expect(await cardIds(page)).toEqual(['RULE-001', 'RULE-002']);
    await page.getByRole('button', { name: '계약', exact: true }).click();
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(chipButton(page, 'mutation')).toHaveText('변이: 생존');
    expect(await cardIds(page)).toEqual(['RULE-001', 'RULE-002']);
  });

  for (const width of [820, 1280]) {
    test(`창 폭 ${String(width)}: 변이 칩 · 예외가 있는 카드가 목록 밖으로 넘치지 않는다`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await openMutation(page);
      await chipButton(page, 'mutation').click();
      await page.getByTestId('filter-option').filter({ hasText: '생존' }).click();
      await page.keyboard.press('Escape');
      await expect(chipButton(page, 'mutation')).toHaveText('변이: 생존');
      const list = page.getByTestId('list-view');
      expect(await horizontalOverflow(list, '[data-testid="card"]')).toEqual([]);
      expect(await horizontalOverflow(list, '[data-testid^="filter-chip-"]')).toEqual([]);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `scr-03-mutation-${String(width)}.png`),
      });
    });
  }
});

test.describe('프로젝트 전환 (ADR-034 · ADR-060)', () => {
  test('다른 프로젝트가 열리면 이전 목록 없이 로딩부터 하고 새 프로젝트로 다시 부른다', async ({
    page,
  }) => {
    const bive = await openScreen(page);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    // 블록 · 위험도 칩을 골라 둔다 (프로젝트 전환 때 함께 지워져야 한다, #64)
    await chipButton(page, 'block').click();
    await page.getByTestId('filter-option').filter({ hasText: 'lib' }).click();
    await page.keyboard.press('Escape');
    await chipButton(page, 'risk').click();
    await page.getByTestId('filter-option').filter({ hasText: '낮음' }).click();
    await page.keyboard.press('Escape');
    expect(await cardIds(page)).toEqual(['RULE-005']);
    await bive.setResponse('rule.list', { result: { rules: [] }, delayMs: 1500 });
    await bive.emit(PROJECT_OPENED_EVENT, { project: OTHER_PROJECT, created: false, empty: false });
    // 프로젝트가 열리면 요구사항 화면으로 이동하므로(ADR-055) 다시 규칙으로 간다
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(page.getByTestId('rules-loading')).toBeVisible();
    await expect(page.getByTestId('card')).toHaveCount(0);
    await expect(page.getByTestId('list-view').getByTestId('empty-state')).toHaveText('규칙 없음');
    const listCalls = await callsOf(bive, 'rule.list');
    expect(listCalls.at(-1)?.params).toEqual({ projectId: OTHER_PROJECT.id, includeRetired: true });
    // 새 프로젝트의 규칙 목록에서 블록 · 위험도 선택이 남아 있지 않다
    await bive.setResponse('rule.list', { result: { rules: RULES } });
    await bive.emit(PROJECT_OPENED_EVENT, { project: PROJECT, created: false, empty: false });
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await expect(chipButton(page, 'block')).toHaveText('블록');
    await expect(chipButton(page, 'risk')).toHaveText('위험도');
    await expect(page.getByTestId('list-result')).toHaveCount(0);
  });
});

test.describe('[실행]으로 만든 실행의 표시 (프로젝트당 동시 실행 1개 · 실행 대기, ADR-105)', () => {
  /** 테스트 전용 실행 값 (NFR-03: 화면은 run.create · run.get 응답만 쓴다). */
  const created = (status: RunStatus, currentStep: StepKind | null): Run =>
    summaryRun({
      id: '01JE0000000000000000000004',
      displayId: 'EXE-004',
      projectId: PROJECT.id,
      targetRuleIds: [RULES[0]?.rule.id ?? ''],
      status,
      currentStep,
      lastCompletedStep: status === 'waiting_approval' ? null : 'approval',
      branch: null,
      worktreePath: null,
      baseCommit: null,
      startedAt: null,
      costUsd: null,
      turns: null,
    });
  /** `run.get` 가짜 응답: 비용 · 턴 집계는 화면이 읽지 않으므로 빈 값 (테스트 전용 데이터). */
  const got = (run: Run): RunGetResult =>
    ({
      run,
      steps: [],
      usage: {
        run: {
          costUsd: null,
          turns: null,
          modelUsage: null,
          sessionCount: 0,
          costUnknownCount: 0,
          turnsUnknownCount: 0,
        },
        roles: {},
        steps: [],
      },
    }) as unknown as RunGetResult;
  const runUpdated = (status: RunStatus): RunUpdatedEvent => ({
    projectId: PROJECT.id,
    runId: '01JE0000000000000000000004',
    displayId: 'EXE-004',
    status,
    currentStep: 'test_writing',
    regressionCount: 0,
    costUsd: null,
  });

  /** run.create(생성 직후 승인 대기) · run.get(실행 대기) 응답을 둔 화면. */
  const openWithCreate = (page: Page): Promise<BiveMock> =>
    openScreen(page, {
      'run.create': {
        result: {
          run: created('waiting_approval', 'approval'),
          steps: [],
          approvalLog: {
            seq: 1,
            at: '2026-10-16T05:00:00.000Z',
            action: 'run_start',
            actor: { kind: 'human' },
            targetRef: { entity: 'Run', id: '01JE0000000000000000000004' },
            clientId: null,
            detail: { ruleIds: [RULES[0]?.rule.id ?? ''] },
            prevHash: '0'.repeat(64),
            hash: 'a'.repeat(64),
          },
        } as unknown as RunCreateResult,
      },
      'run.get': { result: got(created('queued', 'test_writing')) },
    });

  test('진행 중인 실행이 있을 때 만든 실행은 상세 머리줄 아래에 "EXE-004 · 실행 대기"로 보이고, 시작하면 "진행 중"으로 바뀐다', async ({
    page,
  }) => {
    const bive = await openWithCreate(page);
    await page.getByTestId('card').filter({ hasText: 'RULE-001' }).click();
    // 아직 실행을 만들지 않았으면 표시가 없다
    await expect(page.getByTestId('run-start-created')).toHaveCount(0);
    await page.getByTestId('run-start').click();
    await page.getByTestId('run-start-confirm').click();
    await expect(page.getByTestId('run-start-dialog')).toHaveCount(0);
    // 생성 응답의 상태(승인 대기) → 실행 알림 뒤 다시 읽은 상태(실행 대기)
    const createdEl = page.getByTestId('run-start-created');
    await expect(createdEl).toHaveText('EXE-004 · 승인 대기');
    await bive.emit('event.run.updated', runUpdated('queued'));
    await expect(createdEl).toHaveText('EXE-004 · 실행 대기');
    await expect(createdEl).toHaveAttribute('data-status', 'queued');
    await expect(createdEl).toBeVisible();
    expect(findForbiddenText(await collectVisibleText(page))).toEqual([]);
    for (const call of await callsOf(bive, 'run.get')) {
      expect(call.params).toEqual({ projectId: PROJECT.id, id: '01JE0000000000000000000004' });
    }

    // 앞 실행이 끝나 시작하면 "진행 중"
    await bive.setResponse('run.get', { result: got(created('running', 'test_writing')) });
    await bive.emit('event.run.updated', runUpdated('running'));
    await expect(createdEl).toHaveText('EXE-004 · 진행 중');

    // 다른 규칙을 고르면 보이지 않는다 (그 규칙으로 만든 실행이 아님)
    await page.getByTestId('card').filter({ hasText: 'RULE-002' }).click();
    await expect(page.getByTestId('run-start-created')).toHaveCount(0);
  });

  /** 상세 머리줄(제목 · ID · 배지 · [실행])의 경계 상자. */
  const headBoxes = (page: Page) =>
    page
      .getByTestId('rule-detail')
      .locator('.rule-detail-head')
      .evaluate((head) =>
        [head, ...head.children].map((el) => {
          const box = el.getBoundingClientRect();
          return [box.x, box.y, box.width, box.height].map((v) => Math.round(v));
        }),
      );

  for (const width of [1280, 1100, 820] as const) {
    test(`창 폭 ${String(width)}px: 만든 실행 표시가 있어도 머리줄 배치(제목 폭 포함)가 표시 전과 같고 상세에 가로 넘침이 없다 (#218 검토)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      const bive = await openWithCreate(page);
      await page.getByTestId('card').filter({ hasText: 'RULE-001' }).click();
      await expect(page.getByTestId('rule-detail-title')).toBeVisible();
      const before = await headBoxes(page);
      await page.getByTestId('run-start').click();
      await page.getByTestId('run-start-confirm').click();
      const createdEl = page.getByTestId('run-start-created');
      // 표시가 생겨(알림 구독 뒤) 알림을 보낸다
      await expect(createdEl).toHaveText('EXE-004 · 승인 대기');
      await bive.emit('event.run.updated', runUpdated('queued'));
      await expect(createdEl).toHaveText('EXE-004 · 실행 대기');
      expect(await headBoxes(page)).toEqual(before);
      const pane = page.getByTestId('rule-detail');
      expect(await horizontalOverflow(pane, '[data-testid="run-start-created"]')).toEqual([]);
      expect(await brokenWords(page.getByTestId('rule-detail-title'))).toEqual([]);
      // 머리줄 밖(아래)이다
      const head = await pane.locator('.rule-detail-head').boundingBox();
      const line = await createdEl.boundingBox();
      if (head === null || line === null) throw new Error('머리줄 · 표시 없음');
      expect(line.y).toBeGreaterThanOrEqual(head.y + head.height - 0.5);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `scr-03-created-run-${String(width)}.png`),
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

  test('칩 메뉴를 연 상태와 로딩 · 에러 상태에도 금지 문구가 없다', async ({ page }) => {
    const bive = await openScreen(page);
    await expect(page.getByTestId('card')).toHaveCount(LIVE.length);
    await chipButton(page, 'judgment').click();
    await expect(page.getByTestId('filter-menu')).toBeVisible();
    await expectCleanText(page);
    await page.keyboard.press('Escape');

    await bive.setResponse('rule.list', { pending: true });
    await page.getByRole('button', { name: '검증', exact: true }).click();
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(page.getByTestId('rules-loading')).toBeVisible();
    await expectCleanText(page);
  });

  test('에러 상태에도 금지 문구가 없다', async ({ page }) => {
    await openScreen(page, { 'rule.list': { error: { code: -32603, message: '내부 오류' } } });
    await expect(page.getByTestId('rules-load-error')).toBeVisible();
    await expectCleanText(page);
  });
});
