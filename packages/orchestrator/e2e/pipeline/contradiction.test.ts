// 파이프라인 e2e: 모순 해소 · 실수로 깬 기존 규칙 · 이의 제기 · 확인 풀림 (M7-17 #229, RUN-02 · RUN-08 · NRM-02, ADR-071 ·
// ADR-100, ADR-112 · ADR-113 · ADR-115 · ADR-118).
// 네 흐름은 시나리오가 달라 흐름마다 픽스처 복사본과 오케스트레이터를 새로 띄운다(시나리오는 기동 때 정해지고, 흐름끼리 실행 ·
// 규범 변경 기록이 섞이면 순서 단언이 약해진다). 모두 하루 한도를 채워 자동 시작으로 돈다(사람의 조작은 설정 저장 · 요구사항
// 저장 · 확인뿐). 판정은 실제 판정 러너, 병합은 실제 git이고 가짜는 에이전트 어댑터뿐이다(ADR-016).
// 1. contradiction: RULE-001 병합 → 사람이 RULE-001을 확인 → 모순 요구사항 저장 → 규칙 작성 세션이 RULE-001을 RULE-002로
//    대체 + 확인 풀림 → 자동 시작된 EXE-002가 merged(검사 판정에 폐기된 RULE-001 없음) → 확인할 것 목록 맨 앞이 그 대체
// 2. contradiction-missed: 규칙 작성이 모순을 못 봄 → EXE-002 검사에서 RULE-001 실패 → 판단 세션이 모순 · 대체 → EXE-002는
//    failed(기존 규칙 모순) · 병합 없음 → 대체 규칙의 EXE-003 · RULE-002를 다시 시작한 EXE-004가 merged
// 3. accidental-break: EXE-002 구현이 실수로 RULE-001을 깸 → 판단 모순 없음 → 같은 실행이 구현 재시도로 merged, 폐기 0
// 4. objection: 구현 시도 1의 이의 → 판단 유지 → 구현 시도 2로 merged, 폐기 0
// 확인됨 규칙은 1의 RULE-001뿐이다. 그 규칙의 기존 테스트를 바꾸는 병합이 없으므로(EXE-002의 대상은 새 규칙) 어느 흐름에도
// 테스트 변경 알림(`test_changed`)이 끼지 않는다.
import type { NormChangeEntry, Run, RunGetResult } from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attempts,
  branchExists,
  cleanupPipeline,
  git,
  human,
  mainTip,
  mergeCount,
  type PipelineE2e,
  readStore,
  saveRequirement,
  startPipeline,
  waitForRunCreated,
  waitForRunEnd,
} from './harness.js';

afterEach(cleanupPipeline);

const RUN_TIMEOUT_MS = 300_000;

/** 한 번에 통과해 병합된 실행의 단계 시도 */
const MERGED_STEPS = [
  'approval#1:passed',
  'test_writing#1:passed',
  'red_check#1:passed',
  'implementation#1:passed',
  'check#1:passed',
  'mutation#1:skipped',
  'merge#1:passed',
  'screen_update#1:passed',
];

/** 하루 한도를 채운 시나리오 오케스트레이터 (자동 시작이 돈다, ADR-100 B⑤). */
const startWithBudget = async (scenario: string): Promise<PipelineE2e> => {
  const e = await startPipeline(scenario);
  await e.client.call('settings.update', {
    projectId: e.projectId,
    patch: { dailyBudgetUsd: 10 },
    author: human,
  });
  return e;
};

/** 규범 변경 기록의 종류 순서. 판단 기록은 `judgment(주제:결과)`로 적는다. */
const kindsOf = (entries: readonly NormChangeEntry[]): string[] =>
  entries.map((entry) =>
    entry.kind === 'judgment'
      ? `judgment(${String(entry.detail.judgment?.subject)}:${String(entry.detail.judgment?.verdict)})`
      : entry.kind,
  );

/** 체인이 정상인 규범 변경 기록 전부. */
const normChanges = async (e: PipelineE2e): Promise<NormChangeEntry[]> => {
  const changes = await e.client.call('normChange.list', { projectId: e.projectId });
  expect(changes.chain.valid).toBe(true);
  return changes.entries;
};

/** 실행 목록 `표시 ID:상태:종료 사유`. */
const runSummary = async (e: PipelineE2e): Promise<string[]> =>
  (await e.client.call('run.list', { projectId: e.projectId })).runs.map(
    (run: Run) => `${run.displayId}:${run.status}:${String(run.failureReason)}`,
  );

