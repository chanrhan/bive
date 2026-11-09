// 실행 모델 · 생성 RPC · 상태 저장 (M1-12 수용 기준, RUN-01 · RUN-02 · NFR-07 · NFR-01 · ADR-027 · ADR-061).
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소. 재시작 시험은 오케스트레이터 프로세스를 실제로 띄우고 죽인다.
import { readFileSync } from 'node:fs';

import {
  APPROVAL_LOG_GENESIS_HASH,
  type Author,
  createUlidGenerator,
  ErrorCode,
  type Project,
  RUN_STEP_PLANS,
  type Rule,
  type SettingsPatch,
  SETTINGS_INCOMPLETE_MESSAGE,
  SETTINGS_INCOMPLETE_REASON,
  type Step,
  type StepKind,
} from '@bive/shared';
import { openProjectStore, registerProject, type ProjectStore } from '@bive/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PipeServer } from '../src/ipc/server.js';
import { runPaths } from '../src/run-paths.js';
import { completeStep, evaluateApprovalStep, RunService } from '../src/runs/run-service.js';
import { connect, RpcCallError, type TestClient } from './helpers/client.js';
import { cleanup, makeBiveHome, spawnCli, type Spawned, waitFor } from './helpers/process.js';
import { iso, startProjectHarness, T0, type ProjectHarness } from './helpers/project-harness.js';

const human = { kind: 'human' } as const satisfies Author;
const implementerAgent = { kind: 'agent', role: 'implementer' } as const satisfies Author;
const SHA = 'c'.repeat(40);

const newId = createUlidGenerator();

/** roadmap M1 흐름 2 · 6의 값: 실행 전체 USD 5 · 턴 200, rule-writer USD 1 · 턴 20, 실행 역할 USD 2 · 턴 100. */
const RULE_WRITER_ONLY: SettingsPatch = {
  run: { maxBudgetUsd: 5, maxTurns: 200 },
  roles: { 'rule-writer': { model: 'test-model', maxBudgetUsd: 1, maxTurns: 20 } },
};
const COMPLETE: SettingsPatch = {
  run: RULE_WRITER_ONLY.run,
  roles: {
    ...RULE_WRITER_ONLY.roles,
    'test-writer': { model: 'test-model', maxBudgetUsd: 2, maxTurns: 100 },
    implementer: { model: 'impl-model', maxBudgetUsd: 3, maxTurns: 150 },
  },
};

const rpcError = async (promise: Promise<unknown>): Promise<RpcCallError> => {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcCallError);
  return error as RpcCallError;
};

const stepOf = (steps: readonly Step[], kind: StepKind, attempt = 1): Step => {
  const step = steps.find((s) => s.kind === kind && s.attempt === attempt);
  if (step === undefined) throw new Error(`단계 없음: ${kind}#${String(attempt)}`);
  return step;
};

/** 저장소에 규칙을 바로 넣는다 (잠정 승인처럼 RPC로 만들 수 없는 상태용). */
const insertRule = (store: ProjectStore, normState: Rule['normState'] = 'approved'): Rule => {
  const requirement = store.requirements.create({
    id: newId(),
    text: '헬스 체크 응답에 서버 시각 포함',
    author: human,
    normState: 'approved',
    createdAt: iso(T0),
  });
  return store.rules.create({
    id: newId(),
    title: '헬스 체크 서버 시각',
    statement: 'WHEN GET /api/health를 요청하면 THE SYSTEM SHALL 응답에 서버 시각을 포함한다',
    kind: 'business',
    checkKinds: ['test'],
    parentRequirementId: requirement.id,
    builtin: false,
    targetBlockIds: [],
    risk: null,
    contractId: null,
    author: { kind: 'agent', role: 'rule-writer' },
    normState,
    createdAt: iso(T0),
  });
};

