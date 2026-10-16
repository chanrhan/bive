import { describe, expect, it } from 'vitest';

import { ConflictError, NotFoundError } from '../src/errors.js';
import { openProjectStore, type ProjectStore } from '../src/project-store.js';
import { newId, sampleProject, useTempHome } from './support/temp-home.js';

const home = useTempHome();

const withStore = <T>(projectId: string, fn: (store: ProjectStore) => T): T => {
  const store = openProjectStore(projectId, { home: home() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

describe('projects 테이블 (id · 경로 · 생성 시각)', () => {
  it('생성 → 조회 → 목록', () => {
    const project = sampleProject();
    withStore(project.id, (store) => {
      expect(store.projects.create(project)).toEqual(project);
      expect(store.projects.get(project.id)).toEqual(project);
      expect(store.getProject()).toEqual(project);
      expect(store.projects.list()).toEqual([project]);

      const row = store.db
        .prepare('SELECT id, root_path, created_at FROM projects WHERE id = ?')
        .get(project.id);
      expect(row).toEqual({
        id: project.id,
        root_path: project.rootPath,
        created_at: project.createdAt,
      });
    });
  });

  it('닫았다 다시 열어도 남아 있다', () => {
    const project = sampleProject();
    withStore(project.id, (store) => store.projects.create(project));
    withStore(project.id, (store) => {
      expect(store.projects.get(project.id)).toEqual(project);
    });
  });

  it('수정은 이름 · 경로 · 기준 브랜치만 바꾸고 ID · 생성 시각은 그대로', () => {
    const project = sampleProject();
    withStore(project.id, (store) => {
      store.projects.create(project);
      const updated = store.projects.update(project.id, {
        rootPath: '/work/moved-app',
        baseBranch: 'develop',
      });
      expect(updated).toEqual({ ...project, rootPath: '/work/moved-app', baseBranch: 'develop' });
      expect(store.projects.get(project.id)).toEqual(updated);
      expect(store.projects.update(project.id, {})).toEqual(updated);
    });
  });

  it('수정 값이 잘못되면 거부하고 저장 값은 그대로', () => {
    const project = sampleProject();
    withStore(project.id, (store) => {
      store.projects.create(project);
      expect(() => store.projects.update(project.id, { rootPath: '' })).toThrow();
      expect(() =>
        store.projects.update(project.id, { createdAt: '2030-01-01T00:00:00.000Z' } as never),
      ).toThrow();
      expect(() => store.projects.update(project.id, { id: newId() } as never)).toThrow();
      expect(store.projects.get(project.id)).toEqual(project);
    });
  });

  it('없는 프로젝트 수정은 NotFoundError', () => {
    withStore(newId(), (store) => {
      expect(() => store.projects.update(newId(), { name: 'x' })).toThrow(NotFoundError);
    });
  });

  it('삭제하면 조회 · 목록에서 사라지고, 두 번째 삭제는 false', () => {
    const project = sampleProject();
    withStore(project.id, (store) => {
      store.projects.create(project);
      expect(store.projects.delete(project.id)).toBe(true);
      expect(store.projects.get(project.id)).toBeNull();
      expect(store.projects.list()).toEqual([]);
      expect(store.projects.delete(project.id)).toBe(false);
    });
  });

  it('같은 ID 생성은 ConflictError', () => {
    const project = sampleProject();
    withStore(project.id, (store) => {
      store.projects.create(project);
      expect(() => store.projects.create({ ...project, name: '다른 이름' })).toThrow(ConflictError);
      expect(store.projects.get(project.id)).toEqual(project);
    });
  });

  it('스키마에 맞지 않는 입력은 저장하지 않는다', () => {
    const id = newId();
    withStore(id, (store) => {
      expect(() => store.projects.create(sampleProject({ id: 'not-a-ulid' }))).toThrow();
      expect(() => store.projects.create(sampleProject({ id, rootPath: '' }))).toThrow();
      expect(() => store.projects.create(sampleProject({ id, createdAt: '2026-10-16' }))).toThrow();
      expect(() =>
        store.projects.create({ ...sampleProject({ id }), extra: true } as never),
      ).toThrow();
      expect(store.projects.list()).toEqual([]);
    });
  });
});

describe('트랜잭션 헬퍼', () => {
  it('예외가 나면 트랜잭션 안의 쓰기를 모두 되돌린다', () => {
    const project = sampleProject();
    withStore(project.id, (store) => {
      expect(() =>
        store.transaction(() => {
          store.projects.create(project);
          throw new Error('중단');
        }),
      ).toThrow('중단');
      expect(store.projects.get(project.id)).toBeNull();
    });
  });

  it('성공하면 반환값을 돌려주고 커밋한다', () => {
    const project = sampleProject();
    withStore(project.id, (store) => {
      expect(store.transaction(() => store.projects.create(project).id)).toBe(project.id);
      expect(store.db.inTransaction).toBe(false);
      expect(store.projects.get(project.id)).toEqual(project);
    });
  });

  it('중첩 트랜잭션은 안쪽 실패만 되돌린다', () => {
    const outer = sampleProject();
    const inner = sampleProject();
    withStore(outer.id, (store) => {
      store.transaction(() => {
        store.projects.create(outer);
        expect(() =>
          store.transaction(() => {
            store.projects.create(inner);
            throw new Error('안쪽 중단');
          }),
        ).toThrow('안쪽 중단');
      });
      expect(store.projects.list()).toEqual([outer]);
    });
  });
});
