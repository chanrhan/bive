// OS별 파이프 경로 함수 (M0-05 수용 기준 2, architecture.md 5장 · NFR-10). 경로 문자열만 검사한다.
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertSocketPathLength,
  maxSocketPathBytes,
  pipePath,
  sanitizePipeSegment,
} from '../src/pipe-path.js';
import { resolveBiveHome, runPaths } from '../src/run-paths.js';

describe('pipePath', () => {
  it('Windows는 \\\\.\\pipe\\bive-<사용자>', () => {
    expect(
      pipePath({ platform: 'win32', biveHome: 'C:\\Users\\kim\\.bive', username: 'kim' }),
    ).toBe('\\\\.\\pipe\\bive-kim');
  });

  it('Windows 파이프 이름은 BIVE_HOME과 무관하고 사용자 이름의 쓸 수 없는 문자를 바꾼다', () => {
    expect(pipePath({ platform: 'win32', biveHome: 'D:\\x', username: 'DOMAIN\\Kim Lee' })).toBe(
      '\\\\.\\pipe\\bive-DOMAIN_Kim_Lee',
    );
    expect(sanitizePipeSegment('')).toBe('user');
    expect(sanitizePipeSegment('a.b-c_d9')).toBe('a.b-c_d9');
  });

  it.each(['linux', 'darwin', 'freebsd'] as const)(
    '%s는 $BIVE_HOME/run/orchestrator.sock',
    (platform) => {
      expect(pipePath({ platform, biveHome: '/home/kim/.bive', username: 'kim' })).toBe(
        '/home/kim/.bive/run/orchestrator.sock',
      );
    },
  );
});

describe('소켓 경로 길이 제한', () => {
  it('Linux 107바이트, macOS 103바이트, Windows 없음', () => {
    expect(maxSocketPathBytes('linux')).toBe(107);
    expect(maxSocketPathBytes('darwin')).toBe(103);
    expect(maxSocketPathBytes('win32')).toBeNull();
  });

  it('제한을 넘으면 기동 전에 예외', () => {
    const ok = `/${'a'.repeat(106)}`;
    expect(() => assertSocketPathLength(ok, 'linux')).not.toThrow();
    expect(() => assertSocketPathLength(`${ok}b`, 'linux')).toThrow(/너무 김/);
    expect(() => assertSocketPathLength(ok, 'darwin')).toThrow(/너무 김/);
    // 다중 바이트 문자는 바이트로 센다
    expect(() => assertSocketPathLength(`/${'가'.repeat(36)}`, 'linux')).toThrow(/너무 김/);
    expect(() => assertSocketPathLength(`\\\\.\\pipe\\${'a'.repeat(300)}`, 'win32')).not.toThrow();
  });
});

describe('BIVE_HOME · run 경로', () => {
  it('BIVE_HOME이 없거나 비면 ~/.bive', () => {
    expect(resolveBiveHome({}, '/home/kim')).toBe(path.join('/home/kim', '.bive'));
    expect(resolveBiveHome({ BIVE_HOME: '' }, '/home/kim')).toBe(path.join('/home/kim', '.bive'));
  });

  it('BIVE_HOME을 절대 경로로 푼다', () => {
    expect(resolveBiveHome({ BIVE_HOME: '/srv/bive' }, '/home/kim')).toBe(
      path.resolve('/srv/bive'),
    );
  });

  it('run 아래 소켓 · 토큰 · 잠금 파일', () => {
    const paths = runPaths('/home/kim/.bive', 'linux', 'kim');
    expect(paths).toEqual({
      dir: path.join('/home/kim/.bive', 'run'),
      pipe: '/home/kim/.bive/run/orchestrator.sock',
      token: path.join('/home/kim/.bive', 'run', 'token'),
      pid: path.join('/home/kim/.bive', 'run', 'orchestrator.pid'),
    });
    expect(runPaths('/home/kim/.bive', 'win32', 'kim').pipe).toBe('\\\\.\\pipe\\bive-kim');
  });
});
