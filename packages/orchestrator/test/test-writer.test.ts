// 테스트 작성 역할 · Red 확인 (M1-15 수용 기준, RUN-03 · RUN-04 · JDG-01 · NFR-02 · ADR-024 · ADR-026 · ADR-068).
// 픽스처 git 복사본 · 실제 git · 실제 SQLite · ScriptedAdapter(실제 고정 도구 · 경로 가드) · 실제 테스트 작성 실행기.
// Red 확인은 대부분 판정 · 설치를 주입해 빠르게 돌리고(체크아웃은 실제 git), `실제 판정` 묶음만 픽스처 체크아웃에
// 의존성을 설치하고 실제 판정 러너(next build · next start · vitest)로 돈다. 구현 단계는 시험용 실행기로 멈춘다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Rule, RunStatus, StepKind, TestCaseStatus } from '@bive/shared';
import type { RunDetail } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentAdapter, SessionSpec } from '../src/agent/adapter.js';
import { loadScenario } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import { DEFAULT_STEP_EXECUTORS, PipelineEngine } from '../src/engine/pipeline-engine.js';
import type { StepExecutor, StepExecutors } from '../src/engine/types.js';
import {
  ACCEPTANCE_DECLARATION_FILES,
  ACCEPTANCE_ENV_DECLARATION,
  ACCEPTANCE_HTTP_DECLARATION,
} from '../src/judge/acceptance-env.js';
import {
  ACCEPTANCE_IMPORT_ALLOWLIST,
  BIVE_HTTP_HELPER_MODULE,
  lintAcceptanceSource,
} from '../src/judge/acceptance-lint.js';
import { hashAcceptanceFiles, installDependencies } from '../src/judge/checkout.js';
import { buildJudgeConfig } from '../src/judge/config.js';
import { parseVitestReport } from '../src/judge/report.js';
import {
  JudgeRunner,
  type JudgeRunInput,
  type JudgeRunResult,
  type JudgeRunStatus,
} from '../src/judge/runner.js';
import { createRun } from '../src/runs/run-service.js';
import { createRedCheckExecutor, JUDGE_RUNNER_ERROR_REASON } from '../src/steps/red-check.js';
import { createTestWritingExecutor } from '../src/steps/test-writing.js';
import { exportedMethods, listAppRoutes } from '../src/test-writer/inputs.js';
import {
  copyFixture,
  human,
  newId,
  scripted,
  seedProject,
  type SeededProject,
  T0,
  TEST_SCENARIOS_DIR,
  userGit,
  withProject,
} from './helpers/engine-harness.js';
import { cleanup, makeBiveHome } from './helpers/process.js';

const temps: string[] = [];
const engines: PipelineEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── 도우미 ─────────────────────────────────────────────

/** 판정 · 설치를 주입한 Red 확인의 판정 계획 한 칸. */
type JudgePlan = 'red' | 'passed' | 'skipped' | 'collect_error' | 'runner_error';

/** 주입한 판정이 본 체크아웃 상태. */
interface JudgeCall {
  input: JudgeRunInput;
  head: string;
  /** 체크아웃의 `bive-acceptance/` 아래 파일 */
  acceptance: string[];
  planted: boolean;
  plantedDependency: boolean;
  installed: boolean;
  nodeModulesIsLink: boolean;
  /** 미추적 · 무시된 파일 (`git status --ignored`) */
  status: string;
}

/** 세션 시작 때의 작업 디렉터리 모습. */
interface SessionSnapshot {
  role: SessionSpec['role'];
  workDir: string;
  prompt: string;
  /** 작업 디렉터리 기준 상대 경로 (폴더는 끝에 `/`) */
  entries: string[];
}

const listTree = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(full);
      } else out.push(rel);
    }
  };
  walk(root);
  return out.sort();
};

const acceptanceFilesIn = (dir: string): string[] =>
  fs.existsSync(path.join(dir, 'bive-acceptance'))
    ? listTree(path.join(dir, 'bive-acceptance')).filter((entry) => !entry.endsWith('/'))
    : [];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const FAKE_INSTALL_MARKER = '.bive-fake-install';

/** 주입한 설치: 체크아웃 `node_modules`에 표시 파일만 둔다. */
const fakeInstall = (dir: string): Promise<void> => {
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', FAKE_INSTALL_MARKER), '');
  return Promise.resolve();
};

/** 판정 러너 결과 모양 (주입한 판정용). 케이스는 대상 규칙 폴더의 첫 파일에 붙인다. */
const judgeResult = (
  input: JudgeRunInput,
  status: JudgeRunStatus,
  caseStatuses: readonly TestCaseStatus[],
): JudgeRunResult => {
  const ruleId = input.ruleIds?.[0] ?? 'RULE-001';
  const file =
    acceptanceFilesIn(input.worktreeDir)
      .map((rel) => `bive-acceptance/${rel}`)
      .find((rel) => rel.startsWith(`bive-acceptance/${ruleId}/`)) ??
    `bive-acceptance/${ruleId}/x.acc.ts`;
  const cases = caseStatuses.map((caseStatus, index) => ({
    name: `케이스 ${String(index + 1)}`,
    file,
    line: index + 1,
    status: caseStatus,
    message: caseStatus === 'failed' ? '실패' : null,
  }));
  const count = (s: TestCaseStatus) => cases.filter((c) => c.status === s).length;
  const dir = '/판정/폴더';
  const problems =
    status === 'completed'
      ? []
      : [{ file: status === 'collect_error' ? file : null, message: `${status} 원인` }];
  return {
    status,
    runner: 'vitest',
    profile: input.profile,
    projectId: input.projectId,
    runId: input.runId,
    judgeId: newId(),
    ruleIds: input.ruleIds === undefined ? null : [...input.ruleIds],
    exitCode: status === 'completed' ? 1 : null,
    cases,
    summary: {
      files: 1,
      total: cases.length,
      passed: count('passed'),
      failed: count('failed'),
      skipped: cases.length - count('passed') - count('failed'),
    },
    problems,
    message: status === 'completed' ? null : `${status} 원인`,
    reporterPath: null,
    paths: {
      dir,
      config: dir,
      collectConfig: dir,
      globalSetup: dir,
      httpHelper: dir,
      result: dir,
      collectResult: dir,
      collectLog: dir,
      stdout: dir,
      stderr: dir,
      profileLog: dir,
      serverLog: dir,
    },
    server: null,
    timings: {},
    startedAt: new Date(T0).toISOString(),
    endedAt: new Date(T0).toISOString(),
  };
};

