// SCR-04 계약 (이슈 #50 수용 기준 1 · 2 · 3, screens.md SCR-04 · 1.4, NRM-03, ADR-029 · ADR-100 I3, ADR-133).
// 1) checklists/scr-04.ts의 기본(종류 · 원본 파일 · 연결 규칙 · 판정 · 생성 주체 · 확인 상태) · 빈("계약 없음") 상태
// 2) 결함(스키마 불일치 · 검사 규칙 없음)과 미확인이 카드 2줄째 예외로 보이고 결함이 [문제만]에 잡힌다
// 3) 필터 칩 3종(종류 · 검사 규칙 · 판정)과 확인 칩(미확인 · 확인됨)
// 데이터는 가짜 브리지의 project.current · contract.list · rule.list · requirement.get 응답과 알림으로만 만든다.
import { expect, type Locator, type Page, test } from '@playwright/test';

import type { ContractListResult, Project } from '@bive/shared';

import { PROJECT_OPENED_EVENT } from '../src/common/bridge.js';
import {
  CHIPS,
  CONTRACT_RULES,
  CONTRACTS,
  PARENT,
  PROJECT,
  VISIBLE_ORDER,
} from './checklists/scr-04.js';
import {
  allSettled,
  type BiveMock,
  type MockCall,
  mockBive,
  type MockResponses,
  nextFrame,
} from './support/bive-mock.js';
import { collectVisibleText, expectScreen, findForbiddenText } from './support/expectScreen.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
const OTHER_PROJECT: Project = {
  id: '01JCCCCCCCCCCCCCCCCCCCCCCC',
  name: 'other-app',
  rootPath: '/work/other-app',
  baseBranch: 'main',
  createdAt: '2026-10-15T00:00:00.000Z',
};

type Entry = ContractListResult['contracts'][number];

const openScreen = async (
  page: Page,
  responses: MockResponses = {},
  { project = true }: { project?: boolean } = {},
): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: project ? PROJECT : null } },
      'contract.list': { result: { contracts: CONTRACTS } },
      'rule.list': { result: { rules: CONTRACT_RULES } },
      ...(PARENT !== undefined && { 'requirement.get': { result: { requirement: PARENT } } }),
      ...responses,
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: '계약', exact: true }).click();
  return bive;
};

const callsOf = async (bive: BiveMock, method: string): Promise<MockCall[]> =>
  (await bive.calls()).filter((call) => call.method === method);

const cardIds = (page: Page): Promise<string[]> => page.getByTestId('card-id').allTextContents();
const card = (page: Page, displayId: string): Locator =>
  page.getByTestId('card').filter({ has: page.getByTestId('card-id').getByText(displayId) });
const chipButton = (page: Page, id: string): Locator =>
  page.getByTestId(`filter-chip-${id}`).getByTestId('filter-chip-button');
const detailValue = (page: Page, id: string): Locator =>
  page.getByTestId('contract-detail').getByTestId(`contract-value-${id}`);

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

const pickOption = async (page: Page, chip: string, option: string): Promise<void> => {
  await chipButton(page, chip).click();
  await page
    .getByTestId('filter-option')
    .filter({ has: page.locator('.filter-option-label', { hasText: new RegExp(`^${option}$`) }) })
    .click();
  await page.keyboard.press('Escape');
};

const withConfirmed = (entries: readonly Entry[]): Entry[] =>
  entries.map((entry) => ({
    ...entry,
    contract: {
      ...entry.contract,
      confirmation: {
        state: 'confirmed',
        at: '2026-11-20T02:00:00.000Z',
        by: { kind: 'human' },
        basis: { kind: 'contract_record', at: entry.contract.createdAt },
      },
    },
  }));

