// 구현 역할 · 검사 단계 판정 · 판정 결과 저장 (M1-16 수용 기준, RUN-02 · RUN-04 · JDG-01 · JDG-02 · NFR-01 · NFR-02, ADR-069).
// 픽스처 git 복사본 · 실제 git(커밋 · 판정 체크아웃 · 병합) · 실제 SQLite · ScriptedAdapter(실제 고정 도구 · 경로 가드) ·
// 제품 단계 실행기. 판정 · 의존성 설치만 주입한다(체크아웃 파일 내용으로 케이스 결과를 정하는 대역, test/helpers/pipeline-harness.ts).
// 실제 판정 러너로 도는 완주는 test/pipeline-merge.test.ts에 있다.
// 제한: 엔진 · git · 체크아웃을 여러 번 띄우는 테스트는 60초, afterEach는 60초(픽스처 복사본 · 워크트리 삭제, ADR-064).
import fs from 'node:fs';
import path from 'node:path';

import { APPROVAL_LOG_GENESIS_HASH, type JudgmentResult } from '@bive/shared';
import {
  bivePaths,
  canonicalJson,
  computeApprovalLogHash,
  openDatabase,
  type SqliteDatabase,
} from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import type { PipelineEngine } from '../src/engine/pipeline-engine.js';
import type { StepExecutor } from '../src/engine/types.js';
import { buildJudgeConfig } from '../src/judge/config.js';
import { lintAcceptanceSource } from '../src/judge/acceptance-lint.js';
import { storedLatestJudgments } from '../src/judgments/latest-judgment.js';
import { NORM_INTEGRITY_STAGE } from '../src/steps/judging.js';
import {
  human,
  newId,
  ROUTE,
  T0,
  TEST_SCENARIOS_DIR,
  userGit,
  withProject,
} from './helpers/engine-harness.js';
import {
  attempts,
  before,
  exitOf,
  git,
  hookAdapter,
  type JudgeCall,
  judgmentsOf,
  type PipelineHarness,
  type PipelineSetupOptions,
  plantIgnored,
  runToEnd,
  setupPipeline,
  stepOf,
  toolCallsOf,
} from './helpers/pipeline-harness.js';
import { cleanup } from './helpers/process.js';

const temps: string[] = [];
const engines: PipelineEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}, 60_000);

const setup = (options: Omit<PipelineSetupOptions, 'temps' | 'engines'> = {}): PipelineHarness =>
  setupPipeline({ ...options, temps, engines });

const mainTip = (h: PipelineHarness): string => userGit(h.repo, 'rev-parse', 'refs/heads/main');

