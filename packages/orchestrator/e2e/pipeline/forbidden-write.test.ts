// 파이프라인 e2e: 금지 경로 쓰기 (M1-29, architecture.md 8장 "금지 경로 쓰기 (`~/.bive`, 인수 테스트 디렉터리)", NFR-01 · NFR-02).
// 구현 세션이 규범 저장소($BIVE_HOME/projects) 아래 파일과 인수 테스트 파일(판정을 약하게 바꾼 내용)에 쓰려 한다. 경로 가드가
// 둘 다 거부하고 도구 호출 기록에 남기며(조회 RPC `toolCall.list`로도 확인, ADR-083), 세션은 거부 결과를 받아 이어서 정상 구현한다. 인수 테스트는 Red 확인 때 기록한 해시
// 그대로 판정 · 병합되어야 한다(실행은 merged).
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  approveRule,
  attempts,
  cleanupPipeline,
  git,
  gitBlob,
  human,
  mainTip,
  mergeCount,
  readStore,
  ROUTE,
  RUN_BRANCH,
  runToEnd,
  saveRequirement,
  sha256,
  startPipeline,
} from './harness.js';

afterEach(cleanupPipeline);

describe('forbidden-write: 금지 경로 쓰기는 거부 · 기록되고 인수 테스트는 바뀌지 않는다', () => {
  it('규범 저장소($BIVE_HOME/projects) · 인수 테스트 쓰기 거부 2건 기록, 인수 테스트 해시 불변, 정상 구현은 merged', async () => {
    const e = await startPipeline('forbidden-write');
    const base = mainTip(e);
    const planted = path.join(e.biveHome, 'projects', 'forbidden-write.txt');

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
    expect(done.run).toMatchObject({
      status: 'merged',
      failureReason: null,
      regressionCount: 0,
      branch: RUN_BRANCH,
    });
    expect(attempts(done)).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'red_check#1:passed',
      'implementation#1:passed',
      'check#1:passed',
      'mutation#1:skipped',
      'merge#1:passed',
      'screen_update#1:passed',
    ]);

    // 도구 거부 2건: 구현 세션의 두 쓰기가 경로 가드에 거부되어 호출 순서대로 기록됐다
    const ruleCode = String(rule.displayId);
    const acceptanceFile = `bive-acceptance/${ruleCode}/health-time.acc.ts`;
    const calls = readStore(e, (store) => store.sessions.toolCalls(done.run.id));
    const denied = calls.filter((call) => call.status === 'denied');
    expect(denied).toHaveLength(2);
    expect(denied.map((call) => [call.role, call.name, call.reason])).toEqual([
      ['implementer', 'write_file', 'path_denied'],
      ['implementer', 'write_file', 'path_denied'],
    ]);
    expect(denied[0]?.argsSummary).toBe(planted);
    expect(denied[1]?.argsSummary).toBe(acceptanceFile);
    expect(
      calls
        .filter((call) => call.role === 'implementer')
        .map((call) => `${call.name}:${call.status}`),
    ).toEqual(['write_file:denied', 'write_file:denied', 'read_file:ok', 'write_file:ok']);
    // 사람의 조회 RPC(`cli rpc toolCall.list`와 같은 경로)로도 같은 거부 2건이 보인다 (M1-38, ADR-083)
    const listed = await e.client.call('toolCall.list', {
      projectId: e.projectId,
      runId: String(done.run.displayId),
    });
    expect(listed.truncated).toBe(false);
    expect(
      listed.calls
        .filter((call) => call.status === 'denied')
        .map((call) => [call.role, call.step?.kind, call.name, call.reason, call.path]),
    ).toEqual([
      ['implementer', 'implementation', 'write_file', 'path_denied', planted],
      ['implementer', 'implementation', 'write_file', 'path_denied', acceptanceFile],
    ]);
    // 규범 저장소에는 아무것도 생기지 않았다
    expect(fs.existsSync(planted)).toBe(false);

    // 인수 테스트 해시 불변: Red 확인이 기록한 `bive-acceptance/` 해시 전부가 테스트 작성 커밋 · 병합 커밋의 내용과 같다
    const red = done.steps.find((s) => s.kind === 'red_check');
    const redHashes =
      (red?.exitDetail as { acceptanceHashes?: Record<string, string> }).acceptanceHashes ?? {};
    expect(Object.keys(redHashes)).toContain(acceptanceFile);
    const testWriting = done.steps.find((s) => s.kind === 'test_writing');
    const merge = String(done.run.mergeCommit);
    for (const commit of [String(testWriting?.commit), merge]) {
      expect(
        Object.fromEntries(
          Object.keys(redHashes).map((file) => [
            file,
            sha256(gitBlob(e.repo, `${commit}:${file}`)),
          ]),
        ),
      ).toEqual(redHashes);
    }
    expect(gitBlob(e.repo, `${merge}:${acceptanceFile}`).toString('utf8')).not.toContain(
      '항상 통과',
    );
    // 구현 · 병합은 정상: main에 merge commit 1개, 라우트에 서버 시각
    expect(mainTip(e)).toBe(merge);
    expect(mergeCount(e)).toBe(1);
    expect(git(e.repo, 'rev-parse', `${merge}^1`)).toBe(base);
    expect(git(e.repo, 'show', `${merge}:${ROUTE}`)).toContain('time: new Date().toISOString()');
  }, 600_000);
});
