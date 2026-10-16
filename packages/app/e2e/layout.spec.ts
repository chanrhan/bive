// 레이아웃 (이슈 #13 수용 기준 1 · 3, screens.md 1.2 · SCR-20 위치):
// 사이드바(상단 프로젝트명 · 알림 아이콘, 기획/설계/실행 메뉴, 하단 연결 상태 · 설정 아이콘) · 중앙 영역 ·
// 오른쪽 360px 채팅 자리, 창 폭 1100px 미만의 44px 띠, system.status 성공 · 실패에 따른 연결 상태.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { expect, type Locator, type Page, test } from '@playwright/test';

import { CONNECTION_TEXT, MENU_GROUPS } from './checklists/scr-00-shell.js';
import { mockBive } from './support/bive-mock.js';
import { expectScreen, SCREENSHOT_DIR } from './support/expectScreen.js';

const STATUS = { version: '0.0.0-e2e', uptimeMs: 1000, connections: 1, runsInProgress: 0 } as const;
const FAILED = { code: -32603, message: '오케스트레이터 연결 실패' } as const;

const box = async (locator: Locator): Promise<{ x: number; y: number; w: number; h: number }> => {
  const rect = await locator.boundingBox();
  if (rect === null) throw new Error('요소가 화면에 없음');
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
};

const connection = (page: Page): Locator => page.getByTestId('connection-status');

/** 연결 상태 아이콘(점)과 글자의 계산된 색. */
const connectionColors = (page: Page): Promise<{ icon: string; label: string; muted: string }> =>
  connection(page).evaluate((status) => {
    const icon = status.querySelector('svg');
    const label = status.querySelector('span');
    if (icon === null || label === null) throw new Error('아이콘 · 글자 없음');
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-text-muted)';
    document.body.append(probe);
    const muted = getComputedStyle(probe).color;
    probe.remove();
    return { icon: getComputedStyle(icon).color, label: getComputedStyle(label).color, muted };
  });