const isLocked = (h: PipelineHarness, worktree: string): boolean =>
  userGit(h.repo, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .some(
      (entry) =>
        entry.includes(`worktree ${fs.realpathSync(worktree)}`) && entry.includes('\nlocked'),
    );

const ACC_FILE = 'bive-acceptance/RULE-001/health-time.acc.ts';

/**
 * 같은 사용자 권한의 다른 프로세스 흉내: 오케스트레이터의 저장소(`ProjectStore`)를 거치지 않는 별도 연결로 DB를 직접 고친다
 * (에이전트 코드가 `run_tests` · 판정 서버에서 `bive.db`를 여는 경우, #117).
 */
const rawDb = <T>(h: PipelineHarness, fn: (db: SqliteDatabase) => T): T => {
  const db = openDatabase(bivePaths(h.biveHome).projectDb(h.project.id), { create: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

const tamper = (h: PipelineHarness, sql: string, ...args: unknown[]): void => {
  rawDb(h, (db) => {
    db.exec('DROP TRIGGER IF EXISTS approval_log_no_update;');
    db.prepare(sql).run(...args);
  });
};

const judgeKinds = (h: PipelineHarness): string[] => h.judgeCalls.map((call) => call.kind);

// ── 수용 기준 1: 구현 세션의 쓰기 범위 · 인수 테스트 해시 · 세션 뒤 판정 ───────────

describe('구현 세션: 실행 워크트리에서 인수 테스트 · .git · .bive.json 쓰기 거부 (수용 기준 1, ADR-052)', () => {
  it('구현 세션은 금지 경로 쓰기를 거부당하고 소스만 고쳐 커밋 · 판정 · 병합된다', async () => {
    const h = setup({ scenario: 'implementer-guard', scenariosDir: TEST_SCENARIOS_DIR });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'merged', failureReason: null });

    const session = h.sessions.find((s) => s.role === 'implementer');
    expect(session?.workDir).toBe(done.run.worktreePath);
    const calls = toolCallsOf(h).filter((call) => call.role === 'implementer');
    expect(calls.map((call) => [call.name, call.argsSummary, call.status, call.reason])).toEqual([
      ['read_file', ACC_FILE, 'ok', null],
      ['write_file', ACC_FILE, 'denied', 'path_denied'],
      ['write_file', 'bive-acceptance/RULE-001/extra.acc.ts', 'denied', 'path_denied'],
      ['write_file', '.git', 'denied', 'path_denied'],
      ['write_file', '.git/hooks/pre-commit', 'denied', 'path_denied'],
      ['write_file', '.bive.json', 'denied', 'path_denied'],
      ['write_file', 'node_modules/next/dist/evil.js', 'denied', 'path_denied'],
      ['write_file', ROUTE, 'ok', null],
    ]);

    // 구현 커밋은 소스만 바꿨고 인수 테스트는 테스트 작성 커밋 그대로다
    const writing = stepOf(done, 'test_writing').commit;
    const implementation = stepOf(done, 'implementation').commit;
    expect(implementation).not.toBe(writing);
    expect(
      git(h.repo, 'diff', '--name-only', String(writing), String(implementation)).split('\n'),
    ).toEqual([ROUTE]);
    const worktree = String(done.run.worktreePath);
    expect(fs.existsSync(path.join(worktree, 'bive-acceptance/RULE-001/extra.acc.ts'))).toBe(false);
    expect(fs.existsSync(path.join(worktree, '.bive.json'))).toBe(false);
    expect(fs.statSync(path.join(worktree, '.git')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(worktree, '.git'), 'utf8')).not.toContain('elsewhere');
    expect(git(h.repo, 'show', `${String(done.run.mergeCommit)}:${ROUTE}`)).toContain(
      'toISOString()',
    );
  }, 60_000);
});

describe('인수 테스트 보호: Red 확인 때와 해시가 다르면 guard_violation (수용 기준 1, architecture.md 4장)', () => {
  it('구현 세션 동안 인수 테스트가 바뀌면(테스트 실행 코드 등) 판정하지 않고 failed(guard_violation), 브랜치 보존 · 병합 없음', async () => {
    const h = setup({
      // 에이전트 코드가 run_tests로 돌며 경로 가드를 거치지 않고 인수 테스트를 고친 상황
      wrapAdapter: (adapter) =>
        hookAdapter(adapter, {
          beforeResult: (spec) => {
            if (spec.role !== 'implementer') return;
            fs.writeFileSync(
              path.join(spec.workDir, ACC_FILE),
              "import { it } from 'vitest';\nit('항상 통과', () => {});\n",
            );
          },
        }),
    });
    const base = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'failed', failureReason: 'guard_violation' });
    expect(exitOf(done, 'implementation')).toMatchObject({
      reason: 'guard_violation',
      detail: { stage: 'acceptance_hash', changed: [ACC_FILE] },
    });
    // Red 확인 판정 뒤 다른 판정은 없다 (바뀐 테스트로 판정하지 않음)
    expect(judgeKinds(h)).toEqual(['red_check']);
    expect(judgmentsOf(h)).toEqual([]);
    expect(mainTip(h)).toBe(base);
    expect(userGit(h.repo, 'branch', '--list', 'bive/run-EXE-001')).toContain('bive/run-EXE-001');
    expect(isLocked(h, String(done.run.worktreePath))).toBe(true);
  }, 60_000);

  it('검사 직전에도 대조한다: 구현 단계를 지나온 커밋의 인수 테스트가 다르면 검사가 failed(guard_violation)', async () => {
    // 구현 실행기를 해시 대조 없이 통과시키는 대역으로 바꿔, 인수 테스트가 바뀐 커밋이 검사까지 오게 한다
    const sneaky: StepExecutor = (context) => {
      const worktree = context.git.worktreePath;
      fs.writeFileSync(
        path.join(worktree, ROUTE),
        'export const GET = () => Response.json({ ok: true, time: new Date().toISOString() });\n',
      );
      fs.writeFileSync(
        path.join(worktree, 'bive-acceptance/RULE-001/extra.acc.ts'),
        "import { it } from 'vitest';\nit('항상 통과', () => {});\n",
      );
      return Promise.resolve({ status: 'passed' });
    };
    const h = setup({ executors: (defaults) => ({ ...defaults, implementation: sneaky }) });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'failed', failureReason: 'guard_violation' });
    expect(exitOf(done, 'check')).toMatchObject({
      reason: 'guard_violation',
      detail: {
        stage: 'acceptance_hash',
        changed: ['bive-acceptance/RULE-001/extra.acc.ts'],
        commit: done.run.headCommit,
      },
    });
    expect(judgeKinds(h)).toEqual(['red_check']);
    expect(done.run.mergeCommit).toBeNull();
  }, 60_000);
});

