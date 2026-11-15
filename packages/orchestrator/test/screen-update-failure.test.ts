// 병합 뒤 화면 갱신 단계가 실패한 실행의 상태 · 표시 (M2-08 #174, RUN-02 · RUN-08 · JDG-03 · SCR-05, ADR-072 · ADR-076 ·
// ADR-091). 픽스처 git 복사본 · 실제 git 병합 · 실제 SQLite · ScriptedAdapter · 제품 단계 실행기(판정 · 설치만 주입,
// `pipeline-merge.test.ts`와 같은 하네스)에 제품 알림 발행기(`RunEventPublisher`)를 잇고, 알림을 보낼 곳(`sink.notify`)만
// 예외를 내는 대역으로 바꾼다.
// - 병합 커밋이 기준 브랜치에 들어간 뒤 화면 갱신 단계가 실패하면 실행은 `merged`(병합 커밋 기록, 실패 사유 없음)로 끝나고
//   화면 갱신 단계 시도만 `failed`로 남는다(ADR-091). `run.get` · `verification.summary`가 그 실행을 병합 완료 · 판정 기준으로 본다
// - 대조: 병합 전 단계에서 실패한 실행은 여전히 `failed`이고 병합 커밋이 없다
import fs from 'node:fs';

import { METHODS, type NotificationName } from '@bive/shared';
import { afterEach, describe, expect, it } from 'vitest';

import type { PipelineEngine } from '../src/engine/pipeline-engine.js';
import { type NotificationSink, RunEventPublisher } from '../src/events/run-events.js';
import { createRunHandlers } from '../src/ipc/run-handlers.js';
import { createVerificationHandlers } from '../src/ipc/verification-handlers.js';
import { userGit } from './helpers/engine-harness.js';
import {
  attempts,
  exitOf,
  judgmentsOf,
  type PipelineHarness,
  type PipelineSetupOptions,
  runToEnd,
  setupPipeline,
  stepOf,
} from './helpers/pipeline-harness.js';
import { cleanup } from './helpers/process.js';

const temps: string[] = [];
const engines: PipelineEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}, 120_000);

const setup = (options: Omit<PipelineSetupOptions, 'temps' | 'engines'> = {}): PipelineHarness =>
  setupPipeline({ ...options, temps, engines });

const mainTip = (h: PipelineHarness): string => userGit(h.repo, 'rev-parse', 'refs/heads/main');
const mergeCount = (h: PipelineHarness): number =>
  Number(userGit(h.repo, 'rev-list', '--merges', '--count', 'refs/heads/main'));

/** 보낸 알림 기록 (`이름 실행 상태:현재 단계`). */
interface SinkProbe {
  sent: string[];
}

/**
 * 제품 발행기에 잇는 알림 대역. `fail`이 정한 알림에서 예외를 낸다: `throw`는 보내는 쪽 스키마 검증처럼 그 자리에서
 * 던지고(`PipeServer.notify`의 `createNotification`), `reject`는 거부된 약속을 돌려준다.
 */
const failingSink =
  (
    probe: SinkProbe,
    fail: {
      mode: 'throw' | 'reject';
      when: (method: NotificationName, params: unknown) => boolean;
    },
  ) =>
  (biveHome: string) => {
    const sink: NotificationSink = {
      notify: (method, params) => {
        const run = params as { status?: string; currentStep?: string | null };
        probe.sent.push(`${method} ${String(run.status)}:${String(run.currentStep)}`);
        if (!fail.when(method, params)) return Promise.resolve();
        const error = new Error(`알림 송신 실패 (${method})`);
        if (fail.mode === 'throw') throw error;
        return Promise.reject(error);
      },
    };
    const publisher = new RunEventPublisher({ biveHome, sink: () => sink });
    return (event: Parameters<RunEventPublisher['publish']>[0]) => publisher.publish(event);
  };