/** 계획대로 결과를 내는 판정. 다 쓰면 마지막을 반복한다. 호출마다 체크아웃 상태를 기록한다. */
const plannedJudge = (plan: readonly JudgePlan[], calls: JudgeCall[]) => {
  return (input: JudgeRunInput): Promise<JudgeRunResult> => {
    const dir = input.worktreeDir;
    const nodeModules = path.join(dir, 'node_modules');
    calls.push({
      input,
      head: git(dir, 'rev-parse', 'HEAD'),
      acceptance: acceptanceFilesIn(dir),
      planted: fs.existsSync(path.join(dir, 'src', 'planted', 'evil.ts')),
      plantedDependency: fs.existsSync(path.join(nodeModules, '.planted-dependency')),
      installed: fs.existsSync(path.join(nodeModules, FAKE_INSTALL_MARKER)),
      nodeModulesIsLink:
        fs.lstatSync(nodeModules, { throwIfNoEntry: false })?.isSymbolicLink() ?? false,
      status: git(dir, 'status', '--porcelain', '--ignored', '--untracked-files=all'),
    });
    const step = plan[Math.min(calls.length - 1, plan.length - 1)] ?? 'red';
    switch (step) {
      case 'red':
        return Promise.resolve(judgeResult(input, 'completed', ['failed', 'failed']));
      case 'passed':
        return Promise.resolve(judgeResult(input, 'completed', ['failed', 'passed']));
      case 'skipped':
        return Promise.resolve(judgeResult(input, 'completed', ['failed', 'skipped']));
      case 'collect_error':
        return Promise.resolve(judgeResult(input, 'collect_error', []));
      case 'runner_error':
        return Promise.resolve(judgeResult(input, 'runner_error', []));
    }
  };
};

interface Harness extends SeededProject {
  biveHome: string;
  repo: string;
  runId: string;
  rules: Rule[];
  engine: PipelineEngine;
  sessions: SessionSnapshot[];
  judgeCalls: JudgeCall[];
}

interface SetupOptions {
  scenario?: string;
  scenariosDir?: string;
  /** 주입한 판정 계획. `real`이면 실제 설치 · 판정 러너 */
  judge?: readonly JudgePlan[] | 'real';
  /** 대상 규칙을 하나 더 (RULE-002) */
  secondRule?: boolean;
  /** 실행 시작 전 저장소를 고치고 커밋한다 */
  prepareRepo?: (repo: string) => void;
  /** 테스트 작성 실행기 감싸기 (실행 워크트리에 무시된 파일 심기 등) */
  wrapTestWriting?: (inner: StepExecutor) => StepExecutor;
}

/** 프로젝트 · 실행을 만들고 엔진을 준비한다. 구현 단계는 시험용 실행기가 실행을 끝낸다(`scripted_halt`). */
const setup = (options: SetupOptions = {}): Harness => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  if (options.prepareRepo !== undefined) {
    options.prepareRepo(repo);
    userGit(repo, 'add', '--all');
    userGit(repo, 'commit', '-q', '-m', 'fixture: 시험 준비');
  }
  const seeded = seedProject(biveHome, repo);
  const rules = [seeded.rule];
  if (options.secondRule === true) {
    rules.push(
      withProject(biveHome, seeded.project.id, (store) =>
        store.rules.create({
          id: newId(),
          title: '헬스 체크 버전',
          statement:
            'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 응답 JSON의 version 필드에 버전을 담는다',
          kind: seeded.rule.kind,
          checkKinds: seeded.rule.checkKinds,
          parentRequirementId: seeded.rule.parentRequirementId,
          builtin: false,
          targetBlockIds: [],
          risk: null,
          contractId: null,
          author: seeded.rule.author,
          normState: 'approved',
          createdAt: new Date(T0).toISOString(),
        }),
      ),
    );
  }
  const scripted0 = new ScriptedAdapter({
    scenario: loadScenario(options.scenario ?? 'happy-path', options.scenariosDir),
    biveHome,
    pollIntervalMs: 20,
  });
  const sessions: SessionSnapshot[] = [];
  const adapter: AgentAdapter = {
    kind: scripted0.kind,
    startSession: (spec) => {
      sessions.push({
        role: spec.role,
        workDir: spec.workDir,
        prompt: spec.prompt,
        entries: listTree(spec.workDir),
      });
      return scripted0.startSession(spec);
    },
  };
  const judgeCalls: JudgeCall[] = [];
  const red =
    options.judge === 'real'
      ? createRedCheckExecutor({ judgeTimeoutMs: 240_000 })
      : createRedCheckExecutor({
          judge: plannedJudge(options.judge ?? ['red'], judgeCalls),
          installDependencies: fakeInstall,
        });
  const testWriting = createTestWritingExecutor();
  const executors: StepExecutors = {
    test_writing: options.wrapTestWriting?.(testWriting) ?? testWriting,
    red_check: red,
    implementation: scripted(['halt']),
    check: scripted(['passed']),
    merge: scripted(['passed']),
  };
  const engine = new PipelineEngine({ biveHome, agent: adapter, executors });
  engines.push(engine);
  const runId = withProject(biveHome, seeded.project.id, (store) =>
    createRun(
      store,
      { ruleIds: rules.map((rule) => rule.id), author: human },
      { clientId: null },
      { now: Date.now, newId },
    ),
  ).run.id;
  return { ...seeded, biveHome, repo, runId, rules, engine, sessions, judgeCalls };
};

