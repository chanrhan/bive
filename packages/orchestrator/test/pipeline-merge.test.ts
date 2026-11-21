// 판정 통과 → 병합 연결 (M1-16 수용 기준 4, RUN-08 · JDG-01 · COST-01, ADR-017 · ADR-058 · ADR-065 · ADR-066 · ADR-069).
// 픽스처 통합: 픽스처 git 복사본 · 실제 git 병합(M1-13 `merge`) · 실제 SQLite · ScriptedAdapter · 제품 단계 실행기.
// `실제 판정` 묶음 1건만 실제 의존성 설치 · 판정 러너(next build · next start · vitest)로 유형 A를 끝까지 돌고, 나머지는
// 판정 · 설치를 주입한다(체크아웃 · 커밋 · 병합 · 재검사 체크아웃은 실제 git).
// 제한: 엔진 · git을 띄우는 테스트 60초, 실제 판정 완주 600초(설치 3회 + 빌드 3회 + 기동 · vitest, 이 VM 단독 실측 52초), afterEach 120초(실제
// 판정이 설치한 node_modules 삭제가 부하에서 기본 훅 10초를 넘는다, ADR-064).
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Run } from '@bive/shared';

import type { PipelineEngine } from '../src/engine/pipeline-engine.js';
import {
  createWorktreeManager,
  type MergeOptions,
  type WorktreeManager,
} from '../src/git/worktree-manager.js';
import { DEFAULT_INSTALL_TIMEOUT_MS } from '../src/judge/checkout.js';
import { DEFAULT_JUDGE_TIMEOUT_MS } from '../src/steps/judging.js';
import { createGitRunner, type GitRunner } from '../src/git/git-exec.js';
import {
  MERGE_CHECK_MARGIN_MS,
  MERGE_ORDER_TIMEOUT_MS,
  readMergeOrder,
} from '../src/steps/merge.js';
import { basisOf, mergeRecordOf } from '../src/verification/summary.js';
import { human, ROUTE, userGit, withProject } from './helpers/engine-harness.js';
import {
  attempts,
  before,
  detailOf,
  exitOf,
  judgmentsOf,
  type PipelineHarness,
  type PipelineSetupOptions,
  runToEnd,
  setupPipeline,
  stepOf,
} from './helpers/pipeline-harness.js';
import { cleanup } from './helpers/process.js';

const temps: string[] = [];
const engines: PipelineEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}, 120_000);

const setup = (options: Omit<PipelineSetupOptions, 'temps' | 'engines'> = {}): PipelineHarness =>
  setupPipeline({ ...options, temps, engines });

const mainTip = (h: PipelineHarness): string => userGit(h.repo, 'rev-parse', 'refs/heads/main');
const parentsOf = (h: PipelineHarness, commit: string): string[] =>
  userGit(h.repo, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);
/** 그 커밋의 전체 조상 수 (병합 순서 값과 같은 계산, 시험 쪽은 사용자 git, ADR-096). */
const ancestorCount = (h: PipelineHarness, commit: string): number =>
  Number(userGit(h.repo, 'rev-list', '--count', commit));
/** 첫 부모 커밋 수 (이전 시도의 순서 값, 빨리 감기에서 줄어드는 것을 보이는 대조용). */
const firstParentCount = (h: PipelineHarness, commit: string): number =>
  Number(userGit(h.repo, 'rev-list', '--count', '--first-parent', commit));
/** 제품의 순서 값 읽기로 커밋의 순서 값을 읽는다 (BIVE 실행이 아닌 병합 커밋용). */
const productOrder = async (h: PipelineHarness, commit: string): Promise<number> => {
  const read = await readMergeOrder(createGitRunner(), h.repo, commit);
  if (read.mergeOrder === null) throw new Error(`순서 값 읽기 실패: ${read.mergeOrderError}`);
  return read.mergeOrder;
};
/** 사람이 기준 브랜치에서 작업 브랜치를 만들어 커밋하고 `--no-ff`로 병합한다 (제품 병합과 같은 모양). 병합 커밋을 돌려준다. */
const humanMerge = (repo: string, branch: string, file: string): string => {
  userGit(repo, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(repo, file), `${branch}\n`);
  userGit(repo, 'add', file);
  userGit(repo, 'commit', '-q', '-m', `${branch} 작업`);
  userGit(repo, 'checkout', '-q', 'main');
  userGit(repo, 'merge', '-q', '--no-ff', '-m', `${branch} 병합`, branch);
  return userGit(repo, 'rev-parse', 'HEAD');
};
/** 판정 기준 고르기에 넘길 다른 실행 (테스트 전용: 순서에 쓰는 칸만 바꾼다). */
const otherRun = (like: Run, mergeCommit: string): Run => ({
  ...like,
  id: '01JE0000000000000000000000',
  displayId: 'EXE-900',
  mergeCommit,
});