/** 화면 갱신 단계가 보내는 `event.run.updated`(실행이 아직 화면 갱신 단계에 있는 알림)인지. */
const screenUpdateNotice = (method: NotificationName, params: unknown): boolean =>
  method === 'event.run.updated' &&
  (params as { status: string; currentStep: string | null }).status === 'running' &&
  (params as { currentStep: string | null }).currentStep === 'screen_update';

const runGet = async (h: PipelineHarness) => {
  const handler = createRunHandlers({ biveHome: h.biveHome, now: Date.now })['run.get'];
  if (handler === undefined) throw new Error('run.get 처리기 없음');
  return METHODS['run.get'].result.parse(
    await handler({ projectId: h.project.id, id: 'EXE-001' }, { connectionId: 1 }),
  );
};

const summaryOf = async (h: PipelineHarness) => {
  const handler = createVerificationHandlers({ biveHome: h.biveHome })['verification.summary'];
  if (handler === undefined) throw new Error('verification.summary 처리기 없음');
  return METHODS['verification.summary'].result.parse(
    await handler({ projectId: h.project.id }, { connectionId: 1 }),
  );
};

describe('병합 커밋이 만들어진 뒤 화면 갱신 단계가 실패하면 (수용 기준 1, ADR-091)', () => {
  for (const mode of ['throw', 'reject'] as const) {
    it(`알림 송신 예외(${mode}) → 실행 merged(병합 커밋 기록, 실패 사유 없음), 화면 갱신 단계만 failed`, async () => {
      const probe: SinkProbe = { sent: [] };
      const h = setup({ onEvent: failingSink(probe, { mode, when: screenUpdateNotice }) });
      const base = mainTip(h);
      const done = await runToEnd(h);

      // 기준 브랜치에 병합 커밋이 있다 (되돌릴 수 없는 사실)
      const merge = String(done.run.mergeCommit);
      expect(merge).toMatch(/^[0-9a-f]{40}$/);
      expect(mainTip(h)).toBe(merge);
      expect(mainTip(h)).not.toBe(base);
      expect(mergeCount(h)).toBe(1);

      // 실행은 병합 완료로 끝난다. 화면 갱신 단계 시도만 실패로 남는다
      expect(done.run).toMatchObject({
        status: 'merged',
        failureReason: null,
        currentStep: null,
        lastCompletedStep: 'merge',
        mergeCommit: merge,
      });
      expect(done.run.endedAt).not.toBeNull();
      expect(attempts(done, 'check', 'mutation', 'merge', 'screen_update')).toEqual([
        'check#1:passed',
        'mutation#1:skipped',
        'merge#1:passed',
        'screen_update#1:failed',
      ]);
      expect(exitOf(done, 'screen_update')).toEqual({
        reason: 'step_error',
        detail: { message: '알림 송신 실패 (event.run.updated)' },
      });
      expect(stepOf(done, 'screen_update').endedAt).not.toBeNull();
      // 화면 갱신 알림은 시도했고, 끝난 뒤의 저장 알림은 병합 완료다(다시 조회하는 화면이 사실을 읽는다)
      expect(probe.sent).toContain('event.run.updated running:screen_update');
      expect(probe.sent.at(-1)).toBe('event.run.updated merged:null');
    }, 60_000);
  }

  it('화면 갱신 단계의 완료 저장이 실패해도(저장 예외 → 엔진 예외 처리) 실행 merged, 화면 갱신 단계만 failed', async () => {
    // JSON으로 저장할 수 없는 종료 조건 결과 → completeStep 저장에서 예외 (engine.test.ts "결과 저장 실패"와 같은 방법)
    const h = setup({
      executors: (defaults) => ({
        ...defaults,
        screen_update: () => Promise.resolve({ status: 'passed', exitDetail: { n: 1n } }),
      }),
    });
    const done = await runToEnd(h);
    expect(mainTip(h)).toBe(String(done.run.mergeCommit));
    expect(done.run).toMatchObject({ status: 'merged', failureReason: null, currentStep: null });
    expect(stepOf(done, 'screen_update')).toMatchObject({
      status: 'failed',
      exitDetail: { reason: 'step_error', detail: { message: expect.any(String) } },
    });
    expect(h.engine.activeRunIds).toEqual([]);
  }, 60_000);

  it('대조: 병합 전 단계(검사)에서 실패한 실행은 failed(step_error), 병합 커밋 없음, 기준 브랜치 그대로', async () => {
    const probe: SinkProbe = { sent: [] };
    const h = setup({
      onEvent: failingSink(probe, { mode: 'throw', when: screenUpdateNotice }),
      executors: (defaults) => ({
        ...defaults,
        check: () => Promise.reject(new Error('검사 폭발')),
      }),
    });
    const base = mainTip(h);
    const done = await runToEnd(h);
    expect(done.run).toMatchObject({
      status: 'failed',
      failureReason: 'step_error',
      currentStep: 'check',
      mergeCommit: null,
    });
    expect(attempts(done, 'check', 'merge', 'screen_update')).toEqual([
      'check#1:failed',
      'merge#1:pending',
      'screen_update#1:pending',
    ]);
    expect(mainTip(h)).toBe(base);
    expect(mergeCount(h)).toBe(0);
    expect((await runGet(h)).run).toMatchObject({ status: 'failed', mergeCommit: null });
    expect((await summaryOf(h)).basis).toBeNull();
  }, 60_000);
});