const detailOf = (h: Harness): RunDetail =>
  withProject(h.biveHome, h.project.id, (store) => {
    const detail = store.runs.getDetail(h.runId);
    if (detail === null) throw new Error('실행 없음');
    return detail;
  });

const runToEnd = async (h: Harness): Promise<RunDetail> => {
  expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
  await h.engine.settled();
  return detailOf(h);
};

const attempts = (detail: RunDetail, ...kinds: StepKind[]): string[] =>
  detail.steps
    .filter((step) => kinds.length === 0 || kinds.includes(step.kind))
    .map((step) => `${step.kind}#${String(step.attempt)}:${step.status}`);

const exitOf = (detail: RunDetail, kind: StepKind, attempt: number): Record<string, unknown> => {
  const step = detail.steps.find((s) => s.kind === kind && s.attempt === attempt);
  if (step === undefined) throw new Error(`단계 없음: ${kind}#${String(attempt)}`);
  return step.exitDetail as Record<string, unknown>;
};

const toolCallsOf = (h: Harness) =>
  withProject(h.biveHome, h.project.id, (store) => store.sessions.toolCalls(h.runId));

const sessionsOf = (h: Harness, role: SessionSpec['role']) =>
  withProject(h.biveHome, h.project.id, (store) =>
    store.sessions.listByRun(h.runId).filter((s) => s.role === role),
  );

/** 커밋이 바꾼 파일. */
const changedIn = (repo: string, commit: string): string[] =>
  git(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', `${commit}^`, commit)
    .split('\n')
    .filter((line) => line !== '')
    .sort();

const expectRun = (detail: RunDetail, status: RunStatus, failureReason: string | null): void => {
  expect(detail.run).toMatchObject({ status, failureReason });
};

const LEGACY_ACC =
  "import { expect, it } from 'vitest';\n\nit('기존 규칙', () => {\n  expect(1).toBe(1);\n});\n";

/** 기존 인수 테스트(다른 규칙) · 그 옆 메모 · 소스를 가리키는 링크를 커밋해 둔다. */
const addLegacyAcceptance = (repo: string): void => {
  const dir = path.join(repo, 'bive-acceptance', 'RULE-900');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'legacy.acc.ts'), LEGACY_ACC);
  fs.writeFileSync(path.join(dir, 'notes.md'), '메모');
  fs.symlinkSync('../../src/lib/db.ts', path.join(dir, 'linked.acc.ts'));
};

// ── 수용 기준 1: 세션 작업 디렉터리 · 쓰기 범위 ─────────────────

