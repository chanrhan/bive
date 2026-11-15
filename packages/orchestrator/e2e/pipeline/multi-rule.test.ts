// 파이프라인 e2e: 다규칙 (M2-04 · #170, JDG-01 · JDG-02 · RUN-04 · RUN-08, ADR-071 · ADR-083 · ADR-092).
// 한 프로젝트에서 요구사항 1개 → 규칙 제안 2개 → 둘 다 승인(RULE-001 time · RULE-002 version) → 실행 1(RULE-001) 병합 →
// 실행 2(RULE-002). 실행 2의 검사 단계가 이미 병합된 RULE-001의 인수 테스트까지 실제 판정 러너로 다시 돌리는지 본다.
// - multi-rule: 실행 2의 구현이 time을 유지하고 version을 더해 두 규칙 모두 통과, 병합
// - multi-rule-regress: 실행 2의 구현이 time을 지운다. 구현 단계(대상 규칙만 판정)는 통과하고 검사 단계가 RULE-001 실패를
//   잡아 회귀 상한까지 반복한 뒤 실행이 실패, 기준 브랜치는 실행 1의 병합 커밋 그대로
import type { JudgmentResult, Rule, RunGetResult, Step } from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  approveRule,
  attempts,
  branchExists,
  cleanupPipeline,
  git,
  mainTip,
  mergeCount,
  parentsOf,
  type PipelineE2e,
  readStore,
  ROUTE,
  RUN_BRANCH,
  runToEnd,
  saveRequirement,
  startPipeline,
} from './harness.js';

afterEach(cleanupPipeline);

/** 두 번째 실행의 브랜치 (ADR-058) */
const RUN2_BRANCH = 'bive/run-EXE-002';
const TIME_TITLE = '헬스 체크 응답의 서버 시각';
const VERSION_TITLE = '헬스 체크 응답의 버전';
const TIME_TEST = 'bive-acceptance/RULE-001/health-time.acc.ts';
const VERSION_TEST = 'bive-acceptance/RULE-002/health-version.acc.ts';
const RUN_TIMEOUT_MS = 300_000;

const MERGED_STEPS = [
  'approval#1:passed',
  'test_writing#1:passed',
  'red_check#1:passed',
  'implementation#1:passed',
  'check#1:passed',
  'mutation#1:skipped',
  'merge#1:passed',
  'screen_update#1:passed',
];

interface Prepared {
  e: PipelineE2e;
  base: string;
  timeRule: Rule;
  versionRule: Rule;
  run1: RunGetResult;
}

/**
 * 요구사항 저장 → 제안 2개 → time · version 순서로 승인(RULE-001 · RULE-002) → 실행 1(RULE-001)을 병합까지.
 * 두 시나리오가 같은 앞부분이다.
 */
const prepare = async (scenario: string): Promise<Prepared> => {
  const e = await startPipeline(scenario);
  const base = mainTip(e);
  const { requirement, proposals } = await saveRequirement(
    e,
    '헬스 체크 응답에 서버 시각과 버전 포함',
    2,
  );
  const byTitle = (title: string) => {
    const found = proposals.find(
      (p) => (p.payload as { title?: unknown } | undefined)?.title === title,
    );
    if (found === undefined) throw new Error(`제안 없음: ${title}`);
    return found;
  };
  const timeRule = await approveRule(e, byTitle(TIME_TITLE));
  const versionRule = await approveRule(e, byTitle(VERSION_TITLE));
  expect([timeRule.displayId, versionRule.displayId]).toEqual(['RULE-001', 'RULE-002']);
  for (const rule of [timeRule, versionRule]) {
    expect(rule).toMatchObject({ parentRequirementId: requirement.id, normState: 'approved' });
  }

  // 실행 1: RULE-001만. 검사 단계는 승인된 규칙 전체 중 인수 테스트 폴더가 있는 RULE-001만 판정한다
  const run1 = await runToEnd(e, [timeRule.id], RUN_TIMEOUT_MS);
  expect(run1.run).toMatchObject({
    status: 'merged',
    failureReason: null,
    regressionCount: 0,
    branch: RUN_BRANCH,
    baseCommit: base,
  });
  expect(attempts(run1)).toEqual(MERGED_STEPS);
  expect(stepOf(run1, 'check').exitDetail).toMatchObject({ ruleIds: ['RULE-001'] });
  const merge1 = String(run1.run.mergeCommit);
  expect(mainTip(e)).toBe(merge1);
  expect(mergeCount(e)).toBe(1);
  expect(git(e.repo, 'show', `${merge1}:${ROUTE}`)).toContain('time: new Date().toISOString()');
  return { e, base, timeRule, versionRule, run1 };
};

