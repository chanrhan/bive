// 실행 알림 (M1-19 수용 기준 3, RUN-01 · RUN-02 · SCR-03 · SCR-05, ADR-076).
// 오케스트레이터 쪽: 실제 파이프(Unix 소켓) · 실제 SQLite · 실제 git 워크트리 · 실제 엔진. 단계 실행기만 결과를 바로 내는
// 대역이다(판정 러너 · 세션 없음, 검사 대역이 판정 기록 1건을 남긴다).
// - 단계 전이(실행 상태 저장)마다 바뀐 단계 시도의 `event.step.updated`와 `event.run.updated`가 인증된 연결에 나간다
// - 알림을 받은 순간 규칙(SCR-03 `rule.list`) · 검증(SCR-05 `verification.summary`)을 다시 조회하면 그 알림의 상태가 보인다
// 렌더러가 알림을 받아 두 화면을 다시 조회하는 것은 앱 쪽에서 단언한다(`packages/app/e2e/run-start.spec.ts`의
// "실행 알림" · `packages/app/test/refresh-coalescer.test.ts`). 파일이 프로세스 경계를 넘을 수 없어 나눴다(ADR-076).
// 제안 알림(M1-36): 실제 rule-writer 세션(scripted happy-path)이 제안을 만들 때와 사람이 처리할 때 `event.proposal.changed`가
// 저장 뒤에 나가 받은 순간 `proposal.count`가 그 상태임을 단언한다. 배지 · 할 일 목록 쪽은 `packages/app/e2e/todo-badge.spec.ts`.
import fs from 'node:fs';
import net from 'node:net';

import {
  createRequest,
  type JudgmentResult,
  PROTOCOL_VERSION,
  parseNotification,
  type Proposal,
  type ProposalChangedEvent,
  RUN_STEP_PLANS,
  type RunUpdatedEvent,
  type StepUpdatedEvent,
} from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { selectAgent } from '../src/agent/select.js';
import type { StepExecutors } from '../src/engine/types.js';
import { ProposalEventPublisher } from '../src/events/proposal-events.js';
import { RunEventPublisher } from '../src/events/run-events.js';
import { type Orchestrator, startOrchestrator } from '../src/orchestrator.js';
import { submitProposal } from '../src/proposals/proposal-service.js';
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
  | { method: 'event.step.updated'; params: StepUpdatedEvent }
  | { method: 'event.proposal.changed'; params: ProposalChangedEvent };

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

