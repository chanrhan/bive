import { existsSync, rmSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ConflictError, NotFoundError } from '../src/errors.js';
import { bivePaths } from '../src/paths.js';
import { openProjectStore } from '../src/project-store.js';
import {
  listRegisteredProjects,
  openRegistry,
  registerProject,
  unregisterProject,
} from '../src/registry.js';
import { sampleProject, useTempHome } from './support/temp-home.js';

const home = useTempHome();
const now = () => '2026-10-16T01:00:00.000Z';

describe('프로젝트 등록부 (registry.db, 프로젝트별 DB와 분리)', () => {
  it('등록하면 프로젝트별 DB에 행을, 등록부에 ID만 남긴다', () => {
    const project = sampleProject();
    expect(registerProject(project, { home: home(), now })).toEqual(project);

    const paths = bivePaths(home());
    expect(existsSync(paths.registryDb)).toBe(true);
    expect(existsSync(paths.projectDb(project.id))).toBe(true);

    const registry = openRegistry({ home: home() });
    try {
      expect(registry.entries.list()).toEqual([{ projectId: project.id, registeredAt: now() }]);
      const columns = registry.db
        .prepare("SELECT name FROM pragma_table_info('registered_projects') ORDER BY cid")
        .all();
      expect(columns).toEqual([{ name: 'project_id' }, { name: 'registered_at' }]);
    } finally {
      registry.close();
    }

    const store = openProjectStore(project.id, { home: home(), create: false });
    try {
      expect(store.getProject()).toEqual(project);
    } finally {
      store.close();
    }
  });

  it('목록은 등록 시각 순으로 프로젝트별 DB의 내용을 돌려준다', () => {
    const a = sampleProject({ name: 'A' });
    const b = sampleProject({ name: 'B' });
    registerProject(b, { home: home(), now: () => '2026-10-16T02:00:00.000Z' });
    registerProject(a, { home: home(), now: () => '2026-10-16T01:00:00.000Z' });
    expect(listRegisteredProjects({ home: home() })).toEqual([a, b]);
  });

  it('이미 등록된 ID는 ConflictError', () => {
    const project = sampleProject();
    registerProject(project, { home: home(), now });
    expect(() => registerProject(project, { home: home(), now })).toThrow(ConflictError);
  });

  it('등록부 추가 전에 멈춘 등록은 같은 내용이면 이어서 끝내고, 다르면 거부한다', () => {
    const project = sampleProject();
    const store = openProjectStore(project.id, { home: home() });
    store.projects.create(project);
    store.close();

    expect(() => registerProject({ ...project, name: '다른 이름' }, { home: home(), now })).toThrow(
      ConflictError,
    );
    expect(listRegisteredProjects({ home: home() })).toEqual([]);

    registerProject(project, { home: home(), now });
    expect(listRegisteredProjects({ home: home() })).toEqual([project]);
  });

  it('등록 해제는 등록부 항목만 지우고 프로젝트별 DB는 남긴다', () => {
    const project = sampleProject();
    registerProject(project, { home: home(), now });
    expect(unregisterProject(project.id, { home: home() })).toBe(true);
    expect(unregisterProject(project.id, { home: home() })).toBe(false);
    expect(listRegisteredProjects({ home: home() })).toEqual([]);
    expect(existsSync(bivePaths(home()).projectDb(project.id))).toBe(true);
  });

  it('등록부에 있는데 프로젝트별 DB가 없으면 숨기지 않고 NotFoundError', () => {
    const project = sampleProject();
    registerProject(project, { home: home(), now });
    rmSync(bivePaths(home()).projectDir(project.id), { recursive: true, force: true });
    expect(() => listRegisteredProjects({ home: home() })).toThrow(NotFoundError);
    expect(existsSync(bivePaths(home()).projectDir(project.id))).toBe(false);
  });

  it('BIVE_HOME 환경 변수(임시 디렉터리)를 기본 경로로 쓴다', () => {
    const project = sampleProject();
    registerProject(project, { now });
    expect(listRegisteredProjects()).toEqual([project]);
    expect(existsSync(bivePaths(home()).registryDb)).toBe(true);
  });
});
