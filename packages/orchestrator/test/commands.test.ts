// 명령 도구 허용 argv 템플릿 (이슈 #20 수용 기준 1 · 3, NFR-02 · NFR-04 · ADR-024 · ADR-052).
// 임시 워크트리의 node_modules/.bin에 가짜 실행 파일(Node 스크립트)을 두고 실제 execFile로 실행해,
// 받은 argv · cwd · 환경 변수를 확인한다. 목록 밖 명령 · 임의 인자는 실행 전에 거부돼야 한다.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ToolResult } from '../src/agent/adapter.js';
import { COMMAND_ENV_ALLOWLIST, planCommand, runCommand } from '../src/tools/commands.js';
import { createRoleTools, type FixedToolExecutor } from '../src/tools/executor.js';
import { PathGuard } from '../src/tools/path-guard.js';

const isWindows = process.platform === 'win32';

/**
 * 가짜 실행 파일: 받은 argv · cwd · 환경 변수를 JSON 한 줄로 출력하고 호출 기록 파일에 덧붙인다.
 * `-t` 값으로 동작을 바꾼다: `exit-3`(종료 코드 3) · `sleep`(오래 대기) · `flood`(긴 출력) ·
 * `ignore-term`(SIGTERM 무시, 자기 pid 기록) · `grandchild`(출력 통로를 물려받은 손자를 남기고 바로 끝남,
 * 손자 pid 기록).
 */
const FAKE_SCRIPT = (name: string, logFile: string): string => `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ bin: ${JSON.stringify(name)}, args }) + '\\n');
const t = args.indexOf('-t') >= 0 ? args[args.indexOf('-t') + 1] : undefined;
if (t === 'flood') process.stdout.write('x'.repeat(200000) + '\\nFLOOD_END\\n');
process.stdout.write(JSON.stringify({ bin: ${JSON.stringify(name)}, args, cwd: process.cwd(), env: process.env }) + '\\n');
if (t === 'exit-3') process.exit(3);
if (t === 'sleep') setTimeout(() => {}, 20000);
if (t === 'ignore-term') {
  fs.writeFileSync(${JSON.stringify(logFile)} + '.pid', String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
if (t === 'grandchild') {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => console.log("late"), 20000)'], { stdio: 'inherit' });
  fs.writeFileSync(${JSON.stringify(logFile)} + '.pid', String(child.pid));
  child.unref();
}
`;

/** 프로세스가 살아 있는지 */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface FakeRun {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

let root: string;
let home: string;
let logFile: string;
const tempDirs: string[] = [];

const makeTemp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};

const writeExecutable = (file: string, content: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  chmodSync(file, 0o755);
};

