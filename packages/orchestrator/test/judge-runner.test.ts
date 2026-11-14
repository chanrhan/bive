// 판정 러너 (M1-24 수용 기준, JDG-01 · ADR-026 · ADR-051).
// scripts/reset-fixture.sh로 만든 픽스처 복사본 하나에서 여러 판정을 순서대로 돌린다(서버 빌드는 1회).
// 제한: afterAll 정리 120초(부하 평균 12 이상에서 픽스처 node_modules 삭제가 기본 10초를 넘었다), 남은 프로세스 확인은
// SIGKILL 뒤 3초까지 폴링, 임시 DB는 이 파일 전용 폴더에 만들어 같은 VM의 다른 판정 테스트와 섞지 않는다 (#122, ADR-064).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUlidGenerator } from '@bive/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  assertBuildPathBins,
  assertLockfilePathsInside,
  assertProjectPnpmConfig,
  assertRegistryBuiltDependencies,
  assertRegistryTestRunner,
  dependencyClosure,
  installDependencies,
  lockfileKeyName,
  overrideTargetNames,
  parseStrictYaml,
  pinnedPnpmConfigArgs,
  resolveJudgeStoreDir,
  shimTargets,
} from '../src/judge/checkout.js';
import {
  fingerprintChanges,
  judgeInputFingerprint,
  resolveRunnerEntry,
} from '../src/judge/fingerprint.js';
import { JudgeRunner, type JudgeRunResult } from '../src/judge/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RESET_FIXTURE = path.join(REPO_ROOT, 'scripts', 'reset-fixture.sh');

/** 판정 1회 제한 시간 (마이그레이션 + next build + next start + vitest). */
const JUDGE_TIMEOUT_MS = 180_000;
/** 서버를 띄우는 테스트의 vitest 제한 시간. */
const BUILD_TEST_TIMEOUT_MS = 240_000;
/** 픽스처 복사본(node_modules 포함) 삭제 제한 시간. 부하에서 기본 10초를 넘는다 (#122). */
const CLEANUP_TIMEOUT_MS = 120_000;

const newId = createUlidGenerator();
const projectId = newId();
const runId = newId();

let fixtureDir = '';
let biveHome = '';
/** 판정 임시 DB의 상위 폴더. 이 파일 전용이라 다른 worktree의 판정이 만든 폴더가 섞이지 않는다 */
let judgeTempDir = '';
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

const STRAY_ACC = "throw new Error('규칙 폴더 밖 파일이 실행됨');\n";

/** 임시 DB 폴더 목록 (프로필이 러너의 tempDir 아래에 만든다). */
const tempDbDirs = (): string[] =>
  readdirSync(judgeTempDir)
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

/**
 * 러너가 보낸 SIGKILL은 비동기라, 부하에서는 러너가 돌아온 직후에도 신호를 받은 하위 프로세스
 * (prisma의 schema-engine 등 같은 프로세스 그룹)가 잠깐 /proc에 보인다. 사라질 때까지 이만큼 기다린다 (#122).
 */
const LEFTOVER_GRACE_MS = 3_000;

