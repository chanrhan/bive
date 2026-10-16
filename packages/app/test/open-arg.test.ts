// 기동 인자 `--open <path>` (이슈 #14 수용 기준 2): 폴더 선택 대화상자 없이 그 경로로 `project.open`을 부른다.
import type { ProjectOpenResult } from '@bive/shared';
import { describe, expect, it, vi } from 'vitest';

import { type BridgeEvent, PROJECT_OPENED_EVENT } from '../src/common/bridge.js';
import { launchCwd, parseOpenArg } from '../src/main/open-arg.js';
import { createProjectOpener } from '../src/main/project-opener.js';
import { handleRendererRpc } from '../src/main/rpc-bridge.js';

const ELECTRON = ['/usr/lib/electron/electron', '--no-sandbox', '/repo/packages/app'];

const result = (rootPath: string): ProjectOpenResult => ({
  project: {
    id: '01JB2C3D4E5F6G7H8J9KAMBNCP',
    name: rootPath.split('/').at(-1) ?? 'x',
    rootPath,
    baseBranch: 'main',
    createdAt: '2026-10-16T09:00:00.000Z',
  },
  created: true,
  empty: false,
});

describe('parseOpenArg', () => {
  it('`--open <path>`와 `--open=<path>`를 읽고 다른 인자와 섞여도 찾는다', () => {
    expect(parseOpenArg([...ELECTRON, '--open', '/tmp/fx'], '/cwd')).toEqual({
      kind: 'path',
      path: '/tmp/fx',
    });
    expect(
      parseOpenArg([...ELECTRON, '--open', '/tmp/fx', '--remote-debugging-port=9222'], '/cwd'),
    ).toEqual({ kind: 'path', path: '/tmp/fx' });
    expect(
      parseOpenArg([...ELECTRON, '--remote-debugging-port=9222', '--open=/tmp/fx'], '/cwd'),
    ).toEqual({ kind: 'path', path: '/tmp/fx' });
  });

  it('상대 경로는 기준 폴더로 절대 경로로 바꾼다', () => {
    expect(parseOpenArg([...ELECTRON, '--open', 'fx'], '/home/me')).toEqual({
      kind: 'path',
      path: '/home/me/fx',
    });
    expect(parseOpenArg([...ELECTRON, '--open=../fx'], '/home/me/work')).toEqual({
      kind: 'path',
      path: '/home/me/fx',
    });
  });

  it('인자가 없으면 none, 값이 없거나 다음이 스위치면 missing, 여러 번이면 처음 것', () => {
    expect(parseOpenArg(ELECTRON, '/cwd')).toEqual({ kind: 'none' });
    expect(parseOpenArg([...ELECTRON, '--opener', '/x'], '/cwd')).toEqual({ kind: 'none' });
    expect(parseOpenArg([...ELECTRON, '--open'], '/cwd')).toEqual({ kind: 'missing' });
    expect(parseOpenArg([...ELECTRON, '--open='], '/cwd')).toEqual({ kind: 'missing' });
    expect(parseOpenArg([...ELECTRON, '--open', '--remote-debugging-port=9222'], '/cwd')).toEqual({
      kind: 'missing',
    });
    expect(parseOpenArg([...ELECTRON, '--open', '/a', '--open', '/b'], '/cwd')).toEqual({
      kind: 'path',
      path: '/a',
    });
  });

  it('기준 폴더는 INIT_CWD(pnpm이 남긴 원래 위치), 없거나 비면 현재 폴더', () => {
    expect(launchCwd({ INIT_CWD: '/home/me' }, () => '/repo/packages/app')).toBe('/home/me');
    expect(launchCwd({ INIT_CWD: ' ' }, () => '/repo/packages/app')).toBe('/repo/packages/app');
    expect(launchCwd({}, () => '/repo/packages/app')).toBe('/repo/packages/app');
  });
});

const opener = (request: (method: string, params?: unknown) => Promise<unknown>) => {
  const pickFolder = vi.fn(() => Promise.resolve<string | null>('/picked'));
  const emitted: BridgeEvent[] = [];
  const logs: string[] = [];
  const requests = vi.fn(request);
  const instance = createProjectOpener({
    request: requests,
    pickFolder,
    emit: (event) => emitted.push(event),
    log: (message) => logs.push(message),
  });
  return { instance, pickFolder, requests, emitted, logs };
};

