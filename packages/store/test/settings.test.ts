// 프로젝트 설정 테이블 · 리포지토리 (M1-05, COST-01 · NFR-07, ADR-057).
import { defaultSettings } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();

const T0 = '2026-10-16T00:00:00.000Z';
const T1 = '2026-10-16T01:00:00.000Z';
const human = { kind: 'human' } as const;

const withStore = <T>(projectId: string, fn: (store: ProjectStore) => T): T => {
  const store = openProjectStore(projectId, { home: home() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

describe('settings 테이블 · 리포지토리', () => {
  it('저장한 적이 없으면 기본값이고 행을 만들지 않는다', () => {
    const projectId = newId();
    withStore(projectId, (store) => {
      expect(store.settings.get()).toEqual(defaultSettings(projectId));
      expect(store.db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 0 });
    });
  });

  it('패치를 덮어쓰고(없는 키는 그대로, null은 미설정) 변경 주체 · 시각을 남기며 다시 열어도 같다', () => {
    const projectId = newId();
    const first = withStore(projectId, (store) =>
      store.settings.update(
        {
          run: { maxBudgetUsd: 5, maxTurns: 200 },
          roles: { 'rule-writer': { model: 'test-model', maxBudgetUsd: 1, maxTurns: 20 } },
        },
        { by: human, at: T0 },
      ),
    );
    expect(first.run).toEqual({ maxBudgetUsd: 5, maxTurns: 200 });
    expect(first.roles['rule-writer']).toEqual({
      model: 'test-model',
      maxBudgetUsd: 1,
      maxTurns: 20,
    });
    expect(first.roles['test-writer']).toEqual({ model: null, maxBudgetUsd: null, maxTurns: null });
    expect(first.updatedAt).toBe(T0);
    expect(first.updatedBy).toEqual(human);

    const second = withStore(projectId, (store) =>
      store.settings.update(
        { run: { maxBudgetUsd: 0.01 }, roles: { 'rule-writer': { model: null } } },
        { by: human, at: T1 },
      ),
    );
    expect(second.run).toEqual({ maxBudgetUsd: 0.01, maxTurns: 200 });
    expect(second.roles['rule-writer']).toEqual({ model: null, maxBudgetUsd: 1, maxTurns: 20 });
    expect(second.updatedAt).toBe(T1);

    withStore(projectId, (store) => {
      expect(store.settings.get()).toEqual(second);
      expect(store.db.prepare('SELECT count(*) AS n FROM settings').get()).toEqual({ n: 1 });
      const row = store.db.prepare('SELECT body, updated_by FROM settings').get() as {
        body: string;
        updated_by: string;
      };
      expect(row.updated_by).toBe('{"kind":"human"}');
      // 본문에는 프로젝트 ID · 변경 주체 · 시각이 없다
      expect(Object.keys(JSON.parse(row.body) as object).sort()).toEqual([
        'approvalQueueLimit',
        'autoMode',
        'installAllowlist',
        'provisionalPolicy',
        'roles',
        'run',
      ]);
    });
  });

  it('스키마 위반 · 에이전트 주체는 저장하지 않는다', () => {
    const projectId = newId();
    withStore(projectId, (store) => {
      expect(() =>
        store.settings.update({ run: { maxBudgetUsd: 0 } }, { by: human, at: T0 }),
      ).toThrow();
      expect(() =>
        store.settings.update({ roles: { implementer: { maxTurns: 1.5 } } }, { by: human, at: T0 }),
      ).toThrow();
      expect(() =>
        store.settings.update(
          { run: { maxTurns: 10 } },
          // @ts-expect-error 에이전트 주체는 타입에서도 막는다
          { by: { kind: 'agent', role: 'implementer' }, at: T0 },
        ),
      ).toThrow();
      expect(store.settings.get()).toEqual(defaultSettings(projectId));
    });
  });

  it('행은 1개만 둘 수 있다 (singleton = 1)', () => {
    withStore(newId(), (store) => {
      expect(() =>
        store.db
          .prepare(
            "INSERT INTO settings (singleton, body, updated_at, updated_by) VALUES (2, '{}', 'x', '{}')",
          )
          .run(),
      ).toThrow(/CHECK/);
    });
  });
});
