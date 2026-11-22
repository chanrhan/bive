// 테스트 변경 알림 (M7-13 #225 수용 기준 4, ADR-100 G, NRM-07, ADR-113).
// - 바뀜의 기준: 실행 시작 때 기준 브랜치에 있던 대상 규칙 폴더의 파일이 병합한 실행 브랜치 끝에서 내용이 달라졌거나 지워짐.
//   새 파일 · 같은 내용으로 다시 쓴 파일 · 다른 규칙 폴더는 넣지 않는다. 이름 바꿈은 지움으로 본다 (실제 git)
// - 기록: 확인됨 규칙에만, 실행 · 규칙마다 1건, 주체 오케스트레이터, 확인 상태는 그대로 (실제 SQLite)
// - 쓰는 시점: 실행이 병합으로 끝났을 때만 (엔진의 저장 이벤트, 실패 · 예산 초과 · 진행 중에는 쓰지 않는다)
// - 실제 오케스트레이터: 사람의 진술 편집(확인됨)으로 시작된 실행이 기존 인수 테스트를 다시 써 병합되면 알림이 남고
//   `confirmation.list`가 돌려준다. 미확인 규칙의 실행은 알림이 없다
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type Run, type SettingsPatch, type Step } from '@bive/shared';
import type { ProjectStore, RunDetail } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import { selectAgent } from '../src/agent/select.js';
import type { StepExecutor } from '../src/engine/types.js';
import type { GitRunner } from '../src/git/git-exec.js';
import { createGitRunner } from '../src/git/git-exec.js';
import {
  changedAcceptanceFiles,
  observeThenPublish,
  recordTestChanges,
  TestChangeNotifier,
  testWriterSessionOf,
} from '../src/norms/test-change.js';
import { type Orchestrator, startOrchestrator } from '../src/orchestrator.js';
import { connect, type TestClient } from './helpers/client.js';
import {
  COMPLETE_SETTINGS,
  copyFixture,
  human,
  mergeStep,
  newId,
  scripted,
  seedProject,
  testExecutors,
  userGit,
  withProject,
} from './helpers/engine-harness.js';
import { makeBiveHome, waitFor } from './helpers/process.js';

const temps: string[] = [];
const running: { orchestrator: Orchestrator; client: TestClient }[] = [];

