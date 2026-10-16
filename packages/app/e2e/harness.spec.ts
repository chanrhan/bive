// 화면 e2e 하네스 자체 검사 (M0-07): 가짜 브리지 주입 · 체크리스트 통과 · 문구 위반 검출 · 스크린샷 저장.
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { MOCK_GLOBAL, mockBive } from './support/bive-mock.js';
import { SCREENSHOT_DIR, expectScreen } from './support/expectScreen.js';

const PONG = { pong: true, version: '0.0.0-e2e' } as const;

/** 화면에 문구를 덧붙인다 (위반 예제용). hidden이면 보이지 않게 넣는다. */
const inject = (page: Page, html: string): Promise<void> =>
  page.evaluate((markup) => {
    const holder = document.createElement('div');
    holder.dataset.testid = 'injected';
    holder.innerHTML = markup;
    document.body.append(holder);
  }, html);

test.describe('가짜 브리지', () => {
  test('렌더러가 뜨고 window.bive가 invoke · on 두 키의 가짜다', async ({ page }) => {
    const bive = await mockBive(page, { responses: { ping: { result: PONG } } });
    await page.goto('/');

    await expect(page.getByTestId('connection-status')).toHaveText('오케스트레이터 연결됨');
    expect(await page.evaluate(() => Object.keys(window.bive))).toEqual(['invoke', 'on']);
    expect(
      await page.evaluate(() => [
        typeof window.bive.invoke,
        typeof window.bive.on,
        Object.isFrozen(window.bive),
      ]),
    ).toEqual(['function', 'function', true]);
    // 가짜임: 조작 객체가 있고 렌더러의 ping 호출이 기록된다
    expect(await page.evaluate((name) => name in window, MOCK_GLOBAL)).toBe(true);
    expect(await bive.calls()).toContainEqual({ method: 'ping', params: undefined });
  });

  test('오류 응답은 { code, message, data? }로 거부되고 연결 끊김으로 보인다', async ({ page }) => {
    await mockBive(page, {
      responses: { ping: { error: { code: -32603, message: '오케스트레이터 연결 실패' } } },
    });
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toHaveAttribute(
      'data-state',
      'disconnected',
    );
    const rejected = await page.evaluate(() =>
      window.bive.invoke('ping').then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect(rejected).toEqual({ code: -32603, message: '오케스트레이터 연결 실패' });
  });

  test('표에 없는 메서드는 -32601, main 전용 메서드는 -32020', async ({ page }) => {
    await mockBive(page, { responses: { ping: { result: PONG } } });
    await page.goto('/');
    const codes = await page.evaluate(async () => {
      const codeOf = (p: Promise<unknown>): Promise<unknown> =>
        p.then(
          () => null,
          (error: { code: number }) => error.code,
        );
      const invoke = window.bive.invoke as (method: string, params?: unknown) => Promise<unknown>;
      return [await codeOf(invoke('project.list')), await codeOf(invoke('system.hello', {}))];
    });
    expect(codes).toEqual([-32601, -32020]);
  });

  test('대기 응답(로딩) · 지연 응답 · setResponse', async ({ page }) => {
    const bive = await mockBive(page, { responses: { ping: { pending: true } } });
    await page.goto('/');
    await expectScreen(page, 'SCR-00', '로딩');

    await bive.setResponse('ping', { result: PONG, delayMs: 200 });
    const started = Date.now();
    expect(await page.evaluate(() => window.bive.invoke('ping'))).toEqual(PONG);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  test('알림 발행 · 자동 발행 · 구독 해제', async ({ page }) => {
    const bive = await mockBive(page, {
      responses: { ping: { result: PONG } },
      events: [{ event: 'auto.event', params: { n: 1 }, delayMs: 10 }],
    });
    await page.goto('/');
    await page.evaluate(() => {
      const box = window as unknown as { received: unknown[]; off: () => void };
      box.received = [];
      box.off = window.bive.on('test.event', (params) => box.received.push(params));
      window.bive.on('auto.event', (params) => box.received.push(params));
    });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { received: unknown[] }).received))
      .toEqual([{ n: 1 }]);

    await bive.emit('test.event', { n: 2 });
    expect(await bive.listenerCounts()).toEqual({ 'test.event': 1, 'auto.event': 1 });
    await page.evaluate(() => (window as unknown as { off: () => void }).off());
    await bive.emit('test.event', { n: 3 });
    expect(
      await page.evaluate(() => (window as unknown as { received: unknown[] }).received),
    ).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await bive.listenerCounts()).toEqual({ 'test.event': 0, 'auto.event': 1 });
  });
});