test.describe('기본 배치 (1440px)', () => {
  test.beforeEach(async ({ page }) => {
    await mockBive(page, { responses: { 'system.status': { result: STATUS } } });
    await page.goto('/');
  });

  test('체크리스트: 사이드바 · 중앙 영역 · 채팅 자리 · 연결됨', async ({ page }) => {
    await expectScreen(page, 'SCR-00', '기본');
  });

  test('왼쪽 사이드바 · 가운데 중앙 영역 · 오른쪽 360px 채팅이 창 높이를 채운다', async ({
    page,
  }) => {
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('뷰포트 없음');
    const sidebar = await box(page.getByTestId('sidebar'));
    const main = await box(page.getByTestId('main-area'));
    const chat = await box(page.getByTestId('chat-panel'));

    expect(sidebar.x).toBe(0);
    expect(sidebar.w).toBe(232);
    expect(main.x).toBe(sidebar.x + sidebar.w);
    expect(chat.w).toBe(360);
    expect(chat.x).toBe(main.x + main.w);
    expect(chat.x + chat.w).toBe(viewport.width);
    for (const area of [sidebar, main, chat]) {
      expect(area.y).toBe(0);
      expect(area.h).toBe(viewport.height);
    }
    await expect(page.getByTestId('chat-strip')).toHaveCount(0);
  });

  test('사이드바 위 · 가운데 · 아래 순서: 프로젝트명 · 알림 → 메뉴 → 연결 상태 · 설정', async ({
    page,
  }) => {
    const sidebar = page.getByTestId('sidebar');
    const project = await box(sidebar.getByTestId('sidebar-project'));
    const todo = await box(sidebar.getByRole('button', { name: '할 일', exact: true }));
    const nav = await box(sidebar.getByRole('navigation', { name: '메뉴' }));
    const status = await box(sidebar.getByTestId('connection-status'));
    const settings = await box(sidebar.getByRole('button', { name: '설정', exact: true }));

    // 상단: 프로젝트명 왼쪽, 알림 아이콘 오른쪽 · 하단: 연결 상태 왼쪽, 설정 아이콘 오른쪽
    expect(todo.x).toBeGreaterThan(project.x);
    expect(settings.x).toBeGreaterThan(status.x);
    expect(project.y + project.h).toBeLessThanOrEqual(nav.y);
    expect(nav.y + nav.h).toBeLessThanOrEqual(status.y);
    // 아이콘은 이모지가 아닌 SVG
    await expect(sidebar.getByTestId('todo-button').locator('svg')).toHaveCount(1);
    await expect(sidebar.getByTestId('settings-button').locator('svg')).toHaveCount(1);
  });

  test('메뉴 그룹 기획 · 설계 · 실행과 항목 이름 · 순서가 화면 구조 그대로다', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: '메뉴' });
    await expect(nav.getByRole('heading')).toHaveText(MENU_GROUPS.map((g) => g.label));
    for (const group of MENU_GROUPS) {
      const region = nav.getByTestId(`nav-group-${group.id}`);
      await expect(region.getByRole('button')).toHaveText([...group.items]);
      // 항목마다 표준 아이콘(SVG) 1개
      await expect(region.locator('button svg')).toHaveCount(group.items.length);
    }
  });

  test('글자 옆 아이콘은 글자보다 약간 작고 글자와 같은 색이다', async ({ page }) => {
    const item = page.getByRole('button', { name: '요구사항', exact: true });
    const measured = await item.evaluate((button) => {
      const icon = button.querySelector('svg');
      const label = button.querySelector('span');
      if (icon === null || label === null) throw new Error('아이콘 · 글자 없음');
      const iconStyle = getComputedStyle(icon);
      const labelStyle = getComputedStyle(label);
      return {
        iconSize: icon.getBoundingClientRect().height,
        fontSize: Number.parseFloat(labelStyle.fontSize),
        iconColor: iconStyle.color,
        stroke: icon.getAttribute('stroke'),
        labelColor: labelStyle.color,
      };
    });
    expect(measured.iconSize).toBeLessThan(measured.fontSize);
    expect(measured.iconSize).toBeGreaterThanOrEqual(measured.fontSize * 0.75);
    expect(measured.stroke).toBe('currentColor');
    expect(measured.iconColor).toBe(measured.labelColor);
  });

  test('메뉴를 누르면 선택 표시되고 중앙에 "<화면 이름> 준비 중" 빈 상태가 보인다', async ({
    page,
  }) => {
    const empty = page.getByTestId('main-area').getByTestId('empty-state');
    await expect(empty).toHaveText('선택 항목 없음');

    const rules = page.getByRole('button', { name: '규칙', exact: true });
    await rules.click();
    await expect(rules).toHaveAttribute('aria-current', 'page');
    await expect(empty).toHaveText('규칙 준비 중');
    await expect(page.getByTestId('main-area')).toHaveAttribute('data-route', 'rules');

    await page.getByRole('button', { name: '실행 추적', exact: true }).click();
    await expect(empty).toHaveText('실행 추적 준비 중');
    await expect(rules).not.toHaveAttribute('aria-current', 'page');

    await page.getByRole('button', { name: '할 일', exact: true }).click();
    await expect(empty).toHaveText('할 일 준비 중');
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await expect(empty).toHaveText('설정 준비 중');
  });
});

