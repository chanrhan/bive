// Electron 실행 인자 (ADR-028, 이슈 #9 수용 기준 4).
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { electronArgs, needsNoSandbox, NO_SANDBOX_FLAG } from '../src/launch-flags.js';

const APP = '/repo/packages/app';
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

describe('launch-flags', () => {
  it('root(uid 0)이면 --no-sandbox를 붙인다', () => {
    expect(needsNoSandbox({ uid: 0, env: {} })).toBe(true);
    expect(electronArgs({ appDir: APP, userArgs: [], uid: 0, env: {} })).toEqual([
      NO_SANDBOX_FLAG,
      APP,
    ]);
  });

  it('BIVE_NO_SANDBOX=1이면 일반 사용자도 --no-sandbox를 붙인다', () => {
    expect(needsNoSandbox({ uid: 1000, env: { BIVE_NO_SANDBOX: '1' } })).toBe(true);
    expect(
      electronArgs({ appDir: APP, userArgs: [], uid: 1000, env: { BIVE_NO_SANDBOX: '1' } }),
    ).toEqual([NO_SANDBOX_FLAG, APP]);
  });

  it('일반 사용자 · Windows(uid 없음)는 붙이지 않는다. BIVE_NO_SANDBOX의 다른 값도 꺼짐', () => {
    expect(electronArgs({ appDir: APP, userArgs: [], uid: 1000, env: {} })).toEqual([APP]);
    expect(electronArgs({ appDir: APP, userArgs: [], uid: undefined, env: {} })).toEqual([APP]);
    expect(needsNoSandbox({ uid: 1000, env: { BIVE_NO_SANDBOX: '0' } })).toBe(false);
    expect(needsNoSandbox({ uid: 1000, env: { BIVE_NO_SANDBOX: 'true' } })).toBe(false);
  });

  it('사용자 인자를 순서 그대로 넘긴다 (--remote-debugging-port 포함)', () => {
    const userArgs = ['--remote-debugging-port=9222', '--lang=ko', 'extra'];
    expect(electronArgs({ appDir: APP, userArgs, uid: 1000, env: {} })).toEqual([APP, ...userArgs]);
    expect(electronArgs({ appDir: APP, userArgs, uid: 0, env: {} })).toEqual([
      NO_SANDBOX_FLAG,
      APP,
      ...userArgs,
    ]);
  });

  it('맨 앞 -- 구분자는 떼고, 이미 넘긴 --no-sandbox는 중복으로 붙이지 않는다', () => {
    expect(
      electronArgs({
        appDir: APP,
        userArgs: ['--', '--remote-debugging-port=0'],
        uid: 1000,
        env: {},
      }),
    ).toEqual([APP, '--remote-debugging-port=0']);
    expect(electronArgs({ appDir: APP, userArgs: [NO_SANDBOX_FLAG], uid: 0, env: {} })).toEqual([
      APP,
      NO_SANDBOX_FLAG,
    ]);
  });

  // start 스크립트의 마지막 명령(`tsx src/start.ts`)을 가짜 Electron 실행 파일로 돌려 실제 argv를 본다.
  // pnpm은 `start -- <인자>`의 `--`를 떼고 인자를 스크립트 끝에 덧붙인다(pnpm 10.28 확인).
  it.skipIf(process.platform === 'win32')(
    'start 진입점이 인자를 Electron에 그대로 넘기고 Electron 종료 코드를 돌려준다',
    () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-fake-electron-'));
      try {
        const out = path.join(dir, 'argv.txt');
        const fake = path.join(dir, 'electron');
        writeFileSync(
          fake,
          '#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "$FAKE_ELECTRON_OUT"\nexit 7\n',
        );
        chmodSync(fake, 0o755);
        const result = spawnSync(
          'pnpm',
          ['--silent', 'exec', 'tsx', 'src/start.ts', '--remote-debugging-port=9333', '--foo'],
          {
            cwd: APP_DIR,
            encoding: 'utf8',
            // electron 패키지는 이 변수가 있으면 그 폴더의 실행 파일 경로를 내보낸다
            env: { ...process.env, ELECTRON_OVERRIDE_DIST_PATH: dir, FAKE_ELECTRON_OUT: out },
          },
        );
        expect(result.status, result.stderr).toBe(7);
        const received = readFileSync(out, 'utf8').trim().split('\n');
        expect(received).toEqual(
          electronArgs({
            appDir: APP_DIR,
            userArgs: ['--remote-debugging-port=9333', '--foo'],
            uid: process.getuid?.(),
            env: process.env,
          }),
        );
        expect(received.slice(-2)).toEqual(['--remote-debugging-port=9333', '--foo']);
        if (process.getuid?.() === 0) expect(received[0]).toBe(NO_SANDBOX_FLAG);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