const start = async (
  options: { executors?: StepExecutors; notifyTimeoutMs?: number } = {},
): Promise<Started> => {
  const biveHome = makeBiveHome();
  const repo = copyFixture(temps);
  const seeded = seedProject(biveHome, repo);
  const result = await startOrchestrator({
    biveHome,
    idleShutdownMs: 60_000,
    helloTimeoutMs: 60_000,
    agent: selectAgent({ BIVE_AGENT: 'scripted' }, { biveHome }),
    executors: options.executors ?? stubExecutors,
    log: () => undefined,
    ...(options.notifyTimeoutMs === undefined ? {} : { notifyTimeoutMs: options.notifyTimeoutMs }),
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

const runState = (notice: Received): string => {
  switch (notice.method) {
    case 'event.run.updated':
      return `run ${notice.params.status}:${String(notice.params.currentStep)}`;
    case 'event.step.updated':
      return `step ${notice.params.kind}#${String(notice.params.attempt)}:${notice.params.status}`;
    case 'event.proposal.changed':
      return `proposal ${notice.params.displayId}:${notice.params.state}`;
  }
};

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
      // 실행 알림만 온다 (제안 알림이 섞이면 runId가 없어 실패)
      expect('runId' in notice.params ? notice.params.runId : null).toBe(runId);
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

/**
 * 인증만 하고 소켓을 읽지 않는 연결 (멈춘 앱). 응답이 큰 요청 몇 건을 보내 그 연결의 송신 버퍼(커널 버퍼 포함)를
 * 채운다: id는 응답에 그대로 실려 오므로 512KB 문자열 id의 `ping` 8건이면 응답이 4MB다. 요청이 가벼워 금방
 * 쌓인다(#153. 이전에는 `rule.list` 3000건을 보내 처리에 15초쯤 걸렸다). 닫히면 `closed`가 풀린다.
 */
const stalledConnection = async (
  s: Started,
): Promise<{ socket: net.Socket; closed: Promise<void> }> => {
  const socket = net.createConnection(s.orchestrator.paths.pipe);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.on('error', () => undefined);
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.setEncoding('utf8');
  // hello 응답 1줄만 읽고 멈춘다
  const hello = new Promise<void>((resolve) => {
    const onData = (chunk: string): void => {
      if (!chunk.includes('\n')) return;
      socket.off('data', onData);
      socket.pause();
      resolve();
    };
    socket.on('data', onData);
  });
  socket.write(
    `${JSON.stringify(
      createRequest(0, 'system.hello', {
        protocolVersion: PROTOCOL_VERSION,
        token: s.orchestrator.token,
      }),
    )}\n`,
  );
  await hello;
  const lines: string[] = [];
  for (let n = 1; n <= 8; n += 1) {
    lines.push(JSON.stringify(createRequest(`${String(n)}:${'x'.repeat(512 * 1024)}`, 'ping')));
  }
  socket.write(`${lines.join('\n')}\n`);
  return { socket, closed };
};

describe('읽지 않는 연결 · 종료 (검토 1회차, ADR-076)', () => {
  it('인증만 하고 읽지 않는 연결이 있어도 화면 갱신 단계는 송신 상한 안에 끝나 merged, 멈춘 연결은 닫히고 정상 연결은 알림을 받는다', async () => {
    const s = await start({ notifyTimeoutMs: 300 });
    const stalled = await stalledConnection(s);
    // 서버가 요청을 처리해 응답이 그 연결의 버퍼에 쌓일 시간
    await new Promise((resolve) => setTimeout(resolve, 200));
    const received = collect(await client(s));
    const caller = await client(s);
    const created = await caller.call('run.create', {
      projectId: s.project.id,
      ruleIds: [s.rule.id],
      author: human,
    });
    await waitFor(
      () => received.some((n) => n.method === 'event.run.updated' && n.params.status === 'merged'),
      20_000,
      '병합 알림 (멈춘 연결이 있어도)',
    );
    const detail = await caller.call('run.get', { projectId: s.project.id, id: created.run.id });
    expect(detail.run.status).toBe('merged');
    expect(detail.steps.find((step) => step.kind === 'screen_update')?.status).toBe('passed');
    // 멈춘 연결은 송신 상한을 넘겨 서버가 끊었다 (끊긴 연결과 같이 완료로 본다). 쌓인 것을 비우면 끝(EOF)이 온다
    expect(s.orchestrator.connectionCount).toBe(2);
    stalled.socket.resume();
    await stalled.closed;
  }, 60_000);

  it('송신을 기다리는 화면 갱신 단계에서 orchestrator.stop()이 제한 시간 안에 끝나고, 실행은 다음 기동 때 중단으로 남는다', async () => {
    const s = await start({ notifyTimeoutMs: 120_000 });
    const stalled = await stalledConnection(s);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const caller = await client(s);
    const created = await caller.call('run.create', {
      projectId: s.project.id,
      ruleIds: [s.rule.id],
      author: human,
    });
    // 병합까지 끝나고 화면 갱신 단계에서 송신을 기다린다
    await waitFor(
      () =>
        withProject(s.biveHome, s.project.id, (store) => {
          const steps = store.runs.steps(created.run.id);
          return steps.find((step) => step.kind === 'merge')?.status === 'passed';
        }),
      20_000,
      '병합 단계 완료',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const run = withProject(s.biveHome, s.project.id, (store) => store.runs.get(created.run.id));
    expect(run).toMatchObject({ status: 'running', currentStep: 'screen_update' });

    const stopped = s.orchestrator.stop();
    const outcome = await Promise.race([
      stopped.then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
    ]);
    expect(outcome).toBe('stopped');
    running.splice(running.indexOf(s.orchestrator), 1);
    stalled.socket.resume();
    await stalled.closed;
    // 중단은 저장하지 않는다(ADR-066): running · 화면 갱신 진행 중으로 남고 다음 기동 때 interrupted
    expect(
      withProject(s.biveHome, s.project.id, (store) => store.runs.get(created.run.id)),
    ).toMatchObject({ status: 'running', currentStep: 'screen_update' });
  }, 60_000);
});

describe('제안 생성 · 처리마다 event.proposal.changed (M1-36, TODO-01 · NRM-02)', () => {
  /** 실제 rule-writer 세션(scripted happy-path)이 `propose_rule`을 2번 부른다. */
  const startWithRuleWriter = () =>
    start().then(async (s) => {
      const watcher = await client(s);
      const caller = await client(s);
      return { s, watcher, caller };
    });

  it('요구사항 저장 뒤 rule-writer가 제안 2개를 만들면 제안마다 알림이 가고, 받은 순간 proposal.count가 그 수다', async () => {
    const { s, watcher, caller } = await startWithRuleWriter();
    const anonymous = await TestClient.open(s.orchestrator.paths.pipe);
    clients.push(anonymous);
    // 알림을 받은 순간 할 일 배지가 다시 세는 값 (렌더러의 proposal.count 재조회와 같다)
    const counts: Promise<number>[] = [];
    const received = collect(watcher, (notice) => {
      if (notice.method !== 'event.proposal.changed') return;
      counts.push(
        caller.call('proposal.count', { projectId: s.project.id }).then(({ pending }) => pending),
      );
    });
    expect((await caller.call('proposal.count', { projectId: s.project.id })).pending).toBe(0);

    const { requirement } = await caller.call('requirement.create', {
      projectId: s.project.id,
      text: '헬스 체크 응답에 서버 시각 포함',
      author: human,
    });
    await waitFor(() => counts.length === 2, 30_000, '제안 알림 2건');
    // 알림은 저장 뒤에 나가므로 받은 순간 다시 세면 그 제안까지 들어 있다(두 제안은 연달아 생겨 첫 재조회에 둘 다
    // 보일 수 있다). 마지막 알림 뒤의 재조회는 마지막 상태(2)다
    const seen = await Promise.all(counts);
    expect(seen[0]).toBeGreaterThanOrEqual(1);
    expect(seen[1]).toBe(2);

    const { proposals } = await caller.call('proposal.list', { projectId: s.project.id });
    expect(proposals.map((p) => p.targetRef)).toEqual([
      { entity: 'Requirement', id: requirement.id },
      { entity: 'Requirement', id: requirement.id },
    ]);
    // 알림은 식별자 · 상태만 싣는다 (본문 · 근거는 다시 조회)
    expect(received.filter((n) => n.method === 'event.proposal.changed')).toEqual(
      proposals.map((p) => ({
        method: 'event.proposal.changed',
        params: {
          projectId: s.project.id,
          proposalId: p.id,
          displayId: p.displayId,
          kind: 'rule_new',
          state: 'pending',
        },
      })),
    );
    // 인증 전 연결은 받지 않는다
    expect(anonymous.unmatched).toEqual([]);
  }, 60_000);

  it('승인 · 수정 후 승인 · 거절이 저장되면 그 제안의 처리 상태로 알림이 가고, 받은 순간 proposal.count가 줄어 있다', async () => {
    const { s, watcher, caller } = await startWithRuleWriter();
    const counts: Promise<string>[] = [];
    const received = collect(watcher, (notice) => {
      if (notice.method !== 'event.proposal.changed' || notice.params.state === 'pending') return;
      counts.push(
        caller
          .call('proposal.count', { projectId: s.project.id })
          .then(
            ({ pending }) =>
              `${notice.params.displayId} ${notice.params.state} 대기 ${String(pending)}`,
          ),
      );
    });
    const { requirement } = await caller.call('requirement.create', {
      projectId: s.project.id,
      text: '헬스 체크 응답에 서버 시각 포함',
      author: human,
    });
    await s.orchestrator.ruleWriter.whenSettled(s.project.id, requirement.id);
    // 세 번째 제안은 저장소에 바로 넣는다(준비 단계, 알림 대상 아님): 승인 · 수정 후 승인 · 거절을 하나씩 하려고
    const first = await caller.call('proposal.list', { projectId: s.project.id });
    const template = first.proposals[1];
    if (template === undefined) throw new Error('제안 부족');
    withProject(s.biveHome, s.project.id, (store) =>
      submitProposal(
        store,
        {
          kind: 'rule_new',
          payload: { ...(template.payload as object), title: '헬스 체크 응답 형식 (별안)' },
          rationale: template.rationale,
          author: { kind: 'agent', role: 'rule-writer' },
          source: 'rule_generation',
        },
        { now: Date.now, newId },
      ),
    );
    const { proposals } = await caller.call('proposal.list', {
      projectId: s.project.id,
      state: 'pending',
    });
    expect(proposals).toHaveLength(3);
    const [a, b, c] = proposals;
    if (a === undefined || b === undefined || c === undefined) throw new Error('제안 부족');
    const total = proposals.length;

    // 처리 하나마다 그 알림의 재조회가 끝난 뒤 다음 처리를 한다(받은 순간의 수를 처리별로 본다)
    const nextCount = async (n: number): Promise<void> => {
      await waitFor(() => counts.length === n, 10_000, `처리 알림 ${String(n)}건`);
      await counts[n - 1];
    };
    await caller.call('proposal.approve', { projectId: s.project.id, id: a.id, author: human });
    await nextCount(1);
    await caller.call('proposal.amend', {
      projectId: s.project.id,
      id: b.id,
      author: human,
      edited: { ...(b.payload as object), title: '헬스 체크 응답 형식 유지 (수정)' } as never,
    });
    await nextCount(2);
    await caller.call('proposal.reject', {
      projectId: s.project.id,
      id: c.id,
      author: human,
      reason: '범위 밖',
    });
    await nextCount(3);
    expect(await Promise.all(counts)).toEqual([
      `${a.displayId} approved 대기 ${String(total - 1)}`,
      `${b.displayId} approved 대기 ${String(total - 2)}`,
      `${c.displayId} rejected 대기 ${String(total - 3)}`,
    ]);
    // 실패한 처리(이미 처리된 제안 재승인)는 저장이 없으므로 알리지 않는다
    const before = received.length;
    await expect(
      caller.call('proposal.approve', { projectId: s.project.id, id: a.id, author: human }),
    ).rejects.toMatchObject({ code: -32009 });
    await caller.call('ping');
    expect(received).toHaveLength(before);
  }, 60_000);
});

describe('ProposalEventPublisher', () => {
  it('서버가 없으면 보내지 않고, 송신이 거부되거나 던져도 부른 쪽에 예외를 넘기지 않고 기록만 남긴다', async () => {
    const logs: string[] = [];
    let sink: { notify: (method: string, params: unknown) => Promise<void> } | null = null;
    const publisher = new ProposalEventPublisher({
      sink: () => sink as never,
      log: (line) => logs.push(line),
    });
    const proposal = {
      id: '01JP0000000000000000000001',
      displayId: 'PRP-001',
      kind: 'rule_new',
      state: 'pending',
    } as Proposal;
    expect(() => publisher.changed('01JA0000000000000000000001', proposal)).not.toThrow();
    sink = { notify: () => Promise.reject(new Error('끊김')) };
    publisher.changed('01JA0000000000000000000001', proposal);
    sink = {
      notify: () => {
        throw new Error('스키마');
      },
    };
    publisher.changed('01JA0000000000000000000001', proposal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logs.sort()).toEqual(['제안 알림 전달 실패: 끊김', '제안 알림 전달 실패: 스키마']);
  });
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
