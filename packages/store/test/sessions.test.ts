// 세션 · 도구 호출 기록 리포지토리 (M1-14, RUN-04 · NFR-02 · ADR-066). 실제 SQLite 임시 저장소.
import { type Author, RUN_STEP_PLANS, STEP_ROLES, type Step } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { ConflictError, NotFoundError } from '../src/errors.js';
import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();
const T0 = '2026-10-16T00:00:00.000Z';
const T1 = '2026-10-16T01:00:00.000Z';
const human = { kind: 'human' } as const satisfies Author;

const seedRun = (store: ProjectStore) => {
  const requirement = store.requirements.create({
    id: newId(),
    text: '요구사항',
    author: human,
    normState: 'approved',
    createdAt: T0,
  });
  const rule = store.rules.create({
    id: newId(),
    title: '규칙',
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
  return store.runs.create({
    id: newId(),
    type: 'A',
    targetRuleIds: [rule.id],
    currentStep: 'approval',
    baseBranch: 'main',
    budgetSnapshot: {
      run: { maxBudgetUsd: 5, maxTurns: 200 },
      roles: { 'test-writer': { maxBudgetUsd: 2, maxTurns: 100 } },
    },
    modelSnapshot: { 'test-writer': 'model-a' },
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
};

const stepOf = (steps: readonly Step[], kind: Step['kind']): Step => {
  const step = steps.find((s) => s.kind === kind);
  if (step === undefined) throw new Error(`단계 없음: ${kind}`);
  return step;
};

const withStore = <T>(fn: (store: ProjectStore) => T): T => {
  const store = openProjectStore(newId(), { home: home() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

describe('sessions', () => {
  it('시작 → init → 종료를 기록하고, 역할별 세션 수 · 도구 목록(manifest)을 돌려준다', () => {
    withStore((store) => {
      const { run, steps } = seedRun(store);
      const id = newId();
      const started = store.sessions.start({
        id,
        runId: run.id,
        stepId: stepOf(steps, 'test_writing').id,
        role: 'test-writer',
        model: 'model-a',
        workDir: '/tmp/w',
        startedAt: T0,
      });
      expect(started).toMatchObject({ endReason: null, sdkSessionId: null, tools: [] });
      expect(store.sessions.countByRunRole(run.id, 'test-writer')).toBe(1);
      expect(store.sessions.countByRunRole(run.id, 'implementer')).toBe(0);
      expect(store.sessions.manifest(run.id)).toEqual([]);

      store.sessions.recordInit(id, {
        sdkSessionId: 's-1',
        tools: ['read_file'],
        mcpServers: ['bive'],
      });
      expect(store.sessions.manifest(run.id)).toEqual([
        { role: 'test-writer', tools: ['read_file'], mcpServerCount: 1 },
      ]);
      const ended = store.sessions.end(id, {
        endReason: 'success',
        totalCostUsd: 0.04,
        numTurns: 2,
        modelUsage: {
          'model-a': {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 4,
            costUsd: 0.04,
          },
        },
        endedAt: T1,
      });
      expect(ended).toMatchObject({ endReason: 'success', totalCostUsd: 0.04, endedAt: T1 });
      expect(store.sessions.listByRun(run.id)).toEqual([ended]);
      // 끝난 세션은 바뀌지 않는다 (리포지토리 · 트리거)
      expect(() => store.sessions.end(id, { endReason: 'aborted', endedAt: T1 })).toThrow(
        ConflictError,
      );
      expect(() =>
        store.db.prepare('UPDATE sessions SET error = ? WHERE id = ?').run('x', id),
      ).toThrow(/끝난 세션/);
      expect(() => store.db.prepare('DELETE FROM sessions').run()).toThrow(/지울 수 없/);
    });
  });

  it('단계 시도의 실행 · 역할과 다르면 거부한다', () => {
    withStore((store) => {
      const { run, steps } = seedRun(store);
      const base = { id: newId(), runId: run.id, model: 'm', workDir: '/w', startedAt: T0 };
      expect(() =>
        store.sessions.start({
          ...base,
          stepId: stepOf(steps, 'implementation').id,
          role: 'test-writer',
        }),
      ).toThrow(ConflictError);
      expect(() => store.sessions.start({ ...base, stepId: newId(), role: 'test-writer' })).toThrow(
        NotFoundError,
      );
    });
  });

  it('실행 밖 세션(규칙 작성)은 실행 · 단계 없이 요구사항을 가리킨다', () => {
    withStore((store) => {
      const { run } = seedRun(store);
      const requirementId = store.requirements.list()[0]?.id ?? '';
      const id = newId();
      store.sessions.start({
        id,
        runId: null,
        stepId: null,
        requirementId,
        role: 'rule-writer',
        model: 'model-a',
        workDir: '/w',
        startedAt: T0,
      });
      store.sessions.appendToolCall({
        id: newId(),
        runId: null,
        sessionId: id,
        at: T0,
        role: 'rule-writer',
        name: 'propose_rule',
        argsSummary: '{}',
        status: 'ok',
        reason: null,
        durationMs: 1,
      });
      expect(store.sessions.listByRequirement(requirementId).map((s) => s.id)).toEqual([id]);
      expect(store.sessions.toolCallsBySession(id)).toHaveLength(1);
      expect(store.sessions.listByRun(run.id)).toEqual([]);
      // 실행 · 단계는 둘 다 있거나 둘 다 없다 (스키마 · CHECK)
      expect(() =>
        store.sessions.start({
          id: newId(),
          runId: run.id,
          stepId: null,
          role: 'rule-writer',
          model: 'm',
          workDir: '/w',
          startedAt: T0,
        }),
      ).toThrow();
    });
  });

  it('도구 호출은 세션 안 순번을 붙여 추가만 한다', () => {
    withStore((store) => {
      const { run, steps } = seedRun(store);
      const sessionId = newId();
      store.sessions.start({
        id: sessionId,
        runId: run.id,
        stepId: stepOf(steps, 'test_writing').id,
        role: 'test-writer',
        model: 'model-a',
        workDir: '/w',
        startedAt: T0,
      });
      const call = (name: string, status: 'ok' | 'denied', runId: string = run.id) =>
        store.sessions.appendToolCall({
          id: newId(),
          runId,
          sessionId,
          at: T0,
          role: 'test-writer',
          name,
          argsSummary: 'a.ts',
          status,
          reason: status === 'denied' ? 'path_denied' : null,
          durationMs: 3,
        });
      expect(call('read_file', 'ok').seq).toBe(0);
      expect(call('write_file', 'denied').seq).toBe(1);
      expect(
        store.sessions.toolCalls(run.id).map((c) => [c.seq, c.name, c.status, c.reason]),
      ).toEqual([
        [0, 'read_file', 'ok', null],
        [1, 'write_file', 'denied', 'path_denied'],
      ]);
      expect(() => call('x', 'ok', newId())).toThrow(ConflictError);
      expect(() => store.db.prepare('UPDATE tool_calls SET name = ?').run('y')).toThrow(
        /바꿀 수 없/,
      );
      expect(() => store.db.prepare('DELETE FROM tool_calls').run()).toThrow(/지울 수 없/);
    });
  });
});
