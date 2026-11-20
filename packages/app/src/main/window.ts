// 메인 창 (architecture.md 10장 "렌더러 격리"): contextIsolation · sandbox 켬, nodeIntegration 끔, CSP는 index.html.
// 크기: 기본 1280 × 800(바깥 크기), 최소는 안쪽 크기 820 × 600 (window-size.ts, ADR-093).
import path from 'node:path';

import { BrowserWindow } from 'electron';

import { DEFAULT_WINDOW_SIZE, MIN_CONTENT_SIZE } from './window-size.js';

export const WINDOW_TITLE = 'BIVE';

type SizedWindow = Pick<BrowserWindow, 'getSize' | 'getContentSize' | 'setMinimumSize'>;

/**
 * 최소 크기를 안쪽(웹 페이지) 크기 기준으로 건다. Electron의 최소 크기는 바깥 크기라 테두리 · 제목 줄만큼
 * (지금 바깥 크기 − 안쪽 크기)을 더한다. 기본 크기의 뜻(바깥 1280 × 800)은 바꾸지 않으려고
 * `useContentSize`를 쓰지 않는다.
 */
export const applyMinContentSize = (window: SizedWindow): void => {
  const [outerWidth = 0, outerHeight = 0] = window.getSize();
  const [innerWidth = 0, innerHeight = 0] = window.getContentSize();
  window.setMinimumSize(
    MIN_CONTENT_SIZE.width + Math.max(0, outerWidth - innerWidth),
    MIN_CONTENT_SIZE.height + Math.max(0, outerHeight - innerHeight),
  );
};

export const createMainWindow = (baseDir: string): BrowserWindow => {
  const window = new BrowserWindow({
    title: WINDOW_TITLE,
    width: DEFAULT_WINDOW_SIZE.width,
    height: DEFAULT_WINDOW_SIZE.height,
    // 테두리 크기를 알기 전의 하한(바깥 크기). 보일 때 안쪽 크기 기준으로 다시 건다
    minWidth: MIN_CONTENT_SIZE.width,
    minHeight: MIN_CONTENT_SIZE.height,
    show: false,
    webPreferences: {
      preload: path.join(baseDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron 기본값도 켜짐이지만 기본값 변경에 기대지 않도록 명시한다
      sandbox: true,
    },
  });
  window.once('ready-to-show', () => {
    applyMinContentSize(window);
    window.show();
  });
  // 새 창 · 다른 주소로의 이동 차단
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  void window.loadFile(path.join(baseDir, '../renderer/index.html'));
  return window;
};
