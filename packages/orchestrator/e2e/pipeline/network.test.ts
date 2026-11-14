// 파이프라인 e2e: happy-path 실행 동안 오케스트레이터 프로세스의 외부 연결 시도 0건 (M1-22 수용 기준 4, NFR-04 · ADR-075).
// 제품 CLI를 네트워크 감시 진입점(`test/helpers/net-watched-cli.ts`)으로 띄워 같은 프로세스의 `net` · `dns` · `dgram`(UDP) 호출을 모두 기록하고,
// happy-path와 같은 조작(요구사항 저장 → 제안 승인 · 거절 → 실행 → merged)을 실제 git · 실제 판정 러너로 끝낸 뒤 기록을 본다.
// 허용: 로컬 소켓(파이프)과 127.0.0.1. 범위: 오케스트레이터 프로세스만. 판정 러너 · git의 하위 프로세스(pnpm install ·
// next build · next start · vitest)는 감시하지 않는다(범위와 근거는 ADR-075).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readPidFile } from '../../src/lock.js';
import { runPaths } from '../../src/run-paths.js';
import {
  describeAttempt,
  isExternalAttempt,
  type NetAttempt,
  readNetWatchLog,
} from '../../test/helpers/net-watch.js';
import {
  approveRule,
  attempts,
  cleanupPipeline,
  human,
  runToEnd,
  saveRequirement,
  startPipeline,
} from './harness.js';

const logDirs: string[] = [];

afterEach(async () => {
  await cleanupPipeline();
  for (const dir of logDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('happy-path 실행 동안 오케스트레이터 프로세스의 외부 연결 시도 0건', () => {
  it('net · dns · dgram 감시 기록에 로컬 소켓 · 127.0.0.1 밖 연결 시도가 없고 실행은 merged다', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bive-net-'));
    logDirs.push(logDir);
    const log = path.join(logDir, 'net-watch.jsonl');
    const e = await startPipeline('happy-path', {
      entry: 'test/helpers/net-watched-cli.ts',
      env: { BIVE_NET_WATCH_LOG: log },
    });

    const { proposals } = await saveRequirement(e, '헬스 체크 응답에 서버 시각 포함', 2);
    const [first, second] = proposals;
    if (first === undefined || second === undefined) throw new Error('제안 2개 아님');
    const rule = await approveRule(e, first);
    await e.client.call('proposal.reject', {
      projectId: e.projectId,
      id: second.id,
      author: human,
      reason: '중복',
    });
    const done = await runToEnd(e, [rule.id], 300_000);
    expect(done.run).toMatchObject({ status: 'merged', failureReason: null });
    expect(attempts(done)).toContain('merge#1:passed');

    // 감시는 오케스트레이터 프로세스(파이프를 연 pid)에 걸려 있었다
    const pid = e.orchestrator.child.pid;
    expect(readPidFile(runPaths(e.biveHome).pid)).toBe(pid);
    const records = readNetWatchLog(log);
    expect(records[0]).toMatchObject({ kind: 'installed', pid });
    expect(records.every((record) => record.pid === pid)).toBe(true);

    const seen = records.filter((record): record is NetAttempt => record.kind !== 'installed');
    // 대조군: 판정 러너의 서버 응답 대기(127.0.0.1 HTTP)가 기록됐다 = 감시가 실제 호출을 보고 있었다
    expect(seen.some((a) => a.kind === 'net' && 'host' in a && a.host === '127.0.0.1')).toBe(true);
    expect(seen.filter(isExternalAttempt).map(describeAttempt)).toEqual([]);
  }, 600_000);
});
