// 개발용 CLI의 계약 등록 (M3-04 #49 수용 기준 4, NRM-03 · ADR-019 · ADR-100 C2, ADR-129).
// 제한: 실제 pnpm · 오케스트레이터를 띄우는 묶음은 60초(cli.test.ts와 같다, #122).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ErrorCode, PROJECT_FILE_NAME, rpcError } from '@bive/shared';
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

const PROJECT_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const REQUIREMENT_ID = '01J9ZZZZZZZZZZZZZZZZZZZZZY';

/** 가짜 파일 · 접속으로 CLI 본체를 돌린다. */
const fakeDeps = (
  files: Record<string, string>,
  request: (method: string, params?: unknown) => Promise<unknown> = (_method, params) =>
    Promise.resolve({ echoed: params }),
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

const FILES = {
  [`/cwd/proj/${PROJECT_FILE_NAME}`]: JSON.stringify({ projectId: PROJECT_ID, schemaVersion: 1 }),
};

describe('cli contract register 본체', () => {
  it('폴더의 .bive.json 프로젝트 ID와 계약 파일 경로(프로젝트 루트 기준, 풀지 않음) · 종류로 contract.register를 사람 주체로 1회 부르고 결과를 출력한다', async () => {
    const deps = fakeDeps(FILES);
    expect(
      await runCli(['contract', 'register', 'proj', 'docs/openapi.yaml', 'openapi'], deps),
    ).toBe(EXIT_OK);
    const params = {
      projectId: PROJECT_ID,
      file: 'docs/openapi.yaml',
      kind: 'openapi',
      author: { kind: 'human' },
    };
    expect(deps.requests).toEqual([['contract.register', params]]);
    expect(JSON.parse(deps.out[0] ?? '')).toEqual({ echoed: params });
    expect(deps.err).toEqual([]);
    // 넷째 인자는 부모 요구사항 ID
    const linked = fakeDeps(FILES);
    expect(
      await runCli(
        ['contract', 'register', 'proj', 'prisma/schema.prisma', 'db-schema', REQUIREMENT_ID],
        linked,
      ),
    ).toBe(EXIT_OK);
    expect(linked.requests).toEqual([
      [
        'contract.register',
        {
          projectId: PROJECT_ID,
          file: 'prisma/schema.prisma',
          kind: 'db-schema',
          author: { kind: 'human' },
          requirementId: REQUIREMENT_ID,
        },
      ],
    ]);
  });

  it('식별 파일 없음 · 형식 오류 · 모르는 종류 · 요구사항 ID 형식 오류 · 인자 수 위반은 접속하지 않고 종료 2', async () => {
    const cases: [string[], Record<string, string>, string][] = [
      [
        ['contract', 'register', 'none', 'openapi.yaml', 'openapi'],
        FILES,
        '프로젝트 식별 파일 읽기 실패',
      ],
      [
        ['contract', 'register', 'proj', 'openapi.yaml', 'openapi'],
        { [`/cwd/proj/${PROJECT_FILE_NAME}`]: '{"projectId":"x"}' },
        '프로젝트 식별 파일 형식 오류',
      ],
      [
        ['contract', 'register', 'proj', 'openapi.yaml', 'openapi'],
        { [`/cwd/proj/${PROJECT_FILE_NAME}`]: '{bad' },
        'JSON 해석 실패',
      ],
      [['contract', 'register', 'proj', 'openapi.yaml', 'graphql'], FILES, '모르는 계약 종류'],
      [
        ['contract', 'register', 'proj', 'openapi.yaml', 'openapi', 'REQ-001'],
        FILES,
        '요구사항 ID 형식 오류',
      ],
      [['contract', 'register', 'proj', 'openapi.yaml'], FILES, '사용법'],
      [['contract', 'register', 'proj', 'a.yaml', 'openapi', REQUIREMENT_ID, 'x'], FILES, '사용법'],
      [['contract', 'list', 'proj', 'a.yaml', 'openapi'], FILES, '사용법'],
    ];
    for (const [argv, files, message] of cases) {
      const deps = fakeDeps(files);
      expect(await runCli(argv, deps), argv.join(' ')).toBe(EXIT_USAGE);
      expect(deps.connects, argv.join(' ')).toBe(0);
      expect(deps.err[0], argv.join(' ')).toContain(message);
    }
  });

  it('원격 오류(검증 실패 · 권한 · 상태 충돌)는 종료 1과 오류 코드 · 메시지', async () => {
    for (const [code, message] of [
      [ErrorCode.ValidationFailed, '계약 등록 실패: 종류와 맞지 않는 확장자입니다'],
      [ErrorCode.StateConflict, '같은 파일의 계약이 이미 있습니다: openapi.yaml'],
    ] as const) {
      const deps = fakeDeps(FILES, () => Promise.reject(new PipeRpcError(rpcError(code, message))));
      expect(await runCli(['contract', 'register', 'proj', 'openapi.yaml', 'openapi'], deps)).toBe(
        EXIT_ERROR,
      );
      expect(deps.err).toEqual([`오류 ${String(code)}: ${message}`]);
    }
  });

  it('rpc 명령으로는 계약 등록을 부를 수 없다 (contract.register는 접속 전에 거부, contract.list는 허용)', async () => {
    const deps = fakeDeps(FILES);
    expect(await runCli(['rpc', 'contract.register', '{}'], deps)).toBe(EXIT_USAGE);
    expect(deps.connects).toBe(0);
    expect(await runCli(['rpc', 'contract.list', `{"projectId":"${PROJECT_ID}"}`], deps)).toBe(
      EXIT_OK,
    );
    expect(deps.requests).toEqual([['contract.list', { projectId: PROJECT_ID }]]);
  });
});

/** 사용자 쪽 git (서명 · 훅 끔). */
const userGit = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=사용자',
      '-c',
      'user.email=user@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${os.devNull}`,
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();

describe(
  'pnpm --filter @bive/app cli contract register (실제 오케스트레이터)',
  PROCESS_TEST_OPTIONS,
  () => {
    it('등록된 프로젝트 폴더(git 저장소)의 커밋된 계약 파일을 사람 주체로 등록하고, contract.list가 표시 ID · 종류 · 원본 파일 · 해시 · 확인됨 · 검사 규칙을 돌려준다', async () => {
      const home = makeBiveHome();
      const env = { ...process.env, BIVE_HOME: home, BIVE_IDLE_SHUTDOWN_MS: '60000' };
      const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-cli-contract-'));
      projectDirs.push(dir);
      const openapi = 'openapi: 3.1.0\ninfo:\n  title: 샘플\n  version: 1.0.0\npaths: {}\n';
      writeFileSync(path.join(dir, 'openapi.yaml'), openapi);
      userGit(dir, 'init', '-q', '-b', 'main');
      userGit(dir, 'add', 'openapi.yaml');
      userGit(dir, 'commit', '-q', '-m', '계약');
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
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env,
          shell: process.platform === 'win32',
          timeout: PROCESS_TEST_OPTIONS.timeout - 10_000,
        });
      const saved = run(['contract', 'register', dir, 'openapi.yaml', 'openapi']);
      expect(saved.status, saved.stderr).toBe(0);
      const result = JSON.parse(saved.stdout) as {
        contract: { id: string; displayId: string };
        rule: { id: string; displayId: string };
        approvalLog: { action: string };
      };
      expect(result.contract).toMatchObject({
        displayId: 'CON-001',
        kind: 'openapi',
        sourceFile: 'openapi.yaml',
        contentHash: createHash('sha256').update(openapi).digest('hex'),
        sourceCommit: userGit(dir, 'rev-parse', 'refs/heads/main'),
        author: { kind: 'human' },
        confirmation: { state: 'confirmed', basis: { kind: 'contract_record' } },
      });
      expect(result.rule).toMatchObject({ builtin: true, checkKinds: ['contract'] });
      expect(result.approvalLog.action).toBe('contract_edit');

      const read = run(['rpc', 'contract.list', JSON.stringify({ projectId })]);
      expect(read.status, read.stderr).toBe(0);
      expect(JSON.parse(read.stdout)).toEqual({
        contracts: [
          {
            contract: result.contract,
            rule: { id: result.rule.id, displayId: result.rule.displayId },
            source: { status: 'same' },
          },
        ],
      });
      // 같은 파일을 다시 등록하면 종료 1 (상태 충돌), 커밋 안 한 파일은 종료 1 (검증 실패)
      const again = run(['contract', 'register', dir, 'openapi.yaml', 'openapi']);
      expect(again.status).toBe(1);
      expect(again.stderr).toContain('오류 -32009');
      writeFileSync(path.join(dir, 'events.yaml'), 'asyncapi: 3.0.0\n');
      const uncommitted = run(['contract', 'register', dir, 'events.yaml', 'asyncapi']);
      expect(uncommitted.status).toBe(1);
      expect(uncommitted.stderr).toContain('오류 -32001');
    });
  },
);
