// 위반 판별 (M3-02 #47, ADR-125 ③): 블록 선언에서 생성한 dependency-cruiser 규칙의 위반 출력을 옮긴다.
import { describe, expect, it } from 'vitest';

import { analyzeProject, type StructureViolation } from '../src/index.js';
import { mapFilesToBlocks } from '../src/blocks.js';
import { CruiseOutput } from '../src/cruise.js';
import { escapeRegExpLiteral, exactPathsRegExp } from '../src/regex.js';
import { buildRuleSet } from '../src/rules.js';
import { violationsFromCruise } from '../src/violations.js';
import { PARSER_LIMITS } from '../src/limits.js';
import { copyFixture, declaration, exampleDeclaration, makeProject } from './helpers.js';

/** auth · health · lib (예제와 같은 방향) + lib 공개 파일 하나. */
const blocks = () =>
  declaration([
    { name: 'auth', include: ['src/auth/**'], dependsOn: ['lib'] },
    { name: 'health', include: ['src/health/**'], dependsOn: ['lib'] },
    { name: 'lib', kind: 'shared', include: ['src/lib/**'], public: ['src/lib/db.ts'] },
  ]);

const base = {
  'src/auth/a.ts': '',
  'src/health/h.ts': '',
  'src/lib/db.ts': '',
  'src/lib/internal.ts': '',
  'src/page.ts': '',
};

const violationsOf = async (files: Record<string, string>): Promise<StructureViolation[]> => {
  const result = await analyzeProject({
    projectDir: makeProject({ ...base, ...files }),
    declaration: blocks(),
  });
  if (result.structure?.outcome.status !== 'checked') throw new Error('판별하지 않음');
  expect(result.structure.outcome.violations.total).toBe(
    result.structure.outcome.violations.items.length,
  );
  return result.structure.outcome.violations.items;
};

const edge = (
  kind: StructureViolation['kind'],
  from: [string, string],
  to: [string, string],
): StructureViolation => ({
  kind,
  from: { file: from[0], block: from[1] },
  to: { file: to[0], block: to[1] },
  cycle: null,
});

describe('종류별 판별', () => {
  it('선언 외 방향: dependsOn에 없는 블록으로의 import (공개 여부와 상관없이 한 건)', async () => {
    expect(await violationsOf({ 'src/health/h.ts': "import '@/auth/a';\n" })).toEqual([
      edge(
        'structure.declared-direction',
        ['src/health/h.ts', 'health'],
        ['src/auth/a.ts', 'auth'],
      ),
    ]);
  });

  it('공개 API 외 접근: 허용된 방향에서 공개 파일이 아닌 파일을 import. 공개 파일은 위반이 아니다', async () => {
    expect(
      await violationsOf({
        'src/auth/a.ts': "import '@/lib/internal';\nimport '@/lib/db';\n",
      }),
    ).toEqual([
      edge('structure.public-api-only', ['src/auth/a.ts', 'auth'], ['src/lib/internal.ts', 'lib']),
    ]);
  });

  it('공유 블록도 선언한 방향만 허용된다 (종류로 방향을 넓히지 않는다)', async () => {
    expect(await violationsOf({ 'src/lib/db.ts': "import '@/auth/a';\n" })).toEqual([
      edge('structure.declared-direction', ['src/lib/db.ts', 'lib'], ['src/auth/a.ts', 'auth']),
    ]);
  });

  it('같은 블록 안 import와 미분류 파일이 낀 import는 위반이 아니다', async () => {
    expect(
      await violationsOf({
        'src/lib/db.ts': "import './internal';\n",
        'src/page.ts': "import '@/lib/internal';\nimport '@/auth/a';\n",
        'src/health/h.ts': "import '@/page';\n",
      }),
    ).toEqual([]);
  });

  it('타입 전용 · 동적 import도 판별한다', async () => {
    expect(
      await violationsOf({
        'src/health/h.ts':
          "import type { X } from '@/lib/internal';\nexport const l = () => import('@/auth/a');\nexport type Y = X;\n",
        'src/lib/internal.ts': 'export type X = 1;\n',
      }),
    ).toEqual([
      edge(
        'structure.declared-direction',
        ['src/health/h.ts', 'health'],
        ['src/auth/a.ts', 'auth'],
      ),
      edge(
        'structure.public-api-only',
        ['src/health/h.ts', 'health'],
        ['src/lib/internal.ts', 'lib'],
      ),
    ]);
  });

  it('순환: 블록 안의 순환 하나는 위반 한 건이고, 경로는 사전순 첫 파일에서 시작한다', async () => {
    expect(
      await violationsOf({
        'src/lib/c.ts': "import './internal';\n",
        'src/lib/internal.ts': "import './b';\n",
        'src/lib/b.ts': "import './c';\n",
      }),
    ).toEqual([
      {
        kind: 'structure.no-cycle',
        from: { file: 'src/lib/b.ts', block: 'lib' },
        to: { file: 'src/lib/c.ts', block: 'lib' },
        cycle: { items: ['src/lib/b.ts', 'src/lib/c.ts', 'src/lib/internal.ts'], total: 3 },
      },
    ]);
  });

  it('미분류 파일을 거치는 순환은 위반이 아니다', async () => {
    expect(
      await violationsOf({
        'src/lib/db.ts': "import '@/page';\n",
        'src/page.ts': "import '@/lib/db';\n",
      }),
    ).toEqual([]);
  });
});

