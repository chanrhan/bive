// 파이프라인 e2e: 예산 초과 (M1-21, architecture.md 8장 "예산 초과 subtype", COST-01 · RUN-08).
// 테스트 작성 · Red 확인(실제 판정 러너)은 정상으로 끝나고, 구현 세션이 결과 subtype error_max_budget_usd로 끝난다.
// 실행은 budget_exceeded, 브랜치 · 워크트리 보존, 구현 판정 · 병합 없음이어야 한다. 구현 세션은 다시 열리지 않는다.
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
  RUN_BRANCH,
  runToEnd,
  saveRequirement,
  startPipeline,
} from './harness.js';

afterEach(cleanupPipeline);

describe('budget-exceeded: budget_exceeded, 브랜치 보존, 병합 없음', () => {
  it('구현 세션의 error_max_budget_usd는 budget_exceeded로 끝나고 브랜치 · 워크트리를 남기며 병합하지 않는다', async () => {
    const e = await startPipeline('budget-exceeded');
    const base = mainTip(e);

    const { proposals } = await saveRequirement(e, '헬스 체크 응답에 호스트 이름 포함', 1);
    const [proposal] = proposals;
    if (proposal === undefined) throw new Error('제안 없음');
    const rule = await approveRule(e, proposal);

    const done = await runToEnd(e, [rule.id], 300_000);
    expect(done.run).toMatchObject({
      status: 'budget_exceeded',
      failureReason: 'error_max_budget_usd',
      currentStep: 'implementation',
      lastCompletedStep: 'red_check',
      regressionCount: 0,
      mergeCommit: null,
      branch: RUN_BRANCH,
    });
    expect(attempts(done)).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'red_check#1:passed',
      'implementation#1:failed',
      'check#1:pending',
      'mutation#1:pending',
      'merge#1:pending',
      'screen_update#1:pending',
    ]);

    // 구현 세션 1개(재시도 없음), 그 결과가 예산 초과. 구현 판정 · 규칙 판정 기록 없음
    const { sessions, judgments } = readStore(e, (store) => ({
      sessions: store.sessions.listByRun(done.run.id),
      judgments: store.judgments.listByRun(done.run.id),
    }));
    expect(sessions.map((s) => [s.role, s.endReason])).toEqual([
      ['test-writer', 'success'],
      ['implementer', 'error_max_budget_usd'],
    ]);
    expect(judgments).toEqual([]);
    expect(done.usage.run.costUsd).not.toBeNull();

    // 브랜치 · 워크트리 보존: 브랜치는 Red 확인을 넘긴 테스트 작성 커밋에서 멈추고 워크트리는 남는다
    expect(branchExists(e, RUN_BRANCH)).toBe(true);
    expect(git(e.repo, 'rev-parse', `refs/heads/${RUN_BRANCH}`)).toBe(done.run.headCommit);
    const worktree = String(done.run.worktreePath);
    expect(fs.existsSync(worktree)).toBe(true);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(done.run.headCommit);
    // 병합 없음: main 그대로, merge commit 0개, 인수 테스트도 main에 없다
    expect(mainTip(e)).toBe(base);
    expect(mergeCount(e)).toBe(0);
    expect(git(e.repo, 'ls-tree', '-r', '--name-only', 'refs/heads/main', 'bive-acceptance')).toBe(
      '',
    );
  }, 600_000);
});
