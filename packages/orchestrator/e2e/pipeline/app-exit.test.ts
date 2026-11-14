// 파이프라인 e2e: 앱 종료 후 실행 유지 · 재접속 (M1-20, NFR-06 · RUN-01, roadmap M1 완료 기준 흐름 11, ADR-074).
// "앱" = 앱 main과 같은 코드 경로(`startMainSession` → 분리 프로세스 기동 · 접속)를 쓰는 앱 프로세스(app-process.ts).
// 앱 1이 오케스트레이터를 띄우고 실행을 시작한 뒤 끝난다 → 앱이 없는 동안(연결 0개) 실행이 구현 단계까지 가고
// pause-implement의 대기 파일에서 멈춘다(유휴 종료 시간이 지나도 살아 있음) → 앱 2가 같은 pid에 붙어 진행 중 상태를
// 보고 끝난다 → 대기 파일을 지우면 앱 없이 병합까지 간다 → 앱 3이 같은 pid에 붙어 `merged`를 본다.
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

import { isTerminalRunStatus, type Proposal, type RunGetResult } from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { isProcessAlive, readPidFile } from '../../src/lock.js';
import { runPaths } from '../../src/run-paths.js';
import { COMPLETE_SETTINGS } from '../../test/helpers/engine-harness.js';
import { isOrchestratorOf, makeBiveHome, sleep } from '../../test/helpers/process.js';
import { type AppProcess, cleanupApps, startApp } from './app-process.js';
import { attempts, cleanupPipeline, git, human, resetFixture, RUN_BRANCH } from './harness.js';

/**
 * 유휴 종료 시간. 앱 1 종료 뒤 이 시간보다 1초 더 기다린 뒤에도 살아 있어야 하고, 병합 뒤에는 이 시간 안에 앱 3이
 * 붙어야 하므로 부하에서도 앱 3 기동(tsx 변환 포함)이 넉넉히 들어가게 둔다
 */
const IDLE_MS = 20_000;

afterEach(async () => {
  await cleanupApps();
  await cleanupPipeline();
});

