// 규칙 작성 시도 기록 리포지토리 (M3-26 #206, NRM-02 · NFR-03 · ADR-099). 실제 SQLite 임시 저장소.
import type { Author } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { ConflictError, NotFoundError } from '../src/errors.js';
import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();
const T0 = '2026-11-21T00:00:00.000Z';
const T1 = '2026-11-21T00:01:00.000Z';
const T2 = '2026-11-21T00:02:00.000Z';
const human = { kind: 'human' } as const satisfies Author;

const withStore = <T>(fn: (store: ProjectStore) => T): T => {
  const store = openProjectStore(newId(), { home: home() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

const seedRequirement = (store: ProjectStore) =>
  store.requirements.create({
    id: newId(),
    text: '요구사항',
    author: human,
    normState: 'approved',
    createdAt: T0,
  });

const startSession = (store: ProjectStore, id: string, requirementId: string, at = T0) =>
  store.sessions.start({
    id,
    runId: null,
    stepId: null,
    requirementId,
    role: 'rule-writer',
    model: 'm',
    workDir: '/w',
    startedAt: at,
  });

describe('rule_writer_requests', () => {
  it('상태를 시도 · 세션 행에서 만든다: 대기 → 진행 중 → 끝남(종료 사유 · 오류), 생략(사유 · 설명 · 항목)', () => {
    withStore((store) => {
      const a = seedRequirement(store);
      const b = seedRequirement(store);
      const id = newId();
      store.ruleWriterRequests.create({ id, requirementId: a.id, requestedAt: T0 });
      expect(store.ruleWriterRequests.latest(a.id)).toMatchObject({
        id,
        state: 'queued',
        skipReason: null,
        endReason: null,
        error: null,
        endedAt: null,
      });
      startSession(store, id, a.id);
      expect(store.ruleWriterRequests.latest(a.id)?.state).toBe('running');
      store.sessions.end(id, {
        endReason: 'guard_violation',
        error: '세션 가드: 허용되지 않은 플러그인 x',
        endedAt: T1,
      });
      expect(store.ruleWriterRequests.latest(a.id)).toEqual({
        id,
        requirementId: a.id,
        requestedAt: T0,
        state: 'ended',
        skipReason: null,
        missing: [],
        endReason: 'guard_violation',
        error: '세션 가드: 허용되지 않은 플러그인 x',
        endedAt: T1,
      });

      const skipped = newId();
      store.ruleWriterRequests.create({
        id: skipped,
        requirementId: b.id,
        requestedAt: T0,
        skip: {
          reason: 'settings_incomplete',
          detail: '예산 · 모델 미설정',
          missing: ['run.maxBudgetUsd', 'roles.rule-writer.model'],
          at: T0,
        },
      });
      expect(store.ruleWriterRequests.latestAll()).toEqual(
        [
          store.ruleWriterRequests.latest(a.id),
          {
            id: skipped,
            requirementId: b.id,
            requestedAt: T0,
            state: 'skipped',
            skipReason: 'settings_incomplete',
            missing: ['run.maxBudgetUsd', 'roles.rule-writer.model'],
            endReason: null,
            error: '예산 · 모델 미설정',
            endedAt: T0,
          },
        ].sort((x, y) => ((x?.requirementId ?? '') < (y?.requirementId ?? '') ? -1 : 1)),
      );
    });
  });

  it('가장 최근 시도는 받은 시각 → ID 순의 마지막이고, 0011 전에 저장된 규칙 작성 세션(시도 행 없음)도 시도로 읽는다', () => {
    withStore((store) => {
      const requirement = seedRequirement(store);
      const legacy = newId();
      startSession(store, legacy, requirement.id, T0);
      store.sessions.end(legacy, { endReason: 'error_during_execution', error: 'x', endedAt: T0 });
      expect(store.ruleWriterRequests.latest(requirement.id)).toMatchObject({
        id: legacy,
        state: 'ended',
        endReason: 'error_during_execution',
      });
      const retry = newId();
      store.ruleWriterRequests.create({
        id: retry,
        requirementId: requirement.id,
        requestedAt: T2,
      });
      expect(store.ruleWriterRequests.listByRequirement(requirement.id).map((a) => a.id)).toEqual([
        legacy,
        retry,
      ]);
      expect(store.ruleWriterRequests.latest(requirement.id)?.id).toBe(retry);
      expect(store.ruleWriterRequests.latestAll().map((a) => a.id)).toEqual([retry]);
      // 실행 세션은 시도가 아니다
      expect(store.ruleWriterRequests.latest(newId())).toBeNull();
    });
  });

  it('생략은 대기 중인 시도에 한 번만: 없는 시도 · 이미 생략 · 세션을 연 시도는 거부, 행은 바꾸거나 지울 수 없다', () => {
    withStore((store) => {
      const requirement = seedRequirement(store);
      const id = newId();
      store.ruleWriterRequests.create({ id, requirementId: requirement.id, requestedAt: T0 });
      expect(() =>
        store.ruleWriterRequests.create({ id, requirementId: requirement.id, requestedAt: T0 }),
      ).toThrow(ConflictError);
      expect(() =>
        store.ruleWriterRequests.skip(newId(), { reason: 'closed', detail: null, at: T1 }),
      ).toThrow(NotFoundError);
      store.ruleWriterRequests.skip(id, { reason: 'requirement_unavailable', detail: '', at: T1 });
      expect(store.ruleWriterRequests.latest(requirement.id)).toMatchObject({
        state: 'skipped',
        skipReason: 'requirement_unavailable',
        error: null,
        endedAt: T1,
      });
      expect(() =>
        store.ruleWriterRequests.skip(id, { reason: 'closed', detail: null, at: T2 }),
      ).toThrow(ConflictError);

      const started = newId();
      store.ruleWriterRequests.create({
        id: started,
        requirementId: requirement.id,
        requestedAt: T1,
      });
      startSession(store, started, requirement.id, T1);
      expect(() =>
        store.ruleWriterRequests.skip(started, { reason: 'closed', detail: null, at: T2 }),
      ).toThrow(ConflictError);

      expect(() =>
        store.db.prepare("UPDATE rule_writer_requests SET skip_detail = 'y' WHERE id = ?").run(id),
      ).toThrow(/바꿀 수 없/);
      expect(() =>
        store.db
          .prepare('UPDATE rule_writer_requests SET requested_at = ? WHERE id = ?')
          .run(T2, started),
      ).toThrow(/식별 정보/);
      expect(() => store.db.prepare('DELETE FROM rule_writer_requests').run()).toThrow(
        /지울 수 없/,
      );
      expect(() =>
        store.db
          .prepare(
            "INSERT OR REPLACE INTO rule_writer_requests (id, requirement_id, requested_at, missing) VALUES (?, ?, ?, '[]')",
          )
          .run(id, requirement.id, T0),
      ).toThrow(/덮어쓰기 금지/);
    });
  });

  it('재기동 정리: 세션도 생략도 없는 시도만 closed로 끝내고 그 ID를 돌려준다', () => {
    withStore((store) => {
      const requirement = seedRequirement(store);
      const pending = newId();
      const running = newId();
      store.ruleWriterRequests.create({
        id: running,
        requirementId: requirement.id,
        requestedAt: T0,
      });
      startSession(store, running, requirement.id);
      store.ruleWriterRequests.create({
        id: pending,
        requirementId: requirement.id,
        requestedAt: T1,
      });
      expect(store.ruleWriterRequests.closePending('오케스트레이터가 비정상 종료됨', T2)).toEqual([
        pending,
      ]);
      expect(store.ruleWriterRequests.listByRequirement(requirement.id)).toEqual([
        expect.objectContaining({ id: running, state: 'running' }),
        expect.objectContaining({
          id: pending,
          state: 'skipped',
          skipReason: 'closed',
          error: '오케스트레이터가 비정상 종료됨',
          endedAt: T2,
        }),
      ]);
      expect(store.ruleWriterRequests.closePending('x', T2)).toEqual([]);
    });
  });
});
