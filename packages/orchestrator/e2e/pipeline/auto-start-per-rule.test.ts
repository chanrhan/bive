// 파이프라인 e2e: 규칙마다 실행 1개 자동 시작 (M7-19 #244 수용 기준 4, RUN-01 · RUN-03 · RUN-05, ADR-100 B⑥, ADR-105 · ADR-110 ·
// ADR-111) · 동작 선언으로 고르는 실행 유형 (M3-30 #245, RUN-07, ADR-151).
// 요구사항 저장 → rule-writer가 규칙 2개를 바로 반영(시나리오 `happy-path`: 첫 규칙은 새 동작, 둘째 규칙 "응답 형식 유지"는 이미
// 통과하는 동작이라 기존 동작으로 선언) → 세션이 끝나면 오케스트레이터가 규칙마다 실행 1개씩 2개를 자동 시작(첫째 유형 A, 둘째 유형 C)
// → 첫 실행은 진행 중, 둘째는 실행 대기 → 첫 실행 병합 → 둘째 실행이 그 병합 위에서 시작한다. 둘째는 Red 확인 대신 Green 확인(구현
// 생략)이라 이미 통과하는 인수 테스트가 그대로 병합된다(ADR-110 맥락의 `test_retry_limit` 실패가 풀림. Red 확인은 바꾸지 않았고 통과하는
// 테스트를 대상에서 빼지도 않는다). 실행 내내 실행 목록을 폴링해 두 실행이 함께 `running`인 조회가 없음을 본다.
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
  it('첫 규칙(새 동작)의 실행은 유형 A로 merged, 이미 통과하는 둘째 규칙(기존 동작)의 실행은 유형 C(Green 확인 · 구현 생략)로 그 병합 위에서 merged이고, 두 실행이 함께 running인 조회 결과가 없다', async () => {
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
        ['EXE-002', [ruleB.id], { kind: 'orchestrator', causeSeqs: [3] }, 'C'],
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
      // 둘째는 첫 실행의 병합 위에서 시작해(실행 대기 뒤) Green 확인이 통과하고 구현 없이 병합된다 (유형 C, ADR-151)
      expect(second.run).toMatchObject({
        type: 'C',
        status: 'merged',
        failureReason: null,
        baseCommit: first.run.mergeCommit,
        targetRuleIds: [ruleB.id],
      });
      expect(String(second.run.startedAt) >= String(first.run.endedAt)).toBe(true);
      expect(attempts(second)).toEqual([
        'approval#1:passed',
        'test_writing#1:passed',
        'green_check#1:passed',
        'implementation#1:skipped',
        'check#1:passed',
        'mutation#1:skipped',
        'merge#1:passed',
        'screen_update#1:passed',
      ]);
      // 구현 세션은 열리지 않았고(구현 생략), 변이 주입은 보강 실행이 아니라 유형 생략이다
      expect(second.sessions.map((session) => session.role)).toEqual(['test-writer']);
      expect(
        second.steps
          .filter((step) => step.status === 'skipped')
          .map((step) => [step.kind, step.exitDetail]),
      ).toEqual([
        ['implementation', { reason: 'run_type', runType: 'C' }],
        ['mutation', { reason: 'run_type', runType: 'C' }],
      ]);

      // 기준 브랜치에는 두 실행의 병합 커밋 2개가 차례로 쌓인다
      expect(mainTip(e)).toBe(second.run.mergeCommit);
      expect(mergeCount(e)).toBe(2);

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
      // 동작 선언은 두 규칙의 신규 기록에만 있다 (자동 시작 항목에는 복사하지 않는다)
      expect(changes.entries.slice(0, 4).map((entry) => entry.detail.behavior)).toEqual([
        'new',
        undefined,
        'existing',
        undefined,
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
