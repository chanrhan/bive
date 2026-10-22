// 실행 · 단계 리포지토리 (M1-12, RUN-01 · RUN-02 · NFR-01 · ADR-061). 실제 SQLite 임시 저장소.
import { type Author, RUN_STEP_PLANS, STEP_ROLES, type StepKind } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { ConflictError, NotFoundError } from '../src/errors.js';
import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import type { RunCreateInput, RunDetail } from '../src/repositories/run-repository.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();

const T0 = '2026-10-16T00:00:00.000Z';
const T1 = '2026-10-16T01:00:00.000Z';
const T2 = '2026-10-16T02:00:00.000Z';
const SHA = 'a'.repeat(40);
const human = { kind: 'human' } as const satisfies Author;

const open = (projectId: string): ProjectStore => openProjectStore(projectId, { home: home() });

const withStore = <T>(fn: (store: ProjectStore) => T): T => {
  const store = open(newId());
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

const seedRule = (store: ProjectStore): string => {
  const requirement = store.requirements.create({
    id: newId(),
    text: '헬스 체크 응답에 서버 시각 포함',
    author: human,
    normState: 'approved',
    createdAt: T0,
  });
  return store.rules.create({
    id: newId(),
    title: '헬스 체크 서버 시각',
    statement: 'WHEN GET /api/health THE SYSTEM SHALL 응답에 서버 시각을 포함한다',
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
  }).id;
};

const runInput = (ruleIds: string[], overrides: Partial<RunCreateInput> = {}): RunCreateInput => {
  const plan: readonly StepKind[] = RUN_STEP_PLANS.A;
  return {
    id: newId(),
    type: 'A',
    targetRuleIds: ruleIds,
    currentStep: 'approval',
    baseBranch: 'main',
    budgetSnapshot: {
      run: { maxBudgetUsd: 5, maxTurns: 200 },
      roles: {
        'test-writer': { maxBudgetUsd: 2, maxTurns: 100 },
        implementer: { maxBudgetUsd: 2, maxTurns: 100 },
      },
    },
    modelSnapshot: { 'test-writer': 'test-model', implementer: 'test-model' },
    startedBy: human,
    createdAt: T1,
    steps: plan.map((kind, index) => ({
      id: newId(),
      kind,
      attempt: 1,
      status: index === 0 ? 'running' : 'pending',
      role: STEP_ROLES[kind],
      startedAt: index === 0 ? T1 : null,
    })),
    ...overrides,
  };
};

const stepOf = (detail: RunDetail, kind: StepKind, attempt = 1) => {
  const step = detail.steps.find((s) => s.kind === kind && s.attempt === attempt);
  if (step === undefined) throw new Error(`단계 없음: ${kind}#${String(attempt)}`);
  return step;
};

/** 승인 단계를 끝내고 테스트 작성으로 넘어간다. */
const passApproval = (store: ProjectStore, detail: RunDetail): RunDetail =>
  store.runs.transition(detail.run.id, {
    expectedStatus: 'waiting_approval',
    run: {
      status: 'running',
      currentStep: 'test_writing',
      lastCompletedStep: 'approval',
      startedAt: T2,
    },
    steps: [
      { id: stepOf(detail, 'approval').id, status: 'passed', endedAt: T2, exitDetail: { ok: 1 } },
      { id: stepOf(detail, 'test_writing').id, status: 'running', startedAt: T2 },
    ],
  });

describe('runs.create', () => {
  it('승인 대기 · 현재 단계 승인 · 진행 필드 비움으로 저장하고 표시 ID를 프로젝트별 순번으로 붙인다', () => {
    withStore((store) => {
      const a = seedRule(store);
      const b = seedRule(store);
      const first = store.runs.create(runInput([b, a]));
      expect(first.run).toMatchObject({
        displayId: 'EXE-001',
        projectId: store.projectId,
        type: 'A',
        targetRuleIds: [b, a],
        status: 'waiting_approval',
        currentStep: 'approval',
        lastCompletedStep: null,
        regressionCount: 0,
        failureReason: null,
        branch: null,
        worktreePath: null,
        baseCommit: null,
        headCommit: null,
        mergeCommit: null,
        costUsd: null,
        turns: null,
        toolManifest: [],
        startedAt: null,
        endedAt: null,
      });
      expect(first.steps.map((s) => s.kind)).toEqual([...RUN_STEP_PLANS.A]);
      expect(first.steps.map((s) => s.exitDetail)).toEqual(Array(8).fill(null));
      expect(store.runs.create(runInput([a])).run.displayId).toBe('EXE-002');
      expect(store.runs.getDetail(first.run.id)).toEqual(first);
      expect(store.runs.getDetailByDisplayId('EXE-001')).toEqual(first);
      expect(store.runs.get(newId())).toBeNull();
      expect(store.runs.getByDisplayId('EXE-009')).toBeNull();
    });
  });

  it('다른 프로젝트의 순번과 섞이지 않는다', () => {
    const one = open(newId());
    const two = open(newId());
    try {
      one.runs.create(runInput([seedRule(one)]));
      expect(two.runs.create(runInput([seedRule(two)])).run.displayId).toBe('EXE-001');
    } finally {
      one.close();
      two.close();
    }
  });

  it('없는 규칙은 NotFoundError, 삭제된 규칙은 ConflictError이고 실행 · 순번이 남지 않는다', () => {
    withStore((store) => {
      const live = seedRule(store);
      expect(() => store.runs.create(runInput([live, newId()]))).toThrow(NotFoundError);
      const doomed = seedRule(store);
      const parent = store.rules.get(doomed)?.parentRequirementId ?? '';
      store.db.prepare('UPDATE rules SET deleted_at = ? WHERE id = ?').run(T1, doomed);
      expect(parent).not.toBe('');
      expect(() => store.runs.create(runInput([doomed]))).toThrow(ConflictError);
      expect(store.runs.list()).toEqual([]);
      expect(store.sequences.last('EXE')).toBe(0);
      expect(store.runs.create(runInput([live])).run.displayId).toBe('EXE-001');
    });
  });

  it('스키마 위반(대상 규칙 중복 · 사람 아닌 시작 주체)은 순번을 쓰지 않는다', () => {
    withStore((store) => {
      const rule = seedRule(store);
      expect(() => store.runs.create(runInput([rule, rule]))).toThrow();
      expect(() =>
        store.runs.create(
          runInput([rule], {
            startedBy: { kind: 'agent', role: 'implementer' } as unknown as typeof human,
          }),
        ),
      ).toThrow();
      expect(store.sequences.last('EXE')).toBe(0);
    });
  });

  it('같은 ID로 다시 만들면 ConflictError', () => {
    withStore((store) => {
      const input = runInput([seedRule(store)]);
      store.runs.create(input);
      expect(() => store.runs.create(input)).toThrow(ConflictError);
      expect(store.runs.list()).toHaveLength(1);
    });
  });
});

describe('runs.list', () => {
  it('표시 ID 순, 상태로 거른다', () => {
    withStore((store) => {
      const rule = seedRule(store);
      const first = store.runs.create(runInput([rule]));
      store.runs.create(runInput([rule]));
      passApproval(store, first);
      expect(store.runs.list().map((r) => r.displayId)).toEqual(['EXE-001', 'EXE-002']);
      expect(store.runs.list({ status: 'running' }).map((r) => r.displayId)).toEqual(['EXE-001']);
      expect(store.runs.list({ status: 'waiting_approval' }).map((r) => r.displayId)).toEqual([
        'EXE-002',
      ]);
      expect(store.runs.list({ status: 'merged' })).toEqual([]);
    });
  });
});

describe('runs.transition (상태 저장 1회 = 트랜잭션 1회)', () => {
  it('단계 종료 · 다음 단계 시작 · 실행 갱신을 함께 저장하고, 다시 열어도 같은 값이다', () => {
    const projectId = newId();
    const store = open(projectId);
    let saved: RunDetail;
    try {
      const created = store.runs.create(runInput([seedRule(store)]));
      saved = passApproval(store, created);
      expect(saved.run).toMatchObject({
        status: 'running',
        currentStep: 'test_writing',
        lastCompletedStep: 'approval',
        startedAt: T2,
      });
      expect(stepOf(saved, 'approval')).toMatchObject({
        status: 'passed',
        endedAt: T2,
        exitDetail: { ok: 1 },
      });
      expect(stepOf(saved, 'test_writing')).toMatchObject({ status: 'running', startedAt: T2 });
    } finally {
      store.close();
    }
    const reopened = open(projectId);
    try {
      expect(reopened.runs.getDetail(saved.run.id)).toEqual(saved);
    } finally {
      reopened.close();
    }
  });

  it('회귀는 새 시도 행을 더하고 시도 순으로 정렬된다', () => {
    withStore((store) => {
      const started = passApproval(store, store.runs.create(runInput([seedRule(store)])));
      const regressed = store.runs.transition(started.run.id, {
        run: { currentStep: 'implementation', regressionCount: 1 },
        steps: [{ id: stepOf(started, 'test_writing').id, status: 'passed', commit: SHA }],
        addSteps: [
          {
            id: newId(),
            kind: 'implementation',
            attempt: 2,
            status: 'running',
            role: 'implementer',
            startedAt: T2,
          },
        ],
      });
      expect(regressed.steps.map((s) => `${s.kind}#${String(s.attempt)}`)).toEqual([
        'approval#1',
        'test_writing#1',
        'red_check#1',
        'implementation#1',
        'implementation#2',
        'check#1',
        'mutation#1',
        'merge#1',
        'screen_update#1',
      ]);
      expect(stepOf(regressed, 'test_writing').commit).toBe(SHA);
      expect(regressed.run.regressionCount).toBe(1);
      // 같은 단계 · 시도를 다시 더하면 거부되고 아무것도 바뀌지 않는다
      expect(() =>
        store.runs.transition(started.run.id, {
          run: { regressionCount: 2 },
          addSteps: [
            {
              id: newId(),
              kind: 'implementation',
              attempt: 2,
              status: 'pending',
              role: 'implementer',
              startedAt: null,
            },
          ],
        }),
      ).toThrow(ConflictError);
      expect(store.runs.getDetail(started.run.id)).toEqual(regressed);
    });
  });

  it('상태 기계에 없는 전이 · 기대 상태 불일치는 ConflictError이고 아무것도 바뀌지 않는다', () => {
    withStore((store) => {
      const created = store.runs.create(runInput([seedRule(store)]));
      const approval = stepOf(created, 'approval').id;
      for (const status of ['merged', 'failed', 'budget_exceeded', 'interrupted'] as const) {
        expect(() =>
          store.runs.transition(created.run.id, {
            run: { status },
            steps: [{ id: approval, status: 'passed' }],
          }),
        ).toThrow(ConflictError);
      }
      expect(() =>
        store.runs.transition(created.run.id, {
          expectedStatus: 'running',
          steps: [{ id: approval, status: 'passed' }],
        }),
      ).toThrow(/상태가 running가 아닙니다/);
      expect(store.runs.getDetail(created.run.id)).toEqual(created);
    });
  });

  it('스키마 위반 값은 거부되고 앞서 쓴 단계 변경도 되돌려진다', () => {
    withStore((store) => {
      const created = store.runs.create(runInput([seedRule(store)]));
      expect(() =>
        store.runs.transition(created.run.id, {
          steps: [{ id: stepOf(created, 'approval').id, status: 'passed' }],
          run: { regressionCount: -1 },
        }),
      ).toThrow();
      expect(() =>
        store.runs.transition(created.run.id, {
          steps: [
            { id: stepOf(created, 'approval').id, status: 'passed' },
            { id: stepOf(created, 'test_writing').id, commit: 'xyz' },
          ],
        }),
      ).toThrow();
      expect(store.runs.getDetail(created.run.id)).toEqual(created);
    });
  });

  it('없는 실행 · 다른 실행의 단계는 NotFoundError, 같은 단계를 두 번 · 끝난 단계를 바꾸면 ConflictError', () => {
    withStore((store) => {
      const rule = seedRule(store);
      const a = store.runs.create(runInput([rule]));
      const b = store.runs.create(runInput([rule]));
      expect(() => store.runs.transition(newId(), {})).toThrow(NotFoundError);
      expect(() =>
        store.runs.transition(a.run.id, {
          steps: [{ id: stepOf(b, 'approval').id, status: 'passed' }],
        }),
      ).toThrow(NotFoundError);
      const approval = stepOf(a, 'approval').id;
      expect(() =>
        store.runs.transition(a.run.id, {
          steps: [
            { id: approval, status: 'running' },
            { id: approval, status: 'passed' },
          ],
        }),
      ).toThrow(ConflictError);
      const started = passApproval(store, a);
      expect(() =>
        store.runs.transition(a.run.id, {
          steps: [{ id: stepOf(started, 'approval').id, status: 'failed' }],
        }),
      ).toThrow(/끝난 단계 시도/);
    });
  });

  it('바꿀 수 없는 필드(표시 ID · 유형 · 스냅샷 등)는 패치에 섞여 와도 무시한다', () => {
    withStore((store) => {
      const created = store.runs.create(runInput([seedRule(store)]));
      const patch = {
        displayId: 'EXE-099',
        type: 'B',
        budgetSnapshot: { run: { maxBudgetUsd: 999, maxTurns: 999 }, roles: {} },
        failureReason: '시험',
      } as unknown as { failureReason: string };
      const saved = store.runs.transition(created.run.id, { run: patch });
      expect(saved.run).toEqual({ ...created.run, failureReason: '시험' });
      expect(store.runs.get(created.run.id)).toEqual(saved.run);
    });
  });

  it('종료된 실행은 더 바꿀 수 없다 (리포지토리 · 트리거)', () => {
    withStore((store) => {
      const started = passApproval(store, store.runs.create(runInput([seedRule(store)])));
      const ended = store.runs.transition(started.run.id, {
        run: { status: 'failed', failureReason: '회귀 상한 초과', currentStep: null, endedAt: T2 },
        steps: [{ id: stepOf(started, 'test_writing').id, status: 'failed', endedAt: T2 }],
      });
      expect(ended.run.status).toBe('failed');
      expect(() =>
        store.runs.transition(started.run.id, { run: { failureReason: '다른 사유' } }),
      ).toThrow(/종료된 실행/);
      expect(() =>
        store.db.prepare('UPDATE runs SET failure_reason = ? WHERE id = ?').run('x', ended.run.id),
      ).toThrow(/종료된 실행/);
      expect(() =>
        store.db
          .prepare('UPDATE steps SET status = ? WHERE id = ?')
          .run('running', stepOf(ended, 'red_check').id),
      ).toThrow(/바꿀 수 없습니다/);
      expect(store.runs.getDetail(started.run.id)).toEqual(ended);
    });
  });
});

describe('기록 보존 트리거 (NFR-01)', () => {
  it('실행 · 단계 · 대상 규칙은 지울 수 없고 생성 정보는 바꿀 수 없으며 덮어쓰기도 막힌다', () => {
    withStore((store) => {
      const created = store.runs.create(runInput([seedRule(store)]));
      const { id } = created.run;
      const run =
        (sql: string, ...args: unknown[]) =>
        () =>
          store.db.prepare(sql).run(...args);
      expect(run('DELETE FROM runs WHERE id = ?', id)).toThrow(/지울 수 없습니다/);
      expect(run('DELETE FROM steps WHERE run_id = ?', id)).toThrow(/지울 수 없습니다/);
      expect(run('DELETE FROM run_target_rules WHERE run_id = ?', id)).toThrow(/지울 수 없습니다/);
      expect(run('UPDATE run_target_rules SET position = 5 WHERE run_id = ?', id)).toThrow(
        /바꿀 수 없습니다/,
      );
      expect(run(`UPDATE runs SET display_id = 'EXE-099' WHERE id = ?`, id)).toThrow(/생성 정보/);
      expect(run(`UPDATE runs SET budget_snapshot = '{}' WHERE id = ?`, id)).toThrow(/생성 정보/);
      expect(
        run(`UPDATE runs SET started_by = '{"kind":"human","by":"x"}' WHERE id = ?`, id),
      ).toThrow(/생성 정보/);
      expect(
        run(`UPDATE steps SET kind = 'merge' WHERE id = ?`, stepOf(created, 'approval').id),
      ).toThrow(/식별 정보/);
      expect(run(`INSERT OR REPLACE INTO runs SELECT * FROM runs WHERE id = ?`, id)).toThrow(
        /덮어쓰기 금지/,
      );
      expect(run(`INSERT OR REPLACE INTO steps SELECT * FROM steps WHERE run_id = ?`, id)).toThrow(
        /덮어쓰기 금지/,
      );
      expect(store.runs.getDetail(id)).toEqual(created);
    });
  });
});