/** run.get 세션 목록 `역할:종료 사유` (시작 순). */
const sessionsOf = (detail: RunGetResult): string[] =>
  detail.sessions.map((session) => `${session.role}:${String(session.endReason)}`);

/** 폐기 행 수 (폐기 · 대체 건수, ADR-112). */
const retirementCount = (e: PipelineE2e, ruleIds: readonly string[]): number =>
  readStore(e, (store) => ruleIds.filter((id) => store.ruleRetirements.get(id) !== null).length);

/** 실행의 판정 기록 `규칙 표시 ID:결과` (단계 순). */
const judgedRules = (e: PipelineE2e, runId: string): string[] =>
  readStore(e, (store) =>
    store.judgments
      .listByRun(runId)
      .map((j) => `${store.rules.get(j.ruleId)?.displayId ?? j.ruleId}:${j.status}`),
  );

/** 같은 단계 종류 시도의 결과 상세 (시도 순). */
const exitDetailsOf = (detail: RunGetResult, kind: RunGetResult['steps'][number]['kind']) =>
  detail.steps.filter((step) => step.kind === kind).map((step) => step.exitDetail);

/** 브랜치가 main에 들어갔는지 (main의 조상인지). */
const mergedIntoMain = (e: PipelineE2e, branch: string): boolean => {
  try {
    git(e.repo, 'merge-base', '--is-ancestor', branch, 'refs/heads/main');
    return true;
  } catch {
    return false;
  }
};

