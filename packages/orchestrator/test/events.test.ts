// 실행 알림 (M1-19 수용 기준 3, RUN-01 · RUN-02 · SCR-03 · SCR-05, ADR-076).
// 오케스트레이터 쪽: 실제 파이프(Unix 소켓) · 실제 SQLite · 실제 git 워크트리 · 실제 엔진. 단계 실행기만 결과를 바로 내는
// 대역이다(판정 러너 · 세션 없음, 검사 대역이 판정 기록 1건을 남긴다).
// - 단계 전이(실행 상태 저장)마다 바뀐 단계 시도의 `event.step.updated`와 `event.run.updated`가 인증된 연결에 나간다
// - 알림을 받은 순간 규칙(SCR-03 `rule.list`) · 검증(SCR-05 `verification.summary`)을 다시 조회하면 그 알림의 상태가 보인다
// 렌더러가 알림을 받아 두 화면을 다시 조회하는 것은 앱 쪽에서 단언한다(`packages/app/e2e/run-start.spec.ts`의
// "실행 알림" · `packages/app/test/refresh-coalescer.test.ts`). 파일이 프로세스 경계를 넘을 수 없어 나눴다(ADR-076).
import fs from 'node:fs';

import {
  type JudgmentResult,
  parseNotification,
  RUN_STEP_PLANS,
  type RunUpdatedEvent,
  type StepUpdatedEvent,
} from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { selectAgent } from '../src/agent/select.js';
import type { StepExecutors } from '../src/engine/types.js';
import { RunEventPublisher } from '../src/events/run-events.js';
import { type Orchestrator, startOrchestrator } from '../src/orchestrator.js';
import { createRun } from '../src/runs/run-service.js';
import { connect, TestClient } from './helpers/client.js';
import {
  copyFixture,
  human,
  newId,
  scripted,
  seedProject,
  type SeededProject,
  withProject,
} from './helpers/engine-harness.js';
import { cleanup, makeBiveHome, waitFor } from './helpers/process.js';

const temps: string[] = [];
const running: Orchestrator[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const orchestrator of running.splice(0)) await orchestrator.stop();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Received =
  | { method: 'event.run.updated'; params: RunUpdatedEvent }
  | { method: 'event.step.updated'; params: StepUpdatedEvent };

/** 받은 알림을 차례대로 모은다. 알림을 받을 때마다 `onNotice`를 부른다(받은 순간의 재조회). */
const collect = (
  client: TestClient,
  onNotice: (notice: Received) => void = () => undefined,
): Received[] => {
  const received: Received[] = [];
  const pump = async (): Promise<void> => {
    while (!client.isClosed) {
      const message = await client.nextUnmatched();
      const parsed = parseNotification(message);
      if (!parsed.ok) throw new Error(`알림 아닌 메시지: ${JSON.stringify(message)}`);
      const notice = { method: parsed.method, params: parsed.params } as Received;
      received.push(notice);
      onNotice(notice);
    }
  };
  void pump();
  return received;
};

/** 판정 기록 1건 (검사 대역이 남긴다, ADR-069 판정 기록과 같은 모양). */
const judgmentOf = (
  ruleId: string,
  runId: string,
  stepId: string,
  commit: string,
): JudgmentResult => ({
  id: newId(),
  ruleId,
  runId,
  stepId,
  commit,
  judgedAt: new Date().toISOString(),
  status: 'pass',
  runner: 'vitest',
  exitCode: 0,
  reporterPath: null,
  cases: [],
  quarantineReason: null,
});

/** 세션 · 판정 러너 없이 결과만 내는 실행기. 검사는 판정 기록 1건을 저장하고, 병합은 기준 커밋을 병합 커밋으로 쓴다. */
const stubExecutors: StepExecutors = {
  test_writing: scripted(['passed']),
  red_check: scripted(['passed']),
  implementation: scripted(['passed']),
  check: (context) => {
    context.read((store) =>
      store.judgments.record(
        context.run.targetRuleIds.map((ruleId) =>
          judgmentOf(ruleId, context.run.id, context.step.id, context.git.baseCommit),
        ),
      ),
    );
    return Promise.resolve({ status: 'passed' });
  },
  merge: (context) =>
    Promise.resolve({ status: 'passed', run: { mergeCommit: context.git.baseCommit } }),
};

interface Started extends SeededProject {
  biveHome: string;
  orchestrator: Orchestrator;
}

const start = async (executors: StepExecutors = stubExecutors): Promise<Started> => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const seeded = seedProject(biveHome, repo);
  const result = await startOrchestrator({
    biveHome,
    idleShutdownMs: 60_000,
    helloTimeoutMs: 60_000,
    agent: selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome }),
    executors,
    log: () => undefined,
  });
  if (result.status !== 'started') throw new Error('기동 실패');
  running.push(result.orchestrator);
  return { ...seeded, biveHome, orchestrator: result.orchestrator };
};

const client = async (s: Started): Promise<TestClient> => {
  const c = await connect(s.orchestrator.paths.pipe, s.orchestrator.token);
  clients.push(c);
  return c;
};

