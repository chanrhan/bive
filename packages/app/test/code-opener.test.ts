// main의 코드 열기 `app.openInIde` (이슈 #43, MET-01 · ADR-018 · ADR-084).
// - 순서: 프로젝트 루트 안의 경로로 URL을 만든 뒤 `codeOpen.record`로 기록하고, 기록이 성공해야 연다
// - 기록이 실패하면 열지 않는다. 루트 밖 경로 · 등록되지 않은 프로젝트는 기록도 열기도 없다
// - URL은 고정 틀(`vscode://file/{절대 경로}:{줄}`)에서만 만들고, 여는 곳은 고정 스킴만 받는다
// - 렌더러 요청(`bive:rpc`)의 파라미터 검증: 대상 스키마가 틀리면 -32602로 처리기를 부르지 않는다
import path from 'node:path';

import { type CodeOpenTarget, ErrorCode, isProjectRelativePath, rpcError } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { OPEN_IN_IDE_METHOD } from '../src/common/bridge.js';
import { createCodeOpener } from '../src/main/code-opener.js';
import {
  assertIdeUrl,
  IDE_URL_SCHEMES,
  resolveProjectFile,
  vscodeFileUrl,
} from '../src/main/ide-url.js';
import { PipeRpcError } from '../src/main/pipe-client.js';
import { handleRendererRpc } from '../src/main/rpc-bridge.js';

const PROJECT_ID = '01JA0000000000000000000000';
const RULE_ID = '01JA0000000000000000000002';
const ROOT = '/work/sample-next-app';

const target = (patch: Partial<CodeOpenTarget> = {}): CodeOpenTarget => ({
  projectId: PROJECT_ID,
  reason: 'debugging',
  sourceScreen: 'SCR-03',
  itemRef: { entity: 'Rule', id: RULE_ID },
  file: 'bive-acceptance/RULE-001/health.acc.ts',
  line: 18,
  ...patch,
});

const RECORD = {
  id: '01JA0000000000000000000009',
  at: '2026-11-14T09:00:00.000Z',
  reason: 'debugging',
  sourceScreen: 'SCR-03',
  itemRef: { entity: 'Rule', id: RULE_ID },
  file: 'bive-acceptance/RULE-001/health.acc.ts',
  line: 18,
} as const;

interface Harness {
  /** 오케스트레이터 요청 · 연 URL을 순서대로 */
  log: string[];
  open: (input: unknown) => Promise<unknown>;
}

const harness = (
  options: { recordFails?: boolean; openFails?: boolean; rootPath?: string } = {},
): Harness => {
  const log: string[] = [];
  const opener = createCodeOpener({
    request: (method, params) => {
      log.push(`request ${method}`);
      if (method === 'project.list') {
        return Promise.resolve({
          projects: [
            {
              id: PROJECT_ID,
              name: '샘플 앱',
              rootPath: options.rootPath ?? ROOT,
              baseBranch: 'main',
              createdAt: '2026-10-16T00:00:00.000Z',
            },
          ],
        });
      }
      if (method === 'codeOpen.record') {
        expect(params).toMatchObject({ author: { kind: 'human' } });
        if (options.recordFails === true) {
          return Promise.reject(new PipeRpcError(rpcError(ErrorCode.InternalError, '저장 실패')));
        }
        return Promise.resolve({ record: RECORD });
      }
      return Promise.reject(new Error(`예상하지 않은 요청 ${method}`));
    },
    openUrl: (url) => {
      log.push(`open ${url}`);
      return options.openFails === true
        ? Promise.reject(new Error('xdg-open 없음'))
        : Promise.resolve();
    },
  });
  const handler = opener.appMethods[OPEN_IN_IDE_METHOD];
  if (handler === undefined) throw new Error('app.openInIde 처리기 없음');
  return { log, open: (input) => handler(input as CodeOpenTarget) };
};

describe('app.openInIde: 기록 뒤 열기 (MET-01)', () => {
  it('기록(codeOpen.record, 사람 주체)이 먼저이고 그 뒤에 고정 틀의 VS Code URL을 1번 연다', async () => {
    const h = harness();
    await expect(h.open(target())).resolves.toEqual({ record: RECORD });
    expect(h.log).toEqual([
      'request project.list',
      'request codeOpen.record',
      `open vscode://file${ROOT}/bive-acceptance/RULE-001/health.acc.ts:18`,
    ]);
  });

  it('기록이 실패하면 열지 않고 그 오류를 그대로 던진다', async () => {
    const h = harness({ recordFails: true });
    await expect(h.open(target())).rejects.toBeInstanceOf(PipeRpcError);
    expect(h.log.filter((line) => line.startsWith('open'))).toEqual([]);
  });

  it('열기가 실패하면 예외(기록은 이미 남음: 사유를 고른 시도 1회)', async () => {
    const h = harness({ openFails: true });
    await expect(h.open(target())).rejects.toThrow('xdg-open 없음');
    expect(h.log).toContain('request codeOpen.record');
  });

  it('등록되지 않은 프로젝트는 기록도 열기도 없다', async () => {
    const h = harness();
    await expect(h.open(target({ projectId: '01JA00000000000000000000ZZ' }))).rejects.toThrow(
      /등록되지 않은 프로젝트/,
    );
    expect(h.log).toEqual(['request project.list']);
  });

  it.each([
    ['절대 경로', { file: '/etc/passwd' }],
    ['상위 폴더', { file: '../outside.ts' }],
    ['중간 상위 폴더', { file: 'src/../../outside.ts' }],
    ['제어 문자', { file: 'src/a\u0000.ts' }],
    ['줄 0', { line: 0 }],
  ])('대상 형식 위반(%s)은 요청 · 기록 · 열기 없이 거부', async (_label, patch) => {
    const h = harness();
    await expect(h.open({ ...target(), ...patch })).rejects.toThrow();
    expect(h.log).toEqual([]);
  });

  it('프로젝트 루트가 절대 경로가 아니면 기록 · 열기 없이 거부', async () => {
    const h = harness({ rootPath: 'relative/root' });
    await expect(h.open(target())).rejects.toThrow(/루트 밖/);
    expect(h.log).toEqual(['request project.list']);
  });
});

