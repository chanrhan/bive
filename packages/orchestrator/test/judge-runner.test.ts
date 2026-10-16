// 판정 러너 (M1-24 수용 기준, JDG-01 · ADR-026 · ADR-051).
// scripts/reset-fixture.sh로 만든 픽스처 복사본 하나에서 여러 판정을 순서대로 돌린다(서버 빌드는 1회).
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUlidGenerator } from '@bive/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JudgeRunner, type JudgeRunResult } from '../src/judge/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RESET_FIXTURE = path.join(REPO_ROOT, 'scripts', 'reset-fixture.sh');

/** 판정 1회 제한 시간 (마이그레이션 + next build + next start + vitest). */
const JUDGE_TIMEOUT_MS = 180_000;
/** 서버를 띄우는 테스트의 vitest 제한 시간. */
const BUILD_TEST_TIMEOUT_MS = 240_000;

const newId = createUlidGenerator();
const projectId = newId();
const runId = newId();

let fixtureDir = '';
let biveHome = '';
let runner: JudgeRunner;

const write = (relative: string, content: string): void => {
  const file = path.join(fixtureDir, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};

// 줄 번호를 단언하므로 줄 구성을 바꾸면 아래 기대값도 바꾼다
const HEALTH_ACC = `import { describe, expect, inject, it } from 'vitest';

describe('판정 서버', () => {
  it('기준 URL로 헬스 체크 성공', async () => {
    const baseUrl = inject('baseUrl');
    expect(baseUrl).toMatch(/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/);
    const res = await fetch(new URL('/api/health', baseUrl));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('없는 경로는 200', async () => {
    const res = await fetch(new URL('/api/missing', inject('baseUrl')));
    expect(res.status).toBe(200);
  });

  it.skip('건너뛴 케이스', () => {});
});
`;

/** 임시 DB 폴더 목록 (프로필이 os.tmpdir() 아래에 만든다). */
const tempDbDirs = (): string[] =>
  readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('bive-judge-db-'))
    .sort();

/** 워크트리를 작업 폴더로 쓰거나 명령줄에 담은 프로세스 (Linux /proc 기준). */
const processesIn = (dir: string): string[] => {
  if (process.platform !== 'linux') return [];
  const found: string[] = [];
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
      let cwd = '';
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        // 권한 없음 · 이미 종료
      }
      if (cmdline.includes(dir) || cwd === dir || cwd.startsWith(`${dir}/`)) {
        found.push(`${pid}: ${cmdline}`);
      }
    } catch {
      // 이미 종료
    }
  }
  return found;
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 판정 뒤 서버 프로세스 · 임시 DB가 남지 않았음을 확인한다. */
const expectNoLeftovers = async (result: JudgeRunResult, dbDirsBefore: string[]) => {
  expect(processesIn(fixtureDir)).toEqual([]);
  expect(tempDbDirs()).toEqual(dbDirsBefore);
  if (result.server !== null) {
    expect(existsSync(result.server.databasePath)).toBe(false);
    if (result.server.pid !== null) expect(isAlive(result.server.pid)).toBe(false);
    await expect(fetch(result.server.baseUrl)).rejects.toThrow();
  }
};

beforeAll(() => {
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'bive-judge-fx-'));
  biveHome = mkdtempSync(path.join(os.tmpdir(), 'bive-judge-home-'));
  execFileSync('bash', [RESET_FIXTURE, fixtureDir], { stdio: 'pipe' });
  // 프로젝트 vitest 설정을 읽으면 바로 실패하게 만든다 (JDG-01: 프로젝트 테스트 설정 불사용)
  write(
    'vitest.config.ts',
    "throw new Error('프로젝트 vitest 설정이 로드됨');\nexport default {};\n",
  );
  write('bive-acceptance/RULE-001/health.acc.ts', HEALTH_ACC);
  runner = new JudgeRunner({ biveHome });
}, 180_000);

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  if (biveHome) rmSync(biveHome, { recursive: true, force: true });
});