const runState = (notice: Received): string =>
  notice.method === 'event.run.updated'
    ? `run ${notice.params.status}:${String(notice.params.currentStep)}`
    : `step ${notice.params.kind}#${String(notice.params.attempt)}:${notice.params.status}`;

describe('단계 전이마다 event.step.updated · event.run.updated (수용 기준 3)', () => {
  it('실행 생성부터 병합까지: 저장마다 바뀐 단계 시도 알림 뒤 실행 알림, 화면 갱신 단계의 실행 알림 포함', async () => {
    const s = await start();
    const watcher = await client(s);
    const received = collect(watcher);
    const caller = await client(s);

    const created = await caller.call('run.create', {
      projectId: s.project.id,
      ruleIds: [s.rule.id],
      author: human,
    });
    const runId = created.run.id;
    await waitFor(
      () => received.some((n) => n.method === 'event.run.updated' && n.params.status === 'merged'),
      30_000,
      '병합 알림',
    );

    expect(received.map(runState)).toEqual([
      // 실행 생성(승인 대기): 처음 알리는 실행이라 단계 시도 전부
      'step approval#1:running',
      'step test_writing#1:pending',
      'step red_check#1:pending',
      'step implementation#1:pending',
      'step check#1:pending',
      'step mutation#1:pending',
      'step merge#1:pending',
      'step screen_update#1:pending',
      'run waiting_approval:approval',
      // 승인 단계 통과 → running (테스트 작성 시작)
      'step approval#1:passed',
      'step test_writing#1:running',
      'run running:test_writing',
      // 워크트리 생성 정보 저장 (단계 시도 변화 없음)
      'run running:test_writing',
      'step test_writing#1:passed',
      'step red_check#1:running',
      'run running:red_check',
      'step red_check#1:passed',
      'step implementation#1:running',
      'run running:implementation',
      'step implementation#1:passed',
      'step check#1:running',
      'run running:check',
      'step check#1:passed',
      'step mutation#1:running',
      'run running:mutation',
      'step mutation#1:skipped',
      'step merge#1:running',
      'run running:merge',
      'step merge#1:passed',
      'step screen_update#1:running',
      'run running:screen_update',
      // 화면 갱신 단계: 판정 결과 저장 뒤 실행 알림, 송신이 끝난 뒤 완료 저장
      'run running:screen_update',
      'step screen_update#1:passed',
      'run merged:null',
    ]);
    for (const notice of received) {
      expect(notice.params.projectId).toBe(s.project.id);
      expect(notice.params.runId).toBe(runId);
    }
    // 단계 계획의 모든 단계가 끝남 알림을 받는다
    const ended = received.filter(
      (n): n is Extract<Received, { method: 'event.step.updated' }> =>
        n.method === 'event.step.updated' &&
        n.params.status !== 'running' &&
        n.params.status !== 'pending',
    );
    expect(ended.map((n) => n.params.kind)).toEqual([...RUN_STEP_PLANS.A]);
    const last = received.at(-1);
    expect(last).toEqual({
      method: 'event.run.updated',
      params: {
        projectId: s.project.id,
        runId,
        displayId: 'EXE-001',
        status: 'merged',
        currentStep: null,
        regressionCount: 0,
        costUsd: null,
      },
    });
    // 알림의 단계 시도 ID는 저장된 단계 시도다
    const detail = await caller.call('run.get', { projectId: s.project.id, id: runId });
    const stepIds = new Set(detail.steps.map((step) => step.id));
    for (const notice of received) {
      if (notice.method === 'event.step.updated') {
        expect(stepIds.has(notice.params.stepId)).toBe(true);
      }
    }
  }, 60_000);

  it('인증 전 연결은 알림을 받지 않고, 인증된 연결은 모두 같은 알림을 받는다', async () => {
    const s = await start();
    const first = collect(await client(s));
    const second = collect(await client(s));
    const anonymous = await TestClient.open(s.orchestrator.paths.pipe);
    clients.push(anonymous);
    const caller = await client(s);
    await caller.call('run.create', {
      projectId: s.project.id,
      ruleIds: [s.rule.id],
      author: human,
    });
    await waitFor(
      () => first.some((n) => n.method === 'event.run.updated' && n.params.status === 'merged'),
      30_000,
      '병합 알림',
    );
    await waitFor(() => second.length === first.length, 5_000, '두 번째 연결의 알림');
    expect(second.map(runState)).toEqual(first.map(runState));
    // 인증 전 연결: hello 전 프레임은 아무것도 오지 않는다
    expect(anonymous.unmatched).toEqual([]);
    // 인증 전 연결도 여전히 hello를 받을 수 있다 (알림 때문에 닫히지 않음)
    await expect(anonymous.hello(s.orchestrator.token)).resolves.toMatchObject({
      orchestratorVersion: expect.any(String) as string,
    });
  }, 60_000);
});