const mergeCount = (h: PipelineHarness): number =>
  Number(userGit(h.repo, 'rev-list', '--merges', '--count', 'refs/heads/main'));

const isLocked = (h: PipelineHarness, worktree: string): boolean =>
  userGit(h.repo, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .some(
      (entry) =>
        entry.includes(`worktree ${fs.realpathSync(worktree)}`) && entry.includes('\nlocked'),
    );

/** 병합 직전 사용자가 기준 브랜치에 겹치지 않는 커밋을 만든다 (병합 커밋으로 검사를 다시 돈다). */
const userCommitsOnMain = (repo: string): void => {
  fs.writeFileSync(path.join(repo, 'NOTES.md'), '사용자 메모\n');
  userGit(repo, 'add', 'NOTES.md');
  userGit(repo, 'commit', '-q', '-m', '사용자 커밋');
};

/** 관리자의 `merge` 호출 옵션을 기록하는 감싸기. */
const recordingManager = (
  calls: MergeOptions[],
  after?: () => void,
): ((biveHome: string) => WorktreeManager) => {
  return (biveHome) => {
    const inner = createWorktreeManager({ biveHome });
    return {
      ...inner,
      merge: async (run, options) => {
        calls.push(options);
        const result = await inner.merge(run, options);
        after?.();
        return result;
      },
    };
  };
};

describe('판정 통과 → merge → main에 merge commit (수용 기준 4, RUN-08)', () => {
  it('기준 브랜치가 그대로면 검사 없이 --no-ff merge commit을 만들고, 관리자에 검사 제한 시간 · 중단 신호를 넘긴다', async () => {
    const calls: MergeOptions[] = [];
    const h = setup({ worktrees: recordingManager(calls) });
    const base = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'merged', failureReason: null, currentStep: null });
    expect(attempts(done, 'check', 'mutation', 'merge', 'screen_update')).toEqual([
      'check#1:passed',
      'mutation#1:skipped',
      'merge#1:passed',
      'screen_update#1:passed',
    ]);
    const merge = String(done.run.mergeCommit);
    expect(mainTip(h)).toBe(merge);
    expect(parentsOf(h, merge)).toEqual([base, String(done.run.headCommit)]);
    expect(userGit(h.repo, 'log', '-1', '--format=%an <%ae>%n%B', merge)).toContain(
      'BIVE <bive@bive.invalid>',
    );
    expect(exitOf(done, 'merge')).toMatchObject({ mergeCommit: merge, rechecked: false });
    // 병합 순서 값: 병합 커밋의 전체 조상 수 (ADR-096). 기준 커밋보다 크다
    expect(exitOf(done, 'merge').mergeOrder).toBe(ancestorCount(h, merge));
    expect(exitOf(done, 'merge')).not.toHaveProperty('mergeOrderError');
    expect(ancestorCount(h, merge)).toBeGreaterThan(ancestorCount(h, base));
    // 판정 재검사는 없었다 (구현 · 검사 판정만)
    expect(h.judgeCalls.map((c) => c.kind)).toEqual(['red_check', 'implementation', 'check']);
    // ADR-065: 관리자 기본 제한 없음 → 실행기가 설치 + 판정 제한 + 여유를 넘긴다
    expect(calls).toHaveLength(1);
    expect(calls[0]?.checkTimeoutMs).toBe(
      DEFAULT_INSTALL_TIMEOUT_MS + DEFAULT_JUDGE_TIMEOUT_MS + MERGE_CHECK_MARGIN_MS,
    );
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    // 실행 브랜치는 병합 뒤에도 남는다 (ADR-058)
    expect(userGit(h.repo, 'branch', '--list', 'bive/run-EXE-001')).toContain('bive/run-EXE-001');
  }, 60_000);

  it('기준 브랜치가 바뀌었으면 병합 커밋의 깨끗한 체크아웃에서 승인된 규칙 전체를 다시 판정하고 통과할 때만 병합한다', async () => {
    const h = setup({
      merge: { checkTimeoutMs: 90_000 },
      executors: (defaults) => ({
        ...defaults,
        merge: before(defaults.merge, (context) => userCommitsOnMain(context.git.repoPath)),
      }),
    });
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    const merge = String(done.run.mergeCommit);
    expect(exitOf(done, 'merge')).toMatchObject({
      rechecked: true,
      checkTimeoutMs: 90_000,
      recheck: {
        mergeCommit: merge,
        ruleIds: ['RULE-001'],
        judgeStatus: 'completed',
        judgments: [{ ruleId: 'RULE-001', status: 'pass' }],
      },
    });
    const recheck = h.judgeCalls.find((c) => c.kind === 'merge');
    expect(recheck?.head).toBe(merge);
    expect(recheck?.installed).toBe(true);
    // 재검사 판정도 규칙별로 기록한다 (병합 단계 · 병합 커밋)
    const last = judgmentsOf(h).at(-1);
    expect(last).toMatchObject({
      ruleId: h.rule.id,
      status: 'pass',
      commit: merge,
      stepId: stepOf(done, 'merge').id,
    });
    expect(userGit(h.repo, 'show', `${merge}:NOTES.md`)).toBe('사용자 메모');
  }, 60_000);

  it('재검사가 실패하면 병합하지 않고 failed(check_failed), 기준 브랜치 · 실행 브랜치 그대로', async () => {
    const h = setup({
      decide: (call) =>
        Object.fromEntries(
          (call.input.ruleIds ?? []).map((id) => [
            id,
            call.kind === 'red_check' || call.kind === 'merge' ? ['failed'] : ['passed'],
          ]),
        ),
      executors: (defaults) => ({
        ...defaults,
        merge: before(defaults.merge, (context) => userCommitsOnMain(context.git.repoPath)),
      }),
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'check_failed',
      mergeCommit: null,
    });
    expect(exitOf(done, 'merge')).toMatchObject({
      reason: 'check_failed',
      detail: { checkDetail: '실패한 규칙: RULE-001', recheck: { judgeStatus: 'completed' } },
    });
    expect(userGit(h.repo, 'log', '-1', '--format=%s', 'refs/heads/main')).toBe('사용자 커밋');
    expect(mergeCount(h)).toBe(0);
    expect(isLocked(h, String(done.run.worktreePath))).toBe(true);
  }, 60_000);
});