describe('파이프 RPC (실제 처리기 · 고정 시계)', () => {
  const servers: PipeServer[] = [];
  const clients: TestClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    for (const server of servers.splice(0)) await server.close();
    await cleanup();
  });

  let h: ProjectHarness;
  beforeEach(async () => {
    h = await startProjectHarness({ servers, clients });
  });

  const saveSettings = (patch: SettingsPatch) =>
    h.client.call('settings.update', { projectId: h.project.id, patch, author: human });

  /** 요구사항 작성 → rule-writer 제안 → 사람 승인 (roadmap M1 흐름 3 · 4와 같은 경로). */
  const approvedRule = async (title = '헬스 체크 서버 시각'): Promise<Rule> => {
    const { requirement } = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '헬스 체크 응답에 서버 시각 포함',
      author: human,
    });
    const proposal = h.proposals.submit(h.project.id, {
      kind: 'rule_new',
      payload: {
        title,
        statement: 'WHEN GET /api/health를 요청하면 THE SYSTEM SHALL 응답에 서버 시각을 포함한다',
        kind: 'business',
        checkKinds: ['test'],
        parentRequirementId: requirement.id,
      },
      rationale: '요구사항의 기본 경로',
      author: { kind: 'agent', role: 'rule-writer' },
      source: 'rule_generation',
    });
    const { applied } = await h.client.call('proposal.approve', {
      projectId: h.project.id,
      id: proposal.id,
      author: human,
    });
    if (applied.entity !== 'Rule') throw new Error('규칙이 반영되지 않았습니다');
    return applied.rule;
  };

  const create = (ruleIds: string[], author: Author = human) =>
    h.client.call('run.create', { projectId: h.project.id, ruleIds, author });

  const runCount = (): number => h.read((store) => store.runs.list().length);
  const runStartCount = (): number =>
    h.read((store) => store.approvalLog.list().filter((e) => e.action === 'run_start').length);

  describe('run.create: 실행 저장 + 승인 기록 run_start (수용 기준 1)', () => {
    it('표시 ID EXE-001 · 대상 규칙 · 유형 A · 단계 8개를 저장하고 run_start를 같은 시각으로 남긴다', async () => {
      const rule = await approvedRule();
      await saveSettings(COMPLETE);
      h.clock.now = T0 + 60_000;
      const logBefore = h.read((store) => store.approvalLog.list());

      const created = await create([rule.id]);

      expect(created.run).toMatchObject({
        displayId: 'EXE-001',
        projectId: h.project.id,
        type: 'A',
        targetRuleIds: [rule.id],
        status: 'waiting_approval',
        currentStep: 'approval',
        lastCompletedStep: null,
        regressionCount: 0,
        failureReason: null,
        branch: null,
        worktreePath: null,
        baseBranch: h.project.baseBranch,
        baseCommit: null,
        startedBy: human,
        createdAt: iso(T0 + 60_000),
        startedAt: null,
        endedAt: null,
      });
      // 단계 목록: 유형 A 순서, 승인만 진행 중(생성 시각에 시작), 나머지 대기. 역할은 테스트 작성 · 구현만
      expect(created.steps.map((s) => s.kind)).toEqual([...RUN_STEP_PLANS.A]);
      expect(created.steps.map((s) => [s.kind, s.status, s.role, s.attempt])).toEqual([
        ['approval', 'running', null, 1],
        ['test_writing', 'pending', 'test-writer', 1],
        ['red_check', 'pending', null, 1],
        ['implementation', 'pending', 'implementer', 1],
        ['check', 'pending', null, 1],
        ['mutation', 'pending', null, 1],
        ['merge', 'pending', null, 1],
        ['screen_update', 'pending', null, 1],
      ]);
      expect(stepOf(created.steps, 'approval').startedAt).toBe(iso(T0 + 60_000));
      expect(created.steps.every((s) => s.runId === created.run.id)).toBe(true);
      // 예산 · 모델 스냅샷 = 시작 시 설정의 실행 전체 한도 + 실행이 쓰는 역할(test-writer · implementer)
      expect(created.run.budgetSnapshot).toEqual({
        run: { maxBudgetUsd: 5, maxTurns: 200 },
        roles: {
          'test-writer': { maxBudgetUsd: 2, maxTurns: 100 },
          implementer: { maxBudgetUsd: 3, maxTurns: 150 },
        },
      });
      expect(created.run.modelSnapshot).toEqual({
        'test-writer': 'test-model',
        implementer: 'impl-model',
      });

      // 승인 기록: 규칙 승인 기록 뒤에 run_start 1건, 주체 사람 · 대상 실행 · 대상 규칙 · 연결 번호
      expect(created.approvalLog).toMatchObject({
        seq: logBefore.length + 1,
        at: iso(T0 + 60_000),
        action: 'run_start',
        actor: human,
        targetRef: { entity: 'Run', id: created.run.id },
        detail: { ruleIds: [rule.id] },
        prevHash: logBefore.at(-1)?.hash ?? APPROVAL_LOG_GENESIS_HASH,
      });
      expect(created.approvalLog.clientId).toMatch(/^pipe-\d+$/);
      const log = await h.client.call('approvalLog.list', {
        projectId: h.project.id,
        targetRef: { entity: 'Run', id: created.run.id },
      });
      expect(log.entries).toEqual([created.approvalLog]);
      expect(log.chain).toEqual({ valid: true, brokenAtSeq: null, reason: null });

      // 저장된 값 = 돌려준 값 (ULID · 표시 ID 어느 쪽으로도 조회)
      const detail = { run: created.run, steps: created.steps };
      expect(
        await h.client.call('run.get', { projectId: h.project.id, id: created.run.id }),
      ).toEqual(detail);
      expect(await h.client.call('run.get', { projectId: h.project.id, id: 'EXE-001' })).toEqual(
        detail,
      );
      expect(h.read((store) => store.runs.getDetail(created.run.id))).toEqual(detail);
      expect(await h.client.call('run.list', { projectId: h.project.id })).toEqual({
        runs: [created.run],
      });
    });

    it('대상 규칙 여러 개는 요청 순서대로 저장하고 run_start에도 그 순서로 남긴다', async () => {
      const a = await approvedRule('규칙 가');
      const b = await approvedRule('규칙 나');
      await saveSettings(COMPLETE);
      const created = await create([b.id, a.id]);
      expect(created.run.targetRuleIds).toEqual([b.id, a.id]);
      expect(created.approvalLog.detail).toEqual({ ruleIds: [b.id, a.id] });
    });

    it('동시에 여러 번 만들어도 표시 ID가 겹치지 않고 run_start도 실행마다 1건이다', async () => {
      const rule = await approvedRule();
      await saveSettings(COMPLETE);
      const second = await connect(h.socketPath, 'tok');
      clients.push(second);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          (i % 2 === 0 ? h.client : second).call('run.create', {
            projectId: h.project.id,
            ruleIds: [rule.id],
            author: human,
          }),
        ),
      );
      const ids = results.map((r) => r.run.displayId).sort();
      expect(ids).toEqual(['EXE-001', 'EXE-002', 'EXE-003', 'EXE-004', 'EXE-005', 'EXE-006']);
      expect(new Set(results.map((r) => r.approvalLog.seq)).size).toBe(6);
      expect(runStartCount()).toBe(6);
      const listed = await h.client.call('run.list', { projectId: h.project.id });
      expect(listed.runs.map((r) => r.displayId)).toEqual(ids);
      expect(
        (await h.client.call('approvalLog.list', { projectId: h.project.id })).chain.valid,
      ).toBe(true);
    });

    it('run.list는 상태로 거른다', async () => {
      const rule = await approvedRule();
      await saveSettings(COMPLETE);
      const first = await create([rule.id]);
      await create([rule.id]);
      h.read((store) => evaluateApprovalStep(store, first.run.id, { now: () => T0 }));
      const running = await h.client.call('run.list', {
        projectId: h.project.id,
        status: 'running',
      });
      expect(running.runs.map((r) => r.displayId)).toEqual(['EXE-001']);
      const waiting = await h.client.call('run.list', {
        projectId: h.project.id,
        status: 'waiting_approval',
      });
      expect(waiting.runs.map((r) => r.displayId)).toEqual(['EXE-002']);
    });
  });

  describe('run.create: 설정 검증 실패는 -32010이고 실행이 만들어지지 않는다 (수용 기준 2, NFR-07)', () => {
    it('한 번도 저장하지 않은 설정: 실행 · run_start · 표시 ID 순번이 남지 않는다', async () => {
      const rule = await approvedRule();
      const error = await rpcError(create([rule.id]));
      expect(error.code).toBe(ErrorCode.SettingsIncomplete);
      expect(error.code).toBe(-32010);
      expect(error.message).toBe(`-32010 ${SETTINGS_INCOMPLETE_MESSAGE}`);
      expect(error.data).toMatchObject({ reason: SETTINGS_INCOMPLETE_REASON });
      expect((error.data as { missing: string[] }).missing).toContain('run.maxBudgetUsd');
      expect(runCount()).toBe(0);
      expect(runStartCount()).toBe(0);
      expect((await h.client.call('run.list', { projectId: h.project.id })).runs).toEqual([]);
      expect(h.read((store) => store.sequences.last('EXE'))).toBe(0);
    });

    it('rule-writer만 저장한 상태(roadmap M1 흐름 5): 빈 항목은 test-writer · implementer, 채운 뒤에는 EXE-001', async () => {
      const rule = await approvedRule();
      await saveSettings(RULE_WRITER_ONLY);
      const error = await rpcError(create([rule.id]));
      expect(error.code).toBe(-32010);
      expect(error.data).toEqual({
        reason: SETTINGS_INCOMPLETE_REASON,
        missing: [
          'roles.test-writer.model',
          'roles.test-writer.maxBudgetUsd',
          'roles.test-writer.maxTurns',
          'roles.implementer.model',
          'roles.implementer.maxBudgetUsd',
          'roles.implementer.maxTurns',
        ],
      });
      expect(runCount()).toBe(0);
      expect(runStartCount()).toBe(0);

      await saveSettings(COMPLETE);
      expect((await create([rule.id])).run.displayId).toBe('EXE-001');
    });

    it('실행 전체 한도 하나만 비워도 거부한다', async () => {
      const rule = await approvedRule();
      await saveSettings(COMPLETE);
      await saveSettings({ run: { maxTurns: null } });
      const error = await rpcError(create([rule.id]));
      expect(error.code).toBe(-32010);
      expect(error.data).toEqual({ reason: SETTINGS_INCOMPLETE_REASON, missing: ['run.maxTurns'] });
      expect(runCount()).toBe(0);
    });
  });

  describe('run.create: 주체 · 대상 오류', () => {
    it('에이전트 주체는 -32020이고 설정 · 규칙과 무관하게 아무것도 만들지 않는다 (NFR-01)', async () => {
      const rule = await approvedRule();
      await saveSettings(COMPLETE);
      expect((await rpcError(create([rule.id], implementerAgent))).code).toBe(
        ErrorCode.Unauthorized,
      );
      expect(runCount()).toBe(0);
      expect(runStartCount()).toBe(0);
    });

    it('없는 규칙 -32004, 삭제된 규칙 -32009, 등록되지 않은 프로젝트 -32004, 중복 규칙 -32602', async () => {
      const rule = await approvedRule();
      await saveSettings(COMPLETE);
      expect((await rpcError(create([rule.id, newId()]))).code).toBe(ErrorCode.NotFound);
      h.read((store) =>
        store.db.prepare('UPDATE rules SET deleted_at = ? WHERE id = ?').run(iso(T0), rule.id),
      );
      expect((await rpcError(create([rule.id]))).code).toBe(ErrorCode.StateConflict);
      expect(
        (
          await rpcError(
            h.client.call('run.create', { projectId: newId(), ruleIds: [rule.id], author: human }),
          )
        ).code,
      ).toBe(ErrorCode.NotFound);
      const raw = (await h.client.requestRaw({
        jsonrpc: '2.0',
        id: 'dup',
        method: 'run.create',
        params: { projectId: h.project.id, ruleIds: [rule.id, rule.id], author: human },
      })) as { error?: { code: number } };
      expect(raw.error?.code).toBe(ErrorCode.InvalidParams);
      expect(runCount()).toBe(0);
      expect(runStartCount()).toBe(0);
      expect(h.read((store) => store.sequences.last('EXE'))).toBe(0);
    });

    it('run.get: 없는 실행은 ULID · 표시 ID 모두 -32004', async () => {
      for (const id of [newId(), 'EXE-001']) {
        expect(
          (await rpcError(h.client.call('run.get', { projectId: h.project.id, id }))).code,
        ).toBe(ErrorCode.NotFound);
      }
    });
  });

  describe('승인 단계 (수용 기준 3, RUN-02)', () => {
    it('대상 규칙이 전부 승인 상태면 승인 단계가 끝나고 실행이 running, 테스트 작성이 시작된다', async () => {
      const rule = await approvedRule();
      await saveSettings(COMPLETE);
      const created = await create([rule.id]);
      const at = T0 + 120_000;

      const result = h.read((store) =>
        evaluateApprovalStep(store, created.run.id, { now: () => at }),
      );

      expect(result.approved).toBe(true);
      expect(result.unapprovedRuleIds).toEqual([]);
      expect(result.run).toMatchObject({
        status: 'running',
        currentStep: 'test_writing',
        lastCompletedStep: 'approval',
        startedAt: iso(at),
      });
      expect(stepOf(result.steps, 'approval')).toMatchObject({
        status: 'passed',
        endedAt: iso(at),
        exitDetail: { approvedRuleIds: [rule.id] },
      });
      expect(stepOf(result.steps, 'test_writing')).toMatchObject({
        status: 'running',
        startedAt: iso(at),
      });
      expect(
        await h.client.call('run.get', { projectId: h.project.id, id: created.run.id }),
      ).toEqual({ run: result.run, steps: result.steps });
      // 승인 단계가 끝난 실행은 다시 판정하지 않는다
      expect(() =>
        h.read((store) => evaluateApprovalStep(store, created.run.id, { now: () => at })),
      ).toThrow(/승인 단계가 아닙니다/);
    });

    it('승인 상태가 아닌 규칙(잠정 승인 · 삭제)이 하나라도 있으면 waiting_approval에 머물고 아무것도 저장하지 않는다', async () => {
      const approved = await approvedRule();
      const provisional = h.read((store) => insertRule(store, 'provisional'));
      await saveSettings(COMPLETE);
      const created = await create([approved.id, provisional.id]);
      const before = await h.client.call('run.get', {
        projectId: h.project.id,
        id: created.run.id,
      });

      const waiting = h.read((store) =>
        evaluateApprovalStep(store, created.run.id, { now: () => T0 + 1 }),
      );
      expect(waiting.approved).toBe(false);
      expect(waiting.unapprovedRuleIds).toEqual([provisional.id]);
      expect(waiting.run.status).toBe('waiting_approval');
      expect(waiting.run.currentStep).toBe('approval');
      expect(stepOf(waiting.steps, 'approval').status).toBe('running');
      expect(stepOf(waiting.steps, 'test_writing').status).toBe('pending');
      expect(
        await h.client.call('run.get', { projectId: h.project.id, id: created.run.id }),
      ).toEqual(before);

      // 승인된 규칙이 실행 생성 뒤 삭제돼도 승인 단계는 끝나지 않는다
      h.read((store) => {
        store.db
          .prepare(`UPDATE rules SET norm_state = 'approved' WHERE id = ?`)
          .run(provisional.id);
        store.db.prepare('UPDATE rules SET deleted_at = ? WHERE id = ?').run(iso(T0), approved.id);
      });
      const stillWaiting = h.read((store) =>
        evaluateApprovalStep(store, created.run.id, { now: () => T0 + 2 }),
      );
      expect(stillWaiting.approved).toBe(false);
      expect(stillWaiting.unapprovedRuleIds).toEqual([approved.id]);
      expect(
        await h.client.call('run.get', { projectId: h.project.id, id: created.run.id }),
      ).toEqual(before);

      // 남은 대상 규칙이 모두 승인 상태가 되면 그때 끝난다
      h.read((store) =>
        store.db.prepare('UPDATE rules SET deleted_at = NULL WHERE id = ?').run(approved.id),
      );
      const passed = h.read((store) =>
        evaluateApprovalStep(store, created.run.id, { now: () => T0 + 3 }),
      );
      expect(passed.approved).toBe(true);
      expect(passed.run.status).toBe('running');
    });
  });

  describe('단계 종료 저장은 트랜잭션 1회 (수용 기준 4 일부)', () => {
    it('실행 갱신이 실패하면 같은 저장의 단계 갱신도 남지 않는다', async () => {
      const rule = await approvedRule();
      await saveSettings(COMPLETE);
      const created = await create([rule.id]);
      h.read((store) => evaluateApprovalStep(store, created.run.id, { now: () => T0 + 1 }));
      const before = await h.client.call('run.get', {
        projectId: h.project.id,
        id: created.run.id,
      });

      const store = openProjectStore(h.project.id, { home: h.biveHome, create: false });
      try {
        // 이 연결에서만 실행 행 갱신을 실패시킨다 (단계 행을 먼저 쓴 뒤 마지막 쓰기에서 실패)
        store.db.exec(`CREATE TEMP TRIGGER fail_run_update BEFORE UPDATE ON main.runs
          BEGIN SELECT RAISE(ABORT, '주입된 실패'); END;`);
        expect(() =>
          completeStep(
            store,
            created.run.id,
            { status: 'passed', commit: SHA },
            { now: () => T0 + 2 },
          ),
        ).toThrow(/주입된 실패/);
      } finally {
        store.close();
      }
      expect(
        await h.client.call('run.get', { projectId: h.project.id, id: created.run.id }),
      ).toEqual(before);
    });

    it('진행 중이 아닌 실행의 단계 종료는 거부된다', async () => {
      const rule = await approvedRule();
      await saveSettings(COMPLETE);
      const created = await create([rule.id]);
      expect(() =>
        h.read((store) =>
          completeStep(store, created.run.id, { status: 'passed' }, { now: () => T0 }),
        ),
      ).toThrow(/running가 아닙니다/);
    });
  });
});

