// SCR-01 프로젝트 시작 (이슈 #14 수용 기준 3, PRJ-01 · ADR-036):
// 기본 상태([폴더 열기]) · 빈 폴더와 비어 있지 않은 미연결 폴더 모두 요구사항 화면으로 진입 · [BIVE 동기화] 없음 ·
// 연결된 프로젝트 재진입(`project.current`) · 기동 인자로 연 프로젝트(`project.opened` 알림) · 취소 · 실패.
import type { Project, ProjectOpenResult } from '@bive/shared';
import { expect, type Page, test } from '@playwright/test';

import { HIDDEN_BUTTONS, PROJECT_START_TEXT } from './checklists/scr-01.js';
import { type BiveMock, type MockResponses, mockBive } from './support/bive-mock.js';
import { expectScreen, FORBIDDEN_TEXT } from './support/expectScreen.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;

// 테스트 데이터 (제품 코드 경로에 두지 않는다, CLAUDE.md 4장)
const project = (name: string): Project => ({
  id: '01JB2C3D4E5F6G7H8J9KAMBNCP',
  name,
  rootPath: `/work/${name}`,
  baseBranch: 'main',
  createdAt: '2026-10-16T09:00:00.000Z',
});

const opened = (name: string, extra: Partial<ProjectOpenResult> = {}): ProjectOpenResult => ({
  project: project(name),
  created: true,
  empty: false,
  ...extra,
});

const start = async (page: Page, responses: MockResponses = {}): Promise<BiveMock> => {
  const bive = await mockBive(page, {
    responses: {
      'system.status': { result: STATUS },
      'project.current': { result: { project: null } },
      ...responses,
    },
  });
  await page.goto('/');
  return bive;
};

const mainArea = (page: Page) => page.getByTestId('main-area');

/** [BIVE 동기화] · [요구사항 자동 생성]이 화면 어디에도 없다 (ADR-035 · ADR-036). */
const expectNoHiddenButtons = async (page: Page): Promise<void> => {
  for (const name of HIDDEN_BUTTONS) {
    await expect(page.getByRole('button', { name })).toHaveCount(0);
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  }
};

/** 화면에 보이는 글자에 PRD ID · 화면 코드 · 이모지가 없다. */
const expectNoForbiddenText = async (page: Page): Promise<void> => {
  const text = await page.locator('body').innerText();
  for (const { label, pattern } of FORBIDDEN_TEXT) {
    expect(text.match(new RegExp(pattern.source, pattern.flags)), label).toBeNull();
  }
};

