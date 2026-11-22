// 파이프라인 e2e: 테스트 작성 · 구현 역할의 규범 입력 (M7-08 #220, RUN-04 · NFR-02, ADR-100 K1 · A14 · A15, ADR-108).
// 시나리오 norm-input: 요구사항 2개를 차례로 저장하고(요구사항마다 규칙 1개), 규칙마다 사람의 [실행]으로 끝까지 돌린다.
// 1. REQ-001 저장 → RULE-001(time) 바로 반영 → 실행 1(RULE-001) 병합
// 2. REQ-002 저장 → RULE-002(version) 바로 반영 → 실행 2(RULE-002) 병합
// 실행 2의 테스트 작성 · 구현 세션은 작업 지시의 규범 자료로 앞 실행의 RULE-001을 받고, 받은 표시 ID가 세션 기록에 남아
// 사람의 조회 RPC(`cli rpc run.get`과 같은 경로)의 세션 항목으로 보인다. 자동 시작은 쓰지 않는다(하루 한도 비움, 생략 단언은
// `saveRequirement`가 한다): 실행은 규칙마다 1개라 자동 시작으로 바뀌어도 실행 번호가 요구사항 순서와 같다.
import type { RunGetResult, RunSessionEntry } from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { attempts, cleanupPipeline, runToEnd, saveRequirement, startPipeline } from './harness.js';

afterEach(cleanupPipeline);

const RUN_TIMEOUT_MS = 300_000;

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

/** 역할의 세션 항목 (시작 순). */
const sessionsOf = (detail: RunGetResult, role: RunSessionEntry['role']): RunSessionEntry[] =>
  detail.sessions.filter((session) => session.role === role);

describe('norm-input: 테스트 작성 · 구현 세션이 효력 있는 규범을 작업 지시로 받고 받은 표시 ID를 세션 기록에 남긴다', () => {
  it('요구사항 2개를 차례로: 두 번째 실행의 구현 세션 규범 입력 목록에 앞 실행의 RULE-001이 있다 (run.get 세션 항목)', async () => {
    const e = await startPipeline('norm-input');

    // 1. 첫 요구사항 → 규칙 1개 → 실행 1
    const first = await saveRequirement(e, '헬스 체크 응답에 서버 시각 포함', 1);
    const [timeRule] = first.rules;
    if (timeRule === undefined) throw new Error('규칙 없음');
    expect(timeRule.displayId).toBe('RULE-001');
    const run1 = await runToEnd(e, [timeRule.id], RUN_TIMEOUT_MS);
    expect(run1.run).toMatchObject({ displayId: 'EXE-001', status: 'merged' });
    expect(attempts(run1)).toEqual(MERGED_STEPS);
    // 실행 1의 세션은 그때 효력 있던 규범(자기 대상과 그 부모)만 받았다
    for (const role of ['test-writer', 'implementer'] as const) {
      expect(
        sessionsOf(run1, role).map((session) => session.normInput),
        role,
      ).toEqual([
        {
          summary: {
            requirements: { total: 1, included: 1, omitted: 0 },
            rules: { total: 1, included: 1, omitted: 0 },
            truncated: false,
          },
          requirementDisplayIds: ['REQ-001'],
          ruleDisplayIds: ['RULE-001'],
        },
      ]);
    }

    // 2. 둘째 요구사항 → 규칙 1개 → 실행 2
    const second = await saveRequirement(e, '헬스 체크 응답에 버전 포함', 1);
    const [versionRule] = second.rules;
    if (versionRule === undefined) throw new Error('규칙 없음');
    expect(versionRule.displayId).toBe('RULE-002');
    const run2 = await runToEnd(e, [versionRule.id], RUN_TIMEOUT_MS);
    expect(run2.run).toMatchObject({ displayId: 'EXE-002', status: 'merged' });
    expect(attempts(run2)).toEqual(MERGED_STEPS);

    // 실행 2의 구현 · 테스트 작성 세션은 앞 실행의 RULE-001(대상 아님)과 그 부모 REQ-001을 규범 입력으로 받았다
    const both = {
      summary: {
        requirements: { total: 2, included: 2, omitted: 0 },
        rules: { total: 2, included: 2, omitted: 0 },
        truncated: false,
      },
      requirementDisplayIds: ['REQ-001', 'REQ-002'],
      ruleDisplayIds: ['RULE-001', 'RULE-002'],
    };
    const implementers = sessionsOf(run2, 'implementer');
    expect(implementers).toHaveLength(1);
    expect(implementers[0]?.normInput?.ruleDisplayIds).toContain('RULE-001');
    expect(implementers.map((session) => session.normInput)).toEqual([both]);
    expect(sessionsOf(run2, 'test-writer').map((session) => session.normInput)).toEqual([both]);
    // 세션 항목은 실행의 단계 시도를 가리키고 모두 정상 종료다
    const stepIds = new Set(run2.steps.map((step) => step.id));
    for (const session of run2.sessions) {
      expect(stepIds.has(session.stepId)).toBe(true);
      expect(session.endReason).toBe('success');
    }
    // 같은 실행을 표시 ID로 다시 읽어도 같다 (저장된 기록)
    expect(
      (await e.client.call('run.get', { projectId: e.projectId, id: 'EXE-002' })).sessions,
    ).toEqual(run2.sessions);
  }, 900_000);
});
