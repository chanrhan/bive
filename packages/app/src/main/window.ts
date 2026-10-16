// 메인 창 (architecture.md 10장 "렌더러 격리"): contextIsolation · nodeIntegration 끔 · sandbox는 Electron 기본(켜짐).
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
    },
  });
  window.once('ready-to-show', () => window.show());
  // 새 창 · 다른 주소로의 이동 차단
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  void window.loadFile(path.join(baseDir, '../renderer/index.html'));
  return window;
};
