import { describe, expect, it } from 'vitest';

import { ConflictError, NotFoundError } from '../src/errors.js';
import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import type { RequirementCreateInput } from '../src/repositories/requirement-repository.js';
import { newId, useTempHome } from './support/temp-home.js';

const home = useTempHome();

const T0 = '2026-10-16T00:00:00.000Z';
const T1 = '2026-10-16T01:00:00.000Z';
const T2 = '2026-10-16T02:00:00.000Z';
const human = { kind: 'human' } as const;
const ruleWriter = { kind: 'agent', role: 'rule-writer' } as const;

const withStore = <T>(fn: (store: ProjectStore) => T, projectId = newId()): T => {
  const store = openProjectStore(projectId, { home: home() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

const input = (overrides: Partial<RequirementCreateInput> = {}): RequirementCreateInput => ({
  id: newId(),
  text: '사용자는 이메일로 가입할 수 있다',
  author: human,
  normState: 'approved',
  createdAt: T0,
  ...overrides,
});

describe('requirements 테이블 · 리포지토리', () => {
  it('생성: 표시 ID REQ-001부터, 수정 기록 = 생성 기록, 삭제 시각 없음', () => {
    withStore((store) => {
      const first = input();
      const created = store.requirements.create(first);
      expect(created).toEqual({
        ...first,
        displayId: 'REQ-001',
        unrulable: null,
        updatedAt: T0,
        updatedBy: human,
        deletedAt: null,
      });
      expect(store.requirements.get(first.id)).toEqual(created);
      expect(store.requirements.create(input()).displayId).toBe('REQ-002');

      const row = store.db
        .prepare('SELECT author, updated_by, deleted_at FROM requirements WHERE id = ?')
        .get(first.id);
      expect(row).toEqual({
        author: '{"kind":"human"}',
        updated_by: '{"kind":"human"}',
        deleted_at: null,
      });
    });
  });

  it('에이전트 주체도 기록한다 (권한 판단은 호출한 쪽)', () => {
    withStore((store) => {
      const created = store.requirements.create(input({ author: ruleWriter }));
      expect(created.author).toEqual(ruleWriter);
      expect(store.requirements.get(created.id)?.updatedBy).toEqual(ruleWriter);
    });
  });

  it('닫았다 다시 열어도 남아 있고 순번도 이어진다', () => {
    const projectId = newId();
    const first = withStore((store) => store.requirements.create(input()), projectId);
    withStore((store) => {
      expect(store.requirements.get(first.id)).toEqual(first);
      expect(store.requirements.create(input()).displayId).toBe('REQ-002');
    }, projectId);
  });

  it('수정: 본문 · 수정 시각 · 수정 주체만 바뀐다', () => {
    withStore((store) => {
      const created = store.requirements.create(input({ author: ruleWriter }));
      const updated = store.requirements.update(
        created.id,
        { text: '사용자는 이메일과 비밀번호로 가입할 수 있다' },
        { by: human, at: T1 },
      );
      expect(updated).toEqual({
        ...created,
        text: '사용자는 이메일과 비밀번호로 가입할 수 있다',
        updatedAt: T1,
        updatedBy: human,
      });
      expect(store.requirements.get(created.id)).toEqual(updated);
    });
  });

  it('소프트 삭제: 행은 남고 deletedAt이 채워지며 목록에서 빠진다', () => {
    withStore((store) => {
      const a = store.requirements.create(input());
      const b = store.requirements.create(input());
      const deleted = store.requirements.softDelete(a.id, { by: human, at: T2 });
      expect(deleted).toEqual({ ...a, updatedAt: T2, updatedBy: human, deletedAt: T2 });
      expect(store.requirements.get(a.id)).toEqual(deleted);
      expect(store.requirements.list()).toEqual([b]);
      const count = store.db.prepare('SELECT count(*) AS n FROM requirements').get();
      expect(count).toEqual({ n: 2 });
    });
  });

  it('삭제된 번호는 다시 쓰지 않는다', () => {
    withStore((store) => {
      const a = store.requirements.create(input());
      store.requirements.softDelete(a.id, { by: human, at: T1 });
      expect(store.requirements.create(input()).displayId).toBe('REQ-002');
      expect(store.sequences.last('REQ')).toBe(2);
    });
  });

  it('목록은 표시 ID 순 (REQ-999 < REQ-1000)', () => {
    withStore((store) => {
      store.db
        .prepare("INSERT INTO display_id_sequences (prefix, last_seq) VALUES ('REQ', 998)")
        .run();
      const ids = [input(), input(), input()].map(
        (value) => store.requirements.create(value).displayId,
      );
      expect(ids).toEqual(['REQ-999', 'REQ-1000', 'REQ-1001']);
      expect(store.requirements.list().map((r) => r.displayId)).toEqual(ids);
    });
  });

  it('없는 ID는 NotFoundError, 삭제된 것의 수정 · 재삭제는 ConflictError', () => {
    withStore((store) => {
      expect(store.requirements.get(newId())).toBeNull();
      expect(() =>
        store.requirements.update(newId(), { text: '새 본문' }, { by: human, at: T1 }),
      ).toThrow(NotFoundError);
      expect(() => store.requirements.softDelete(newId(), { by: human, at: T1 })).toThrow(
        NotFoundError,
      );

      const created = store.requirements.create(input());
      const deleted = store.requirements.softDelete(created.id, { by: human, at: T1 });
      expect(() => store.requirements.softDelete(created.id, { by: human, at: T2 })).toThrow(
        ConflictError,
      );
      expect(() =>
        store.requirements.update(created.id, { text: '새 본문' }, { by: human, at: T2 }),
      ).toThrow(ConflictError);
      expect(store.requirements.get(created.id)).toEqual(deleted);
    });
  });

  it('같은 ID 재생성은 ConflictError이고 순번을 소비하지 않는다', () => {
    withStore((store) => {
      const first = input();
      store.requirements.create(first);
      expect(() => store.requirements.create({ ...first, text: '다른 본문' })).toThrow(
        ConflictError,
      );
      expect(store.sequences.last('REQ')).toBe(1);
      expect(store.requirements.create(input()).displayId).toBe('REQ-002');
    });
  });

  it('스키마 위반은 거부하고 저장하지 않는다', () => {
    withStore((store) => {
      expect(() => store.requirements.create(input({ text: '' }))).toThrow();
      expect(() => store.requirements.create(input({ id: 'not-a-ulid' }))).toThrow();
      expect(() => store.requirements.create(input({ createdAt: '2026-10-16' }))).toThrow();
      expect(() =>
        store.requirements.create({ ...input(), displayId: 'REQ-777' } as RequirementCreateInput),
      ).toThrow();
      expect(store.requirements.list()).toEqual([]);
      expect(store.sequences.last('REQ')).toBe(0);

      const created = store.requirements.create(input());
      expect(() =>
        store.requirements.update(created.id, { text: '' }, { by: human, at: T1 }),
      ).toThrow();
      expect(() =>
        store.requirements.update(created.id, { text: '본문' }, { by: human, at: 'yesterday' }),
      ).toThrow();
      expect(() =>
        store.requirements.update(created.id, { text: '본문', author: ruleWriter } as never, {
          by: human,
          at: T1,
        }),
      ).toThrow();
      expect(store.requirements.get(created.id)).toEqual(created);
    });
  });

  it('DB 제약: 표시 ID 형식 · 규범 상태 · 주체 JSON', () => {
    withStore((store) => {
      const insert = (values: Record<string, unknown>): void => {
        store.db
          .prepare(
            `INSERT INTO requirements (id, display_id, text, author, norm_state, unrulable_reason,
             created_at, updated_at, updated_by, deleted_at)
             VALUES (@id, @display_id, @text, @author, @norm_state, NULL, @t, @t, @author, NULL)`,
          )
          .run({
            id: newId(),
            display_id: 'REQ-001',
            text: '본문',
            author: '{"kind":"human"}',
            norm_state: 'approved',
            t: T0,
            ...values,
          });
      };
      expect(() => insert({ display_id: 'RULE-001' })).toThrow(/CHECK/);
      expect(() => insert({ norm_state: 'pending' })).toThrow(/CHECK/);
      expect(() => insert({ author: 'human' })).toThrow(/CHECK/);
      expect(() => insert({ text: '' })).toThrow(/CHECK/);
      insert({});
      expect(() => insert({})).toThrow(/UNIQUE/);
    });
  });
});

describe('표시 ID 순번', () => {
  it('접두별로 따로 1부터 증가한다', () => {
    withStore((store) => {
      expect(store.sequences.last('RULE')).toBe(0);
      expect(store.sequences.nextDisplayId('RULE')).toBe('RULE-001');
      expect(store.sequences.next('REQ')).toBe(1);
      expect(store.sequences.next('RULE')).toBe(2);
      expect(() => store.sequences.next('BAD' as never)).toThrow();
    });
  });

  it('트랜잭션이 되돌려지면 순번도 되돌려진다', () => {
    withStore((store) => {
      expect(() =>
        store.transaction(() => {
          store.requirements.create(input());
          throw new Error('중단');
        }),
      ).toThrow('중단');
      expect(store.sequences.last('REQ')).toBe(0);
      expect(store.requirements.list()).toEqual([]);
    });
  });
});
