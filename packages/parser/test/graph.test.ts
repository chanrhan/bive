// import 그래프 (M3-02 #47, ADR-033 · ADR-125 ①): dependency-cruiser 출력을 변환만 하고 자체 모듈 해석기를 쓰지 않는다.
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyzeProject, ParserError } from '../src/index.js';
import { CruiseOutput } from '../src/cruise.js';
import { graphFromCruise } from '../src/graph.js';
import { capped, PARSER_LIMITS } from '../src/limits.js';
import { copyFixture, makeProject, tempDir, writeFiles } from './helpers.js';

const graphOf = async (projectDir: string) =>
  (await analyzeProject({ projectDir, declaration: null })).graph;

const cruiseOutput = (modules: unknown[]): CruiseOutput =>
  CruiseOutput.parse({ modules, summary: { violations: [] } });

const dep = (module: string, resolved: string, extra: object = {}) => ({
  module,
  resolved,
  coreModule: false,
  couldNotResolve: false,
  ...extra,
});

describe('픽스처의 import 그래프', () => {
  it('소스 파일 전부가 모듈이고, 경로 별칭 import는 dependency-cruiser가 푼 경로로 간선이 된다', async () => {
    const graph = await graphOf(copyFixture());
    expect(graph.modules).toEqual([
      'next.config.ts',
      'prisma.config.ts',
      'src/app/api/auth/session/route.ts',
      'src/app/api/health/route.ts',
      'src/app/layout.tsx',
      'src/app/page.tsx',
      'src/lib/db.ts',
      'tests/http/health.test.ts',
      'tests/support/server.ts',
      'vitest.config.ts',
    ]);
    // `import { getDb } from '@/lib/db'` (tsconfig paths `@/*` → `./src/*`)
    expect(graph.edges).toEqual({
      items: [{ from: 'src/app/api/health/route.ts', to: 'src/lib/db.ts' }],
      total: 1,
    });
    // 설치하지 않은 사본이라 패키지 · 생성 코드는 풀리지 않은 import로 남는다(Node 내장 모듈은 빠진다)
    expect(graph.unresolved.items).toContainEqual({
      from: 'src/lib/db.ts',
      module: '@/generated/prisma/client',
    });
    expect(graph.unresolved.items.some((item) => item.module === 'fs')).toBe(false);
  });

  it('별칭 풀이는 프로젝트의 tsconfig를 읽은 dependency-cruiser의 것이다: paths를 바꾸면 간선이 따라간다', async () => {
    const root = makeProject({
      'src/a.ts': "import { b } from '@/b';\nexport const a = b;\n",
      'src/b.ts': 'export const b = 1;\n',
      'alt/b.ts': 'export const b = 2;\n',
    });
    expect((await graphOf(root)).edges.items).toEqual([{ from: 'src/a.ts', to: 'src/b.ts' }]);
    writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./alt/*'] } } }),
    );
    expect((await graphOf(root)).edges.items).toEqual([{ from: 'src/a.ts', to: 'alt/b.ts' }]);
  });

  it('확장자 생략 · index 파일 · 상대 경로 풀이도 dependency-cruiser 출력 그대로다', async () => {
    const root = makeProject({
      'src/a.ts': "import './dir';\nimport './c';\nimport '../src/./d.js';\n",
      'src/dir/index.ts': '',
      'src/c.tsx': '',
      'src/d.ts': '',
    });
    expect((await graphOf(root)).edges.items).toEqual([
      { from: 'src/a.ts', to: 'src/c.tsx' },
      { from: 'src/a.ts', to: 'src/d.ts' },
      { from: 'src/a.ts', to: 'src/dir/index.ts' },
    ]);
  });
});

describe('변환만 한다 (출력 → 그래프)', () => {
  it('간선의 끝은 출력의 resolved 그대로다 (모듈 이름에서 경로를 짐작하지 않는다)', () => {
    const output = cruiseOutput([
      {
        source: 'src/a.ts',
        dependencies: [
          // 이름으로는 짐작할 수 없는 풀이: 그대로 옮긴다
          dep('./whatever', 'src/z.ts'),
          dep('fs', 'fs', { coreModule: true }),
          dep('left-pad', 'left-pad', { couldNotResolve: true }),
          dep('./style.css', 'src/style.css'),
          dep('../outside', '../outside.ts'),
        ],
      },
      { source: 'src/z.ts', dependencies: [dep('./a', 'src/a.ts'), dep('./a', 'src/a.ts')] },
      { source: 'src/style.css', dependencies: [dep('./z', 'src/z.ts')] },
    ]);
    expect(graphFromCruise(output, ['src/a.ts', 'src/z.ts'])).toEqual({
      modules: ['src/a.ts', 'src/z.ts'],
      edges: {
        items: [
          { from: 'src/a.ts', to: 'src/z.ts' },
          { from: 'src/z.ts', to: 'src/a.ts' },
        ],
        total: 2,
      },
      unresolved: { items: [{ from: 'src/a.ts', module: 'left-pad' }], total: 1 },
    });
  });

  it('소스 파일인데 출력에 없으면 오류다 ("import 없음"으로 읽지 않는다)', () => {
    const output = cruiseOutput([{ source: 'src/a.ts', dependencies: [] }]);
    expect(() => graphFromCruise(output, ['src/a.ts', 'src/b.ts'])).toThrow(
      expect.objectContaining({ code: 'file_not_analyzed' }),
    );
  });

  it('대소문자만 다른 경로로 풀린 import는 오류다 (간선을 조용히 잃지 않는다)', () => {
    const output = cruiseOutput([
      { source: 'src/a.ts', dependencies: [dep('./DB', 'src/DB.ts')] },
      { source: 'src/db.ts', dependencies: [] },
    ]);
    expect(() => graphFromCruise(output, ['src/a.ts', 'src/db.ts'])).toThrow(
      expect.objectContaining({ code: 'path_case_mismatch' }),
    );
  });

  it('parser 소스에 모듈 해석 코드가 없다 (해석기 · tsconfig 읽기 · require.resolve 없음, 가져오는 모듈은 허용 목록뿐)', () => {
    const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
    const allowedImports = new Set([
      '@bive/shared',
      'zod',
      'node:child_process',
      'node:fs',
      'node:path',
      'node:url',
    ]);
    const files = readdirSync(srcDir).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const name of files) {
      const text = readFileSync(path.join(srcDir, name), 'utf8');
      for (const match of text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
        const specifier = match[1] as string;
        if (specifier.startsWith('./')) continue;
        expect(allowedImports, `${name}: ${specifier}`).toContain(specifier);
      }
      for (const banned of [
        'require.resolve',
        'import.meta.resolve',
        'createRequire',
        'compilerOptions',
        'baseUrl',
        'enhanced-resolve',
        'tsconfig-paths',
        '/index',
      ]) {
        expect(text.includes(banned), `${name}: ${banned}`).toBe(false);
      }
    }
    const runner = readFileSync(fileURLToPath(new URL('../runner/cruise.mjs', import.meta.url)), 'utf8');
    expect([...runner.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])).toEqual(['dependency-cruiser']);
  });
});

describe('그래프에 넣는 파일 (ADR-125 ①)', () => {
  it('JS · TS 계열 확장자만, node_modules(어느 깊이든) · 루트의 .git · .next · bive-acceptance는 빼고, 시험 파일 · 선언 파일 · 숨은 폴더는 넣는다', async () => {
    const root = makeProject({
      'src/a.ts': '',
      'src/b.tsx': '',
      'src/c.mts': '',
      'src/d.cts': '',
      'src/e.js': '',
      'src/f.jsx': '',
      'src/g.mjs': '',
      'src/h.cjs': '',
      'src/types.d.ts': '',
      'src/a.test.ts': '',
      'tests/x.spec.ts': '',
      'src/.hidden/x.ts': '',
      'src/.next/y.ts': '',
      'src/data.json': '{}',
      'src/style.css': '',
      'README.md': '',
      'node_modules/pkg/index.js': '',
      'src/node_modules/pkg/index.js': '',
      '.git/hooks/x.js': '',
      '.next/server/x.js': '',
      'bive-acceptance/r1/x.acc.ts': '',
    });
    expect((await graphOf(root)).modules).toEqual([
      'src/.hidden/x.ts',
      'src/.next/y.ts',
      'src/a.test.ts',
      'src/a.ts',
      'src/b.tsx',
      'src/c.mts',
      'src/d.cts',
      'src/e.js',
      'src/f.jsx',
      'src/g.mjs',
      'src/h.cjs',
      'src/types.d.ts',
      'tests/x.spec.ts',
    ]);
  });

  it('타입 전용 import · 동적 import · require도 간선이다', async () => {
    const root = makeProject({
      'src/a.ts':
        "import type { T } from './t';\nexport const x: T = 1;\nexport const l = () => import('./lazy');\n",
      'src/c.cjs': "require('./r.cjs');\n",
      'src/t.ts': 'export type T = number;\n',
      'src/lazy.ts': '',
      'src/r.cjs': '',
    });
    expect((await graphOf(root)).edges.items).toEqual([
      { from: 'src/a.ts', to: 'src/lazy.ts' },
      { from: 'src/a.ts', to: 'src/t.ts' },
      { from: 'src/c.cjs', to: 'src/r.cjs' },
    ]);
  });

  it('기호 링크는 따라가지 않고, 프로젝트 밖으로 풀린 경로는 간선이 아니다', async () => {
    const outside = tempDir('outside-');
    writeFiles(outside, { 'lib/x.ts': "import './y';\n", 'lib/y.ts': '', 'z.ts': '' });
    const root = makeProject({ 'src/a.ts': "import '../../outside/z';\n", 'src/b.ts': '' });
    symlinkSync(path.join(outside, 'lib'), path.join(root, 'src/linked-dir'));
    symlinkSync(path.join(outside, 'z.ts'), path.join(root, 'src/linked-file.ts'));
    symlinkSync(root, path.join(root, 'src/loop'));
    mkdirSync(path.join(root, '..', 'outside'), { recursive: true });
    writeFileSync(path.join(root, '..', 'outside', 'z.ts'), "import './w';\n");
    writeFileSync(path.join(root, 'src/c.ts'), "import './linked-file';\nimport './linked-dir/x';\n");
    const graph = await graphOf(root);
    expect(graph.modules).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(graph.edges).toEqual({ items: [], total: 0 });
  });

  it('경로 글자는 바꾸지 않는다: 정규식 특수 글자 · 공백 · 유니코드 · 역슬래시가 든 이름', async () => {
    const names = [
      'src/app/[id]/(group)/a+b $x.ts',
      'src/lib/한글 파일.ts',
      'src/lib/back\\slash.ts',
      'src/lib/q{1}|^.ts',
    ];
    const root = makeProject({
      'src/main.ts': names
        .map((name) => `import ${JSON.stringify(`./${path.relative('src', name)}`)};`)
        .join('\n'),
      // `?`는 리졸버가 쿼리로 읽는다: 파일은 모듈이지만 그 이름으로 쓴 import는 풀리지 않은 import로 남는다
      'src/q?.ts': '',
      'src/other.ts': "import './q?';\n",
      ...Object.fromEntries(names.map((name) => [name, ''])),
    });
    const graph = await graphOf(root);
    expect(graph.modules).toEqual([...names, 'src/main.ts', 'src/other.ts', 'src/q?.ts'].sort());
    expect(graph.edges.items.filter((edge) => edge.from === 'src/main.ts').map((edge) => edge.to)).toEqual(
      [...names].sort(),
    );
    expect(graph.edges.items.some((edge) => edge.from === 'src/other.ts')).toBe(false);
    expect(graph.unresolved.items).toContainEqual({ from: 'src/other.ts', module: './q?' });
  });
});

describe('상한 (ADR-125 ⑤)', () => {
  it('경로가 상한을 넘으면 오류다', async () => {
    const segment = 'd'.repeat(200);
    const deep = Array.from({ length: 6 }, () => segment).join('/');
    const root = makeProject({ [`${deep}/a.ts`]: '' });
    await expect(graphOf(root)).rejects.toMatchObject({ code: 'path_too_long' });
  });

  it('소스 파일 수가 상한을 넘으면 오류다 (상한과 같으면 받는다는 것은 비용 측정이 보인다)', async () => {
    const root = makeProject({});
    mkdirSync(path.join(root, 'src'), { recursive: true });
    for (let i = 0; i <= PARSER_LIMITS.maxFiles; i += 1) {
      writeFileSync(path.join(root, 'src', `f${String(i)}.ts`), '');
    }
    await expect(graphOf(root)).rejects.toBeInstanceOf(ParserError);
    await expect(graphOf(root)).rejects.toMatchObject({ code: 'too_many_files' });
  });

  it('목록이 상한을 넘으면 앞쪽만 담고 전체 개수를 남긴다', () => {
    expect(capped([1, 2, 3], 2)).toEqual({ items: [1, 2], total: 3 });
    expect(capped([1, 2], 2)).toEqual({ items: [1, 2], total: 2 });
    const files = Array.from({ length: PARSER_LIMITS.edges + 1 }, (_, i) => `f${String(i)}.ts`);
    const output = cruiseOutput([
      { source: 'a.ts', dependencies: files.map((file) => dep(file, file)) },
      ...files.map((file) => ({ source: file, dependencies: [] })),
    ]);
    const graph = graphFromCruise(output, ['a.ts', ...files]);
    expect(graph.edges.items).toHaveLength(PARSER_LIMITS.edges);
    expect(graph.edges.total).toBe(PARSER_LIMITS.edges + 1);
  });

  it('프로젝트 폴더가 없으면 오류다', async () => {
    await expect(graphOf(path.join(tempDir(), 'none'))).rejects.toMatchObject({
      code: 'project_not_found',
    });
  });
});
