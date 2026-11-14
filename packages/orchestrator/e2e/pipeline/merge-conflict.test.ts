// 파이프라인 e2e: 병합 직전 기준 브랜치 충돌 커밋 (M1-29, architecture.md 8장 "병합 직전 기준 브랜치 충돌 커밋", RUN-08 · ADR-017 · ADR-058).
// 구현 세션이 라우트를 고친 뒤 pause 파일에서 기다리는 동안, 사람이 기준 브랜치 main에 같은 줄을 다르게 고친 커밋을 올린다.
// 대기를 풀면 구현 판정 · 검사는 통과하고, 병합 단계가 기준 브랜치와의 충돌을 찾아 실행은 failed(conflict)여야 한다.
// 실행 브랜치는 검사한 커밋에, 워크트리도 그대로 남고, main은 사람의 커밋에서 움직이지 않는다.
import fs from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  approveRule,
  attempts,
  branchExists,
  cleanupPipeline,
  commitAsUser,
  createRun,
  git,
  human,
  mainTip,
  mergeCount,
  pauseFile,
  readStore,
  ROUTE,
  RUN_BRANCH,
  saveRequirement,
  startPipeline,
  waitForFile,
  waitForRunEnd,
} from './harness.js';

afterEach(cleanupPipeline);

/** 사람이 main에 올리는 변경: 실행이 고치는 `return` 줄을 다르게 고친다 */
const USER_ROUTE = `import { getDb } from '@/lib/db';

// 요청마다 실행한다(빌드 시점 정적 생성 금지).
export const dynamic = 'force-dynamic';

/** 데이터베이스를 한 번 읽어 연결을 확인한 뒤 상태와 서비스 이름을 돌려준다. */
export async function GET(): Promise<Response> {
  await getDb().item.count();
  return Response.json({ ok: true, service: 'sample-next-app' });
}
`;

describe('merge-conflict: 병합 직전 기준 브랜치 충돌 커밋이면 failed, 브랜치 보존', () => {
  it('검사를 통과한 실행도 기준 브랜치와 충돌하면 failed(conflict), 실행 브랜치 · 워크트리 보존, main 그대로', async () => {
    const e = await startPipeline('merge-conflict');
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

    const run = await createRun(e, [rule.id]);
    // 구현 세션이 라우트를 고친 뒤 대기하는 동안 사람이 main에 충돌 커밋을 올린다
    const pause = pauseFile(e);
    await waitForFile(e, pause, 300_000, '구현 세션 대기 파일');
    const paused = await e.client.call('run.get', { projectId: e.projectId, id: run.id });
    expect(paused.run).toMatchObject({ status: 'running', currentStep: 'implementation' });
    const userCommit = commitAsUser(e.repo, ROUTE, USER_ROUTE, 'health: 서비스 이름 포함');
    expect(git(e.repo, 'rev-parse', `${userCommit}^`)).toBe(base);
    fs.rmSync(pause);

    const done = await waitForRunEnd(e, run.id, 300_000);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'conflict',
      currentStep: 'merge',
      lastCompletedStep: 'mutation',
      regressionCount: 0,
      mergeCommit: null,
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
      'merge#1:failed',
      'screen_update#1:pending',
    ]);
    // 병합 단계 기록: 충돌 파일 = 라우트
    const mergeStep = done.steps.find((s) => s.kind === 'merge');
    expect(JSON.stringify(mergeStep?.exitDetail)).toContain(ROUTE);

    // 검사는 실행 브랜치 끝(구현 커밋)을 판정해 통과했다 (병합 재검사 판정은 없다)
    const headCommit = String(done.run.headCommit);
    const judgments = readStore(e, (store) => store.judgments.listByRun(done.run.id));
    expect(judgments.map((j) => [j.ruleId, j.status, j.commit])).toEqual([
      [rule.id, 'pass', headCommit],
      [rule.id, 'pass', headCommit],
    ]);

    // 브랜치 · 워크트리 보존: 실행 브랜치는 검사한 커밋, 워크트리도 그 커밋에 남는다
    expect(branchExists(e, RUN_BRANCH)).toBe(true);
    expect(git(e.repo, 'rev-parse', `refs/heads/${RUN_BRANCH}`)).toBe(headCommit);
    expect(git(e.repo, 'show', `${headCommit}:${ROUTE}`)).toContain(
      'time: new Date().toISOString()',
    );
    const worktree = String(done.run.worktreePath);
    expect(fs.existsSync(worktree)).toBe(true);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(headCommit);
    // 병합 없음: main은 사람의 커밋 그대로, merge commit 0개, 프로젝트 폴더의 추적 파일도 그대로다
    // (`.bive.json`은 프로젝트 표시 파일로 추적하지 않는다)
    expect(mainTip(e)).toBe(userCommit);
    expect(mergeCount(e)).toBe(0);
    expect(git(e.repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  }, 600_000);
});
