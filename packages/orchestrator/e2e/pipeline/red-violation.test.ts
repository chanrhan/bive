// 파이프라인 e2e: Red 위반 (M1-21, architecture.md 8장 "Red 위반 (구현 전 통과 테스트)", RUN-03).
// 테스트 작성이 매번 이미 있는 동작만 확인하는 인수 테스트를 써서, 실제 판정 러너로 구현 전에도 통과한다.
// Red 확인을 넘지 못해 테스트 작성 단계가 끝나지 않고(재시도 2회, 테스트 작성 3회) failed여야 한다. 구현 세션은 열리지 않는다.
// "테스트 작성 단계 미종료"의 해석: Red 확인 미통과로 테스트 작성이 다음 단계(구현)로 넘어가지 못함 (테스트 작성 시도 자체는 passed).
import fs from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  approveRule,
  attempts,
  branchExists,
  cleanupPipeline,
  mainTip,
  mergeCount,
  readStore,
  RUN_BRANCH,
  runToEnd,
  saveRequirement,
  startPipeline,
} from './harness.js';

afterEach(cleanupPipeline);

describe('red-violation: 테스트 작성 미종료 뒤 failed', () => {
  it('Red 확인이 세 번 모두 구현 전 통과면 failed(test_retry_limit), 구현 세션 없음, 병합 없음', async () => {
    const e = await startPipeline('red-violation');
    const base = mainTip(e);

    const { proposals } = await saveRequirement(e, '헬스 체크 응답에 서버 시각 포함', 1);
    const [proposal] = proposals;
    if (proposal === undefined) throw new Error('제안 없음');
    const rule = await approveRule(e, proposal);

    const done = await runToEnd(e, [rule.id], 480_000);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'test_retry_limit',
      currentStep: 'red_check',
      lastCompletedStep: 'test_writing',
      mergeCommit: null,
      branch: RUN_BRANCH,
    });
    expect(attempts(done)).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'test_writing#2:passed',
      'test_writing#3:passed',
      'red_check#1:failed',
      'red_check#2:failed',
      'red_check#3:failed',
      'implementation#1:pending',
      'check#1:pending',
      'mutation#1:pending',
      'merge#1:pending',
      'screen_update#1:pending',
    ]);
    // 실제 판정 러너가 케이스를 실행했고 통과해서(구현 전 통과) Red가 아니다
    for (const step of done.steps.filter((s) => s.kind === 'red_check')) {
      const detail = step.exitDetail as Record<string, unknown>;
      const cause = (detail.reason === 'test_retry_limit' ? detail.detail : detail) as Record<
        string,
        unknown
      >;
      expect(cause).toMatchObject({
        reason: 'not_red',
        judgeStatus: 'completed',
        notFailedCases: [expect.objectContaining({ status: 'passed' })],
      });
    }

    // 구현 세션 없음 · 판정 기록 없음 (Red 확인은 규칙 판정 기록을 남기지 않는다)
    const { sessions, judgments } = readStore(e, (store) => ({
      sessions: store.sessions.listByRun(done.run.id),
      judgments: store.judgments.listByRun(done.run.id),
    }));
    expect(sessions.map((s) => s.role)).toEqual(['test-writer', 'test-writer', 'test-writer']);
    expect(judgments).toEqual([]);

    // 브랜치 · 워크트리 보존, 병합 없음
    expect(branchExists(e, RUN_BRANCH)).toBe(true);
    expect(fs.existsSync(String(done.run.worktreePath))).toBe(true);
    expect(mainTip(e)).toBe(base);
    expect(mergeCount(e)).toBe(0);
  }, 600_000);
});