test.describe('연결 상태 (system.status)', () => {
  test('system.status 성공 → 연결됨', async ({ page }) => {
    const bive = await mockBive(page, { responses: { 'system.status': { result: STATUS } } });
    await page.goto('/');
    await expect(connection(page)).toHaveText(CONNECTION_TEXT.connected);
    await expect(connection(page)).toHaveAttribute('data-state', 'connected');
    expect(await bive.calls()).toContainEqual({ method: 'system.status', params: undefined });
    // 정상 상태: 아이콘(점)은 글자와 같은 흐린 색 (1.1 글자 옆 아이콘 · 예외만 강조)
    const colors = await connectionColors(page);
    expect(colors.icon).toBe(colors.label);
    expect(colors.label).toBe(colors.muted);
  });

  test('연결 끊김은 아이콘 · 글자가 같은 강조 색이다', async ({ page }) => {
    await mockBive(page, { responses: { 'system.status': { error: FAILED } } });
    await page.goto('/');
    await expect(connection(page)).toHaveAttribute('data-state', 'disconnected');
    const colors = await connectionColors(page);
    expect(colors.icon).toBe(colors.label);
    expect(colors.label).not.toBe(colors.muted);
  });

  test('system.status 실패 → 연결 끊김 (에러 상태 체크리스트)', async ({ page }) => {
    await mockBive(page, { responses: { 'system.status': { error: FAILED } } });
    await page.goto('/');
    await expectScreen(page, 'SCR-00', '에러');
  });

  test('응답 전에는 연결 확인 중 (로딩 상태 체크리스트)', async ({ page }) => {
    await mockBive(page, { responses: { 'system.status': { pending: true } } });
    await page.goto('/');
    await expectScreen(page, 'SCR-00', '로딩');
  });

  test('main의 system.connection 알림을 따라 끊김 · 재연결이 바뀐다', async ({ page }) => {
    const bive = await mockBive(page, { responses: { 'system.status': { result: STATUS } } });
    await page.goto('/');
    await expect(connection(page)).toHaveText(CONNECTION_TEXT.connected);

    await bive.emit('system.connection', { state: 'disconnected' });
    await expect(connection(page)).toHaveText(CONNECTION_TEXT.disconnected);
    await expect(connection(page)).toHaveAttribute('data-state', 'disconnected');

    await bive.emit('system.connection', { state: 'connected', status: STATUS });
    await expect(connection(page)).toHaveText(CONNECTION_TEXT.connected);

    // 형식이 틀린 알림은 무시한다
    await bive.emit('system.connection', { state: 'connected' });
    await bive.emit('system.connection', { state: 'unknown' });
    await expect(connection(page)).toHaveText(CONNECTION_TEXT.connected);
  });

  test('처음 조회가 실패해도 이후 연결됨 알림이 오면 연결됨', async ({ page }) => {
    const bive = await mockBive(page, { responses: { 'system.status': { error: FAILED } } });
    await page.goto('/');
    await expect(connection(page)).toHaveText(CONNECTION_TEXT.disconnected);
    await bive.emit('system.connection', { state: 'connected', status: STATUS });
    await expect(connection(page)).toHaveText(CONNECTION_TEXT.connected);
  });
});

test.describe('좁은 창 (1000px): 채팅 44px 띠', () => {
  test.use({ viewport: { width: 1000, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await mockBive(page, { responses: { 'system.status': { result: STATUS } } });
    await page.goto('/');
  });

  test('채팅이 44px 띠로 접히고, 누르면 본문 위에 360px로 겹쳐 열리며 Esc · 닫기로 닫힌다', async ({
    page,
  }) => {
    const panel = page.getByTestId('chat-panel');
    const strip = page.getByRole('button', { name: '에이전트 채팅 열기' });
    await expect(panel).toHaveAttribute('data-mode', 'strip');
    await expect(page.getByTestId('chat-body')).toHaveCount(0);

    const stripBox = await box(panel);
    expect(stripBox.w).toBe(44);
    expect(stripBox.x + stripBox.w).toBe(1000);
    const main = await box(page.getByTestId('main-area'));
    expect(main.x + main.w).toBe(stripBox.x);
    await expect(strip.locator('svg')).toHaveCount(1);

    // 상태 이름(ADR-043)이 아닌 보조 스크린샷은 artifacts/layout/에 둔다
    const dir = path.join(SCREENSHOT_DIR, '..', 'layout');
    await mkdir(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, 'chat-strip-1000.png') });

    await strip.click();
    await expect(panel).toHaveAttribute('data-mode', 'overlay');
    await expect(strip).toHaveAttribute('aria-expanded', 'true');
    const body = await box(page.getByTestId('chat-body'));
    expect(body.w).toBe(360);
    expect(body.x + body.w).toBe(1000);
    // 겹쳐 열기: 중앙 영역 폭은 그대로다
    expect((await box(page.getByTestId('main-area'))).w).toBe(main.w);
    await expect(page.getByRole('heading', { name: '에이전트 채팅' })).toBeVisible();
    await page.screenshot({ path: path.join(dir, 'chat-overlay-1000.png') });

    await page.keyboard.press('Escape');
    await expect(panel).toHaveAttribute('data-mode', 'strip');

    await strip.click();
    await page.getByRole('button', { name: '에이전트 채팅 닫기' }).click();
    await expect(panel).toHaveAttribute('data-mode', 'strip');
  });

  test('창을 1100px 이상으로 넓히면 고정 360px로 돌아온다', async ({ page }) => {
    await page.getByRole('button', { name: '에이전트 채팅 열기' }).click();
    await page.setViewportSize({ width: 1100, height: 800 });
    const panel = page.getByTestId('chat-panel');
    await expect(panel).toHaveAttribute('data-mode', 'docked');
    expect((await box(panel)).w).toBe(360);
    await page.setViewportSize({ width: 1099, height: 800 });
    await expect(panel).toHaveAttribute('data-mode', 'strip');
  });
});
