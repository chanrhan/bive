// 인수 테스트 import 검사 보강 (#137, ADR-068): process 탈출 수단 · import.<이름> · 오탐 완화 · 파서 지연 로드.
// 허용 목록 · 기본 거부 사례는 test-writer.test.ts에 있다. 자식 node 프로세스를 띄우는 기동 검사만 30초(ADR-064).
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { lintAcceptanceSource } from '../src/judge/acceptance-lint.js';
import { ORCHESTRATOR_DIR } from './helpers/process.js';

const expectRejected = (source: string, message: string): void => {
  const problems = lintAcceptanceSource(source);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems[0]?.message).toContain(message);
  // 문제는 마지막 줄에 있다 (앞줄은 준비 코드)
  expect(problems[0]?.line).toBe(source.split('\n').length);
};

describe('process 전역의 탈출 수단 (#137)', () => {
  it.each([
    // 셸 실행: 현재 프로세스를 다른 프로그램으로 바꾼다
    ["process.execve('/bin/sh', ['sh', '-c', 'id']);", 'process.execve'],
    ["process['execve']('/bin/sh');", 'process.execve'],
    ['const { execve } = process;', 'process.execve'],
    // 파일 읽기: 파일 내용을 process.env로 읽어 들인다
    ["process.loadEnvFile('../../.env');", 'process.loadEnvFile'],
    ["globalThis.process.loadEnvFile('../../.env');", 'process.loadEnvFile'],
    ['const { loadEnvFile: load } = process;', 'process.loadEnvFile'],
    // 파일 쓰기: 진단 보고서를 원하는 경로에 쓴다
    ["process.report.writeReport('/tmp/r.json');", 'process.report'],
    ['const r = process.report;', 'process.report'],
    ["process['report'].directory = '/tmp';", 'process.report'],
    ['const { report } = process;', 'process.report'],
    ['const { report: r } = globalThis.process;', 'process.report'],
    ['const r = (process as NodeJS.Process).report;', 'process.report'],
    // process를 다른 이름에 담아도 보고서를 쓰는 함수 · 설정 이름으로 막는다
    ['const p = process;\np.report.writeReport();', 'process.report'],
    ['const p = process;\np.report.reportOnUncaughtException = true;', 'process.report'],
    ['const p = process;\np.report.reportOnFatalError = true;', 'process.report'],
    ['const p = process;\np.report.reportOnSignal = true;', 'process.report'],
  ])('%s → 거부', (source, message) => {
    expectRejected(source, message);
  });

  it('다른 객체의 report는 허용한다 (흔한 이름)', () => {
    const source = [
      "import { expect, it } from 'vitest';",
      "import { request } from '@bive/http';",
      "it('보고서', async () => {",
      "  const res = await request('/api/report');",
      '  const report = (await res.json()) as { report: { status: string } };',
      "  expect(report.report.status).toBe('ok');",
      "  expect(report['report']).toBeDefined();",
      '  const { report: inner } = report;',
      '  const statuses = [report].map(({ report: r }) => r.status);',
      '  expect(inner.status).toBe(statuses[0]);',
      '});',
    ].join('\n');
    expect(lintAcceptanceSource(source)).toEqual([]);
  });
});

describe('import.<이름>은 meta만 (#137)', () => {
  it.each([
    ["const m = await import.defer('../../src/lib/db');", 'import.defer'],
    ["const m = await import.source('../../src/lib/db');", 'import.source'],
    ["const m = await import.defer('node:url');", 'import.defer'],
  ])('%s → 거부', (source, message) => {
    expectRejected(source, message);
  });

  it('import.meta.url · import.meta.dirname은 허용한다', () => {
    expect(
      lintAcceptanceSource('const u = import.meta.url;\nconst d = import.meta.dirname;'),
    ).toEqual([]);
  });
});