test.describe('체크리스트 (수용 기준 1)', () => {
  test('기본: 카드를 고르면 상세에 종류 · 원본 파일 · 연결 규칙 · 판정 · 부모 요구사항 · 생성 주체 · 확인 상태', async ({
    page,
  }) => {
    const bive = await openScreen(page);
    await card(page, 'CON-001').click();
    await expectScreen(page, 'SCR-04', '기본');
    // 상세 속성 줄 순서
    await expect(
      page.getByTestId('contract-detail').locator('[data-testid^="contract-field-"] > dt'),
    ).toHaveText([
      '종류',
      '원본 파일',
      '연결 규칙',
      '판정',
      '부모 요구사항',
      '생성 주체',
      '확인 상태',
    ]);
    // 상세의 버튼은 연결 규칙 링크 하나뿐이다([확인] · 지시 없음, ADR-133)
    await expect(page.getByTestId('contract-detail').getByRole('button')).toHaveText(['RULE-011']);
    // 부모 요구사항은 requirement.get으로 표시 ID를 읽는다
    const parents = await callsOf(bive, 'requirement.get');
    expect(parents.length).toBeGreaterThan(0);
    for (const call of parents) {
      expect(call.params).toEqual({ projectId: PROJECT.id, id: PARENT?.id });
    }
  });

  test('빈: "계약 없음" 한 줄, 칩은 전부 0건 비활성', async ({ page }) => {
    await openScreen(page, { 'contract.list': { result: { contracts: [] } } });
    await expectScreen(page, 'SCR-04', '빈');
    for (const chip of CHIPS) await expect(chipButton(page, chip.id)).toBeDisabled();
  });

  test('로딩: 목록 자리는 문구 없이 대기 (규칙 판정을 기다리는 동안도)', async ({ page }) => {
    await openScreen(page, { 'rule.list': { pending: true } });
    await expectScreen(page, 'SCR-04', '로딩');
    await expect(page.getByTestId('contracts-loading')).toHaveText('');
  });

  test('에러: 계약 조회가 실패하면 "계약 불러오기 실패"', async ({ page }) => {
    await openScreen(page, {
      'contract.list': { error: { code: -32004, message: '프로젝트 없음' } },
    });
    await expectScreen(page, 'SCR-04', '에러');
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'connected');
  });

  test('에러: 검사 규칙의 판정 조회만 실패해도 목록을 보이지 않는다 (결함을 모른 채 정상처럼 보이지 않게)', async ({
    page,
  }) => {
    await openScreen(page, { 'rule.list': { error: { code: -32603, message: '내부 오류' } } });
    await expectScreen(page, 'SCR-04', '에러');
    await expect(page.getByTestId('card')).toHaveCount(0);
  });

  test('열린 프로젝트가 없으면 "프로젝트 없음"이고 목록을 부르지 않는다', async ({ page }) => {
    const bive = await openScreen(page, {}, { project: false });
    const main = page.getByTestId('main-area');
    await expect(main.getByTestId('empty-state')).toHaveText('프로젝트 없음');
    await expect(main.getByText('계약 준비 중')).toHaveCount(0);
    await expect(page.getByTestId('list-view')).toHaveCount(0);
    expect(await callsOf(bive, 'contract.list')).toEqual([]);
  });

  test('contract.list · rule.list를 현재 프로젝트로 부른다', async ({ page }) => {
    const bive = await openScreen(page);
    await expect(page.getByTestId('card')).toHaveCount(CONTRACTS.length);
    const contractCalls = await callsOf(bive, 'contract.list');
    expect(contractCalls.length).toBeGreaterThan(0);
    for (const call of contractCalls) expect(call.params).toEqual({ projectId: PROJECT.id });
    // 계약 검사 규칙은 폐기되지 않으므로 기본 목록(폐기 제외)으로 읽는다. 다른 영역의 rule.list 호출과 섞여 있어 포함만 본다
    const ruleCalls = (await callsOf(bive, 'rule.list')).map((call) => call.params);
    expect(ruleCalls).toContainEqual({ projectId: PROJECT.id });
  });
});