describe('기동 인자로 열기 (openFromArgv)', () => {
  it('`--open <path>`면 대화상자 없이 그 경로로 project.open을 1회 부르고 project.opened를 보낸다', async () => {
    const opened = result('/tmp/fx');
    const o = opener(() => Promise.resolve(opened));

    await expect(o.instance.openFromArgv([...ELECTRON, '--open', '/tmp/fx'], '/cwd')).resolves.toBe(
      opened,
    );

    expect(o.pickFolder).not.toHaveBeenCalled();
    expect(o.requests.mock.calls).toEqual([['project.open', { path: '/tmp/fx' }]]);
    expect(o.emitted).toEqual([{ event: PROJECT_OPENED_EVENT, params: opened }]);
  });

  it('인자가 없으면 아무것도 부르지 않는다 (대화상자도 열지 않음)', async () => {
    const o = opener(() => Promise.reject(new Error('부르면 안 됨')));
    await expect(o.instance.openFromArgv(ELECTRON, '/cwd')).resolves.toBeNull();
    expect(o.requests).not.toHaveBeenCalled();
    expect(o.pickFolder).not.toHaveBeenCalled();
    expect(o.emitted).toEqual([]);
  });

  it('값이 없거나 열기에 실패하면 main 로그만 남기고 null, 알림 없음', async () => {
    const o = opener(() => Promise.reject({ code: -32004, message: '폴더를 찾을 수 없습니다' }));
    await expect(o.instance.openFromArgv([...ELECTRON, '--open'], '/cwd')).resolves.toBeNull();
    await expect(
      o.instance.openFromArgv([...ELECTRON, '--open', '/no/such'], '/cwd'),
    ).resolves.toBeNull();
    expect(o.requests.mock.calls).toEqual([['project.open', { path: '/no/such' }]]);
    expect(o.pickFolder).not.toHaveBeenCalled();
    expect(o.emitted).toEqual([]);
    expect(o.logs).toEqual([
      '--open 뒤에 폴더 경로가 없음',
      '프로젝트 열기 실패 (/no/such): 폴더를 찾을 수 없습니다',
    ]);
  });
});

describe('렌더러 경로: app.pickFolder · project.open', () => {
  it('app.pickFolder는 대화상자 결과 경로만 돌려주고 파이프로 보내지 않는다', async () => {
    const o = opener(() => Promise.reject(new Error('파이프로 가면 안 됨')));
    const target = { request: vi.fn(() => Promise.resolve(null)) };

    await expect(
      handleRendererRpc(
        target,
        { method: 'app.pickFolder' },
        { appMethods: o.instance.appMethods },
      ),
    ).resolves.toEqual({ ok: true, result: { path: '/picked' } });
    o.pickFolder.mockResolvedValueOnce(null);
    await expect(
      handleRendererRpc(
        target,
        { method: 'app.pickFolder' },
        { appMethods: o.instance.appMethods },
      ),
    ).resolves.toEqual({ ok: true, result: { path: null } });

    expect(target.request).not.toHaveBeenCalled();
    expect(o.emitted).toEqual([]);
  });

  it('렌더러의 project.open이 성공하면 project.opened를 보내고, 다른 메서드 · 실패는 보내지 않는다', async () => {
    const opened = result('/work/app');
    const o = opener(() => Promise.reject(new Error('쓰지 않음')));
    const target = {
      request: vi.fn((method: string) =>
        method === 'project.open' ? Promise.resolve(opened) : Promise.resolve({ project: null }),
      ),
    };
    const options = { onResult: (m: string, r: unknown) => o.instance.onResult(m, r) };

    await expect(
      handleRendererRpc(target, { method: 'project.open', params: { path: '/work/app' } }, options),
    ).resolves.toEqual({ ok: true, result: opened });
    await handleRendererRpc(target, { method: 'project.current' }, options);
    // 상대 경로는 main이 접속 전에 -32602로 거부한다
    await expect(
      handleRendererRpc(target, { method: 'project.open', params: { path: 'work/app' } }, options),
    ).resolves.toMatchObject({ ok: false, error: { code: -32602 } });

    expect(o.emitted).toEqual([{ event: PROJECT_OPENED_EVENT, params: opened }]);
    expect(target.request.mock.calls).toEqual([
      ['project.open', { path: '/work/app' }],
      ['project.current', undefined],
    ]);
  });
});
