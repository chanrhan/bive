// 판정 기록 리포지토리 · 규범 저장소 스냅숏 (M1-16, JDG-01 · JDG-02 · NFR-01, ADR-060 · ADR-069). 실제 SQLite 임시 저장소.
import { type Author, type JudgmentResult, RUN_STEP_PLANS, STEP_ROLES } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { captureNormSnapshot, compareNormSnapshots } from '../src/norm-snapshot.js';
import { ConflictError } from '../src/errors.js';
import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();
const T0 = '2026-10-16T00:00:00.000Z';
const T1 = '2026-10-16T01:00:00.000Z';
const T2 = '2026-10-16T02:00:00.000Z';
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const human = { kind: 'human' } as const satisfies Author;

const withStore = <T>(fn: (store: ProjectStore) => T): T => {
  const store = openProjectStore(newId(), { home: home() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

const seed = (store: ProjectStore) => {
  const requirement = store.requirements.create({
    id: newId(),
    text: '요구사항',
    author: human,
    normState: 'approved',
    createdAt: T0,
  });
  const rule = (title: string) =>
    store.rules.create({
      id: newId(),
      title,
      statement: 'WHEN GET /api/health THE SYSTEM SHALL 응답한다',
      kind: 'business',
      checkKinds: ['test'],
      parentRequirementId: requirement.id,
      builtin: false,
      targetBlockIds: [],
      risk: null,
      contractId: null,
      author: { kind: 'agent', role: 'rule-writer' },
      normState: 'approved',
      createdAt: T0,
    });
  const first = rule('첫 규칙');
  const second = rule('둘째 규칙');
  const detail = store.runs.create({
    id: newId(),
    type: 'A',
    targetRuleIds: [first.id],
    currentStep: 'approval',
    baseBranch: 'main',
    budgetSnapshot: { run: { maxBudgetUsd: 5, maxTurns: 200 }, roles: {} },
    modelSnapshot: {},
    startedBy: human,
    createdAt: T0,
    steps: RUN_STEP_PLANS.A.map((kind) => ({
      id: newId(),
      kind,
      attempt: 1,
      status: 'pending' as const,
      role: STEP_ROLES[kind],
      startedAt: null,
    })),
  });
  const check = detail.steps.find((step) => step.kind === 'check');
  if (check === undefined) throw new Error('검사 단계 없음');
  return { requirement, first, second, run: detail.run, check };
};

const judgment = (overrides: Partial<JudgmentResult> & Pick<JudgmentResult, 'ruleId'>) =>
  ({
    id: newId(),
    runId: null,
    stepId: null,
    commit: COMMIT_A,
    judgedAt: T1,
    status: 'pass',
    runner: 'vitest',
    exitCode: 0,
    reporterPath: '/bive/projects/p/judge/r/j/result.json',
    cases: [
      {
        name: '응답 > 시각',
        file: 'bive-acceptance/RULE-001/a.acc.ts',
        line: 4,
        status: 'passed',
        message: null,
      },
    ],
    quarantineReason: null,
    ...overrides,
  }) satisfies JudgmentResult;

describe('judgments', () => {
  it('판정 기록을 추가하고 규칙의 최신 판정(판정 시각 → ID 순)과 실행 · 규칙별 이력을 돌려준다', () => {
    withStore((store) => {
      const { first, second, run, check } = seed(store);
      expect(store.judgments.latestByRule(first.id)).toBeNull();
      expect(store.judgments.latestForRules()).toEqual(new Map());

      const old = judgment({ ruleId: first.id, judgedAt: T0, status: 'fail', exitCode: 1 });
      const [passed, failed] = store.judgments.record([
        judgment({ ruleId: first.id, runId: run.id, stepId: check.id, commit: COMMIT_B }),
        judgment({
          ruleId: second.id,
          runId: run.id,
          stepId: check.id,
          commit: COMMIT_B,
          status: 'fail',
          exitCode: 1,
          cases: [
            {
              name: '둘째 > 실패',
              file: 'bive-acceptance/RULE-002/b.acc.ts',
              line: 12,
              status: 'failed',
              message: 'expected 1 to be 2',
            },
          ],
        }),
      ]);
      store.judgments.record([old]);

      expect(store.judgments.latestByRule(first.id)).toEqual(passed);
      expect(store.judgments.latestByRule(second.id)).toEqual(failed);
      expect(store.judgments.latestForRules()).toEqual(
        new Map([
          [first.id, passed],
          [second.id, failed],
        ]),
      );
      expect(store.judgments.listByRun(run.id)).toEqual([passed, failed]);
      expect(store.judgments.listByRule(first.id)).toEqual([passed, old]);
      expect(store.judgments.listByRule(first.id, 1)).toEqual([passed]);

      // 같은 판정 시각이면 ID가 큰(나중에 만든) 기록이 최신이다
      const later = judgment({ ruleId: first.id, status: 'fail', exitCode: 1 });
      store.judgments.record([later]);
      expect(store.judgments.latestByRule(first.id)).toEqual(later);
    });
  });

  it('추가만 한다: 수정 · 삭제 · 덮어쓰기는 막고, 형식 · 외래 키를 검사한다', () => {
    withStore((store) => {
      const { first, run, check } = seed(store);
      const [saved] = store.judgments.record([judgment({ ruleId: first.id })]);
      if (saved === undefined) throw new Error('기록 없음');
      expect(() => store.judgments.record([saved])).toThrow(ConflictError);
      expect(() =>
        store.db.prepare("UPDATE judgments SET status = 'fail' WHERE id = ?").run(saved.id),
      ).toThrow(/바꿀 수 없/);
      expect(() => store.db.prepare('DELETE FROM judgments').run()).toThrow(/지울 수 없/);
      expect(() =>
        store.db
          .prepare(
            "INSERT OR REPLACE INTO judgments (id, rule_id, commit_sha, judged_at, status, runner, cases) VALUES (?, ?, ?, ?, 'fail', 'vitest', '[]')",
          )
          .run(saved.id, first.id, COMMIT_A, T2),
      ).toThrow(/덮어쓰기 금지/);
      // 실행 · 단계는 함께 있거나 함께 없다, 격리에는 사유가 필요하다, 없는 규칙은 외래 키 위반
      expect(() =>
        store.judgments.record([judgment({ ruleId: first.id, runId: run.id })]),
      ).toThrow();
      expect(() =>
        store.judgments.record([judgment({ ruleId: first.id, status: 'quarantined' })]),
      ).toThrow(/격리/);
      expect(() => store.judgments.record([judgment({ ruleId: newId() })])).toThrow(/FOREIGN/);
      expect(() =>
        store.judgments.record([judgment({ ruleId: first.id, stepId: check.id, runId: run.id })]),
      ).not.toThrow();
      // 한 건이라도 실패하면 같은 호출의 기록은 남지 않는다 (트랜잭션 1회)
      const before = store.judgments.listByRule(first.id).length;
      expect(() =>
        store.judgments.record([judgment({ ruleId: first.id }), judgment({ ruleId: newId() })]),
      ).toThrow();
      expect(store.judgments.listByRule(first.id)).toHaveLength(before);
    });
  });
});

describe('규범 저장소 스냅숏 (#117 기본 조치)', () => {
  const approve = (store: ProjectStore) =>
    store.approvalLog.append({
      at: T1,
      action: 'approve',
      actor: human,
      targetRef: { entity: 'Proposal', id: newId() },
      clientId: 'pipe-1',
      detail: { appliedRef: { entity: 'Rule', id: newId() } },
    });

  it('사람의 정상 활동(승인 기록 추가 · 새 규칙 · 부모 해제 · 다른 실행의 판정)은 불일치가 아니다', () => {
    withStore((store) => {
      const { requirement, run } = seed(store);
      approve(store);
      const before = captureNormSnapshot(store, run.id);
      approve(store);
      store.rules.create({
        id: newId(),
        title: '새 규칙',
        statement: 'WHEN GET /a THE SYSTEM SHALL 응답한다',
        kind: 'business',
        checkKinds: ['test'],
        parentRequirementId: requirement.id,
        builtin: false,
        targetBlockIds: [],
        risk: null,
        contractId: null,
        author: { kind: 'agent', role: 'rule-writer' },
        normState: 'approved',
        createdAt: T1,
      });
      store.rules.detachFromParent(requirement.id, T2);
      expect(compareNormSnapshots(before, captureNormSnapshot(store, run.id))).toEqual([]);
    });
  });

  it('승인 기록 변조 · 규칙 변경 · 삭제 · 이 실행의 기록 변경은 불일치다', () => {
    withStore((store) => {
      const { first, second, run, check } = seed(store);
      approve(store);
      approve(store);
      const before = captureNormSnapshot(store, run.id);
      // 같은 사용자 권한의 다른 프로세스 흉내: 트리거를 지우고 직접 고친다
      store.db.exec(
        'DROP TRIGGER approval_log_no_update; DROP TRIGGER steps_final; DROP TRIGGER steps_identity_immutable;',
      );
      store.db.prepare("UPDATE approval_log SET client_id = 'x' WHERE seq = 1").run();
      store.db
        .prepare("UPDATE rules SET statement = 'WHEN x THE SYSTEM SHALL y' WHERE id = ?")
        .run(first.id);
      store.db.prepare('UPDATE rules SET deleted_at = ? WHERE id = ?').run(T2, second.id);
      store.db.prepare("UPDATE steps SET exit_detail = '{}' WHERE id = ?").run(check.id);
      const kinds = compareNormSnapshots(before, captureNormSnapshot(store, run.id)).map(
        (m) => m.kind,
      );
      // 내용만 고친 승인 기록은 저장된 해시가 그대로라 체인 검증이 잡는다
      expect(kinds).toEqual([
        'approval_chain_broken',
        'rule_changed',
        'rule_changed',
        'run_records_changed',
      ]);

      // 승인 기록 끝을 잘라 내면 체인은 유효해도 앞부분이 사라진 것으로 잡는다
      const fresh = captureNormSnapshot(store, run.id);
      store.db.exec('DROP TRIGGER approval_log_no_delete;');
      store.db.prepare('DELETE FROM approval_log WHERE seq = 2').run();
      expect(
        compareNormSnapshots(fresh, captureNormSnapshot(store, run.id)).map((m) => m.kind),
      ).toContain('approval_log_rewritten');

      // 이 실행의 판정 기록이 끼어들어도 불일치다 (체인은 위에서 이미 깨진 상태)
      const again = captureNormSnapshot(store, run.id);
      store.judgments.record([judgment({ ruleId: first.id, runId: run.id, stepId: check.id })]);
      expect(
        compareNormSnapshots(again, captureNormSnapshot(store, run.id)).map((m) => m.kind),
      ).toEqual(['approval_chain_broken', 'run_records_changed']);
    });
  });
});
