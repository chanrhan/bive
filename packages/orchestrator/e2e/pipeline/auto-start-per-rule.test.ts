// 파이프라인 e2e: 규칙마다 실행 1개 자동 시작 (M7-19 #244 수용 기준 4, RUN-01 · RUN-03 · RUN-05, ADR-100 B⑥, ADR-105 · ADR-110 ·
// ADR-111).
// 요구사항 저장 → rule-writer가 규칙 2개를 바로 반영(시나리오 `happy-path`: 둘째 규칙 "응답 형식 유지"는 이미 통과하는 동작) →
// 세션이 끝나면 오케스트레이터가 규칙마다 실행 1개씩 2개를 자동 시작 → 첫 실행은 진행 중, 둘째는 실행 대기 → 첫 실행 병합 →
// 둘째 실행이 그 병합 위에서 시작한다. 둘째의 테스트 작성 세션은 그 실행의 대상 규칙(`{{ruleId}}`) 폴더에 쓰고, 이미 통과하는
// 동작이라 Red 확인이 `not_red`로 테스트 작성에 돌려보내 재시도 상한 뒤 `test_retry_limit`으로 끝난다(Red 확인은 그대로,
// 통과하는 테스트를 대상에서 빼지 않는다, ADR-110). 실행 내내 실행 목록을 폴링해 두 실행이 함께 `running`인 조회가 없음을 본다.
// 사람의 조작은 설정 저장과 요구사항 저장뿐이다. 판정은 실제 판정 러너로만 정한다.
import { afterEach, describe, expect, it } from 'vitest';

import {
  attempts,
  cleanupPipeline,
  human,
  mainTip,
  mergeCount,
  saveRequirement,
  startPipeline,
  waitForRunEnd,
} from './harness.js';