test.describe('결함 · 미확인 예외와 [문제만] (수용 기준 2)', () => {
  test('카드 2줄째: 표시 ID · 결함 · 미확인 · 등록 시각, 정상은 예외가 비어 있다', async ({
    page,
  }) => {
    await openScreen(page);
    expect(await cardIds(page)).toEqual([...VISIBLE_ORDER]);
    const exceptions = (id: string): Locator =>
      card(page, id).getByTestId('card-line-2').getByTestId('card-exception');
    // 판정 기록 없음(미판정)은 결함이 아니다: 미확인만
    await expect(exceptions('CON-004')).toHaveText(['미확인']);
    // 검사 규칙 없음은 결함, 미확인보다 앞
    await expect(exceptions('CON-003')).toHaveText(['검사 규칙 없음', '미확인']);
    await expect(exceptions('CON-003').first()).toHaveAttribute('data-tone', 'danger');
    // 검사 규칙의 최신 판정이 실패면 스키마 불일치
    await expect(exceptions('CON-002')).toHaveText(['스키마 불일치']);
    await expect(exceptions('CON-002')).toHaveAttribute('data-tone', 'danger');
    await expect(exceptions('CON-001')).toHaveCount(0);
    // 예외는 카드 2줄째에만 있다
    await expect(page.getByTestId('card-exception')).toHaveCount(4);
    // 판정 상태 글자(실패 · 미판정)는 카드에 따로 보이지 않는다(결함으로만)
    await expect(page.getByTestId('list-items').getByText('실패', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('list-items').getByText('미판정', { exact: true })).toHaveCount(
      0,
    );
    // 통과만 1줄 앞 흐린 점
    const dot = card(page, 'CON-001').getByTestId('status-badge');
    await expect(dot).toHaveAttribute('data-tone', 'normal');
    await expect(page.getByTestId('list-items').getByTestId('status-badge')).toHaveCount(1);
    // 시각 = 등록 시각, 2줄째 끝
    for (const { contract } of CONTRACTS) {
      const time = card(page, contract.displayId).getByTestId('card-line-2').locator('time');
      await expect(time).toHaveAttribute('dateTime', contract.createdAt);
      await expect(
        card(page, contract.displayId).getByTestId('card-line-2').locator(':scope > *').last(),
      ).toHaveAttribute('dateTime', contract.createdAt);
    }
    // 1줄 = 원본 파일, 생성 주체 아이콘
    await expect(card(page, 'CON-002').getByTestId('card-title')).toHaveText(
      'prisma/schema.prisma',
    );
    await expect(card(page, 'CON-003').getByTestId('author-mark')).toHaveAttribute(
      'data-author',
      'agent',
    );
  });

  test('[문제만]은 결함과 미확인이 있는 계약만 보인다', async ({ page }) => {
    await openScreen(page);
    await page.getByTestId('problem-toggle').click();
    expect(await cardIds(page)).toEqual(['CON-004', 'CON-003', 'CON-002']);
    await expect(page.getByTestId('list-result')).toHaveText('4개 중 3개 · 초기화');
  });

  test('[문제만]: 모두 확인됨이면 결함 둘만 남고 미판정 · 통과 계약은 빠진다', async ({ page }) => {
    await openScreen(page, {
      'contract.list': { result: { contracts: withConfirmed(CONTRACTS) } },
    });
    await expect(page.getByTestId('card')).toHaveCount(4);
    await page.getByTestId('problem-toggle').click();
    expect(await cardIds(page)).toEqual(['CON-003', 'CON-002']);
    await expect(page.getByTestId('card-exception')).toHaveText([
      '검사 규칙 없음',
      '스키마 불일치',
    ]);
  });

  test('상세: 결함 계약의 연결 규칙 · 판정 · 생성 주체 · 확인 상태', async ({ page }) => {
    await openScreen(page);
    await card(page, 'CON-002').click();
    await expect(detailValue(page, 'kind')).toHaveText('DB');
    await expect(detailValue(page, 'rule')).toHaveText('RULE-012');
    await expect(detailValue(page, 'judgment')).toHaveText('실패');
    await expect(detailValue(page, 'parent')).toHaveText('없음');

    await card(page, 'CON-003').click();
    await expect(page.getByTestId('contract-detail-id')).toHaveText('CON-003');
    await expect(detailValue(page, 'kind')).toHaveText('이벤트');
    await expect(detailValue(page, 'rule')).toHaveText('없음');
    await expect(page.getByTestId('contract-rule-ref')).toHaveCount(0);
    await expect(detailValue(page, 'judgment')).toHaveText('없음');
    await expect(detailValue(page, 'author')).toHaveText('에이전트 · 규칙 작성');
    await expect(detailValue(page, 'confirmation')).toHaveText('미확인');

    await card(page, 'CON-004').click();
    await expect(detailValue(page, 'judgment')).toHaveText('미판정');
    await expect(detailValue(page, 'rule')).toHaveText('RULE-014');
  });

  test('연결 규칙을 누르면 규칙 화면이 그 규칙을 고른 상태로 열린다', async ({ page }) => {
    await openScreen(page);
    await card(page, 'CON-002').click();
    await page.getByTestId('contract-rule-ref').click();
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');
    await expect(page.getByTestId('rule-detail')).toHaveAttribute(
      'data-selected-id',
      CONTRACT_RULES[1]?.rule.id ?? '',
    );
    await expect(page.getByTestId('list-search')).toHaveValue('RULE-012');
  });

  test('숨은 글자가 든 원본 파일은 보이는 표기로 그린다 (카드 · 상세)', async ({ page }) => {
    const first = CONTRACTS[0] as Entry;
    const odd: Entry = {
      ...first,
      contract: { ...first.contract, sourceFile: 'api/‮open​.yaml' },
    };
    await openScreen(page, { 'contract.list': { result: { contracts: [odd] } } });
    await expect(page.getByTestId('card-title')).toHaveText('api/\\u202eopen\\u200b.yaml');
    await page.getByTestId('card').click();
    await expect(page.getByTestId('contract-detail-title')).toHaveText(
      'api/\\u202eopen\\u200b.yaml',
    );
    await expect(detailValue(page, 'source')).toHaveText('api/\\u202eopen\\u200b.yaml');
  });

  test('규범 변경 알림을 받으면 다시 읽어 새 판정의 결함을 보인다', async ({ page }) => {
    const bive = await openScreen(page);
    await expect(card(page, 'CON-004').getByTestId('card-exception')).toHaveText(['미확인']);
    const failed = CONTRACT_RULES.map((item) =>
      item.rule.displayId === 'RULE-014'
        ? {
            ...item,
            judgment: {
              status: 'fail' as const,
              latest: {
                ...(CONTRACT_RULES[1]?.judgment.latest ?? (null as never)),
                id: '01JD0000000000000000000099',
                ruleId: item.rule.id,
              },
            },
          }
        : item,
    );
    await bive.setResponse('rule.list', { result: { rules: failed } });
    await bive.emit('event.normChange.appended', { projectId: PROJECT.id, lastSeq: 9 });
    await expect(card(page, 'CON-004').getByTestId('card-exception')).toHaveText([
      '스키마 불일치',
      '미확인',
    ]);
    // 다른 프로젝트 알림으로는 다시 읽지 않는다
    await allSettled(bive, 'contract.list');
    const before = (await callsOf(bive, 'contract.list')).length;
    await bive.emit('event.normChange.appended', { projectId: OTHER_PROJECT.id, lastSeq: 3 });
    await nextFrame(page);
    await allSettled(bive, 'contract.list');
    expect((await callsOf(bive, 'contract.list')).length).toBe(before);
  });

  test('화면 문구에 문서 기호 · 이모지가 없다', async ({ page }) => {
    await openScreen(page);
    await card(page, 'CON-003').click();
    await expect(page.getByTestId('contract-detail-id')).toHaveText('CON-003');
    expect(findForbiddenText(await collectVisibleText(page))).toEqual([]);
  });
});

test.describe('필터 칩 (수용 기준 3)', () => {
  test('칩 4종: 종류 · 검사 규칙 · 판정 · 확인, 값과 개수는 목록 항목에서', async ({ page }) => {
    await openScreen(page);
    await expect(page.getByTestId('list-view').getByTestId('filter-chip-button')).toHaveText(
      CHIPS.map((chip) => chip.label),
    );

    await chipButton(page, 'kind').click();
    expect(await menuOptions(page)).toEqual([
      ['API', '2', false],
      ['DB', '1', false],
      ['이벤트', '1', false],
      ['외부 API', '0', true],
      ['캐시', '0', true],
      ['JSON 스키마', '0', true],
    ]);
    await page.keyboard.press('Escape');

    await chipButton(page, 'rule').click();
    expect(await menuOptions(page)).toEqual([
      ['있음', '3', false],
      ['없음', '1', false],
    ]);
    await page.keyboard.press('Escape');

    await chipButton(page, 'judgment').click();
    expect(await menuOptions(page)).toEqual([
      ['통과', '1', false],
      ['실패', '1', false],
      ['미판정', '1', false],
      ['격리', '0', true],
      ['재검증 필요', '0', true],
    ]);
    await page.keyboard.press('Escape');

    await chipButton(page, 'confirmation').click();
    expect(await menuOptions(page)).toEqual([
      ['미확인', '2', false],
      ['확인됨', '2', false],
    ]);
    await page.keyboard.press('Escape');
  });

  test('칩마다 고른 값의 계약만 남고 칩에 값이 보인다', async ({ page }) => {
    await openScreen(page);
    await pickOption(page, 'kind', 'DB');
    await expect(chipButton(page, 'kind')).toHaveText('종류: DB');
    expect(await cardIds(page)).toEqual(['CON-002']);
    await page.getByTestId('list-reset').click();

    await pickOption(page, 'rule', '없음');
    await expect(chipButton(page, 'rule')).toHaveText('검사 규칙: 없음');
    expect(await cardIds(page)).toEqual(['CON-003']);
    await page.getByTestId('list-reset').click();

    await pickOption(page, 'judgment', '미판정');
    await expect(chipButton(page, 'judgment')).toHaveText('판정: 미판정');
    expect(await cardIds(page)).toEqual(['CON-004']);
    await page.getByTestId('list-reset').click();

    await pickOption(page, 'confirmation', '미확인');
    await expect(chipButton(page, 'confirmation')).toHaveText('확인: 미확인');
    expect(await cardIds(page)).toEqual(['CON-004', 'CON-003']);
    await expect(page.getByTestId('list-result')).toHaveText('4개 중 2개 · 초기화');
    await page.getByTestId('list-reset').click();

    await pickOption(page, 'confirmation', '확인됨');
    expect(await cardIds(page)).toEqual(['CON-002', 'CON-001']);
  });

  test('고른 칩은 다른 화면에 갔다 와도 유지되고, 프로젝트가 바뀌면 지워진다', async ({ page }) => {
    const bive = await openScreen(page);
    await pickOption(page, 'kind', 'API');
    expect(await cardIds(page)).toEqual(['CON-004', 'CON-001']);
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await page.getByRole('button', { name: '계약', exact: true }).click();
    await expect(chipButton(page, 'kind')).toHaveText('종류: API');
    expect(await cardIds(page)).toEqual(['CON-004', 'CON-001']);

    await bive.emit(PROJECT_OPENED_EVENT, { project: OTHER_PROJECT, created: false, empty: false });
    // 프로젝트가 열리면 요구사항 화면으로 이동하므로(ADR-055) 다시 계약으로 간다
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'requirements');
    await page.getByRole('button', { name: '계약', exact: true }).click();
    await expect(chipButton(page, 'kind')).toHaveText('종류');
    await expect(page.getByTestId('card')).toHaveCount(CONTRACTS.length);
  });
});
