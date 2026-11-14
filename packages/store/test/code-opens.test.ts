// 코드 열람 기록 리포지토리 (M2-01, MET-01 · ADR-084). 실제 SQLite 임시 저장소.
// - 기록은 추가만 한다: 같은 ID 다시 쓰기 · 수정 · 삭제 · `INSERT OR REPLACE`는 거부(리포지토리 + DB 트리거)
// - 형식(프로젝트 루트 기준 상대 경로 · 1 이상 줄 · 화면 ID · 사유)은 스키마로, 직접 쓴 행은 DB CHECK로 막는다
// - 조회는 최신부터 건수 제한까지
// - 집계(`countByReason`)는 전체 기록의 사유별 건수, 고정 순서 · 0건 포함 (M2-02, ADR-088)
import type { CodeOpenRecord } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { ConflictError } from '../src/errors.js';
import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();

const withStore = <T>(fn: (store: ProjectStore) => T): T => {
  const store = openProjectStore(newId(), { home: home() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

const RULE_ID = newId();

const record = (patch: Partial<CodeOpenRecord> = {}): CodeOpenRecord => ({
  id: newId(),
  at: '2026-11-14T09:00:00.000Z',
  reason: 'debugging',
  sourceScreen: 'SCR-03',
  itemRef: { entity: 'Rule', id: RULE_ID },
  file: 'bive-acceptance/RULE-001/health.acc.ts',
  line: 18,
  ...patch,
});

const INSERT =
  'INSERT INTO code_open_records (id, at, reason, source_screen, item_entity, item_id, file, line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

describe('CodeOpenRepository', () => {
  it('record가 저장한 값을 listLatest가 그대로 돌려주고, 시각은 밀리초 3자리 UTC로 맞춘다', () => {
    withStore((store) => {
      const saved = store.codeOpens.record(record({ at: '2026-11-14T09:00:00Z' }));
      expect(saved.at).toBe('2026-11-14T09:00:00.000Z');
      expect(store.codeOpens.listLatest(10)).toEqual([saved]);
    });
  });

  it('listLatest는 최신부터(같은 시각이면 ID가 큰 것 먼저) 건수 제한까지', () => {
    withStore((store) => {
      const old = store.codeOpens.record(record({ at: '2026-11-14T08:00:00.000Z' }));
      const a = store.codeOpens.record(record());
      const b = store.codeOpens.record(record());
      const latest = store.codeOpens.record(record({ at: '2026-11-14T10:00:00.000Z' }));
      expect(store.codeOpens.listLatest(10).map((r) => r.id)).toEqual([
        latest.id,
        b.id,
        a.id,
        old.id,
      ]);
      expect(store.codeOpens.listLatest(2).map((r) => r.id)).toEqual([latest.id, b.id]);
      expect(store.codeOpens.listLatest(0)).toHaveLength(1);
    });
  });

  it('추가만: 같은 ID · 수정 · 삭제 · 덮어쓰기를 거부한다', () => {
    withStore((store) => {
      const saved = store.codeOpens.record(record());
      expect(() => store.codeOpens.record(saved)).toThrow(ConflictError);
      expect(() =>
        store.db.prepare("UPDATE code_open_records SET reason = 'screen_error'").run(),
      ).toThrow(/바꿀 수 없/);
      expect(() => store.db.prepare('DELETE FROM code_open_records').run()).toThrow(/지울 수 없/);
      expect(() =>
        store.db
          .prepare(INSERT.replace('INSERT', 'INSERT OR REPLACE'))
          .run(saved.id, saved.at, 'screen_error', 'SCR-03', 'Rule', RULE_ID, 'a.ts', 1),
      ).toThrow(/덮어쓰기 금지/);
      expect(store.codeOpens.listLatest(10)).toEqual([saved]);
    });
  });

  it.each([
    ['절대 경로', { file: '/etc/passwd' }],
    ['상위 폴더', { file: '../a.ts' }],
    ['중간 상위 폴더', { file: 'a/../../b.ts' }],
    ['역슬래시', { file: 'a\\b.ts' }],
    ['콜론', { file: 'C:a.ts' }],
    ['제어 문자', { file: 'a\u0000.ts' }],
    ['줄 0', { line: 0 }],
    ['화면 ID 아님', { sourceScreen: 'SCR-99' }],
  ])('형식 위반(%s)은 저장하지 않는다', (_label, patch) => {
    withStore((store) => {
      expect(() => store.codeOpens.record(record(patch as Partial<CodeOpenRecord>))).toThrow();
      expect(store.codeOpens.listLatest(10)).toEqual([]);
    });
  });

  it('직접 쓴 행도 DB CHECK가 절대 경로 · 0 이하 줄 · 모르는 사유 · 화면 ID 아님을 막는다', () => {
    withStore((store) => {
      const at = '2026-11-14T09:00:00.000Z';
      const insert = store.db.prepare(INSERT);
      for (const [reason, screen, file, line] of [
        ['debugging', 'SCR-03', '/etc/passwd', 1],
        ['debugging', 'SCR-03', 'a.ts', 0],
        ['curiosity', 'SCR-03', 'a.ts', 1],
        ['debugging', 'rules', 'a.ts', 1],
      ] as const) {
        expect(() => insert.run(newId(), at, reason, screen, 'Rule', RULE_ID, file, line)).toThrow(
          /CHECK/,
        );
      }
      expect(store.codeOpens.listLatest(10)).toEqual([]);
    });
  });
});

describe('CodeOpenRepository.countByReason (M2-02, ADR-088)', () => {
  const ZERO = [
    { reason: 'screen_error', count: 0 },
    { reason: 'info_lacking', count: 0 },
    { reason: 'debugging', count: 0 },
  ];

  it('기록이 없으면 사유 3종 모두 0 (고정 순서)', () => {
    withStore((store) => {
      expect(store.codeOpens.countByReason()).toEqual(ZERO);
    });
  });

  it('사유별로 세고, 순서는 기록 순서와 무관하게 화면 오류 · 정보 부족 · 디버깅', () => {
    withStore((store) => {
      for (const reason of ['debugging', 'debugging', 'info_lacking'] as const) {
        store.codeOpens.record(record({ reason }));
      }
      expect(store.codeOpens.countByReason()).toEqual([
        { reason: 'screen_error', count: 0 },
        { reason: 'info_lacking', count: 1 },
        { reason: 'debugging', count: 2 },
      ]);
    });
  });

  it('조회 건수 제한(listLatest)과 무관하게 전체를 센다', () => {
    withStore((store) => {
      for (let i = 0; i < 1_001; i += 1) {
        store.codeOpens.record(
          record({ reason: i === 0 ? 'screen_error' : 'debugging', line: i + 1 }),
        );
      }
      expect(store.codeOpens.countByReason()).toEqual([
        { reason: 'screen_error', count: 1 },
        { reason: 'info_lacking', count: 0 },
        { reason: 'debugging', count: 1_000 },
      ]);
    });
  });

  it('다른 프로젝트 저장소의 기록은 세지 않는다', () => {
    withStore((store) => store.codeOpens.record(record()));
    withStore((store) => expect(store.codeOpens.countByReason()).toEqual(ZERO));
  });
});
