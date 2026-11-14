// 파이프라인 e2e: 구현 실패 3회 (M1-21, architecture.md 8장 "구현 실패 3회", RUN-02 · RUN-08, roadmap M1 완료 기준 흐름 8).
// 구현 세션이 매번 형식이 틀린 version을 넣어 실제 판정 러너의 대상 규칙 판정이 끝내 실패한다.
// 구현 3회(회귀 2회) 뒤 failed(regression_limit), 실행 브랜치 · 워크트리 보존, main 그대로여야 한다.
import fs from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  approveRule,
  attempts,
  branchExists,
  cleanupPipeline,
  git,
  mainTip,
  mergeCount,
  readStore,
  ROUTE,
  RUN_BRANCH,
  runToEnd,
  saveRequirement,
  startPipeline,
} from './harness.js';

afterEach(cleanupPipeline);

describe('fail-check: 구현 3회(회귀 2회) 뒤 failed', () => {
  it('구현 판정이 세 번 모두 fail이면 failed(regression_limit), 브랜치 · 워크트리 보존, 병합 없음', async () => {
    const e = await startPipeline('fail-check');
    const base = mainTip(e);

    const { proposals } = await saveRequirement(e, '헬스 체크 응답에 버전 포함', 1);
    const [proposal] = proposals;
    if (proposal === undefined) throw new Error('제안 없음');
    const rule = await approveRule(e, proposal);

    const done = await runToEnd(e, [rule.id], 480_000);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'regression_limit',
      regressionCount: 2,
      currentStep: 'implementation',
      mergeCommit: null,
      branch: RUN_BRANCH,
    });
    expect(attempts(done)).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'red_check#1:passed',
      'implementation#1:failed',
      'implementation#2:failed',
      'implementation#3:failed',
      'check#1:pending',
      'mutation#1:pending',
      'merge#1:pending',
      'screen_update#1:pending',
    ]);

    // 구현 세션 3개, 시도마다 실제 판정 러너의 대상 규칙 판정 fail
    const implementationSteps = done.steps.filter((s) => s.kind === 'implementation');
    const { sessions, judgments } = readStore(e, (store) => ({
      sessions: store.sessions.listByRun(done.run.id),
      judgments: store.judgments.listByRun(done.run.id),
    }));
    expect(sessions.filter((s) => s.role === 'implementer')).toHaveLength(3);
    expect(judgments.map((j) => [j.ruleId, j.stepId, j.status, j.runner])).toEqual(
      implementationSteps.map((step) => [rule.id, step.id, 'fail', 'vitest']),
    );
    const { judgment } = await e.client.call('rule.get', { projectId: e.projectId, id: rule.id });
    expect(judgment.status).toBe('fail');

    // 브랜치 · 워크트리 보존: 실행 브랜치는 마지막(3회차) 구현 시도의 커밋을 담은 채 남고, 워크트리도 남는다
    expect(branchExists(e, RUN_BRANCH)).toBe(true);
    const branchTip = git(e.repo, 'rev-parse', `refs/heads/${RUN_BRANCH}`);
    // 3회차 판정은 그 시도의 커밋에서 했다 (미충족 시도는 단계 커밋으로 남기지 않고 판정 기록이 가리킨다, ADR-069)
    expect(judgments.at(-1)?.commit).toBe(branchTip);
    expect(git(e.repo, 'rev-parse', `${branchTip}^`)).toBe(done.run.headCommit);
    expect(git(e.repo, 'show', `${branchTip}:${ROUTE}`)).toContain("appVersion: '0.1.0'");
    expect(fs.existsSync(String(done.run.worktreePath))).toBe(true);
    // 병합 없음: main 그대로, merge commit 0개, main의 라우트에 version 없음
    expect(mainTip(e)).toBe(base);
    expect(mergeCount(e)).toBe(0);
    expect(git(e.repo, 'show', `refs/heads/main:${ROUTE}`)).not.toContain('version');
  }, 600_000);
});
