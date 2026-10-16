// Electron main 진입점: app.pid 기록 → 오케스트레이터 접속(없으면 분리 기동) → 창 · IPC 핸들러 · 연결 감시.
// 연결이 끊기면 다시 띄우지 않고 1초 간격으로 붙기만 한다 (ADR-045).
// 기동 인자 `--open <path>`가 있으면 대화상자 없이 그 폴더를 연다 (M1-01).
// Electron 사용자 데이터(캐시 · 로컬 저장소)는 `$BIVE_HOME/app-data`에 둔다 (ADR-055).
// 앱이 끝나면 연결만 닫고 app.pid를 지운다. 오케스트레이터는 유휴 종료에 맡긴다 (NFR-06).
import path from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';

import {
  type BridgeEvent,
  CONNECTION_EVENT,
  EVENT_CHANNEL,
  RPC_CHANNEL,
} from '../common/bridge.js';
import { ConnectionMonitor } from './connection-monitor.js';
import { orchestratorCommand, resolveOrchestratorMode } from './orchestrator-launch.js';
import { launchCwd } from './open-arg.js';
import { createProjectOpener } from './project-opener.js';
import { handleRendererRpc } from './rpc-bridge.js';
import { resolveBiveHome } from './run-paths.js';
import { startMainSession } from './session.js';
import { createMainWindow } from './window.js';

const baseDir = import.meta.dirname;
const biveHome = resolveBiveHome();
const packaged = app.isPackaged;

// 창을 만들기 전(ready 전)에 정해야 한다. 기본값(~/.config/<패키지 이름>)은 BIVE_HOME을 바꿔도 공유된다
app.setPath('userData', path.join(biveHome, 'app-data'));

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

const pickFolder = async (): Promise<string | null> => {
  const options: OpenDialogOptions = {
    title: '폴더 열기',
    properties: ['openDirectory', 'createDirectory'],
  };
  const owner = BrowserWindow.getFocusedWindow();
  const picked = await (owner === null
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(owner, options));
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
};

const projects = createProjectOpener({
  request: (method, params) => session.link.request(method, params),
  pickFolder,
  emit: broadcast,
});

ipcMain.handle(RPC_CHANNEL, (_event, payload: unknown) =>
  handleRendererRpc(session.link, payload, {
    appMethods: projects.appMethods,
    onResult: (method, result) => projects.onResult(method, result),
  }),
);

// 창을 띄우는 동안 미리 접속(필요하면 기동)하고, 이후 1초마다 상태를 확인해 렌더러에 알린다
const monitor = new ConnectionMonitor({
  target: session.link,
  emit: (params) => broadcast({ event: CONNECTION_EVENT, params }),
});
monitor.start();

// 창과 별개로 바로 연다. 창이 늦게 뜨면 렌더러가 `project.current`로 결과를 읽는다
void projects.openFromArgv(process.argv, launchCwd(process.env));

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