/** 판정 뒤 서버 프로세스 · 임시 DB가 남지 않았음을 확인한다. */
const expectNoLeftovers = async (result: JudgeRunResult, dbDirsBefore: string[]) => {
  const deadline = Date.now() + LEFTOVER_GRACE_MS;
  while (processesIn(fixtureDir).length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
  judgeTempDir = mkdtempSync(path.join(os.tmpdir(), 'bive-judge-tmp-'));
  execFileSync('bash', [RESET_FIXTURE, fixtureDir], { stdio: 'pipe' });
  // 프로젝트 vitest 설정을 읽으면 바로 실패하게 만든다 (JDG-01: 프로젝트 테스트 설정 불사용)
  write(
    'vitest.config.ts',
    "throw new Error('프로젝트 vitest 설정이 로드됨');\nexport default {};\n",
  );
  write('bive-acceptance/RULE-001/health.acc.ts', HEALTH_ACC);
  // 규칙 폴더 밖 파일은 규칙에 매핑되지 않으므로 줍지 않는다 (줍히면 파일 로드 오류로 collect_error가 된다)
  write('bive-acceptance/stray.acc.ts', STRAY_ACC);
  runner = new JudgeRunner({ biveHome, tempDir: judgeTempDir });
}, 180_000);

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  if (biveHome) rmSync(biveHome, { recursive: true, force: true });
  if (judgeTempDir) rmSync(judgeTempDir, { recursive: true, force: true });
}, CLEANUP_TIMEOUT_MS);

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
      expect(config).toContain('"bive-acceptance/*/**/*.acc.ts"');
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
      expect(path.dirname(path.dirname(server.databasePath))).toBe(judgeTempDir);
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
        ['build', 'collect', 'generate', 'migrate', 'start', 'total', 'vitest'].sort(),
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
      // 판정 폴더 0700 · 바로 아래 파일(실행기가 만든 결과 JSON · 로그 포함) 0600 (ADR-051)
      expect(statSync(judgeDir).mode & 0o777).toBe(0o700);
      const modes = readdirSync(judgeDir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => [e.name, statSync(path.join(judgeDir, e.name)).mode & 0o777]);
      expect(modes.length).toBeGreaterThanOrEqual(10);
      expect(modes.filter(([, mode]) => mode !== 0o600)).toEqual([]);

      await expectNoLeftovers(result, dbDirsBefore);
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  it(
    'describe 안 beforeAll 훅 실패는 케이스 실패가 아니라 파일 이름과 원인을 담은 collect_error',
    async () => {
      write(
        'bive-acceptance/RULE-010/hook.acc.ts',
        `import { beforeAll, describe, expect, inject, it } from 'vitest';

describe('훅', () => {
  beforeAll(async () => {
    const res = await fetch(new URL('/api/items', inject('baseUrl')), { method: 'POST' });
    expect(res.status).toBe(201);
  });
  it('a', () => expect(1).toBe(1));
  it('b', () => expect(1).toBe(1));
});
`,
      );
      const dbDirsBefore = tempDbDirs();
      const result = await runner.run({
        projectId,
        runId,
        worktreeDir: fixtureDir,
        profile: 'next-prisma-sqlite',
        ruleIds: ['RULE-010'],
        timeoutMs: JUDGE_TIMEOUT_MS,
      });
      rmSync(path.join(fixtureDir, 'bive-acceptance', 'RULE-010'), {
        recursive: true,
        force: true,
      });

      expect(result.status).toBe('collect_error');
      expect(result.problems).toHaveLength(1);
      const problem = result.problems[0]!;
      expect(problem.file).toBe('bive-acceptance/RULE-010/hook.acc.ts');
      expect(problem.message).toMatch(
        /^스위트 훅 실패 등 파일 수준 오류 \(stderr\.log 참고\): AssertionError: expected \d+ to be 201/,
      );
      expect(result.message).toContain('bive-acceptance/RULE-010/hook.acc.ts: ');
      // 훅이 막아 실행되지 않은 케이스는 건너뜀으로 남는다 (실패 케이스와 섞지 않음)
      expect(result.cases.map((c) => [c.name, c.status])).toEqual([
        ['훅 > a', 'skipped'],
        ['훅 > b', 'skipped'],
      ]);
      expect(result.server).not.toBeNull();
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

    // 규칙 폴더 밖 파일만 남으면 0개 수집과 같다
    rmSync(path.join(fixtureDir, 'bive-acceptance'), { recursive: true, force: true });
    write('bive-acceptance/stray.acc.ts', STRAY_ACC);
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
    expect(readdirSync(path.join(biveHome, 'projects', projectId, 'judge', runId))).toHaveLength(5);
    write('bive-acceptance/RULE-001/health.acc.ts', HEALTH_ACC);
  });

  it('시간 초과는 runner_error이고 띄운 프로세스 · 임시 DB를 정리한다', async () => {
    // 앞 테스트의 빌드 캐시가 있으면 다시 빌드가 몇 초 만에 끝나므로 지우고 처음부터 빌드하게 한다
    rmSync(path.join(fixtureDir, '.next'), { recursive: true, force: true });
    const dbDirsBefore = tempDbDirs();
    const result = await runner.run({
      projectId,
      runId,
      worktreeDir: fixtureDir,
      profile: 'next-prisma-sqlite',
      // 새 빌드는 이 VM 약 18초 · CI 약 8초라 빌드 도중에 끊긴다 (느린 환경에서는 앞 단계에서 끊길 수 있다)
      timeoutMs: 3_000,
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

  it('임시 폴더 옵션(tempDir)은 절대 경로만 받는다', () => {
    expect(() => new JudgeRunner({ biveHome, tempDir: 'relative/tmp' })).toThrow(TypeError);
    expect(() => new JudgeRunner({ biveHome, tempDir: judgeTempDir })).not.toThrow();
  });

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

  it('중단 신호를 받으면 띄운 프로세스 · 임시 DB를 정리하고 runner_error(판정 중단)', async () => {
    // 빌드 캐시를 지워 빌드 도중에 중단되게 한다 (느린 환경에서는 앞 단계에서 중단될 수 있다)
    rmSync(path.join(fixtureDir, '.next'), { recursive: true, force: true });
    const dbDirsBefore = tempDbDirs();
    const result = await runner.run({
      projectId,
      runId,
      worktreeDir: fixtureDir,
      profile: 'next-prisma-sqlite',
      timeoutMs: JUDGE_TIMEOUT_MS,
      signal: AbortSignal.timeout(2_000),
    });
    expect(result.status).toBe('runner_error');
    expect(result.message).toMatch(/^판정 중단 \((collect|migrate|build|start|vitest) 단계\)$/);
    await expectNoLeftovers(result, dbDirsBefore);
  }, 30_000);

  it(
    '스냅숏을 새로 쓰지 않는다: 없는 스냅숏 단언은 실패하고 판정 환경에 파일을 만들지 않는다 (#29 재현)',
    async () => {
      write(
        'bive-acceptance/RULE-020/snap.acc.ts',
        `import { expect, it } from 'vitest';

it('파일 스냅숏', async () => {
  await expect('export const pwned = true;\\n').toMatchFileSnapshot('../../src/lib/pwned.ts');
});

it('스냅숏', () => {
  expect({ ok: true }).toMatchSnapshot();
});
`,
      );
      try {
        const result = await runner.run({
          projectId,
          runId,
          worktreeDir: fixtureDir,
          profile: 'next-prisma-sqlite',
          ruleIds: ['RULE-020'],
          timeoutMs: JUDGE_TIMEOUT_MS,
        });
        expect(result.status).toBe('completed');
        expect(result.cases.map((c) => [c.name, c.status])).toEqual([
          ['파일 스냅숏', 'failed'],
          ['스냅숏', 'failed'],
        ]);
        expect(existsSync(path.join(fixtureDir, 'src', 'lib', 'pwned.ts'))).toBe(false);
        expect(
          existsSync(path.join(fixtureDir, 'bive-acceptance', 'RULE-020', '__snapshots__')),
        ).toBe(false);
        // 생성 설정에 스냅숏 갱신 금지가 들어 있다
        expect(readFileSync(result.paths.config, 'utf8')).toContain('"update": "none"');
      } finally {
        rmSync(path.join(fixtureDir, 'bive-acceptance', 'RULE-020'), {
          recursive: true,
          force: true,
        });
        rmSync(path.join(fixtureDir, 'src', 'lib', 'pwned.ts'), { force: true });
      }
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  it(
    '빌드 중 에이전트 코드(next.config.ts)가 인수 테스트를 바꾸면 vitest를 돌리기 전에 잡아 runner_error(판정 입력 변조)',
    async () => {
      const config = path.join(fixtureDir, 'next.config.ts');
      const original = readFileSync(config, 'utf8');
      write(
        'bive-acceptance/RULE-030/t.acc.ts',
        "import { expect, it } from 'vitest';\n\nit('실패해야 하는 케이스', () => {\n  expect(1).toBe(2);\n});\n",
      );
      // 검토 1회차 재현: 빌드 · 기동 때 실행되는 설정 파일이 인수 테스트를 통과하는 내용으로 바꾼다
      writeFileSync(
        config,
        `import { writeFileSync } from 'node:fs';\n` +
          `writeFileSync('bive-acceptance/RULE-030/t.acc.ts', "import { it } from 'vitest';\\nit('실패해야 하는 케이스', () => {});\\n");\n` +
          original,
      );
      try {
        const result = await runner.run({
          projectId,
          runId,
          worktreeDir: fixtureDir,
          profile: 'next-prisma-sqlite',
          ruleIds: ['RULE-030'],
          timeoutMs: JUDGE_TIMEOUT_MS,
        });
        expect(result.status).toBe('runner_error');
        expect(result.tampered).toEqual({
          moment: 'before_vitest',
          changed: ['bive-acceptance/RULE-030/t.acc.ts'],
        });
        expect(result.cases).toEqual([]);
        expect(result.message).toContain('판정 입력이 바뀌었습니다');
      } finally {
        writeFileSync(config, original);
        rmSync(path.join(fixtureDir, 'bive-acceptance', 'RULE-030'), {
          recursive: true,
          force: true,
        });
      }
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  it(
    '빌드 중 에이전트 코드가 vitest 패키지 안 node_modules에 의존성 사본을 심으면 vitest 전에 잡는다 (검토 2회차)',
    async () => {
      const config = path.join(fixtureDir, 'next.config.ts');
      const original = readFileSync(config, 'utf8');
      const vitestDir = realpathSync(path.join(fixtureDir, 'node_modules', 'vitest'));
      const planted = path.join(vitestDir, 'node_modules', 'std-env');
      write(
        'bive-acceptance/RULE-031/t.acc.ts',
        "import { expect, it } from 'vitest';\n\nit('실패해야 하는 케이스', () => {\n  expect(1).toBe(2);\n});\n",
      );
      // 검토 2회차 재현: Node가 형제 링크보다 먼저 찾는 자리에 사본을 심는다. 새 파일만 복사로 만든다
      // (하드 링크된 기존 파일은 고치지 않는다: 전역 pnpm 저장소를 건드리지 않게)
      const source = realpathSync(path.join(path.dirname(vitestDir), 'std-env'));
      writeFileSync(
        config,
        `import { cpSync } from 'node:fs';\n` +
          `cpSync(${JSON.stringify(source)}, ${JSON.stringify(planted)}, { recursive: true, dereference: true });\n` +
          original,
      );
      try {
        const result = await runner.run({
          projectId,
          runId,
          worktreeDir: fixtureDir,
          profile: 'next-prisma-sqlite',
          ruleIds: ['RULE-031'],
          timeoutMs: JUDGE_TIMEOUT_MS,
        });
        expect(result.status).toBe('runner_error');
        expect(result.tampered?.moment).toBe('before_vitest');
        expect(result.tampered?.changed.length).toBeGreaterThan(0);
        expect(
          result.tampered?.changed.every((key) => key.startsWith('runner:vitest@')) &&
            result.tampered.changed.some((key) => key.includes('/node_modules/std-env/')),
        ).toBe(true);
        expect(result.cases).toEqual([]);
      } finally {
        writeFileSync(config, original);
        // 심은 사본만 지운다 (원래 없던 빈 node_modules 폴더도)
        rmSync(planted, { recursive: true, force: true });
        try {
          rmdirSync(path.join(vitestDir, 'node_modules'));
        } catch {
          // 원래 있던 폴더거나 비어 있지 않다
        }
        rmSync(path.join(fixtureDir, 'bive-acceptance', 'RULE-031'), {
          recursive: true,
          force: true,
        });
      }
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  it(
    '빌드 중 에이전트 코드가 node_modules/.bin/node 래퍼를 심어도 vitest는 그 래퍼로 실행되지 않는다 (pnpm 셸 shim 우회, #146)',
    async () => {
      const config = path.join(fixtureDir, 'next.config.ts');
      const original = readFileSync(config, 'utf8');
      const planted = path.join(fixtureDir, 'node_modules', '.bin', 'node');
      const marker = path.join(fixtureDir, 'PWNED_BIN_NODE');
      expect(existsSync(planted)).toBe(false);
      write(
        'bive-acceptance/RULE-032/t.acc.ts',
        "import { expect, it } from 'vitest';\n\nit('실패해야 하는 케이스', () => {\n  expect(1).toBe(2);\n});\n",
      );
      // 3차 검토 재현: pnpm 셸 shim은 `[ -x "$basedir/node" ]`이면 그 파일로 실행한다. 래퍼는 vitest로 불릴 때만 표시를 남기고
      // 진짜 node로 넘긴다(실제 공격은 결과 파일을 바꾼다). 새 파일만 만든다(전역 저장소 · 기존 파일은 건드리지 않음)
      const wrapper =
        '#!/bin/sh\n' +
        `case "$*" in *vitest*) : > ${JSON.stringify(marker)} ;; esac\n` +
        `exec ${JSON.stringify(process.execPath)} "$@"\n`;
      writeFileSync(
        config,
        `import { writeFileSync } from 'node:fs';\n` +
          `writeFileSync(${JSON.stringify(planted)}, ${JSON.stringify(wrapper)}, { mode: 0o755 });\n` +
          original,
      );
      try {
        const result = await runner.run({
          projectId,
          runId,
          worktreeDir: fixtureDir,
          profile: 'next-prisma-sqlite',
          ruleIds: ['RULE-032'],
          timeoutMs: JUDGE_TIMEOUT_MS,
        });
        // 래퍼는 빌드 중에 심겼다
        expect(existsSync(planted)).toBe(true);
        // vitest(수집 · 실행)는 shim을 거치지 않고 오케스트레이터의 node로 vitest 진입 파일을 직접 실행한다
        expect(existsSync(marker)).toBe(false);
        expect(result.tampered).toBeNull();
        expect(result.status).toBe('completed');
        expect(result.cases.map((c) => [c.name, c.status])).toEqual([
          ['실패해야 하는 케이스', 'failed'],
        ]);
        const vitestEntry = path.join(
          realpathSync(path.join(fixtureDir, 'node_modules', 'vitest')),
          'vitest.mjs',
        );
        expect(readFileSync(result.paths.stdout, 'utf8')).toContain(
          `$ ${process.execPath} ${vitestEntry} run --config ${result.paths.config}`,
        );
      } finally {
        writeFileSync(config, original);
        rmSync(planted, { force: true });
        rmSync(marker, { force: true });
        rmSync(path.join(fixtureDir, 'bive-acceptance', 'RULE-032'), {
          recursive: true,
          force: true,
        });
      }
    },
    BUILD_TEST_TIMEOUT_MS,
  );
});

/** 픽스처의 추적 파일만 `<dir>/app`에 복사한다 (설치 없음). */
const copyFixtureFiles = (dir: string): string => {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'fixtures/sample-next-app'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file !== '');
  for (const file of files) {
    const target = path.join(dir, 'app', path.relative('fixtures/sample-next-app', file));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(path.join(REPO_ROOT, file)));
  }
  return path.join(dir, 'app');
};

describe('판정 체크아웃 의존성 설치 (검토 1회차)', () => {
  it(
    '프로젝트의 설치 수명 주기 스크립트(postinstall · prepare)는 실행하지 않고, 허용된 의존성의 빌드 스크립트만 돌린다',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-install-fx-'));
      // 픽스처의 추적 파일만 복사한다 (설치 없음)
      const files = execFileSync('git', ['ls-files', '-z', '--', 'fixtures/sample-next-app'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
        .split('\0')
        .filter((file) => file !== '');
      for (const file of files) {
        const target = path.join(dir, 'app', path.relative('fixtures/sample-next-app', file));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(path.join(REPO_ROOT, file)));
      }
      const app = path.join(dir, 'app');
      try {
        const pkg = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8')) as {
          scripts: Record<string, string>;
        };
        pkg.scripts.postinstall =
          "node -e \"require('fs').writeFileSync('PWNED_POSTINSTALL', '')\"";
        pkg.scripts.prepare = "node -e \"require('fs').writeFileSync('PWNED_PREPARE', '')\"";
        writeFileSync(path.join(app, 'package.json'), JSON.stringify(pkg, null, 2));
        await installDependencies(app, {
          logFile: path.join(dir, 'install.log'),
          timeoutMs: JUDGE_TIMEOUT_MS,
        });
        expect(existsSync(path.join(app, 'PWNED_POSTINSTALL'))).toBe(false);
        expect(existsSync(path.join(app, 'PWNED_PREPARE'))).toBe(false);
        // 허용 목록(pnpm-workspace.yaml onlyBuiltDependencies)의 의존성 빌드는 돈다 (better-sqlite3 네이티브 모듈)
        const native = execFileSync(
          'find',
          [path.join(app, 'node_modules', '.pnpm'), '-name', 'better_sqlite3.node'],
          { encoding: 'utf8' },
        );
        expect(native.trim()).not.toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  it(
    '프로젝트의 .pnpmfile.cjs는 실행되지 않고(lockfile 체크섬을 맞춰도 설치 실패로 닫힘), 의존성은 전역 저장소와 하드 링크하지 않고 복사한다 (검토 2회차)',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-pnpmfile-fx-'));
      const app = copyFixtureFiles(dir);
      const marker = path.join(app, 'PWNED_PNPMFILE');
      try {
        // 실제 공격은 저장소의 vitest 파일을 바꾼다. 시험은 전역 저장소를 건드리지 않게 표시 파일만 남긴다
        writeFileSync(
          path.join(app, '.pnpmfile.cjs'),
          "require('fs').writeFileSync(__dirname + '/PWNED_PNPMFILE', '');\nmodule.exports = { hooks: {} };\n",
        );
        // ① lockfile에 체크섬이 없을 때: 설치는 되고 pnpmfile은 돌지 않는다
        await installDependencies(app, {
          logFile: path.join(dir, 'install.log'),
          timeoutMs: JUDGE_TIMEOUT_MS,
        });
        expect(existsSync(marker)).toBe(false);
        const vitestPkg = path.join(
          realpathSync(path.join(app, 'node_modules', 'vitest')),
          'package.json',
        );
        expect(statSync(vitestPkg).nlink).toBe(1);
        expect(
          execFileSync(
            'find',
            [path.join(app, 'node_modules', '.pnpm'), '-name', 'better_sqlite3.node'],
            {
              encoding: 'utf8',
            },
          ).trim(),
        ).not.toBe('');

        // ② 에이전트가 lockfile의 pnpmfileChecksum을 맞춰 둔 경우: frozen 설치가 거부되어 설치 실패(판정하지 않음)
        rmSync(path.join(app, 'node_modules'), { recursive: true, force: true });
        execFileSync(
          'pnpm',
          ['install', '--lockfile-only', '--prefer-offline', '--ignore-scripts'],
          {
            cwd: app,
            stdio: 'pipe',
            env: { ...process.env, CI: '1' },
          },
        );
        rmSync(marker, { force: true });
        expect(readFileSync(path.join(app, 'pnpm-lock.yaml'), 'utf8')).toContain(
          'pnpmfileChecksum',
        );
        await expect(
          installDependencies(app, {
            logFile: path.join(dir, 'install2.log'),
            timeoutMs: JUDGE_TIMEOUT_MS,
          }),
        ).rejects.toThrow(/의존성 설치 실패/);
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  it(
    '빌드 허용 목록의 file: 의존성은 lockfile 해상도가 레지스트리가 아니라 거부하고 설치 실패로 닫는다: 그 postinstall은 돌지 않는다 (#146 재현)',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-filedep-fx-'));
      const app = copyFixtureFiles(dir);
      const marker = path.join(app, 'PWNED_FILE_DEP');
      try {
        // 3차 검토 재현: 구현 역할이 커밋할 수 있는 파일만 고친다 (package.json · pnpm-workspace.yaml · lockfile · 새 폴더)
        mkdirSync(path.join(app, 'evil'));
        writeFileSync(
          path.join(app, 'evil', 'package.json'),
          JSON.stringify({
            name: 'evil',
            version: '1.0.0',
            scripts: {
              postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(marker).replaceAll('"', '\\"')}, '')"`,
            },
          }),
        );
        const pkg = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8')) as {
          dependencies: Record<string, string>;
        };
        pkg.dependencies.evil = 'file:./evil';
        writeFileSync(path.join(app, 'package.json'), JSON.stringify(pkg, null, 2));
        const workspace = path.join(app, 'pnpm-workspace.yaml');
        writeFileSync(
          workspace,
          readFileSync(workspace, 'utf8').replace(
            'onlyBuiltDependencies:\n',
            'onlyBuiltDependencies:\n  - evil\n',
          ),
        );
        execFileSync(
          'pnpm',
          ['install', '--lockfile-only', '--prefer-offline', '--ignore-scripts'],
          { cwd: app, stdio: 'pipe', env: { ...process.env, CI: '1' } },
        );
        expect(readFileSync(path.join(app, 'pnpm-lock.yaml'), 'utf8')).toContain(
          'evil@file:evil:\n    resolution: {directory: evil, type: directory}',
        );
        await expect(
          installDependencies(app, {
            logFile: path.join(dir, 'install.log'),
            timeoutMs: JUDGE_TIMEOUT_MS,
          }),
        ).rejects.toThrow(/빌드 허용 목록.*evil.*레지스트리/);
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    BUILD_TEST_TIMEOUT_MS,
  );
});

describe('빌드 허용 목록의 lockfile 해상도 검사 (#146)', () => {
  const INTEGRITY = 'sha512-' + 'A'.repeat(86) + '==';
  /** 픽스처 모양의 최소 lockfile (pnpm 10.28 · lockfileVersion 9.0 실측 형식). */
  const lockfile = (packages: string, importers = '', extra = '', snapshots = ''): string =>
    [
      "lockfileVersion: '9.0'",
      '',
      'settings:',
      '  autoInstallPeers: true',
      '  excludeLinksFromLockfile: false',
      extra,
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      is-number:',
      '        specifier: 7.0.0',
      '        version: 7.0.0',
      importers,
      '',
      'packages:',
      '',
      '  is-number@7.0.0:',
      `    resolution: {integrity: ${INTEGRITY}}`,
      "    engines: {node: '>=0.12.0'}",
      '',
      packages,
      '',
      'snapshots:',
      '',
      '  is-number@7.0.0: {}',
      '',
      snapshots,
      '',
    ].join('\n');
  const check = (names: string[], lock: string, files: Record<string, string> = {}): void => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-lockcheck-'));
    try {
      writeFileSync(path.join(dir, 'pnpm-lock.yaml'), lock);
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), body);
      }
      assertRegistryBuiltDependencies(dir, names);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('레지스트리 해상도(integrity만)인 이름은 통과한다 (여러 버전 · 범위 이름 포함)', () => {
    expect(() =>
      check(
        ['is-number', '@scope/native'],
        lockfile(
          [
            '  is-number@6.0.0:',
            `    resolution: {integrity: ${INTEGRITY}}`,
            '',
            "  '@scope/native@1.2.3-beta.1':",
            `    resolution: {integrity: ${INTEGRITY}}`,
            '    hasBin: true',
          ].join('\n'),
          '',
          '',
          [
            '  is-number@6.0.0: {}',
            '',
            "  '@scope/native@1.2.3-beta.1(is-number@6.0.0)':",
            '    dependencies:',
            '      is-number: 6.0.0',
          ].join('\n'),
        ),
      ),
    ).not.toThrow();
    expect(() => check([], lockfile(''))).not.toThrow();
  });

  it.each([
    ['디렉터리(file:)', 'evil@file:evil', '{directory: evil, type: directory}'],
    [
      '로컬 tarball(file:)',
      'evil@file:evil.tgz',
      `{integrity: ${INTEGRITY}, tarball: file:evil.tgz}`,
    ],
    [
      '원격 tarball URL',
      'evil@https://example.com/evil-1.0.0.tgz',
      `{integrity: ${INTEGRITY}, tarball: https://example.com/evil-1.0.0.tgz}`,
    ],
    [
      'git',
      'evil@https://codeload.github.com/o/evil/tar.gz/0123456789abcdef0123456789abcdef01234567',
      '{tarball: https://codeload.github.com/o/evil/tar.gz/0123456789abcdef0123456789abcdef01234567}',
    ],
    [
      'git 저장소',
      'evil@git+https://example.com/o/evil.git#0123456789abcdef0123456789abcdef01234567',
      '{commit: 0123456789abcdef0123456789abcdef01234567, repo: https://example.com/o/evil.git, type: git}',
    ],
  ])('%s 해상도는 거부한다', (_kind, key, resolution) => {
    expect(() =>
      check(['evil'], lockfile(`  '${key}':\n    resolution: ${resolution}\n    version: 1.0.0`)),
    ).toThrow(/빌드 허용 목록.*evil.*레지스트리/);
  });

  it('같은 이름의 여러 버전 중 하나라도 레지스트리가 아니면 거부한다', () => {
    expect(() =>
      check(
        ['evil'],
        lockfile(
          [
            '  evil@1.0.0:',
            `    resolution: {integrity: ${INTEGRITY}}`,
            '',
            '  evil@file:evil:',
            '    resolution: {directory: evil, type: directory}',
          ].join('\n'),
        ),
      ),
    ).toThrow(/evil/);
  });

  it('link: · 작업 공간 패키지(importers의 link: 버전) · lockfile에 없는 이름 · 프로젝트 자신의 이름은 거부한다', () => {
    const linked = [
      '      evil:',
      '        specifier: link:./evil',
      '        version: link:evil',
    ].join('\n');
    expect(() => check(['evil'], lockfile('', linked))).toThrow(/evil/);
    const workspace = [
      '      ws:',
      '        specifier: workspace:*',
      '        version: link:packages/ws',
    ].join('\n');
    expect(() => check(['ws'], lockfile('', workspace))).toThrow(/ws/);
    expect(() => check(['missing'], lockfile(''))).toThrow(/missing.*lockfile에 없/);
    // 레지스트리 항목이 있어도 같은 이름의 작업 공간 프로젝트(importer)가 있으면 거부한다
    expect(() =>
      check(['is-number'], lockfile('', '\n  packages/inner:\n    dependencies: {}'), {
        'packages/inner/package.json': JSON.stringify({ name: 'is-number' }),
      }),
    ).toThrow(/is-number/);
    expect(() =>
      check(['is-number'], lockfile(''), {
        'package.json': JSON.stringify({ name: 'is-number' }),
      }),
    ).toThrow(/is-number/);
  });

  it('패치(patchedDependencies)가 걸린 이름 · 지원하지 않는 lockfile 버전 · 읽을 수 없는 lockfile은 거부한다', () => {
    const patched = [
      'patchedDependencies:',
      '  is-number@7.0.0:',
      '    hash: 2fbc726474bf6ab1a62986ac3168f21e34fda08bd690b0e33e570e81a613aa3a',
      '    path: patches/is-number@7.0.0.patch',
      '',
    ].join('\n');
    expect(() => check(['is-number'], lockfile('', '', patched))).toThrow(/is-number.*패치/);
    expect(() =>
      check(
        ['is-number'],
        lockfile('').replace("lockfileVersion: '9.0'", "lockfileVersion: '6.0'"),
      ),
    ).toThrow(/lockfile/);
    expect(() => check(['is-number'], ': [\n')).toThrow(/lockfile/);
  });
});

describe('빌드 허용 목록 · 판정 실행기의 의존성 닫힘 검사 (#146 검토 1회차)', () => {
  const INTEGRITY = 'sha512-' + 'B'.repeat(86) + '==';
  const registry = (key: string): string =>
    `  '${key}':\n    resolution: {integrity: ${INTEGRITY}}\n`;
  /**
   * 최소 lockfile (pnpm 10.28 · 9.0 실측 형식). 루트가 vitest(의존성 tinyrainbow, 피어 vite)와 native(빌드 허용,
   * 의존성 helper)를 선언한다. 일부를 바꿔 위반을 만든다.
   */
  const base = {
    extra: '',
    rootDeps: ['      native:', '        specifier: 1.0.0', '        version: 1.0.0'],
    rootDevDeps: [
      '      vitest:',
      '        specifier: 5.0.5',
      '        version: 5.0.5(vite@8.3.4)',
    ],
    packages: [
      registry('native@1.0.0'),
      registry('helper@2.0.0'),
      registry('vitest@5.0.5'),
      registry('tinyrainbow@3.0.0'),
      registry('vite@8.3.4'),
    ],
    snapshots: [
      '  native@1.0.0:\n    dependencies:\n      helper: 2.0.0\n',
      '  helper@2.0.0: {}\n',
      "  'vitest@5.0.5(vite@8.3.4)':\n    dependencies:\n      tinyrainbow: 3.0.0\n      vite: 8.3.4\n",
      '  tinyrainbow@3.0.0: {}\n',
      '  vite@8.3.4: {}\n',
    ],
  };
  type Lock = typeof base;
  const render = (lock: Lock): string =>
    [
      "lockfileVersion: '9.0'",
      '',
      'settings:',
      '  autoInstallPeers: true',
      '  excludeLinksFromLockfile: false',
      '',
      lock.extra,
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      ...lock.rootDeps,
      '    devDependencies:',
      ...lock.rootDevDeps,
      '',
      'packages:',
      '',
      ...lock.packages,
      'snapshots:',
      '',
      ...lock.snapshots,
    ].join('\n');
  /** 판정 설치와 같은 함수(`installDependencies`)로 검사한다. 검사가 거부하면 pnpm을 띄우기 전에 던진다 */
  const installText = async (
    text: string,
    workspace = 'onlyBuiltDependencies:\n  - native\n',
    files: Record<string, string> = {},
  ): Promise<void> => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-closure-'));
    try {
      writeFileSync(path.join(dir, 'pnpm-lock.yaml'), text);
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
      writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), `packages: []\n${workspace}`);
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), body);
      }
      await installDependencies(dir, { logFile: path.join(dir, 'install.log'), timeoutMs: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const install = (
    lock: Lock,
    workspace?: string,
    files: Record<string, string> = {},
  ): Promise<void> => installText(render(lock), workspace, files);
  const check = (lock: Lock, names: string[] = ['native']): void => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-closure-'));
    try {
      writeFileSync(path.join(dir, 'pnpm-lock.yaml'), render(lock));
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
      assertRegistryBuiltDependencies(dir, names);
      assertRegistryTestRunner(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const replace = (list: string[], from: string, to: string): string[] =>
    list.map((item) => item.replace(from, to));
  const PATCH_HASH = '0'.repeat(64);

  it('정상 lockfile(레지스트리 닫힘)은 통과한다', () => {
    expect(() => check(base)).not.toThrow();
  });

  it('installDependencies는 install과 rebuild 둘 다에 고정 인자(pinnedPnpmConfigArgs 전부)와 스크립트 · pnpmfile 차단 인자를 넘긴다 (#162 검토 1회차)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-fakepnpm-'));
    try {
      // PATH 앞의 가짜 pnpm: 받은 인자를 기록하고, `store path`에는 경로만 출력하며, install은 가상 저장소 폴더만 만든다
      const bin = path.join(dir, 'bin');
      const log = path.join(dir, 'pnpm-args.log');
      const fakeStore = path.join(dir, 'fake-store', 'v10');
      mkdirSync(bin);
      writeFileSync(
        path.join(bin, 'pnpm'),
        [
          '#!/bin/sh',
          `for a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done`,
          `printf '%s\\n' '--END--' >> '${log}'`,
          `if [ "$1" = store ]; then printf '%s\\n' '${fakeStore}'; exit 0; fi`,
          'if [ "$1" = install ]; then mkdir -p node_modules/.pnpm; fi',
          'exit 0',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      const app = path.join(dir, 'app');
      mkdirSync(app);
      writeFileSync(path.join(app, 'pnpm-lock.yaml'), render(base));
      writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }));
      writeFileSync(
        path.join(app, 'pnpm-workspace.yaml'),
        'packages: []\nonlyBuiltDependencies:\n  - native\n',
      );
      await installDependencies(app, {
        logFile: path.join(dir, 'install.log'),
        timeoutMs: 60_000,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
      });
      const calls = readFileSync(log, 'utf8')
        .split('--END--\n')
        .filter((call) => call !== '')
        .map((call) => call.split('\n').filter((arg) => arg !== ''));
      const install = calls.find((call) => call[0] === 'install');
      const rebuild = calls.find((call) => call[0] === 'rebuild');
      expect(calls.map((call) => call[0])).toEqual(['store', 'install', 'rebuild']);
      const pinned = pinnedPnpmConfigArgs(fakeStore);
      expect(pinned).toHaveLength(12);
      expect(install).toEqual(
        expect.arrayContaining([
          ...pinned,
          '--frozen-lockfile',
          '--ignore-scripts',
          '--ignore-pnpmfile',
          '--package-import-method=copy',
        ]),
      );
      expect(rebuild).toEqual(expect.arrayContaining([...pinned, '--config.ignore-pnpmfile=true']));
      expect(rebuild?.at(-1)).toBe('native');
      // 고정 인자의 각 `--config.<키>`는 install · rebuild에 정확히 한 번씩만 나온다 (뒤에 다른 값으로 덧붙는 회귀를 잡는다,
      // 검토 2회차)
      for (const arg of pinned) {
        const key = arg.slice(0, arg.indexOf('=') + 1);
        for (const [what, call] of [
          ['install', install],
          ['rebuild', rebuild],
        ] as const) {
          expect(
            call?.filter((item) => item.startsWith(key)),
            `${what} ${key}`,
          ).toEqual([arg]);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('허용 이름의 의존성이 overrides로 file: 디렉터리면 거부한다 (검토 재현 모양)', async () => {
    const lock: Lock = {
      ...base,
      extra: 'overrides:\n  helper: file:./evil\n',
      packages: [
        ...base.packages,
        '  helper@file:evil:\n    resolution: {directory: evil, type: directory}\n',
      ],
      snapshots: [
        ...replace(base.snapshots, 'helper: 2.0.0', 'helper: file:evil'),
        '  helper@file:evil: {}\n',
      ],
    };
    await expect(install(lock)).rejects.toThrow(
      /빌드 허용 목록의 패키지 native.*helper: file:evil/,
    );
  });

  it('허용 이름의 의존성이 패치(patchedDependencies) · overrides(레지스트리 값이라도) 대상이면 거부한다', async () => {
    const patched: Lock = {
      ...base,
      extra: `patchedDependencies:\n  helper@2.0.0:\n    hash: ${PATCH_HASH}\n    path: patches/helper@2.0.0.patch\n`,
    };
    await expect(install(patched)).rejects.toThrow(/native.*helper: 패치/);
    const overridden: Lock = { ...base, extra: "overrides:\n  'native>helper': 2.0.0\n" };
    await expect(install(overridden)).rejects.toThrow(/native.*helper: overrides/);
  });

  it('vitest가 패치됐거나 file:이거나 그 의존성이 overrides로 file:이면 빌드 허용 목록이 비어 있어도 판정 설치를 거부한다', async () => {
    const none = '';
    const patched: Lock = {
      ...base,
      extra: `patchedDependencies:\n  vitest@5.0.5:\n    hash: ${PATCH_HASH}\n    path: patches/vitest@5.0.5.patch\n`,
    };
    await expect(install(patched, none)).rejects.toThrow(/판정 실행기 vitest.*vitest: 패치/);
    const fileVitest: Lock = {
      ...base,
      rootDevDeps: replace(base.rootDevDeps, 'version: 5.0.5(vite@8.3.4)', 'version: file:x'),
      packages: [
        ...base.packages,
        '  vitest@file:x:\n    resolution: {directory: x, type: directory}\n',
      ],
    };
    await expect(install(fileVitest, none)).rejects.toThrow(/판정 실행기 vitest.*file:x/);
    const overridden: Lock = {
      ...base,
      extra: "overrides:\n  'tinyrainbow@>=1': file:./evil\n",
      packages: [
        ...base.packages,
        '  tinyrainbow@file:evil:\n    resolution: {directory: evil, type: directory}\n',
      ],
      snapshots: [
        ...replace(base.snapshots, 'tinyrainbow: 3.0.0', 'tinyrainbow: file:evil'),
        '  tinyrainbow@file:evil: {}\n',
      ],
    };
    await expect(install(overridden, none)).rejects.toThrow(
      /판정 실행기 vitest.*tinyrainbow: file:evil/,
    );
    // 루트가 vitest를 선언하지 않으면 판정할 수 없다
    await expect(install({ ...base, rootDevDeps: [] }, none)).rejects.toThrow(/vitest.*없습니다/);
  });

  it('닫힘 밖 패키지의 file: · 패치는 막지 않는다', () => {
    const lock: Lock = {
      ...base,
      extra: `patchedDependencies:\n  other@1.0.0:\n    hash: ${PATCH_HASH}\n    path: patches/other@1.0.0.patch\n`,
      rootDeps: [
        ...base.rootDeps,
        '      other:',
        '        specifier: 1.0.0',
        '        version: 1.0.0',
        '      local:',
        '        specifier: file:./local',
        '        version: file:local',
      ],
      packages: [
        ...base.packages,
        registry('other@1.0.0'),
        '  local@file:local:\n    resolution: {directory: local, type: directory}\n',
      ],
      snapshots: [...base.snapshots, '  other@1.0.0: {}\n', '  local@file:local: {}\n'],
    };
    // 빌드 허용 목록이 없으면 루트의 bin 검사도 하지 않는다
    expect(() => check(lock, [])).not.toThrow();
  });

  it('빌드 허용 목록이 있으면 루트의 레지스트리가 아닌 직접 의존성 중 bin을 내는 것을 거부한다 (빌드 스크립트 PATH)', async () => {
    const lock: Lock = {
      ...base,
      rootDeps: [
        ...base.rootDeps,
        '      tool:',
        '        specifier: file:./tool',
        '        version: file:tool',
      ],
      packages: [
        ...base.packages,
        '  tool@file:tool:\n    resolution: {directory: tool, type: directory}\n',
      ],
      snapshots: [...base.snapshots, '  tool@file:tool: {}\n'],
    };
    await expect(
      install(lock, undefined, {
        'tool/package.json': JSON.stringify({ name: 'tool', bin: { 'node-gyp': 'gyp.js' } }),
      }),
    ).rejects.toThrow(/bin.*tool/);
    expect(() => check(lock, [])).not.toThrow();
  });

  it('닫힘 걷기: 피어 접미 · 범위 이름 · 순환 · 여러 버전 · 레지스트리가 아닌 참조 · 없는 키', () => {
    const snapshots = {
      'a@1.0.0(b@2.0.0)': { dependencies: { b: '2.0.0', '@s/c': '3.0.0(b@2.0.0)' } },
      'b@2.0.0': { dependencies: { a: '1.0.0(b@2.0.0)' } },
      '@s/c@3.0.0(b@2.0.0)': { optionalDependencies: { d: 'file:d', e: 'other@1.0.0' } },
      'a@1.1.0': { dependencies: { gone: '9.9.9' } },
    };
    expect(dependencyClosure(snapshots, ['a@1.0.0(b@2.0.0)', 'a@1.1.0'])).toEqual({
      keys: ['@s/c@3.0.0(b@2.0.0)', 'a@1.0.0(b@2.0.0)', 'a@1.1.0', 'b@2.0.0', 'gone@9.9.9'],
      problems: [
        '@s/c@3.0.0(b@2.0.0) → d: file:d',
        '@s/c@3.0.0(b@2.0.0) → e: other@1.0.0',
        'gone@9.9.9: snapshots에 없음',
      ],
    });
    expect(lockfileKeyName('@s/c@3.0.0(b@2.0.0)')).toBe('@s/c');
    expect(lockfileKeyName('vitest@5.0.5(@types/node@22.20.5)')).toBe('vitest');
    expect(lockfileKeyName('nope')).toBeNull();
  });

  it('overrides 키에서 이름 뽑기 (실측 형식 name · name@범위 · @scope/name@범위 · parent>name, 애매하면 넓게)', () => {
    expect(overrideTargetNames('prebuild-install')).toEqual(['prebuild-install']);
    expect(overrideTargetNames('is-number@<8')).toEqual(['is-number']);
    expect(overrideTargetNames('@types/node@>=1')).toEqual(['@types/node']);
    expect(overrideTargetNames('better-sqlite3>bindings')).toEqual(['bindings']);
    expect(overrideTargetNames('better-sqlite3@12>@s/x@<2')).toEqual(['@s/x', 'better-sqlite3']);
    expect(overrideTargetNames('is-number@>7')).toEqual(['7', 'is-number']);
    expect(overrideTargetNames('>>')).toEqual([]);
  });

  it('lockfile의 YAML 병합 키(<<)로 snapshot · importer 의존성을 숨기면 거부한다 (pnpm은 병합해 읽는다, #146 검토 2회차)', async () => {
    // 검토 재현 모양: native snapshot의 의존성을 `<<` 아래에 둔다
    const snapshotMerge: Lock = {
      ...base,
      packages: [
        ...base.packages,
        '  helper@file:evil:\n    resolution: {directory: evil, type: directory}\n',
      ],
      snapshots: replace(
        base.snapshots,
        '  native@1.0.0:\n    dependencies:\n      helper: 2.0.0\n',
        '  native@1.0.0:\n    <<:\n      dependencies:\n        helper: file:evil\n',
      ),
    };
    await expect(install(snapshotMerge)).rejects.toThrow(/YAML.*<</);
    // 루트 importer의 의존성을 `<<` 아래에 숨긴다 (PATH 규칙을 피하려는 모양)
    const importerMerge = render(base).replace(
      '  .:\n    dependencies:\n',
      '  .:\n    <<:\n      dependencies:\n        tool:\n          specifier: file:./tool\n          version: file:tool\n    dependencies:\n',
    );
    await expect(installText(importerMerge)).rejects.toThrow(/YAML.*<</);
  });

  it('lockfile · pnpm-workspace.yaml의 앵커 · 별칭 · 명시 태그 · 중복 키 · 여러 문서는 거부한다', async () => {
    const text = render(base);
    await expect(
      installText(text.replace('  helper@2.0.0: {}\n', '  helper@2.0.0: &h {}\n')),
    ).rejects.toThrow(/YAML.*앵커/);
    await expect(
      installText(
        text.replace(
          "  'vitest@5.0.5(vite@8.3.4)':\n    dependencies:\n      tinyrainbow: 3.0.0\n",
          "  'vitest@5.0.5(vite@8.3.4)':\n    dependencies: &d\n      tinyrainbow: 3.0.0\n",
        ) + '  extra@1.0.0: *d\n',
      ),
    ).rejects.toThrow(/YAML/);
    await expect(
      installText(text.replace('  helper@2.0.0: {}\n', '  helper@2.0.0: !!map {}\n')),
    ).rejects.toThrow(/YAML.*태그/);
    await expect(
      installText(text.replace('  helper@2.0.0: {}\n', '  helper@2.0.0: {}\n  helper@2.0.0: {}\n')),
    ).rejects.toThrow(/YAML/);
    await expect(installText(`${text}\n---\na: 1\n`)).rejects.toThrow(/YAML/);
    // pnpm-workspace.yaml도 같은 파서로 읽는다: 별칭으로 빌드 허용 목록을 만들면 거부
    await expect(
      installText(text, 'names: &n\n  - native\nonlyBuiltDependencies: *n\n'),
    ).rejects.toThrow(/pnpm-workspace.yaml.*YAML/);
    // 정상 모양은 검사를 지나 설치 단계로 간다 (제한 시간 1ms로 끝남)
    await expect(installText(text)).rejects.toThrow(/의존성 설치 (시간 초과|실패)/);
  });

  it('lockfile settings.excludeLinksFromLockfile이 false가 아니면 거부한다 (link: 의존성이 importers에서 빠진다)', async () => {
    const text = render(base);
    await expect(
      installText(
        text.replace('excludeLinksFromLockfile: false', 'excludeLinksFromLockfile: true'),
      ),
    ).rejects.toThrow(/excludeLinksFromLockfile/);
    await expect(
      installText(text.replace('  excludeLinksFromLockfile: false\n', '')),
    ).rejects.toThrow(/excludeLinksFromLockfile/);
  });

  it('빌드 스크립트 PATH의 bin 폴더 항목은 레지스트리 패키지 폴더 안을 가리켜야 한다 (bin 실경로 확인)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-pathbin-'));
    try {
      const put = (rel: string, body: string): void => {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), body);
      };
      const shim = (target: string): string =>
        `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/${target}" "$@"\nelse\n  exec node  "$basedir/${target}" "$@"\nfi\n`;
      writeFileSync(path.join(dir, 'pnpm-lock.yaml'), render(base));
      // 레지스트리 패키지 (pnpm 배치: .pnpm/<키>/node_modules/<이름>, 피어 접미 `_…`)
      put('node_modules/.pnpm/native@1.0.0/node_modules/native/cli.js', '');
      put('node_modules/.pnpm/vitest@5.0.5_vite@8.3.4/node_modules/vitest/vitest.mjs', '');
      symlinkSync('.pnpm/native@1.0.0/node_modules/native', path.join(dir, 'node_modules/native'));
      mkdirSync(path.join(dir, 'node_modules/.pnpm/node_modules'), { recursive: true });
      symlinkSync(
        '../vitest@5.0.5_vite@8.3.4/node_modules/vitest',
        path.join(dir, 'node_modules/.pnpm/node_modules/vitest'),
        'dir',
      );
      put('node_modules/.bin/native', shim('../native/cli.js'));
      put('node_modules/.pnpm/node_modules/.bin/vitest', shim('../vitest/vitest.mjs'));
      expect(() => assertBuildPathBins(dir)).not.toThrow();

      // 레지스트리가 아닌 패키지(file: 폴더)를 가리키는 hoist된 bin
      put('node_modules/.pnpm/b@file+b/node_modules/b/gyp.js', '');
      symlinkSync(
        '../b@file+b/node_modules/b',
        path.join(dir, 'node_modules/.pnpm/node_modules/b'),
        'dir',
      );
      put('node_modules/.pnpm/node_modules/.bin/node-gyp', shim('../b/gyp.js'));
      expect(() => assertBuildPathBins(dir)).toThrow(/node-gyp.*레지스트리/);
      rmSync(path.join(dir, 'node_modules/.pnpm/node_modules/.bin/node-gyp'));

      // 프로젝트 폴더(link:)를 가리키는 루트 bin · 링크 bin · 대상을 읽을 수 없는 shim
      put('tool/gyp.js', '');
      symlinkSync('../tool', path.join(dir, 'node_modules/tool'), 'dir');
      put('node_modules/.bin/node-gyp', shim('../tool/gyp.js'));
      expect(() => assertBuildPathBins(dir)).toThrow(/node-gyp/);
      rmSync(path.join(dir, 'node_modules/.bin/node-gyp'));
      symlinkSync('../../tool/gyp.js', path.join(dir, 'node_modules/.bin/node-gyp'));
      expect(() => assertBuildPathBins(dir)).toThrow(/node-gyp/);
      rmSync(path.join(dir, 'node_modules/.bin/node-gyp'));
      put('node_modules/.bin/odd', '#!/bin/sh\necho hi\n');
      expect(() => assertBuildPathBins(dir)).toThrow(/odd/);
      rmSync(path.join(dir, 'node_modules/.bin/odd'));
      // lockfile에 레지스트리로 없는 키 폴더(패치본 등)
      put('node_modules/.pnpm/helper@2.0.0_patch_hash=00/node_modules/helper/x.js', '');
      symlinkSync(
        '../helper@2.0.0_patch_hash=00/node_modules/helper',
        path.join(dir, 'node_modules/.pnpm/node_modules/helper'),
        'dir',
      );
      put('node_modules/.pnpm/node_modules/.bin/helper', shim('../helper/x.js'));
      expect(() => assertBuildPathBins(dir)).toThrow(/helper/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'hoist 설정(.npmrc shamefully-hoist · pnpm-workspace.yaml shamefullyHoist)으로 닫힘 밖 file: 패키지의 node-gyp bin을 올려도 빌드 스크립트가 그것을 실행하지 않는다 (#146 검토 2회차 재현)',
    async () => {
      for (const [file, body] of [
        ['.npmrc', 'shamefully-hoist=true\n'],
        [
          'pnpm-workspace.yaml',
          'packages: []\nonlyBuiltDependencies:\n  - better-sqlite3\nshamefullyHoist: true\n',
        ],
      ] as const) {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-hoist-'));
        const marker = path.join(dir, 'PWNED_HOIST');
        try {
          const fixturePkg = JSON.parse(
            readFileSync(path.join(REPO_ROOT, 'fixtures/sample-next-app/package.json'), 'utf8'),
          ) as { devDependencies: Record<string, string> };
          mkdirSync(path.join(dir, 'a'));
          mkdirSync(path.join(dir, 'b'));
          writeFileSync(
            path.join(dir, 'a', 'package.json'),
            JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { b: 'file:../b' } }),
          );
          writeFileSync(
            path.join(dir, 'b', 'package.json'),
            JSON.stringify({ name: 'b', version: '1.0.0', bin: { 'node-gyp': 'gyp.js' } }),
          );
          writeFileSync(
            path.join(dir, 'b', 'gyp.js'),
            `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, '');\n`,
          );
          writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
              name: 'hoist-app',
              private: true,
              dependencies: {
                // 픽스처 lockfile에 있는 버전 (전역 저장소 캐시에서 복사 설치)
                'better-sqlite3': '12.11.1',
                a: 'file:./a',
              },
              devDependencies: { vitest: fixturePkg.devDependencies.vitest },
            }),
          );
          writeFileSync(
            path.join(dir, 'pnpm-workspace.yaml'),
            'packages: []\nonlyBuiltDependencies:\n  - better-sqlite3\n',
          );
          // prebuild-install을 실패시켜 node-gyp로 넘어가게 한다
          writeFileSync(path.join(dir, '.prebuild-installrc'), 'buildFromSource=true\n');
          writeFileSync(path.join(dir, file), body);
          execFileSync(
            'pnpm',
            ['install', '--lockfile-only', '--prefer-offline', '--ignore-scripts'],
            { cwd: dir, stdio: 'pipe', env: { ...process.env, CI: '1' } },
          );
          await expect(
            installDependencies(dir, {
              logFile: path.join(dir, 'install.log'),
              timeoutMs: JUDGE_TIMEOUT_MS,
            }),
            file,
          ).rejects.toThrow(/node-gyp.*레지스트리/);
          // 루트 .bin에는 올라오지 않았다 (hoist 설정 고정)
          expect(existsSync(path.join(dir, 'node_modules', '.bin', 'node-gyp')), file).toBe(false);
          expect(existsSync(marker), file).toBe(false);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  it(
    '픽스처에 허용 패키지 의존성 override(prebuild-install → file: 폴더)를 커밋하면 설치를 거부하고 rebuild가 그 bin을 실행하지 않는다 (검토 재현)',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-override-fx-'));
      const app = copyFixtureFiles(dir);
      const marker = path.join(app, 'PWNED_OVERRIDE');
      try {
        mkdirSync(path.join(app, 'evil'));
        writeFileSync(
          path.join(app, 'evil', 'package.json'),
          JSON.stringify({
            name: 'prebuild-install',
            version: '9.9.9',
            bin: { 'prebuild-install': 'bin.js' },
          }),
        );
        writeFileSync(
          path.join(app, 'evil', 'bin.js'),
          `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, '');\nprocess.exit(1);\n`,
        );
        const workspace = path.join(app, 'pnpm-workspace.yaml');
        writeFileSync(
          workspace,
          `${readFileSync(workspace, 'utf8')}overrides:\n  prebuild-install: file:./evil\n`,
        );
        execFileSync(
          'pnpm',
          ['install', '--lockfile-only', '--prefer-offline', '--ignore-scripts'],
          { cwd: app, stdio: 'pipe', env: { ...process.env, CI: '1' } },
        );
        const lock = readFileSync(path.join(app, 'pnpm-lock.yaml'), 'utf8');
        expect(lock).toContain(
          'prebuild-install@file:evil:\n    resolution: {directory: evil, type: directory}',
        );
        expect(lock).toContain('      prebuild-install: file:evil');
        await expect(
          installDependencies(app, {
            logFile: path.join(dir, 'install.log'),
            timeoutMs: JUDGE_TIMEOUT_MS,
          }),
        ).rejects.toThrow(/빌드 허용 목록의 패키지 better-sqlite3.*prebuild-install/);
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  it(
    '픽스처에 vitest 패치를 커밋하면 빌드 허용 목록과 상관없이 판정 설치를 거부한다',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-vitest-patch-fx-'));
      const app = copyFixtureFiles(dir);
      try {
        mkdirSync(path.join(app, 'patches'));
        writeFileSync(
          path.join(app, 'patches', 'vitest@5.0.5.patch'),
          'diff --git a/vitest.mjs b/vitest.mjs\n--- a/vitest.mjs\n+++ b/vitest.mjs\n@@ -1 +1,2 @@\n+globalThis.PATCHED = true;\n #!/usr/bin/env node\n',
        );
        const workspace = path.join(app, 'pnpm-workspace.yaml');
        writeFileSync(
          workspace,
          `${readFileSync(workspace, 'utf8').replace(/onlyBuiltDependencies:[\s\S]*$/u, '')}patchedDependencies:\n  vitest@5.0.5: patches/vitest@5.0.5.patch\n`,
        );
        execFileSync(
          'pnpm',
          ['install', '--lockfile-only', '--prefer-offline', '--ignore-scripts'],
          { cwd: app, stdio: 'pipe', env: { ...process.env, CI: '1' } },
        );
        expect(readFileSync(path.join(app, 'pnpm-lock.yaml'), 'utf8')).toContain(
          'patchedDependencies:\n  vitest@5.0.5:',
        );
        await expect(
          installDependencies(app, {
            logFile: path.join(dir, 'install.log'),
            timeoutMs: JUDGE_TIMEOUT_MS,
          }),
        ).rejects.toThrow(/판정 실행기 vitest.*패치/);
        expect(existsSync(path.join(app, 'node_modules'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    BUILD_TEST_TIMEOUT_MS,
  );
});

/**
 * 레지스트리 의존성만 둔 최소 프로젝트를 `dir`에 만들고 lockfile을 만든다(`--lockfile-only`, 설치 없음). 버전은 픽스처
 * lockfile에 있는 것이라 판정 설치가 전역 저장소 캐시에서 복사한다.
 */
const minimalProject = (
  dir: string,
  dependencies: Record<string, string>,
  workspace = 'packages: []\n',
): void => {
  const fixturePkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'fixtures/sample-next-app/package.json'), 'utf8'),
  ) as { devDependencies: Record<string, string> };
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'config-app',
      private: true,
      dependencies,
      devDependencies: { vitest: fixturePkg.devDependencies.vitest },
    }),
  );
  writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), workspace);
  execFileSync('pnpm', ['install', '--lockfile-only', '--prefer-offline', '--ignore-scripts'], {
    cwd: dir,
    stdio: 'pipe',
    env: { ...process.env, CI: '1' },
  });
};

describe('판정 설치의 프로젝트 pnpm 설정 (#162)', () => {
  /** `files`로 프로젝트 설정 파일을 만들고 `assertProjectPnpmConfig`로 검사한다. */
  const checkConfig = (files: Record<string, string>): void => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-pnpmcfg-'));
    try {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
      for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(dir, rel), body);
      assertProjectPnpmConfig(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('.npmrc는 허용한 키만 받는다: 주석 · 빈 줄 · 허용 키(배열 표기 포함)는 통과한다', () => {
    expect(() =>
      checkConfig({
        '.npmrc': [
          '# 주석',
          '; 주석',
          '',
          'auto-install-peers=true',
          'strict-peer-dependencies = false',
          'shamefully-hoist=true',
          'public-hoist-pattern[]=*eslint*',
          'save-exact',
          '',
        ].join('\r\n'),
      }),
    ).not.toThrow();
    expect(() => checkConfig({})).not.toThrow();
  });

  it.each([
    ['node-gyp=../../../../../tool/gyp.js', 'node-gyp'],
    ['store-dir=./.st', 'store-dir'],
    ['side-effects-cache=true', 'side-effects-cache'],
    ['virtual-store-dir=.vs', 'virtual-store-dir'],
    ['modules-dir=.mods', 'modules-dir'],
    ['registry=https://registry.example.com/', 'registry'],
    ['@evil:registry=https://registry.example.com/', '@evil:registry'],
    ['//registry.npmjs.org/:_authToken=${NPM_TOKEN}', '//registry.npmjs.org/:_authToken'],
    ['"store-dir"=./.st', '"store-dir"'],
    ['  store-dir = "./.st"', 'store-dir'],
    ['store-dir', 'store-dir'],
    ['storeDir=./.st', 'storeDir'],
    ['${HOME}=x', '${HOME}'],
    ['userconfig=./.user-npmrc', 'userconfig'],
    ['globalconfig=./.global-npmrc', 'globalconfig'],
    ['lockfile-dir=..', 'lockfile-dir'],
    ['package-import-method=hardlink', 'package-import-method'],
    ['manage-package-manager-versions=true', 'manage-package-manager-versions'],
    ['[section]\nstore-dir=./.st', '[section]'],
    ['node-gyp;x=1', 'node-gyp;x'],
  ])('.npmrc의 %s는 거부한다 (파일 · 키를 알린다)', (line, key) => {
    expect(() => checkConfig({ '.npmrc': `auto-install-peers=true\n${line}\n` })).toThrow(
      new RegExp(`\\.npmrc의 ${key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'),
    );
  });

  it('pnpm-workspace.yaml은 허용한 최상위 키만 받는다', () => {
    expect(() =>
      checkConfig({
        'pnpm-workspace.yaml': [
          'packages: []',
          'onlyBuiltDependencies: [better-sqlite3]',
          'ignoredBuiltDependencies: [esbuild]',
          'overrides: {}',
          'catalog: {}',
          'shamefullyHoist: true',
          'peerDependencyRules: {}',
          '',
        ].join('\n'),
      }),
    ).not.toThrow();
    for (const key of [
      'storeDir: ./.st',
      'nodeGyp: ./tool/gyp.js',
      'virtualStoreDir: .vs',
      'modulesDir: .mods',
      'sideEffectsCache: true',
      'registry: https://registry.example.com/',
      'allowBuilds: {evil: true}',
      'onlyBuiltDependenciesFile: built.json',
      'dangerouslyAllowAllBuilds: true',
      'configDependencies: {}',
      'store-dir: ./.st',
    ]) {
      const name = key.slice(0, key.indexOf(':'));
      expect(() => checkConfig({ 'pnpm-workspace.yaml': `packages: []\n${key}\n` }), key).toThrow(
        new RegExp(`pnpm-workspace\\.yaml의 ${name}`, 'u'),
      );
    }
  });

  it('package.json의 pnpm 칸은 허용한 키만 받는다', () => {
    const pkg = (pnpm: Record<string, unknown>): string => JSON.stringify({ name: 'app', pnpm });
    expect(() =>
      checkConfig({
        'package.json': pkg({
          onlyBuiltDependencies: ['x'],
          overrides: {},
          patchedDependencies: {},
        }),
      }),
    ).not.toThrow();
    for (const key of ['configDependencies', 'executionEnv', 'allowBuilds', 'storeDir']) {
      expect(() => checkConfig({ 'package.json': pkg({ [key]: {} }) }), key).toThrow(
        new RegExp(`package\\.json pnpm의 ${key}`, 'u'),
      );
    }
    expect(() =>
      checkConfig({ 'package.json': JSON.stringify({ name: 'app', pnpm: [] }) }),
    ).toThrow(/package\.json pnpm/);
  });

  it('레지스트리 주소(registry= · @scope:registry=)를 바꾼 프로젝트는 판정 설치를 거부한다: pnpm을 띄우지 않는다 (ADR-069)', async () => {
    for (const npmrc of [
      'registry=https://registry.example.com/\n',
      '@scope:registry=https://registry.example.com/\n',
    ]) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-registry-'));
      try {
        writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
        writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
        writeFileSync(path.join(dir, '.npmrc'), npmrc);
        await expect(
          installDependencies(dir, { logFile: path.join(dir, 'install.log'), timeoutMs: 1 }),
          npmrc,
        ).rejects.toThrow(/\.npmrc의 (@scope:)?registry/);
        expect(existsSync(path.join(dir, 'install.log'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('.npmrc가 일반 파일이 아니면(폴더 · 링크) 거부한다', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-pnpmcfg-'));
    try {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
      mkdirSync(path.join(dir, '.npmrc'));
      expect(() => assertProjectPnpmConfig(dir)).toThrow(/\.npmrc/);
      rmdirSync(path.join(dir, '.npmrc'));
      writeFileSync(path.join(dir, 'other'), 'store-dir=./.st\n');
      symlinkSync('other', path.join(dir, '.npmrc'));
      expect(() => assertProjectPnpmConfig(dir)).toThrow(/\.npmrc/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('판정 설치의 install · rebuild 고정 인자: node-gyp · 저장소 · side-effects-cache · 배치 · pnpm 버전 전환', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-pinned-'));
    try {
      // 저장소는 프로젝트 밖(체크아웃의 부모)에서 판정 자식 환경으로 정한 pnpm 기본 저장소다
      const storeDir = await resolveJudgeStoreDir(dir, undefined);
      expect(storeDir).toBe(
        execFileSync('pnpm', ['store', 'path'], {
          cwd: os.tmpdir(),
          encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: '1' },
        }).trim(),
      );
      expect(pinnedPnpmConfigArgs(storeDir)).toEqual([
        '--config.node-linker=isolated',
        '--config.shamefully-hoist=false',
        '--config.public-hoist-pattern=',
        '--config.node-gyp=',
        `--config.store-dir=${storeDir}`,
        '--config.side-effects-cache=false',
        '--config.virtual-store-dir=node_modules/.pnpm',
        '--config.modules-dir=node_modules',
        '--config.manage-package-manager-versions=false',
        '--config.verify-store-integrity=true',
        '--config.node-options=',
        '--config.script-shell=',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pnpm이 읽는 다른 루트 매니페스트(package.json5 · package.yaml)가 있거나 package.json이 없으면 거부한다 (검토 1회차)', () => {
    for (const other of ['package.json5', 'package.yaml']) {
      expect(() => checkConfig({ [other]: 'name: app\n' }), other).toThrow(
        new RegExp(`${other.replace('.', '\\.')}는 받아들이지 않습니다`, 'u'),
      );
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-pnpmcfg-'));
    try {
      expect(() => assertProjectPnpmConfig(dir)).toThrow(/package\.json이 없습니다/);
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
      symlinkSync('missing', path.join(dir, 'package.yaml'));
      expect(() => assertProjectPnpmConfig(dir)).toThrow(/package\.yaml/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('쓰이지 않는 fund · audit는 받고, 흔한 다른 키(기본 레지스트리 주소 · loglevel 포함)는 거부하며 빈 키는 (빈 키)로 알린다 (검토 1 · 2회차)', () => {
    expect(() =>
      checkConfig({
        '.npmrc': 'fund=false\naudit=false\n',
        'pnpm-workspace.yaml': 'packages: []\nfund: false\n',
      }),
    ).not.toThrow();
    // loglevel=silent는 명령줄 --reporter보다 먼저 리포터를 꺼 판정 설치 로그를 비운다 (검토 2회차)
    expect(() =>
      checkConfig({ 'pnpm-workspace.yaml': 'packages: []\nloglevel: silent\n' }),
    ).toThrow(/pnpm-workspace\.yaml의 loglevel/);
    for (const line of [
      'loglevel=silent',
      'prefer-offline=true',
      'resolution-mode=highest',
      'ignore-workspace-root-check=true',
      'strict-ssl=false',
      'registry=https://registry.npmjs.org/',
    ]) {
      expect(() => checkConfig({ '.npmrc': `${line}\n` }), line).toThrow(
        new RegExp(`\\.npmrc의 ${line.slice(0, line.indexOf('='))} `, 'u'),
      );
    }
    expect(() => checkConfig({ '.npmrc': '=x\n' })).toThrow(/\.npmrc의 \(빈 키\)/);
  });

  it('작업 공간 · lockfile이 체크아웃 밖을 가리키면 거부하고, 체크아웃 안의 file: · link:는 받는다 (검토 1회차)', () => {
    const INTEGRITY = 'sha512-' + 'D'.repeat(86) + '==';
    const lock = (importers: string, packages = '', snapshots = ''): string =>
      [
        "lockfileVersion: '9.0'",
        '',
        'settings:',
        '  autoInstallPeers: true',
        '  excludeLinksFromLockfile: false',
        '',
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      is-number:',
        '        specifier: 7.0.0',
        '        version: 7.0.0',
        importers,
        '',
        'packages:',
        '',
        '  is-number@7.0.0:',
        `    resolution: {integrity: ${INTEGRITY}}`,
        packages,
        '',
        'snapshots:',
        '',
        '  is-number@7.0.0: {}',
        snapshots,
        '',
      ].join('\n');
    const check = (text: string, workspace = 'packages: []\n'): void => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-inside-'));
      try {
        writeFileSync(path.join(dir, 'pnpm-lock.yaml'), text);
        writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), workspace);
        assertLockfilePathsInside(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    // 체크아웃 안: 루트 file: · 하위 importer의 link:../b(importer 기준) · file:(lockfile 기준)
    const inside = lock(
      [
        '      local:',
        '        specifier: file:./local',
        '        version: file:local',
        '',
        '  packages/a:',
        '    dependencies:',
        '      b:',
        '        specifier: workspace:*',
        '        version: link:../b',
        '      local:',
        '        specifier: file:../../local',
        '        version: file:local',
        '',
        '  packages/b: {}',
      ].join('\n'),
      '\n  local@file:local:\n    resolution: {directory: local, type: directory}',
      '\n  local@file:local: {}',
    );
    expect(() => check(inside, 'packages:\n  - packages/*\n  - "!packages/skip"\n')).not.toThrow();
    // 작업 공간 packages의 .. · 절대 경로
    for (const pattern of ['../worktrees/*', '/abs/*', 'packages/../../x', '{..,packages}/*']) {
      expect(() => check(inside, `packages:\n  - '${pattern}'\n`), pattern).toThrow(
        /체크아웃 밖.*packages/,
      );
    }
    // importers 키 · link: · file: · resolution.directory가 체크아웃 밖
    expect(() => check(lock('\n  ../../../worktrees/EXE-1: {}'))).toThrow(/importers \.\.\//);
    expect(() =>
      check(lock('      wt:\n        specifier: link:../../wt\n        version: link:../../wt')),
    ).toThrow(/link:\.\.\/\.\.\/wt/);
    expect(() =>
      check(
        lock(
          '      wt:\n        specifier: file:../wt\n        version: file:../wt',
          '\n  wt@file:../wt:\n    resolution: {directory: ../wt, type: directory}',
          '\n  wt@file:../wt: {}',
        ),
      ),
    ).toThrow(/체크아웃 밖.*\.\.\/wt/);
    expect(() =>
      check(
        lock(
          '',
          '\n  wt@1.0.0:\n    resolution: {directory: /abs/wt, type: directory}',
          '\n  wt@1.0.0:\n    dependencies:\n      x: file:/abs/x',
        ),
      ),
    ).toThrow(/체크아웃 밖/);
  });

  /** 루트 importer가 `wt`를 `version`으로 가리키는 최소 lockfile (pnpm 10.28 · 9.0 형식). */
  const wtLock = (version: string, extra = ''): string =>
    [
      "lockfileVersion: '9.0'",
      '',
      'settings:',
      '  autoInstallPeers: true',
      '  excludeLinksFromLockfile: false',
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      '      wt:',
      '        specifier: link:x',
      `        version: '${version}'`,
      '',
      extra,
    ].join('\n');
  /** `dir/co`를 체크아웃으로 삼아 `files`(링크는 `->` 대상)를 만들고 `assertLockfilePathsInside`를 부른다. */
  const checkCo = (lock: string, links: Record<string, string> = {}): void => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-inside2-'));
    try {
      const co = path.join(dir, 'co');
      mkdirSync(path.join(dir, 'outside', 'wt'), { recursive: true });
      mkdirSync(co);
      mkdirSync(path.join(co, 'real-inside', 'wt'), { recursive: true });
      writeFileSync(path.join(co, 'pnpm-lock.yaml'), lock);
      writeFileSync(path.join(co, 'pnpm-workspace.yaml'), 'packages: []\n');
      for (const [link, target] of Object.entries(links)) {
        symlinkSync(target, path.join(co, link));
      }
      assertLockfilePathsInside(co);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('link: · file: 참조의 ( 뒤에 숨긴 .. 를 피어 접미로 잘라 통과시키지 않는다 (검토 2회차 재현)', () => {
    // pnpm은 importers의 `link:` 값을 자르지 않고 경로 그대로 써 `../outside/wt`로 링크했다(검토자 실측)
    expect(() => checkCo(wtLock('link:x(/../../outside/wt'))).toThrow(/체크아웃 밖/);
    expect(() => checkCo(wtLock('file:x(/../../outside/wt'))).toThrow(/체크아웃 밖/);
    // 정상: pnpm이 피어 의존성이 있는 file: 디렉터리에 붙이는 접미(실측 `file:localdir(is-number@7.0.0)`)
    expect(() => checkCo(wtLock('file:real-inside/wt(is-number@7.0.0)'))).not.toThrow();
    // link:에는 pnpm이 접미를 붙이지 않는다(실측) → ( 가 있으면 거부
    expect(() => checkCo(wtLock('link:real-inside/wt(is-number@7.0.0)'))).toThrow(/체크아웃 밖/);
  });

  it('체크아웃 안의 심볼릭 링크가 밖을 가리키는 link: · file: · importer 폴더는 실경로로 거부하고, 안을 가리키면 받는다 (검토 2회차 재현)', () => {
    expect(() => checkCo(wtLock('link:inside'), { inside: '../outside/wt' })).toThrow(
      /체크아웃 밖.*link:inside/,
    );
    expect(() => checkCo(wtLock('file:inside'), { inside: '../outside/wt' })).toThrow(
      /체크아웃 밖/,
    );
    // 경로 중간의 링크도 푼다 (대상 폴더가 없어도 있는 조상까지는 실경로로 본다)
    expect(() => checkCo(wtLock('link:mid/wt/missing'), { mid: '../outside' })).toThrow(
      /체크아웃 밖/,
    );
    expect(() => checkCo(wtLock('link:inside'), { inside: 'real-inside/wt' })).not.toThrow();
    // 작업 공간 importer 폴더가 밖을 가리키는 링크
    expect(() =>
      checkCo(
        wtLock('link:real-inside/wt', '\n  pkgs/a:\n    dependencies: {}\n').replace(
          '\n\n\n  pkgs/a',
          '\n\n  pkgs/a',
        ),
        { pkgs: '../outside' },
      ),
    ).toThrow(/체크아웃 밖.*importers pkgs\/a/);
  });

  it(
    '프로젝트 .npmrc의 node-gyp=<프로젝트 파일>은 판정 설치 실패로 닫고 그 파일을 실행하지 않는다 (3차 검토 재현)',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-nodegyp-'));
      const marker = path.join(dir, 'PWNED_NODE_GYP');
      try {
        minimalProject(
          dir,
          { 'better-sqlite3': '12.11.1' },
          'packages: []\nonlyBuiltDependencies:\n  - better-sqlite3\n',
        );
        // prebuild-install을 실패시켜 `node-gyp rebuild`로 넘어가게 한다. pnpm의 node-gyp-bin은 "$npm_config_node_gyp"를 실행한다
        writeFileSync(path.join(dir, '.prebuild-installrc'), 'buildFromSource=true\n');
        mkdirSync(path.join(dir, 'tool'));
        writeFileSync(
          path.join(dir, 'tool', 'gyp.js'),
          `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, '');\nprocess.exit(1);\n`,
          { mode: 0o755 },
        );
        // `.pnpm/<id>/node_modules/<이름>`에서 프로젝트 최상위까지의 상대 경로
        writeFileSync(path.join(dir, '.npmrc'), 'node-gyp=../../../../../tool/gyp.js\n');
        await expect(
          installDependencies(dir, {
            logFile: path.join(dir, 'install.log'),
            timeoutMs: JUDGE_TIMEOUT_MS,
          }),
        ).rejects.toThrow(/\.npmrc의 node-gyp/);
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  it(
    '프로젝트 .npmrc의 store-dir=<커밋 안 저장소>에서 vitest를 바꿔 두면 판정 설치 실패로 닫는다: 변조된 vitest가 설치되지 않는다 (3차 검토 재현)',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-storedir-'));
      try {
        minimalProject(dir, {});
        // 커밋 안의 저장소(.st/v10)를 전역 저장소의 복사본으로 만든다. 전역 저장소의 파일은 읽기만 한다
        const globalStore = execFileSync('pnpm', ['store', 'path'], {
          cwd: os.tmpdir(),
          encoding: 'utf8',
          env: { ...process.env, CI: '1' },
        }).trim();
        const store = path.join(dir, '.st', 'v10');
        const hex = (integrity: string): string =>
          Buffer.from(integrity.slice(integrity.indexOf('-') + 1), 'base64').toString('hex');
        const contentPath = (root: string, integrity: string, mode: number): string => {
          const h = hex(integrity);
          return path.join(
            root,
            'files',
            h.slice(0, 2),
            `${h.slice(2)}${mode & 0o111 ? '-exec' : ''}`,
          );
        };
        type IndexFile = {
          files: Record<
            string,
            { integrity: string; mode: number; size: number; checkedAt?: number }
          >;
        };
        const lock = parseYaml(readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8')) as {
          packages: Record<string, { resolution: { integrity: string } }>;
        };
        let vitestIndex = '';
        for (const [key, entry] of Object.entries(lock.packages)) {
          const name = lockfileKeyName(key) ?? '';
          const h = hex(entry.resolution.integrity);
          // 색인 파일 이름은 integrity 16진수의 앞 64자(실측 pnpm 10.28 저장소 v10)
          const rel = path.join(
            'index',
            h.slice(0, 2),
            `${h.slice(2, 64)}-${name.replace('/', '+')}@${key.slice(name.length + 1)}.json`,
          );
          // 다른 플랫폼의 선택 의존성은 전역 저장소에도 없다
          if (!existsSync(path.join(globalStore, rel))) continue;
          mkdirSync(path.dirname(path.join(store, rel)), { recursive: true });
          writeFileSync(path.join(store, rel), readFileSync(path.join(globalStore, rel)));
          const index = JSON.parse(readFileSync(path.join(globalStore, rel), 'utf8')) as IndexFile;
          for (const file of Object.values(index.files)) {
            const target = contentPath(store, file.integrity, file.mode);
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(
              target,
              readFileSync(contentPath(globalStore, file.integrity, file.mode)),
              {
                mode: file.mode,
              },
            );
          }
          if (name === 'vitest') vitestIndex = path.join(store, rel);
        }
        // 복사본의 vitest.mjs 내용과 색인 항목(integrity · size)만 바꾼다
        const tampered = Buffer.from('#!/usr/bin/env node\nconsole.log("TAMPERED_VITEST");\n');
        const integrity = `sha512-${createHash('sha512').update(tampered).digest('base64')}`;
        const index = JSON.parse(readFileSync(vitestIndex, 'utf8')) as IndexFile;
        const entry = index.files['vitest.mjs'];
        if (entry === undefined) throw new Error('vitest.mjs 색인 항목이 없다');
        index.files['vitest.mjs'] = { ...entry, integrity, size: tampered.length };
        writeFileSync(vitestIndex, JSON.stringify(index));
        const target = contentPath(store, integrity, entry.mode);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, tampered, { mode: entry.mode });
        writeFileSync(path.join(dir, '.npmrc'), 'store-dir=./.st\n');

        await expect(
          installDependencies(dir, {
            logFile: path.join(dir, 'install.log'),
            timeoutMs: JUDGE_TIMEOUT_MS,
          }),
        ).rejects.toThrow(/\.npmrc의 store-dir/);
        const installed = path.join(dir, 'node_modules', 'vitest', 'vitest.mjs');
        expect(existsSync(installed) && readFileSync(installed, 'utf8').includes('TAMPERED')).toBe(
          false,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  it(
    '닫힘 밖 file: 패키지의 python3 bin이 .pnpm/node_modules/.bin에 올라오면 rebuild 전에 거부한다: node-gyp가 Python을 찾다가 실행하지 않는다 (bin 확인이 유일한 방어)',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-python3-'));
      const marker = path.join(dir, 'PWNED_PYTHON3');
      try {
        mkdirSync(path.join(dir, 'a'));
        mkdirSync(path.join(dir, 'b'));
        writeFileSync(
          path.join(dir, 'a', 'package.json'),
          JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { b: 'file:../b' } }),
        );
        writeFileSync(
          path.join(dir, 'b', 'package.json'),
          JSON.stringify({ name: 'b', version: '1.0.0', bin: { python3: 'python3.js' } }),
        );
        writeFileSync(
          path.join(dir, 'b', 'python3.js'),
          `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, '');\nprocess.exit(1);\n`,
        );
        minimalProject(
          dir,
          { 'better-sqlite3': '12.11.1', a: 'file:./a' },
          'packages: []\nonlyBuiltDependencies:\n  - better-sqlite3\n',
        );
        writeFileSync(path.join(dir, '.prebuild-installrc'), 'buildFromSource=true\n');
        await expect(
          installDependencies(dir, {
            logFile: path.join(dir, 'install.log'),
            timeoutMs: JUDGE_TIMEOUT_MS,
          }),
        ).rejects.toThrow(/node_modules\/\.pnpm\/node_modules\/\.bin\/python3.*레지스트리/);
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    BUILD_TEST_TIMEOUT_MS,
  );
});

describe('bin shim 해석 · 설치 배치 확인 (#162)', () => {
  /** pnpm 10.28이 만드는 셸 shim (실측 모양, NODE_PATH 줄은 줄임). `prog`가 없으면 인터프리터 없는 직접 실행 */
  const pnpmShim = (
    target: string,
    prog?: { inner: string; outer: string; args?: string },
  ): string =>
    [
      '#!/bin/sh',
      `basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")`,
      '',
      'case `uname` in',
      '    *CYGWIN*|*MINGW*|*MSYS*)',
      '        if command -v cygpath > /dev/null 2>&1; then',
      '            basedir=`cygpath -w "$basedir"`',
      '        fi',
      '    ;;',
      'esac',
      '',
      'if [ -z "$NODE_PATH" ]; then',
      '  export NODE_PATH="/x/node_modules/.pnpm/node_modules"',
      'else',
      '  export NODE_PATH="/x/node_modules/.pnpm/node_modules:$NODE_PATH"',
      'fi',
      ...(prog === undefined
        ? [`"$basedir/${target}"   "$@"`, 'exit $?']
        : [
            `if [ -x "$basedir/${prog.inner}" ]; then`,
            `  exec "$basedir/${prog.inner}"  ${prog.args ?? ''}"$basedir/${target}" "$@"`,
            'else',
            `  exec ${prog.outer}  ${prog.args ?? ''}"$basedir/${target}" "$@"`,
            'fi',
          ]),
      '',
    ].join('\n');

  it('shim에서 대상만 읽는다: node · bash · /bin/sh · python3 · 인자 있는 인터프리터 · 인터프리터 없는 직접 실행', () => {
    const t = '../.pnpm/tools@1.0.0/node_modules/tools/x';
    expect(shimTargets(pnpmShim(t, { inner: 'node', outer: 'node' }))).toEqual([t]);
    expect(shimTargets(pnpmShim(t, { inner: 'bash', outer: 'bash' }))).toEqual([t]);
    expect(shimTargets(pnpmShim(t, { inner: '/bin/sh', outer: '/bin/sh' }))).toEqual([t]);
    expect(shimTargets(pnpmShim(t, { inner: '/bin/bash', outer: '/bin/bash' }))).toEqual([t]);
    expect(shimTargets(pnpmShim(t, { inner: 'python3', outer: 'python3' }))).toEqual([t]);
    expect(
      shimTargets(pnpmShim(t, { inner: 'node', outer: 'node', args: '--no-warnings ' })),
    ).toEqual([t]);
    expect(
      shimTargets(pnpmShim(t, { inner: '/usr/bin/perl', outer: '/usr/bin/perl', args: '-w ' })),
    ).toEqual([t]);
    expect(shimTargets(pnpmShim(t))).toEqual([t]);
    // 해석할 수 없는 모양은 null (거부)
    expect(shimTargets('#!/bin/sh\necho hi\n')).toBeNull();
    expect(shimTargets(`${pnpmShim(t)}\n"$basedir/../../tool/gyp.js"\n`)).toBeNull();
    expect(
      shimTargets(pnpmShim(t, { inner: '../../tool/gyp', outer: '../../tool/gyp' })),
    ).toBeNull();
    expect(shimTargets(pnpmShim(t).replace('"$@"', '"$@" "$basedir/../evil"'))).toBeNull();
  });

  it('레지스트리 패키지의 셸 스크립트 bin(bash · /bin/sh shim)은 인터프리터 경로를 대상으로 오인하지 않고 통과한다', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-shellbin-'));
    try {
      const INTEGRITY = 'sha512-' + 'C'.repeat(86) + '==';
      writeFileSync(
        path.join(dir, 'pnpm-lock.yaml'),
        [
          "lockfileVersion: '9.0'",
          '',
          'settings:',
          '  autoInstallPeers: true',
          '  excludeLinksFromLockfile: false',
          '',
          'importers:',
          '',
          '  .:',
          '    dependencies:',
          '      tools:',
          '        specifier: 1.0.0',
          '        version: 1.0.0',
          '',
          'packages:',
          '',
          '  tools@1.0.0:',
          `    resolution: {integrity: ${INTEGRITY}}`,
          '',
          'snapshots:',
          '',
          '  tools@1.0.0: {}',
          '',
        ].join('\n'),
      );
      const pkg = path.join(dir, 'node_modules/.pnpm/tools@1.0.0/node_modules/tools');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(path.join(pkg, 'b.sh'), '#!/usr/bin/env bash\n');
      writeFileSync(path.join(pkg, 's.sh'), '#!/bin/sh\n');
      mkdirSync(path.join(dir, 'node_modules/.bin'));
      const target = (file: string): string => `../.pnpm/tools@1.0.0/node_modules/tools/${file}`;
      writeFileSync(
        path.join(dir, 'node_modules/.bin/t-bash'),
        pnpmShim(target('b.sh'), { inner: 'bash', outer: 'bash' }),
      );
      writeFileSync(
        path.join(dir, 'node_modules/.bin/t-sh'),
        pnpmShim(target('s.sh'), { inner: '/bin/sh', outer: '/bin/sh' }),
      );
      expect(() => assertBuildPathBins(dir)).not.toThrow();
      // .bin 안의 폴더(`"$basedir//bin/sh"`가 가리킬 자리)는 거부한다
      mkdirSync(path.join(dir, 'node_modules/.bin/bin'));
      expect(() => assertBuildPathBins(dir)).toThrow(/\.bin\/bin/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('설치 뒤 node_modules/.pnpm이 없으면 bin 확인을 건너뛰지 않고 거부한다', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-novstore-'));
    try {
      writeFileSync(
        path.join(dir, 'pnpm-lock.yaml'),
        "lockfileVersion: '9.0'\nsettings:\n  excludeLinksFromLockfile: false\n",
      );
      expect(() => assertBuildPathBins(dir)).toThrow(/node_modules\/\.pnpm/);
      mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
      expect(() => assertBuildPathBins(dir)).toThrow(/node_modules\/\.pnpm/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('엄격 YAML은 % 지시문(%YAML · %TAG)을 거부한다 (%YAML 1.1이면 검사와 pnpm이 no · off를 다르게 읽는다)', () => {
    expect(() => parseStrictYaml('%YAML 1.1\n---\na: no\n', 'x')).toThrow(/x의 YAML.*지시문/);
    expect(() => parseStrictYaml('%TAG !e! tag:example.com,2000:\n---\na: 1\n', 'x')).toThrow(
      /지시문/,
    );
    expect(parseStrictYaml('---\na: no\n', 'x')).toEqual({ a: 'no' });
  });
});

describe('판정 입력 지문 (검토 1회차)', () => {
  it('vitest 진입 파일은 package.json bin에서 정하고 패키지 폴더 안이어야 하며, node_modules/vitest를 다른 사본으로 바꾸면 바뀐 항목이다 (#146)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-fingerprint-'));
    try {
      const put = (rel: string, body: string): void => {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), body);
      };
      const store = 'node_modules/.pnpm';
      const vitest = `${store}/vitest@5/node_modules/vitest`;
      const manifest = (bin: unknown): string =>
        JSON.stringify({ name: 'vitest', version: '5', bin });
      put(`${vitest}/package.json`, manifest({ vitest: './vitest.mjs' }));
      put(`${vitest}/vitest.mjs`, "import './dist/cli.js';\n");
      put(`${vitest}/dist/cli.js`, 'export {};\n');
      put('outside.mjs', 'export {};\n');
      symlinkSync('.pnpm/vitest@5/node_modules/vitest', path.join(dir, 'node_modules/vitest'));
      const real = realpathSync(path.join(dir, vitest));
      expect(resolveRunnerEntry(dir)).toEqual({
        packageDir: real,
        entry: path.join(real, 'vitest.mjs'),
      });
      // 문자열 bin도 읽는다 (파일 이름을 하드코딩하지 않음)
      put(`${vitest}/package.json`, manifest('./dist/cli.js'));
      expect(resolveRunnerEntry(dir)?.entry).toBe(path.join(real, 'dist', 'cli.js'));
      // bin 없음 · 패키지 밖을 가리키는 bin · 링크로 밖을 가리키는 진입 파일은 찾지 못한 것이다
      put(`${vitest}/package.json`, manifest(undefined));
      expect(resolveRunnerEntry(dir)).toBeNull();
      put(`${vitest}/package.json`, manifest({ vitest: '../../../../outside.mjs' }));
      expect(resolveRunnerEntry(dir)).toBeNull();
      symlinkSync(path.join(dir, 'outside.mjs'), path.join(dir, vitest, 'linked.mjs'));
      put(`${vitest}/package.json`, manifest({ vitest: './linked.mjs' }));
      expect(resolveRunnerEntry(dir)).toBeNull();
      rmSync(path.join(dir, vitest, 'linked.mjs'));

      // 진입 파일 경로는 지문 항목이다: 같은 이름 · 버전 · 내용의 사본으로 링크를 바꾸면 runner:entry가 바뀐다
      put(`${vitest}/package.json`, manifest({ vitest: './vitest.mjs' }));
      const before = judgeInputFingerprint(dir, []);
      const copy = `${store}/vitest@5_copy/node_modules/vitest`;
      put(`${copy}/package.json`, manifest({ vitest: './vitest.mjs' }));
      put(`${copy}/vitest.mjs`, "import './dist/cli.js';\n");
      put(`${copy}/dist/cli.js`, 'export {};\n');
      rmSync(path.join(dir, 'node_modules/vitest'));
      symlinkSync('.pnpm/vitest@5_copy/node_modules/vitest', path.join(dir, 'node_modules/vitest'));
      expect(fingerprintChanges(before, judgeInputFingerprint(dir, []))).toEqual(['runner:entry']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('인수 테스트 · vitest와 그 의존성(pnpm 배치) · .bin/vitest · 판정 설정이 바뀌면 바뀐 항목을 돌려준다', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-fingerprint-'));
    try {
      const put = (rel: string, body: string): void => {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), body);
      };
      // pnpm 배치 흉내: .pnpm/<id>/node_modules/<이름> 실제 폴더, 의존성은 형제 링크, 최상위는 링크
      const store = 'node_modules/.pnpm';
      put(
        `${store}/vitest@5/node_modules/vitest/package.json`,
        JSON.stringify({ name: 'vitest', version: '5', dependencies: { chai: '1' } }),
      );
      put(`${store}/vitest@5/node_modules/vitest/dist/index.js`, 'export const expect = 1;\n');
      put(
        `${store}/chai@1/node_modules/chai/package.json`,
        JSON.stringify({ name: 'chai', version: '1' }),
      );
      put(`${store}/chai@1/node_modules/chai/index.js`, 'export const assert = 1;\n');
      symlinkSync(
        '../../chai@1/node_modules/chai',
        path.join(dir, store, 'vitest@5/node_modules/chai'),
      );
      symlinkSync('.pnpm/vitest@5/node_modules/vitest', path.join(dir, 'node_modules/vitest'));
      put('node_modules/.bin/vitest', '#!/bin/sh\nexec node vitest.mjs "$@"\n');
      put('bive-acceptance/RULE-001/a.acc.ts', "it('a', () => {});\n");
      put('judge/vitest.config.mjs', 'export default {};\n');
      const files = [path.join(dir, 'judge/vitest.config.mjs')];
      const before = judgeInputFingerprint(dir, files);
      expect(Object.keys(before).sort()).toEqual([
        'bive-acceptance/RULE-001/a.acc.ts',
        'judge:vitest.config.mjs',
        'runner:.bin/vitest',
        'runner:chai@1/index.js',
        'runner:chai@1/package.json',
        'runner:entry',
        'runner:vitest@5/dist/index.js',
        'runner:vitest@5/package.json',
      ]);
      expect(fingerprintChanges(before, judgeInputFingerprint(dir, files))).toEqual([]);
      put(`${store}/chai@1/node_modules/chai/index.js`, 'export const assert = () => true;\n');
      put('node_modules/.bin/vitest', '#!/bin/sh\nexit 0\n');
      put('bive-acceptance/RULE-001/b.acc.ts', "it('b', () => {});\n");
      put('judge/vitest.config.mjs', 'export default { test: { include: [] } };\n');
      expect(fingerprintChanges(before, judgeInputFingerprint(dir, files))).toEqual([
        'bive-acceptance/RULE-001/b.acc.ts',
        'judge:vitest.config.mjs',
        'runner:.bin/vitest',
        'runner:chai@1/index.js',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('패키지 안 node_modules에 심은 의존성 사본 · 인수 테스트 폴더의 node_modules · 링크도 바뀐 항목이다 (검토 2회차)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bive-fingerprint-'));
    try {
      const put = (rel: string, body: string): void => {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), body);
      };
      const store = 'node_modules/.pnpm';
      const vitest = `${store}/vitest@5/node_modules/vitest`;
      put(
        `${vitest}/package.json`,
        JSON.stringify({ name: 'vitest', version: '5', dependencies: { 'std-env': '1' } }),
      );
      put(`${vitest}/dist/index.js`, "import 'std-env';\n");
      put(
        `${store}/std-env@1/node_modules/std-env/package.json`,
        JSON.stringify({ name: 'std-env', version: '1' }),
      );
      put(`${store}/std-env@1/node_modules/std-env/index.js`, 'export const isCI = true;\n');
      symlinkSync(
        '../../std-env@1/node_modules/std-env',
        path.join(dir, store, 'vitest@5/node_modules/std-env'),
      );
      symlinkSync('.pnpm/vitest@5/node_modules/vitest', path.join(dir, 'node_modules/vitest'));
      put('node_modules/.bin/vitest', '#!/bin/sh\n');
      put('bive-acceptance/RULE-001/a.acc.ts', "it('a', () => {});\n");
      const before = judgeInputFingerprint(dir, []);
      // Node는 vitest/dist의 맨 이름 import를 형제 링크보다 vitest/node_modules에서 먼저 찾는다
      put(
        `${vitest}/node_modules/std-env/package.json`,
        JSON.stringify({ name: 'std-env', version: '1' }),
      );
      put(
        `${vitest}/node_modules/std-env/index.js`,
        'export const isCI = true; /* 결과 파일 변조 */\n',
      );
      put(`${vitest}/node_modules/.bin/x`, '#!/bin/sh\n');
      // 인수 테스트가 import 'vitest'를 찾을 때 먼저 보는 자리
      put('bive-acceptance/node_modules/vitest/index.js', 'export const it = () => {};\n');
      symlinkSync('../../src', path.join(dir, 'bive-acceptance/RULE-001/linked'));
      expect(fingerprintChanges(before, judgeInputFingerprint(dir, []))).toEqual([
        'bive-acceptance/RULE-001/linked',
        'bive-acceptance/node_modules/vitest/index.js',
        'runner:vitest@5/node_modules/.bin/x',
        'runner:vitest@5/node_modules/std-env/index.js',
        'runner:vitest@5/node_modules/std-env/package.json',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
