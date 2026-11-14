// 코드 열기 IDE URL (이슈 #45 수용 기준 2, MET-01 · ADR-018 · ADR-084 · ADR-087).
// - 선택(VS Code · Cursor · 사용자 지정 틀)별 URL 생성과 경로 인코딩(퍼센트 인코딩 · Windows · UNC 사례)
// - 여는 곳 바로 앞의 확인: 허용 스킴 · 고정 호스트만(호스트 · 사용자 정보 · 대문자 · 앞 공백 · 제어 문자 거부)
// - `BIVE_OPEN_URL_LOG=<파일>`이면 URL을 열지 않고 그 파일에 한 줄로 기록한다. 절대 경로가 아니거나 쓰기가 실패하면 열지 않는다
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertIdeUrl, buildIdeUrl, encodeIdePath } from '../src/main/ide-url.js';
import { createUrlOpener, OPEN_URL_LOG_ENV } from '../src/main/url-opener.js';

const VSCODE = { kind: 'vscode' } as const;
const CURSOR = { kind: 'cursor' } as const;
const custom = (template: string) => ({ kind: 'custom', template }) as const;

describe('선택별 URL 생성 (ADR-018)', () => {
  it('VS Code: vscode://file/{path}:{line}', () => {
    expect(buildIdeUrl(VSCODE, '/work/app/src/a.ts', 18)).toBe(
      'vscode://file/work/app/src/a.ts:18',
    );
  });

  it('Cursor: cursor://file/{path}:{line}', () => {
    expect(buildIdeUrl(CURSOR, '/work/app/src/a.ts', 18)).toBe(
      'cursor://file/work/app/src/a.ts:18',
    );
  });

  it('사용자 지정 틀: 자리 표시자 {path} · {line}을 채운다 (위치 · 순서 무관)', () => {
    expect(buildIdeUrl(custom('vscode-insiders://file/{path}:{line}'), '/w/a.ts', 3)).toBe(
      'vscode-insiders://file/w/a.ts:3',
    );
    expect(buildIdeUrl(custom('idea://open?line={line}&file=/{path}'), '/w/a b.ts', 7)).toBe(
      'idea://open?line=7&file=/w/a%20b.ts',
    );
    expect(buildIdeUrl(custom('subl://open?url=file:///{path}&line={line}'), '/w/a.ts', 2)).toBe(
      'subl://open?url=file:///w/a.ts&line=2',
    );
  });

  it('경로 인코딩: 조각마다 퍼센트 인코딩(공백 · 한글 · # · ? · & · % · 중괄호), 틀이 인코딩을 끌 수 없다', () => {
    expect(buildIdeUrl(VSCODE, '/work/app/화면 목록/a#b?.ts', 3)).toBe(
      'vscode://file/work/app/%ED%99%94%EB%A9%B4%20%EB%AA%A9%EB%A1%9D/a%23b%3F.ts:3',
    );
    // 쿼리에 넣는 틀에서도 경로의 & · = · % · {line}이 구조를 깨지 않는다
    expect(
      buildIdeUrl(custom('idea://open?file=/{path}&line={line}'), '/w/x&line=9%/{line}.ts', 4),
    ).toBe('idea://open?file=/w/x%26line%3D9%25/%7Bline%7D.ts&line=4');
  });

  it('Windows 경로는 C:/…, UNC 루트는 //srv/share/… (UNC를 VS Code가 받는지는 #158에서 확인)', () => {
    expect(buildIdeUrl(VSCODE, 'C:\\work\\app\\a.ts', 7)).toBe('vscode://file/C:/work/app/a.ts:7');
    expect(encodeIdePath('C:\\work\\app\\a.ts')).toBe('C:/work/app/a.ts');
    // 사례 기록 (#45 코멘트 6): UNC 루트 `\\srv\share`의 파일
    expect(buildIdeUrl(VSCODE, '\\\\srv\\share\\a.ts', 1)).toBe('vscode://file//srv/share/a.ts:1');
  });

  it('줄 번호가 1 이상 정수가 아니면 RangeError', () => {
    for (const line of [0, -1, 1.5, Number.NaN]) {
      expect(() => buildIdeUrl(VSCODE, '/w/a.ts', line), String(line)).toThrow(RangeError);
    }
  });

  it('저장된 선택이 허용 범위가 아니면(알 수 없는 종류 · 금지 틀 · 틀 없음) URL을 만들지 않는다', () => {
    for (const setting of [
      null,
      { kind: 'idea' },
      { kind: 'vscode', template: 'https://x/{path}{line}' },
      custom('https://evil.example/{path}?l={line}'),
      custom('vscode://evil.ext/{path}:{line}'),
      { kind: 'custom' },
    ]) {
      expect(() => buildIdeUrl(setting, '/w/a.ts', 1), JSON.stringify(setting)).toThrow();
    }
  });
});

