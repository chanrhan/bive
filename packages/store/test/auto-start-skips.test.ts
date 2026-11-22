// 실행 자동 시작 생략 기록 리포지토리 (M7-05 #217, ADR-100 B⑤ · A12, ADR-107). 실제 SQLite 임시 저장소.
import { describe, expect, it } from 'vitest';

import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();

const T0 = '2026-11-21T00:00:00.000Z';

const withStore = <T>(fn: (store: ProjectStore) => T): T => {
  const store = openProjectStore(newId(), { home: home() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

describe('auto_start_skips 리포지토리', () => {
  it('세션마다 한 번 남기고 그대로 읽는다. 없으면 null, 같은 세션은 다시 남기지 않는다', () => {
    withStore((store) => {
      const session = newId();
      expect(store.autoStartSkips.get(session)).toBeNull();
      const saved = store.autoStartSkips.record({
        sessionId: session,
        reason: 'settings_incomplete',
        missing: ['roles.implementer.model', 'run.maxTurns'],
        skippedAt: T0,
      });
      expect(store.autoStartSkips.get(session)).toEqual(saved);
      expect(saved).toEqual({
        sessionId: session,
        reason: 'settings_incomplete',
        missing: ['roles.implementer.model', 'run.maxTurns'],
        skippedAt: T0,
      });
      expect(() =>
        store.autoStartSkips.record({
          sessionId: session,
          reason: 'project_daily_budget_unset',
          missing: [],
          skippedAt: T0,
        }),
      ).toThrow(/덮어쓰기 금지/);
      expect(store.autoStartSkips.get(session)?.reason).toBe('settings_incomplete');
    });
  });

  it('형식 위반은 남기지 않고, 저장소 밖에서 깨진 행은 null로 읽는다', () => {
    withStore((store) => {
      const session = newId();
      expect(() =>
        store.autoStartSkips.record({
          sessionId: session,
          reason: 'closed' as never,
          missing: [],
          skippedAt: T0,
        }),
      ).toThrow();
      expect(() =>
        store.autoStartSkips.record({
          sessionId: session,
          reason: 'settings_incomplete',
          missing: ['roles.unknown.model' as never],
          skippedAt: T0,
        }),
      ).toThrow();
      expect(store.autoStartSkips.get(session)).toBeNull();
      // 설정 항목 배열이지만 알 수 없는 항목 (DB CHECK는 배열만 본다)
      store.db
        .prepare(
          "INSERT INTO auto_start_skips (session_id, reason, missing, skipped_at) VALUES (?, 'settings_incomplete', '[\"x\"]', ?)",
        )
        .run(session, T0);
      expect(store.autoStartSkips.get(session)).toBeNull();
    });
  });
});