/** 요구사항 화면으로 들어갔고 사이드바 상단에 폴더 이름이 보인다. */
const expectEntered = async (page: Page, name: string): Promise<void> => {
  await expect(mainArea(page)).toHaveAttribute('data-route', 'requirements');
  await expect(page.getByRole('button', { name: '요구사항', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByTestId('sidebar-project')).toHaveText(name);
  await expect(page.getByTestId('sidebar-project')).toHaveAttribute('data-state', 'open');
  await expect(page.getByTestId('project-start')).toHaveCount(0);
  await expectNoHiddenButtons(page);
  await expectNoForbiddenText(page);
};

test.describe('기본 상태', () => {
  test('체크리스트: 제목 · [폴더 열기] · 프로젝트 없음 · 동기화와 자동 생성 미노출', async ({
    page,
  }) => {
    await start(page);
    await expectScreen(page, 'SCR-01', '기본');
  });

  test('프로젝트가 없으면 앱 시작 화면이 프로젝트 시작이고 메뉴는 "준비 중"으로 이동한다', async ({
    page,
  }) => {
    const bive = await start(page);
    await expect(mainArea(page)).toHaveAttribute('data-route', 'start');
    await page.getByRole('button', { name: '규칙', exact: true }).click();
    await expect(mainArea(page).getByTestId('empty-state')).toHaveText('규칙 준비 중');
    await expect(page.getByTestId('sidebar-project')).toHaveText('프로젝트 없음');
    // 폴더 선택 · 열기는 누르기 전에 부르지 않는다
    const methods = (await bive.calls()).map((call) => call.method);
    expect(methods).not.toContain('app.pickFolder');
    expect(methods).not.toContain('project.open');
  });
});

test.describe('[폴더 열기] → 요구사항 화면', () => {
  test('빈 폴더: 폴더 선택 → project.open → 요구사항 화면, 동기화 없음', async ({ page }) => {
    const bive = await start(page, {
      'app.pickFolder': { result: { path: '/work/new-app' } },
      'project.open': { result: opened('new-app', { empty: true }) },
    });

    await page.getByRole('button', { name: PROJECT_START_TEXT.openFolder }).click();

    await expectEntered(page, 'new-app');
    const calls = (await bive.calls()).filter(
      (c) => c.method.startsWith('app.') || c.method === 'project.open',
    );
    expect(calls).toEqual([
      { method: 'app.pickFolder', params: undefined },
      { method: 'project.open', params: { path: '/work/new-app' } },
    ]);
  });

  test('비어 있지 않은 미연결 폴더도 같은 방식으로 요구사항 화면에 들어가고 동기화 없음 (ADR-036)', async ({
    page,
  }) => {
    const bive = await start(page, {
      'app.pickFolder': { result: { path: '/work/sample-next-app' } },
      'project.open': { result: opened('sample-next-app', { empty: false }) },
    });

    await page.getByRole('button', { name: PROJECT_START_TEXT.openFolder }).click();

    await expectEntered(page, 'sample-next-app');
    expect((await bive.calls()).filter((c) => c.method === 'project.open')).toEqual([
      { method: 'project.open', params: { path: '/work/sample-next-app' } },
    ]);
  });

  test('폴더 선택을 취소하면 project.open을 부르지 않고 시작 화면에 머문다', async ({ page }) => {
    const bive = await start(page, { 'app.pickFolder': { result: { path: null } } });

    await page.getByRole('button', { name: PROJECT_START_TEXT.openFolder }).click();

    await expect(page.getByRole('button', { name: PROJECT_START_TEXT.openFolder })).toBeEnabled();
    expect((await bive.calls()).map((c) => c.method)).toContain('app.pickFolder');
    expect((await bive.calls()).map((c) => c.method)).not.toContain('project.open');
    await expectScreen(page, 'SCR-01', '기본', { screenshot: false });
  });

  test('열기 실패: "폴더 열기 실패" 한 줄, 시작 화면에 머문다', async ({ page }) => {
    await start(page, {
      'app.pickFolder': { result: { path: '/work/gone' } },
      'project.open': { error: { code: -32004, message: '폴더를 찾을 수 없습니다' } },
    });

    await page.getByRole('button', { name: PROJECT_START_TEXT.openFolder }).click();

    await expectScreen(page, 'SCR-01', '에러');
    await expect(mainArea(page)).toHaveAttribute('data-route', 'start');
  });

  test('여는 동안 [폴더 열기]는 비활성이다', async ({ page }) => {
    await start(page, {
      'app.pickFolder': { result: { path: '/work/slow-app' } },
      'project.open': { pending: true },
    });
    const button = page.getByRole('button', { name: PROJECT_START_TEXT.openFolder });
    await button.click();
    await expect(button).toBeDisabled();
  });
});

test.describe('재진입 · 기동 인자', () => {
  test('연결된 프로젝트(project.current)가 있으면 시작 화면 없이 요구사항 화면으로 들어간다', async ({
    page,
  }) => {
    const bive = await start(page, {
      'project.current': { result: { project: project('sample-next-app') } },
    });
    await expectEntered(page, 'sample-next-app');
    expect((await bive.calls()).map((c) => c.method)).not.toContain('app.pickFolder');
  });

  test('main이 연 프로젝트(project.opened 알림, 기동 인자)로 대화상자 없이 들어간다', async ({
    page,
  }) => {
    const bive = await start(page, { 'project.current': { result: { project: null } } });
    await expect(mainArea(page)).toHaveAttribute('data-route', 'start');

    await bive.emit('project.opened', opened('sample-next-app', { created: false }));

    await expectEntered(page, 'sample-next-app');
    const methods = (await bive.calls()).map((c) => c.method);
    expect(methods).not.toContain('app.pickFolder');
    expect(methods).not.toContain('project.open');
  });

  test('알림이 먼저 오면 늦게 온 첫 조회 결과(null)로 덮지 않는다', async ({ page }) => {
    const bive = await mockBive(page, {
      responses: {
        'system.status': { result: STATUS },
        'project.current': { result: { project: null }, delayMs: 500 },
      },
      events: [{ event: 'project.opened', params: opened('early-app'), delayMs: 0 }],
    });
    await page.goto('/');
    await expectEntered(page, 'early-app');
    await page.waitForTimeout(700);
    await expect(page.getByTestId('sidebar-project')).toHaveText('early-app');
    expect((await bive.calls()).map((c) => c.method)).toContain('project.current');
  });
});