describe('세션 뒤 판정: 대상 테스트가 전부 통과해야 구현 단계가 끝난다 (수용 기준 1, JDG-01)', () => {
  it('세션이 끝나면 커밋의 깨끗한 체크아웃에서 대상 규칙만 판정하고, 실패 · 건너뜀 · 러너 오류는 미충족(회귀 1회)이다', async () => {
    const h = setup({
      decide: (call) => {
        const nth = h.judgeCalls.filter((c) => c.kind === 'implementation').length;
        if (call.kind === 'implementation' && nth === 1)
          return { 'RULE-001': ['passed', 'failed'] };
        if (call.kind === 'implementation' && nth === 2)
          return { 'RULE-001': ['passed', 'skipped'] };
        if (call.kind === 'implementation' && nth === 3) return 'runner_error';
        return { 'RULE-001': ['failed'] };
      },
    });
    // 1회 실패 케이스 · 2회 건너뜀 케이스 · 3회 러너 오류(빌드 실패 등): 모두 미충족이고 3회째에 회귀 상한을 넘는다
    const done = await runToEnd(h);
    expect(attempts(done, 'implementation')).toEqual([
      'implementation#1:failed',
      'implementation#2:failed',
      'implementation#3:failed',
    ]);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'regression_limit',
      regressionCount: 2,
    });
    expect(exitOf(done, 'implementation', 1)).toMatchObject({
      reason: 'not_green',
      judgeStatus: 'completed',
      failingCases: [
        {
          name: 'RULE-001 > 케이스 2',
          file: ACC_FILE,
          line: 20,
          status: 'failed',
          message: 'expected 실패 2',
        },
      ],
    });
    expect(exitOf(done, 'implementation', 2)).toMatchObject({
      reason: 'not_green',
      failingCases: [{ status: 'skipped', file: ACC_FILE, line: 20 }],
    });
    expect(exitOf(done, 'implementation', 3)).toMatchObject({
      reason: 'regression_limit',
      detail: { reason: 'judge_runner_error', judgeStatus: 'runner_error' },
    });

    // 판정은 대상 규칙만, 판정 체크아웃(실행 워크트리 아님)에서, 그 시도의 커밋으로
    const implementationCalls = h.judgeCalls.filter((c) => c.kind === 'implementation');
    expect(implementationCalls).toHaveLength(3);
    const judgeRoot = path.join(
      fs.realpathSync(h.biveHome),
      'work',
      h.project.id,
      'judge',
      'EXE-001',
    );
    for (const call of implementationCalls) {
      expect(call.input.ruleIds).toEqual(['RULE-001']);
      expect(path.dirname(call.input.worktreeDir)).toBe(judgeRoot);
      expect(call.installed).toBe(true);
      expect(call.routeHasTime).toBe(true);
    }
    // 시도마다 새 커밋, 미충족 뒤 실행 브랜치는 테스트 작성 커밋으로 되돌아간다
    const heads = implementationCalls.map((call) => call.head);
    expect(new Set(heads).size).toBe(3);
    expect(done.run.headCommit).toBe(stepOf(done, 'test_writing').commit);
    expect(fs.readdirSync(judgeRoot)).toEqual([]);
  }, 60_000);

  it('미충족 뒤 다음 시도가 통과하면 검사 · 병합으로 이어지고, 다음 세션은 앞 시도의 실패 위치를 받는다', async () => {
    const h = setup({
      decide: (call) => {
        const nth = h.judgeCalls.filter((c) => c.kind === 'implementation').length;
        if (call.kind === 'implementation' && nth === 1)
          return { 'RULE-001': ['passed', 'failed'] };
        return Object.fromEntries(
          (call.input.ruleIds ?? []).map((id) => [
            id,
            call.kind === 'red_check' ? ['failed'] : ['passed', 'passed'],
          ]),
        );
      },
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'merged', regressionCount: 1 });
    expect(attempts(done, 'implementation', 'check')).toEqual([
      'implementation#1:failed',
      'implementation#2:passed',
      'check#1:passed',
    ]);
    // 통과한 시도의 커밋 = 판정한 커밋 = 실행의 마지막 완료 단계 커밋 (엔진의 커밋은 같은 커밋을 돌려준다)
    const passed = stepOf(done, 'implementation', 2);
    expect(passed.commit).toBe(h.judgeCalls.filter((c) => c.kind === 'implementation')[1]?.head);
    expect(done.run.headCommit).toBe(passed.commit);
    const prompts = h.sessions.filter((s) => s.role === 'implementer').map((s) => s.prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('앞 시도');
    expect(prompts[1]).toContain(`${ACC_FILE}:20 RULE-001 > 케이스 2 (expected 실패 2)`);
  }, 60_000);
});

