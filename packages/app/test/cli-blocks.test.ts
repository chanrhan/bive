// 개발용 CLI의 블록 선언 저장 · 예제 블록 선언 (M3-01 #46 수용 기준 4, NRM-09 · ADR-005 · ADR-122).
// 제한: 실제 pnpm · 오케스트레이터를 띄우는 묶음은 60초(cli.test.ts와 같다, #122).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BlockDeclaration,
  blockPatternProblem,
  ErrorCode,
  matchesBlockPattern,
  PROJECT_FILE_NAME,
  rpcError,
} from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, runCli, type CliDeps } from '../src/cli-core.js';
import { ensureOrchestrator, orchestratorCommand } from '../src/main/orchestrator-launch.js';
import { PipeRpcError } from '../src/main/pipe-client.js';
import { cleanup, makeBiveHome, ORCHESTRATOR_DIR, REPO_ROOT } from './helpers/orchestrator.js';

const projectDirs: string[] = [];

afterEach(async () => {
  await cleanup();
  for (const dir of projectDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROCESS_TEST_OPTIONS = { timeout: 60_000 };

const EXAMPLE = path.join(REPO_ROOT, 'fixtures', 'blocks', 'sample-next-app.json');
const FIXTURE = path.join(REPO_ROOT, 'fixtures', 'sample-next-app');
const PROJECT_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';

/** 가짜 파일 · 접속으로 CLI 본체를 돌린다. */
const fakeDeps = (
  files: Record<string, string>,
  request: (method: string, params?: unknown) => Promise<unknown> = (_method, params) =>
    Promise.resolve({ current: { echoed: params } }),
): CliDeps & { out: string[]; err: string[]; connects: number; requests: unknown[][] } => {
  const deps = {
    out: [] as string[],
    err: [] as string[],
    connects: 0,
    requests: [] as unknown[][],
    stdout: (t: string) => deps.out.push(t),
    stderr: (t: string) => deps.err.push(t),
    readFile: (file: string) => {
      const content = files[file];
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    resolvePath: (value: string) => path.posix.join('/cwd', value),
    connect: () => {
      deps.connects += 1;
      return Promise.resolve({
        request: (method: string, params?: unknown) => {
          deps.requests.push([method, params]);
          return request(method, params);
        },
        close: () => Promise.resolve(),
      });
    },
  };
  return deps;
};

const DECLARATION = { blocks: [{ name: 'lib' }] };
const FILES = {
  [`/cwd/proj/${PROJECT_FILE_NAME}`]: JSON.stringify({ projectId: PROJECT_ID, schemaVersion: 1 }),
  '/cwd/blocks.json': JSON.stringify(DECLARATION),
};

describe('cli blocks set 본체', () => {
  it('폴더의 .bive.json 프로젝트 ID와 JSON 파일 내용으로 blocks.set을 사람 주체로 1회 부르고 결과를 출력한다', async () => {
    const deps = fakeDeps(FILES);
    expect(await runCli(['blocks', 'set', 'proj', 'blocks.json'], deps)).toBe(EXIT_OK);
    const params = { projectId: PROJECT_ID, author: { kind: 'human' }, declaration: DECLARATION };
    expect(deps.requests).toEqual([['blocks.set', params]]);
    expect(JSON.parse(deps.out[0] ?? '')).toEqual({ current: { echoed: params } });
    expect(deps.err).toEqual([]);
  });

  it('식별 파일 없음 · 형식 오류 · JSON 해석 실패 · 인자 수 위반은 접속하지 않고 종료 2', async () => {
    const cases: [string[], Record<string, string>, string][] = [
      [['blocks', 'set', 'none', 'blocks.json'], FILES, '프로젝트 식별 파일 읽기 실패'],
      [
        ['blocks', 'set', 'proj', 'blocks.json'],
        { ...FILES, [`/cwd/proj/${PROJECT_FILE_NAME}`]: '{"projectId":"x"}' },
        '프로젝트 식별 파일 형식 오류',
      ],
      [['blocks', 'set', 'proj', 'missing.json'], FILES, '블록 선언 파일 읽기 실패'],
      [
        ['blocks', 'set', 'proj', 'blocks.json'],
        { ...FILES, '/cwd/blocks.json': '{bad' },
        'JSON 해석 실패',
      ],
      [['blocks', 'set', 'proj'], FILES, '사용법'],
      [['blocks', 'get', 'proj', 'blocks.json'], FILES, '사용법'],
    ];
    for (const [argv, files, message] of cases) {
      const deps = fakeDeps(files);
      expect(await runCli(argv, deps), argv.join(' ')).toBe(EXIT_USAGE);
      expect(deps.connects).toBe(0);
      expect(deps.err[0]).toContain(message);
    }
  });

  it('원격 오류(검증 실패 · 권한)는 종료 1과 오류 코드 · 메시지', async () => {
    const deps = fakeDeps(FILES, () =>
      Promise.reject(
        new PipeRpcError(rpcError(ErrorCode.ValidationFailed, '블록 선언 검증 실패: 이름 중복')),
      ),
    );
    expect(await runCli(['blocks', 'set', 'proj', 'blocks.json'], deps)).toBe(EXIT_ERROR);
    expect(deps.err).toEqual(['오류 -32001: 블록 선언 검증 실패: 이름 중복']);
  });

  it('rpc 명령으로는 여전히 쓰기 메서드를 부를 수 없다 (blocks.set은 접속 전에 거부, blocks.get은 허용)', async () => {
    const deps = fakeDeps(FILES);
    expect(await runCli(['rpc', 'blocks.set', '{}'], deps)).toBe(EXIT_USAGE);
    expect(deps.connects).toBe(0);
    expect(await runCli(['rpc', 'blocks.get', `{"projectId":"${PROJECT_ID}"}`], deps)).toBe(
      EXIT_OK,
    );
    expect(deps.requests).toEqual([['blocks.get', { projectId: PROJECT_ID }]]);
  });
});

describe('예제 블록 선언이 픽스처에 맞는다 (fixtures/blocks/sample-next-app.json)', () => {
  /** 픽스처의 파일 (git이 추적하거나 무시하지 않는 파일, 픽스처 기준 상대 경로) */
  const fixtureFiles = (): string[] =>
    execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
      {
        cwd: FIXTURE,
        encoding: 'utf8',
      },
    )
      .split('\0')
      // 지워진(추적만 남은) 파일은 빼고 지금 있는 파일만
      .filter((file) => file !== '' && existsSync(path.join(FIXTURE, file)));

  it('스키마 · 저장 규칙을 지나고 auth는 위험도 high, lib는 low다', () => {
    const declaration = BlockDeclaration.parse(JSON.parse(readFileSync(EXAMPLE, 'utf8')));
    const byName = new Map(declaration.blocks.map((block) => [block.name, block]));
    expect(byName.get('auth')).toMatchObject({ kind: 'domain', risk: 'high' });
    expect(byName.get('lib')).toMatchObject({ kind: 'shared', risk: 'low' });
  });

  it('포함 경로 · 공개 API 패턴이 모두 픽스처의 실제 파일을 가리키고, 공개 API는 그 블록 안이며, 두 블록에 속한 파일이 없다', () => {
    const declaration = BlockDeclaration.parse(JSON.parse(readFileSync(EXAMPLE, 'utf8')));
    const files = fixtureFiles();
    expect(files).toContain('src/lib/db.ts');
    const owners = new Map<string, string[]>();
    for (const block of declaration.blocks) {
      for (const pattern of block.include) {
        expect(blockPatternProblem(pattern)).toBeNull();
        const matched = files.filter((file) => matchesBlockPattern(pattern, file));
        expect(matched, `${block.name} include ${pattern}`).not.toEqual([]);
        for (const file of matched) owners.set(file, [...(owners.get(file) ?? []), block.name]);
      }
      for (const pattern of block.public) {
        const matched = files.filter((file) => matchesBlockPattern(pattern, file));
        expect(matched, `${block.name} public ${pattern}`).not.toEqual([]);
        for (const file of matched) {
          expect(
            block.include.some((include) => matchesBlockPattern(include, file)),
            `${block.name} public ${file}`,
          ).toBe(true);
        }
      }
    }
    for (const [file, names] of owners) expect(names, file).toHaveLength(1);
    // 블록마다 실제로 가리키는 파일 (픽스처 구조와 맞는지)
    const filesOf = (name: string) =>
      [...owners]
        .filter(([, names]) => names.includes(name))
        .map(([file]) => file)
        .sort();
    expect(filesOf('auth')).toEqual(['src/app/api/auth/session/route.ts']);
    expect(filesOf('health')).toEqual(['src/app/api/health/route.ts']);
    expect(filesOf('lib')).toEqual(['src/lib/db.ts']);
  });
});

describe(
  'pnpm --filter @bive/app cli blocks set (실제 오케스트레이터)',
  PROCESS_TEST_OPTIONS,
  () => {
    it('등록된 프로젝트 폴더에 예제 선언을 저장하고 blocks.get이 같은 선언을 돌려준다', async () => {
      const home = makeBiveHome();
      const env = { ...process.env, BIVE_HOME: home, BIVE_IDLE_SHUTDOWN_MS: '60000' };
      // 프로젝트 등록 (.bive.json 생성): 앱이 폴더를 여는 것과 같은 project.open
      const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-cli-blocks-'));
      projectDirs.push(dir);
      writeFileSync(path.join(dir, 'README.md'), '프로젝트');
      const { client } = await ensureOrchestrator({
        biveHome: home,
        command: orchestratorCommand({
          mode: 'source',
          orchestratorDir: ORCHESTRATOR_DIR,
          nodePath: process.execPath,
          biveHome: home,
          env,
        }),
      });
      let projectId: string;
      try {
        const opened = (await client.request('project.open', { path: dir })) as {
          project: { id: string };
        };
        projectId = opened.project.id;
      } finally {
        await client.close();
      }

      const run = (args: string[]) =>
        spawnSync('pnpm', ['--silent', '--filter', '@bive/app', 'cli', ...args], {
          // 상대 경로는 명령을 친 폴더 기준이다 (pnpm의 INIT_CWD)
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env,
          shell: process.platform === 'win32',
          timeout: PROCESS_TEST_OPTIONS.timeout - 10_000,
        });
      const saved = run(['blocks', 'set', dir, path.relative(REPO_ROOT, EXAMPLE)]);
      expect(saved.status, saved.stderr).toBe(0);
      const example = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as unknown;
      const result = JSON.parse(saved.stdout) as { current: unknown };
      expect(result.current).toMatchObject({
        version: 1,
        declaration: example,
        setBy: { kind: 'human' },
      });

      const read = run(['rpc', 'blocks.get', JSON.stringify({ projectId })]);
      expect(read.status, read.stderr).toBe(0);
      expect(JSON.parse(read.stdout)).toEqual(result);
    });
  },
);
