// 파이프라인 e2e: 프로젝트당 동시 실행 1개 · 실행 대기 (M7-06 #218, RUN-01 · RUN-08, ADR-100 B⑥ · A13, ADR-105).
// 시나리오 pause-implement: 실행마다 첫 구현 세션이 $BIVE_HOME/run/pause가 지워질 때까지 기다린다.
// 1. 요구사항 → 규칙 2개 바로 반영 → 사람의 [실행](RULE-001) → 첫 구현 세션 대기(진행 중)
// 2. 그동안 사람의 [실행](RULE-002)으로 만든 두 번째 실행은 승인 단계만 통과하고 실행 대기에 머문다(세션 · 워크트리 ·
//    브랜치 · 기준 커밋 없음). 실제 오케스트레이터 프로세스에서 시간이 지나도 그대로다
// 3. 대기 파일을 지우면 첫 실행이 병합되고, 두 번째 실행이 그 병합 커밋 위에서 이어진다(실제 git · 실제 판정).
//    두 번째 실행의 인수 테스트는 첫 실행이 이미 넣은 동작(서버 시각)을 확인하므로 Red 확인을 넘지 못해 실패로 끝난다
//    (red-violation과 같은 결과): 이 시험이 보는 것은 "대기였다가 앞 실행의 병합 위에서 이어짐"이다
// 시험 내내 run.list(running)를 폴링해 진행 중이 2건이 된 적이 없는지 본다.
import fs from 'node:fs';

import type { RunGetResult } from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attempts,
  cleanupPipeline,
  createRun,
  mainTip,
  mergeCount,
  pauseFile,
  type PipelineE2e,
  readStore,
  RUN_BRANCH,
  saveRequirement,
  startPipeline,
  waitForFile,
  waitForRunEnd,
} from './harness.js';

afterEach(cleanupPipeline);

const RUN2_BRANCH = 'bive/run-EXE-002';
const RUN_TIMEOUT_MS = 480_000;

/** 진행 중 실행 수를 계속 세어 최댓값을 남긴다 (오케스트레이터가 바뀌어도 같은 클라이언트로). */
const watchRunning = (e: PipelineE2e): { stop: () => Promise<number> } => {
  let max = 0;
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const { runs } = await e.client
        .call('run.list', { projectId: e.projectId, status: 'running' })
        .catch(() => ({ runs: [] }));
      max = Math.max(max, runs.length);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await loop;
      return max;
    },
  };
};

const get = (e: PipelineE2e, id: string): Promise<RunGetResult> =>
  e.client.call('run.get', { projectId: e.projectId, id });

