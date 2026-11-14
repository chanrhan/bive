// 파이프라인 e2e: 실행 중 오케스트레이터 강제 종료 → 재기동 → 재개 (M1-29, architecture.md 8장, PRD 5.1 · NFR-06,
// roadmap M1 완료 기준 흐름 10, ADR-049 · ADR-066).
// 시나리오 pause-implement: 실행의 첫 구현 세션이 $BIVE_HOME/run/pause에서 기다리는 동안 오케스트레이터를 SIGKILL한다
// (정상 종료 처리 없이). 같은 BIVE_HOME으로 다시 띄우면 실행은 자동 진행 없이 `interrupted`이고, `run.resume`(사람) 뒤
// 새 구현 세션(대기 없음, 세션 순번이 저장된 세션 수로 이어짐)으로 끝까지 가서 `merged`여야 한다. 대기 파일은 지우지 않는다:
// 재개가 첫 구현 세션 대본을 다시 쓰면 대기에서 멈춰 시간 초과로 실패한다.
// 죽이는 대상은 이 시험이 띄운 자식 핸들뿐이고, 강제 종료 뒤 이 시험의 BIVE_HOME 안에 남은 프로세스가 없음을 확인한다.
import fs from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { isProcessAlive, readPidFile } from '../../src/lock.js';
import { runPaths } from '../../src/run-paths.js';
import { leftoverProcesses, waitFor } from '../../test/helpers/process.js';
import {
  approveRule,
  attempts,
  cleanupPipeline,
  createRun,
  git,
  human,
  killOrchestrator,
  mainTip,
  mergeCount,
  parentsOf,
  pauseFile,
  readStore,
  restartOrchestrator,
  RUN_BRANCH,
  saveRequirement,
  startPipeline,
  waitForFile,
  waitForRunEnd,
} from './harness.js';

afterEach(cleanupPipeline);

describe('interrupt-resume: 강제 종료 뒤 재기동하면 interrupted, 재개하면 merged', () => {
  it('구현 단계 대기 중 SIGKILL → 재기동 뒤 interrupted(자동 진행 없음) → run.resume → merged', async () => {
    const e = await startPipeline('pause-implement');
    const base = mainTip(e);
    const pidFile = runPaths(e.biveHome).pid;

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

    // 1. 실행 → 테스트 작성 → Red 확인(실제 판정) → 첫 구현 세션 대기
    const run = await createRun(e, [rule.id]);
    const pause = pauseFile(e);
    await waitForFile(e, pause, 300_000, '구현 세션 대기 파일');
    const paused = await e.client.call('run.get', { projectId: e.projectId, id: run.id });
    expect(paused.run).toMatchObject({ status: 'running', currentStep: 'implementation' });
    expect(attempts(paused, 'implementation')).toEqual(['implementation#1:running']);

    // 2. 오케스트레이터 강제 종료 (이 시험이 띄운 자식 핸들에 SIGKILL, 정상 종료 처리 없음)
    const killedPid = e.orchestrator.child.pid;
    expect(readPidFile(pidFile)).toBe(killedPid);
    await killOrchestrator(e);
    expect(killedPid !== undefined && isProcessAlive(killedPid)).toBe(false);
    // 강제 종료 뒤 이 시험의 BIVE_HOME 안에 남은 프로세스가 없다 (구현 대기 중에는 판정 하위 프로세스가 없다)
    await waitFor(() => leftoverProcesses(e.biveHome).length === 0, 10_000, '남은 프로세스 없음');
    expect(fs.existsSync(pause)).toBe(true);

    // 3. 같은 BIVE_HOME으로 재기동: 실행은 interrupted, 중단된 구현 시도는 failed, 같은 단계의 새 시도가 대기
    await restartOrchestrator(e);
    expect(e.orchestrator.child.pid).not.toBe(killedPid);
    expect(readPidFile(pidFile)).toBe(e.orchestrator.child.pid);
    const interrupted = await e.client.call('run.get', { projectId: e.projectId, id: run.id });
    expect(interrupted.run).toMatchObject({
      status: 'interrupted',
      currentStep: 'implementation',
      lastCompletedStep: 'red_check',
      regressionCount: 0,
      mergeCommit: null,
    });
    expect(attempts(interrupted)).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'red_check#1:passed',
      'implementation#1:failed',
      'implementation#2:pending',
      'check#1:pending',
      'mutation#1:pending',
      'merge#1:pending',
      'screen_update#1:pending',
    ]);
    const stopped = interrupted.steps.find((s) => s.kind === 'implementation' && s.attempt === 1);
    expect(stopped?.exitDetail).toMatchObject({
      interrupted: true,
      reason: 'orchestrator_restart',
    });
    // 자동 재개 없음: 잠시 기다려도 그대로다
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await expect(
      e.client.call('run.get', { projectId: e.projectId, id: run.id }),
    ).resolves.toMatchObject({ run: { status: 'interrupted' } });
    expect(mergeCount(e)).toBe(0);

    // 4. 재개(사람) → 새 구현 세션(대기 없음) → 검사 → 병합
    const resumed = await e.client.call('run.resume', {
      projectId: e.projectId,
      id: run.id,
      author: human,
    });
    expect(resumed.run.status).toBe('running');
    const done = await waitForRunEnd(e, run.id, 300_000);
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
      'implementation#1:failed',
      'implementation#2:passed',
      'check#1:passed',
      'mutation#1:skipped',
      'merge#1:passed',
      'screen_update#1:passed',
    ]);
    // 구현 세션 2개: 강제 종료로 끝나지 않은 첫 세션은 재기동 때 aborted로 닫히고, 재개 뒤 새 세션이 성공했다
    const sessions = readStore(e, (store) => store.sessions.listByRun(done.run.id));
    expect(sessions.map((s) => [s.role, s.endReason])).toEqual([
      ['test-writer', 'success'],
      ['implementer', 'aborted'],
      ['implementer', 'success'],
    ]);
    // main에 merge commit 1개 (부모 = 시작 기준 커밋 · 재개 뒤 구현 커밋)
    const merge = String(done.run.mergeCommit);
    expect(mainTip(e)).toBe(merge);
    expect(mergeCount(e)).toBe(1);
    expect(parentsOf(e, merge)).toEqual([base, String(done.run.headCommit)]);
    expect(git(e.repo, 'show', `${merge}:src/app/api/health/route.ts`)).toContain(
      'time: new Date().toISOString()',
    );
  }, 600_000);
});
