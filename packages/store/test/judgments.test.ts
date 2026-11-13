// 판정 기록 리포지토리 · 규범 저장소 스냅숏 (M1-16, JDG-01 · JDG-02 · NFR-01, ADR-060 · ADR-069). 실제 SQLite 임시 저장소.
import { type Author, type JudgmentResult, RUN_STEP_PLANS, STEP_ROLES } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { canonicalJson, computeApprovalLogHash } from '../src/approval-chain.js';
import { openDatabase } from '../src/database.js';
import { beginNormWatch, verifyNormWatch } from '../src/norm-snapshot.js';
import { bivePaths } from '../src/paths.js';
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

describe('규범 저장소 쓰기 장부 (#117 기본 조치, 검토 1회차)', () => {
  /** 같은 프로젝트 저장소를 여러 번 연다 (오케스트레이터의 요청마다 열고 닫기). */
  const project = () => {
    const id = newId();
    const open = <T>(fn: (store: ProjectStore) => T): T => {
      const store = openProjectStore(id, { home: home() });
      try {
        return fn(store);
      } finally {
        store.close();
      }
    };
    /** 다른 프로세스 흉내: ProjectStore를 거치지 않는 별도 연결 */
    const raw = (fn: (db: ReturnType<typeof openDatabase>) => void): void => {
      const db = openDatabase(bivePaths(home()).projectDb(id), { create: false });
      try {
        fn(db);
      } finally {
        db.close();
      }
    };
    return { open, raw };
  };
  const approve = (store: ProjectStore) =>
    store.approvalLog.append({
      at: T1,
      action: 'approve',
      actor: human,
      targetRef: { entity: 'Proposal', id: newId() },
      clientId: 'pipe-1',
      detail: { appliedRef: { entity: 'Rule', id: newId() } },
    });

  it('ProjectStore를 거친 쓰기(승인 기록 · 새 규칙 · 부모 해제 · 판정 기록)는 불일치가 아니다', () => {
    const p = project();
    const { requirement, first } = p.open((store) => seed(store));
    const watch = p.open((store) => beginNormWatch(store));
    p.open((store) => {
      approve(store);
      store.rules.detachFromParent(requirement.id, T2);
      store.judgments.record([judgment({ ruleId: first.id })]);
    });
    expect(p.open((store) => verifyNormWatch(store, watch))).toEqual([]);
  });

  it('별도 연결의 변경은 어느 테이블이든 불일치다: 규칙 행 추가 · 규칙 열 변경 · 체인을 맞춘 승인 기록 추가 · 트리거 삭제', () => {
    const p = project();
    const { first } = p.open((store) => seed(store));
    p.open((store) => approve(store));
    const cases: [string, (db: ReturnType<typeof openDatabase>) => void, string][] = [
      [
        '규칙 열',
        (db) =>
          db.prepare(`UPDATE rules SET target_block_ids = '["x"]' WHERE id = ?`).run(first.id),
        'rules',
      ],
      [
        '승인 기록 꼬리',
        (db) => {
          const last = db
            .prepare('SELECT seq, hash FROM approval_log ORDER BY seq DESC LIMIT 1')
            .get() as { seq: number; hash: string };
          const entry = {
            seq: last.seq + 1,
            at: T2,
            action: 'approve' as const,
            actor: human,
            targetRef: { entity: 'Proposal' as const, id: newId() },
            clientId: 'pipe-1',
            detail: {},
            prevHash: last.hash,
          };
          db.prepare(
            'INSERT INTO approval_log (seq, at, action, actor, target_ref, client_id, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(
            entry.seq,
            entry.at,
            entry.action,
            canonicalJson(entry.actor),
            canonicalJson(entry.targetRef),
            entry.clientId,
            canonicalJson(entry.detail),
            entry.prevHash,
            computeApprovalLogHash(entry),
          );
        },
        'approval_log',
      ],
      ['트리거 삭제', (db) => db.exec('DROP TRIGGER judgments_no_update;'), '#schema'],
    ];
    for (const [name, forge, table] of cases) {
      const watch = p.open((store) => beginNormWatch(store));
      p.raw(forge);
      // 그 뒤 오케스트레이터가 다른 기록을 써도 위조가 믿는 상태로 흡수되지 않는다 (열 때 먼저 대조)
      p.open((store) => approve(store));
      const mismatches = p.open((store) => verifyNormWatch(store, watch));
      expect(
        mismatches.map((m) => m.kind),
        name,
      ).toEqual(['untrusted_change']);
      expect(mismatches[0]?.detail, name).toContain(table);
      // 보고한 사건은 다음 감시의 대상이 아니다
      const next = p.open((store) => beginNormWatch(store));
      expect(
        p.open((store) => verifyNormWatch(store, next)),
        name,
      ).toEqual([]);
    }
  });

  it('저장소가 열려 있는 동안 별도 연결이 쓴 위조는 그 연결의 정상 쓰기와 함께 믿는 상태로 흡수되지 않는다 (검토 2회차)', () => {
    const p = project();
    const { first } = p.open((store) => seed(store));
    const watch = p.open((store) => beginNormWatch(store));
    // 열기(장부 대조) → 별도 연결의 위조 커밋 → 같은 연결의 정상 쓰기 → 닫기
    p.open((store) => {
      p.raw((db) => db.prepare("UPDATE requirements SET text = '위조'").run());
      store.judgments.record([judgment({ ruleId: first.id })]);
    });
    const mismatches = p.open((store) => verifyNormWatch(store, watch));
    expect(mismatches.map((m) => m.kind)).toEqual(['untrusted_change']);
    expect(mismatches[0]?.detail).toContain('requirements');
  });

  it('감시 시작 전 단계 사이에 생긴 보고되지 않은 변경도 다음 감시가 잡는다', () => {
    const p = project();
    p.open((store) => seed(store));
    p.open(() => undefined);
    p.raw((db) => db.prepare("UPDATE rules SET title = '바뀐 제목'").run());
    const watch = p.open((store) => beginNormWatch(store));
    expect(p.open((store) => verifyNormWatch(store, watch)).map((m) => m.kind)).toEqual([
      'untrusted_change',
    ]);
  });

  it('미래 시각 판정 기록은 저장 · 트리거가 거부하고, 직접 넣어도 최신 판정으로 보지 않으며 대조가 잡는다', () => {
    const p = project();
    const { first } = p.open((store) => seed(store));
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(() =>
      p.open((store) => store.judgments.record([judgment({ ruleId: first.id, judgedAt: future })])),
    ).toThrow(/미래/);
    const watch = p.open((store) => beginNormWatch(store));
    expect(() =>
      p.raw((db) =>
        db
          .prepare(
            "INSERT INTO judgments (id, rule_id, commit_sha, judged_at, status, runner, cases) VALUES (?, ?, ?, ?, 'pass', 'vitest', '[]')",
          )
          .run(newId(), first.id, COMMIT_A, future),
      ),
    ).toThrow(/미래/);
    p.raw((db) => {
      db.exec('DROP TRIGGER judgments_no_future;');
      db.prepare(
        "INSERT INTO judgments (id, rule_id, commit_sha, judged_at, status, runner, cases) VALUES (?, ?, ?, ?, 'pass', 'vitest', '[]')",
      ).run(newId(), first.id, COMMIT_A, future);
    });
    expect(p.open((store) => store.judgments.latestByRule(first.id))).toBeNull();
    expect(p.open((store) => store.judgments.latestForRules())).toEqual(new Map());
    const kinds = p.open((store) => verifyNormWatch(store, watch)).map((m) => m.kind);
    expect(kinds).toEqual(['untrusted_change', 'future_judgment']);
  });

  it('판정 시각은 밀리초 3자리 UTC로 맞춰 저장하고 그 밖 형식은 DB가 거부한다', () => {
    const p = project();
    const { first } = p.open((store) => seed(store));
    const [saved] = p.open((store) =>
      store.judgments.record([judgment({ ruleId: first.id, judgedAt: '2026-10-16T01:00:00Z' })]),
    );
    expect(saved?.judgedAt).toBe('2026-10-16T01:00:00.000Z');
    expect(() =>
      p.raw((db) =>
        db
          .prepare(
            "INSERT INTO judgments (id, rule_id, commit_sha, judged_at, status, runner, cases) VALUES (?, ?, ?, '2026-10-16T01:00:00Z', 'pass', 'vitest', '[]')",
          )
          .run(newId(), first.id, COMMIT_A),
      ),
    ).toThrow(/CHECK/);
  });
});
