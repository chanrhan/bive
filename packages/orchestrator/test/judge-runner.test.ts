// 판정 러너 (M1-24 수용 기준, JDG-01 · ADR-026 · ADR-051).
// scripts/reset-fixture.sh로 만든 픽스처 복사본 하나에서 여러 판정을 순서대로 돌린다(서버 빌드는 1회).
// 제한: afterAll 정리 120초(부하 평균 12 이상에서 픽스처 node_modules 삭제가 기본 10초를 넘었다), 남은 프로세스 확인은
// SIGKILL 뒤 3초까지 폴링, 임시 DB는 이 파일 전용 폴더에 만들어 같은 VM의 다른 판정 테스트와 섞지 않는다 (#122, ADR-064).
import { execFileSync } from 'node:child_process';
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

import { installDependencies } from '../src/judge/checkout.js';
import { fingerprintChanges, judgeInputFingerprint } from '../src/judge/fingerprint.js';
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
});

describe('판정 입력 지문 (검토 1회차)', () => {
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