describe('오탐 완화: 코드가 아닌 자리의 거부 이름 (#137)', () => {
  it('객체 리터럴 키 · 타입 자리 · 매처의 문자열 인자는 허용한다', () => {
    const source = [
      "import { expect, it } from 'vitest';",
      "import { request } from '@bive/http';",
      // 타입 자리: 타입 리터럴 · interface · 타입 별칭 · 타입 주석 · 문자열 리터럴 타입 · 타입 인자
      'type Body = { require: boolean; eval: string; binding: number; constructor: string; Function: 1 };',
      'interface Shape { Function: string; binding(): void; getBuiltinModule?: unknown }',
      "type Key = 'binding' | 'eval' | 'constructor' | 'require';",
      "type Ctor = Body['constructor'];",
      'const handler: Function | undefined = undefined;',
      'const handlers = new Map<string, Function>();',
      "it('오탐 없음', async () => {",
      "  const res = await request('/api/items', { method: 'POST', body: JSON.stringify({ require: true, eval: 'x' }) });",
      '  const body = (await res.json()) as Body & { kind: Key; message: string };',
      // 객체 리터럴 키 (식별자 · 문자열 · 계산된 문자열 · 메서드 · 접근자)
      "  const payload = { require: true, eval: 'x', binding: 1, 'Function': 2, ['constructor']: 3, dlopen() { return 1; }, get createRequire() { return 2; } };",
      // 매처의 문자열 인자 하나
      "  expect(body.message).toContain('Function');",
      "  expect(body).toHaveProperty('binding');",
      "  expect(body).not.toHaveProperty('require');",
      "  expect(body.kind).toBe('eval');",
      "  expect(body.kind).toEqual('constructor');",
      "  expect(body.kind).toStrictEqual('getBuiltinModule');",
      "  expect(body.message).toMatch('require');",
      "  expect(() => JSON.parse('x')).not.toThrow('Function');",
      "  expect(body.message).toEqual(expect.stringContaining('eval'));",
      "  expect(body.message).toEqual(expect.not.stringContaining('binding'));",
      "  expect.soft(body.kind).toBe('require');",
      "  await expect(Promise.resolve(body.kind)).resolves.toBe('Function');",
      '  expect(payload).toBeTruthy();',
      '  expect(handler ?? handlers).toBeTruthy();',
      '});',
    ].join('\n');
    expect(lintAcceptanceSource(source)).toEqual([]);
  });

  // 완화한 자리처럼 보여도 값을 읽거나 부르는 자리는 그대로 거부한다
  it.each([
    // 구조 분해 대입: 객체 리터럴 모양이지만 키가 속성 읽기다
    ['let b: unknown;\n({ binding: b } = process);', 'process.binding'],
    ["let b: unknown;\n({ 'binding': b } = process);", 'process.binding'],
    ['let F: unknown;\n[{ constructor: F }] = [async () => {}];', 'constructor로 생성자'],
    ['let F: unknown;\n({ constructor: F } = async () => {});', 'constructor로 생성자'],
    ['let constructor: unknown;\n({ constructor } = async () => {});', 'constructor로 생성자'],
    ['let report: unknown;\n({ report } = process);', 'process.report'],
    ['let r: unknown;\n({ report: r } = process);', 'process.report'],
    ['let b: unknown;\nfor ({ binding: b } of [process]) void b;', 'process.binding'],
    ['let b: unknown;\n({ x: { getBuiltinModule: b } } = { x: process });', 'getBuiltinModule'],
    // 객체 리터럴의 값 · 단축 속성 · 계산된 식별자 키는 값 참조다
    ["const o = { x: require('../src/x') };", 'require'],
    ['const o = { require };', 'require'],
    ['const o = { [eval]: 1 };', 'eval'],
    ['const o = { get x() { return process.binding; } };', 'process.binding'],
    // 클래스 extends는 값 참조다 (타입 자리 아님)
    ['class F extends Function {}', 'Function'],
    ['const f: Function = Function;', 'Function'],
    // 매처가 아닌 함수의 문자열 인자 (속성을 꺼내 돌려줄 수 있다)
    ["const b = Reflect.get(process, 'binding');", 'process.binding'],
    ["const d = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule');", 'getBuiltinModule'],
    ["vi.spyOn(process, 'binding');", 'process.binding'],
    [
      "const get = (o: Record<string, unknown>, k: string) => o[k];\nget(process, 'getBuiltinModule');",
      'getBuiltinModule',
    ],
    // 매처라도 인자가 둘 이상(값 비교는 사용자 asymmetricMatch에 속성 값을 넘긴다) · 배열 경로 · 목록 밖 매처
    [
      "expect(process).toHaveProperty('binding', { asymmetricMatch: (b: unknown) => Boolean(b) });",
      'process.binding',
    ],
    ["expect(process).toHaveProperty(['binding']);", 'process.binding'],
    ["expect(process).to.have.property('binding');", 'process.binding'],
    ["expect(process, 'binding').toBeTruthy();", 'process.binding'],
    ["notExpect(process).toHaveProperty('binding');", 'process.binding'],
    // 그 밖의 문자열 · 속성 읽기
    ["const k = 'constructor';", 'constructor로 생성자'],
    ["const v = Object.keys(process).includes('binding');", 'process.binding'],
    ["const e = globalThis['eval'];", 'eval'],
    // 실행기 내부 이름은 어느 자리든 거부
    ['const o = { __vite_ssr_import__: 1 };', '실행기 내부 이름'],
    ['type T = { __vitest_worker__: 1 };', '실행기 내부 이름'],
  ])('%s → 거부', (source, message) => {
    expectRejected(source, message);
  });

  // PR #136 리뷰에서 거부를 확인한 사례 (test-writer.test.ts와 같은 목록). 완화 뒤에도 그대로 거부된다
  it.each([
    // 1차 재현: 나눗셈 · 정규식 오판
    ["let n = 0; let p; n++ /(p = import('../../src/lib/db'))/ 1;", '상대 · 절대 경로'],
    ["const of = 1; of /import('../../src/lib/db')/ 1;", '상대 · 절대 경로'],
    ["let n = 0; n-- /import('../../src/lib/db')/ 1;", '상대 · 절대 경로'],
    ["let n = 0; n! /import('../../src/lib/db')/ 1;", '상대 · 절대 경로'],
    ["const o = { in: 1 }; o.in /import('../../src/lib/db')/ 1;", '상대 · 절대 경로'],
    // 2차 7건: 따옴표 · 백틱이 문자열 경계로 바뀌어 코드가 숨는 사례
    ['if (true) {}\n/\'/.test("x"); await import("../../src/lib/db"); // \'', '상대 · 절대 경로'],
    ['if (1) /\'/.test("x"), await import("../../src/lib/db"); // \'', '상대 · 절대 경로'],
    [
      'let i = 0; while (i++ < 1) /\'/.test("x"); await import("../../src/lib/db"); // \'',
      '상대 · 절대 경로',
    ],
    [
      'for (const m of /\'/.exec("x") ?? []) {} await import("../../src/lib/db"); // \'',
      '상대 · 절대 경로',
    ],
    [
      "const s = `${/'/.source}`; await import(\"../../src/lib/db\"); const t = '}`'; // '",
      '상대 · 절대 경로',
    ],
    ['if (true) {}\n/`/.test("x"); await import("../../src/lib/db"); // `', '상대 · 절대 경로'],
    [
      "const v = n as Array<number> / '/'; await import(\"../../src/lib/db\"); // '",
      '상대 · 절대 경로',
    ],
    // Function 생성자 우회
    [
      '(async () => {}).constructor(\'return import("../../src/lib/db")\')();',
      'constructor로 생성자',
    ],
    ['const F = Object.getPrototypeOf(async () => {}).constructor;', 'constructor로 생성자'],
    ["const g = (() => {})['constructor'];", 'constructor로 생성자'],
    ['const x = (1).constructor.constructor;', 'constructor로 생성자'],
    ['const { constructor: F } = async () => {};', 'constructor로 생성자'],
    ["const F = Reflect.get(async () => {}, 'constructor');", 'constructor로 생성자'],
    ['const g = (() => {})[`constructor`];', 'constructor로 생성자'],
    ["Reflect.construct(Function, ['return 1']);", 'Function 생성자'],
    ["globalThis.Function('return 1')();", 'Function 생성자'],
    ["const f = new Function('return 1');", 'Function'],
    // 속성 이름을 문자열 · 구조 분해로 꺼내기, 실행기 내부 이름
    ["const fsm = process['getBuiltinModule']('node:fs');", 'getBuiltinModule'],
    ['const { getBuiltinModule: g } = process;', 'getBuiltinModule'],
    ["const b = Reflect.get(process, 'binding');", 'process.binding'],
    ["const m = await __vite_ssr_dynamic_import__('../../src/lib/db');", '실행기 내부 이름'],
    // with · eval
    ['with (process) { void 0; }', 'with 문'],
    ["eval('1');", 'eval'],
    ["\\u0065val('1');", 'eval'],
  ])('PR #136 사례 %s → 거부', (source, message) => {
    expectRejected(source, message);
  });
});