// ── 수용 기준 2: 검사 단계 판정 · 규칙별 판정 기록 ───────────────────────

describe('검사 단계: 승인된 규칙 전체 인수 테스트를 판정하고 규칙별 판정 기록을 저장한다 (수용 기준 2, JDG-02)', () => {
  const OTHER_ACC = 'bive-acceptance/RULE-002/ok.acc.ts';

  it('검사는 승인된 규칙 전체(대상 아님 포함)를 판정하고 상태 · 커밋 · 시각 · 실행기 출력 · 실패 케이스 file:line을 남긴다', async () => {
    const h = setup({
      secondRule: true,
      prepareRepo: (repo) => {
        for (const [file, body] of [
          [OTHER_ACC, "import { it } from 'vitest';\nit('ok', () => {});\n"],
          // 승인된 규칙이 아닌 폴더 (판정 대상 아님)
          [
            'bive-acceptance/RULE-009/orphan.acc.ts',
            "import { it } from 'vitest';\nit('x', () => {});\n",
          ],
        ]) {
          fs.mkdirSync(path.dirname(path.join(repo, String(file))), { recursive: true });
          fs.writeFileSync(path.join(repo, String(file)), String(body));
        }
      },
      decide: (call) => {
        const checks = h.judgeCalls.filter((c) => c.kind === 'check').length;
        return Object.fromEntries(
          (call.input.ruleIds ?? []).map((id) => {
            if (call.kind === 'red_check') return [id, ['failed']];
            if (id === 'RULE-002' && checks === 1) return [id, ['passed', 'failed']];
            return [id, ['passed', 'passed']];
          }),
        );
      },
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'merged', regressionCount: 1 });
    expect(attempts(done, 'implementation', 'check')).toEqual([
      'implementation#1:passed',
      'implementation#2:passed',
      'check#1:failed',
      'check#2:passed',
    ]);

    // 판정 대상: 승인된 규칙 중 폴더가 있는 것 (RULE-009 제외)
    const checkCalls = h.judgeCalls.filter((c) => c.kind === 'check');
    expect(checkCalls.map((c) => c.input.ruleIds)).toEqual([
      ['RULE-001', 'RULE-002'],
      ['RULE-001', 'RULE-002'],
    ]);
    // 미충족 시도의 종료 조건 결과 = 실행기 결과 그대로 (엔진이 구현으로 회귀)
    expect(exitOf(done, 'check', 1)).toMatchObject({
      reason: 'check_failed',
      unjudgedDirs: ['RULE-009'],
      judgments: [
        { ruleId: 'RULE-001', status: 'pass', failedCases: [] },
        {
          ruleId: 'RULE-002',
          status: 'fail',
          failedCases: [
            { file: OTHER_ACC, line: 20, status: 'failed', message: 'expected 실패 2' },
          ],
        },
      ],
    });

    // 저장된 판정 기록: 구현 · 검사 판정마다 규칙별로, 커밋 · 시각 · 종료 코드 · 원본 경로 · 케이스와 함께
    const [rule1, rule2] = h.rules;
    if (rule1 === undefined || rule2 === undefined) throw new Error('규칙 없음');
    const records = judgmentsOf(h);
    const view = (record: JudgmentResult) => [
      done.steps.find((s) => s.id === record.stepId)?.kind,
      record.ruleId === rule1.id ? 'RULE-001' : 'RULE-002',
      record.status,
    ];
    expect(records.map(view)).toEqual([
      ['implementation', 'RULE-001', 'pass'],
      ['check', 'RULE-001', 'pass'],
      ['check', 'RULE-002', 'fail'],
      ['implementation', 'RULE-001', 'pass'],
      ['check', 'RULE-001', 'pass'],
      ['check', 'RULE-002', 'pass'],
    ]);
    const failed = records[2];
    expect(failed).toMatchObject({
      runId: h.runId,
      stepId: stepOf(done, 'check', 1).id,
      commit: stepOf(done, 'implementation', 1).commit,
      runner: 'vitest',
      exitCode: 1,
      reporterPath: '/판정/check/result.json',
      quarantineReason: null,
      cases: [
        { name: 'RULE-002 > 케이스 1', file: OTHER_ACC, line: 10, status: 'passed', message: null },
        {
          name: 'RULE-002 > 케이스 2',
          file: OTHER_ACC,
          line: 20,
          status: 'failed',
          message: 'expected 실패 2',
        },
      ],
    });
    expect(Date.parse(String(failed?.judgedAt))).toBeGreaterThanOrEqual(T0);
    // 마지막 검사의 기록이 규칙의 최신 판정이고, 커밋은 병합된 실행 브랜치 커밋이다
    const latest = withProject(h.biveHome, h.project.id, (store) => storedLatestJudgments(store));
    expect(latest(rule1.id)).toMatchObject({ status: 'pass', commit: done.run.headCommit });
    expect(latest(rule2.id)).toMatchObject({
      status: 'pass',
      commit: done.run.headCommit,
      stepId: stepOf(done, 'check', 2).id,
    });
    // 검사 실패 사유가 다음 구현 세션의 지시에 들어간다
    const prompts = h.sessions.filter((s) => s.role === 'implementer').map((s) => s.prompt);
    expect(prompts[1]).toContain('RULE-002');
    expect(prompts[1]).toContain(`${OTHER_ACC}:20`);
  }, 60_000);

  it('검사의 수집 오류는 미충족(기록 없음), 러너 오류는 failed(judge_runner_error)', async () => {
    const collect = setup({
      decide: (call) =>
        call.kind === 'check'
          ? 'collect_error'
          : Object.fromEntries(
              (call.input.ruleIds ?? []).map((id) => [
                id,
                call.kind === 'red_check' ? ['failed'] : ['passed'],
              ]),
            ),
    });
    const collected = await runToEnd(collect);
    expect(collected.run).toMatchObject({ status: 'failed', failureReason: 'regression_limit' });
    expect(exitOf(collected, 'check', 1)).toMatchObject({
      reason: 'collect_error',
      judgeStatus: 'collect_error',
    });
    // 수집 오류는 규칙을 판정하지 못한 것이라 검사 단계의 판정 기록이 없다 (구현 판정 기록만)
    const checkIds = new Set(collected.steps.filter((s) => s.kind === 'check').map((s) => s.id));
    expect(judgmentsOf(collect).filter((record) => checkIds.has(String(record.stepId)))).toEqual(
      [],
    );
    expect(judgmentsOf(collect)).toHaveLength(3);

    const runner = setup({
      decide: (call) =>
        call.kind === 'check'
          ? 'runner_error'
          : Object.fromEntries(
              (call.input.ruleIds ?? []).map((id) => [
                id,
                call.kind === 'red_check' ? ['failed'] : ['passed'],
              ]),
            ),
    });
    const errored = await runToEnd(runner);
    expect(errored.run).toMatchObject({ status: 'failed', failureReason: 'judge_runner_error' });
    expect(attempts(errored, 'check')).toEqual(['check#1:failed']);
    expect(exitOf(errored, 'check')).toMatchObject({
      reason: 'judge_runner_error',
      detail: { stage: 'judge', judgeStatus: 'runner_error' },
    });
  }, 60_000);
});