test.describe('expectScreen', () => {
  test('정상 체크리스트를 통과하고 스크린샷을 저장한다', async ({ page }) => {
    const shot = path.join(SCREENSHOT_DIR, 'SCR-00', '기본.png');
    await rm(shot, { force: true });
    await mockBive(page, { responses: { ping: { result: PONG } } });
    await page.goto('/');
    await expectScreen(page, 'SCR-00', '기본');
    expect(existsSync(shot)).toBe(true);
  });

  test('에러 상태 체크리스트를 통과한다', async ({ page }) => {
    await mockBive(page, {
      responses: { ping: { error: { code: -32603, message: '내부 오류' } } },
    });
    await page.goto('/');
    await expectScreen(page, 'SCR-00', '에러');
  });

  test('필수 요소가 없으면 실패한다', async ({ page }) => {
    await mockBive(page, { responses: { ping: { pending: true } } });
    await page.goto('/');
    await expect(
      expectScreen(page, 'SCR-00', '기본', { screenshot: false, timeout: 500 }),
    ).rejects.toThrow(/연결 상태 문구/);
  });

  test('정의되지 않은 상태 · 등록되지 않은 화면은 실패한다', async ({ page }) => {
    await mockBive(page, { responses: { ping: { result: PONG } } });
    await page.goto('/');
    await expect(expectScreen(page, 'SCR-00', '빈', { screenshot: false })).rejects.toThrow(
      /상태 "빈" 없음/,
    );
    await expect(expectScreen(page, 'SCR-99', '기본', { screenshot: false })).rejects.toThrow(
      /체크리스트 없음/,
    );
  });

  test.describe('화면 문구 위반 예제', () => {
    test.beforeEach(async ({ page }) => {
      await mockBive(page, { responses: { ping: { result: PONG } } });
      await page.goto('/');
      await expect(page.getByTestId('connection-status')).toHaveText('오케스트레이터 연결됨');
    });

    const cases: { name: string; html: string; error: RegExp }[] = [
      { name: 'PRD ID', html: '<p>NRM-01 정규화 규칙</p>', error: /PRD ID "NRM-01"/ },
      { name: '화면 코드', html: '<p>SCR-02 요구사항</p>', error: /화면 코드 "SCR-02"/ },
      // 이모지는 소스에 직접 쓰지 않고 이스케이프로 넣는다
      { name: '이모지', html: '<p>완료 \u{1F680}</p>', error: /이모지 "\u{1F680}"/u },
      {
        name: '속성 문구 (title)',
        html: '<button title="COST-01 예산">예산</button>',
        error: /PRD ID "COST-01" \(button\[title\]\)/,
      },
      {
        name: '속성 문구 (aria-label)',
        html: '<button aria-label="상태 ✅">상태</button>',
        error: /이모지 "✅" \(button\[aria-label\]\)/u,
      },
    ];

    for (const { name, html, error } of cases) {
      test(`${name} 노출 시 실패`, async ({ page }) => {
        await inject(page, html);
        await expect(expectScreen(page, 'SCR-00', '기본', { screenshot: false })).rejects.toThrow(
          error,
        );
      });
    }

    test('보이지 않는 문구는 검사하지 않는다', async ({ page }) => {
      await inject(
        page,
        '<p hidden>NRM-01</p><p style="display:none">SCR-02</p><p style="visibility:hidden" title="RUN-08">\u{1F680}</p>',
      );
      await expectScreen(page, 'SCR-00', '기본', { screenshot: false });
    });

    test('코드와 비슷하지만 다른 문구는 통과한다', async ({ page }) => {
      // 두 자리가 아닌 번호 · 다른 접두 · 단어 안의 일치는 금지 패턴이 아니다
      await inject(page, '<p>NRM-1 · RUN-123 · ABC-01 · XSCR-02 · 화살표 ↑↓</p>');
      await expectScreen(page, 'SCR-00', '기본', { screenshot: false });
    });
  });
});