beforeEach(() => {
  home = makeTemp('bive-cmd-home-');
  root = path.join(home, 'work', 'p1', 'worktrees', 'r1');
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  writeFileSync(path.join(root, 'tests', 'a.test.ts'), '// 테스트\n');
  writeFileSync(path.join(root, 'tests', 'b.test.ts'), '// 테스트\n');
  logFile = path.join(home, 'calls.log');
  writeExecutable(
    path.join(root, 'node_modules', '.bin', 'vitest'),
    FAKE_SCRIPT('vitest', logFile),
  );
  writeExecutable(
    path.join(root, 'node_modules', '.bin', 'prisma'),
    FAKE_SCRIPT('prisma', logFile),
  );
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 가짜 실행 파일이 실제로 불린 기록. */
const calls = (): { bin: string; args: string[] }[] =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { bin: string; args: string[] })
    : [];

/** ignore-term 모드의 자식 · grandchild 모드의 손자 pid. 없으면 `null`. */
const readPid = (): number | null => {
  const file = `${logFile}.pid`;
  return existsSync(file) ? Number(readFileSync(file, 'utf8')) : null;
};

const waitUntil = async (condition: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('조건을 기다리다 시간 초과');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** 결과 본문에서 가짜 실행 파일의 JSON 출력을 꺼낸다. */
const fakeRun = (result: ToolResult): FakeRun => {
  const line = result.content.split('\n').find((l) => l.startsWith('{"bin"'));
  if (line === undefined) throw new Error(`가짜 실행 파일 출력 없음: ${result.content}`);
  return JSON.parse(line) as FakeRun;
};

const implementer = (
  options: Partial<Parameters<typeof createRoleTools>[0]['commands']> = {},
): FixedToolExecutor =>
  createRoleTools({ role: 'implementer', sessionRoot: root, biveHome: home, commands: options });

describe.skipIf(isWindows)('허용 argv 템플릿 실행 (셸 없는 spawn)', () => {
  it('run_tests는 인자 없이 node_modules/.bin/vitest run을 세션 루트에서 실행한다', async () => {
    const tools = implementer();
    const result = await tools.execute('run_tests', {});

    expect(result.status).toBe('ok');
    const run = fakeRun(result);
    expect(run.bin).toBe('vitest');
    expect(run.args).toEqual(['run']);
    expect(realpathSync(run.cwd)).toBe(root);
    expect(calls()).toEqual([{ bin: 'vitest', args: ['run'] }]);
  });

  it('run_tests는 허용 옵션(파일 · 이름 필터)만 템플릿 빈칸에 넣는다', async () => {
    const result = await implementer().execute('run_tests', {
      files: ['tests/a.test.ts', './tests/../tests/b.test.ts'],
      testNamePattern: '헬스 체크',
    });

    expect(result.status).toBe('ok');
    expect(fakeRun(result).args).toEqual([
      'run',
      '-t',
      '헬스 체크',
      'tests/a.test.ts',
      'tests/b.test.ts',
    ]);
  });

  it('셸 메타 문자는 해석되지 않고 인자 하나로 그대로 전달된다', async () => {
    const marker = path.join(home, 'pwned');
    const pattern = `x; touch ${marker} && echo $(id) | cat`;
    const result = await implementer().execute('run_tests', { testNamePattern: pattern });

    expect(result.status).toBe('ok');
    expect(fakeRun(result).args).toEqual(['run', '-t', pattern]);
    expect(existsSync(marker)).toBe(false);
  });

  it('prisma_generate는 prisma generate, prisma_migrate는 prisma migrate deploy로 고정이다', async () => {
    const tools = implementer();
    const generate = await tools.execute('prisma_generate', {});
    const migrate = await tools.execute('prisma_migrate', {});

    expect(generate.status).toBe('ok');
    expect(fakeRun(generate).args).toEqual(['generate']);
    expect(migrate.status).toBe('ok');
    expect(fakeRun(migrate).args).toEqual(['migrate', 'deploy']);
    expect(calls().map((call) => call.args)).toEqual([['generate'], ['migrate', 'deploy']]);
  });

  it('install_package는 허용 목록에 있는 패키지만 pnpm add로 설치한다 (스크립트 끔)', async () => {
    const fakeBin = makeTemp('bive-fake-pnpm-');
    writeExecutable(path.join(fakeBin, 'pnpm'), FAKE_SCRIPT('pnpm', logFile));
    const tools = implementer({
      installAllowlist: ['left-pad'],
      baseEnv: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` },
    });

    const result = await tools.execute('install_package', { name: 'left-pad' });

    expect(result.status).toBe('ok');
    expect(fakeRun(result).args).toEqual(['add', '--save-exact', '--ignore-scripts', 'left-pad']);
    const other = await tools.execute('install_package', { name: 'lodash' });
    expect(other).toMatchObject({ status: 'denied', reason: 'not_allowed' });
    expect(calls()).toHaveLength(1);
  });

  it('자식 프로세스에는 허용 목록 환경 변수와 오케스트레이터가 정한 값만 넘어간다', async () => {
    const tools = implementer({
      baseEnv: {
        PATH: process.env.PATH,
        HOME: home,
        DATABASE_URL: 'file:./original.db',
        ANTHROPIC_API_KEY: 'sk-secret',
        GITHUB_TOKEN: 'ghp-secret',
        NODE_OPTIONS: '--require /tmp/evil.js',
      },
      env: { DATABASE_URL: 'file:./judge.db' },
    });

    const env = fakeRun(await tools.execute('run_tests', {})).env;

    expect(env.DATABASE_URL).toBe('file:./judge.db');
    expect(env.HOME).toBe(home);
    expect(env.CI).toBe('1');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    const allowed = new Set<string>([
      ...COMMAND_ENV_ALLOWLIST,
      'DATABASE_URL',
      'CI',
      'NO_COLOR',
      'FORCE_COLOR',
    ]);
    // Node가 스스로 넣는 변수 외에는 허용 목록 밖 변수가 없다
    const extra = Object.keys(env).filter(
      (key) => !allowed.has(key) && !/^(_|PWD|SHLVL|OLDPWD)$/u.test(key),
    );
    expect(extra).toEqual([]);
  });

  it('DATABASE_URL은 원본 환경에서 물려받지 않고 오케스트레이터가 넘긴 값만 쓴다', async () => {
    const tools = implementer({
      baseEnv: {
        PATH: process.env.PATH,
        DATABASE_URL: 'file:/home/user/.bive/projects/p1/bive.db',
      },
    });

    const env = fakeRun(await tools.execute('run_tests', {})).env;

    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('0이 아닌 종료 코드는 error(nonzero_exit)이고 출력이 본문에 담긴다', async () => {
    const result = await implementer().execute('run_tests', { testNamePattern: 'exit-3' });

    expect(result).toMatchObject({ status: 'error', reason: 'nonzero_exit' });
    expect(result.content).toContain('종료 코드 3');
    expect(fakeRun(result).args).toEqual(['run', '-t', 'exit-3']);
  });

  it('타임아웃을 넘으면 프로세스를 멈추고 error(timeout)', async () => {
    const started = Date.now();
    const result = await implementer({ timeoutMs: { run_tests: 500 } }).execute('run_tests', {
      testNamePattern: 'sleep',
    });

    expect(result).toMatchObject({ status: 'error', reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('SIGTERM을 무시하는 자식은 유예 뒤 SIGKILL로 멈추고 결과는 timeout', async () => {
    const started = Date.now();
    const result = await implementer({ timeoutMs: { run_tests: 500 }, killGraceMs: 300 }).execute(
      'run_tests',
      { testNamePattern: 'ignore-term' },
    );

    expect(result).toMatchObject({ status: 'error', reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = readPid();
    expect(pid).not.toBeNull();
    await waitUntil(() => !alive(pid as number));
  });

  it('출력 통로를 물려받은 손자가 있어도 자식이 끝나면 바로 결과를 내고 손자를 정리한다', async () => {
    const started = Date.now();
    const result = await implementer({ timeoutMs: { run_tests: 10_000 } }).execute('run_tests', {
      testNamePattern: 'grandchild',
    });

    expect(result.status).toBe('ok');
    expect(Date.now() - started).toBeLessThan(5_000);
    const grandchild = readPid();
    expect(grandchild).not.toBeNull();
    await waitUntil(() => !alive(grandchild as number));
    expect(result.content).not.toContain('late');
  });

  it('출력은 상한 크기의 끝부분만 돌려준다', async () => {
    const result = await implementer({ outputLimitBytes: 4096 }).execute('run_tests', {
      testNamePattern: 'flood',
    });

    expect(result.status).toBe('ok');
    expect(Buffer.byteLength(result.content)).toBeLessThan(4096 + 300);
    expect(result.content).toContain('마지막 4096바이트만 표시');
    expect(result.content).toContain('"bin":"vitest"');
  });

  it('실행 파일이 없으면 error(command_unavailable)', async () => {
    rmSync(path.join(root, 'node_modules'), { recursive: true });
    const result = await implementer().execute('prisma_generate', {});

    expect(result).toMatchObject({ status: 'error', reason: 'command_unavailable' });
  });

  it('세션 중단 신호를 받으면 실행 중인 명령을 멈춘다', async () => {
    const controller = new AbortController();
    const pending = implementer({ signal: controller.signal }).execute('run_tests', {
      testNamePattern: 'sleep',
    });
    setTimeout(() => controller.abort(), 300);

    const result = await pending;

    expect(result).toMatchObject({ status: 'error', reason: 'aborted' });
  });

  it('.bin 실행 파일이 의존성 폴더 밖을 가리키면 실행하지 않는다', async () => {
    const outsideBin = makeTemp('bive-outside-bin-');
    writeExecutable(path.join(outsideBin, 'evil'), FAKE_SCRIPT('evil', logFile));
    const bin = path.join(root, 'node_modules', '.bin', 'vitest');
    rmSync(bin);
    symlinkSync(path.join(outsideBin, 'evil'), bin);

    const result = await implementer().execute('run_tests', {});

    expect(result).toMatchObject({ status: 'error', reason: 'command_unavailable' });
    expect(calls()).toEqual([]);
  });

  it('없는 테스트 파일은 넘기지 않는다', async () => {
    const result = await implementer().execute('run_tests', { files: ['./--config=evil.ts'] });

    expect(result).toMatchObject({ status: 'error', reason: 'not_found' });
    expect(calls()).toEqual([]);
  });
});

describe('목록 밖 명령 · 임의 인자 거부', () => {
  it.each([
    ['bash', { command: 'rm -rf /' }],
    ['shell', { cmd: 'ls' }],
    ['exec', { file: 'node', args: ['-e', '1'] }],
    ['npx', { package: 'vitest' }],
    ['run_command', { argv: ['node_modules/.bin/vitest', 'run'] }],
    ['Bash', { command: 'id' }],
  ])('목록 밖 명령 %s는 denied(unknown_tool)이고 아무것도 실행하지 않는다', async (name, args) => {
    const result = await implementer().execute(name, args);

    expect(result).toMatchObject({ status: 'denied', reason: 'unknown_tool' });
    expect(calls()).toEqual([]);
  });

  it.each([
    ['run_tests', { reporter: 'json' }],
    ['run_tests', { args: ['--config', 'evil.config.ts'] }],
    ['run_tests', { files: ['--config=evil.config.ts'] }],
    ['run_tests', { files: ['-c', 'evil.config.ts'] }],
    ['run_tests', { testNamePattern: '--globalSetup=evil.ts' }],
    ['run_tests', { files: 'tests/a.test.ts' }],
    ['run_tests', { watch: true }],
    ['prisma_generate', { schema: '../other/schema.prisma' }],
    ['prisma_migrate', { command: 'reset' }],
    ['prisma_migrate', { args: ['--force'] }],
    ['install_package', { name: 'left-pad', registry: 'https://evil.example' }],
    ['install_package', {}],
  ])('%s의 임의 인자 %j는 denied(invalid_args)', async (name, args) => {
    const result = await implementer({ installAllowlist: ['left-pad'] }).execute(name, args);

    expect(result).toMatchObject({ status: 'denied', reason: 'invalid_args' });
    expect(calls()).toEqual([]);
  });

  it('run_tests의 파일 인자도 경로 가드를 거친다', async () => {
    const tools = implementer();
    for (const file of ['../../../../calls.log', path.join(home, 'calls.log'), '.git/hooks/x']) {
      const result = await tools.execute('run_tests', { files: [file] });
      expect(result).toMatchObject({ status: 'denied', reason: 'path_denied' });
    }
    expect(calls()).toEqual([]);
  });

  it('install_package는 기본 허용 목록이 비어 있어 항상 거부된다', async () => {
    const tools = implementer();
    for (const name of ['left-pad', 'vitest', 'prisma']) {
      const result = await tools.execute('install_package', { name });
      expect(result).toMatchObject({ status: 'denied', reason: 'not_allowed' });
    }
    expect(calls()).toEqual([]);
  });

  it('허용 목록에 있어도 경로 · URL · git 지정자는 invalid_args', () => {
    const guard = new PathGuard({ role: 'implementer', sessionRoot: root, biveHome: home });
    const allowlist = ['../evil', 'file:../evil', 'git+https://x/y.git', '-g', 'https://x/y.tgz'];
    for (const name of allowlist) {
      const planned = planCommand(
        'install_package',
        { name },
        { cwd: root, guard, installAllowlist: allowlist },
      );
      expect(planned.ok).toBe(false);
      if (!planned.ok) expect(planned.result.reason).toBe('invalid_args');
    }
  });

  it('test-writer에는 prisma · 설치 도구가 없다', async () => {
    const session = path.join(home, 'work', 'p1', 'sessions', 's1');
    mkdirSync(session, { recursive: true });
    const tools = createRoleTools({ role: 'test-writer', sessionRoot: session, biveHome: home });
    for (const name of ['prisma_generate', 'prisma_migrate', 'install_package']) {
      const result = await tools.execute(name, {});
      expect(result).toMatchObject({ status: 'denied', reason: 'unknown_tool' });
    }
  });
});

describe('Windows 실행 파일 해석', () => {
  it('win32에서는 .cmd 대신 패키지 bin 항목의 스크립트를 현재 Node로 실행한다', async () => {
    rmSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    const pkg = path.join(root, 'node_modules', 'vitest');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'vitest', bin: { vitest: './vitest.cjs' } }),
    );
    writeFileSync(path.join(pkg, 'vitest.cjs'), FAKE_SCRIPT('vitest', logFile));
    const guard = new PathGuard({ role: 'implementer', sessionRoot: root, biveHome: home });

    const planned = planCommand('run_tests', {}, { cwd: root, guard, platform: 'win32' });
    expect(planned).toMatchObject({
      ok: true,
      plan: { file: process.execPath, args: [path.join(pkg, 'vitest.cjs'), 'run'] },
    });

    const outcome = await runCommand('run_tests', {}, { cwd: root, guard, platform: 'win32' });
    expect(outcome.summary).toBe('node_modules/.bin/vitest run');
    expect(fakeRun(outcome.result).args).toEqual(['run']);
  });

  it('win32의 install_package는 지원하지 않는다', () => {
    const guard = new PathGuard({ role: 'implementer', sessionRoot: root, biveHome: home });
    const planned = planCommand(
      'install_package',
      { name: 'left-pad' },
      { cwd: root, guard, platform: 'win32', installAllowlist: ['left-pad'] },
    );
    expect(planned).toMatchObject({ ok: false, result: { reason: 'unsupported_platform' } });
  });
});

describe.skipIf(isWindows)('명령 도구 호출 기록', () => {
  it('실행한 명령은 argv 요약, 거부된 명령은 요청 요약으로 시각 · 결과와 함께 기록된다', async () => {
    const seen: unknown[] = [];
    const tools = createRoleTools({
      role: 'implementer',
      sessionRoot: root,
      biveHome: home,
      sessionId: 'sess-1',
      hooks: { onToolCall: (record) => seen.push(record) },
    });

    await tools.execute('run_tests', { files: ['tests/a.test.ts'] });
    await tools.execute('run_tests', { testNamePattern: 'exit-3' });
    await tools.execute('install_package', { name: 'left-pad' });
    await tools.execute('bash', { command: 'id' });

    expect(
      tools.records.map(({ name, argsSummary, status, reason }) => ({
        name,
        argsSummary,
        status,
        reason,
      })),
    ).toEqual([
      {
        name: 'run_tests',
        argsSummary: 'node_modules/.bin/vitest run tests/a.test.ts',
        status: 'ok',
        reason: undefined,
      },
      {
        name: 'run_tests',
        argsSummary: 'node_modules/.bin/vitest run -t exit-3',
        status: 'error',
        reason: 'nonzero_exit',
      },
      {
        name: 'install_package',
        argsSummary: 'install_package {"name":"left-pad"}',
        status: 'denied',
        reason: 'not_allowed',
      },
      { name: 'bash', argsSummary: '{"command":"id"}', status: 'denied', reason: 'unknown_tool' },
    ]);
    for (const record of tools.records) {
      expect(record.role).toBe('implementer');
      expect(record.sessionId).toBe('sess-1');
      expect(new Date(record.at).toISOString()).toBe(record.at);
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(seen).toEqual(tools.records);
  });
});
