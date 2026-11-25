// 분석 대상 프로젝트의 코드를 실행하지 않는다 (M3-02 #47, ADR-125 ④).
// 대상 프로젝트에 "실행되면 표시 파일을 남기는" 설정 파일 · 플러그인 · 스크립트를 심고 분석해도 표시 파일이 생기지 않음을 본다.
// 심은 파일이 실제로 실행되면 표시 파일을 남긴다는 것은 대조군(node로 직접 실행)으로 확인한다.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { analyzeProject } from '../src/index.js';
import { cruiseInput, RUNNER_PATH, runCruiseProcess } from '../src/cruise.js';
import { declaration, tempDir, writeFiles } from './helpers.js';

const cjs = (marker: string): string =>
  `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nmodule.exports = {};\n`;
const esm = (marker: string): string =>
  `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport default {};\n`;

/** 심은 프로젝트와 표시 파일 폴더. */
const plantedProject = () => {
  const markers = tempDir('markers-');
  const m = (name: string): string => path.join(markers, name);
  const root = path.join(tempDir(), 'project');
  const executables: Record<string, string> = {
    // dependency-cruiser 설정 파일 (CLI가 자동으로 찾는 이름)
    '.dependency-cruiser.js': cjs(m('depcruise-js')),
    '.dependency-cruiser.cjs': cjs(m('depcruise-cjs')),
    '.dependency-cruiser.mjs': esm(m('depcruise-mjs')),
    '.dependency-cruiser.ts': esm(m('depcruise-ts')),
    '.dependency-cruiser.mts': esm(m('depcruise-mts')),
    '.dependency-cruiser.cts': cjs(m('depcruise-cts')),
    // webpack · babel 설정
    'webpack.config.js': cjs(m('webpack-js')),
    'webpack.config.mjs': esm(m('webpack-mjs')),
    'babel.config.js': cjs(m('babel-js')),
    'babel.config.cjs': cjs(m('babel-cjs')),
    '.babelrc.js': cjs(m('babelrc-js')),
    // 프로젝트 안의 도구 · 플러그인 (tsconfig · .babelrc가 가리킴, 프로젝트의 typescript · dependency-cruiser)
    'node_modules/evil-ts-plugin/index.js': cjs(m('ts-plugin')),
    'node_modules/evil-ts-config/index.js': cjs(m('ts-extends-package')),
    'node_modules/evil-babel-plugin/index.js': cjs(m('babel-plugin')),
    'node_modules/typescript/index.js': cjs(m('project-typescript')),
    'node_modules/dependency-cruiser/index.js': cjs(m('project-depcruise')),
    // pnpm 훅 · 프로젝트 소스의 최상위 부수 효과
    '.pnpmfile.cjs': cjs(m('pnpmfile')),
    'next.config.js': cjs(m('next-config')),
    'src/side.js': cjs(m('source-side-effect')),
  };
  writeFiles(root, {
    ...executables,
    '.dependency-cruiser.json': JSON.stringify({
      forbidden: [{ name: 'planted', severity: 'error', from: {}, to: {} }],
    }),
    '.babelrc': JSON.stringify({ plugins: ['evil-babel-plugin'] }),
    'node_modules/evil-ts-plugin/package.json': JSON.stringify({
      name: 'evil-ts-plugin',
      main: 'index.js',
    }),
    'node_modules/evil-ts-config/package.json': JSON.stringify({
      name: 'evil-ts-config',
      main: 'index.js',
    }),
    'node_modules/evil-ts-config/tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true },
    }),
    'node_modules/evil-babel-plugin/package.json': JSON.stringify({
      name: 'evil-babel-plugin',
      main: 'index.js',
    }),
    'node_modules/typescript/package.json': JSON.stringify({
      name: 'typescript',
      version: '5.9.0',
      main: 'index.js',
    }),
    'node_modules/dependency-cruiser/package.json': JSON.stringify({
      name: 'dependency-cruiser',
      version: '18.7.2',
      main: 'index.js',
    }),
    'package.json': JSON.stringify({
      name: 'planted',
      scripts: Object.fromEntries(
        ['preinstall', 'install', 'postinstall', 'prepare', 'pretest', 'test', 'depcruise'].map(
          (hook) => [
            hook,
            `node -e "require('fs').writeFileSync('${m(`script-${hook}`)}', 'ran')"`,
          ],
        ),
      ),
    }),
    'tsconfig.json': JSON.stringify({
      extends: [
        'evil-ts-config/tsconfig.json',
        './node_modules/evil-ts-config/tsconfig.json',
        '../outside/tsconfig.json',
      ],
      compilerOptions: { paths: { '@/*': ['./src/*'] }, plugins: [{ name: 'evil-ts-plugin' }] },
    }),
    'src/a.ts': "import '@/side';\nimport './b';\n",
    'src/b.ts': '',
  });
  writeFiles(path.join(root, '..'), {
    'outside/tsconfig.json': JSON.stringify({ compilerOptions: { target: 'es2022' } }),
  });
  return { root, markers, executables };
};

