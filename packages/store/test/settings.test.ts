// 프로젝트 설정 테이블 · 리포지토리 (M1-05, COST-01 · NFR-07, ADR-057).
import { defaultSettings } from '@bive/shared';
import { describe, expect, it, vi } from 'vitest';

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
        'ide',
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

  it('IDE 선택(ADR-087): 기본 미설정, 패치로 고르고 다시 열어도 같으며 IDE 키가 없는 이전 본문은 미설정으로 읽는다', () => {
    const projectId = newId();
    withStore(projectId, (store) => {
      expect(store.settings.get().ide).toBeNull();
      // M2-03 이전에 저장된 본문(ide 키 없음)
      store.settings.update({ run: { maxTurns: 10 } }, { by: human, at: T0 });
      const row = store.db.prepare('SELECT body FROM settings').get() as { body: string };
      const legacy = JSON.parse(row.body) as Record<string, unknown>;
      delete legacy.ide;
      store.db.prepare('UPDATE settings SET body = ?').run(JSON.stringify(legacy));
      expect(store.settings.get().ide).toBeNull();
      const saved = store.settings.update({ ide: { kind: 'cursor' } }, { by: human, at: T1 });
      expect(saved.ide).toEqual({ kind: 'cursor' });
      expect(saved.run.maxTurns).toBe(10);
      expect(() =>
        store.settings.update(
          { ide: { kind: 'custom', template: 'https://example.com/{path}?l={line}' } },
          { by: human, at: T1 },
        ),
      ).toThrow();
    });
    withStore(projectId, (store) => {
      expect(store.settings.get().ide).toEqual({ kind: 'cursor' });
    });
  });

  it.each([
    [
      '예전에 받던 중첩 틀',
      { kind: 'custom', template: 'subl://open?url=file:///{path}&line={line}' },
    ],
    ['직접 고친 금지 틀', { kind: 'custom', template: 'file:///{path}#{line}' }],
    ['모르는 종류', { kind: 'idea' }],
  ])(
    '저장된 IDE 선택이 허용 범위가 아니면(%s) 미설정으로 읽고 나머지 설정은 그대로이며, 다시 고르면 저장된다 (#184 검토 1회차)',
    (_label, ide) => {
      const projectId = newId();
      withStore(projectId, (store) => {
        const saved = store.settings.update(
          { run: { maxBudgetUsd: 5, maxTurns: 200 }, ide: { kind: 'vscode' } },
          { by: human, at: T0 },
        );
        const row = store.db.prepare('SELECT body FROM settings').get() as { body: string };
        const body = JSON.parse(row.body) as Record<string, unknown>;
        body.ide = ide;
        store.db.prepare('UPDATE settings SET body = ?').run(JSON.stringify(body));
        const read = store.settings.get();
        expect(read.ide).toBeNull();
        expect(read).toEqual({ ...saved, ide: null });
        const next = store.settings.update({ ide: { kind: 'cursor' } }, { by: human, at: T1 });
        expect(next.ide).toEqual({ kind: 'cursor' });
        expect(next.run).toEqual({ maxBudgetUsd: 5, maxTurns: 200 });
        expect(store.settings.get().ide).toEqual({ kind: 'cursor' });
      });
    },
  );

  it('잘못 저장된 IDE 선택의 경고는 같은 프로젝트 · 같은 값이면 조회가 몇 번이든 한 번이고, 값이 바뀌면 다시 한 번이며, 저장된 값을 싣지 않은 한 줄이다 (M2-11 #190 · ADR-094)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const projectId = newId();
      const setIde = (store: ProjectStore, ide: unknown): void => {
        const row = store.db.prepare('SELECT body FROM settings').get() as { body: string };
        const body = JSON.parse(row.body) as Record<string, unknown>;
        body.ide = ide;
        store.db.prepare('UPDATE settings SET body = ?').run(JSON.stringify(body));
      };
      withStore(projectId, (store) => {
        store.settings.update({ ide: { kind: 'vscode' } }, { by: human, at: T0 });
        setIde(store, { kind: 'custom', template: 'file:///{path}\n가짜 로그 줄\u202e{line}' });
        for (let i = 0; i < 3; i += 1) expect(store.settings.get().ide).toBeNull();
        expect(warn.mock.calls).toEqual([
          [`설정의 IDE 선택이 허용 범위가 아니라 미설정으로 읽음 (프로젝트 ${projectId})`],
        ]);
        setIde(store, { kind: 'idea' });
        for (let i = 0; i < 3; i += 1) expect(store.settings.get().ide).toBeNull();
        expect(warn).toHaveBeenCalledTimes(2);
      });
      // 다시 열어도(같은 프로세스) 같은 값이면 찍지 않는다
      withStore(projectId, (store) => expect(store.settings.get().ide).toBeNull());
      expect(warn).toHaveBeenCalledTimes(2);
      for (const [line] of warn.mock.calls) {
        expect(String(line)).not.toMatch(/[\p{Cc}\p{Cf}]/u);
        expect(String(line)).not.toContain('file:');
      }
    } finally {
      warn.mockRestore();
    }
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