describe('run-queue: 진행 중인 실행이 있으면 사람의 [실행]도 실행 대기, 앞 실행이 끝나면 이어짐', () => {
  it('pause-implement: 첫 실행 구현 대기 중 만든 두 번째 실행은 실행 대기 → 첫 실행 병합 → 두 번째 실행이 그 병합 위에서 시작', async () => {
    const e = await startPipeline('pause-implement');
    const base = mainTip(e);
    const watch = watchRunning(e);
    let maxRunning: number;
    try {
      const { rules } = await saveRequirement(e, '헬스 체크 응답에 서버 시각 포함', 2);
      const [rule1, rule2] = rules;
      if (rule1 === undefined || rule2 === undefined) throw new Error('규칙 없음');

      // 1. 첫 실행 → 첫 구현 세션 대기
      const run1 = await createRun(e, [rule1.id]);
      const pause = pauseFile(e);
      await waitForFile(e, pause, 300_000, '구현 세션 대기 파일');
      expect((await get(e, run1.id)).run).toMatchObject({
        status: 'running',
        currentStep: 'implementation',
      });

      // 2. 사람의 [실행]으로 두 번째 실행: 승인 단계만 통과하고 실행 대기
      const run2 = await createRun(e, [rule2.id]);
      expect(run2.displayId).toBe('EXE-002');
      const deadline = Date.now() + 30_000;
      while ((await get(e, run2.id)).run.status !== 'queued') {
        if (Date.now() > deadline) throw new Error('실행 대기로 저장되지 않음');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      // 앞 실행이 대기 파일에서 멈춘 동안 시간이 지나도 시작하지 않는다
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const queued = await get(e, run2.id);
      expect(queued.run).toMatchObject({
        status: 'queued',
        currentStep: 'test_writing',
        lastCompletedStep: 'approval',
        branch: null,
        worktreePath: null,
        baseCommit: null,
        startedAt: null,
      });
      expect(attempts(queued)).toEqual([
        'approval#1:passed',
        'test_writing#1:pending',
        'red_check#1:pending',
        'implementation#1:pending',
        'check#1:pending',
        'mutation#1:pending',
        'merge#1:pending',
        'screen_update#1:pending',
      ]);
      expect(
        (await e.client.call('run.list', { projectId: e.projectId, status: 'running' })).runs.map(
          (run) => run.displayId,
        ),
      ).toEqual(['EXE-001']);
      expect(
        (await e.client.call('run.list', { projectId: e.projectId, status: 'queued' })).runs.map(
          (run) => run.displayId,
        ),
      ).toEqual(['EXE-002']);
      // 사람의 실행 시작 확인은 생성 때 남았고, 세션은 아직 없다
      const queuedRecords = readStore(e, (store) => ({
        runStarts: store.approvalLog
          .list({ entity: 'Run', id: run2.id })
          .filter((entry) => entry.action === 'run_start').length,
        sessions: store.sessions.listByRun(run2.id).length,
      }));
      expect(queuedRecords).toEqual({ runStarts: 1, sessions: 0 });

      // 3. 대기 파일을 지우면 첫 실행이 병합되고, 두 번째 실행이 그 병합 커밋 위에서 이어진다
      fs.rmSync(pause);
      const done1 = await waitForRunEnd(e, run1.id, RUN_TIMEOUT_MS);
      expect(done1.run).toMatchObject({ status: 'merged', branch: RUN_BRANCH, baseCommit: base });
      const done2 = await waitForRunEnd(e, run2.id, RUN_TIMEOUT_MS);
      expect(done2.run).toMatchObject({
        status: 'failed',
        failureReason: 'test_retry_limit',
        branch: RUN2_BRANCH,
        // 기준 커밋은 시작 때: 생성 때의 기준 브랜치 끝(base)이 아니라 첫 실행의 병합 커밋
        baseCommit: done1.run.mergeCommit,
        mergeCommit: null,
      });
      expect(Date.parse(String(done2.run.startedAt))).toBeGreaterThanOrEqual(
        Date.parse(String(done1.run.endedAt)),
      );
      expect(attempts(done2, 'approval', 'test_writing', 'red_check')).toEqual([
        'approval#1:passed',
        'test_writing#1:passed',
        'test_writing#2:passed',
        'test_writing#3:passed',
        'red_check#1:failed',
        'red_check#2:failed',
        'red_check#3:failed',
      ]);
      // 두 번째 실행의 세션은 모두 첫 실행이 끝난 뒤에 열렸다
      const sessions = readStore(e, (store) => store.sessions.listByRun(run2.id));
      expect(sessions.length).toBeGreaterThan(0);
      for (const session of sessions) {
        expect(Date.parse(session.startedAt)).toBeGreaterThanOrEqual(
          Date.parse(String(done1.run.endedAt)),
        );
      }
      // 기준 브랜치는 첫 실행의 병합 커밋 그대로
      expect(mainTip(e)).toBe(done1.run.mergeCommit);
      expect(mergeCount(e)).toBe(1);
    } finally {
      // 실패로 끝나도 폴링은 멈춘다
      maxRunning = await watch.stop();
    }
    // 시험 내내 진행 중은 1건을 넘은 적이 없다
    expect(maxRunning).toBe(1);
  }, 900_000);
});