const stepOf = (detail: RunGetResult, kind: Step['kind'], attempt = 1): Step => {
  const step = detail.steps.find((s) => s.kind === kind && s.attempt === attempt);
  if (step === undefined) throw new Error(`단계 없음: ${kind}#${String(attempt)}`);
  return step;
};

/** 판정 기록을 `[단계#시도, 규칙 표시 ID, 상태, 커밋]`으로 (기록 순서 그대로). */
const describeJudgments = (
  detail: RunGetResult,
  judgments: readonly JudgmentResult[],
  rules: readonly Rule[],
): string[][] =>
  judgments.map((j) => {
    const step = detail.steps.find((s) => s.id === j.stepId);
    return [
      step === undefined ? String(j.stepId) : `${step.kind}#${String(step.attempt)}`,
      String(rules.find((r) => r.id === j.ruleId)?.displayId),
      j.status,
      j.commit,
    ];
  });

describe('multi-rule: 병합된 규칙이 있는 프로젝트에서 새 규칙 실행', () => {
  it('실행 2의 검사 단계가 RULE-001의 인수 테스트를 실행 2의 커밋에서 다시 돌려 통과하고, 두 규칙 모두 판정 기준 커밋에서 pass', async () => {
    const { e, timeRule, versionRule, run1 } = await prepare('multi-rule');
    const merge1 = String(run1.run.mergeCommit);
    const rules = [timeRule, versionRule];

    const run2 = await runToEnd(e, [versionRule.id], RUN_TIMEOUT_MS);
    expect(run2.run).toMatchObject({
      status: 'merged',
      failureReason: null,
      regressionCount: 0,
      branch: RUN2_BRANCH,
      baseCommit: merge1,
    });
    expect(attempts(run2)).toEqual(MERGED_STEPS);
    const head2 = String(run2.run.headCommit);
    const check2 = stepOf(run2, 'check');
    // 검사 단계의 판정 대상 = 승인된 규칙 전체 (대상 규칙 RULE-002만이 아님)
    expect(check2.exitDetail).toMatchObject({ commit: head2, ruleIds: ['RULE-001', 'RULE-002'] });

    // 판정 기록: 실행 2 · 검사 단계 · 실행 2의 커밋에서 RULE-001 pass (실행 1의 판정을 다시 읽은 것이 아님)
    const { run2Judgments, run1Judgments } = readStore(e, (store) => ({
      run2Judgments: store.judgments.listByRun(run2.run.id),
      run1Judgments: store.judgments.listByRun(run1.run.id),
    }));
    expect(describeJudgments(run2, run2Judgments, rules)).toEqual([
      ['implementation#1', 'RULE-002', 'pass', head2],
      ['check#1', 'RULE-001', 'pass', head2],
      ['check#1', 'RULE-002', 'pass', head2],
    ]);
    const timeCheck = run2Judgments.find((j) => j.ruleId === timeRule.id && j.stepId === check2.id);
    expect(timeCheck).toMatchObject({ runId: run2.run.id, runner: 'vitest', exitCode: 0 });
    expect(run1Judgments.map((j) => j.id)).not.toContain(timeCheck?.id);
    expect(head2).not.toBe(String(run1.run.headCommit));
    // 판정 러너 출력의 케이스가 RULE-001의 인수 테스트 파일에서 나왔다
    expect(timeCheck?.cases.length).toBeGreaterThan(0);
    for (const item of timeCheck?.cases ?? []) {
      expect(item).toMatchObject({ file: TIME_TEST, status: 'passed' });
    }

    // 기준 브랜치: 병합 커밋 2개, 라우트에 두 필드, 인수 테스트 둘 다
    const merge2 = String(run2.run.mergeCommit);
    expect(mainTip(e)).toBe(merge2);
    expect(mergeCount(e)).toBe(2);
    expect(parentsOf(e, merge2)).toEqual([merge1, head2]);
    const route = git(e.repo, 'show', `${merge2}:${ROUTE}`);
    expect(route).toContain('time: new Date().toISOString()');
    expect(route).toContain("version: '0.1.0'");
    const tests = git(e.repo, 'ls-tree', '-r', '--name-only', merge2, 'bive-acceptance');
    expect(tests.split('\n')).toEqual(expect.arrayContaining([TIME_TEST, VERSION_TEST]));

    // 검증 요약: 판정 기준 = 실행 2의 병합 커밋, 준수 2 / 2, 두 규칙 모두 실행 2의 판정으로 pass
    const summary = await e.client.call('verification.summary', { projectId: e.projectId });
    expect(summary.basis).toEqual({ branch: 'main', commit: merge2, runId: run2.run.id });
    expect(summary.compliance).toEqual({ passed: 2, judgeable: 2 });
    expect(summary.denominator).toEqual([timeRule.id, versionRule.id]);
    expect(
      summary.rules.map((row) => [
        row.rule.displayId,
        row.judgment.status,
        row.judgment.latest?.runId,
        row.judgment.latest?.stepId,
        row.judgment.latest?.commit,
        row.run?.displayId,
      ]),
    ).toEqual([
      ['RULE-001', 'pass', run2.run.id, check2.id, head2, 'EXE-002'],
      ['RULE-002', 'pass', run2.run.id, check2.id, head2, 'EXE-002'],
    ]);
  }, 900_000);
});