// ── 수용 기준 3: false-pass ─────────────────────────────────────

describe('false-pass 시나리오: 에이전트가 "통과"라고 보고해도 판정은 실행 결과로 (수용 기준 3, JDG-01)', () => {
  it('구현 세션이 통과했다고 보고하지만 판정은 fail이고, 실행 상태는 에이전트 메시지로 바뀌지 않는다', async () => {
    const h = setup({ scenario: 'false-pass' });
    const base = mainTip(h);
    const done = await runToEnd(h);

    // 세션은 매번 성공으로 끝나며 "전부 통과" 메시지를 냈다
    const implementerSessions = withProject(h.biveHome, h.project.id, (store) =>
      store.sessions.listByRun(h.runId).filter((s) => s.role === 'implementer'),
    );
    expect(implementerSessions.map((s) => s.endReason)).toEqual(['success', 'success', 'success']);
    // 판정은 체크아웃의 실제 코드로: 서버 시각이 ISO 문자열이 아니므로 실패
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'regression_limit',
      mergeCommit: null,
    });
    expect(attempts(done, 'implementation', 'check')).toEqual([
      'implementation#1:failed',
      'implementation#2:failed',
      'implementation#3:failed',
      'check#1:pending',
    ]);
    expect(exitOf(done, 'implementation', 1)).toMatchObject({ reason: 'not_green' });
    const records = judgmentsOf(h);
    expect(records.map((record) => record.status)).toEqual(['fail', 'fail', 'fail']);
    const latest = withProject(h.biveHome, h.project.id, (store) => storedLatestJudgments(store));
    expect(latest(h.rule.id)).toMatchObject({ status: 'fail', runId: h.runId });
    expect(latest(h.rule.id)?.cases.map((c) => [c.file, c.line, c.status])).toEqual([
      [ACC_FILE, 10, 'failed'],
      [ACC_FILE, 20, 'failed'],
    ]);
    // 단계 기록 어디에도 에이전트의 보고 문장이 근거로 남지 않는다
    expect(JSON.stringify(done.steps)).not.toContain('전부 통과했습니다');
    expect(mainTip(h)).toBe(base);
    expect(isLocked(h, String(done.run.worktreePath))).toBe(true);
  }, 60_000);
});