describe('실패 · 예산 초과 종료: 브랜치 보존 · 병합 없음 (수용 기준 4, RUN-08 · COST-01)', () => {
  it('구현 실패 3회(fail-check)는 failed(regression_limit), 브랜치 · 워크트리 보존, main 그대로', async () => {
    const calls: MergeOptions[] = [];
    const h = setup({ scenario: 'fail-check', worktrees: recordingManager(calls) });
    const base = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'regression_limit',
      mergeCommit: null,
    });
    expect(attempts(done, 'merge')).toEqual(['merge#1:pending']);
    expect(calls).toEqual([]);
    expect(mainTip(h)).toBe(base);
    expect(mergeCount(h)).toBe(0);
    expect(userGit(h.repo, 'branch', '--list', 'bive/run-EXE-001')).toContain('bive/run-EXE-001');
    expect(isLocked(h, String(done.run.worktreePath))).toBe(true);
  }, 60_000);

  it('구현 세션의 예산 초과(budget-exceeded)는 budget_exceeded, 판정 · 병합 없음, 브랜치 보존', async () => {
    const calls: MergeOptions[] = [];
    const h = setup({ scenario: 'budget-exceeded', worktrees: recordingManager(calls) });
    const base = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'budget_exceeded',
      failureReason: 'error_max_budget_usd',
      mergeCommit: null,
    });
    expect(h.judgeCalls.map((c) => c.kind)).toEqual(['red_check']);
    expect(judgmentsOf(h)).toEqual([]);
    expect(calls).toEqual([]);
    expect(mainTip(h)).toBe(base);
    expect(isLocked(h, String(done.run.worktreePath))).toBe(true);
  }, 60_000);
});

