// Electron main 진입점: app.pid 기록 → 오케스트레이터 접속(없으면 분리 기동) → 창 · IPC 핸들러 · 연결 감시.
// 연결이 끊기면 다시 띄우지 않고 1초 간격으로 붙기만 한다 (ADR-045).
// 앱이 끝나면 연결만 닫고 app.pid를 지운다. 오케스트레이터는 유휴 종료에 맡긴다 (NFR-06).
import path from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import {
  type BridgeEvent,
  CONNECTION_EVENT,
  EVENT_CHANNEL,
  RPC_CHANNEL,
} from '../common/bridge.js';
import { ConnectionMonitor } from './connection-monitor.js';
import { orchestratorCommand, resolveOrchestratorMode } from './orchestrator-launch.js';
import { handleRendererRpc } from './rpc-bridge.js';
import { resolveBiveHome } from './run-paths.js';
import { startMainSession } from './session.js';
import { createMainWindow } from './window.js';

const baseDir = import.meta.dirname;
const biveHome = resolveBiveHome();
const packaged = app.isPackaged;

// 개발: 저장소의 packages/orchestrator를 시스템 Node로. 패키징: 리소스 안 dist를 Electron 내장 Node로 (ADR-042)
const command = orchestratorCommand({
  mode: resolveOrchestratorMode(process.env, packaged),
  orchestratorDir: packaged
    ? path.join(process.resourcesPath, 'orchestrator')
    : path.resolve(app.getAppPath(), '../orchestrator'),
  nodePath: packaged ? process.execPath : (process.env.BIVE_NODE_PATH ?? 'node'),
  runAsNode: packaged,
  biveHome,
  env: process.env,
});

const session = startMainSession({ biveHome, command });

const broadcast = (message: BridgeEvent): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(EVENT_CHANNEL, message);
  }
};

session.link.onNotification((notification) => {
  broadcast({ event: notification.event, params: notification.params });
});

ipcMain.handle(RPC_CHANNEL, (_event, payload: unknown) => handleRendererRpc(session.link, payload));

// 창을 띄우는 동안 미리 접속(필요하면 기동)하고, 이후 1초마다 상태를 확인해 렌더러에 알린다
const monitor = new ConnectionMonitor({
  target: session.link,
  emit: (params) => broadcast({ event: CONNECTION_EVENT, params }),
});
monitor.start();

void app.whenReady().then(() => {
  createMainWindow(baseDir);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(baseDir);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  monitor.stop();
  session.dispose();
});