describe('세션 작업 디렉터리 · 쓰기 범위 (수용 기준 1, ADR-024)', () => {
  it('세션 디렉터리에는 규칙 진술 · 라우트 목록 · Prisma 스키마 · 기존 인수 테스트 사본만 있다', async () => {
    const h = setup({
      scenario: 'test-writer-guard',
      scenariosDir: TEST_SCENARIOS_DIR,
      prepareRepo: addLegacyAcceptance,
    });
    const done = await runToEnd(h);
    expect(attempts(done, 'test_writing', 'red_check')).toEqual([
      'test_writing#1:passed',
      'red_check#1:passed',
    ]);

    const session = h.sessions.find((s) => s.role === 'test-writer');
    expect(session).toBeDefined();
    if (session === undefined) return;
    // 허용 입력 사본만: 소스 · 설정 · node_modules · .git · .bive.json 없음, 메모 · 링크는 복사하지 않음
    expect(session.entries).toEqual([
      'bive-acceptance/',
      'bive-acceptance/RULE-900/',
      'bive-acceptance/RULE-900/legacy.acc.ts',
      'prisma/',
      'prisma/schema.prisma',
      'routes.md',
      'rules/',
      'rules/RULE-001.md',
    ]);
    // 세션 디렉터리는 실행 워크트리 밖 `$BIVE_HOME/work/<projectId>/sessions/` 아래이고 단계가 끝나면 지운다
    const worktree = String(done.run.worktreePath);
    expect(
      session.workDir.startsWith(path.join(h.biveHome, 'work', h.project.id, 'sessions')),
    ).toBe(true);
    expect(session.workDir.startsWith(worktree)).toBe(false);
    expect(fs.existsSync(session.workDir)).toBe(false);

    // 입력 내용: 규칙 진술 · 라우트 목록(경로 · 메서드) · 스키마 사본 · 기존 테스트 사본
    expect(session.prompt).toContain(h.rule.statement);
    expect(session.prompt).toContain('bive-acceptance/RULE-001/');
    const listCall = toolCallsOf(h).find((call) => call.name === 'list_files');
    expect(listCall?.status).toBe('ok');

    // 쓰기는 대상 규칙 폴더만: 루트 밖 · 소스 · 다른 규칙 폴더 · bive-acceptance 바로 아래 · 입력 사본은 거부
    const byPath = toolCallsOf(h)
      .filter((call) => call.name === 'write_file' || call.name === 'read_file')
      .map(
        (call) =>
          `${call.name} ${call.argsSummary} ${call.status}${call.reason === null ? '' : `:${call.reason}`}`,
      );
    expect(byPath).toEqual([
      'read_file src/app/api/health/route.ts error:not_found',
      'read_file ../outside.txt denied:path_denied',
      'write_file src/app/api/health/route.ts denied:path_denied',
      'write_file bive-acceptance/RULE-900/legacy.acc.ts denied:path_denied',
      'write_file bive-acceptance/top.acc.ts denied:path_denied',
      'write_file rules/RULE-001.md denied:path_denied',
      'write_file bive-acceptance/RULE-001/health-time.acc.ts ok',
      'write_file bive-acceptance/RULE-001/notes.md ok',
    ]);

    // 워크트리로 옮긴 것: 대상 규칙의 *.acc.ts와 BIVE 선언 파일뿐 (메모 · 다른 규칙 · 소스 변경 없음)
    const writing = done.steps.find((s) => s.kind === 'test_writing');
    expect(writing?.commit).toBe(done.run.headCommit);
    expect(changedIn(h.repo, String(writing?.commit))).toEqual([
      'bive-acceptance/RULE-001/health-time.acc.ts',
      ACCEPTANCE_ENV_DECLARATION,
      ACCEPTANCE_HTTP_DECLARATION,
    ]);
    expect(exitOf(done, 'test_writing', 1)).toMatchObject({
      ruleIds: ['RULE-001'],
      ignoredFiles: ['bive-acceptance/RULE-001/notes.md'],
    });
    for (const [rel, content] of Object.entries(ACCEPTANCE_DECLARATION_FILES)) {
      expect(fs.readFileSync(path.join(worktree, rel), 'utf8')).toBe(content);
    }
  }, 60_000);

  it('라우트 목록은 App Router 위치에서 경로 · 메서드만 만든다', () => {
    const repo = copyFixture(temps);
    const extra = path.join(repo, 'src', 'app', '(group)', 'api', 'items', '[id]');
    fs.mkdirSync(extra, { recursive: true });
    fs.writeFileSync(
      path.join(extra, 'route.ts'),
      'export async function GET() {}\nconst DELETE = () => null;\nexport { DELETE };\nexport const POST = () => null;\n',
    );
    fs.mkdirSync(path.join(repo, 'src', 'app', '_private'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'src', 'app', '_private', 'route.ts'),
      'export function GET() {}',
    );
    expect(listAppRoutes(repo).map((r) => `${r.kind} ${r.methods.join(',')} ${r.path}`)).toEqual([
      'page  /',
      'route GET /api/health',
      'route GET,POST,DELETE /api/items/[id]',
    ]);
    expect(exportedMethods('export { handler as PUT, other }')).toEqual(['PUT']);
  });
});

// ── 수용 기준 2: 종료 조건 (규칙마다 *.acc.ts · import 허용 목록) ─────────

describe('acceptance-lint import 허용 목록 (수용 기준 2, JDG-01)', () => {
  it('허용 목록은 vitest · BIVE HTTP 도우미 · node: 내장(코드 로드 · 파일 · DB 수단 제외)', () => {
    expect(ACCEPTANCE_IMPORT_ALLOWLIST.vitest).toEqual(['vitest']);
    expect(ACCEPTANCE_IMPORT_ALLOWLIST.helpers).toEqual([BIVE_HTTP_HELPER_MODULE]);
    expect(ACCEPTANCE_IMPORT_ALLOWLIST.nodeBuiltins).toEqual(
      expect.arrayContaining(['node:assert', 'node:crypto', 'node:url', 'node:timers/promises']),
    );
    for (const denied of [
      'node:fs',
      'node:child_process',
      'node:vm',
      'node:module',
      'node:sqlite',
    ]) {
      expect(ACCEPTANCE_IMPORT_ALLOWLIST.nodeBuiltins).not.toContain(denied);
    }
  });

  it('허용 import만 쓰면 문제 없음 (주석 · 문자열 · 정규식 · 템플릿 안 글자는 코드로 보지 않음)', () => {
    const source = [
      "import { describe, expect, inject, it } from 'vitest';",
      "import type { TestContext } from 'vitest';",
      "import { request } from '@bive/http';",
      "import { strict as assert } from 'node:assert';",
      "export { it as test } from 'vitest';",
      "// import x from '../src/secret';",
      "/* require('../src/x') */",
      'const s = "import y from \'../src/y\'";',
      "const re = /from '..\\/src'/;",
      "const t = `require ${'x'} ${`import('../z')`}`;",
      "const lazy = await import('node:url');",
      'const meta = import.meta.url;',
      "it('x', async () => { assert.ok(re && s && t && lazy && meta); await request('/'); expect(inject('baseUrl')).toBeTruthy(); });",
    ].join('\n');
    expect(lintAcceptanceSource(source)).toEqual([]);
  });

  it.each([
    ["import { GET } from '../../src/app/api/health/route';", '상대 · 절대 경로'],
    ["import db from '@/lib/db';", '허용 목록 밖'],
    ["import '../setup';", '상대 · 절대 경로'],
    ["export * from '../../src/lib/db';", '상대 · 절대 경로'],
    ["import fs from 'node:fs';", 'HTTP 밖 경로'],
    ["import { execFileSync } from 'node:child_process';", 'HTTP 밖 경로'],
    ["import crypto from 'crypto';", 'node: 접두'],
    ["import next from 'next';", '허용 목록 밖'],
    ["const m = await import('../../src/lib/db');", '상대 · 절대 경로'],
    ['const m = await import(name);', '동적 import'],
    ['const m = await import(`../src/${name}`);', '동적 import'],
    ["const db = require('../src/lib/db');", 'require'],
    ["import db = require('../src/lib/db');", 'require'],
    ["const real = await vi.importActual('../src/lib/db');", 'importActual'],
    ["const all = import.meta.glob('../src/**');", 'import.meta.glob'],
    ["eval('1');", 'eval'],
    ["const f = new Function('return 1');", 'Function'],
    ["const s = 'unterminated;", '해석할 수 없습니다'],
  ])('%s → 거부', (source, message) => {
    const problems = lintAcceptanceSource(source);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]?.message).toContain(message);
    expect(problems[0]?.line).toBe(1);
  });
});