describe('app-exit: 앱이 끝나도 오케스트레이터와 실행이 계속되고, 다시 띄운 앱은 같은 프로세스에 붙는다', () => {
  it('앱 없이 구현 단계까지 진행 · 유휴 시간이 지나도 유지 · 재접속(같은 pid) · 앱 없이 merged', async () => {
    const repo = resetFixture();
    const biveHome = makeBiveHome();
    const paths = runPaths(biveHome);
    const pause = path.join(biveHome, 'run', 'pause');
    const env = {
      BIVE_HOME: biveHome,
      BIVE_IDLE_SHUTDOWN_MS: String(IDLE_MS),
      BIVE_AGENT: 'scripted',
      BIVE_SCENARIO: 'pause-implement',
    };
    const base = git(repo, 'rev-parse', 'refs/heads/main');
    const merges = (): number =>
      Number(git(repo, 'rev-list', '--merges', '--count', 'refs/heads/main'));

    // 1. 앱 1: 오케스트레이터를 분리 프로세스로 띄우고 요구사항 → 규칙 승인 → 실행 시작
    const app1 = await startApp(env);
    const app1ReadyAt = Date.now();
    expect(app1.ready.launched).toBe(true);
    const pid = app1.ready.orchestratorPid;
    if (pid === null) throw new Error('잠금 파일에 오케스트레이터 pid 없음');
    expect(pid).toBe(app1.ready.spawnedPid);
    expect(pid).not.toBe(app1.ready.appPid);
    expect(isOrchestratorOf(pid, biveHome)).toBe(true);

    /** 오케스트레이터가 처음 띄운 그 프로세스로 살아 있는지 (pid 재사용이 아닌지 BIVE_HOME까지 본다) */
    const assertAlive = (): void => {
      expect(isProcessAlive(pid) && isOrchestratorOf(pid, biveHome)).toBe(true);
      expect(readPidFile(paths.pid)).toBe(pid);
    };
    /** 앱 없이 기다린다. 기다리는 동안 오케스트레이터가 사라지면 바로 실패 */
    const waitWithoutApp = async (
      condition: () => boolean,
      timeoutMs: number,
      what: string,
    ): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        assertAlive();
        if (condition()) return;
        if (Date.now() > deadline) throw new Error(`시간 초과: ${what}`);
        await sleep(250);
      }
    };

    const { project } = await app1.call('project.open', { path: repo });
    const projectId = project.id;
    await app1.call('settings.update', { projectId, patch: COMPLETE_SETTINGS, author: human });
    await app1.call('requirement.create', {
      projectId,
      text: '헬스 체크 응답에 서버 시각 포함',
      author: human,
    });
    let proposals: Proposal[] = [];
    const proposalDeadline = Date.now() + 30_000;
    while (proposals.length < 2) {
      if (Date.now() > proposalDeadline) throw new Error('시간 초과: rule-writer 제안 2개');
      await sleep(250);
      proposals = (await app1.call('proposal.list', { projectId, state: 'pending' })).proposals;
    }
    const [first, second] = proposals;
    if (first === undefined || second === undefined) throw new Error('제안 2개 아님');
    const { applied } = await app1.call('proposal.approve', {
      projectId,
      id: first.id,
      author: human,
    });
    if (applied.entity !== 'Rule') throw new Error(`규칙 제안이 아님: ${applied.entity}`);
    const rule = applied.rule;
    await app1.call('proposal.reject', { projectId, id: second.id, author: human, reason: '중복' });
    const { run } = await app1.call('run.create', { projectId, ruleIds: [rule.id], author: human });
    expect(existsSync(pause)).toBe(false);

    // 앱 1 종료 (will-quit → session.dispose)
    expect(await app1.exit()).toBe(0);
    const appExitAt = Date.now();
    expect(isProcessAlive(app1.ready.appPid)).toBe(false);
    expect(existsSync(path.join(paths.dir, 'app.pid'))).toBe(false);
    assertAlive();

    // 2. 앱 없음(연결 0개): 테스트 작성 → Red 확인(실제 판정) → 구현 세션의 대기 파일까지 진행
    await waitWithoutApp(() => existsSync(pause), 300_000, '구현 단계 대기 파일');
    // 앱이 끝난 뒤 유휴 종료 시간이 넘게 지나도 진행 중 실행이 있으므로 살아 있다
    await sleep(Math.max(0, appExitAt + IDLE_MS + 1000 - Date.now()));
    assertAlive();

    // 3. 앱 2: 새 오케스트레이터를 띄우지 않고 같은 pid에 붙어 진행 중 상태를 본다
    const app2 = await startApp(env);
    expect(app2.ready).toMatchObject({ launched: false, spawnedPid: null, orchestratorPid: pid });
    const statusAt = Date.now();
    const status = await app2.call('system.status', undefined);
    expect(status).toMatchObject({ connections: 1, runsInProgress: 1 });
    // 앱 1이 붙은 때부터 쭉 같은 프로세스 (재기동이면 가동 시간이 짧다). 가동 시간은 요청을 받은 뒤에 재므로
    // 요청 직전까지의 경과가 응답 지연과 무관한 하한이다. 그 경과는 위에서 앱 1 종료 뒤 IDLE_MS + 1초를 기다려 그보다 길다
    expect(statusAt - app1ReadyAt).toBeGreaterThan(IDLE_MS);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(statusAt - app1ReadyAt - 1000);
    const paused = await app2.call('run.get', { projectId, id: run.id });
    expect(paused.run).toMatchObject({ status: 'running', currentStep: 'implementation' });
    expect(attempts(paused)).toEqual([
      'approval#1:passed',
      'test_writing#1:passed',
      'red_check#1:passed',
      'implementation#1:running',
      'check#1:pending',
      'mutation#1:pending',
      'merge#1:pending',
      'screen_update#1:pending',
    ]);
    expect(await app2.exit()).toBe(0);

    // 4. 앱 없음: 대기 파일을 지우면 구현 → 검사 → 병합까지 간다
    rmSync(pause);
    await waitWithoutApp(() => merges() === 1, 300_000, 'main의 merge commit');

    // 5. 앱 3: 같은 pid에 붙어 merged를 본다
    const app3: AppProcess = await startApp(env);
    expect(app3.ready).toMatchObject({ launched: false, spawnedPid: null, orchestratorPid: pid });
    let done: RunGetResult = await app3.call('run.get', { projectId, id: run.id });
    const doneDeadline = Date.now() + 60_000;
    while (!isTerminalRunStatus(done.run.status)) {
      if (Date.now() > doneDeadline) throw new Error(`시간 초과: 실행 종료 (${done.run.status})`);
      await sleep(250);
      done = await app3.call('run.get', { projectId, id: run.id });
    }
    expect(done.run).toMatchObject({
      status: 'merged',
      failureReason: null,
      branch: RUN_BRANCH,
      baseCommit: base,
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
    const merge = String(done.run.mergeCommit);
    expect(git(repo, 'rev-parse', 'refs/heads/main')).toBe(merge);
    expect(git(repo, 'rev-list', '--parents', '-n', '1', merge).split(' ').slice(1)).toEqual([
      base,
      String(done.run.headCommit),
    ]);
    await expect(app3.call('system.status', undefined)).resolves.toMatchObject({
      runsInProgress: 0,
    });
    expect(await app3.exit()).toBe(0);
    assertAlive();
  }, 600_000);
});
