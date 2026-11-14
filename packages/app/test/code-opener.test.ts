// main의 코드 열기 `app.openInIde` (이슈 #43 · #45, MET-01 · ADR-018 · ADR-084 · ADR-087).
// - 순서: 프로젝트 루트 안의 경로(실제 경로로도 확인) → 설정의 IDE 선택으로 URL 생성 · 확인 → `codeOpen.record` → 열기
// - 확인(경로 · IDE 설정 · URL)이 실패하면 기록도 열기도 없다. 기록이 실패하면 열지 않는다
// - IDE 미설정이면 기록 · 열기 없이 거부(화면이 먼저 선택을 받는다, ADR-018)
// - 루트 안 심볼릭 링크가 루트 밖을 가리키거나 끊어진 링크면 거부 (#45 코멘트 3)
// - 렌더러 요청(`bive:rpc`)의 파라미터 검증: 대상 스키마가 틀리면 -32602로 처리기를 부르지 않는다.
//   `codeOpen.record`는 렌더러가 직접 부를 수 없다(-32020, #45 코멘트 4)
// URL 틀 · 인코딩 · 여는 곳의 확인은 test/ide-url.test.ts.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type CodeOpenTarget,
  ErrorCode,
  type IdeSetting,
  isProjectRelativePath,
  rpcError,
} from '@bive/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { MAIN_ONLY_METHODS, OPEN_IN_IDE_METHOD } from '../src/common/bridge.js';
import { createCodeOpener } from '../src/main/code-opener.js';
import { resolveProjectFile, resolveRealProjectFile } from '../src/main/ide-url.js';
import { PipeRpcError } from '../src/main/pipe-client.js';
import { handleRendererRpc } from '../src/main/rpc-bridge.js';

const PROJECT_ID = '01JA0000000000000000000000';
const RULE_ID = '01JA0000000000000000000002';
const FILE = 'bive-acceptance/RULE-001/health.acc.ts';

/** 실제 폴더(심볼릭 링크 시험용). `ROOT`는 프로젝트 루트, `OUTSIDE`는 루트 밖 폴더. */
let ROOT = '';
let OUTSIDE = '';

beforeAll(() => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'bive-code-opener-')));
  ROOT = path.join(base, 'root');
  OUTSIDE = path.join(base, 'outside');
  mkdirSync(path.join(ROOT, 'src'), { recursive: true });
  mkdirSync(OUTSIDE);
  writeFileSync(path.join(ROOT, 'src', 'a.ts'), 'export {};\n');
  writeFileSync(path.join(OUTSIDE, 'hostname'), 'secret\n');
  // 루트 안 → 루트 밖 폴더 링크 (#45 코멘트 3 재현: src/link → 밖, src/link/hostname)
  symlinkSync(OUTSIDE, path.join(ROOT, 'src', 'link'));
  // 루트 안 → 루트 밖 파일 링크
  symlinkSync(path.join(OUTSIDE, 'hostname'), path.join(ROOT, 'src', 'out.ts'));
  // 루트 안 → 루트 안 파일 링크 (허용)
  symlinkSync(path.join(ROOT, 'src', 'a.ts'), path.join(ROOT, 'src', 'alias.ts'));
  // 끊어진 링크 (대상 없음)
  symlinkSync(path.join(base, 'gone'), path.join(ROOT, 'src', 'dangling.ts'));
  symlinkSync(path.join(base, 'gone-dir'), path.join(ROOT, 'src', 'dangling-dir'));
});

const target = (patch: Partial<CodeOpenTarget> = {}): CodeOpenTarget => ({
  projectId: PROJECT_ID,
  reason: 'debugging',
  sourceScreen: 'SCR-03',
  itemRef: { entity: 'Rule', id: RULE_ID },
  file: FILE,
  line: 18,
  ...patch,
});

const RECORD = {
  id: '01JA0000000000000000000009',
  at: '2026-11-14T09:00:00.000Z',
  reason: 'debugging',
  sourceScreen: 'SCR-03',
  itemRef: { entity: 'Rule', id: RULE_ID },
  file: FILE,
  line: 18,
} as const;

interface Harness {
  /** 오케스트레이터 요청 · 연 URL을 순서대로 */
  log: string[];
  open: (input: unknown) => Promise<unknown>;
}