describe('병합 단계 중단 뒤 재개 (코멘트 기준, ADR-066 한계)', () => {
  it('기준 브랜치가 이미 갱신된 뒤 재개하면 no_changes 대신 그 병합 커밋으로 merged로 마무리한다', async () => {
    let stopped = false;
    const ref: { harness?: PipelineHarness } = {};
    const h = setup({
      worktrees: recordingManager([], () => {
        // 병합이 기준 브랜치를 갱신한 직후 오케스트레이터가 죽은 것처럼 엔진을 멈춘다 (단계 결과는 저장되지 않음)
        if (stopped || ref.harness === undefined) return;
        stopped = true;
        void ref.harness.engine.stop();
      }),
    });
    ref.harness = h;
    const base = mainTip(h);
    expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
    await h.engine.settled();
    const crashed = detailOf(h);
    expect(crashed.run).toMatchObject({
      status: 'running',
      currentStep: 'merge',
      mergeCommit: null,
    });
    const merged = mainTip(h);
    expect(merged).not.toBe(base);

    // 재기동: running → interrupted, 재개(사람) → 병합 단계 새 시도
    const engine = h.newEngine();
    expect(engine.recoverInterruptedRuns().map((r) => r.runId)).toEqual([h.runId]);
    await engine.resume(h.project.id, h.runId, human);
    await engine.settled();
    const done = detailOf(h);
    expect(done.run).toMatchObject({ status: 'merged', mergeCommit: merged, failureReason: null });
    expect(attempts(done, 'merge')).toEqual(['merge#1:failed', 'merge#2:passed']);
    expect(exitOf(done, 'merge', 2)).toEqual({
      mergeCommit: merged,
      mergeOrder: ancestorCount(h, merged),
      headCommit: done.run.headCommit,
      recovered: true,
    });
    // 병합 커밋은 하나뿐이다
    expect(mainTip(h)).toBe(merged);
    expect(mergeCount(h)).toBe(1);
  }, 60_000);

  it('A 병합 직후 중단 → 다른 병합 B가 쌓임 → A 재개 복구: A의 순서 값은 A의 병합 커밋 값이라 B보다 작고, 판정 기준은 B다 (#195 ⓐ)', async () => {
    let stopped = false;
    const ref: { harness?: PipelineHarness } = {};
    const h = setup({
      worktrees: recordingManager([], () => {
        if (stopped || ref.harness === undefined) return;
        stopped = true;
        void ref.harness.engine.stop();
      }),
    });
    ref.harness = h;
    expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
    await h.engine.settled();
    expect(detailOf(h).run).toMatchObject({ status: 'running', currentStep: 'merge' });
    const merged = mainTip(h);
    // A가 중단된 동안 기준 브랜치 끝에서 다른 병합 B가 쌓인다 (제품 병합과 같은 모양의 실제 git 병합 커밋)
    const later = humanMerge(h.repo, 'other-work', 'OTHER.md');
    expect(parentsOf(h, later)[0]).toBe(merged);
    const bMergedAt = new Date().toISOString();

    const engine = h.newEngine();
    expect(engine.recoverInterruptedRuns().map((r) => r.runId)).toEqual([h.runId]);
    await engine.resume(h.project.id, h.runId, human);
    await engine.settled();
    const done = detailOf(h);
    expect(done.run).toMatchObject({ status: 'merged', mergeCommit: merged });
    expect(attempts(done, 'merge')).toEqual(['merge#1:failed', 'merge#2:passed']);
    const recovered = exitOf(done, 'merge', 2);
    expect(recovered).toMatchObject({ mergeCommit: merged, recovered: true });
    // 저장된 값은 기준 브랜치 끝(B)이 아니라 찾은 A의 병합 커밋의 조상 수다
    expect(recovered.mergeOrder).toBe(ancestorCount(h, merged));
    expect(recovered.mergeOrder).not.toBe(ancestorCount(h, mainTip(h)));
    const bOrder = await productOrder(h, later);
    expect(recovered.mergeOrder as number).toBeLessThan(bOrder);
    expect(mainTip(h)).toBe(later);
    expect(mergeCount(h)).toBe(2);

    // 통과 기록 시각은 A(재개 시점)가 B보다 늦다: 시각으로 고르면 A, 저장된 순서 값으로 고르면 B
    const aRecord = mergeRecordOf(done.run, done.steps);
    expect(aRecord?.order).toBe(recovered.mergeOrder);
    expect(Date.parse(String(aRecord?.at))).toBeGreaterThan(Date.parse(bMergedAt));
    const b = otherRun(done.run, later);
    /** 두 후보의 순서 값을 쓰거나(`true`) 지운(`false`, 저장 전 기록처럼 시각만) 기록으로 판정 기준을 고른다. */
    const pick = (withOrder: boolean) =>
      basisOf([done.run, b], {
        mergeOf: (run) => {
          const record =
            run.id === b.id ? { at: bMergedAt, order: bOrder } : mergeRecordOf(run, done.steps);
          return record === null || withOrder ? record : { ...record, order: null };
        },
        branch: 'main',
      })?.commit;
    expect(pick(true)).toBe(later);
    expect(pick(false)).toBe(merged);
  }, 60_000);

  it('A 병합 → 사람이 오래된 작업 브랜치에 main을 병합하고 main을 빨리 감기 → 제품 병합 B: B의 순서 값이 A보다 크고 판정 기준은 B다 (#195 ⓑ)', async () => {
    const history = { a: '', featureBase: '' };
    const h = setup({
      merge: { checkTimeoutMs: 90_000 },
      executors: (defaults) => ({
        ...defaults,
        merge: before(defaults.merge, (context) => {
          const repo = context.git.repoPath;
          history.featureBase = userGit(repo, 'rev-parse', 'HEAD');
          // 기준 브랜치에 커밋이 쌓인 뒤 A가 병합된다
          for (const n of [1, 2, 3, 4, 5, 6]) {
            fs.writeFileSync(path.join(repo, `NOTE${String(n)}.md`), `${String(n)}\n`);
            userGit(repo, 'add', `NOTE${String(n)}.md`);
            userGit(repo, 'commit', '-q', '-m', `사용자 커밋 ${String(n)}`);
          }
          history.a = humanMerge(repo, 'run-a', 'A.md');
          // 사람: 오래전에 갈라진 작업 브랜치에 main을 병합(main이 둘째 부모)하고 main을 그 커밋으로 빨리 감기
          userGit(repo, 'checkout', '-q', '-b', 'feature', history.featureBase);
          fs.writeFileSync(path.join(repo, 'FEATURE.md'), '사람 작업\n');
          userGit(repo, 'add', 'FEATURE.md');
          userGit(repo, 'commit', '-q', '-m', '사람 작업');
          userGit(repo, 'merge', '-q', '--no-edit', 'main');
          userGit(repo, 'checkout', '-q', 'main');
          userGit(repo, 'merge', '-q', '--ff-only', 'feature');
        }),
      }),
    });
    const done = await runToEnd(h);
    expect(done.run.status).toBe('merged');
    const b = String(done.run.mergeCommit);
    expect(mainTip(h)).toBe(b);
    expect(exitOf(done, 'merge')).toMatchObject({ mergeCommit: b, rechecked: true });
    const bOrder = exitOf(done, 'merge').mergeOrder as number;
    expect(bOrder).toBe(ancestorCount(h, b));
    const aOrder = await productOrder(h, history.a);
    // 첫 부모 커밋 수는 이 흐름에서 거꾸로 된다 (이전 시도의 값). 전체 조상 수는 나중 병합이 크다
    expect(firstParentCount(h, b)).toBeLessThan(firstParentCount(h, history.a));
    expect(aOrder).toBeLessThan(bOrder);
    // A의 통과 기록이 더 늦어도 순서 값으로 B를 고른다
    const a = otherRun(done.run, history.a);
    const late = new Date(Date.now() + 60_000).toISOString();
    const basis = basisOf([a, done.run], {
      mergeOf: (run) =>
        run.id === a.id ? { at: late, order: aOrder } : mergeRecordOf(run, done.steps),
      branch: 'main',
    });
    expect(basis).toEqual({ branch: 'main', commit: b, runId: done.run.id });
  }, 60_000);

  it('이 실행의 BIVE 병합 커밋이 아니면(사람이 직접 병합) no_changes로 failed', async () => {
    const h = setup({
      executors: (defaults) => ({
        ...defaults,
        merge: before(defaults.merge, (context) => {
          // 사람이 실행 브랜치를 직접 fast-forward로 가져갔다 (BIVE 트레일러 없음)
          userGit(context.git.repoPath, 'merge', '-q', '--ff-only', context.git.branch);
        }),
      }),
    });
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'failed', failureReason: 'no_changes' });
    expect(mergeCount(h)).toBe(0);
  }, 60_000);

  // 검토 1회차: 트레일러만 흉내 낸 병합 커밋(검사하지 않은 파일 포함)을 복구로 인정하면 안 된다
  const forgeMerge = (h: PipelineHarness, repo: string, branch: string): void => {
    userGit(repo, 'merge', '-q', '--no-ff', '--no-commit', branch);
    fs.writeFileSync(path.join(repo, 'UNCHECKED.ts'), 'export const unchecked = true;\n');
    userGit(repo, 'add', 'UNCHECKED.ts');
    userGit(
      repo,
      'commit',
      '-q',
      '-m',
      `BIVE 실행 EXE-001 병합\n\nBive-Run: EXE-001\nBive-Project: ${h.project.id}\nBive-Branch: ${branch}`,
    );
  };

  it('첫 병합 시도(중단 뒤 재개 아님)의 no_changes는 BIVE 병합 커밋처럼 보여도 복구하지 않고 failed', async () => {
    const ref: { harness?: PipelineHarness } = {};
    const h = setup({
      executors: (defaults) => ({
        ...defaults,
        merge: before(defaults.merge, (context) => {
          if (ref.harness !== undefined) {
            forgeMerge(ref.harness, context.git.repoPath, context.git.branch);
          }
        }),
      }),
    });
    ref.harness = h;
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'no_changes',
      mergeCommit: null,
    });
    expect(attempts(done, 'merge')).toEqual(['merge#1:failed']);
  }, 60_000);

  it('재개 뒤에도 병합 커밋의 트리가 기대 병합 결과(merge-tree)와 다르면 복구하지 않고 failed', async () => {
    let stopped = false;
    const ref: { harness?: PipelineHarness } = {};
    const h = setup({
      worktrees: (biveHome) => {
        const inner = createWorktreeManager({ biveHome });
        return {
          ...inner,
          merge: (run, options) => {
            // 첫 병합은 하지 않고, 누군가 트레일러만 흉내 낸 병합 커밋을 만든 뒤 오케스트레이터가 죽은 것처럼 멈춘다
            if (!stopped && ref.harness !== undefined) {
              stopped = true;
              forgeMerge(ref.harness, run.repoPath, run.branch);
              void ref.harness.engine.stop();
              return Promise.resolve({
                status: 'failed',
                reason: 'aborted',
                message: '중단',
                branch: run.branch,
                headCommit: null,
              });
            }
            return inner.merge(run, options);
          },
        };
      },
    });
    ref.harness = h;
    expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
    await h.engine.settled();
    expect(detailOf(h).run).toMatchObject({ status: 'running', currentStep: 'merge' });

    const engine = h.newEngine();
    expect(engine.recoverInterruptedRuns().map((r) => r.runId)).toEqual([h.runId]);
    await engine.resume(h.project.id, h.runId, human);
    await engine.settled();
    const done = detailOf(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'no_changes',
      mergeCommit: null,
    });
    expect(exitOf(done, 'merge', 2)).toMatchObject({
      reason: 'no_changes',
      detail: { recovery: { mergeCommit: mainTip(h), reason: 'tree_mismatch' } },
    });
  }, 60_000);
});

