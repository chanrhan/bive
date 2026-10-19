// Electron 스모크 (`xvfb-run -a pnpm smoke`, architecture.md 8장 · 10장).
// 빌드된 앱을 임시 BIVE_HOME으로 띄워 다음을 확인하고, 하나라도 어긋나면 종료 코드 1.
//   창 제목 "BIVE" · window.bive 키가 invoke · on 두 개뿐 · 렌더러에 require 없음 ·
//   레이아웃(사이드바 · 중앙 영역 · 채팅) · 사이드바 하단 "연결됨"(system.status, ADR-045) ·
//   기동 인자 `--open <dir>`로 연 프로젝트(.bive.json 두 키 · 사이드바 프로젝트명 · 요구사항 화면, M1-01) ·
//   Electron 사용자 데이터가 $BIVE_HOME/app-data에 생김(ADR-055) ·
//   app.pid 기록 · 앱 종료 코드 0 · 앱 종료 뒤 app.pid 삭제 ·
//   앱 종료 직후 오케스트레이터 생존(NFR-06) · 유휴 종료로 오케스트레이터 정리
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron, type ElectronApplication } from 'playwright-core';

import { electronArgs } from '../src/launch-flags.js';
import { isProcessAlive, readPidFile } from '../src/main/orchestrator-launch.js';
import { appRunPaths } from '../src/main/run-paths.js';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const electronPath = createRequire(import.meta.url)('electron') as string;
const IDLE_SHUTDOWN_MS = 1500;
/** 저장소 루트의 `artifacts/smoke` (CI가 artifacts/를 올린다). */
const SCREENSHOT_DIR = fileURLToPath(new URL('../../../artifacts/smoke/', import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`시간 초과: ${what}`);
    await sleep(50);
  }
};

const check = (ok: boolean, label: string, detail?: unknown): void => {
  if (!ok)
    throw new Error(`실패: ${label}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`);
  console.log(`확인: ${label}`);
};

