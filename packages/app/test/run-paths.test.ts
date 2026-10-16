// app의 run 경로 규칙이 오케스트레이터 원본과 같은지 대조한다.
// 제품 코드는 orchestrator를 import할 수 없지만(architecture.md 2장) 테스트는 원본 파일을 직접 읽어 비교한다.
import { describe, expect, it } from 'vitest';

import {
  resolveBiveHome as orchestratorBiveHome,
  runPaths,
} from '../../orchestrator/src/run-paths.js';
import { appRunPaths, resolveBiveHome } from '../src/main/run-paths.js';

const cases: [NodeJS.Platform, string, string][] = [
  ['linux', '/tmp/bive-x', 'root'],
  ['darwin', '/Users/kim/.bive', 'kim'],
  ['win32', 'C:\\Users\\kim\\.bive', 'Kim Lee\\DOMAIN'],
  ['win32', 'C:\\h', ''],
];

describe('run 경로', () => {
  it.each(cases)(
    '%s %s: 파이프 · 토큰 · 잠금 경로가 오케스트레이터와 같다',
    (platform, home, user) => {
      const ours = appRunPaths(home, platform, user);
      const theirs = runPaths(home, platform, user);
      expect({
        dir: ours.dir,
        pipe: ours.pipe,
        token: ours.token,
        pid: ours.orchestratorPid,
      }).toEqual(theirs);
    },
  );

  it('app.pid는 run 폴더 안에 둔다', () => {
    const paths = appRunPaths('/tmp/bive-x', 'linux', 'root');
    expect(paths.appPid).toBe('/tmp/bive-x/run/app.pid');
  });

  it('BIVE_HOME 해석이 오케스트레이터와 같다', () => {
    for (const env of [{}, { BIVE_HOME: '' }, { BIVE_HOME: 'rel/home' }, { BIVE_HOME: '/abs' }]) {
      expect(resolveBiveHome(env, '/home/u')).toBe(orchestratorBiveHome(env, '/home/u'));
    }
  });
});