describe('contradiction: 모순 해소 · 실수로 깬 기존 규칙 · 이의 제기 · 확인 풀림', () => {
  it('contradiction: 확인됨 RULE-001을 규칙 작성 세션이 대체하면 확인이 풀려 확인할 것 맨 앞에 오고, 자동 시작된 대체 규칙의 실행은 폐기된 RULE-001을 판정하지 않고 merged', async () => {
    const e = await startWithBudget('contradiction');

    // 1. REQ-001 → RULE-001 → EXE-001 자동 시작 · merged
    const first = await saveRequirement(e, '헬스 체크 응답에 서버 시각 포함', 1, {
      autoStart: 'started',
    });
    const [rule1] = first.rules;
    if (rule1 === undefined || first.autoStartedRunId === null) throw new Error('규칙 · 실행 없음');
    expect(rule1.displayId).toBe('RULE-001');
    const run1 = await waitForRunEnd(e, first.autoStartedRunId, RUN_TIMEOUT_MS);
    expect(run1.run).toMatchObject({ displayId: 'EXE-001', status: 'merged' });
    expect(attempts(run1)).toEqual(MERGED_STEPS);

    // 2. 사람이 RULE-001을 확인한다 (확인됨을 만드는 경로는 사람 RPC뿐, ADR-113)
    const confirmed = await e.client.call('confirmation.set', {
      projectId: e.projectId,
      target: { entity: 'Rule', id: rule1.id },
      author: human,
    });
    expect(confirmed.confirmation.state).toBe('confirmed');
    const seqBefore = (await normChanges(e)).length;

    // 3. 모순 요구사항 → 규칙 작성 세션이 RULE-001을 RULE-002로 대체 → EXE-002 자동 시작
    const second = await saveRequirement(e, '헬스 체크 응답에서 서버 시각 제거', 1, {
      autoStart: 'started',
    });
    const [rule2] = second.rules;
    if (rule2 === undefined || second.autoStartedRunId === null)
      throw new Error('규칙 · 실행 없음');
    expect(rule2.displayId).toBe('RULE-002');
    // 폐기된 RULE-001은 기본 규칙 목록에서 빠지고, 확인이 풀렸다
    expect(
      (await e.client.call('rule.list', { projectId: e.projectId })).rules.map(
        (entry) => entry.rule.displayId,
      ),
    ).toEqual(['RULE-002']);
    const retired = await e.client.call('rule.get', { projectId: e.projectId, id: rule1.id });
    expect(retired.rule.confirmation.state).toBe('unconfirmed');
    expect(retired.retirement).toMatchObject({
      supersededBy: { id: rule2.id, displayId: 'RULE-002' },
    });

    const run2 = await waitForRunEnd(e, second.autoStartedRunId, RUN_TIMEOUT_MS);
    expect(run2.run).toMatchObject({
      displayId: 'EXE-002',
      status: 'merged',
      failureReason: null,
      targetRuleIds: [rule2.id],
      baseCommit: run1.run.mergeCommit,
    });
    expect(attempts(run2)).toEqual(MERGED_STEPS);
    // 검사 단계 판정에 폐기된 RULE-001이 없다: 판정한 규칙은 RULE-002뿐이고 RULE-001 폴더는 판정하지 않은 폴더로 남는다
    expect(exitDetailsOf(run2, 'check')).toMatchObject([
      { ruleIds: ['RULE-002'], unjudgedDirs: ['RULE-001'] },
    ]);
    expect(judgedRules(e, run2.run.id)).toEqual(['RULE-002:pass', 'RULE-002:pass']);
    expect(sessionsOf(run2)).toEqual(['test-writer:success', 'implementer:success']);
    expect(await runSummary(e)).toEqual(['EXE-001:merged:null', 'EXE-002:merged:null']);
    expect(mergeCount(e)).toBe(2);
    expect(mainTip(e)).toBe(run2.run.mergeCommit);

    // 규범 변경 기록: 대체(supersede 판단 → superseded) 바로 뒤 오케스트레이터의 확인 풀림, 그 뒤 자동 시작
    const entries = await normChanges(e);
    expect(kindsOf(entries)).toEqual([
      'created',
      'judgment(new_rule:no_contradiction)',
      'auto_start',
      'created',
      'judgment(supersede:contradiction)',
      'superseded',
      'unconfirmed',
      'auto_start',
    ]);
    expect(seqBefore).toBe(3);
    const superseded = entries[5];
    const unconfirmed = entries[6];
    if (superseded === undefined || unconfirmed === undefined) throw new Error('기록 없음');
    expect(superseded).toMatchObject({ targetRef: { id: rule1.id }, actor: { kind: 'agent' } });
    expect(unconfirmed).toMatchObject({
      targetRef: { entity: 'Rule', id: rule1.id },
      actor: { kind: 'orchestrator' },
      detail: { unconfirm: { causeSeq: superseded.seq } },
    });
    expect(entries[7]).toMatchObject({ runId: run2.run.id, detail: { ruleIds: [rule2.id] } });
    expect(retirementCount(e, [rule1.id, rule2.id])).toBe(1);

    // 확인할 것 목록 맨 앞이 그 대체이고 확인 풀림이 실려 있다
    const list = await e.client.call('confirmation.list', { projectId: e.projectId });
    expect(list.items[0]).toMatchObject({
      kind: 'superseded',
      seq: superseded.seq,
      rule: { id: rule1.id, displayId: 'RULE-001' },
      after: { rule: { id: rule2.id, displayId: 'RULE-002' } },
      released: { seq: unconfirmed.seq, at: unconfirmed.at },
    });
    expect(list.items.filter((item) => item.kind === 'test_changed')).toEqual([]);
  }, 900_000);

  it('contradiction-missed: 규칙 작성이 놓친 모순은 검사의 판단 세션이 대체하고, 첫 실행은 병합 없이 끝나며 대체 규칙과 원래 대상 규칙의 새 실행이 merged', async () => {
    const e = await startWithBudget('contradiction-missed');

    const first = await saveRequirement(e, '헬스 체크 응답에 서버 시각 포함', 1, {
      autoStart: 'started',
    });
    const [rule1] = first.rules;
    if (rule1 === undefined || first.autoStartedRunId === null) throw new Error('규칙 · 실행 없음');
    const run1 = await waitForRunEnd(e, first.autoStartedRunId, RUN_TIMEOUT_MS);
    expect(run1.run).toMatchObject({ displayId: 'EXE-001', status: 'merged' });

    // REQ-002의 규칙 작성은 RULE-001과의 모순을 보지 못하고 RULE-002만 만든다
    const second = await saveRequirement(e, '헬스 체크 응답에서 서버 시각 제거', 1, {
      autoStart: 'started',
    });
    const [rule2] = second.rules;
    if (rule2 === undefined || second.autoStartedRunId === null)
      throw new Error('규칙 · 실행 없음');
    expect(rule2.displayId).toBe('RULE-002');

    // EXE-002: 검사에서 RULE-001 실패 → 판단 세션이 모순 · 대체 → 기존 규칙 모순으로 끝나고 병합되지 않는다
    const run2 = await waitForRunEnd(e, second.autoStartedRunId, RUN_TIMEOUT_MS);
    expect(run2.run).toMatchObject({
      displayId: 'EXE-002',
      status: 'failed',
      failureReason: 'existing_rule_contradiction',
      targetRuleIds: [rule2.id],
      mergeCommit: null,
    });
    expect(attempts(run2)).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'red_check#1:passed',
      'implementation#1:passed',
      'check#1:failed',
      // 검사에서 끝나 뒤 단계는 열리지 않았다
      'mutation#1:pending',
      'merge#1:pending',
      'screen_update#1:pending',
    ]);
    expect(exitDetailsOf(run2, 'check')).toMatchObject([
      { reason: 'existing_rule_contradiction', detail: { failedRuleIds: ['RULE-001'] } },
    ]);
    // 판단 세션은 판단을 청한 검사 시도에 묶여 rule-writer로 나온다
    expect(sessionsOf(run2)).toEqual([
      'test-writer:success',
      'implementer:success',
      'rule-writer:success',
    ]);
    const checkStep = run2.steps.find((step) => step.kind === 'check');
    expect(run2.sessions.at(-1)?.stepId).toBe(checkStep?.id);
    // 모순으로 끝난 실행의 브랜치는 main에 들어가지 않았다
    const branch2 = String(run2.run.branch);
    expect(branchExists(e, branch2)).toBe(true);
    expect(mergedIntoMain(e, branch2)).toBe(false);

    // 대체 규칙(RULE-003)의 실행과 RULE-002를 다시 시작한 실행이 차례로 merged
    const run3Created = await waitForRunCreated(e, 'EXE-003', RUN_TIMEOUT_MS);
    const run4Created = await waitForRunCreated(e, 'EXE-004', RUN_TIMEOUT_MS);
    const rule3 = (await e.client.call('rule.list', { projectId: e.projectId })).rules.find(
      (entry) => entry.rule.displayId === 'RULE-003',
    )?.rule;
    if (rule3 === undefined) throw new Error('대체 규칙 없음');
    expect(rule3.parentRequirementId).toBe(rule1.parentRequirementId);
    expect(run3Created.targetRuleIds).toEqual([rule3.id]);
    expect(run4Created.targetRuleIds).toEqual([rule2.id]);
    const run3 = await waitForRunEnd(e, run3Created.id, RUN_TIMEOUT_MS);
    expect(run3.run).toMatchObject({ status: 'merged', baseCommit: run1.run.mergeCommit });
    expect(attempts(run3)).toEqual(MERGED_STEPS);
    const run4 = await waitForRunEnd(e, run4Created.id, RUN_TIMEOUT_MS);
    expect(run4.run).toMatchObject({ status: 'merged', baseCommit: run3.run.mergeCommit });
    expect(attempts(run4)).toEqual(MERGED_STEPS);
    expect(await runSummary(e)).toEqual([
      'EXE-001:merged:null',
      'EXE-002:failed:existing_rule_contradiction',
      'EXE-003:merged:null',
      'EXE-004:merged:null',
    ]);
    expect(mergeCount(e)).toBe(3);
    expect(mainTip(e)).toBe(run4.run.mergeCommit);
    expect(mergedIntoMain(e, branch2)).toBe(false);

    // 규범 변경 기록: 대체 판단 · 검사 실패 판단(모순) · superseded 뒤 대체 규칙의 자동 시작과 RULE-002의 다시 시작
    const entries = await normChanges(e);
    expect(kindsOf(entries)).toEqual([
      'created',
      'judgment(new_rule:no_contradiction)',
      'auto_start',
      'created',
      'judgment(new_rule:no_contradiction)',
      'auto_start',
      'created',
      'judgment(supersede:contradiction)',
      'judgment(check_failure:contradiction)',
      'superseded',
      'auto_start',
      'auto_start',
    ]);
    const checkJudgment = entries[8];
    if (checkJudgment === undefined) throw new Error('기록 없음');
    expect(checkJudgment).toMatchObject({ runId: run2.run.id, targetRef: { id: rule1.id } });
    expect(entries[10]).toMatchObject({ runId: run3.run.id, detail: { ruleIds: [rule3.id] } });
    // 다시 시작의 원인은 끝난 실행의 모순 판단 순번이다 (ADR-118)
    expect(entries[11]).toMatchObject({
      runId: run4.run.id,
      detail: { causeSeqs: [checkJudgment.seq], ruleIds: [rule2.id] },
    });
    expect(retirementCount(e, [rule1.id, rule2.id, rule3.id])).toBe(1);
  }, 1_500_000);

  it('accidental-break: 판단이 모순 없음이면 같은 실행이 구현 재시도로 merged이고 폐기 · 대체가 없다', async () => {
    const e = await startWithBudget('accidental-break');

    const first = await saveRequirement(e, '헬스 체크 응답에 서버 시각 포함', 1, {
      autoStart: 'started',
    });
    const [rule1] = first.rules;
    if (rule1 === undefined || first.autoStartedRunId === null) throw new Error('규칙 · 실행 없음');
    const run1 = await waitForRunEnd(e, first.autoStartedRunId, RUN_TIMEOUT_MS);
    expect(run1.run).toMatchObject({ displayId: 'EXE-001', status: 'merged' });

    const second = await saveRequirement(e, '헬스 체크 응답에 버전 포함', 1, {
      autoStart: 'started',
    });
    const [rule2] = second.rules;
    if (rule2 === undefined || second.autoStartedRunId === null)
      throw new Error('규칙 · 실행 없음');
    const run2 = await waitForRunEnd(e, second.autoStartedRunId, 600_000);
    expect(run2.run).toMatchObject({
      displayId: 'EXE-002',
      status: 'merged',
      failureReason: null,
      regressionCount: 1,
      targetRuleIds: [rule2.id],
    });
    expect(attempts(run2, 'implementation', 'check')).toEqual([
      'implementation#1:passed',
      'implementation#2:passed',
      'check#1:failed',
      'check#2:passed',
    ]);
    expect(sessionsOf(run2)).toEqual([
      'test-writer:success',
      'implementer:success',
      'rule-writer:success',
      'implementer:success',
    ]);
    // 검사 시도 2는 RULE-001 · RULE-002 모두 판정해 통과했다
    expect(exitDetailsOf(run2, 'check').at(-1)).toMatchObject({
      ruleIds: ['RULE-001', 'RULE-002'],
    });
    expect(await runSummary(e)).toEqual(['EXE-001:merged:null', 'EXE-002:merged:null']);
    expect(mergeCount(e)).toBe(2);
    expect(mainTip(e)).toBe(run2.run.mergeCommit);

    const entries = await normChanges(e);
    expect(kindsOf(entries)).toEqual([
      'created',
      'judgment(new_rule:no_contradiction)',
      'auto_start',
      'created',
      'judgment(new_rule:no_contradiction)',
      'auto_start',
      'judgment(check_failure:no_contradiction)',
    ]);
    expect(entries.at(-1)).toMatchObject({
      runId: run2.run.id,
      targetRef: { id: rule1.id },
      actor: { kind: 'agent' },
    });
    // 폐기 · 대체 0건, 규칙은 둘 다 효력
    expect(retirementCount(e, [rule1.id, rule2.id])).toBe(0);
    expect(
      (await e.client.call('rule.list', { projectId: e.projectId })).rules.map(
        (entry) => entry.rule.displayId,
      ),
    ).toEqual(['RULE-001', 'RULE-002']);
  }, 1_200_000);

  it('objection: 구현 시도 1의 이의를 판단 세션이 유지하면 구현 시도 2로 merged이고 폐기가 없다', async () => {
    const e = await startWithBudget('objection');

    const first = await saveRequirement(e, '헬스 체크 응답에 서버 시각 포함', 1, {
      autoStart: 'started',
    });
    const [rule1] = first.rules;
    if (rule1 === undefined || first.autoStartedRunId === null) throw new Error('규칙 · 실행 없음');
    const run1 = await waitForRunEnd(e, first.autoStartedRunId, 600_000);
    expect(run1.run).toMatchObject({
      displayId: 'EXE-001',
      status: 'merged',
      failureReason: null,
      regressionCount: 1,
    });
    expect(attempts(run1, 'implementation', 'check')).toEqual([
      'implementation#1:failed',
      'implementation#2:passed',
      'check#1:passed',
    ]);
    expect(sessionsOf(run1)).toEqual([
      'test-writer:success',
      'implementer:objection_raised',
      'rule-writer:success',
      'implementer:success',
    ]);
    expect(await runSummary(e)).toEqual(['EXE-001:merged:null']);
    expect(mergeCount(e)).toBe(1);
    expect(mainTip(e)).toBe(run1.run.mergeCommit);

    const entries = await normChanges(e);
    expect(kindsOf(entries)).toEqual([
      'created',
      'judgment(new_rule:no_contradiction)',
      'auto_start',
      'objection',
      'judgment(objection:upheld)',
    ]);
    const [, , , objection, upheld] = entries;
    if (objection === undefined || upheld === undefined) throw new Error('기록 없음');
    expect(objection).toMatchObject({
      actor: { kind: 'agent', role: 'implementer' },
      targetRef: { entity: 'Run', id: run1.run.id },
    });
    expect(upheld).toMatchObject({
      actor: { kind: 'agent' },
      targetRef: { id: rule1.id },
      detail: { judgment: { causeSeq: objection.seq } },
    });
    expect(retirementCount(e, [rule1.id])).toBe(0);
  }, 900_000);
});
