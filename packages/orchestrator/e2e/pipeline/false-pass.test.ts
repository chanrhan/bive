// 파이프라인 e2e: 에이전트의 "통과" 텍스트 보고 + 실제 테스트 실패 (M1-29, architecture.md 8장 "false-pass", JDG-01 · ADR-069).
// 구현 세션은 매번 서버 시각을 ISO 문자열이 아닌 숫자로 넣고 "인수 테스트를 모두 통과했다"고 보고하며 성공 결과로 끝난다.
// 판정은 세션 보고가 아니라 실제 판정 러너의 실행 결과로만 정하므로 판정 fail, 구현 3회(회귀 2회) 뒤 failed(regression_limit),
// 병합 없음이어야 한다.
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
  readStore,
  ROUTE,
  RUN_BRANCH,
  runToEnd,
  saveRequirement,
  startPipeline,
} from './harness.js';

afterEach(cleanupPipeline);

describe('false-pass: 세션의 통과 보고와 무관하게 판정 fail', () => {
  it('구현 세션이 성공 결과로 통과를 보고해도 실제 판정은 fail, failed(regression_limit), 병합 없음', async () => {
    const e = await startPipeline('false-pass');
    const base = mainTip(e);

    const { proposals } = await saveRequirement(e, '헬스 체크 응답에 서버 시각 포함', 2);
    const [first, second] = proposals;
    if (first === undefined || second === undefined) throw new Error('제안 2개 아님');
    const rule = await approveRule(e, first);
    await e.client.call('proposal.reject', {
      projectId: e.projectId,
      id: second.id,
      author: human,
      reason: '중복',
    });

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

    // 구현 세션 3개는 모두 성공 결과(= 통과 보고)로 끝났지만, 시도마다 실제 판정 러너의 대상 규칙 판정은 fail
    const implementationSteps = done.steps.filter((s) => s.kind === 'implementation');
    const { sessions, judgments } = readStore(e, (store) => ({
      sessions: store.sessions.listByRun(done.run.id),
      judgments: store.judgments.listByRun(done.run.id),
    }));
    expect(sessions.filter((s) => s.role === 'implementer').map((s) => s.endReason)).toEqual([
      'success',
      'success',
      'success',
    ]);
    expect(judgments.map((j) => [j.ruleId, j.stepId, j.status, j.runner])).toEqual(
      implementationSteps.map((step) => [rule.id, step.id, 'fail', 'vitest']),
    );
    // 실패 원인은 실행기 출력의 실패 케이스(서버 시각 형식)다
    for (const judgment of judgments) {
      expect(judgment.cases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'failed',
            name: expect.stringContaining('ISO 8601 UTC') as unknown,
          }),
        ]),
      );
    }
    const { judgment } = await e.client.call('rule.get', { projectId: e.projectId, id: rule.id });
    expect(judgment.status).toBe('fail');

    // 판정한 커밋에는 실제로 숫자 시각이 들어 있다 (통과 보고와 다른 코드)
    expect(git(e.repo, 'show', `${String(judgments.at(-1)?.commit)}:${ROUTE}`)).toContain(
      'time: Date.now()',
    );
    // 병합 없음: main 그대로, merge commit 0개, 실행 브랜치 보존
    expect(mainTip(e)).toBe(base);
    expect(mergeCount(e)).toBe(0);
    expect(branchExists(e, RUN_BRANCH)).toBe(true);
  }, 600_000);
});