// ── 코멘트 기준: 깨끗한 체크아웃 · 규범 저장소 무결성 · 스냅숏 ───────────────

describe('검사 · 병합 재검사는 커밋의 깨끗한 체크아웃에서 (코멘트 기준, ADR-058 · ADR-068)', () => {
  it('실행 워크트리에 숨긴 파일 · 의존성은 구현 · 검사 · 병합 재검사 판정에 보이지 않고 node_modules는 새로 설치한다', async () => {
    let worktree = '';
    const h = setup({
      executors: (defaults) => ({
        ...defaults,
        implementation: before(defaults.implementation, (context) => {
          worktree = context.git.worktreePath;
          plantIgnored(worktree);
        }),
        // 병합 직전 사용자가 기준 브랜치에 커밋 → 병합 커밋으로 검사를 다시 돈다
        merge: before(defaults.merge, (context) => {
          fs.writeFileSync(path.join(context.git.repoPath, 'NOTES.md'), '사용자 메모\n');
          userGit(context.git.repoPath, 'add', 'NOTES.md');
          userGit(context.git.repoPath, 'commit', '-q', '-m', '사용자 커밋');
        }),
      }),
    });
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    expect(exitOf(done, 'merge')).toMatchObject({ rechecked: true });
    expect(judgeKinds(h)).toEqual(['red_check', 'implementation', 'check', 'merge']);
    for (const call of h.judgeCalls) {
      expect(call, call.kind).toMatchObject({
        planted: false,
        plantedDependency: false,
        installed: true,
        nodeModulesIsLink: false,
      });
      expect(call.status).not.toContain('planted');
    }
    // 실행 워크트리에는 그대로 남아 있다 (판정만 보지 않는다)
    expect(fs.existsSync(path.join(worktree, 'src', 'planted', 'evil.ts'))).toBe(true);
    const merge = h.judgeCalls.find((c) => c.kind === 'merge');
    expect(merge?.head).toBe(done.run.mergeCommit);
    expect(merge?.input.ruleIds).toEqual(['RULE-001']);
  }, 60_000);
});