describe('테스트 작성 종료 조건 (수용 기준 2)', () => {
  it('import 위반 · 인수 테스트 없음이면 끝나지 않고 새 세션으로 재시도, 규약을 지키면 끝난다', async () => {
    const h = setup({ scenario: 'test-writer-lint', scenariosDir: TEST_SCENARIOS_DIR });
    const done = await runToEnd(h);
    expect(attempts(done, 'test_writing', 'red_check')).toEqual([
      'test_writing#1:failed',
      'test_writing#2:failed',
      'test_writing#3:passed',
      'red_check#1:passed',
    ]);
    expect(exitOf(done, 'test_writing', 1)).toMatchObject({
      reason: 'lint',
      problems: [
        {
          file: 'bive-acceptance/RULE-001/health-time.acc.ts',
          line: 2,
          message: expect.stringContaining('../../src/app/api/health/route') as unknown,
        },
      ],
    });
    expect(exitOf(done, 'test_writing', 2)).toMatchObject({
      reason: 'missing_tests',
      missing: ['RULE-001'],
      ignoredFiles: ['bive-acceptance/RULE-001/plan.md'],
    });
    // 세션마다 새 세션 · 새 디렉터리, 다음 세션 지시에 앞 시도의 사유를 담는다
    const writers = h.sessions.filter((s) => s.role === 'test-writer');
    expect(new Set(writers.map((s) => s.workDir)).size).toBe(3);
    expect(writers[1]?.prompt).toContain('허용되지 않은 import');
    expect(writers[2]?.prompt).toContain('인수 테스트 파일(*.acc.ts)이 없는 규칙');
    // 미충족 시도의 결과는 워크트리에 옮기지 않는다: 통과한 시도의 파일만 커밋
    expect(changedIn(h.repo, String(done.run.headCommit))).toEqual([
      'bive-acceptance/RULE-001/health-time.acc.ts',
      ACCEPTANCE_ENV_DECLARATION,
      ACCEPTANCE_HTTP_DECLARATION,
    ]);
  }, 60_000);

  it('대상 규칙 하나라도 *.acc.ts가 없으면 끝나지 않고 재시도 2회 뒤 failed (test_retry_limit)', async () => {
    const h = setup({ secondRule: true });
    const done = await runToEnd(h);
    expectRun(done, 'failed', 'test_retry_limit');
    expect(done.run.currentStep).toBe('test_writing');
    expect(attempts(done, 'test_writing', 'red_check')).toEqual([
      'test_writing#1:failed',
      'test_writing#2:failed',
      'test_writing#3:failed',
      'red_check#1:pending',
    ]);
    expect(exitOf(done, 'test_writing', 1)).toMatchObject({
      reason: 'missing_tests',
      missing: ['RULE-002'],
    });
    expect(exitOf(done, 'test_writing', 3)).toMatchObject({
      reason: 'test_retry_limit',
      detail: { reason: 'missing_tests', missing: ['RULE-002'] },
    });
    expect(h.judgeCalls).toEqual([]);
    // 끝난 테스트 작성이 없으므로 커밋도 없다
    expect(done.run.headCommit).toBeNull();
    expect(done.steps.filter((s) => s.commit !== null)).toEqual([]);
  }, 60_000);
});

// ── 수용 기준 3: Red 확인 ───────────────────────────────