describe('스냅숏 단언 거부 (#29, ADR-069)', () => {
  it.each([
    ['expect({ ok: true }).toMatchSnapshot();', 'toMatchSnapshot'],
    ['expect({ ok: true }).toMatchInlineSnapshot();', 'toMatchInlineSnapshot'],
    ["await expect('x').toMatchFileSnapshot('../../src/lib/pwned.ts');", 'toMatchFileSnapshot'],
    [
      "await expect(Promise.resolve('x')).resolves.toMatchFileSnapshot('a.txt');",
      'toMatchFileSnapshot',
    ],
    ['expect(() => 1).not.toThrowErrorMatchingSnapshot();', 'toThrowErrorMatchingSnapshot'],
    ['expect(() => 1).toThrowErrorMatchingInlineSnapshot();', 'toThrowErrorMatchingInlineSnapshot'],
    [
      "(expect(1) as unknown as Record<string, () => void>)['toMatchSnapshot']();",
      'toMatchSnapshot',
    ],
    ['const { toMatchSnapshot } = expect(1);', 'toMatchSnapshot'],
  ])('%s → 거부', (source, name) => {
    expectRejected(source, `스냅숏 단언(${name})`);
  });

  it('매처의 문자열 인자 · 객체 키 · 타입 자리의 같은 이름은 허용한다 (스냅숏을 쓰지 않음)', () => {
    const source = [
      "import { expect, it } from 'vitest';",
      "import { request } from '@bive/http';",
      'type Body = { toMatchSnapshot: string };',
      "it('스냅숏 이름이 든 응답', async () => {",
      "  const res = await request('/api/items');",
      '  const body = (await res.json()) as Body;',
      "  expect(body).toHaveProperty('toMatchFileSnapshot');",
      "  expect(body).toEqual({ toMatchSnapshot: 'x' });",
      '});',
    ].join('\n');
    expect(lintAcceptanceSource(source)).toEqual([]);
  });
});