describe('규칙은 매핑한 파일 경로를 글자 그대로 넣은 것이다', () => {
  it('블록 선언 → 규칙 (패턴이 아니라 파일 경로 목록)', () => {
    const files = ['src/auth/a.ts', 'src/health/h.ts', 'src/lib/db.ts', 'src/lib/internal.ts'];
    const ruleSet = buildRuleSet(blocks(), mapFilesToBlocks(blocks(), files));
    expect(ruleSet).toEqual({
      forbidden: [
        {
          name: 'declared-direction--auth',
          severity: 'error',
          from: { path: '^(?:src/auth/a\\.ts)$' },
          to: { path: '^(?:src/health/h\\.ts)$' },
        },
        {
          name: 'declared-direction--health',
          severity: 'error',
          from: { path: '^(?:src/health/h\\.ts)$' },
          to: { path: '^(?:src/auth/a\\.ts)$' },
        },
        {
          name: 'declared-direction--lib',
          severity: 'error',
          from: { path: '^(?:src/lib/db\\.ts|src/lib/internal\\.ts)$' },
          to: { path: '^(?:src/auth/a\\.ts|src/health/h\\.ts)$' },
        },
        {
          name: 'public-api-only--lib',
          severity: 'error',
          from: { path: '^(?:src/auth/a\\.ts|src/health/h\\.ts)$' },
          to: { path: '^(?:src/lib/internal\\.ts)$' },
        },
        {
          name: 'no-cycle',
          severity: 'error',
          from: {
            path: '^(?:src/auth/a\\.ts|src/health/h\\.ts|src/lib/db\\.ts|src/lib/internal\\.ts)$',
          },
          to: {
            circular: true,
            viaOnly: {
              path: '^(?:src/auth/a\\.ts|src/health/h\\.ts|src/lib/db\\.ts|src/lib/internal\\.ts)$',
            },
          },
        },
      ],
    });
  });

  it('정규식 특수 글자 · 공백 · 유니코드가 든 파일 이름도 dependency-cruiser 규칙으로 판별된다', async () => {
    const result = await analyzeProject({
      projectDir: makeProject({
        'src/a/[id]/(g)/x+y $z.ts': "import '@/b/한글 파일{1}|^';\n",
        'src/b/한글 파일{1}|^.ts': '',
        'src/b/한글 파일{1}x^.ts': '',
      }),
      declaration: declaration([
        { name: 'a', include: ['src/a/**'] },
        { name: 'b', include: ['src/b/**'] },
      ]),
    });
    expect(result.structure?.outcome).toEqual({
      status: 'checked',
      violations: {
        items: [
          edge(
            'structure.declared-direction',
            ['src/a/[id]/(g)/x+y $z.ts', 'a'],
            ['src/b/한글 파일{1}|^.ts', 'b'],
          ),
        ],
        total: 1,
      },
    });
  });

  it('이스케이프한 정규식은 목록의 경로에만 정확히 맞는다', () => {
    const paths = [
      'src/a.ts',
      'src/[id]/b+c.ts',
      'src/q?.ts',
      'src/back\\slash.ts',
      'src/한 글.ts',
    ];
    const re = new RegExp(exactPathsRegExp(paths));
    for (const p of paths) expect(re.test(p), p).toBe(true);
    for (const near of [
      'src/aXts',
      'src/a.ts/x',
      'xsrc/a.ts',
      'src/i/b+c.ts',
      'src/q.ts',
      'src/bbc.ts',
    ]) {
      expect(re.test(near), near).toBe(false);
    }
    expect(escapeRegExpLiteral('.*+?^${}()|[]\\')).toBe(
      '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\',
    );
    expect(() => exactPathsRegExp([])).toThrow();
  });

  it('파일 2천 개의 정규식이 폭주하지 않는다 (맞지 않는 긴 글 · 거의 맞는 글)', () => {
    const paths = Array.from(
      { length: 2_000 },
      (_, i) => `src/app/[slug]/(group)/${'a'.repeat(30)}${String(i)}/파일 (${String(i)})+.ts`,
    );
    const re = new RegExp(exactPathsRegExp(paths));
    const probes = [
      ...paths.slice(0, 50).map((p) => `${p}x`),
      `${'src/app/[slug]/(group)/'}${'a'.repeat(4_000)}`,
      'a'.repeat(4_000),
      `${paths[1999] as string}`,
    ];
    const started = performance.now();
    let matched = 0;
    for (const probe of probes) if (re.test(probe)) matched += 1;
    expect(matched).toBe(1);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('위반 출력 옮기기', () => {
  const mapping = () =>
    mapFilesToBlocks(blocks(), ['src/auth/a.ts', 'src/lib/b.ts', 'src/lib/db.ts', 'src/page.ts']);
  const output = (violations: unknown[]) =>
    CruiseOutput.parse({ modules: [], summary: { violations } });
  const rule = (name: string) => ({ name, severity: 'error' });

  it('같은 순환이 여러 간선에서 나와도 하나로 모은다', () => {
    const result = violationsFromCruise(
      output([
        {
          from: 'src/lib/b.ts',
          to: 'src/lib/db.ts',
          rule: rule('no-cycle'),
          cycle: [{ name: 'src/lib/db.ts' }, { name: 'src/lib/b.ts' }],
        },
        {
          from: 'src/lib/db.ts',
          to: 'src/lib/b.ts',
          rule: rule('no-cycle'),
          cycle: [{ name: 'src/lib/b.ts' }, { name: 'src/lib/db.ts' }],
        },
      ]),
      mapping(),
    );
    expect(result.total).toBe(1);
    expect(result.items[0]?.cycle?.items).toEqual(['src/lib/b.ts', 'src/lib/db.ts']);
  });

  it('모르는 규칙 · 블록 밖 파일 · 깨진 순환 경로는 오류다', () => {
    expect(() =>
      violationsFromCruise(
        output([{ from: 'src/auth/a.ts', to: 'src/lib/b.ts', rule: rule('other') }]),
        mapping(),
      ),
    ).toThrow(expect.objectContaining({ code: 'cruise_output_invalid' }));
    expect(() =>
      violationsFromCruise(
        output([{ from: 'src/page.ts', to: 'src/lib/b.ts', rule: rule('declared-direction--x') }]),
        mapping(),
      ),
    ).toThrow(expect.objectContaining({ code: 'cruise_output_invalid' }));
    expect(() =>
      violationsFromCruise(
        output([
          {
            from: 'src/lib/b.ts',
            to: 'src/lib/db.ts',
            rule: rule('no-cycle'),
            cycle: [{ name: 'src/lib/db.ts' }],
          },
        ]),
        mapping(),
      ),
    ).toThrow(expect.objectContaining({ code: 'cruise_output_invalid' }));
  });

  it('위반 목록이 상한을 넘으면 앞쪽만 담고 전체 개수를 남긴다', () => {
    const files = Array.from(
      { length: PARSER_LIMITS.violations + 1 },
      (_, i) => `src/lib/f${String(i).padStart(5, '0')}.ts`,
    );
    const big = mapFilesToBlocks(blocks(), ['src/auth/a.ts', ...files]);
    const result = violationsFromCruise(
      output(
        files.map((file) => ({
          from: 'src/auth/a.ts',
          to: file,
          rule: rule('public-api-only--lib'),
        })),
      ),
      big,
    );
    expect(result.items).toHaveLength(PARSER_LIMITS.violations);
    expect(result.total).toBe(PARSER_LIMITS.violations + 1);
    expect(result.items[0]?.to.file).toBe(files[0]);
  });
});

describe('분석하지 않은 파일로 가는 import는 드러나고, 블록 파일에서면 통과로 읽을 수 없다', () => {
  const ab = () =>
    declaration([
      { name: 'a', include: ['src/a/**'] },
      { name: 'b', include: ['src/b/**'] },
    ]);
  const relayFiles = {
    'src/b/hidden1.ts': '',
    'src/a/relay.es6': "require('../b/hidden1');\n",
    '.next/relay.js': "require('../src/b/hidden1');\n",
    'node_modules/relay-pkg/package.json': JSON.stringify({ name: 'relay-pkg', main: 'index.js' }),
    'node_modules/relay-pkg/index.js': "require('../../src/b/hidden1');\n",
  };
  const analyzeAb = (files: Record<string, string>) =>
    analyzeProject({ projectDir: makeProject({ ...relayFiles, ...files }), declaration: ab() });

  it.each([
    ['소스로 치지 않는 확장자 (블록 include 안)', "import './relay.es6';\n", 'src/a/relay.es6'],
    ['건너뛰는 폴더 (.next)', "import '../../.next/relay.js';\n", '.next/relay.js'],
    [
      '프로젝트 node_modules를 경로로',
      "import '../../node_modules/relay-pkg/index.js';\n",
      'node_modules/relay-pkg/index.js',
    ],
  ])('%s: incomplete 상태에 그 import가 실리고 그래프에도 있다', async (_label, source, to) => {
    const result = await analyzeAb({ 'src/a/x.ts': source });
    expect(result.graph.unanalyzed).toEqual({ items: [{ from: 'src/a/x.ts', to }], total: 1 });
    expect(result.structure?.outcome).toEqual({
      status: 'incomplete',
      violations: { items: [], total: 0 },
      unanalyzed: { items: [{ from: 'src/a/x.ts', to }], total: 1 },
    });
  });

  it('패키지 이름으로 가져온 프로젝트 안 패키지는 패키지 목록에 이름으로 드러난다 (package.json에 없음 표시)', async () => {
    const result = await analyzeAb({ 'src/a/x.ts': "import 'relay-pkg';\n" });
    expect(result.graph.packages).toEqual({
      items: [{ name: 'relay-pkg', inManifest: false }],
      total: 1,
    });
    expect(result.graph.unanalyzed.total).toBe(0);
    // 진짜 패키지와 심은 패키지를 구별하지 않으므로 이것만으로는 incomplete가 아니다(ADR-125 남는 틈)
    expect(result.structure?.outcome.status).toBe('checked');
  });

  it('같은 프로젝트에서 직접 import는 여전히 위반 1건이다 (incomplete 안에서도 위반을 싣는다)', async () => {
    const result = await analyzeAb({
      'src/a/x.ts': "import './relay.es6';\nimport '@/b/hidden1';\n",
    });
    expect(result.structure?.outcome).toEqual({
      status: 'incomplete',
      violations: {
        items: [
          edge('structure.declared-direction', ['src/a/x.ts', 'a'], ['src/b/hidden1.ts', 'b']),
        ],
        total: 1,
      },
      unanalyzed: { items: [{ from: 'src/a/x.ts', to: 'src/a/relay.es6' }], total: 1 },
    });
    const direct = await analyzeAb({ 'src/a/x.ts': "import '@/b/hidden1';\n" });
    expect(direct.structure?.outcome).toEqual({
      status: 'checked',
      violations: {
        items: [
          edge('structure.declared-direction', ['src/a/x.ts', 'a'], ['src/b/hidden1.ts', 'b']),
        ],
        total: 1,
      },
    });
  });

  it('데이터 형식(JSON · CSS · 그림)은 분석하지 않은 대상이 아니고, 미분류 파일에서 간 것은 incomplete로 만들지 않는다', async () => {
    const result = await analyzeAb({
      'src/a/x.ts': "import './d.json';\nimport './s.module.css';\nimport './i.svg';\n",
      'src/a/d.json': '{}',
      'src/a/s.module.css': '',
      'src/a/i.svg': '<svg/>',
      'src/page.ts': "import '../.next/relay.js';\n",
    });
    expect(result.graph.unanalyzed).toEqual({
      items: [{ from: 'src/page.ts', to: '.next/relay.js' }],
      total: 1,
    });
    expect(result.structure?.outcome).toEqual({
      status: 'checked',
      violations: { items: [], total: 0 },
    });
  });

  it('정상 픽스처(설치하지 않은 사본)에서는 분석하지 않은 대상이 없다', async () => {
    const result = await analyzeProject({
      projectDir: copyFixture(),
      declaration: exampleDeclaration(),
    });
    expect(result.graph.unanalyzed).toEqual({ items: [], total: 0 });
    expect(result.structure?.outcome.status).toBe('checked');
  });
});