describe('multi-rule-regress: 두 번째 구현이 첫 규칙을 깨뜨림', () => {
  it('구현 단계는 통과하고 검사 단계가 RULE-001 실패를 잡아 회귀 상한 뒤 failed, 기준 브랜치는 실행 1의 병합 커밋 그대로', async () => {
    const { e, timeRule, versionRule, run1 } = await prepare('multi-rule-regress');
    const merge1 = String(run1.run.mergeCommit);
    const head1 = String(run1.run.headCommit);
    const rules = [timeRule, versionRule];

    const run2 = await runToEnd(e, [versionRule.id], RUN_TIMEOUT_MS);
    expect(run2.run).toMatchObject({
      status: 'failed',
      failureReason: 'regression_limit',
      regressionCount: 2,
      currentStep: 'check',
      mergeCommit: null,
      branch: RUN2_BRANCH,
      baseCommit: merge1,
    });
    // 구현 단계(대상 규칙만 판정)는 매번 통과하고 검사 단계(승인된 규칙 전체)가 매번 실패한다 (목록은 단계 계획 순 · 시도 순)
    expect(attempts(run2)).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'red_check#1:passed',
      'implementation#1:passed',
      'implementation#2:passed',
      'implementation#3:passed',
      'check#1:failed',
      'check#2:failed',
      'check#3:failed',
      'mutation#1:pending',
      'merge#1:pending',
      'screen_update#1:pending',
    ]);
    const checks = [1, 2, 3].map((n) => stepOf(run2, 'check', n));
    const implementations = [1, 2, 3].map((n) => stepOf(run2, 'implementation', n));
    // 검사 실패의 판정 대상 = 승인된 규칙 전체. 마지막 시도는 엔진이 회귀 상한 사유로 감싼다 (ADR-066)
    const checkFailed = { reason: 'check_failed', ruleIds: ['RULE-001', 'RULE-002'] };
    expect(checks[0]?.exitDetail).toMatchObject(checkFailed);
    expect(checks[1]?.exitDetail).toMatchObject(checkFailed);
    expect(checks[2]?.exitDetail).toMatchObject({
      reason: 'regression_limit',
      detail: checkFailed,
    });

    // 판정 기록: 구현 시도마다 RULE-002 pass, 검사 시도마다 RULE-001 fail · RULE-002 pass (그 시도의 구현 커밋에서)
    const run2Judgments = readStore(e, (store) => store.judgments.listByRun(run2.run.id));
    expect(describeJudgments(run2, run2Judgments, rules)).toEqual(
      implementations.flatMap((impl, i) => [
        [`implementation#${String(i + 1)}`, 'RULE-002', 'pass', String(impl.commit)],
        [`check#${String(i + 1)}`, 'RULE-001', 'fail', String(impl.commit)],
        [`check#${String(i + 1)}`, 'RULE-002', 'pass', String(impl.commit)],
      ]),
    );
    // 실패 케이스의 위치는 RULE-001의 인수 테스트
    for (const judgment of run2Judgments.filter((j) => j.ruleId === timeRule.id)) {
      const failed = judgment.cases.filter((item) => item.status === 'failed');
      expect(failed.length).toBeGreaterThan(0);
      for (const item of failed) {
        expect(item.file).toBe(TIME_TEST);
        expect(item.line).toEqual(expect.any(Number));
      }
    }

    // 병합 없음: main 끝 = 실행 1의 병합 커밋, 병합 커밋 1개, main의 라우트에 time이 남고 version은 없음
    expect(mainTip(e)).toBe(merge1);
    expect(mergeCount(e)).toBe(1);
    const mainRoute = git(e.repo, 'show', `refs/heads/main:${ROUTE}`);
    expect(mainRoute).toContain('time: new Date().toISOString()');
    expect(mainRoute).not.toContain('version');
    // 실행 2의 브랜치 · 워크트리 보존 (RUN-08): 브랜치 끝의 라우트는 time을 지운 구현
    expect(branchExists(e, RUN2_BRANCH)).toBe(true);
    const branchRoute = git(e.repo, 'show', `refs/heads/${RUN2_BRANCH}:${ROUTE}`);
    expect(branchRoute).toContain("version: '0.1.0'");
    expect(branchRoute).not.toContain('time');

    // 규칙의 최신 판정(JDG-02)은 실행 2 검사의 fail이지만, 검증 요약은 판정 기준 커밋(실행 1의 병합)의 판정만 쓴다
    const latestTime = await e.client.call('rule.get', { projectId: e.projectId, id: timeRule.id });
    expect(latestTime.judgment.status).toBe('fail');
    expect(latestTime.judgment.latest).toMatchObject({ runId: run2.run.id, stepId: checks[2]?.id });
    const summary = await e.client.call('verification.summary', { projectId: e.projectId });
    expect(summary.basis).toEqual({ branch: 'main', commit: merge1, runId: run1.run.id });
    expect(
      summary.rules.map((row) => [
        row.rule.displayId,
        row.judgment.status,
        row.judgment.latest?.runId ?? null,
        row.judgment.latest?.commit ?? null,
        row.run?.displayId ?? null,
      ]),
    ).toEqual([
      ['RULE-001', 'pass', run1.run.id, head1, 'EXE-001'],
      // RULE-002는 판정 기준 커밋에서 판정되지 않았다 (실행 2의 판정은 병합되지 않은 실행의 것)
      ['RULE-002', 'unjudged', null, null, null],
    ]);
    expect(summary.compliance).toEqual({ passed: 1, judgeable: 2 });
  }, 900_000);
});