describe('여는 곳 앞의 URL 확인 (#45 코멘트 1)', () => {
  it('허용 스킴과 그 고정 호스트의 URL만 통과', () => {
    for (const url of [
      'vscode://file/work/a.ts:1',
      'cursor://file/work/a.ts:1',
      'vscode://file//srv/share/a.ts:1',
      'idea://open?file=/w/a.ts&line=1',
    ]) {
      expect(() => assertIdeUrl(url), url).not.toThrow();
    }
  });

  it.each([
    ['다른 호스트(확장 URI 처리기)', 'vscode://evil.ext/x'],
    ['사용자 정보로 호스트 바꾸기', 'vscode://file@evil/x'],
    ['포트', 'vscode://file:80/x'],
    ['대문자 스킴', 'VSCODE://file/x:1'],
    ['앞 공백', ' vscode://file/x:1'],
    ['뒤 줄바꿈', 'vscode://file/x:1\n'],
    ['중간 공백', 'vscode://file/a b:1'],
    ['탭', 'vscode://file/a\tb:1'],
    ['비ASCII(양방향 제어 문자)', 'vscode://file/a\u202eb:1'],
    ['권한 없음', 'vscode:/file/x:1'],
    ['웹', 'https://example.com/x'],
    ['파일', 'file:///etc/passwd'],
    ['스크립트', 'javascript:alert(1)'],
    ['데이터', 'data:text/html,x'],
    ['OS 처리기', 'ms-msdt://file/x'],
    ['빈 값', ''],
    ['형식 아님', 'not a url'],
    ['너무 김', `vscode://file/${'a'.repeat(9000)}:1`],
  ])('거부: %s', (_label, url) => {
    expect(() => assertIdeUrl(url)).toThrow();
  });
});

describe(`${OPEN_URL_LOG_ENV}: 열지 않고 파일에 한 줄로 기록`, () => {
  const tempDir = (): string => mkdtempSync(path.join(tmpdir(), 'bive-open-url-'));

  const opener = (env: Record<string, string | undefined>) => {
    const opened: string[] = [];
    const open = createUrlOpener({
      env,
      openExternal: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
    });
    return { opened, open };
  };

  it('설정되면 URL을 열지 않고 그 파일 끝에 URL + 줄바꿈을 덧붙인다', async () => {
    const file = path.join(tempDir(), 'open-url.log');
    const { opened, open } = opener({ [OPEN_URL_LOG_ENV]: file });
    await open('vscode://file/w/a.ts:3');
    await open('cursor://file/w/a.ts:4');
    expect(opened).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('vscode://file/w/a.ts:3\ncursor://file/w/a.ts:4\n');
  });

  it('이미 있는 파일은 지우지 않고 덧붙인다', async () => {
    const file = path.join(tempDir(), 'open-url.log');
    writeFileSync(file, 'earlier\n');
    const { open } = opener({ [OPEN_URL_LOG_ENV]: file });
    await open('vscode://file/w/a.ts:3');
    expect(readFileSync(file, 'utf8')).toBe('earlier\nvscode://file/w/a.ts:3\n');
  });

  it('설정되지 않으면 연다(파일 없음)', async () => {
    const { opened, open } = opener({});
    await open('vscode://file/w/a.ts:3');
    expect(opened).toEqual(['vscode://file/w/a.ts:3']);
  });

  it('절대 경로가 아니면(빈 값 포함) 열지도 적지도 않고 예외', async () => {
    for (const value of ['open-url.log', '', './x.log']) {
      const { opened, open } = opener({ [OPEN_URL_LOG_ENV]: value });
      await expect(open('vscode://file/w/a.ts:3'), value).rejects.toThrow(/절대 경로/);
      expect(opened).toEqual([]);
    }
  });

  it('쓰기가 실패하면(폴더 없음) 예외이고 열지 않는다', async () => {
    const file = path.join(tempDir(), 'missing-dir', 'open-url.log');
    const { opened, open } = opener({ [OPEN_URL_LOG_ENV]: file });
    await expect(open('vscode://file/w/a.ts:3')).rejects.toThrow();
    expect(opened).toEqual([]);
  });

  it('허용 범위가 아닌 URL은 열지도 적지도 않는다', async () => {
    const file = path.join(tempDir(), 'open-url.log');
    const logged = opener({ [OPEN_URL_LOG_ENV]: file });
    await expect(logged.open('https://example.com/x')).rejects.toThrow();
    expect(() => readFileSync(file, 'utf8')).toThrow();
    const direct = opener({});
    await expect(direct.open('vscode://evil.ext/x')).rejects.toThrow();
    expect(direct.opened).toEqual([]);
  });
});