afterEach(async () => {
  for (const { orchestrator, client } of running.splice(0)) {
    client.destroy();
    await orchestrator.stop();
  }
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const write = (root: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
const commitAll = (repo: string, message: string): string => {
  userGit(repo, 'add', '--all');
  userGit(repo, 'commit', '-q', '-m', message);
  return userGit(repo, 'rev-parse', 'HEAD');
};

describe('바뀜의 기준: 기준 커밋에 있던 대상 규칙 폴더 파일의 내용 바뀜 · 지움 (실제 git)', () => {
  it('바뀜 · 지움 · 이름 바꿈(지움)만 넣고 새 파일 · 같은 내용 · 다른 규칙 폴더 · 폴더 밖은 넣지 않는다 (경로 순)', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
    temps.push(repo);
    userGit(repo, 'init', '-q', '-b', 'main');
    write(repo, 'bive-acceptance/RULE-001/a.acc.ts', 'a1');
    write(repo, 'bive-acceptance/RULE-001/b.acc.ts', 'b1');
    write(repo, 'bive-acceptance/RULE-001/c.acc.ts', 'c1');
    write(repo, 'bive-acceptance/RULE-001/same.acc.ts', 'same');
    write(repo, 'bive-acceptance/RULE-001/mode.acc.ts', 'm1');
    write(repo, 'bive-acceptance/RULE-001/both.acc.ts', 'p1');
    write(repo, 'bive-acceptance/RULE-0010/x.acc.ts', 'x1');
    write(repo, 'bive-acceptance/RULE-002/y.acc.ts', 'y1');
    write(repo, 'src/app.ts', 'app1');
    const baseCommit = commitAll(repo, 'base');
    write(repo, 'bive-acceptance/RULE-001/a.acc.ts', 'a2');
    fs.rmSync(path.join(repo, 'bive-acceptance/RULE-001/b.acc.ts'));
    fs.renameSync(
      path.join(repo, 'bive-acceptance/RULE-001/c.acc.ts'),
      path.join(repo, 'bive-acceptance/RULE-001/c2.acc.ts'),
    );
    write(repo, 'bive-acceptance/RULE-001/same.acc.ts', 'same');
    write(repo, 'bive-acceptance/RULE-001/new.acc.ts', 'n1');
    // 파일 모드만 바뀜(내용 같음)은 넣지 않고, 모드와 내용이 함께 바뀌면 넣는다 (검토 1회차 N6)
    fs.chmodSync(path.join(repo, 'bive-acceptance/RULE-001/mode.acc.ts'), 0o755);
    write(repo, 'bive-acceptance/RULE-001/both.acc.ts', 'p2');
    fs.chmodSync(path.join(repo, 'bive-acceptance/RULE-001/both.acc.ts'), 0o755);
    write(repo, 'bive-acceptance/RULE-0010/x.acc.ts', 'x2');
    write(repo, 'bive-acceptance/RULE-002/y.acc.ts', 'y2');
    write(repo, 'src/app.ts', 'app2');
    const headCommit = commitAll(repo, 'head');
    const git = createGitRunner();
    await expect(
      changedAcceptanceFiles(git, repo, { baseCommit, headCommit }, 'RULE-001'),
    ).resolves.toEqual([
      { path: 'bive-acceptance/RULE-001/a.acc.ts', change: 'modified' },
      { path: 'bive-acceptance/RULE-001/b.acc.ts', change: 'removed' },
      { path: 'bive-acceptance/RULE-001/both.acc.ts', change: 'modified' },
      { path: 'bive-acceptance/RULE-001/c.acc.ts', change: 'removed' },
    ]);
    // 모드 바뀜이 실제로 커밋에 들어갔다 (대조군)
    expect(userGit(repo, 'diff', '--name-only', baseCommit, headCommit)).toContain(
      'bive-acceptance/RULE-001/mode.acc.ts',
    );
    // 바뀐 것이 없는 규칙 · 새 파일만 있는 규칙
    await expect(
      changedAcceptanceFiles(git, repo, { baseCommit, headCommit: baseCommit }, 'RULE-001'),
    ).resolves.toEqual([]);
    await expect(
      changedAcceptanceFiles(git, repo, { baseCommit, headCommit }, 'RULE-003'),
    ).resolves.toEqual([]);
  });

  it('병합한 실행의 테스트 작성 세션은 마지막으로 통과한 테스트 작성 시도의 세션이다 (ULID가 아니면 없음)', () => {
    const [first, second] = [newId(), newId()];
    const step = (
      status: Step['status'],
      sessionId: unknown,
      kind: Step['kind'] = 'test_writing',
    ) => ({ kind, status, exitDetail: { sessionId } }) as unknown as Step;
    expect(
      testWriterSessionOf([
        step('passed', first),
        step('failed', newId(), 'red_check'),
        step('failed', newId()),
        step('passed', second),
        step('passed', newId(), 'implementation'),
      ]),
    ).toBe(second);
    expect(testWriterSessionOf([step('passed', 'not-ulid')])).toBeNull();
    expect(testWriterSessionOf([step('failed', first)])).toBeNull();
  });
});

const DAILY: SettingsPatch = { ...COMPLETE_SETTINGS, dailyBudgetUsd: 10 };

const storeHarness = () => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const seeded = seedProject(biveHome, repo, DAILY);
  return {
    biveHome,
    repo,
    projectId: seeded.project.id,
    rule: seeded.rule,
    read: <T>(fn: (store: ProjectStore) => T): T => withProject(biveHome, seeded.project.id, fn),
  };
};

const FILES = [
  { path: 'bive-acceptance/RULE-001/health.acc.ts', change: 'modified' },
  { path: 'bive-acceptance/RULE-001/old.acc.ts', change: 'removed' },
] as const;

describe('recordTestChanges: 확인됨 규칙에만, 실행 · 규칙마다 1건 (ADR-100 G)', () => {
  const confirm = (h: ReturnType<typeof storeHarness>) =>
    h.read((store) =>
      store.transaction(() => {
        const log = store.approvalLog.append({
          at: new Date().toISOString(),
          action: 'confirm',
          actor: human,
          targetRef: { entity: 'Rule', id: h.rule.id },
          clientId: 'pipe-1',
          detail: {},
        });
        return store.confirmations.confirm(
          { entity: 'Rule', id: h.rule.id },
          { by: human, at: log.at, basis: { kind: 'approval_log', seq: log.seq } },
        );
      }),
    );
  const record = (h: ReturnType<typeof storeHarness>, runId: string) =>
    h.read((store) =>
      recordTestChanges(store, {
        run: { id: runId },
        baseCommit: 'a'.repeat(40),
        headCommit: 'b'.repeat(40),
        sessionId: null,
        at: new Date().toISOString(),
        changes: [{ ruleId: h.rule.id, files: FILES }],
      }),
    );

  it('확인됨 규칙: 주체 오케스트레이터 · 대상 규칙 · 실행 · 파일 · 두 커밋을 1건 남기고 확인 상태는 그대로, 같은 실행 · 규칙은 다시 남기지 않는다', () => {
    const h = storeHarness();
    const confirmation = confirm(h);
    const runId = newId();
    const [entry] = record(h, runId);
    expect(entry).toMatchObject({
      kind: 'test_changed',
      actor: { kind: 'orchestrator' },
      targetRef: { entity: 'Rule', id: h.rule.id },
      runId,
      sessionId: null,
      reason: null,
      detail: {
        testChange: {
          files: FILES,
          fileCount: 2,
          baseCommit: 'a'.repeat(40),
          headCommit: 'b'.repeat(40),
        },
      },
    });
    expect(record(h, runId)).toEqual([]);
    // 다른 실행은 따로 1건
    expect(record(h, newId())).toHaveLength(1);
    h.read((store) => {
      expect(store.rules.get(h.rule.id)?.confirmation).toEqual(confirmation);
      expect(store.normChanges.list().map((item) => item.kind)).toEqual([
        'test_changed',
        'test_changed',
      ]);
      expect(store.normChanges.verify()).toMatchObject({ valid: true });
      // 승인 기록은 사람의 확인 1건 그대로 (C2)
      expect(store.approvalLog.list().map((item) => item.action)).toEqual(['confirm']);
    });
  });

  it('미확인 · 삭제된 규칙 · 바뀐 파일 없음 · 없는 규칙은 남기지 않는다', () => {
    const h = storeHarness();
    expect(record(h, newId())).toEqual([]);
    confirm(h);
    expect(
      h.read((store) =>
        recordTestChanges(store, {
          run: { id: newId() },
          baseCommit: 'a'.repeat(40),
          headCommit: 'b'.repeat(40),
          sessionId: null,
          at: new Date().toISOString(),
          changes: [
            { ruleId: h.rule.id, files: [] },
            { ruleId: newId(), files: FILES },
          ],
        }),
      ),
    ).toEqual([]);
    h.read((store) =>
      store.db
        .prepare('UPDATE rules SET deleted_at = ? WHERE id = ?')
        .run(new Date().toISOString(), h.rule.id),
    );
    expect(record(h, newId())).toEqual([]);
    expect(h.read((store) => store.normChanges.list())).toEqual([]);
  });

  it('DB는 오케스트레이터가 아닌 주체 · 실행 없는 테스트 변경 알림과 규칙이 아닌 대상을 거부한다 (0019)', () => {
    const h = storeHarness();
    const insert = (actor: string, target: string, runId: string | null) =>
      h.read((store) =>
        store.db
          .prepare(
            `INSERT INTO norm_changes (seq, at, kind, actor, target_ref, session_id, run_id, reason, detail,
             prev_hash, hash) VALUES (1, ?, 'test_changed', ?, ?, ?, ?, '사유', '{}', ?, ?)`,
          )
          .run(
            new Date().toISOString(),
            actor,
            target,
            newId(),
            runId,
            '0'.repeat(64),
            '1'.repeat(64),
          ),
      );
    const rule = JSON.stringify({ entity: 'Rule', id: h.rule.id });
    expect(() => insert('{"kind":"agent","role":"test-writer"}', rule, newId())).toThrow(
      /테스트 변경 알림은 오케스트레이터가/,
    );
    expect(() => insert('{"kind":"orchestrator"}', rule, null)).toThrow(/테스트 변경 알림은/);
    expect(() =>
      insert(
        '{"kind":"orchestrator"}',
        JSON.stringify({ entity: 'Requirement', id: newId() }),
        newId(),
      ),
    ).toThrow(/테스트 변경 알림은/);
    insert('{"kind":"orchestrator"}', rule, newId());
  });
});

describe('TestChangeNotifier: 병합으로 끝난 실행만, 실행마다 한 번 (기다리지 않음 · 실패는 로그)', () => {
  const runOf = (status: Run['status'], targetRuleIds: string[]): Run =>
    ({
      id: newId(),
      displayId: 'EXE-001',
      status,
      targetRuleIds,
      baseCommit: 'a'.repeat(40),
      headCommit: 'b'.repeat(40),
    }) as unknown as Run;
  const event = (projectId: string, run: Run) => ({
    type: 'run.saved' as const,
    projectId,
    detail: { run, steps: [] } as unknown as RunDetail,
  });

  it('merged가 아닌 저장(진행 중 · 실패 · 예산 초과 · 병합 단계 전)에는 git을 부르지 않고, merged는 대상 규칙마다 한 번, 같은 실행의 저장을 다시 받아도 다시 부르지 않는다', async () => {
    const h = storeHarness();
    const calls: (readonly string[])[] = [];
    const git: GitRunner = (args) => {
      calls.push(args);
      return Promise.resolve({ stdout: '', stderr: '', code: 0 });
    };
    const logs: string[] = [];
    const notifier = new TestChangeNotifier({
      biveHome: h.biveHome,
      log: (line) => logs.push(line),
      git,
    });
    for (const status of ['running', 'failed', 'budget_exceeded', 'interrupted'] as const) {
      notifier.observe(event(h.projectId, runOf(status, [h.rule.id])));
    }
    notifier.observe({ type: 'notify', projectId: h.projectId, runId: newId(), topic: 'x' });
    await notifier.idle();
    expect(calls).toEqual([]);
    const merged = runOf('merged', [h.rule.id]);
    notifier.observe(event(h.projectId, merged));
    notifier.observe(event(h.projectId, merged));
    await notifier.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.at(-1)).toBe(':(literal)bive-acceptance/RULE-001/');
    expect(logs).toEqual([]);
  });

  it('관찰자가 동기 예외를 던져도 실행 알림 발행은 그대로 일어나고 로그 한 줄만 남는다 (검토 1회차 N7)', async () => {
    const published: unknown[] = [];
    const logs: string[] = [];
    const onEvent = observeThenPublish(
      () => {
        throw new Error('관찰 실패');
      },
      (item) => {
        published.push(item);
        return Promise.resolve();
      },
      (line) => logs.push(line),
    );
    const item = { type: 'notify' as const, projectId: newId(), runId: newId(), topic: 'x' };
    await onEvent(item);
    expect(published).toEqual([item]);
    expect(logs).toEqual(['테스트 변경 알림 관찰 실패: 관찰 실패']);
  });

  it('git이 실패하면 로그 한 줄만 남기고 기록하지 않는다 (실행 상태와 무관)', async () => {
    const h = storeHarness();
    const logs: string[] = [];
    const notifier = new TestChangeNotifier({
      biveHome: h.biveHome,
      log: (line) => logs.push(line),
      git: () => Promise.reject(new Error('커밋 없음')),
    });
    notifier.observe(event(h.projectId, runOf('merged', [h.rule.id])));
    await notifier.idle();
    expect(logs).toEqual(['테스트 변경 알림 실패 (EXE-001): 커밋 없음']);
    expect(h.read((store) => store.normChanges.list())).toEqual([]);
  });
});