describe('JudgeRunner · next-prisma-sqlite', () => {
  it(
    'BIVE 전용 설정으로 인수 테스트만 실행하고 서버 기준 URL을 넘기며 케이스 결과와 원본 JSON을 남긴다',
    async () => {
      const dbDirsBefore = tempDbDirs();
      const result = await runner.run({
        projectId,
        runId,
        worktreeDir: fixtureDir,
        profile: 'next-prisma-sqlite',
        timeoutMs: JUDGE_TIMEOUT_MS,
      });
      // 단계별 소요 시간은 보고용으로 남긴다
      console.info('[judge-runner] timings(ms)', JSON.stringify(result.timings));

      expect(result.problems).toEqual([]);
      expect(result.status).toBe('completed');

      // ① 설정 위치 · 내용: $BIVE_HOME/projects/<id>/judge/<runId>/<judgeId>/vitest.config.mjs
      const judgeDir = path.join(biveHome, 'projects', projectId, 'judge', runId, result.judgeId);
      expect(result.paths.dir).toBe(judgeDir);
      expect(result.paths.config).toBe(path.join(judgeDir, 'vitest.config.mjs'));
      const config = readFileSync(result.paths.config, 'utf8');
      expect(config).toContain(`"root": ${JSON.stringify(fixtureDir)}`);
      expect(config).toContain('"bive-acceptance/**/*.acc.ts"');
      expect(config).toContain(JSON.stringify(path.join(judgeDir, 'global-setup.mjs')));
      expect(config).toContain(JSON.stringify(path.join(judgeDir, 'result.json')));
      expect(config).not.toContain('tests/support');
      // 프로젝트 설정(던지는 vitest.config.ts) · 프로젝트 테스트(tests/http)는 실행되지 않았다
      expect(result.summary.files).toBe(1);
      expect(new Set(result.cases.map((c) => c.file))).toEqual(
        new Set(['bive-acceptance/RULE-001/health.acc.ts']),
      );
      expect(readFileSync(result.paths.stdout, 'utf8')).not.toContain('health.test.ts');

      // ② 프로필: 임시 SQLite 마이그레이션 → next build → next start(127.0.0.1 임의 포트) → baseUrl
      expect(result.server).not.toBeNull();
      const server = result.server!;
      expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(path.dirname(path.dirname(server.databasePath))).toBe(os.tmpdir());
      const port = new URL(server.baseUrl).port;
      const profileLog = readFileSync(result.paths.profileLog, 'utf8');
      const bin = path.join(fixtureDir, 'node_modules', '.bin');
      expect(profileLog).toContain(`$ ${path.join(bin, 'prisma')} migrate deploy`);
      expect(profileLog).toContain(server.databasePath);
      expect(profileLog).toContain(`$ ${path.join(bin, 'next')} build`);
      expect(profileLog.indexOf('migrate deploy')).toBeLessThan(profileLog.indexOf(' build\n'));
      expect(readFileSync(result.paths.serverLog, 'utf8')).toContain(
        `$ ${path.join(bin, 'next')} start -H 127.0.0.1 -p ${port}`,
      );
      expect(Object.keys(result.timings).sort()).toEqual(
        ['build', 'collect', 'migrate', 'start', 'total', 'vitest'].sort(),
      );

      // ③ 케이스: 이름 · 파일 · 줄 · 상태 · 메시지. 헬스 체크 통과는 마이그레이션된 임시 DB 조회까지 포함
      const file = 'bive-acceptance/RULE-001/health.acc.ts';
      expect(result.cases).toEqual([
        {
          name: '판정 서버 > 기준 URL로 헬스 체크 성공',
          file,
          line: 4,
          status: 'passed',
          message: null,
        },
        {
          name: '판정 서버 > 없는 경로는 200',
          file,
          line: 12,
          status: 'failed',
          message: expect.stringContaining('expected 404 to be 200') as unknown as string,
        },
        { name: '판정 서버 > 건너뛴 케이스', file, line: 17, status: 'skipped', message: null },
      ]);
      expect(result.summary).toEqual({ files: 1, total: 3, passed: 1, failed: 1, skipped: 1 });
      expect(result.exitCode).toBe(1);
      expect(result.message).toBeNull();

      // 원본 JSON · 출력 보존
      expect(result.reporterPath).toBe(path.join(judgeDir, 'result.json'));
      const raw = JSON.parse(readFileSync(result.reporterPath!, 'utf8')) as {
        numTotalTests: number;
        testResults: { name: string }[];
      };
      expect(raw.numTotalTests).toBe(3);
      expect(raw.testResults.map((r) => r.name)).toEqual([path.join(fixtureDir, file)]);
      expect(existsSync(result.paths.stdout)).toBe(true);
      expect(existsSync(result.paths.stderr)).toBe(true);

      await expectNoLeftovers(result, dbDirsBefore);
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  it('문법 오류 · import 실패 · 테스트 0개 · .only 파일은 서버를 띄우기 전에 collect_error', async () => {
    write(
      'bive-acceptance/RULE-003/broken.acc.ts',
      "import { it } from 'vitest';\nit('x', () => { const = 1; });\n",
    );
    write('bive-acceptance/RULE-004/empty.acc.ts', "import { describe } from 'vitest';\n");
    write('bive-acceptance/RULE-005/missing.acc.ts', "import './no-such-helper.js';\n");
    write(
      'bive-acceptance/RULE-006/only.acc.ts',
      "import { expect, it } from 'vitest';\nit('a', () => expect(1).toBe(1));\nit.only('b', () => expect(1).toBe(1));\n",
    );
    const dbDirsBefore = tempDbDirs();
    const result = await runner.run({
      projectId,
      runId,
      worktreeDir: fixtureDir,
      profile: 'next-prisma-sqlite',
      ruleIds: ['RULE-001', 'RULE-003', 'RULE-004', 'RULE-005', 'RULE-006'],
      timeoutMs: JUDGE_TIMEOUT_MS,
    });

    expect(result.status).toBe('collect_error');
    const byFile = new Map(result.problems.map((p) => [p.file, p.message]));
    expect([...byFile.keys()].sort()).toEqual([
      'bive-acceptance/RULE-003/broken.acc.ts',
      'bive-acceptance/RULE-004/empty.acc.ts',
      'bive-acceptance/RULE-005/missing.acc.ts',
      'bive-acceptance/RULE-006/only.acc.ts',
    ]);
    expect(byFile.get('bive-acceptance/RULE-003/broken.acc.ts')).toMatch(/\S/);
    expect(byFile.get('bive-acceptance/RULE-003/broken.acc.ts')).not.toContain('\u001b[');
    expect(byFile.get('bive-acceptance/RULE-004/empty.acc.ts')).toBe('수집된 테스트 0개');
    expect(byFile.get('bive-acceptance/RULE-005/missing.acc.ts')).toContain('no-such-helper');
    expect(byFile.get('bive-acceptance/RULE-006/only.acc.ts')).toMatch(/^b: /);
    expect(result.message).toContain('bive-acceptance/RULE-003/broken.acc.ts: ');
    // 케이스는 하나도 실행하지 않았고(정상 파일 RULE-001 포함) 서버도 띄우지 않았다
    expect(result.cases).toEqual([]);
    expect(result.server).toBeNull();
    expect(result.timings.collect).toBeGreaterThan(0);
    expect(result.timings.build).toBeUndefined();
    expect(result.reporterPath).toBeNull();
    expect(existsSync(result.paths.collectResult)).toBe(true);
    expect(readFileSync(result.paths.collectConfig, 'utf8')).toContain(
      '"bive-acceptance/RULE-005/**/*.acc.ts"',
    );
    await expectNoLeftovers(result, dbDirsBefore);
  }, 60_000);

  it('인수 테스트가 0개면 서버를 띄우지 않고 collect_error', async () => {
    const forRule = await runner.run({
      projectId,
      runId,
      worktreeDir: fixtureDir,
      profile: 'next-prisma-sqlite',
      ruleIds: ['RULE-999'],
      timeoutMs: JUDGE_TIMEOUT_MS,
    });
    expect(forRule.status).toBe('collect_error');
    expect(forRule.problems).toEqual([
      { file: 'bive-acceptance/RULE-999', message: '인수 테스트 파일 없음' },
    ]);
    expect(forRule.server).toBeNull();

    rmSync(path.join(fixtureDir, 'bive-acceptance'), { recursive: true, force: true });
    const all = await runner.run({
      projectId,
      runId,
      worktreeDir: fixtureDir,
      profile: 'next-prisma-sqlite',
      timeoutMs: JUDGE_TIMEOUT_MS,
    });
    expect(all.status).toBe('collect_error');
    expect(all.cases).toEqual([]);
    expect(all.problems).toHaveLength(1);
    expect(all.problems[0]!.file).toBeNull();
    expect(all.server).toBeNull();
    expect(all.exitCode).toBeNull();
    // 같은 실행의 판정마다 폴더가 따로 생겨 이전 원본을 덮어쓰지 않는다
    expect(all.judgeId).not.toBe(forRule.judgeId);
    expect(readdirSync(path.join(biveHome, 'projects', projectId, 'judge', runId))).toHaveLength(4);
    write('bive-acceptance/RULE-001/health.acc.ts', HEALTH_ACC);
  });

  it('시간 초과는 runner_error이고 띄운 프로세스 · 임시 DB를 정리한다', async () => {
    const dbDirsBefore = tempDbDirs();
    const result = await runner.run({
      projectId,
      runId,
      worktreeDir: fixtureDir,
      profile: 'next-prisma-sqlite',
      // 이 VM 기준 수집 · 마이그레이션 뒤 빌드 도중에 끊긴다 (느린 환경에서는 앞 단계에서 끊길 수 있다)
      timeoutMs: 6_000,
    });
    expect(result.status).toBe('runner_error');
    expect(result.message).toMatch(/^판정 시간 초과 \((collect|migrate|build|start) 단계\)$/);
    expect(result.cases).toEqual([]);
    await expectNoLeftovers(result, dbDirsBefore);
  }, 30_000);

  it('서버 기동 실패(마이그레이션 실패)는 runner_error', async () => {
    const broken = 'prisma/migrations/29991231000000_broken/migration.sql';
    write(broken, 'THIS IS NOT SQL;\n');
    try {
      const dbDirsBefore = tempDbDirs();
      const result = await runner.run({
        projectId,
        runId,
        worktreeDir: fixtureDir,
        profile: 'next-prisma-sqlite',
        timeoutMs: JUDGE_TIMEOUT_MS,
      });
      expect(result.status).toBe('runner_error');
      expect(result.message).toContain('판정 서버 기동 실패 (migrate)');
      expect(result.server).toBeNull();
      expect(result.timings.build).toBeUndefined();
      await expectNoLeftovers(result, dbDirsBefore);
    } finally {
      rmSync(path.join(fixtureDir, path.dirname(broken)), { recursive: true, force: true });
    }
  }, 60_000);

  it('잘못된 입력은 판정 폴더를 만들기 전에 거부한다', async () => {
    const base = {
      projectId,
      runId,
      worktreeDir: fixtureDir,
      profile: 'next-prisma-sqlite',
      timeoutMs: 1_000,
    } as const;
    await expect(runner.run({ ...base, runId: '../escape' })).rejects.toThrow(TypeError);
    await expect(runner.run({ ...base, ruleIds: ['../RULE-001'] })).rejects.toThrow(TypeError);
    await expect(runner.run({ ...base, ruleIds: ['RULE-*'] })).rejects.toThrow(TypeError);
    await expect(runner.run({ ...base, ruleIds: [] })).rejects.toThrow(TypeError);
    await expect(runner.run({ ...base, worktreeDir: 'relative' })).rejects.toThrow(TypeError);
    await expect(runner.run({ ...base, timeoutMs: 0 })).rejects.toThrow(TypeError);
  });
});
