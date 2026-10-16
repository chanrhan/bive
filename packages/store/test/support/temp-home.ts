// 테스트 전용: 테스트마다 임시 BIVE_HOME을 만들고 끝나면 지운다. 실제 ~/.bive는 건드리지 않는다.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUlidGenerator, type Project } from '@bive/shared';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * `beforeEach`에서 임시 디렉터리를 만들어 `BIVE_HOME`으로 지정한다(기본 경로를 쓰는 호출도 임시 경로로 간다).
 * @returns 현재 테스트의 임시 BIVE_HOME을 돌려주는 함수
 */
export const useTempHome = (): (() => string) => {
  let home: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bive-store-'));
    vi.stubEnv('BIVE_HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });
  return () => {
    if (home === undefined) throw new Error('useTempHome은 테스트 안에서만 씁니다');
    return home;
  };
};

export const newId = createUlidGenerator();

/** 테스트용 프로젝트 값. */
export const sampleProject = (overrides: Partial<Project> = {}): Project => ({
  id: newId(),
  name: '샘플 앱',
  rootPath: '/work/sample-next-app',
  baseBranch: 'main',
  createdAt: '2026-10-16T00:00:00.000Z',
  ...overrides,
});