describe('알림을 받은 순간 다시 조회하면 그 상태가 보인다 (수용 기준 3, SCR-03 · SCR-05)', () => {
  it('화면 갱신 단계의 실행 알림 때 규칙 목록에 판정이, 병합 알림 때 검증 요약에 병합된 실행이 보인다', async () => {
    const s = await start();
    const caller = await client(s);
    const watcher = await client(s);
    const reads: Promise<string>[] = [];
    let screenUpdateSeen = 0;
    collect(watcher, (notice) => {
      if (notice.method !== 'event.run.updated') return;
      if (notice.params.currentStep === 'screen_update') {
        screenUpdateSeen += 1;
        // 화면 갱신 단계의 두 번째 실행 알림 = 판정 결과 저장 뒤 송신 (첫 번째는 단계 시작 저장)
        if (screenUpdateSeen === 2) {
          reads.push(
            caller
              .call('rule.list', { projectId: s.project.id })
              .then(({ rules }) => `SCR-03 ${rules.map((r) => r.judgment.status).join(',')}`),
          );
        }
      }
      if (notice.params.status === 'merged') {
        reads.push(
          caller
            .call('verification.summary', { projectId: s.project.id })
            .then(
              (summary) =>
                `SCR-05 ${String(summary.pipeline?.run.status)} 준수 ${String(
                  summary.compliance.passed,
                )}/${String(summary.compliance.judgeable)} 기준 ${String(summary.basis?.runId === notice.params.runId)}`,
            ),
        );
      }
    });
    // 실행 전: 규칙은 미판정, 검증 화면 파이프라인 없음
    expect(
      (await caller.call('rule.list', { projectId: s.project.id })).rules[0]?.judgment.status,
    ).toBe('unjudged');
    expect(
      (await caller.call('verification.summary', { projectId: s.project.id })).pipeline,
    ).toBeNull();

    await caller.call('run.create', {
      projectId: s.project.id,
      ruleIds: [s.rule.id],
      author: human,
    });
    await waitFor(() => reads.length === 2, 30_000, '재조회 2건');
    expect(await Promise.all(reads)).toEqual(['SCR-03 pass', 'SCR-05 merged 준수 1/1 기준 true']);
  }, 60_000);
});

describe('RunEventPublisher', () => {
  const withSink = () => {
    const sent: string[] = [];
    const sink = {
      notify: (method: string, params: unknown) => {
        sent.push(`${method} ${JSON.stringify(params)}`);
        return Promise.resolve();
      },
    };
    return { sent, sink };
  };

  it('서버가 없으면(기동 중) 보내지 않고, 화면 갱신이 아닌 notify는 무시한다', async () => {
    const biveHome = makeBiveHome();
    let sink: ReturnType<typeof withSink>['sink'] | null = null;
    const publisher = new RunEventPublisher({ biveHome, sink: () => sink });
    const project = '01JA0000000000000000000001';
    const run = '01JE0000000000000000000001';
    await expect(
      publisher.publish({ type: 'notify', projectId: project, runId: run, topic: 'other' }),
    ).resolves.toBeUndefined();
    const { sent, sink: real } = withSink();
    sink = real;
    await publisher.publish({ type: 'notify', projectId: project, runId: run, topic: 'other' });
    expect(sent).toEqual([]);
  });

  it('같은 단계 시도는 값이 바뀔 때만 다시 알리고, 실행 알림은 저장마다 보낸다', async () => {
    const biveHome = makeBiveHome();
    const seeded = seedProject(biveHome, copyFixture(temps));
    const created = withProject(biveHome, seeded.project.id, (store) =>
      createRun(
        store,
        { ruleIds: [seeded.rule.id], author: human },
        { clientId: null },
        {
          now: Date.now,
          newId,
        },
      ),
    );
    const { sent, sink } = withSink();
    const publisher = new RunEventPublisher({ biveHome, sink: () => sink });
    const detail = { run: created.run, steps: created.steps };
    await publisher.publish({ type: 'run.saved', projectId: seeded.project.id, detail });
    // 처음에는 모든 단계 시도 + 실행
    expect(sent).toHaveLength(created.steps.length + 1);
    expect(sent.at(-1)).toMatch(/^event\.run\.updated /);
    await publisher.publish({ type: 'run.saved', projectId: seeded.project.id, detail });
    expect(sent.slice(created.steps.length + 1).map((line) => line.split(' ')[0])).toEqual([
      'event.run.updated',
    ]);
    // 화면 갱신 notify: 저장소에서 실행을 다시 읽어 실행 알림 1개
    await publisher.publish({
      type: 'notify',
      projectId: seeded.project.id,
      runId: created.run.id,
      topic: 'screen_update',
    });
    expect(sent).toHaveLength(created.steps.length + 3);
    expect(sent.at(-1)).toContain(`"runId":"${created.run.id}"`);
    // 없는 실행이면 거부한다 (화면 갱신 단계가 완료로 저장되지 않게)
    await expect(
      publisher.publish({
        type: 'notify',
        projectId: seeded.project.id,
        runId: '01JE0000000000000000000009',
        topic: 'screen_update',
      }),
    ).rejects.toThrow('실행을 찾을 수 없습니다');
  });
});