afterEach(cleanupPipeline);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('auto-start-per-rule: 규칙 2개 → 실행 2개, 진행 중은 늘 1개', () => {
  it('첫 규칙의 실행은 merged, 이미 통과하는 둘째 규칙의 실행은 Red 확인을 넘지 못해 failed(test_retry_limit)이고, 두 실행이 함께 running인 조회 결과가 없다', async () => {
    const e = await startPipeline('happy-path');
    // 하루 한도를 채운다 (비어 있으면 자동 시작 없음, ADR-100 B⑤)
    await e.client.call('settings.update', {
      projectId: e.projectId,
      patch: { dailyBudgetUsd: 10 },
      author: human,
    });
    const base = mainTip(e);

    // 요구사항 저장부터 두 실행이 끝날 때까지 실행 목록을 폴링한다 (파이프 RPC 조회 = 화면이 보는 값)
    let polling = true;
    let polls = 0;
    const overlaps: string[][] = [];
    const poller = (async () => {
      while (polling) {
        const { runs } = await e.client.call('run.list', { projectId: e.projectId });
        const running = runs.filter((run) => run.status === 'running').map((run) => run.displayId);
        if (running.length > 1) overlaps.push(running);
        polls += 1;
        await sleep(100);
      }
    })();
    try {
      const { rules, status, autoStartedRunId } = await saveRequirement(
        e,
        '헬스 체크 응답에 서버 시각 포함',
        2,
        { autoStart: 'started' },
      );
      const [ruleA, ruleB] = rules;
      if (ruleA === undefined || ruleB === undefined) throw new Error('규칙 없음');
      const { runs } = await e.client.call('run.list', { projectId: e.projectId });
      // 규칙마다 실행 1개, 생성 기록 순서: 대상 규칙 1개 · 원인 = 그 규칙의 신규 기록 1건
      expect(
        runs.map((run) => [run.displayId, run.targetRuleIds, run.startedBy, run.type]),
      ).toEqual([
        ['EXE-001', [ruleA.id], { kind: 'orchestrator', causeSeqs: [1] }, 'A'],
        ['EXE-002', [ruleB.id], { kind: 'orchestrator', causeSeqs: [3] }, 'A'],
      ]);
      const [firstRun, secondRun] = runs;
      if (firstRun === undefined || secondRun === undefined) throw new Error('실행 없음');
      // 상태 줄의 자동 시작 결과는 첫 규칙의 실행이다
      expect(autoStartedRunId).toBe(firstRun.id);
      expect(status.autoStart).toEqual({
        state: 'started',
        runId: firstRun.id,
        runDisplayId: 'EXE-001',
      });

      const first = await waitForRunEnd(e, firstRun.id, 300_000);
      expect(first.run).toMatchObject({
        status: 'merged',
        failureReason: null,
        baseCommit: base,
        targetRuleIds: [ruleA.id],
      });
      expect(attempts(first)).toEqual([
        'approval#1:passed',
        'test_writing#1:passed',
        'red_check#1:passed',
        'implementation#1:passed',
        'check#1:passed',
        'mutation#1:skipped',
        'merge#1:passed',
        'screen_update#1:passed',
      ]);

      const second = await waitForRunEnd(e, secondRun.id, 600_000);
      // 둘째는 첫 실행의 병합 위에서 시작해(실행 대기 뒤), Red 확인이 not_red로 테스트 작성에 돌려보내 재시도 상한으로 끝난다
      expect(second.run).toMatchObject({
        status: 'failed',
        failureReason: 'test_retry_limit',
        baseCommit: first.run.mergeCommit,
        targetRuleIds: [ruleB.id],
        mergeCommit: null,
      });
      expect(String(second.run.startedAt) >= String(first.run.endedAt)).toBe(true);
      expect(attempts(second, 'test_writing', 'red_check')).toEqual([
        'test_writing#1:passed',
        'test_writing#2:passed',
        'test_writing#3:passed',
        'red_check#1:failed',
        'red_check#2:failed',
        'red_check#3:failed',
      ]);
      // Red 확인 3회 모두 not_red(이미 통과). 마지막은 재시도 상한으로 실행을 끝낸 시도라 사유가 그 안에 감싸인다
      const redChecks = second.steps.filter((step) => step.kind === 'red_check');
      expect(redChecks.map((step) => step.exitDetail)).toMatchObject([
        { reason: 'not_red' },
        { reason: 'not_red' },
        { reason: 'test_retry_limit', detail: { reason: 'not_red' } },
      ]);
      // 구현 단계로 가지 않았다
      expect(attempts(second, 'implementation')).toEqual(['implementation#1:pending']);

      // 기준 브랜치에는 첫 실행의 병합 커밋 1개뿐이다
      expect(mainTip(e)).toBe(first.run.mergeCommit);
      expect(mergeCount(e)).toBe(1);

      // 규범 변경 기록: 규칙마다 신규 · 모순 판단 1쌍 뒤 실행마다 자동 시작 1건, 체인 정상. 승인 기록은 비어 있다
      const changes = await e.client.call('normChange.list', { projectId: e.projectId });
      expect(changes.chain.valid).toBe(true);
      expect(changes.entries.map((entry) => [entry.seq, entry.kind, entry.targetRef.id])).toEqual([
        [1, 'created', ruleA.id],
        [2, 'judgment', ruleA.id],
        [3, 'created', ruleB.id],
        [4, 'judgment', ruleB.id],
        [5, 'auto_start', firstRun.id],
        [6, 'auto_start', secondRun.id],
      ]);
      expect(changes.entries.slice(4).map((entry) => entry.detail)).toEqual([
        { causeSeqs: [1], ruleIds: [ruleA.id] },
        { causeSeqs: [3], ruleIds: [ruleB.id] },
      ]);
      expect((await e.client.call('approvalLog.list', { projectId: e.projectId })).entries).toEqual(
        [],
      );
    } finally {
      polling = false;
      await poller;
    }
    // 폴링이 실제로 여러 번 돌았고 두 실행이 함께 진행 중인 조회는 한 번도 없었다
    expect(polls).toBeGreaterThan(10);
    expect(overlaps).toEqual([]);
  }, 900_000);
});
