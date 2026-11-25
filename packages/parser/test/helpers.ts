// 파서 시험 보조: 임시 프로젝트 폴더 · 픽스처 사본 · 예제 블록 선언.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BlockDeclaration } from '@bive/shared';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures/sample-next-app');

/** 예제 블록 선언 (auth · health · lib). */
export const exampleDeclaration = (): BlockDeclaration =>
  BlockDeclaration.parse(
    JSON.parse(readFileSync(path.join(REPO_ROOT, 'fixtures/blocks/sample-next-app.json'), 'utf8')),
  );

/** 새 임시 폴더. */
export const tempDir = (prefix = 'parser-'): string => mkdtempSync(path.join(tmpdir(), prefix));

/** 파일을 쓴다 (폴더는 만든다). */
export const writeFiles = (root: string, files: Record<string, string>): void => {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
};

/** 파일 몇 개로 된 프로젝트 (tsconfig의 `@/*` → `./src/*` 별칭 포함). */
export const makeProject = (files: Record<string, string>): string => {
  const root = path.join(tempDir(), 'project');
  writeFiles(root, {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        module: 'esnext',
        moduleResolution: 'bundler',
        paths: { '@/*': ['./src/*'] },
      },
    }),
    ...files,
  });
  return root;
};

/** 픽스처의 소스 사본 (설치 · 빌드 산출물 없이). */
export const copyFixture = (): string => {
  const root = path.join(tempDir(), 'fx');
  cpSync(FIXTURE_DIR, root, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(FIXTURE_DIR, source);
      return !/(^|\/)(node_modules|\.next|generated)(\/|$)/.test(rel) && !rel.endsWith('.db');
    },
  });
  return root;
};

/** 블록 선언을 줄여 쓰는 도우미. */
export const declaration = (
  blocks: {
    name: string;
    kind?: 'domain' | 'shared';
    include: string[];
    public?: string[];
    dependsOn?: string[];
  }[],
): BlockDeclaration =>
  BlockDeclaration.parse({
    blocks: blocks.map((block) => ({
      kind: 'domain',
      public: [],
      dependsOn: [],
      risk: 'low',
      ...block,
    })),
  });