describe('run.get · verification.summary가 그 실행을 병합 완료로 본다 (수용 기준 3 · 4, ADR-091)', () => {
  it('run.get: merged · 병합 커밋 · 화면 갱신 단계 실패. verification.summary: 판정 기준 = 그 실행의 병합 커밋, 준수 · 목록에 그 실행의 판정', async () => {
    const probe: SinkProbe = { sent: [] };
    const h = setup({ onEvent: failingSink(probe, { mode: 'throw', when: screenUpdateNotice }) });
    const done = await runToEnd(h);
    const merge = String(done.run.mergeCommit);
    expect(mainTip(h)).toBe(merge);

    const got = await runGet(h);
    expect(got.run).toMatchObject({
      displayId: 'EXE-001',
      status: 'merged',
      failureReason: null,
      currentStep: null,
      mergeCommit: merge,
    });
    expect(got.steps.find((step) => step.kind === 'screen_update')?.status).toBe('failed');
    expect(got.steps.find((step) => step.kind === 'merge')?.status).toBe('passed');

    const summary = await summaryOf(h);
    // 판정 기준: 기준 브랜치의 지금 끝(= 이 실행의 병합 커밋)
    expect(summary.basis).toEqual({ branch: 'main', commit: merge, runId: h.runId });
    // 기준 브랜치가 움직이지 않아 재검사가 없었으므로 검사 단계 판정(headCommit)이 기준 커밋의 판정이다 (ADR-072)
    const check = judgmentsOf(h).find((record) => record.stepId === stepOf(done, 'check').id);
    expect(check).toMatchObject({ ruleId: h.rule.id, status: 'pass', commit: done.run.headCommit });
    expect(summary.compliance).toEqual({ passed: 1, judgeable: 1 });
    expect(summary.denominator).toEqual([h.rule.id]);
    expect(summary.rules).toHaveLength(1);
    expect(summary.rules[0]).toMatchObject({
      rule: { id: h.rule.id },
      judgment: { status: 'pass', latest: { id: check?.id, runId: h.runId } },
      run: { id: h.runId, displayId: 'EXE-001' },
    });
    // 파이프라인: 최근 실행은 병합 완료, 화면 갱신 단계만 실패
    expect(summary.pipeline?.run).toMatchObject({ status: 'merged', currentStep: null });
    expect(summary.pipeline?.stages.map((stage) => `${stage.kind}:${stage.status}`)).toEqual([
      'approval:passed',
      'test_writing:passed',
      'red_check:passed',
      'implementation:passed',
      'check:passed',
      'mutation:skipped',
      'merge:passed',
      'screen_update:failed',
    ]);
  }, 60_000);
});
