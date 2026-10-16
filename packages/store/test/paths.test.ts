import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bivePaths, resolveBiveHome } from '../src/paths.js';
import { newId } from './support/temp-home.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveBiveHome', () => {
  it('BIVE_HOME이 없으면 ~/.bive', () => {
    expect(resolveBiveHome({}, () => '/home/someone')).toBe(join('/home/someone', '.bive'));
    expect(resolveBiveHome({})).toBe(join(homedir(), '.bive'));
  });

  it('BIVE_HOME이 비어 있거나 공백이면 미설정으로 본다', () => {
    expect(resolveBiveHome({ BIVE_HOME: '' }, () => '/h')).toBe(join('/h', '.bive'));
    expect(resolveBiveHome({ BIVE_HOME: '  ' }, () => '/h')).toBe(join('/h', '.bive'));
  });

  it('BIVE_HOME이 있으면 그 경로를 절대 경로로 쓴다', () => {
    expect(resolveBiveHome({ BIVE_HOME: '/tmp/bive-x' })).toBe(resolve('/tmp/bive-x'));
    expect(resolveBiveHome({ BIVE_HOME: 'rel/home' })).toBe(resolve('rel/home'));
  });

  it('인자가 없으면 process.env를 읽는다', () => {
    vi.stubEnv('BIVE_HOME', '');
    expect(resolveBiveHome()).toBe(join(homedir(), '.bive'));
    vi.stubEnv('BIVE_HOME', '/tmp/bive-env');
    expect(resolveBiveHome()).toBe(resolve('/tmp/bive-env'));
  });
});

describe('bivePaths', () => {
  const home = resolve('/tmp/bive-home');

  it('작업 디렉터리 루트는 $BIVE_HOME/work, 런타임은 $BIVE_HOME/run', () => {
    const paths = bivePaths(home);
    expect(paths.home).toBe(home);
    expect(paths.workRoot).toBe(join(home, 'work'));
    expect(paths.runDir).toBe(join(home, 'run'));
  });

  it('프로젝트별 DB는 $BIVE_HOME/projects/<projectId>/bive.db, 등록부는 $BIVE_HOME/registry.db', () => {
    const id = newId();
    const paths = bivePaths(home);
    expect(paths.projectsRoot).toBe(join(home, 'projects'));
    expect(paths.projectDir(id)).toBe(join(home, 'projects', id));
    expect(paths.projectDb(id)).toBe(join(home, 'projects', id, 'bive.db'));
    expect(paths.registryDb).toBe(join(home, 'registry.db'));
  });

  it('BIVE_HOME 미설정이면 ~/.bive 아래, 작업 디렉터리 루트는 ~/.bive/work', () => {
    vi.stubEnv('BIVE_HOME', '');
    const paths = bivePaths();
    expect(paths.home).toBe(join(homedir(), '.bive'));
    expect(paths.workRoot).toBe(join(homedir(), '.bive', 'work'));
  });

  it('BIVE_HOME이 있으면 기본 경로 묶음이 그 아래를 가리킨다', () => {
    vi.stubEnv('BIVE_HOME', home);
    expect(bivePaths().workRoot).toBe(join(home, 'work'));
  });

  it('ULID가 아닌 프로젝트 ID로는 경로를 만들지 않는다 (저장소 밖 경로 차단)', () => {
    const paths = bivePaths(home);
    for (const bad of ['', '..', '../escape', 'a/b', `${newId()}/..`, newId().toLowerCase()]) {
      expect(() => paths.projectDir(bad)).toThrow(TypeError);
      expect(() => paths.projectDb(bad)).toThrow(TypeError);
    }
  });
});