describe('IDE URL 고정 틀 · 경로 범위 (ADR-018 · ADR-084)', () => {
  it('vscodeFileUrl: vscode://file/{절대 경로}:{줄}, 조각마다 퍼센트 인코딩, Windows 경로는 /C:/…', () => {
    expect(vscodeFileUrl('/work/app/src/a.ts', 18)).toBe('vscode://file/work/app/src/a.ts:18');
    expect(vscodeFileUrl('/work/app/화면 목록/a#b?.ts', 3)).toBe(
      'vscode://file/work/app/%ED%99%94%EB%A9%B4%20%EB%AA%A9%EB%A1%9D/a%23b%3F.ts:3',
    );
    expect(vscodeFileUrl('C:\\work\\app\\a.ts', 7)).toBe('vscode://file/C:/work/app/a.ts:7');
    for (const line of [0, -1, 1.5]) {
      expect(() => vscodeFileUrl('/work/a.ts', line), String(line)).toThrow(RangeError);
    }
  });

  it('resolveProjectFile: 루트 안의 상대 경로만 절대 경로로 푼다 (POSIX · Windows)', () => {
    expect(resolveProjectFile(ROOT, 'src/a.ts', path.posix)).toBe(`${ROOT}/src/a.ts`);
    expect(resolveProjectFile('C:\\work\\app', 'src/a.ts', path.win32)).toBe(
      'C:\\work\\app\\src\\a.ts',
    );
    for (const file of [
      '/etc/passwd',
      '../x.ts',
      'a/../../x.ts',
      'a\\..\\..\\x.ts',
      'C:x.ts',
      '',
    ]) {
      expect(resolveProjectFile(ROOT, file, path.posix), file).toBeNull();
      expect(resolveProjectFile('C:\\work\\app', file, path.win32), file).toBeNull();
    }
    expect(resolveProjectFile('relative', 'src/a.ts', path.posix)).toBeNull();
    // 경로 판단은 shared와 같은 기준이다
    expect(isProjectRelativePath('a/../../x.ts')).toBe(false);
  });

  it('assertIdeUrl: 고정 스킴(vscode)만 통과, 그 밖의 스킴 · 형식이 아닌 값은 예외', () => {
    expect(IDE_URL_SCHEMES).toEqual(['vscode:']);
    expect(() => assertIdeUrl('vscode://file/work/a.ts:1')).not.toThrow();
    for (const url of [
      'https://example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'cursor://file/a.ts:1',
      'not a url',
      '',
    ]) {
      expect(() => assertIdeUrl(url), url).toThrow();
    }
  });
});

describe('bive:rpc의 app.openInIde 파라미터 검증', () => {
  const pipe = {
    request: () => Promise.reject(new Error('파이프로 보내면 안 됨')),
  };

  it('대상 스키마가 틀리면(URL을 직접 넘김 · 루트 밖 경로 · 사유 없음) -32602이고 처리기를 부르지 않는다', async () => {
    const seen: unknown[] = [];
    const appMethods = {
      [OPEN_IN_IDE_METHOD]: (params: CodeOpenTarget) => {
        seen.push(params);
        return Promise.resolve({ record: RECORD });
      },
    };
    for (const params of [
      undefined,
      { ...target(), url: 'https://example.com' },
      { ...target(), file: '../outside.ts' },
      { ...target(), file: '/etc/passwd' },
      { ...target(), reason: undefined },
      { ...target(), line: 0 },
    ]) {
      await expect(
        handleRendererRpc(pipe, { method: OPEN_IN_IDE_METHOD, params }, { appMethods }),
      ).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.InvalidParams } });
    }
    expect(seen).toEqual([]);
    await expect(
      handleRendererRpc(pipe, { method: OPEN_IN_IDE_METHOD, params: target() }, { appMethods }),
    ).resolves.toEqual({ ok: true, result: { record: RECORD } });
    expect(seen).toEqual([target()]);
  });

  it('처리기가 던진 파이프 오류는 코드 그대로, 그 밖의 오류는 -32603(원본 메시지는 로그에만)', async () => {
    const logs: string[] = [];
    const log = (message: string): void => {
      logs.push(message);
    };
    const failing = (error: Error) => ({
      [OPEN_IN_IDE_METHOD]: () => Promise.reject(error),
    });
    await expect(
      handleRendererRpc(
        pipe,
        { method: OPEN_IN_IDE_METHOD, params: target() },
        {
          appMethods: failing(new PipeRpcError(rpcError(ErrorCode.Unauthorized, '권한 없음'))),
          log,
        },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: ErrorCode.Unauthorized, message: '권한 없음' },
    });
    await expect(
      handleRendererRpc(
        pipe,
        { method: OPEN_IN_IDE_METHOD, params: target() },
        { appMethods: failing(new Error('/secret/path 열기 실패')), log },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: ErrorCode.InternalError, message: '내부 오류' },
    });
    expect(logs).toEqual(['app.openInIde 실패: /secret/path 열기 실패']);
  });
});