const main = async (): Promise<void> => {
  // Unix 소켓 경로 제한(Linux 107바이트)을 넘지 않도록 짧은 경로에 만든다
  const base = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const biveHome = mkdtempSync(path.join(base, 'bive-smoke-'));
  const paths = appRunPaths(biveHome);
  // --open으로 열 비어 있지 않은 미연결 폴더 (BIVE_HOME 밖)
  const fixtureParent = mkdtempSync(path.join(base, 'bive-smoke-fx-'));
  const fixture = path.join(fixtureParent, 'smoke-app');
  mkdirSync(fixture);
  writeFileSync(path.join(fixture, 'package.json'), '{"name":"smoke-app"}\n');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.BIVE_HOME = biveHome;
  env.BIVE_IDLE_SHUTDOWN_MS = String(IDLE_SHUTDOWN_MS);

  let app: ElectronApplication | null = null;
  try {
    const args = electronArgs({
      appDir: APP_DIR,
      userArgs: ['--open', fixture],
      uid: process.getuid?.(),
      env,
    });
    console.log(`Electron 실행: ${electronPath} ${args.join(' ')}`);
    app = await _electron.launch({
      executablePath: electronPath,
      args,
      env,
      timeout: 30_000,
    });
    const child = app.process();
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
    });

    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    check((await page.title()) === 'BIVE', '창 제목 "BIVE"', await page.title());

    // 렌더러 문맥에서 식 그대로 평가한다 (이 파일은 Node 타입으로 검사하므로 문자열로 넘긴다)
    const keys = await page.evaluate<string[]>('Object.keys(window.bive)');
    check(
      JSON.stringify(keys) === JSON.stringify(['invoke', 'on']),
      'Object.keys(window.bive) = [invoke, on]',
      keys,
    );
    const invokeTypes = await page.evaluate<string[]>(
      '[typeof window.bive.invoke, typeof window.bive.on]',
    );
    check(
      JSON.stringify(invokeTypes) === JSON.stringify(['function', 'function']),
      'invoke · on은 함수',
      invokeTypes,
    );

    const requireType = await page.evaluate<string>('typeof window.require');
    check(requireType === 'undefined', "typeof window.require === 'undefined'", requireType);

    for (const testId of ['sidebar', 'main-area', 'chat-panel']) {
      await page.getByTestId(testId).waitFor({ timeout: 15_000 });
    }
    check(true, '레이아웃: 사이드바 · 중앙 영역 · 채팅 자리');

    const status = page.getByTestId('connection-status');
    await status.and(page.locator('[data-state="connected"]')).waitFor({ timeout: 15_000 });
    const statusText = (await status.textContent())?.trim();
    check(statusText === '연결됨', `사이드바 하단 연결 상태 "${statusText}"`, statusText);

    // 기동 인자 --open: 대화상자 없이 열고 요구사항 화면으로 들어간다 (M1-01)
    const project = page.getByTestId('sidebar-project');
    await project.and(page.locator('[data-state="open"]')).waitFor({ timeout: 15_000 });
    const projectName = (await project.textContent())?.trim();
    check(projectName === 'smoke-app', `사이드바 프로젝트명 "${projectName}"`, projectName);
    await page
      .getByTestId('main-area')
      .and(page.locator('[data-route="requirements"]'))
      .waitFor({ timeout: 15_000 });
    check(true, '--open 뒤 요구사항 화면');
    const projectFile = JSON.parse(
      readFileSync(path.join(fixture, '.bive.json'), 'utf8'),
    ) as Record<string, unknown>;
    const fileKeys = Object.keys(projectFile).sort();
    check(
      JSON.stringify(fileKeys) === JSON.stringify(['projectId', 'schemaVersion']),
      '.bive.json 키 = projectId · schemaVersion',
      fileKeys,
    );
    check(
      existsSync(path.join(biveHome, 'app-data')),
      'Electron 사용자 데이터 = $BIVE_HOME/app-data',
    );

    await mkdir(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'electron-layout.png') });

    const appPid = child.pid;
    check(
      readPidFile(paths.appPid) === appPid,
      `app.pid = 앱 main pid (${appPid})`,
      readPidFile(paths.appPid),
    );

    const orchestratorPid = readPidFile(paths.orchestratorPid);
    check(
      orchestratorPid !== null && orchestratorPid !== appPid && isProcessAlive(orchestratorPid),
      `오케스트레이터 별도 프로세스 기동 (pid ${orchestratorPid})`,
    );

    await app.close();
    app = null;
    const code = await exited;
    check(code === 0, '앱 종료 코드 0', code);
    check(readPidFile(paths.appPid) === null, '앱 종료 뒤 app.pid 삭제');
    check(
      orchestratorPid !== null && isProcessAlive(orchestratorPid),
      '앱 종료 직후 오케스트레이터 생존 (NFR-06)',
    );

    await waitFor(
      () => orchestratorPid === null || !isProcessAlive(orchestratorPid),
      IDLE_SHUTDOWN_MS + 10_000,
      '오케스트레이터 유휴 종료',
    );
    check(
      readPidFile(paths.orchestratorPid) === null,
      `오케스트레이터 유휴 종료 (${IDLE_SHUTDOWN_MS}ms)`,
    );
  } finally {
    // 확인이 중간에 실패해도 Electron을 남기지 않는다: 정상 종료를 시도하고, 안 되면 강제 종료
    if (app !== null) {
      const electronProcess = app.process();
      await Promise.race([app.close().catch(() => undefined), sleep(10_000)]);
      if (electronProcess.exitCode === null && electronProcess.signalCode === null) {
        electronProcess.kill('SIGKILL');
      }
    }
    // 남은 오케스트레이터가 있으면 정리한다
    const leftover = readPidFile(paths.orchestratorPid);
    if (leftover !== null && isProcessAlive(leftover)) {
      try {
        process.kill(leftover, 'SIGKILL');
      } catch {
        // 이미 끝남
      }
    }
    rmSync(biveHome, { recursive: true, force: true });
    rmSync(fixtureParent, { recursive: true, force: true });
  }
};

main().then(
  () => {
    console.log('스모크 통과');
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