const markersIn = (dir: string): string[] => readdirSync(dir).sort();

describe('대상 프로젝트의 코드를 실행하지 않는다', () => {
  it('대조군: 심은 파일은 실행되면 표시 파일을 남긴다', () => {
    const { root, markers, executables } = plantedProject();
    for (const rel of Object.keys(executables)) {
      execFileSync(process.execPath, [path.join(root, rel)], { cwd: root, env: {} });
    }
    expect(markersIn(markers)).toHaveLength(Object.keys(executables).length);
  });

  it('설정 파일 · 플러그인 · tsconfig extends · 스크립트 · 소스를 심어도 분석이 아무것도 실행하지 않는다', async () => {
    const { root, markers } = plantedProject();
    const result = await analyzeProject({
      projectDir: root,
      declaration: declaration([{ name: 'app', include: ['src/**'] }]),
    });
    expect(markersIn(markers)).toEqual([]);
    // tsconfig는 데이터로 읽혔다(별칭이 풀림) · 심은 .dependency-cruiser.json의 규칙은 쓰이지 않았다(모르는 규칙이면 오류)
    expect(result.graph.edges.items).toEqual([
      { from: 'src/a.ts', to: 'src/b.ts' },
      { from: 'src/a.ts', to: 'src/side.js' },
    ]);
    expect(result.structure?.outcome).toEqual({
      status: 'checked',
      violations: { items: [], total: 0 },
    });
  });

  describe('실행기 환경', () => {
    const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH };
    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('부모의 NODE_OPTIONS · NODE_PATH가 실행기에 넘어가지 않는다 (대조군: 넘기면 실행됨)', async () => {
      const { root, markers } = plantedProject();
      const preload = path.join(tempDir(), 'preload.cjs');
      writeFileSync(preload, cjs(path.join(markers, 'node-options')));
      process.env.NODE_OPTIONS = `--require ${preload}`;
      process.env.NODE_PATH = path.join(root, 'node_modules');
      execFileSync(process.execPath, ['-e', ''], { env: process.env });
      expect(markersIn(markers)).toEqual(['node-options']);
      rmSync(path.join(markers, 'node-options'));
      await analyzeProject({ projectDir: root, declaration: null });
      expect(markersIn(markers)).toEqual([]);
    });

    it('실행기는 빈 환경 변수 · 프로젝트 밖 작업 디렉터리 · 파서의 Node로 돈다', async () => {
      const probe = path.join(tempDir(), 'probe.mjs');
      writeFileSync(
        probe,
        'process.stdout.write(JSON.stringify({ env: Object.keys(process.env), cwd: process.cwd(), exec: process.execPath, argv: process.argv.slice(2) }));\n',
      );
      process.env.NODE_OPTIONS = '--no-warnings';
      const seen = JSON.parse(await runCruiseProcess({}, { runnerPath: probe })) as {
        env: string[];
        cwd: string;
        exec: string;
        argv: string[];
      };
      expect(seen).toEqual({ env: [], cwd: path.dirname(probe), exec: process.execPath, argv: [] });
    });

    it('TypeScript 파서가 없는 dependency-cruiser면 실행기가 거부한다 (.ts import를 못 읽은 "위반 0건"을 막음)', async () => {
      const dir = tempDir('runner-');
      copyFileSync(RUNNER_PATH, path.join(dir, 'cruise.mjs'));
      writeFiles(dir, {
        'node_modules/dependency-cruiser/package.json': JSON.stringify({
          name: 'dependency-cruiser',
          type: 'module',
          exports: './index.js',
        }),
        'node_modules/dependency-cruiser/index.js':
          "export const getAvailableTranspilers = () => [{ name: 'typescript', available: false }];\nexport const cruise = async () => ({ output: { modules: [], summary: { violations: [] } } });\n",
      });
      await expect(
        runCruiseProcess(
          { args: ['.'], options: {} },
          { runnerPath: path.join(dir, 'cruise.mjs') },
        ),
      ).rejects.toMatchObject({ code: 'cruise_failed' });
      // 파서의 실제 의존성에는 TypeScript 파서가 있다
      const { getAvailableTranspilers } = await import('dependency-cruiser');
      expect(getAvailableTranspilers().find((t) => t.name === 'typescript')?.available).toBe(true);
    });

    it('실제 실행기의 자리는 파서 패키지 안이다', () => {
      expect(RUNNER_PATH.endsWith(path.join('packages', 'parser', 'runner', 'cruise.mjs'))).toBe(
        true,
      );
      expect(existsSync(RUNNER_PATH)).toBe(true);
    });
  });

  it('실행기는 허용 목록 밖의 cruise 옵션을 거부한다 (webpack · babel 설정 · 보고서 플러그인 · 캐시)', async () => {
    const { root, markers } = plantedProject();
    const plugin = path.join(root, 'node_modules/evil-ts-plugin/index.js');
    const input = cruiseInput({ root, exclude: '(^|/)node_modules(/|$)', ruleSet: null });
    for (const extra of [
      { webpackConfig: { fileName: path.join(root, 'webpack.config.js') } },
      { babelConfig: { fileName: path.join(root, 'babel.config.js') } },
      { outputType: `plugin:${plugin}` },
      { cache: { folder: path.join(root, 'cache') } },
      { knownViolations: [] },
    ]) {
      await expect(
        runCruiseProcess({ ...input, options: { ...input.options, ...extra } }),
      ).rejects.toMatchObject({ code: 'cruise_failed' });
    }
    expect(markersIn(markers)).toEqual([]);
    expect(existsSync(path.join(root, 'cache'))).toBe(false);
  });

  it('tsconfig 옵션은 프로젝트에 tsconfig.json이 있을 때만 넘기고, 데이터 경로 하나뿐이다', () => {
    const root = path.join(tempDir(), 'p');
    writeFiles(root, { 'src/a.ts': '' });
    expect(cruiseInput({ root, exclude: 'x', ruleSet: null }).options).toEqual({
      baseDir: root,
      exclude: { path: 'x' },
      tsPreCompilationDeps: true,
      skipAnalysisNotInRules: true,
    });
    writeFiles(root, { 'tsconfig.json': '{}' });
    expect(cruiseInput({ root, exclude: 'x', ruleSet: null }).options).toMatchObject({
      tsConfig: { fileName: path.join(root, 'tsconfig.json') },
    });
  });
});