describe('Red 확인 (수용 기준 3, ADR-026)', () => {
  it('판정 러너가 새 테스트를 깨끗한 체크아웃에서 돌려 케이스 전부 실패면 통과하고 인수 테스트 해시를 기록한다', async () => {
    const h = setup({ judge: ['red'] });
    const done = await runToEnd(h);
    expect(attempts(done, 'test_writing', 'red_check', 'implementation')).toEqual([
      'test_writing#1:passed',
      'red_check#1:passed',
      'implementation#1:failed',
    ]);
    const [call] = h.judgeCalls;
    expect(h.judgeCalls).toHaveLength(1);
    const worktree = String(done.run.worktreePath);
    // 대상 규칙만 · 실행 워크트리가 아닌 체크아웃 · 테스트 작성 커밋
    expect(call?.input).toMatchObject({
      projectId: h.project.id,
      runId: h.runId,
      profile: 'next-prisma-sqlite',
      ruleIds: ['RULE-001'],
    });
    expect(call?.input.worktreeDir).not.toBe(worktree);
    expect(
      call?.input.worktreeDir.startsWith(path.join(h.biveHome, 'work', h.project.id, 'judge')),
    ).toBe(true);
    expect(call?.head).toBe(done.run.headCommit);
    expect(fs.existsSync(String(call?.input.worktreeDir))).toBe(false);
    expect(exitOf(done, 'red_check', 1)).toMatchObject({
      judgeStatus: 'completed',
      cases: 2,
      commit: done.run.headCommit,
      acceptanceHashes: hashAcceptanceFiles(worktree),
    });
    expect(Object.keys(exitOf(done, 'red_check', 1).acceptanceHashes as object).sort()).toEqual([
      'bive-acceptance/RULE-001/health-time.acc.ts',
      ACCEPTANCE_ENV_DECLARATION,
      ACCEPTANCE_HTTP_DECLARATION,
    ]);
  }, 60_000);

  it('하나라도 통과 · 건너뜀이거나 collect_error면 테스트 작성으로 돌아가고, 다시 Red면 진행한다', async () => {
    const h = setup({ judge: ['passed', 'collect_error', 'red'] });
    const done = await runToEnd(h);
    expect(attempts(done, 'test_writing', 'red_check', 'implementation')).toEqual([
      'test_writing#1:passed',
      'test_writing#2:passed',
      'test_writing#3:passed',
      'red_check#1:failed',
      'red_check#2:failed',
      'red_check#3:passed',
      'implementation#1:failed',
    ]);
    expect(exitOf(done, 'red_check', 1)).toMatchObject({
      reason: 'not_red',
      notFailedCases: [{ name: '케이스 2', status: 'passed' }],
    });
    expect(exitOf(done, 'red_check', 2)).toMatchObject({ reason: 'collect_error' });
    // 테스트 작성은 매번 새 세션, Red 미충족 사유가 다음 세션 지시에 들어간다
    const writers = h.sessions.filter((s) => s.role === 'test-writer');
    expect(writers).toHaveLength(3);
    expect(writers[1]?.prompt).toContain('구현 전에 실패하지 않은 케이스');
    expect(writers[2]?.prompt).toContain('테스트 파일을 불러오거나 수집하지 못했다');
    // 판정은 시도마다 그 시도의 테스트 작성 커밋에서
    const writingCommits = done.steps.filter((s) => s.kind === 'test_writing').map((s) => s.commit);
    expect(h.judgeCalls.map((c) => c.head)).toEqual(writingCommits);
    expect(done.run.regressionCount).toBe(0);
  }, 90_000);

  it('재시도 2회 뒤에도 Red가 아니면 failed (test_retry_limit), 구현 세션은 열리지 않는다', async () => {
    const h = setup({ judge: ['passed', 'collect_error', 'skipped'] });
    const done = await runToEnd(h);
    expectRun(done, 'failed', 'test_retry_limit');
    expect(done.run.currentStep).toBe('red_check');
    expect(attempts(done, 'test_writing', 'red_check', 'implementation')).toEqual([
      'test_writing#1:passed',
      'test_writing#2:passed',
      'test_writing#3:passed',
      'red_check#1:failed',
      'red_check#2:failed',
      'red_check#3:failed',
      'implementation#1:pending',
    ]);
    expect(exitOf(done, 'red_check', 3)).toMatchObject({
      reason: 'test_retry_limit',
      detail: { reason: 'not_red', notFailedCases: [{ status: 'skipped' }] },
    });
    expect(sessionsOf(h, 'implementer')).toEqual([]);
    expect(userGit(h.repo, 'branch', '--list', 'bive/run-EXE-001')).toContain('bive/run-EXE-001');
  }, 90_000);

  it('판정 러너 오류(runner_error)는 테스트 작성으로 돌아가지 않고 failed (judge_runner_error)', async () => {
    const h = setup({ judge: ['runner_error'] });
    const done = await runToEnd(h);
    expectRun(done, 'failed', JUDGE_RUNNER_ERROR_REASON);
    expect(attempts(done, 'test_writing', 'red_check')).toEqual([
      'test_writing#1:passed',
      'red_check#1:failed',
    ]);
    expect(exitOf(done, 'red_check', 1)).toMatchObject({
      reason: JUDGE_RUNNER_ERROR_REASON,
      detail: { stage: 'judge', judgeStatus: 'runner_error' },
    });
  }, 60_000);

  it('Red 판정은 커밋의 깨끗한 체크아웃에서: 실행 워크트리의 무시된 소스 · node_modules를 보지 않는다', async () => {
    // 실행 워크트리에만 심는다: .gitignore로 숨긴 소스 + node_modules 표시 (커밋 · 되돌리기에서 살아남는 파일)
    const plant = (worktree: string): void => {
      const planted = path.join(worktree, 'src', 'planted');
      fs.mkdirSync(planted, { recursive: true });
      fs.writeFileSync(path.join(planted, '.gitignore'), '*\n');
      fs.writeFileSync(path.join(planted, 'evil.ts'), 'export const evil = true;\n');
      fs.mkdirSync(path.join(worktree, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(worktree, 'node_modules', '.planted-dependency'), '');
    };
    const h = setup({
      judge: ['passed', 'red'],
      wrapTestWriting: (inner) => async (context) => {
        plant(context.git.worktreePath);
        return inner(context);
      },
    });
    const done = await runToEnd(h);
    expect(attempts(done, 'test_writing', 'red_check')).toEqual([
      'test_writing#1:passed',
      'test_writing#2:passed',
      'red_check#1:failed',
      'red_check#2:passed',
    ]);
    const worktree = String(done.run.worktreePath);
    // 재현: 회귀 때의 되돌리기(reset --hard + clean -ffd)와 커밋은 무시된 파일을 남긴다
    expect(fs.existsSync(path.join(worktree, 'src', 'planted', 'evil.ts'))).toBe(true);
    expect(fs.existsSync(path.join(worktree, 'node_modules', '.planted-dependency'))).toBe(true);
    expect(git(worktree, 'status', '--porcelain', '--ignored')).toContain('src/planted/');
    expect(git(h.repo, 'ls-tree', '-r', '--name-only', String(done.run.headCommit))).not.toContain(
      'src/planted/evil.ts',
    );
    // 판정은 두 번 모두 그 커밋의 추적 파일 + 새로 설치한 의존성에서만 돌았다
    expect(h.judgeCalls).toHaveLength(2);
    for (const call of h.judgeCalls) {
      expect(call.input.worktreeDir).not.toBe(worktree);
      expect(call.planted).toBe(false);
      expect(call.plantedDependency).toBe(false);
      expect(call.installed).toBe(true);
      expect(call.nodeModulesIsLink).toBe(false);
      // 체크아웃의 미추적 · 무시된 파일은 설치한 node_modules뿐
      expect(call.status.split('\n')).toEqual([`!! node_modules/${FAKE_INSTALL_MARKER}`]);
      expect(call.acceptance).toEqual([
        'RULE-001/health-time.acc.ts',
        'bive-env.d.ts',
        'bive-http.d.ts',
      ]);
    }
    // 체크아웃은 판정 뒤 지우고 사용자 저장소에 워크트리 등록도 남기지 않는다
    expect(fs.readdirSync(path.join(h.biveHome, 'work', h.project.id, 'judge', 'EXE-001'))).toEqual(
      [],
    );
    expect(git(h.repo, 'worktree', 'list', '--porcelain')).not.toContain(`/judge/`);
  }, 90_000);
});

// ── 수용 기준 4 · 판정 보조 ─────────────────────────────

describe('red-violation 시나리오 (수용 기준 4)', () => {
  it('시나리오는 구현 전에도 통과하는 인수 테스트를 쓰고, 주입 판정으로도 테스트 작성 단계가 끝나지 않는다', async () => {
    const scenario = loadScenario('red-violation');
    expect(Object.keys(scenario.roles).sort()).toEqual([
      'implementer',
      'rule-writer',
      'test-writer',
    ]);
    expect(scenario.roles['test-writer']?.sessions).toHaveLength(1);
    // 기본 실행기 목록에 테스트 작성 · Red 확인이 등록돼 있다 (구현 · 검사 · 병합은 #29)
    expect(Object.keys(DEFAULT_STEP_EXECUTORS).sort()).toEqual([
      'mutation',
      'red_check',
      'screen_update',
      'test_writing',
    ]);
  });
});

describe('판정 보조 (ADR-051 · ADR-068)', () => {
  it('한 파일에 스위트 훅 실패와 케이스 실패가 섞이면 훅 실패 스위트를 파일 수준 문제로 올린다', () => {
    const file = 'bive-acceptance/RULE-001/mixed.acc.ts';
    const json = JSON.stringify({
      success: false,
      testResults: [
        {
          name: `/w/${file}`,
          status: 'failed',
          message: '',
          assertionResults: [
            { ancestorTitles: ['A'], title: 'a1', status: 'skipped', failureMessages: [] },
            {
              ancestorTitles: ['B'],
              title: 'b1',
              status: 'failed',
              failureMessages: ['AssertionError: expected 1 to be 2'],
            },
          ],
        },
      ],
    });
    // vitest 기본 reporter의 stderr (실측 모양)
    const stderr = [
      '',
      '⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯',
      '',
      ` FAIL  ${file} > A`,
      'Error: 훅 실패',
      ` ❯ ${file}:5:11`,
      '',
      '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
      '',
      ` FAIL  ${file} > B > b1`,
      'AssertionError: expected 1 to be 2 // Object.is equality',
    ].join('\n');
    const parsed = parseVitestReport(json, '/w', { output: stderr });
    expect(parsed.collectProblems).toEqual([
      { file, message: '스위트 훅 실패 등 파일 수준 오류 (stderr.log 참고): A - Error: 훅 실패' },
    ]);
    expect(parsed.cases.map((c) => `${c.name}:${c.status}`)).toEqual([
      'A > a1:skipped',
      'B > b1:failed',
    ]);
    // 케이스 실패만 있으면 문제 없음
    const onlyCases = stderr.split('\n').slice(7).join('\n');
    expect(parseVitestReport(json, '/w', { output: onlyCases }).collectProblems).toEqual([]);
  });

  it('생성 설정은 @bive/http를 판정 폴더의 도우미 파일로 연결한다', () => {
    const config = buildJudgeConfig({
      mode: 'run',
      worktreeDir: '/w',
      judgeDir: '/j',
      globalSetupPath: '/j/global-setup.mjs',
      resultPath: '/j/result.json',
      cacheDir: '/j/vite-cache',
      httpHelperPath: '/j/bive-http.mjs',
      ruleIds: ['RULE-001'],
    });
    expect(config.resolve).toEqual({ alias: { '@bive/http': '/j/bive-http.mjs' } });
  });
});

// ── 실제 판정 (픽스처 체크아웃 설치 · next build · next start · vitest) ─────────

/** 실제 판정 1회 제한 시간을 넉넉히 (설치 + 빌드 + 기동 + vitest). */
const REAL_TIMEOUT_MS = 420_000;

describe('실제 판정 러너로 Red 확인', () => {
  it(
    'red-violation: 구현 전에 통과하는 테스트라 Red가 매번 미충족, 테스트 작성이 끝나지 않고 failed',
    async () => {
      const h = setup({ scenario: 'red-violation', judge: 'real' });
      const done = await runToEnd(h);
      expectRun(done, 'failed', 'test_retry_limit');
      expect(attempts(done, 'test_writing', 'red_check', 'implementation')).toEqual([
        'test_writing#1:passed',
        'test_writing#2:passed',
        'test_writing#3:passed',
        'red_check#1:failed',
        'red_check#2:failed',
        'red_check#3:failed',
        'implementation#1:pending',
      ]);
      for (const attempt of [1, 2]) {
        expect(exitOf(done, 'red_check', attempt)).toMatchObject({
          reason: 'not_red',
          judgeStatus: 'completed',
          summary: { total: 1, passed: 1, failed: 0 },
          notFailedCases: [
            {
              name: 'GET /api/health 응답 > 상태 코드 200과 ok true를 돌려준다',
              file: 'bive-acceptance/RULE-001/health-ok.acc.ts',
              status: 'passed',
            },
          ],
        });
      }
      expect(exitOf(done, 'red_check', 3)).toMatchObject({
        reason: 'test_retry_limit',
        detail: { reason: 'not_red' },
      });
      expect(sessionsOf(h, 'test-writer')).toHaveLength(3);
      expect(sessionsOf(h, 'implementer')).toEqual([]);
      expect(
        fs.readdirSync(path.join(h.biveHome, 'work', h.project.id, 'judge', 'EXE-001')),
      ).toEqual([]);
    },
    REAL_TIMEOUT_MS,
  );

  it(
    '재현: 실행 워크트리에 숨긴 경로가 있어도 깨끗한 체크아웃 판정은 Red, 워크트리에서 판정하면 통과로 바뀐다',
    async () => {
      const h = setup({
        scenario: 'test-writer-planted',
        scenariosDir: TEST_SCENARIOS_DIR,
        judge: 'real',
        // 프로젝트에 ProvidedContext 선언이 없게 만든다: inject('baseUrl')의 타입은 BIVE 선언 파일만 준다
        prepareRepo: (repo) => {
          const support = path.join(repo, 'tests', 'support', 'server.ts');
          const source = fs.readFileSync(support, 'utf8');
          const stripped = source.replace(
            /declare module 'vitest' \{\n {2}export interface ProvidedContext \{\n {4}baseUrl: string;\n {2}\}\n\}\n/u,
            '',
          );
          expect(stripped).not.toBe(source);
          fs.writeFileSync(support, stripped);
        },
        // 테스트 작성 직전 실행 워크트리에 커밋되지 않는 경로를 심는다 (src/app/api/planted, .gitignore = '*')
        wrapTestWriting: (inner) => async (context) => {
          const planted = path.join(context.git.worktreePath, 'src', 'app', 'api', 'planted');
          fs.mkdirSync(planted, { recursive: true });
          fs.writeFileSync(path.join(planted, '.gitignore'), '*\n');
          fs.writeFileSync(
            path.join(planted, 'route.ts'),
            "export const dynamic = 'force-dynamic';\n\nexport function GET(): Response {\n  return Response.json({ planted: true });\n}\n",
          );
          return inner(context);
        },
      });
      const done = await runToEnd(h);
      // 깨끗한 체크아웃: /api/planted 없음(404) → 케이스 실패 → Red 통과. 빌드는 BIVE 선언 파일로 타입 검사 통과
      expect(attempts(done, 'test_writing', 'red_check')).toEqual([
        'test_writing#1:passed',
        'red_check#1:passed',
      ]);
      expect(exitOf(done, 'red_check', 1)).toMatchObject({
        judgeStatus: 'completed',
        summary: { total: 1, failed: 1, passed: 0 },
      });
      const worktree = String(done.run.worktreePath);
      expect(changedIn(h.repo, String(done.run.headCommit))).toEqual([
        'bive-acceptance/RULE-001/planted.acc.ts',
        ACCEPTANCE_ENV_DECLARATION,
        ACCEPTANCE_HTTP_DECLARATION,
      ]);

      // 대조: 같은 커밋이 체크아웃된 실행 워크트리(숨긴 경로 있음)에서 직접 판정하면 케이스가 통과한다
      const logFile = path.join(h.biveHome, 'install.log');
      await installDependencies(worktree, { logFile, timeoutMs: 300_000 });
      const direct = await new JudgeRunner({ biveHome: h.biveHome }).run({
        projectId: h.project.id,
        runId: h.runId,
        worktreeDir: worktree,
        profile: 'next-prisma-sqlite',
        ruleIds: ['RULE-001'],
        timeoutMs: 240_000,
      });
      expect(direct.status).toBe('completed');
      expect(direct.cases.map((c) => c.status)).toEqual(['passed']);

      // 선언 파일 결정(ADR-068): 선언이 있으면 프로젝트 타입 검사 통과, 지우면 inject('baseUrl')이 타입 오류
      const tsc = (): { code: number; output: string } => {
        try {
          execFileSync(
            path.join(worktree, 'node_modules', '.bin', 'tsc'),
            ['--noEmit', '-p', '.'],
            {
              cwd: worktree,
              encoding: 'utf8',
              stdio: 'pipe',
            },
          );
          return { code: 0, output: '' };
        } catch (error) {
          const e = error as { status?: number; stdout?: string };
          return { code: e.status ?? -1, output: String(e.stdout ?? '') };
        }
      };
      expect(tsc().code).toBe(0);
      fs.rmSync(path.join(worktree, ACCEPTANCE_ENV_DECLARATION));
      const broken = tsc();
      expect(broken.code).not.toBe(0);
      expect(broken.output).toContain('bive-acceptance/RULE-001/planted.acc.ts');
    },
    REAL_TIMEOUT_MS,
  );
});
