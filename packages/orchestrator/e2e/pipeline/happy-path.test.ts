// 파이프라인 e2e: 정상 완주 (M1-21, architecture.md 8장 "정상 완주", RUN-02 · RUN-08, roadmap M1 완료 기준 흐름 3~7).
// 요구사항 저장 → rule-writer가 규칙을 바로 반영(승인 없음, M7-02) → 세션이 끝나면 오케스트레이터가 실행을 자동 시작(실행 시작
// 확인 없음, M7-05 #217 · ADR-100 D1 · B⑤ · ADR-107) → 승인 단계(효력 확인, 사람 대기 없음) → 테스트 작성 → Red 확인 → 구현 →
// 검사 → 병합. 사람의 조작은 설정 저장과 요구사항 저장뿐이다.
// 자동 시작은 하루 한도가 채워져 있어야 한다(비어 있으면 생략, B⑤). 시나리오 `auto-start`는 happy-path와 같고 규칙이 1개다:
// 자동 시작 실행은 세션이 만든 규칙 전부가 대상이라, 이미 통과하는 규칙이 섞이면 Red 확인을 넘지 못한다.
// 사람의 [실행](run.create)이 그대로 실행을 만드는 것은 하루 한도를 비워 둔 다른 파이프라인 e2e 전부가 본다(harness.saveRequirement).
// 판정은 실제 판정 러너(커밋의 깨끗한 체크아웃 · 설치 · next build · next start · vitest)로만 정한다.
import { afterEach, describe, expect, it } from 'vitest';

import {
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
  saveRequirement,
  startPipeline,
  waitForRunEnd,
} from './harness.js';

afterEach(cleanupPipeline);

describe('happy-path: 요구사항 저장부터 merged까지 (승인 · 실행 시작 확인 없음)', () => {
  it('규칙 작성 뒤 실행이 자동 시작되어 판정 pass, main에 merge commit 1개, 병합 커밋에 구현과 인수 테스트가 들어 있다', async () => {
    const e = await startPipeline('auto-start');
    // 하루 한도를 채운다 (비어 있으면 자동 시작 없음, ADR-100 B⑤)
    await e.client.call('settings.update', {
      projectId: e.projectId,
      patch: { dailyBudgetUsd: 10 },
      author: human,
    });
    const base = mainTip(e);

    const { requirement, rules, status, autoStartedRunId } = await saveRequirement(
      e,
      '헬스 체크 응답에 서버 시각 포함',
      1,
      { autoStart: 'started' },
    );
    // 규칙이 사람의 승인 없이 바로 효력을 갖는다(M7-02, ADR-100 D1). 승인 · 거절 호출은 없다
    const [rule] = rules;
    if (rule === undefined || autoStartedRunId === null) throw new Error('규칙 · 실행 없음');
    expect(rules.map((r) => [r.parentRequirementId, r.normState, r.confirmation.state])).toEqual([
      [requirement.id, 'approved', 'unconfirmed'],
    ]);
    expect(status.autoStart).toEqual({
      state: 'started',
      runId: autoStartedRunId,
      runDisplayId: 'EXE-001',
    });

    // run.create를 부르지 않는다: 자동 시작된 실행이 끝날 때까지 기다리기만 한다
    const done = await waitForRunEnd(e, autoStartedRunId, 300_000);
    expect(done.run).toMatchObject({
      displayId: 'EXE-001',
      status: 'merged',
      failureReason: null,
      regressionCount: 0,
      branch: RUN_BRANCH,
      baseCommit: base,
      targetRuleIds: [rule.id],
      startedBy: { kind: 'orchestrator', causeSeqs: [1] },
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
    expect((await e.client.call('run.list', { projectId: e.projectId })).runs).toHaveLength(1);

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

    // 사람 기록(승인 기록)에는 아무것도 없다: 승인도 실행 시작 확인도 없었다 (ADR-100 C2)
    const { entries: approvals } = await e.client.call('approvalLog.list', {
      projectId: e.projectId,
    });
    expect(approvals).toEqual([]);
    // 에이전트의 규칙 반영과 오케스트레이터의 자동 시작은 규범 변경 기록에만 있다
    const changes = await e.client.call('normChange.list', { projectId: e.projectId });
    expect(changes.chain.valid).toBe(true);
    expect(
      changes.entries.map((entry) => [entry.seq, entry.kind, entry.actor.kind, entry.targetRef.id]),
    ).toEqual([
      [1, 'created', 'agent', rule.id],
      [2, 'auto_start', 'orchestrator', done.run.id],
    ]);
    expect(changes.entries[1]).toMatchObject({
      runId: done.run.id,
      detail: { causeSeqs: [1], ruleIds: [rule.id] },
    });
    expect((await e.client.call('proposal.list', { projectId: e.projectId })).proposals).toEqual(
      [],
    );
  }, 600_000);
});