describe('실행기 실패는 닫힌 쪽이다 ("위반 0건"으로 읽히지 않는다)', () => {
  const fake = (body: string): string => {
    const file = path.join(tempDir(), 'fake-runner.mjs');
    writeFileSync(file, body);
    return file;
  };
  const project = () => {
    const root = path.join(tempDir(), 'p');
    writeFiles(root, { 'src/a.ts': '' });
    return root;
  };
  const analyze = (runnerPath: string, extra: object = {}) =>
    analyzeProject({ projectDir: project(), declaration: null, runnerPath, ...extra });

  it('시간 제한을 넘으면 오류이고 실행기를 죽인다', async () => {
    const pidFile = path.join(tempDir(), 'pid');
    const runner = fake(
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    );
    await expect(analyze(runner, { timeoutMs: 500 })).rejects.toMatchObject({
      code: 'cruise_timeout',
    });
    const pid = Number(execFileSync('cat', [pidFile]).toString());
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('출력이 크기 상한을 넘으면 오류다', async () => {
    const runner = fake("process.stdout.write('x'.repeat(100000));\n");
    await expect(analyze(runner, { maxOutputBytes: 1000 })).rejects.toMatchObject({
      code: 'cruise_output_too_large',
    });
  });

  it('0이 아닌 종료는 오류다 (출력이 그럴듯해도)', async () => {
    const runner = fake(
      'process.stdout.write(JSON.stringify({ modules: [], summary: { violations: [] } }));\nprocess.exit(3);\n',
    );
    await expect(analyze(runner)).rejects.toMatchObject({ code: 'cruise_failed' });
  });

  it('깨진 JSON · 다른 모양은 오류다', async () => {
    await expect(analyze(fake('process.stdout.write(\'{"modules": [\');\n'))).rejects.toMatchObject(
      {
        code: 'cruise_output_invalid',
      },
    );
    await expect(
      analyze(fake('process.stdout.write(\'{"modules": []}\');\n')),
    ).rejects.toMatchObject({
      code: 'cruise_output_invalid',
    });
  });

  it('빈 결과는 파일을 분석하지 않은 것이라 오류다', async () => {
    const runner = fake(
      'process.stdout.write(JSON.stringify({ modules: [], summary: { violations: [] } }));\n',
    );
    await expect(analyze(runner)).rejects.toMatchObject({ code: 'file_not_analyzed' });
  });
});
