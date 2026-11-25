// 파일과 블록 매핑 · 미분류 파일 (M3-02 #47, ADR-125 ②).
import { describe, expect, it } from 'vitest';

import { analyzeProject } from '../src/index.js';
import { mapFilesToBlocks } from '../src/blocks.js';
import { copyFixture, declaration, exampleDeclaration, makeProject } from './helpers.js';

describe('예제 선언으로 픽스처를 나눈다', () => {
  it('블록별 파일 · 공개 파일 · 미분류 파일과 위반 0건', async () => {
    const result = await analyzeProject({
      projectDir: copyFixture(),
      declaration: exampleDeclaration(),
    });
    expect(result.structure).toEqual({
      blocks: [
        {
          name: 'auth',
          files: { items: ['src/app/api/auth/session/route.ts'], total: 1 },
          publicFiles: { items: [], total: 0 },
        },
        {
          name: 'health',
          files: { items: ['src/app/api/health/route.ts'], total: 1 },
          publicFiles: { items: [], total: 0 },
        },
        {
          name: 'lib',
          files: { items: ['src/lib/db.ts'], total: 1 },
          publicFiles: { items: ['src/lib/db.ts'], total: 1 },
        },
      ],
      unclassified: {
        items: [
          'next.config.ts',
          'prisma.config.ts',
          'src/app/layout.tsx',
          'src/app/page.tsx',
          'tests/http/health.test.ts',
          'tests/support/server.ts',
          'vitest.config.ts',
        ],
        total: 7,
      },
      publicOutsideInclude: { items: [], total: 0 },
      outcome: { status: 'checked', violations: { items: [], total: 0 } },
    });
  });

  it('선언이 없으면 블록 판정 · 위반 판별 없이 그래프만 낸다', async () => {
    const result = await analyzeProject({ projectDir: copyFixture(), declaration: null });
    expect(result.structure).toBeNull();
    expect(result.graph.edges.total).toBe(1);
  });

  it('형식에 맞지 않는 선언은 오류다', async () => {
    await expect(
      analyzeProject({
        projectDir: copyFixture(),
        declaration: { blocks: [] } as unknown as ReturnType<typeof exampleDeclaration>,
      }),
    ).rejects.toMatchObject({ code: 'invalid_declaration' });
  });
});

describe('매핑 판정 (matchesBlockPattern)', () => {
  const files = [
    'src/Lib/x.ts',
    'src/app/a.ts',
    'src/lib/db.ts',
    'src/lib/inner/y.ts',
    'src/other.ts',
  ];

  it('대소문자를 구분하고 디스크 이름 그대로 맞춘다', () => {
    const mapping = mapFilesToBlocks(
      declaration([{ name: 'lib', include: ['src/lib/**'] }]),
      files,
    );
    expect(mapping.blocks[0]?.files).toEqual(['src/lib/db.ts', 'src/lib/inner/y.ts']);
    expect(mapping.unclassified).toEqual(['src/Lib/x.ts', 'src/app/a.ts', 'src/other.ts']);
  });

  it('두 블록의 include에 맞는 파일은 어느 블록에도 넣지 않고 겹침으로 낸다 (하나를 고르지 않는다)', () => {
    const mapping = mapFilesToBlocks(
      declaration([
        { name: 'app', include: ['src/**'] },
        { name: 'lib', include: ['src/lib/**'] },
      ]),
      files,
    );
    expect(mapping.overlaps).toEqual([
      { file: 'src/lib/db.ts', blocks: ['app', 'lib'] },
      { file: 'src/lib/inner/y.ts', blocks: ['app', 'lib'] },
    ]);
    expect(mapping.blockOf.has('src/lib/db.ts')).toBe(false);
    expect(mapping.blocks.map((block) => block.files)).toEqual([
      ['src/Lib/x.ts', 'src/app/a.ts', 'src/other.ts'],
      [],
    ]);
  });

  it('public 패턴은 그 블록에 속한 파일에만 공개를 준다. 밖을 가리키면 목록으로 낸다', () => {
    const mapping = mapFilesToBlocks(
      declaration([
        { name: 'lib', include: ['src/lib/**'], public: ['src/lib/db.ts', 'src/app/a.ts'] },
        { name: 'app', include: ['src/app/**'] },
      ]),
      files,
    );
    expect(mapping.blocks[0]?.publicFiles).toEqual(['src/lib/db.ts']);
    expect(mapping.blocks[1]?.publicFiles).toEqual([]);
    expect(mapping.publicOutsideInclude).toEqual([{ block: 'lib', file: 'src/app/a.ts' }]);
  });
});

describe('겹침이 있으면 위반을 판별하지 않는다', () => {
  it('결과는 overlap 상태이고 위반 목록이 없다 ("위반 0건"과 구별된다)', async () => {
    const root = makeProject({
      'src/lib/db.ts': '',
      'src/app/a.ts': "import '@/lib/db';\n",
    });
    const result = await analyzeProject({
      projectDir: root,
      declaration: declaration([
        { name: 'app', include: ['src/**'] },
        { name: 'lib', include: ['src/lib/**'] },
      ]),
    });
    expect(result.structure?.outcome).toEqual({
      status: 'overlap',
      overlaps: { items: [{ file: 'src/lib/db.ts', blocks: ['app', 'lib'] }], total: 1 },
    });
    expect(result.graph.edges.items).toEqual([{ from: 'src/app/a.ts', to: 'src/lib/db.ts' }]);
  });
});