describe('실제 오케스트레이터: 확인됨 규칙의 기존 인수 테스트를 다시 써 병합하면 테스트 변경 알림 (수용 기준 4, ADR-100 G · ADR-109)', () => {
  /** 테스트 작성 단계의 대역: 기존 파일 바꿈 · 지움, 같은 내용 다시 씀, 새 파일 */
  const rewrite: StepExecutor = (context) => {
    const root = context.git.worktreePath;
    write(root, 'bive-acceptance/RULE-001/health.acc.ts', `// ${context.run.displayId}\nv2`);
    fs.rmSync(path.join(root, 'bive-acceptance/RULE-001/old.acc.ts'), { force: true });
    write(root, 'bive-acceptance/RULE-001/same.acc.ts', 'same');
    write(root, `bive-acceptance/RULE-001/new-${context.run.displayId}.acc.ts`, 'new');
    return Promise.resolve({ status: 'passed' });
  };
  /** 처음 쓰는 파일만 더하는 대역 */
  const addOnly: StepExecutor = (context) => {
    write(
      context.git.worktreePath,
      `bive-acceptance/RULE-001/new-${context.run.displayId}.acc.ts`,
      'new',
    );
    return Promise.resolve({ status: 'passed' });
  };
  const pass: StepExecutor = () => Promise.resolve({ status: 'passed' });

  const start = async (testWriting: StepExecutor) => {
    const h = storeHarness();
    write(h.repo, 'bive-acceptance/RULE-001/health.acc.ts', 'v1');
    write(h.repo, 'bive-acceptance/RULE-001/old.acc.ts', 'old');
    write(h.repo, 'bive-acceptance/RULE-001/same.acc.ts', 'same');
    commitAll(h.repo, 'acceptance: RULE-001');
    const result = await startOrchestrator({
      biveHome: h.biveHome,
      idleShutdownMs: 60_000,
      agent: selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome: h.biveHome, pollIntervalMs: 10 }),
      executors: testExecutors({
        test_writing: testWriting,
        red_check: scripted(['passed']),
        implementation: pass,
        check: pass,
        merge: mergeStep,
      }),
    });
    if (result.status !== 'started') throw new Error('기동 실패');
    const client = await connect(result.orchestrator.paths.pipe, result.orchestrator.token);
    running.push({ orchestrator: result.orchestrator, client });
    return { h, client, orchestrator: result.orchestrator };
  };

  const waitMerged = async (client: TestClient, projectId: string, runId: string) =>
    waitFor(
      async () => (await client.call('run.get', { projectId, id: runId })).run.status === 'merged',
      30_000,
      '실행 병합',
    );

  it('사람의 진술 편집(확인됨)으로 시작된 실행이 바꾼 · 지운 기존 파일만 알림에 싣고, 확인은 그대로이며, 확인할 것 목록이 돌려주고, 다시 확인하면 내려간다', async () => {
    const { h, client } = await start(rewrite);
    const edited = await client.call('rule.update', {
      projectId: h.projectId,
      id: h.rule.id,
      author: human,
      statement:
        'WHEN 클라이언트가 GET /api/health를 요청하면 THE SYSTEM SHALL 응답 JSON의 time 필드에 ISO 8601 서버 시각을 담는다',
    });
    if (edited.autoStart?.state !== 'started') throw new Error('자동 시작 안 됨');
    const runId = edited.autoStart.runId;
    await waitMerged(client, h.projectId, runId);
    await waitFor(
      async () =>
        (await client.call('normChange.list', { projectId: h.projectId })).entries.some(
          (entry) => entry.kind === 'test_changed',
        ),
      10_000,
      '테스트 변경 알림',
    );
    const changes = await client.call('normChange.list', { projectId: h.projectId });
    expect(changes.chain.valid).toBe(true);
    const notices = changes.entries.filter((entry) => entry.kind === 'test_changed');
    expect(notices).toHaveLength(1);
    const run = (await client.call('run.get', { projectId: h.projectId, id: runId })).run;
    expect(notices[0]).toMatchObject({
      actor: { kind: 'orchestrator' },
      targetRef: { entity: 'Rule', id: h.rule.id },
      runId,
      // 대역 실행기는 세션을 열지 않는다
      sessionId: null,
      detail: {
        testChange: {
          files: FILES,
          fileCount: 2,
          baseCommit: run.baseCommit,
          headCommit: run.headCommit,
        },
      },
    });
    // 확인 상태는 그대로 (근거 = 진술 편집)
    const rule = (await client.call('rule.get', { projectId: h.projectId, id: h.rule.id })).rule;
    expect(rule.confirmation).toMatchObject({
      state: 'confirmed',
      basis: { kind: 'approval_log', seq: edited.approvalLog.seq },
    });
    const list = await client.call('confirmation.list', { projectId: h.projectId });
    // 시드 요구사항은 저장소에 바로 둔 것이라 미확인 항목으로 뒤에 온다
    expect(list.items.map((item) => item.kind)).toEqual(['test_changed', 'unconfirmed_norm']);
    expect(list.items.slice(0, 1)).toEqual([
      expect.objectContaining({
        kind: 'test_changed',
        rule: { id: h.rule.id, displayId: 'RULE-001' },
        runId,
        runDisplayId: 'EXE-001',
        files: FILES,
      }),
    ]);
    // 사람이 다시 확인하면 알림이 내려간다 (확인 1건이 승인 기록에)
    await client.call('confirmation.set', {
      projectId: h.projectId,
      target: { entity: 'Rule', id: h.rule.id },
      author: human,
    });
    expect(
      (await client.call('confirmation.list', { projectId: h.projectId })).items.map(
        (item) => item.kind,
      ),
    ).toEqual(['unconfirmed_norm']);
    const approvals = await client.call('approvalLog.list', { projectId: h.projectId });
    expect(approvals.entries.map((entry) => entry.action)).toEqual(['rule_edit', 'confirm']);
  }, 60_000);

  it('미확인 규칙의 실행이 기존 테스트를 바꾸거나, 확인됨 규칙의 실행이 새 파일만 더하면 알림이 없다', async () => {
    for (const [testWriting, confirmFirst] of [
      [rewrite, false],
      [addOnly, true],
    ] as const) {
      const { h, client, orchestrator } = await start(testWriting);
      if (confirmFirst) {
        await client.call('confirmation.set', {
          projectId: h.projectId,
          target: { entity: 'Rule', id: h.rule.id },
          author: human,
        });
      }
      const { run } = await client.call('run.create', {
        projectId: h.projectId,
        ruleIds: [h.rule.id],
        author: human,
      });
      await waitMerged(client, h.projectId, run.id);
      // 종료는 진행 중인 알림 기록을 기다린다
      const index = running.findIndex((item) => item.orchestrator === orchestrator);
      const [entry] = running.splice(index, 1);
      entry?.client.destroy();
      await orchestrator.stop();
      expect(
        h.read((store) => store.normChanges.list().filter((item) => item.kind === 'test_changed')),
      ).toEqual([]);
    }
  }, 120_000);
});