describe('파서 지연 로드 (#137)', () => {
  it('오케스트레이터 기동 모듈을 불러와도 typescript6을 읽지 않고, 첫 검사 때 읽는다', () => {
    // 기동 진입점(orchestrator.ts)과 패키지 전체 공개 모듈(index.ts: 검사 모듈 · 테스트 작성 단계 포함)을 불러온 뒤
    // CommonJS 모듈 캐시에 TypeScript 파서가 있는지 본다. 이어서 검사를 한 번 돌려 캐시에 생기는지(대조군)도 본다
    const script = [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      'const loaded = () => Object.keys(require.cache).some((key) => /[\\\\/]typescript[\\\\/]lib[\\\\/]typescript\\.js$/.test(key));',
      "await import('./src/orchestrator.ts');",
      "const index = await import('./src/index.ts');",
      'const before = loaded();',
      'const problems = index.lintAcceptanceSource("import x from \'../src/x\';");',
      'console.log(JSON.stringify({ before, after: loaded(), problems: problems.length }));',
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['--conditions=@bive/source', '--import', 'tsx', '--input-type=module', '--eval', script],
      { cwd: ORCHESTRATOR_DIR, encoding: 'utf8', timeout: 25_000 },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ before: false, after: true, problems: 1 });
  }, 30_000);
});