describe('프로세스 재시작 뒤 run.get이 같은 값 (수용 기준 4, RUN-01 · NFR-06)', () => {
  afterEach(async () => {
    await cleanup();
  });

  interface Running {
    proc: Spawned;
    client: TestClient;
  }

  /** 실제 오케스트레이터 프로세스를 띄우고 인증까지 마친다 (토큰은 기동마다 새로 만든다). */
  const start = async (biveHome: string): Promise<Running> => {
    const proc = spawnCli({ BIVE_HOME: biveHome, BIVE_IDLE_SHUTDOWN_MS: '60000' });
    await waitFor(() => proc.stdout.includes('오케스트레이터 기동'), 20_000, '오케스트레이터 기동');
    const paths = runPaths(biveHome);
    const client = await connect(paths.pipe, readFileSync(paths.token, 'utf8'));
    return { proc, client };
  };

  /** 비정상 종료(SIGKILL): 열린 트랜잭션이 없으면 커밋된 상태 저장은 모두 남아야 한다. */
  const kill = async ({ proc, client }: Running): Promise<void> => {
    client.destroy();
    proc.child.kill('SIGKILL');
    await proc.exited;
  };

  /** 등록된 프로젝트 + 설정 + 승인된 규칙 1개. */
  const seed = (biveHome: string): { project: Project; ruleId: string } => {
    const project = registerProject(
      {
        id: newId(),
        name: '샘플 앱',
        rootPath: '/work/sample-next-app',
        baseBranch: 'main',
        createdAt: iso(T0),
      },
      { home: biveHome },
    );
    const store = openProjectStore(project.id, { home: biveHome, create: false });
    try {
      store.settings.update(COMPLETE, { by: human, at: iso(T0) });
      return { project, ruleId: insertRule(store).id };
    } finally {
      store.close();
    }
  };

  it('생성 · 승인 단계 종료 · 테스트 작성 종료마다 저장된 값을 새 프로세스가 그대로 돌려준다', async () => {
    const biveHome = makeBiveHome();
    const { project, ruleId } = seed(biveHome);
    const engine = new RunService({ biveHome });

    // 1) 생성 직후
    let current = await start(biveHome);
    const created = await current.client.call('run.create', {
      projectId: project.id,
      ruleIds: [ruleId],
      author: human,
    });
    const afterCreate = await current.client.call('run.get', {
      projectId: project.id,
      id: created.run.id,
    });
    expect(afterCreate).toEqual({ run: created.run, steps: created.steps });
    await kill(current);

    current = await start(biveHome);
    expect(
      await current.client.call('run.get', { projectId: project.id, id: created.run.id }),
    ).toEqual(afterCreate);
    expect(await current.client.call('run.get', { projectId: project.id, id: 'EXE-001' })).toEqual(
      afterCreate,
    );

    // 2) 승인 단계 종료 (엔진 내부 API, 같은 DB) → 새 프로세스
    const approval = engine.evaluateApproval(project.id, created.run.id);
    expect(approval.approved).toBe(true);
    const afterApproval = { run: approval.run, steps: approval.steps };
    expect(
      await current.client.call('run.get', { projectId: project.id, id: created.run.id }),
    ).toEqual(afterApproval);
    await kill(current);

    current = await start(biveHome);
    expect(
      await current.client.call('run.get', { projectId: project.id, id: created.run.id }),
    ).toEqual(afterApproval);

    // 3) 테스트 작성 종료(커밋 · 비용 · 턴 · 종료 조건 결과) → 새 프로세스
    const afterTestWriting = engine.completeStep(project.id, created.run.id, {
      status: 'passed',
      exitDetail: { files: ['bive-acceptance/RULE-001/health.acc.ts'] },
      commit: SHA,
      costUsd: 0.0123,
      turns: 7,
      run: { headCommit: SHA },
    });
    expect(afterTestWriting.run).toMatchObject({
      status: 'running',
      currentStep: 'red_check',
      lastCompletedStep: 'test_writing',
      headCommit: SHA,
    });
    expect(stepOf(afterTestWriting.steps, 'test_writing')).toMatchObject({
      status: 'passed',
      commit: SHA,
      costUsd: 0.0123,
      turns: 7,
    });
    expect(stepOf(afterTestWriting.steps, 'red_check').status).toBe('running');
    await kill(current);

    current = await start(biveHome);
    expect(
      await current.client.call('run.get', { projectId: project.id, id: created.run.id }),
    ).toEqual(afterTestWriting);
    expect(await current.client.call('run.list', { projectId: project.id })).toEqual({
      runs: [afterTestWriting.run],
    });
    const log = await current.client.call('approvalLog.list', { projectId: project.id });
    expect(log.entries.map((e) => e.action)).toEqual(['run_start']);
    expect(log.chain.valid).toBe(true);
    await kill(current);
  }, 90_000);
});