describe('병합 순서 값 읽기의 실패 · 시간 제한 (#195 · ADR-096)', () => {
  /** 실제 git에 `rev-list --count`만 바꿔 끼운 실행기. 받은 제한 시간을 기록한다. */
  const orderGit = (
    behave: (args: readonly string[]) => Promise<{ stdout: string; stderr: string; code: number }>,
    seen: (number | undefined)[],
  ): GitRunner => {
    const real = createGitRunner();
    return (args, options) => {
      if (args.includes('rev-list') && args.includes('--count')) {
        seen.push(options.timeoutMs);
        return behave(args);
      }
      return real(args, options);
    };
  };

  /** 순서 값만 없고 나머지는 정상 병합과 같은지 본다. */
  const expectMergedWithoutOrder = (
    h: PipelineHarness,
    done: Awaited<ReturnType<typeof runToEnd>>,
  ) => {
    expect(done.run).toMatchObject({ status: 'merged', failureReason: null, currentStep: null });
    expect(attempts(done, 'merge', 'screen_update')).toEqual([
      'merge#1:passed',
      'screen_update#1:passed',
    ]);
    const merge = String(done.run.mergeCommit);
    expect(mainTip(h)).toBe(merge);
    expect(exitOf(done, 'merge')).toMatchObject({
      mergeCommit: merge,
      rechecked: false,
      mergeOrder: null,
    });
    expect(mergeRecordOf(done.run, done.steps)?.order).toBeNull();
  };

  it('읽기가 던지면 순서 값 없음(사유 기록)으로 남고 병합 결과 · 단계 기록 · 실행 종료 상태는 그대로다 (기본 제한 시간을 git에 넘긴다)', async () => {
    const seen: (number | undefined)[] = [];
    const h = setup({
      merge: { git: orderGit(() => Promise.reject(new Error('가짜 git 실패')), seen) },
    });
    const done = await runToEnd(h);
    expectMergedWithoutOrder(h, done);
    expect(exitOf(done, 'merge').mergeOrderError).toBe('가짜 git 실패');
    expect(seen).toEqual([MERGE_ORDER_TIMEOUT_MS]);
    expect(MERGE_ORDER_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  }, 60_000);

  it('git 오류 종료 코드면 그 메시지로, 조상 수가 아닌 출력이면 값 없음으로 남는다', async () => {
    const h = setup({
      merge: {
        git: orderGit(
          () => Promise.resolve({ stdout: '', stderr: 'fatal: bad object\n', code: 128 }),
          [],
        ),
      },
    });
    const done = await runToEnd(h);
    expectMergedWithoutOrder(h, done);
    expect(exitOf(done, 'merge').mergeOrderError).toBe('fatal: bad object');
  }, 60_000);

  it('읽기가 끝나지 않아도 제한 시간 뒤 순서 값 없음(timeout)으로 병합 단계를 통과한다 (실행기가 제한 시간을 지키지 않아도)', async () => {
    const seen: (number | undefined)[] = [];
    const h = setup({
      merge: {
        mergeOrderTimeoutMs: 200,
        git: orderGit(() => new Promise(() => undefined), seen),
      },
    });
    const done = await runToEnd(h);
    expectMergedWithoutOrder(h, done);
    expect(exitOf(done, 'merge').mergeOrderError).toBe('timeout');
    expect(seen).toEqual([200]);
    const merge = stepOf(done, 'merge');
    expect(Date.parse(String(merge.endedAt)) - Date.parse(String(merge.startedAt))).toBeLessThan(
      10_000,
    );
  }, 60_000);
});

describe('실제 판정: 유형 A 완주 (픽스처 · 실제 설치 · 판정 러너)', () => {
  it('happy-path: 실제 판정 러너로 Red → 구현 판정 통과 → 검사 통과 → main에 merge commit, 판정 기록 pass', async () => {
    const h = setup({ realJudgeTimeoutMs: 240_000 });
    const base = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({ status: 'merged', failureReason: null });
    const merge = String(done.run.mergeCommit);
    expect(mainTip(h)).toBe(merge);
    expect(parentsOf(h, merge)).toEqual([base, String(done.run.headCommit)]);
    expect(userGit(h.repo, 'show', `${merge}:${ROUTE}`)).toContain('toISOString()');

    const records = judgmentsOf(h);
    expect(records.map((r) => [stepOf(done, 'implementation').id === r.stepId, r.status])).toEqual([
      [true, 'pass'],
      [false, 'pass'],
    ]);
    const check = records[1];
    expect(check).toMatchObject({
      ruleId: h.rule.id,
      commit: done.run.headCommit,
      stepId: stepOf(done, 'check').id,
      exitCode: 0,
      runner: 'vitest',
    });
    expect(check?.cases).toEqual([
      expect.objectContaining({
        file: 'bive-acceptance/RULE-001/health-time.acc.ts',
        status: 'passed',
        line: expect.any(Number) as unknown as number,
      }),
    ]);
    // 원본 JSON은 에이전트가 닿지 않는 판정 폴더에 남는다
    expect(check?.reporterPath).toContain(path.join(h.biveHome, 'projects', h.project.id, 'judge'));
    expect(fs.existsSync(String(check?.reporterPath))).toBe(true);
    // 판정 체크아웃은 지워졌다
    expect(
      fs.readdirSync(
        path.join(fs.realpathSync(h.biveHome), 'work', h.project.id, 'judge', 'EXE-001'),
      ),
    ).toEqual([]);
    expect(withProject(h.biveHome, h.project.id, (store) => store.runs.get(h.runId)?.status)).toBe(
      'merged',
    );
  }, 600_000);
});
