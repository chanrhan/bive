// 파이프라인 e2e: 정상 완주 (M1-21, architecture.md 8장 "정상 완주", RUN-02 · RUN-08, roadmap M1 완료 기준 흐름 3~7).
// 요구사항 저장 → rule-writer 제안 2개 → 첫째 승인 · 둘째 거절 → 실행 → 테스트 작성 → Red 확인 → 구현 → 검사 → 병합.
// 판정은 실제 판정 러너(커밋의 깨끗한 체크아웃 · 설치 · next build · next start · vitest)로만 정한다.
import { afterEach, describe, expect, it } from 'vitest';

import {
  approveRule,
  attempts,
  branchExists,
  cleanupPipeline,
  git,
  human,
  mainTip,
  mergeCount,
  parentsOf,
  readStore,
  ROUTE,
  RUN_BRANCH,
  runToEnd,
  saveRequirement,
  startPipeline,
} from './harness.js';

afterEach(cleanupPipeline);

describe('happy-path: 요구사항 저장부터 merged까지', () => {
  it('판정 pass, main에 merge commit 1개, 병합 커밋에 구현과 인수 테스트가 들어 있다', async () => {
    const e = await startPipeline('happy-path');
    const base = mainTip(e);

    const { requirement, proposals } = await saveRequirement(
      e,
      '헬스 체크 응답에 서버 시각 포함',
      2,
    );
    const [first, second] = proposals;
    if (first === undefined || second === undefined) throw new Error('제안 2개 아님');
    const rule = await approveRule(e, first);
    expect(rule).toMatchObject({ parentRequirementId: requirement.id, normState: 'approved' });
    await e.client.call('proposal.reject', {
      projectId: e.projectId,
      id: second.id,
      author: human,
      reason: '중복',
    });

    const done = await runToEnd(e, [rule.id], 300_000);
    expect(done.run).toMatchObject({
      status: 'merged',
      failureReason: null,
      regressionCount: 0,
      branch: RUN_BRANCH,
      baseCommit: base,
    });
    expect(attempts(done)).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'red_check#1:passed',
      'implementation#1:passed',
      'check#1:passed',
      'mutation#1:skipped',
      'merge#1:passed',
      'screen_update#1:passed',
    ]);

    // 판정 pass: 구현 판정 · 검사 판정 모두 대상 규칙 pass, 최신 판정은 검사한 커밋
    const headCommit = String(done.run.headCommit);
    const judgments = readStore(e, (store) => store.judgments.listByRun(done.run.id));
    expect(judgments.map((j) => [j.ruleId, j.status])).toEqual([
      [rule.id, 'pass'],
      [rule.id, 'pass'],
    ]);
    const { judgment } = await e.client.call('rule.get', { projectId: e.projectId, id: rule.id });
    expect(judgment.status).toBe('pass');
    expect(judgment.latest).toMatchObject({ commit: headCommit, runner: 'vitest', exitCode: 0 });

    // main에 merge commit: 부모 = 시작 기준 커밋 · 실행 브랜치 끝, 내용 = 구현 + 인수 테스트
    const merge = String(done.run.mergeCommit);
    expect(mainTip(e)).toBe(merge);
    expect(mergeCount(e)).toBe(1);
    expect(parentsOf(e, merge)).toEqual([base, headCommit]);
    expect(git(e.repo, 'show', `${merge}:${ROUTE}`)).toContain('time: new Date().toISOString()');
    const ruleCode = String(rule.displayId);
    expect(git(e.repo, 'ls-tree', '-r', '--name-only', merge, 'bive-acceptance')).toContain(
      `bive-acceptance/${ruleCode}/health-time.acc.ts`,
    );
    // 실행 브랜치는 병합 뒤에도 남는다 (ADR-058)
    expect(branchExists(e, RUN_BRANCH)).toBe(true);
  }, 600_000);
});
