// 실행 모델 · 생성 RPC · 상태 저장 (M1-12 수용 기준, RUN-01 · RUN-02 · NFR-07 · NFR-01 · ADR-027 · ADR-061).
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소. 재시작 시험은 오케스트레이터 프로세스를 실제로 띄우고 죽인다.
import { readFileSync } from 'node:fs';

import {
  APPROVAL_LOG_GENESIS_HASH,
  type Author,
  createUlidGenerator,
  ErrorCode,
  type Project,
  type ContractKind,
  RUN_STEP_PLANS,
  type Rule,
  type RunType,
  type SettingsPatch,
  SETTINGS_INCOMPLETE_MESSAGE,
  SETTINGS_INCOMPLETE_REASON,
  STEP_ROLES,
  type Step,
  type StepKind,
  TOOL_CALL_NAME_DISPLAY_MAX,
  TOOL_CALL_PATH_DISPLAY_MAX,
} from '@bive/shared';
import { openProjectStore, registerProject, type ProjectStore } from '@bive/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PipeServer } from '../src/ipc/server.js';
import { runPaths } from '../src/run-paths.js';
import { INTERRUPTED_EXIT_DETAIL } from '../src/engine/pipeline-engine.js';
import {
  completeStep,
  createRun,
  evaluateApprovalStep,
  RunService,
} from '../src/runs/run-service.js';
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
    mutator: { model: 'mutator-model', maxBudgetUsd: 1, maxTurns: 50 },
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
      // 단계 목록: 유형 A 순서, 승인만 진행 중(생성 시각에 시작), 나머지 대기. 역할은 테스트 작성 · 구현 · 변이 주입(M3-07)
      expect(created.steps.map((s) => s.kind)).toEqual([...RUN_STEP_PLANS.A]);
      expect(created.steps.map((s) => [s.kind, s.status, s.role, s.attempt])).toEqual([
        ['approval', 'running', null, 1],
        ['test_writing', 'pending', 'test-writer', 1],
        ['red_check', 'pending', null, 1],
        ['implementation', 'pending', 'implementer', 1],
        ['check', 'pending', null, 1],
        ['mutation', 'pending', 'mutator', 1],
        ['merge', 'pending', null, 1],
        ['screen_update', 'pending', null, 1],
      ]);
      expect(stepOf(created.steps, 'approval').startedAt).toBe(iso(T0 + 60_000));
      expect(created.steps.every((s) => s.runId === created.run.id)).toBe(true);
      // 예산 · 모델 스냅샷 = 시작 시 설정의 실행 전체 한도 + 실행이 쓰는 역할(test-writer · implementer · mutator)
      expect(created.run.budgetSnapshot).toEqual({
        run: { maxBudgetUsd: 5, maxTurns: 200 },
        roles: {
          'test-writer': { maxBudgetUsd: 2, maxTurns: 100 },
          implementer: { maxBudgetUsd: 3, maxTurns: 150 },
          mutator: { maxBudgetUsd: 1, maxTurns: 50 },
        },
      });
      expect(created.run.modelSnapshot).toEqual({
        'test-writer': 'test-model',
        implementer: 'impl-model',
        mutator: 'mutator-model',
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
      // 세션이 없으므로 비용 · 턴 집계는 모두 '없음'(null, ADR-067)
      const detail = { run: created.run, steps: created.steps };
      const got = await h.client.call('run.get', { projectId: h.project.id, id: created.run.id });
      expect(got).toEqual({
        ...detail,
        usage: h.read((store) => store.runs.usage(created.run.id)),
        sessions: [],
      });
      expect(got.usage.run).toMatchObject({ costUsd: null, turns: null, modelUsage: null });
      expect(await h.client.call('run.get', { projectId: h.project.id, id: 'EXE-001' })).toEqual(
        got,
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

  describe('run.create: 실행 유형의 기록과 유형별 대상 규칙 (M3-06 #51 수용 기준 4, RUN-07, ADR-136)', () => {
    /** 내장 구조 규칙 (정적 검사 규칙). 블록 선언 저장이 만드는 행과 같은 모양 */
    const structureRule = (store: ProjectStore, title: string): Rule =>
      store.rules.create({
        id: newId(),
        title,
        statement:
          'WHEN 블록의 파일이 다른 블록을 가져오면 THE SYSTEM SHALL 선언한 방향만 허용한다',
        kind: 'architecture',
        checkKinds: ['structure'],
        parentRequirementId: null,
        builtin: true,
        targetBlockIds: [],
        risk: null,
        contractId: null,
        author: human,
        normState: 'approved',
        createdAt: iso(T0),
      });
    /** 계약 하나와 그 계약 검사 규칙 (정적 검사 규칙). 계약 등록이 만드는 행과 같은 모양 */
    const contractRule = (store: ProjectStore, kind: ContractKind): Rule => {
      const contract = store.contracts.create({
        id: newId(),
        kind,
        sourceFile: `contracts/${kind}.txt`,
        contentHash: 'a'.repeat(64),
        sourceCommit: SHA,
        parentRequirementId: null,
        author: human,
        createdAt: iso(T0),
      });
      return store.rules.create({
        id: newId(),
        title: `계약 일치: ${contract.displayId}`,
        statement: 'WHEN 요청이 오면 THE SYSTEM SHALL 계약대로 응답한다',
        kind: 'tech-constraint',
        checkKinds: ['contract'],
        parentRequirementId: null,
        builtin: true,
        targetBlockIds: [],
        risk: null,
        contractId: contract.id,
        author: human,
        normState: 'approved',
        createdAt: iso(T0),
      });
    };
    const createTyped = (ruleIds: string[], type?: RunType) =>
      h.client.call('run.create', {
        projectId: h.project.id,
        ruleIds,
        author: human,
        ...(type === undefined ? {} : { type }),
      });
    /** 거부되면 실행 · run_start가 하나도 남지 않는다 (-32009) */
    const expectRejected = async (
      ruleIds: string[],
      type?: RunType,
      message?: RegExp,
    ): Promise<void> => {
      const runsBefore = runCount();
      const logBefore = runStartCount();
      const error = await rpcError(createTyped(ruleIds, type));
      expect(error.code, `${String(type)} ${ruleIds.join(',')}`).toBe(ErrorCode.StateConflict);
      if (message !== undefined) expect(error.message).toMatch(message);
      expect(runCount()).toBe(runsBefore);
      expect(runStartCount()).toBe(logBefore);
    };

    it('유형을 주면 그대로 기록하고, 단계 목록 · 예산 · 모델 스냅샷은 그 유형의 계획 · 실제로 쓰는 역할을 따른다', async () => {
      const rule = await approvedRule();
      const structure = h.read((store) => structureRule(store, 'structure.declared-direction'));
      await saveSettings(COMPLETE);
      const roles = {
        // 변이 주입 역할은 변이 주입 단계를 하는 A · C에만 (M3-07 #52, ADR-139)
        A: ['test-writer', 'implementer', 'mutator'],
        B: ['implementer'],
        C: ['test-writer', 'mutator'],
        D: ['implementer'],
      } as const;
      for (const type of ['A', 'B', 'C', 'D'] as const) {
        const created = await createTyped([type === 'B' ? structure.id : rule.id], type);
        expect(created.run.type).toBe(type);
        expect(created.steps.map((s) => s.kind)).toEqual([...RUN_STEP_PLANS[type]]);
        expect(created.steps.map((s) => [s.kind, s.status, s.role])).toEqual(
          RUN_STEP_PLANS[type].map((kind, index) => [
            kind,
            index === 0 ? 'running' : 'pending',
            STEP_ROLES[kind],
          ]),
        );
        expect(Object.keys(created.run.budgetSnapshot.roles)).toEqual(roles[type]);
        expect(Object.keys(created.run.modelSnapshot)).toEqual(roles[type]);
        expect(created.approvalLog).toMatchObject({
          action: 'run_start',
          detail: { ruleIds: created.run.targetRuleIds },
        });
        // 저장된 값 = 돌려준 값
        expect(h.read((store) => store.runs.get(created.run.id))).toEqual(created.run);
      }
      expect(
        (await h.client.call('run.list', { projectId: h.project.id })).runs.map((r) => r.type),
      ).toEqual(['A', 'B', 'C', 'D']);
    });

    it('유형을 주지 않으면 대상으로 정한다: 인수 테스트 검사 규칙만 A, 정적 검사 규칙(구조 · OpenAPI 계약)만 B, 섞이면 순서와 무관하게 -32009', async () => {
      const rule = await approvedRule();
      const [direction, publicApi, openapi] = h.read((store) => [
        structureRule(store, 'structure.declared-direction'),
        structureRule(store, 'structure.public-api-only'),
        contractRule(store, 'openapi'),
      ]);
      await saveSettings(COMPLETE);
      for (const ids of [
        [rule.id, direction.id],
        [direction.id, rule.id],
        [openapi.id, rule.id],
        [direction.id, openapi.id, rule.id],
      ]) {
        await expectRejected(ids, undefined, /함께 받지 않습니다/);
      }
      expect((await createTyped([rule.id])).run.type).toBe('A');
      expect((await createTyped([direction.id])).run.type).toBe('B');
      expect((await createTyped([openapi.id])).run.type).toBe('B');
      const both = await createTyped([publicApi.id, direction.id, openapi.id]);
      expect(both.run).toMatchObject({
        type: 'B',
        targetRuleIds: [publicApi.id, direction.id, openapi.id],
      });
      // 거부가 표시 ID 순번을 쓰지 않았다
      expect(
        (await h.client.call('run.list', { projectId: h.project.id })).runs.map((r) => r.displayId),
      ).toEqual(['EXE-001', 'EXE-002', 'EXE-003', 'EXE-004']);
    });

    it('유형 B는 정적 검사 규칙만, 유형 A · C · D는 인수 테스트 검사 규칙만 받는다 (-32009, 아무것도 남지 않음)', async () => {
      const rule = await approvedRule();
      const [direction, openapi] = h.read((store) => [
        structureRule(store, 'structure.declared-direction'),
        contractRule(store, 'openapi'),
      ]);
      await saveSettings(COMPLETE);
      await expectRejected([rule.id], 'B');
      await expectRejected([direction.id, rule.id], 'B');
      for (const type of ['A', 'C', 'D'] as const) {
        await expectRejected([direction.id], type);
        await expectRejected([openapi.id], type);
        await expectRejected([rule.id, openapi.id], type);
      }
      // 대조군: 맞는 대상이면 만들어진다
      expect((await createTyped([direction.id, openapi.id], 'B')).run.type).toBe('B');
      expect((await createTyped([rule.id], 'C')).run.type).toBe('C');
    });

    it('내장이 아닌 규칙은 검사 종류가 구조 검사 · 계약 검사여도 인수 테스트 검사 규칙이다: 유형 B로 주면 -32009, 유도하면 A', async () => {
      const [structureKind, contractKind] = h.read((store) => {
        const requirement = store.requirements.create({
          id: newId(),
          text: '구조 규칙을 사람이 적음',
          author: human,
          normState: 'approved',
          createdAt: iso(T0),
        });
        return (['structure', 'contract'] as const).map((kind) =>
          store.rules.create({
            id: newId(),
            title: `사람 규칙 ${kind}`,
            statement: 'WHEN 파일이 다른 블록을 가져오면 THE SYSTEM SHALL 선언한 방향만 허용한다',
            kind: 'architecture',
            checkKinds: [kind],
            parentRequirementId: requirement.id,
            builtin: false,
            targetBlockIds: [],
            risk: null,
            contractId: null,
            author: human,
            normState: 'approved',
            createdAt: iso(T0),
          }),
        );
      });
      await saveSettings(COMPLETE);
      for (const rule of [structureKind, contractKind]) {
        if (rule === undefined) throw new Error('규칙 없음');
        await expectRejected([rule.id], 'B', /구조 검사 · 계약 검사 규칙만/);
        expect((await createTyped([rule.id])).run.type).toBe('A');
      }
    });

    it('검사 실행기가 없는 계약 종류의 계약 검사 규칙은 유형 B의 대상으로도 받지 않는다 (판정 없음, -32009)', async () => {
      // AsyncAPI는 실행기(asyncapi-parser)가 있어 받는다 (M3-49, ADR-148)
      const kinds = ['db-schema', 'external-api', 'cache', 'json-schema'] as const;
      const rules = h.read((store) => kinds.map((kind) => contractRule(store, kind)));
      const openapi = h.read((store) => contractRule(store, 'openapi'));
      const asyncapi = h.read((store) => contractRule(store, 'asyncapi'));
      await saveSettings(COMPLETE);
      for (const rule of rules) {
        await expectRejected([rule.id]);
        await expectRejected([rule.id], 'B');
        // 실행기 있는 규칙과 함께여도 받지 않는다
        await expectRejected([openapi.id, rule.id], 'B');
      }
      expect((await createTyped([openapi.id], 'B')).run.type).toBe('B');
      expect((await createTyped([asyncapi.id], 'B')).run.type).toBe('B');
    });

    it('형식이 틀린 type은 -32602, 에이전트 주체는 유형과 무관하게 -32020이고 아무것도 남지 않는다', async () => {
      const rule = await approvedRule();
      await saveSettings(COMPLETE);
      for (const type of ['E', 'a', '', 1, null]) {
        const raw = await h.client.requestRaw({
          jsonrpc: '2.0',
          id: 7,
          method: 'run.create',
          params: { projectId: h.project.id, ruleIds: [rule.id], author: human, type },
        });
        expect(raw, String(type)).toMatchObject({ error: { code: ErrorCode.InvalidParams } });
      }
      const agent = await rpcError(
        h.client.call('run.create', {
          projectId: h.project.id,
          ruleIds: [rule.id],
          author: implementerAgent,
          type: 'D',
        }),
      );
      expect(agent.code).toBe(ErrorCode.Unauthorized);
      expect(runCount()).toBe(0);
      expect(runStartCount()).toBe(0);
    });
  });

  describe('run.list {ruleId}: 규칙 상세의 실행 이력에 드는 실행만 (M3-42 #283, SCR-03 · ADR-135)', () => {
    /** 실행 1건을 저장소에 바로 만든다 (대상 규칙 순서 그대로). 판정 기록을 남길 단계 시도(검사)를 함께 돌려준다. */
    const storedRun = (store: ProjectStore, targetRuleIds: string[]) => {
      const detail = store.runs.create({
        id: newId(),
        type: 'A',
        targetRuleIds,
        currentStep: 'approval',
        baseBranch: 'main',
        budgetSnapshot: { run: { maxBudgetUsd: 5, maxTurns: 200 }, roles: {} },
        modelSnapshot: {},
        startedBy: human,
        createdAt: iso(T0),
        steps: RUN_STEP_PLANS.A.map((kind) => ({
          id: newId(),
          kind,
          attempt: 1,
          status: 'pending' as const,
          role: STEP_ROLES[kind],
          startedAt: null,
        })),
      });
      return { run: detail.run, check: stepOf(detail.steps, 'check') };
    };
    /** 그 실행의 검사 단계가 남긴 판정 기록 (대상이 아닌 규칙도 검사 단계는 효력 있는 규칙을 모두 판정한다). */
    const judged = (
      store: ProjectStore,
      ruleIds: string[],
      at: { run: { id: string }; check: Step } | null,
    ): void => {
      store.judgments.record(
        ruleIds.map((ruleId) => ({
          id: newId(),
          ruleId,
          runId: at?.run.id ?? null,
          stepId: at?.check.id ?? null,
          commit: SHA,
          judgedAt: iso(T0 + 1_000),
          status: 'pass' as const,
          runner: 'vitest' as const,
          exitCode: 0,
          reporterPath: null,
          cases: [],
          quarantineReason: null,
        })),
      );
    };
    const listOf = async (ruleId?: string) =>
      (
        await h.client.call('run.list', {
          projectId: h.project.id,
          ...(ruleId === undefined ? {} : { ruleId }),
        })
      ).runs;

    it('대상인 실행 · 판정만 한 실행 · 둘 다인 실행 · 여러 규칙 대상 실행을 표시 ID 순으로 한 번씩, 무관한 실행은 뺀다. 인자 없는 호출은 그대로 전부다', async () => {
      const seeded = h.read((store) => {
        const a = insertRule(store);
        const b = insertRule(store);
        const c = insertRule(store);
        const targetOnly = storedRun(store, [a.id]); // EXE-001: A 대상, 판정 없음
        const judgedOnly = storedRun(store, [b.id]); // EXE-002: B 대상, A는 판정만
        judged(store, [b.id, a.id], judgedOnly);
        const both = storedRun(store, [a.id]); // EXE-003: A 대상이고 판정도 함(판정 2건이어도 한 번)
        judged(store, [a.id, a.id], both);
        const unrelated = storedRun(store, [b.id, c.id]); // EXE-004: B · C 대상, A 판정 없음
        judged(store, [b.id, c.id], unrelated);
        const cOnly = storedRun(store, [c.id]); // EXE-005: C만
        const multi = storedRun(store, [b.id, a.id]); // EXE-006: 여러 규칙 대상(A가 둘째)
        // 실행 밖 판정(실행 없음)은 실행을 더하지 않는다
        judged(store, [a.id], null);
        return { a, b, c, runs: [targetOnly, judgedOnly, both, unrelated, cOnly, multi] };
      });
      const [targetOnly, judgedOnly, both, unrelated, cOnly, multi] = seeded.runs.map(
        ({ run }) => run,
      );
      const all = await listOf();
      // 인자 없는 호출: 프로젝트의 모든 실행 그대로 (응답 형식 · 값이 같다)
      expect(all.map((run) => run.displayId)).toEqual([
        'EXE-001',
        'EXE-002',
        'EXE-003',
        'EXE-004',
        'EXE-005',
        'EXE-006',
      ]);
      expect(all).toEqual(h.read((store) => store.runs.list()));
      const byId = new Map(all.map((run) => [run.id, run]));
      // 규칙 기준 결과의 실행 값은 인자 없는 결과의 그 실행과 같다(칸을 줄이거나 바꾸지 않는다)
      expect(await listOf(seeded.a.id)).toEqual(
        [targetOnly, judgedOnly, both, multi].map((run) => byId.get(run?.id ?? '')),
      );
      expect((await listOf(seeded.b.id)).map((run) => run.id)).toEqual(
        [judgedOnly, unrelated, multi].map((run) => run?.id),
      );
      expect((await listOf(seeded.c.id)).map((run) => run.id)).toEqual(
        [unrelated, cOnly].map((run) => run?.id),
      );
    });

    it('실행이 없는 규칙은 빈 목록, 상태를 함께 주면 둘 다 맞는 실행만', async () => {
      const { lonely, rule, first } = h.read((store) => {
        const lonely = insertRule(store);
        const rule = insertRule(store);
        const first = storedRun(store, [rule.id]);
        storedRun(store, [rule.id]);
        return { lonely, rule, first };
      });
      expect(await listOf(lonely.id)).toEqual([]);
      h.read((store) => evaluateApprovalStep(store, first.run.id, { now: () => T0 }));
      const running = await h.client.call('run.list', {
        projectId: h.project.id,
        ruleId: rule.id,
        status: 'running',
      });
      expect(running.runs.map((run) => run.displayId)).toEqual(['EXE-001']);
      const waiting = await h.client.call('run.list', {
        projectId: h.project.id,
        ruleId: rule.id,
        status: 'waiting_approval',
      });
      expect(waiting.runs.map((run) => run.displayId)).toEqual(['EXE-002']);
    });

    it('표시 ID 자리수가 넘어가도 순번 순이다 (EXE-999 다음 EXE-1000, 사전식 순서가 아니다)', async () => {
      const ids = h.read((store) => {
        const rule = insertRule(store);
        store.db
          .prepare(
            `INSERT INTO display_id_sequences (prefix, last_seq) VALUES ('EXE', 998)
             ON CONFLICT (prefix) DO UPDATE SET last_seq = 998`,
          )
          .run();
        const older = storedRun(store, [rule.id]);
        const newer = storedRun(store, [insertRule(store).id]);
        judged(store, [rule.id], newer);
        return { rule, displayIds: [older.run.displayId, newer.run.displayId] };
      });
      expect(ids.displayIds).toEqual(['EXE-999', 'EXE-1000']);
      expect((await listOf(ids.rule.id)).map((run) => run.displayId)).toEqual([
        'EXE-999',
        'EXE-1000',
      ]);
    });

    it('없는 규칙 · 다른 프로젝트의 규칙 · 등록되지 않은 프로젝트는 -32004 (판정 이력 조회와 같음)', async () => {
      const mine = h.read((store) => insertRule(store));
      const other = registerProject(
        {
          id: newId(),
          name: '다른 앱',
          rootPath: '/work/other-app',
          baseBranch: 'main',
          createdAt: iso(T0),
        },
        { home: h.biveHome },
      );
      const store = openProjectStore(other.id, { home: h.biveHome, create: false });
      let theirs: Rule;
      try {
        theirs = insertRule(store);
      } finally {
        store.close();
      }
      for (const [projectId, ruleId] of [
        [h.project.id, newId()],
        [h.project.id, theirs.id],
        [other.id, mine.id],
        [newId(), mine.id],
      ] as const) {
        expect(
          (await rpcError(h.client.call('run.list', { projectId, ruleId }))).code,
          `${projectId} ${ruleId}`,
        ).toBe(ErrorCode.NotFound);
      }
    });

    it('질의는 두 색인(대상 규칙 · 판정 기록의 규칙)으로 그 규칙의 행만 읽고 실행은 기본 키로 찾는다 (runs 전체를 훑지 않음)', () => {
      // 저장소가 실제로 준비하는 문장을 소스에서 꺼내 계획을 본다(시험이 같은 SQL을 따로 적지 않게)
      const source = readFileSync(
        new URL('../../store/src/repositories/run-repository.ts', import.meta.url),
        'utf8',
      );
      const statement = /#selectRunsByRule = db\.prepare<[^>]*>\(\s*`([^`]*)`/.exec(source)?.[1];
      const order = /const ORDER = '([^']*)'/.exec(source)?.[1];
      expect(statement).toBeDefined();
      expect(order).toBeDefined();
      const sql = (statement ?? '')
        .replace('${RUN_COLUMNS}', 'id')
        .replace('${ORDER}', order ?? '');
      const plan = h.read((store) =>
        store.db
          .prepare<[{ rule_id: string; status: string | null }], { detail: string }>(
            `EXPLAIN QUERY PLAN ${sql}`,
          )
          .all({ rule_id: newId(), status: null })
          .map((row) => row.detail),
      );
      expect(plan).toContain('SEARCH runs USING INDEX sqlite_autoindex_runs_1 (id=?)');
      expect(plan).toContain(
        'SEARCH run_target_rules USING INDEX run_target_rules_rule (rule_id=?)',
      );
      expect(plan).toContain('SEARCH judgments USING INDEX judgments_rule_latest (rule_id=?)');
      expect(plan.filter((line) => /^SCAN /.test(line))).toEqual([]);
    });

    it('형식이 깨진 실행 행은 그 행만 건너뛰고 경고한다 (인자 없는 목록과 같은 방식, ADR-094 · ADR-120)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { rule, runs } = h.read((store) => {
          const rule = insertRule(store);
          const runs = [
            storedRun(store, [rule.id]),
            storedRun(store, [rule.id]),
            storedRun(store, [rule.id]),
          ];
          store.db
            .prepare(`UPDATE runs SET tool_manifest = '[{"x":1}]' WHERE id = ?`)
            .run(runs[1]?.run.id ?? '');
          return { rule, runs };
        });
        expect((await listOf(rule.id)).map((run) => run.id)).toEqual([
          runs[0]?.run.id,
          runs[2]?.run.id,
        ]);
        expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
          `실행 기록 1건이 저장 형식에 맞지 않아 조회에서 건너뜀 (프로젝트 ${h.project.id})`,
        ]);
      } finally {
        warn.mockRestore();
      }
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
          'roles.mutator.model',
          'roles.mutator.maxBudgetUsd',
          'roles.mutator.maxTurns',
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

  describe('toolCall.list: 실행의 도구 호출 기록 조회 (M1-38, NFR-01 · NFR-02 · ADR-083)', () => {
    /** 실행 1개를 만들고 단계 시도에 세션을 열어 도구 호출을 남긴다 (엔진이 남기는 것과 같은 저장소 창구). */
    const runWithCalls = async () => {
      const rule = await approvedRule();
      await saveSettings(COMPLETE);
      const created = await create([rule.id]);
      const testWriting = stepOf(created.steps, 'test_writing');
      const implementation = stepOf(created.steps, 'implementation');
      const writerSession = newId();
      const implSession = newId();
      h.read((store) => {
        store.sessions.start({
          id: writerSession,
          runId: created.run.id,
          stepId: testWriting.id,
          role: 'test-writer',
          model: 'test-model',
          workDir: '/work/session',
          startedAt: iso(T0),
        });
        store.sessions.start({
          id: implSession,
          runId: created.run.id,
          stepId: implementation.id,
          role: 'implementer',
          model: 'impl-model',
          workDir: '/work/tree',
          startedAt: iso(T0 + 1000),
        });
        const call = (
          sessionId: string,
          role: 'test-writer' | 'implementer',
          at: number,
          name: string,
          argsSummary: string,
          status: 'ok' | 'denied' | 'error',
          reason: string | null = null,
        ) =>
          store.sessions.appendToolCall({
            id: newId(),
            runId: created.run.id,
            sessionId,
            at: iso(at),
            role,
            name,
            argsSummary,
            status,
            reason,
            durationMs: 3,
          });
        call(
          writerSession,
          'test-writer',
          T0,
          'write_file',
          'bive-acceptance/RULE-001/a.acc.ts',
          'ok',
        );
        call(
          implSession,
          'implementer',
          T0 + 1000,
          'write_file',
          '/tmp/bh/projects/x/bive.db',
          'denied',
          'path_denied',
        );
        // 파일 도구가 아닌 호출의 인자 요약(JSON)에는 내용이 들어 있을 수 있다: 결과에 싣지 않는다
        call(
          implSession,
          'implementer',
          T0 + 1001,
          'proposal.approve',
          '{"id":"SECRET-CONTENT-123"}',
          'denied',
          'unknown_tool',
        );
        call(
          implSession,
          'implementer',
          T0 + 1002,
          'run_tests',
          'run_tests',
          'error',
          'tool_failed',
        );
      });
      return { created, testWriting, implementation, writerSession, implSession };
    };

    it('세션별 도구 호출을 시각 순으로 역할 · 단계 · 도구 이름 · 결과 · 거부 사유 · 경로와 함께 돌려준다', async () => {
      const { created, writerSession, implSession } = await runWithCalls();
      for (const runId of [created.run.id, 'EXE-001']) {
        const result = await h.client.call('toolCall.list', { projectId: h.project.id, runId });
        expect(result).toEqual({
          runId: created.run.id,
          displayId: 'EXE-001',
          truncated: false,
          calls: [
            {
              sessionId: writerSession,
              seq: 0,
              at: iso(T0),
              role: 'test-writer',
              step: { kind: 'test_writing', attempt: 1 },
              name: 'write_file',
              nameTruncated: false,
              status: 'ok',
              reason: null,
              path: 'bive-acceptance/RULE-001/a.acc.ts',
              pathTruncated: false,
            },
            {
              sessionId: implSession,
              seq: 0,
              at: iso(T0 + 1000),
              role: 'implementer',
              step: { kind: 'implementation', attempt: 1 },
              name: 'write_file',
              nameTruncated: false,
              status: 'denied',
              reason: 'path_denied',
              path: '/tmp/bh/projects/x/bive.db',
              pathTruncated: false,
            },
            {
              sessionId: implSession,
              seq: 1,
              at: iso(T0 + 1001),
              role: 'implementer',
              step: { kind: 'implementation', attempt: 1 },
              name: 'proposal.approve',
              nameTruncated: false,
              status: 'denied',
              reason: 'unknown_tool',
              path: null,
              pathTruncated: false,
            },
            {
              sessionId: implSession,
              seq: 2,
              at: iso(T0 + 1002),
              role: 'implementer',
              step: { kind: 'implementation', attempt: 1 },
              name: 'run_tests',
              nameTruncated: false,
              status: 'error',
              reason: 'tool_failed',
              path: null,
              pathTruncated: false,
            },
          ],
        });
        // 인자 · 결과 원문은 싣지 않는다 (ADR-083)
        expect(JSON.stringify(result)).not.toContain('SECRET-CONTENT-123');
      }
    });

    it('조회 전용: 부른 뒤에도 도구 호출 · 세션 · 실행 · 승인 기록이 그대로다 (NFR-01)', async () => {
      const { created } = await runWithCalls();
      const snapshot = () =>
        h.read((store) => ({
          calls: store.sessions.toolCalls(created.run.id),
          sessions: store.sessions.listByRun(created.run.id),
          run: store.runs.getDetail(created.run.id),
          log: store.approvalLog.list(),
        }));
      const before = snapshot();
      await h.client.call('toolCall.list', { projectId: h.project.id, runId: 'EXE-001' });
      expect(snapshot()).toEqual(before);
    });

    it('기록이 없는 실행은 빈 목록, 상한(500건)을 넘으면 앞의 500건과 truncated', async () => {
      const rule = await approvedRule();
      await saveSettings(COMPLETE);
      const created = await create([rule.id]);
      expect(
        await h.client.call('toolCall.list', { projectId: h.project.id, runId: 'EXE-001' }),
      ).toEqual({ runId: created.run.id, displayId: 'EXE-001', truncated: false, calls: [] });

      const sessionId = newId();
      h.read((store) => {
        store.sessions.start({
          id: sessionId,
          runId: created.run.id,
          stepId: stepOf(created.steps, 'implementation').id,
          role: 'implementer',
          model: 'impl-model',
          workDir: '/work/tree',
          startedAt: iso(T0),
        });
        for (let i = 0; i < 501; i += 1) {
          store.sessions.appendToolCall({
            id: newId(),
            runId: created.run.id,
            sessionId,
            at: iso(T0 + i),
            role: 'implementer',
            name: 'read_file',
            argsSummary: `src/f${String(i)}.ts`,
            status: 'ok',
            reason: null,
            durationMs: 0,
          });
        }
      });
      const result = await h.client.call('toolCall.list', {
        projectId: h.project.id,
        runId: 'EXE-001',
      });
      expect(result.truncated).toBe(true);
      expect(result.calls).toHaveLength(500);
      expect(result.calls.map((c) => c.seq)).toEqual(Array.from({ length: 500 }, (_, i) => i));
    });

    /** 실행 1개와 구현 단계 세션을 만들고, 그 세션 ID와 기록을 남기는 함수를 돌려준다. */
    const runWithSessions = async (count: number) => {
      const rule = await approvedRule();
      await saveSettings(COMPLETE);
      const created = await create([rule.id]);
      const sessionIds = Array.from({ length: count }, () => newId()).sort();
      h.read((store) => {
        for (const id of sessionIds) {
          store.sessions.start({
            id,
            runId: created.run.id,
            stepId: stepOf(created.steps, 'implementation').id,
            role: 'implementer',
            model: 'impl-model',
            workDir: '/work/tree',
            startedAt: iso(T0),
          });
        }
      });
      /** 기록을 주어진 순서대로 남긴다 (저장소 한 번 열기). */
      const append = (entries: readonly (readonly [string, number, string, string])[]) =>
        h.read((store) => {
          for (const [sessionId, at, name, argsSummary] of entries) {
            store.sessions.appendToolCall({
              id: newId(),
              runId: created.run.id,
              sessionId,
              at: iso(at),
              role: 'implementer',
              name,
              argsSummary,
              status: 'error',
              reason: 'tool_failed',
              durationMs: 0,
            });
          }
        });
      return { created, sessionIds, append };
    };

    it('정확히 500건이면 truncated가 false, 같은 시각이면 세션 → 순번 순으로 결정적이다', async () => {
      const { sessionIds, append } = await runWithSessions(2);
      const [first, second] = sessionIds as [string, string];
      // 같은 시각에 두 세션의 기록을 엇갈려 남긴다: 결과는 세션 ID → 순번 순이어야 한다
      append(
        Array.from({ length: 250 }, (_, i) => [
          [second, T0, 'read_file', `src/b${String(i)}.ts`] as const,
          [first, T0, 'read_file', `src/a${String(i)}.ts`] as const,
        ]).flat(),
      );
      const call = () =>
        h.client.call('toolCall.list', { projectId: h.project.id, runId: 'EXE-001' });
      const result = await call();
      expect(result.truncated).toBe(false);
      expect(result.calls).toHaveLength(500);
      expect(result.calls.map((c) => [c.sessionId, c.seq])).toEqual([
        ...Array.from({ length: 250 }, (_, i) => [first, i]),
        ...Array.from({ length: 250 }, (_, i) => [second, i]),
      ]);
      expect(await call()).toEqual(result);
    });

    it('이미 저장된 파일 도구 기록의 인자 요약이 경로가 아닌 JSON이어도 내용을 싣지 않는다 (ADR-083)', async () => {
      const { sessionIds, append } = await runWithSessions(1);
      const [sessionId] = sessionIds as [string];
      const rows: [string, string, string | null][] = [
        // 실행기 수정 전, 파일 도구가 예외를 던지면 인자 JSON 앞 200자가 기록됐다
        ['write_file', '{"path":"src/x.ts","content":"SECRET-WRITE-1"}', 'src/x.ts'],
        [
          'write_file',
          `{"path":"src/y.ts","content":"SECRET-WRITE-2${'x'.repeat(200)}`.slice(0, 200) + '…',
          null,
        ],
        ['read_file', '{"path":{"nested":"SECRET-READ"}}', null],
        ['write_file', '{"content":"SECRET-NO-PATH"}', null],
        ['search_files', '{"query":"SECRET-QUERY","path":7}', null],
        ['list_files', '.', '.'],
      ];
      append(rows.map(([name, summary], i) => [sessionId, T0 + i, name, summary] as const));
      const result = await h.client.call('toolCall.list', {
        projectId: h.project.id,
        runId: 'EXE-001',
      });
      expect(result.calls.map((c) => [c.name, c.path])).toEqual(
        rows.map(([name, , expected]) => [name, expected]),
      );
      expect(JSON.stringify(result)).not.toContain('SECRET');
    });

    it('빈 도구 이름("")의 거부 기록이 사실 그대로 저장되고 조회에서 빈 문자열 그대로 나온다 (NFR-02, M2-11 #190 · ADR-094)', async () => {
      const { sessionIds, created } = await runWithSessions(1);
      const [sessionId] = sessionIds as [string];
      h.read((store) =>
        store.sessions.appendToolCall({
          id: newId(),
          runId: created.run.id,
          sessionId,
          at: iso(T0),
          role: 'implementer',
          name: '',
          argsSummary: '{"path":"src/a.ts"}',
          status: 'denied',
          reason: 'unknown_tool',
          durationMs: 0,
        }),
      );
      expect(h.read((store) => store.sessions.toolCallsBySession(sessionId))).toEqual([
        expect.objectContaining({ name: '', status: 'denied', reason: 'unknown_tool' }),
      ]);
      const result = await h.client.call('toolCall.list', {
        projectId: h.project.id,
        runId: 'EXE-001',
      });
      expect(result.calls).toEqual([
        expect.objectContaining({
          sessionId,
          seq: 0,
          name: '',
          nameTruncated: false,
          status: 'denied',
          reason: 'unknown_tool',
          path: null,
          pathTruncated: false,
        }),
      ]);
    });

    describe('경로 · 도구 이름의 길이 상한과 제어 문자 이스케이프 (M2-06, ADR-089)', () => {
      const PATH_MAX = TOOL_CALL_PATH_DISPLAY_MAX;
      const NAME_MAX = TOOL_CALL_NAME_DISPLAY_MAX;

      /** 기록을 남기고 조회 결과의 [name, nameTruncated, path, pathTruncated]를 돌려준다. */
      const listShown = async (rows: readonly (readonly [string, string])[]) => {
        const { sessionIds, append } = await runWithSessions(1);
        const [sessionId] = sessionIds as [string];
        append(rows.map(([name, summary], i) => [sessionId, T0 + i, name, summary] as const));
        const result = await h.client.call('toolCall.list', {
          projectId: h.project.id,
          runId: 'EXE-001',
        });
        return result.calls.map((c) => [c.name, c.nameTruncated, c.path, c.pathTruncated]);
      };

      /** 경로 표시 값의 앞 · 뒤 몫: 남길 몫(상한 - 1)의 1/3과 나머지 (ADR-089) */
      const HEAD = Math.floor((PATH_MAX - 1) / 3);
      const TAIL = PATH_MAX - 1 - HEAD;

      it('경로: 상한 바로 아래 · 정확히 상한은 그대로, 넘으면 앞 · 뒤를 남기고 가운데를 …로 줄여 pathTruncated', async () => {
        const below = `src/${'a'.repeat(PATH_MAX - 5)}`;
        const exact = `src/${'b'.repeat(PATH_MAX - 4)}`;
        const over = `src/${'c'.repeat(6000)}`;
        expect([below.length, exact.length]).toEqual([PATH_MAX - 1, PATH_MAX]);
        const shown = await listShown([
          ['read_file', below],
          ['read_file', exact],
          ['write_file', over],
          ['write_file', '/tmp/bh/projects/forbidden-write.txt'],
        ]);
        expect(shown).toEqual([
          ['read_file', false, below, false],
          ['read_file', false, exact, false],
          ['write_file', false, `${over.slice(0, HEAD)}…${over.slice(-TAIL)}`, true],
          // 정상 길이의 경로는 글자까지 그대로다 (roadmap 2.1 흐름 12번)
          ['write_file', false, '/tmp/bh/projects/forbidden-write.txt', false],
        ]);
      });

      it('경로: `./`를 2030번 반복한 4069자 경로도 조회 값의 끝에 실제 대상 src/ok.ts가 보인다', async () => {
        const padded = `${'./'.repeat(2030)}src/ok.ts`;
        expect(padded).toHaveLength(4069);
        const shown = await listShown([['write_file', padded]]);
        const [[name, nameTruncated, path, pathTruncated]] = shown as [
          [string, boolean, string, boolean],
        ];
        expect([name, nameTruncated, pathTruncated]).toEqual(['write_file', false, true]);
        expect(path).toHaveLength(PATH_MAX);
        expect(path.endsWith('/./src/ok.ts')).toBe(true);
        expect(path).toBe(`${padded.slice(0, HEAD)}…${padded.slice(-TAIL)}`);
      });

      it('경로: 제어 · 서식 · 줄 구분 · 양방향 제어 · 한글 채움 문자를 표기로 바꾸고 역슬래시를 \\\\로 적는다', async () => {
        // 짝 없는 서로게이트(\ud800)는 저장소(UTF-8)가 U+FFFD로 바꿔 저장한다: 조회 값은 그 글자다
        const raw =
          'a\nb\rc\td\u001be\u0000f\u007fg\u0085h\u2028i\u2029j\u202ek\u2066l\u200fm\u061cn\ud800o\\np\\q😀r\u200bs\ufefft\u3164u\u00advw';
        const shown = await listShown([['write_file', raw]]);
        expect(shown).toEqual([
          [
            'write_file',
            false,
            'a\\nb\\rc\\td\\u001be\\u0000f\\u007fg\\u0085h\\u2028i\\u2029j\\u202ek\\u2066l\\u200fm\\u061cn\ufffdo\\\\np\\\\q😀r\\u200bs\\ufefft\\u3164u\\u00advw',
            false,
          ],
        ]);
        // 응답에는 제어 · 서식 · 줄 구분 글자가 남지 않는다
        expect(String(shown[0]?.[2])).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      });

      it('경로: 태그 문자를 붙여 src/a.ts와 똑같아 보이게 만든 경로가 조회 값에서 구분된다', async () => {
        const shown = await listShown([
          ['write_file', 'src/a.ts'],
          ['write_file', 'src/a.ts\u{e0061}\u{e0062}'],
        ]);
        expect(shown).toEqual([
          ['write_file', false, 'src/a.ts', false],
          ['write_file', false, 'src/a.ts\\udb40\\udc61\\udb40\\udc62', false],
        ]);
      });

      it('경로: 이스케이프로 늘어난 길이로 상한을 재고, 앞 · 뒤 경계 모두 표기 · 서로게이트 쌍 중간에서 자르지 않는다', async () => {
        const rows: [string, string][] = [
          // 줄바꿈 하나가 `\n` 두 글자가 되어 원래 길이(정확히 상한)가 상한을 넘는다
          [`${'a'.repeat(PATH_MAX - 1)}\n`, `${'a'.repeat(HEAD)}…${'a'.repeat(TAIL - 2)}\\n`],
          // 앞 경계에 `\u001b`(6글자)가 걸친다: 통째로 빼고 남는 몫은 뒤가 쓴다
          [
            `${'h'.repeat(HEAD - 3)}\u001b${'z'.repeat(3000)}`,
            `${'h'.repeat(HEAD - 3)}…${'z'.repeat(TAIL + 3)}`,
          ],
          // 뒤 경계에 `\u001b`가 걸친다
          [
            `${'x'.repeat(3000)}\u001b${'y'.repeat(TAIL - 3)}`,
            `${'x'.repeat(HEAD)}…${'y'.repeat(TAIL - 3)}`,
          ],
          // 앞 경계 · 뒤 경계의 서로게이트 쌍(2 코드 단위)
          [
            `${'h'.repeat(HEAD - 1)}😀${'z'.repeat(3000)}`,
            `${'h'.repeat(HEAD - 1)}…${'z'.repeat(TAIL + 1)}`,
          ],
          [
            `${'x'.repeat(3000)}😀${'y'.repeat(TAIL - 1)}`,
            `${'x'.repeat(HEAD)}…${'y'.repeat(TAIL - 1)}`,
          ],
        ];
        const shown = await listShown(rows.map(([raw]) => ['read_file', raw] as const));
        expect(shown).toEqual(rows.map(([, expected]) => ['read_file', false, expected, true]));
        for (const [, , path] of shown) expect(String(path).length).toBeLessThanOrEqual(PATH_MAX);
      });

      it('도구 이름: 상한을 넘는 · 제어 문자를 담은 모르는 도구 이름도 조회가 실패하지 않고 잘리거나 이스케이프된다', async () => {
        const longName = `proposal.${'x'.repeat(5000)}`;
        const exactName = 'y'.repeat(NAME_MAX);
        const shown = await listShown([
          [longName, '{"id":"SECRET-ARGS"}'],
          [exactName, '{}'],
          ['proposal.approve\n\u001b[2J\u202e', '{}'],
          ['write_file\u0000', 'src/a.ts'],
        ]);
        expect(shown).toEqual([
          [`${longName.slice(0, NAME_MAX - 1)}…`, true, null, false],
          [exactName, false, null, false],
          ['proposal.approve\\n\\u001b[2J\\u202e', false, null, false],
          // 파일 도구 이름과 글자가 다르면 파일 도구가 아니다: 경로를 싣지 않는다
          ['write_file\\u0000', false, null, false],
        ]);
      });
    });

    it('없는 실행 · 다른 프로젝트의 실행 · 등록되지 않은 프로젝트는 -32004, projectId 없으면 -32602', async () => {
      const { created } = await runWithCalls();
      const other = registerProject(
        {
          id: newId(),
          name: '다른 앱',
          rootPath: '/work/other-app',
          baseBranch: 'main',
          createdAt: iso(T0),
        },
        { home: h.biveHome },
      );
      for (const [projectId, runId] of [
        [h.project.id, newId()],
        [h.project.id, 'EXE-009'],
        [other.id, created.run.id],
        [other.id, 'EXE-001'],
        [newId(), created.run.id],
      ] as const) {
        expect(
          (await rpcError(h.client.call('toolCall.list', { projectId, runId }))).code,
          `${projectId} ${runId}`,
        ).toBe(ErrorCode.NotFound);
      }
      const raw = await h.client.requestRaw({
        jsonrpc: '2.0',
        id: 'no-project',
        method: 'toolCall.list',
        params: { runId: 'EXE-001' },
      });
      expect(raw).toMatchObject({ error: { code: ErrorCode.InvalidParams } });
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
      ).toEqual({
        run: result.run,
        steps: result.steps,
        usage: h.read((store) => store.runs.usage(created.run.id)),
        sessions: [],
      });
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

  it('생성 · 승인 단계 종료 · 테스트 작성 종료마다 저장된 값을 새 프로세스가 그대로 돌려준다 (running은 interrupted로, M1-14)', async () => {
    const biveHome = makeBiveHome();
    const { project, ruleId } = seed(biveHome);
    const engine = new RunService({ biveHome });
    const withStore = <T>(fn: (store: ProjectStore) => T): T => {
      const store = openProjectStore(project.id, { home: biveHome, create: false });
      try {
        return fn(store);
      } finally {
        store.close();
      }
    };

    // 1) 생성 직후 (다른 연결이 저장한 값, run.create와 같은 함수). 떠 있는 오케스트레이터는 생성 알림을 받지 않았으므로
    //    판정하지 않고 저장된 값 그대로 돌려준다. 꺼진 동안 만든 승인 대기는 기동 때 판정되므로(ADR-107) 띄운 뒤에 만든다
    let current = await start(biveHome);
    const created = withStore((store) =>
      createRun(
        store,
        { ruleIds: [ruleId], author: human },
        { clientId: null },
        {
          now: () => T0,
          newId,
        },
      ),
    );
    const afterCreate = await current.client.call('run.get', {
      projectId: project.id,
      id: created.run.id,
    });
    expect(afterCreate).toEqual({
      run: created.run,
      steps: created.steps,
      usage: withStore((store) => store.runs.usage(created.run.id)),
      sessions: [],
    });
    expect(afterCreate.usage.run).toMatchObject({ costUsd: null, turns: null, sessionCount: 0 });
    expect(await current.client.call('run.get', { projectId: project.id, id: 'EXE-001' })).toEqual(
      afterCreate,
    );
    await kill(current);

    // 2) 승인 단계 종료 · 테스트 작성 종료(커밋 · 비용 · 턴 · 종료 조건 결과)를 저장한 뒤 비정상 종료된 것과 같은 상태
    const approval = engine.evaluateApproval(project.id, created.run.id);
    expect(approval.approved).toBe(true);
    // 비용 · 턴은 세션 기록에서만 채워진다 (ADR-067): 테스트 작성 시도의 세션 1개를 남긴다
    const sessionId = newId();
    withStore((store) => {
      store.sessions.start({
        id: sessionId,
        runId: created.run.id,
        stepId: stepOf(approval.steps, 'test_writing').id,
        role: 'test-writer',
        model: 'test-model',
        workDir: '/work/session',
        startedAt: iso(T0),
      });
      store.sessions.end(sessionId, {
        endReason: 'success',
        totalCostUsd: 0.0123,
        numTurns: 7,
        endedAt: iso(T0),
      });
    });
    const afterTestWriting = engine.completeStep(project.id, created.run.id, {
      status: 'passed',
      exitDetail: { files: ['bive-acceptance/RULE-001/health.acc.ts'] },
      commit: SHA,
      run: { headCommit: SHA },
    });
    expect(afterTestWriting.run).toMatchObject({
      status: 'running',
      currentStep: 'red_check',
      lastCompletedStep: 'test_writing',
      headCommit: SHA,
      costUsd: 0.0123,
      turns: 7,
    });

    // 재기동: running은 interrupted가 되고, 끝난 단계 값은 그대로, 진행 중이던 시도는 끝나고 새 시도가 대기한다
    current = await start(biveHome);
    const afterRestart = await current.client.call('run.get', {
      projectId: project.id,
      id: created.run.id,
    });
    expect(afterRestart.run).toEqual({ ...afterTestWriting.run, status: 'interrupted' });
    for (const kind of ['approval', 'test_writing'] as const) {
      expect(stepOf(afterRestart.steps, kind)).toEqual(stepOf(afterTestWriting.steps, kind));
    }
    expect(stepOf(afterRestart.steps, 'test_writing')).toMatchObject({
      status: 'passed',
      commit: SHA,
      costUsd: 0.0123,
      turns: 7,
    });
    expect(stepOf(afterRestart.steps, 'red_check')).toMatchObject({
      status: 'failed',
      exitDetail: INTERRUPTED_EXIT_DETAIL,
    });
    expect(stepOf(afterRestart.steps, 'red_check', 2)).toMatchObject({
      status: 'pending',
      startedAt: null,
    });
    // 세션 항목도 저장된 세션 기록 그대로다 (규범 입력 없이 연 세션은 normInput null, ADR-108)
    expect(afterRestart.sessions).toEqual([
      {
        id: sessionId,
        stepId: stepOf(approval.steps, 'test_writing').id,
        role: 'test-writer',
        startedAt: iso(T0),
        endedAt: iso(T0),
        endReason: 'success',
        normInput: null,
      },
    ]);
    await kill(current);

    // 3) 다시 띄워도 자동으로 이어가지 않는다
    current = await start(biveHome);
    expect(
      await current.client.call('run.get', { projectId: project.id, id: created.run.id }),
    ).toEqual(afterRestart);
    expect(await current.client.call('run.list', { projectId: project.id })).toEqual({
      runs: [afterRestart.run],
    });
    const log = await current.client.call('approvalLog.list', { projectId: project.id });
    expect(log.entries.map((e) => e.action)).toEqual(['run_start']);
    expect(log.chain.valid).toBe(true);
    await kill(current);
  }, 90_000);
});
