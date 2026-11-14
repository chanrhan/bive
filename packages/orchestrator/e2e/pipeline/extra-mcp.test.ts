// 파이프라인 e2e: 추가 MCP 서버 존재 (M1-29, architecture.md 8장 "추가 MCP 서버 존재", NFR-02 · ADR-024).
// 실행의 첫 세션(테스트 작성)의 init이 고정 도구 서버 bive 밖의 MCP 서버를 함께 보고한다. 세션 가드가 도구를 하나도 부르기
// 전에 세션을 멈추고, 실행은 failed(guard_violation)로 끝나야 한다. 인수 테스트 · 구현 세션 · 판정 · 병합은 없다.
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
  RUN_BRANCH,
  runToEnd,
  saveRequirement,
  startPipeline,
} from './harness.js';

afterEach(cleanupPipeline);

describe('extra-mcp: 허용 밖 MCP 서버가 보고된 세션은 실행 실패', () => {
  it('테스트 작성 세션 init에 bive 밖 MCP 서버가 있으면 도구 호출 0건으로 멈추고 failed(guard_violation)', async () => {
    const e = await startPipeline('extra-mcp');
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

    const done = await runToEnd(e, [rule.id], 180_000);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'guard_violation',
      currentStep: 'test_writing',
      mergeCommit: null,
      branch: RUN_BRANCH,
    });
    expect(attempts(done)).toEqual([
      'approval#1:passed',
      'test_writing#1:failed',
      'red_check#1:pending',
      'implementation#1:pending',
      'check#1:pending',
      'mutation#1:pending',
      'merge#1:pending',
      'screen_update#1:pending',
    ]);

    // 세션 1개(테스트 작성)가 가드 위반으로 끝났고 보고된 MCP 서버가 기록됐다. 도구 호출 · 판정은 없다
    const { sessions, calls, judgments } = readStore(e, (store) => ({
      sessions: store.sessions.listByRun(done.run.id),
      calls: store.sessions.toolCalls(done.run.id),
      judgments: store.judgments.listByRun(done.run.id),
    }));
    expect(sessions.map((s) => [s.role, s.endReason])).toEqual([
      ['test-writer', 'guard_violation'],
    ]);
    expect(sessions[0]?.mcpServers).toEqual(['bive', 'user-filesystem']);
    expect(calls).toEqual([]);
    expect(judgments).toEqual([]);

    // 병합 없음: main 그대로, 실행 브랜치는 기준 커밋에 보존, 인수 테스트 없음
    expect(mainTip(e)).toBe(base);
    expect(mergeCount(e)).toBe(0);
    expect(branchExists(e, RUN_BRANCH)).toBe(true);
    expect(git(e.repo, 'rev-parse', `refs/heads/${RUN_BRANCH}`)).toBe(base);
    expect(git(e.repo, 'ls-tree', '-r', '--name-only', RUN_BRANCH, 'bive-acceptance')).toBe('');
  }, 600_000);
});
