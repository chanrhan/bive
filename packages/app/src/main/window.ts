// 메인 창 (architecture.md 10장 "렌더러 격리"): contextIsolation · sandbox 켬, nodeIntegration 끔, CSP는 index.html.
import path from 'node:path';

import { BrowserWindow } from 'electron';

export const WINDOW_TITLE = 'BIVE';

export const createMainWindow = (baseDir: string): BrowserWindow => {
  const window = new BrowserWindow({
    title: WINDOW_TITLE,
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(baseDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron 기본값도 켜짐이지만 기본값 변경에 기대지 않도록 명시한다
      sandbox: true,
    },
  });
  window.once('ready-to-show', () => window.show());
  // 새 창 · 다른 주소로의 이동 차단
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  void window.loadFile(path.join(baseDir, '../renderer/index.html'));
  return window;
};