describe('규범 저장소 무결성: 세션 뒤 · 판정 직전 · 판정 뒤 대조 (코멘트 기준, #117 기본 조치)', () => {
  it('구현 세션 동안 승인 기록이 고쳐지면 판정하지 않고 failed(judge_runner_error, norm_integrity)', async () => {
    const h = setup({
      wrapAdapter: (adapter, harness) =>
        hookAdapter(adapter, {
          beforeResult: (spec) => {
            if (spec.role !== 'implementer') return;
            tamper(harness(), "UPDATE approval_log SET client_id = 'tampered' WHERE seq = 1");
          },
        }),
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'failed', failureReason: 'judge_runner_error' });
    expect(exitOf(done, 'implementation')).toMatchObject({
      reason: 'judge_runner_error',
      detail: {
        stage: NORM_INTEGRITY_STAGE,
        moment: 'after_session',
      },
    });
    expect(judgeKinds(h)).toEqual(['red_check']);
    expect(judgmentsOf(h)).toEqual([]);
  }, 60_000);

  it('판정이 도는 동안 규칙이 고쳐지면 그 판정 결과를 기록하지 않고 failed (판정 뒤 대조)', async () => {
    const h = setup({
      onJudge: (call: JudgeCall) => {
        if (call.kind !== 'check') return;
        tamper(
          h,
          "UPDATE rules SET statement = 'WHEN x THE SYSTEM SHALL y' WHERE id = ?",
          h.rule.id,
        );
      },
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'failed', failureReason: 'judge_runner_error' });
    expect(exitOf(done, 'check')).toMatchObject({
      detail: {
        stage: NORM_INTEGRITY_STAGE,
        moment: 'after_judge',
        mismatches: [
          {
            kind: 'untrusted_change',
            detail: expect.stringContaining('rules') as unknown as string,
          },
        ],
      },
    });
    // 구현 판정 기록만 있고 검사 판정 기록은 없다
    expect(judgmentsOf(h).map((r) => r.stepId)).toEqual([stepOf(done, 'implementation').id]);
  }, 60_000);

  // 검토 1회차: 좁힌 대조가 놓친 직접 SQL 위조. 오케스트레이터 저장소를 거치지 않은 변경은 무엇이든 불일치다
  const forgeries: [string, (h: PipelineHarness) => void, string][] = [
    [
      '승인된 규칙 행 INSERT',
      (h) =>
        rawDb(h, (db) => {
          db.prepare(
            `INSERT INTO rules (id, display_id, title, statement, kind, check_kinds, parent_requirement_id,
             parent_detached_at, builtin, target_block_ids, risk, contract_id, author, norm_state, created_at,
             updated_at, deleted_at) VALUES (?, 'RULE-777', '위조', 'WHEN x THE SYSTEM SHALL y', 'business', '["test"]',
             ?, NULL, 0, '[]', NULL, NULL, '{"kind":"human"}', 'approved', ?, ?, NULL)`,
          ).run(
            newId(),
            h.rule.parentRequirementId,
            new Date().toISOString(),
            new Date().toISOString(),
          );
        }),
      'rules',
    ],
    [
      '체인을 맞춘 승인 기록 꼬리 추가',
      (h) =>
        rawDb(h, (db) => {
          const last = db
            .prepare('SELECT seq, hash FROM approval_log ORDER BY seq DESC LIMIT 1')
            .get() as { seq: number; hash: string } | undefined;
          const entry = {
            seq: (last?.seq ?? 0) + 1,
            at: new Date().toISOString(),
            action: 'approve' as const,
            actor: { kind: 'human' as const },
            targetRef: { entity: 'Proposal' as const, id: newId() },
            clientId: 'pipe-1',
            detail: { appliedRef: { entity: 'Rule' as const, id: newId() } },
            prevHash: last?.hash ?? APPROVAL_LOG_GENESIS_HASH,
          };
          db.prepare(
            'INSERT INTO approval_log (seq, at, action, actor, target_ref, client_id, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(
            entry.seq,
            entry.at,
            entry.action,
            canonicalJson(entry.actor),
            canonicalJson(entry.targetRef),
            entry.clientId,
            canonicalJson(entry.detail),
            entry.prevHash,
            computeApprovalLogHash(entry),
          );
        }),
      'approval_log',
    ],
    [
      '규칙 열 UPDATE (대상 블록)',
      (h) =>
        rawDb(h, (db) => {
          db.prepare(`UPDATE rules SET target_block_ids = '["blk"]' WHERE id = ?`).run(h.rule.id);
        }),
      'rules',
    ],
    [
      '미래 시각의 pass 판정 행',
      (h) =>
        rawDb(h, (db) => {
          db.exec('DROP TRIGGER IF EXISTS judgments_no_future;');
          db.prepare(
            `INSERT INTO judgments (id, rule_id, run_id, step_id, commit_sha, judged_at, status, runner, exit_code,
             reporter_path, cases, quarantine_reason) VALUES (?, ?, NULL, NULL, ?, '2999-01-01T00:00:00.000Z',
             'pass', 'vitest', 0, NULL, '[]', NULL)`,
          ).run(newId(), h.rule.id, 'f'.repeat(40));
        }),
      'judgments',
    ],
  ];

  it.each(forgeries)(
    '구현 세션 동안 별도 연결로 %s → 판정하지 않고 failed(norm_integrity)',
    async (_name, forge, table) => {
      const h = setup({
        wrapAdapter: (adapter, harness) =>
          hookAdapter(adapter, {
            beforeResult: (spec) => {
              if (spec.role === 'implementer') forge(harness());
            },
          }),
      });
      const done = await runToEnd(h);
      expect(done.run).toMatchObject({ status: 'failed', failureReason: 'judge_runner_error' });
      const detail = exitOf(done, 'implementation').detail as Record<string, unknown>;
      expect(detail).toMatchObject({ stage: NORM_INTEGRITY_STAGE, moment: 'after_session' });
      expect(JSON.stringify(detail.mismatches)).toContain(table);
      expect(judgeKinds(h)).toEqual(['red_check']);
      // 위조한 미래 판정 행은 최신 판정으로 보이지 않는다
      const latest = withProject(h.biveHome, h.project.id, (store) => storedLatestJudgments(store));
      expect(latest(h.rule.id)).toBeNull();
    },
    60_000,
  );

  it('실행 중 사람의 승인 · 실행 시작(승인 기록 추가 · 새 규칙)은 불일치가 아니다', async () => {
    // 오케스트레이터 프로세스의 저장소(ProjectStore)를 거친 쓰기는 쓰기 장부에 남아 믿는 상태가 된다. 사람의 승인 RPC ·
    // 실행 생성이 같은 경로다(같은 프로세스의 withProject). 별도 연결의 쓰기는 위 위조 시험처럼 불일치다
    const h = setup({
      wrapAdapter: (adapter, harness) =>
        hookAdapter(adapter, {
          beforeResult: (spec) => {
            if (spec.role !== 'implementer') return;
            const { biveHome, project, rule } = harness();
            withProject(biveHome, project.id, (store) => {
              const added = store.rules.create({
                id: newId(),
                title: '실행 중 승인된 규칙',
                statement: 'WHEN GET /api/x THE SYSTEM SHALL 응답한다',
                kind: 'business',
                checkKinds: ['test'],
                parentRequirementId: rule.parentRequirementId,
                builtin: false,
                targetBlockIds: [],
                risk: null,
                contractId: null,
                author: { kind: 'agent', role: 'rule-writer' },
                normState: 'approved',
                createdAt: new Date().toISOString(),
              });
              store.approvalLog.append({
                at: new Date().toISOString(),
                action: 'approve',
                actor: human,
                targetRef: { entity: 'Proposal', id: newId() },
                clientId: 'pipe-1',
                detail: { appliedRef: { entity: 'Rule', id: added.id } },
              });
            });
          },
        }),
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'merged', failureReason: null });
  }, 60_000);
});