const harness = (
  options: {
    recordFails?: boolean;
    openFails?: boolean;
    rootPath?: string;
    /** `settings.get`이 돌려줄 IDE 선택 (기본 VS Code). 스키마를 거치지 않은 값도 넣어 main의 재검증을 본다 */
    ide?: IdeSetting | null | Record<string, unknown>;
  } = {},
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
      if (method === 'settings.get') {
        expect(params).toEqual({ projectId: PROJECT_ID });
        return Promise.resolve({
          settings: { ide: options.ide === undefined ? { kind: 'vscode' } : options.ide },
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

const CHECKED = ['request project.list', 'request settings.get'];

describe('app.openInIde: 확인 → 기록 → 열기 (MET-01)', () => {
  it('설정의 IDE로 URL을 만들고 확인한 뒤 기록(codeOpen.record, 사람 주체)하고 그 뒤에 1번 연다', async () => {
    const h = harness();
    await expect(h.open(target())).resolves.toEqual({ record: RECORD });
    expect(h.log).toEqual([
      ...CHECKED,
      'request codeOpen.record',
      `open vscode://file${ROOT}/${FILE}:18`,
    ]);
  });

  it.each([
    ['Cursor', { kind: 'cursor' }, () => `cursor://file${ROOT}/${FILE}:18`],
    [
      '사용자 지정',
      { kind: 'custom', template: 'idea://open?file=/{path}&line={line}' },
      () => `idea://open?file=${ROOT}/${FILE}&line=18`,
    ],
  ] as const)('선택이 %s이면 그 틀로 연다', async (_label, ide, url) => {
    const h = harness({ ide });
    await h.open(target());
    expect(h.log.at(-1)).toBe(`open ${url()}`);
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

  it('IDE 미설정이면 기록도 열기도 없다 (화면이 먼저 선택을 받는다, ADR-018)', async () => {
    const h = harness({ ide: null });
    await expect(h.open(target())).rejects.toThrow(/IDE 미설정/);
    expect(h.log).toEqual(CHECKED);
  });

  it.each([
    ['웹 스킴 틀', { kind: 'custom', template: 'https://evil.example/{path}?l={line}' }],
    ['다른 호스트 틀', { kind: 'custom', template: 'vscode://evil.ext/{path}:{line}' }],
    ['알 수 없는 종류', { kind: 'idea' }],
    ['틀 없는 사용자 지정', { kind: 'custom' }],
  ])(
    '저장된 IDE 설정이 허용 범위가 아니면(%s) 기록 전에 거부: 기록도 열기도 없다 (#45 코멘트 2)',
    async (_label, ide) => {
      const h = harness({ ide });
      await expect(h.open(target())).rejects.toThrow();
      expect(h.log).toEqual(CHECKED);
    },
  );

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
    ['양방향 제어 문자', { file: 'src/a\u202Est.ts' }],
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

  it.each([
    ['밖을 가리키는 폴더 링크 아래 파일', 'src/link/hostname'],
    ['밖을 가리키는 폴더 링크 아래 없는 파일', 'src/link/missing.ts'],
    ['밖을 가리키는 파일 링크', 'src/out.ts'],
    ['끊어진 파일 링크', 'src/dangling.ts'],
    ['끊어진 폴더 링크 아래 파일', 'src/dangling-dir/a.ts'],
  ])('루트 안 심볼릭 링크가 %s면 기록 · 열기 없이 거부 (#45 코멘트 3)', async (_label, file) => {
    const h = harness();
    await expect(h.open(target({ file }))).rejects.toThrow(/루트 밖/);
    expect(h.log).toEqual(['request project.list']);
  });
});

describe('경로 범위 (ADR-084 · ADR-087)', () => {
  it('resolveProjectFile: 루트 안의 상대 경로만 절대 경로로 푼다 (POSIX · Windows, 글자 비교)', () => {
    const root = '/work/sample-next-app';
    expect(resolveProjectFile(root, 'src/a.ts', path.posix)).toBe(`${root}/src/a.ts`);
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
      expect(resolveProjectFile(root, file, path.posix), file).toBeNull();
      expect(resolveProjectFile('C:\\work\\app', file, path.win32), file).toBeNull();
    }
    expect(resolveProjectFile('relative', 'src/a.ts', path.posix)).toBeNull();
    // 경로 판단은 shared와 같은 기준이다
    expect(isProjectRelativePath('a/../../x.ts')).toBe(false);
  });

  it('resolveRealProjectFile: 있는 파일 · 없는 파일 · 루트 안을 가리키는 링크는 루트 안 절대 경로(글자 그대로)', async () => {
    await expect(resolveRealProjectFile(ROOT, 'src/a.ts')).resolves.toBe(
      path.join(ROOT, 'src', 'a.ts'),
    );
    await expect(resolveRealProjectFile(ROOT, 'src/new/b.ts')).resolves.toBe(
      path.join(ROOT, 'src', 'new', 'b.ts'),
    );
    await expect(resolveRealProjectFile(ROOT, 'src/alias.ts')).resolves.toBe(
      path.join(ROOT, 'src', 'alias.ts'),
    );
    // 파일 아래를 가리키는 경로(ENOTDIR)도 없는 파일처럼 다룬다
    await expect(resolveRealProjectFile(ROOT, 'src/a.ts/x')).resolves.toBe(
      path.join(ROOT, 'src', 'a.ts', 'x'),
    );
  });

  it('resolveRealProjectFile: 실제 경로가 루트 밖이거나 끊어진 링크 · 없는 루트는 null', async () => {
    for (const file of [
      'src/link/hostname',
      'src/link',
      'src/out.ts',
      'src/dangling.ts',
      'src/dangling-dir/a.ts',
    ]) {
      await expect(resolveRealProjectFile(ROOT, file), file).resolves.toBeNull();
    }
    await expect(resolveRealProjectFile(path.join(ROOT, 'none'), 'a.ts')).resolves.toBeNull();
  });
});

describe('렌더러 중계의 기록 차단 (#45 코멘트 4)', () => {
  it('codeOpen.record는 main 전용: 렌더러가 부르면 -32020이고 파이프로 보내지 않는다', async () => {
    expect(MAIN_ONLY_METHODS).toContain('codeOpen.record');
    const sent: string[] = [];
    const pipe = {
      request: (method: string) => {
        sent.push(method);
        return Promise.resolve({ records: [], truncated: false });
      },
    };
    await expect(
      handleRendererRpc(pipe, {
        method: 'codeOpen.record',
        params: { ...target(), author: { kind: 'human' } },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.Unauthorized } });
    expect(sent).toEqual([]);
    // 조회는 그대로 렌더러가 부를 수 있다
    await expect(
      handleRendererRpc(pipe, { method: 'codeOpen.list', params: { projectId: PROJECT_ID } }),
    ).resolves.toMatchObject({ ok: true });
    expect(sent).toEqual(['codeOpen.list']);
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