describe('판정 설정 · 인수 테스트 검사: 스냅숏 쓰기 금지 (코멘트 기준, ADR-069)', () => {
  it('생성 설정은 스냅숏을 갱신하지 않는다(update: none)', () => {
    const config = buildJudgeConfig({
      mode: 'run',
      worktreeDir: '/w',
      judgeDir: '/j',
      globalSetupPath: '/j/g.mjs',
      resultPath: '/j/r.json',
      cacheDir: '/j/c',
      httpHelperPath: '/j/h.mjs',
      ruleIds: null,
    });
    expect(config.test.update).toBe('none');
  });

  it('인수 테스트 검사는 스냅숏 단언(toMatchSnapshot · toMatchInlineSnapshot · toMatchFileSnapshot 등)을 거부한다', () => {
    const source = (body: string) =>
      `import { expect, it } from 'vitest';\n\nit('x', async () => {\n  ${body}\n});\n`;
    for (const body of [
      'expect(1).toMatchSnapshot();',
      'expect(1).toMatchInlineSnapshot();',
      "await expect('x').toMatchFileSnapshot('../../src/lib/pwned.ts');",
      'expect(() => 1).toThrowErrorMatchingSnapshot();',
      'expect(() => 1).toThrowErrorMatchingInlineSnapshot();',
      "const m = 'toMatchSnapshot'; (expect(1) as any)[m]();",
    ]) {
      const problems = lintAcceptanceSource(source(body));
      expect(problems.map((p) => p.message).join('\n'), body).toMatch(/스냅숏 단언/);
    }
    expect(lintAcceptanceSource(source('expect({ a: 1 }).toEqual({ a: 1 });'))).toEqual([]);
  });
});
