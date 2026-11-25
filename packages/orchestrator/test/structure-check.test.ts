// 구조 검사 내장 규칙 · 검사 단계 통합 (M3-03 #48 수용 기준 1 · 2 · 4, JDG-05 · NRM-02 · RUN-02 · RUN-08, ADR-100 B⑨, ADR-127).
// - 블록 선언 저장(`blocks.set`)과 같은 트랜잭션에서 부모 없는 내장 구조 규칙 두 개가 생기고 `rule.list`에 나온다(자동 시작 없음)
// - 검사 단계 · 병합 재검사가 판정할 커밋의 깨끗한 체크아웃에서 설치 전에 구조 검사를 해 내장 규칙의 판정 기록(실행기
//   dependency-cruiser)을 남긴다. `undeclared-import` 변형이면 방향 규칙이 실패하고, 판단 세션 없이 구현으로 회귀해 상한 뒤 실패한다
//   (대상이 내장 규칙인 실행 · 대상이 아닌 실행 둘 다)
// - 구조 검사가 돌지 않았는데 통과로 저장되는 길이 없다: 실행기 오류 · 겹침 · 선언을 읽지 못함 · 내장 규칙 행 없음 · 모르는 예외 · 중단
// - 규칙 작성 역할의 폐기 · 대체 도구와 구현 역할의 이의 도구가 새로 만든 내장 규칙 행을 거부하고 규칙은 효력 상태로 남는다
// 픽스처 git 복사본 · 실제 SQLite · 실제 git · 실제 파서(dependency-cruiser 실행기) · ScriptedAdapter. 인수 테스트 판정 · 설치만 주입한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProjectAnalysis } from '@bive/parser';
import { ParserError } from '@bive/parser';
import {
  BUILTIN_STRUCTURE_RULES,
  createUlidGenerator,
  type JudgmentResult,
  type Rule,
} from '@bive/shared';
import { ConflictError, type ProjectStore } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { loadScenario, ScenarioSchema } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import type { PipelineEngine } from '../src/engine/pipeline-engine.js';
import type { StepExecutor } from '../src/engine/types.js';
import type { PipeServer } from '../src/ipc/server.js';
import {
  BUILTIN_RULE_CREATED_REASON,
  BUILTIN_STRUCTURE_RULE_TEXTS,
  type BuiltinStructureRuleKey,
  ensureBuiltinStructureRules,
} from '../src/norms/builtin-rules.js';
import { recordObjection } from '../src/norms/objection.js';
import { RuleWriterService } from '../src/rule-writer/rule-writer-service.js';
import { createRun, saveNewRun } from '../src/runs/run-service.js';
import {
  MAX_STRUCTURE_CASES,
  runStructureCheck,
  type StructureAnalyzer,
  type StructurePlan,
} from '../src/steps/structure-check.js';
import { RpcCallError, type TestClient } from './helpers/client.js';
import { human, newId as harnessId, userGit, withProject } from './helpers/engine-harness.js';
import {
  attempts,
  before,
  detailOf,
  exitOf,
  type PipelineHarness,
  type PipelineSetupOptions,
  runToEnd,
  setupPipeline,
  stepOf,
} from './helpers/pipeline-harness.js';
import { cleanup, REPO_ROOT, waitFor } from './helpers/process.js';
import { iso, startProjectHarness, T0 } from './helpers/project-harness.js';

const newId = createUlidGenerator();

const SAMPLE = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'fixtures', 'blocks', 'sample-next-app.json'), 'utf8'),
) as { blocks: Record<string, unknown>[] };

const temps: string[] = [];
const engines: PipelineEngine[] = [];
const servers: PipeServer[] = [];
const clients: TestClient[] = [];
const services: RuleWriterService[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const service of services.splice(0)) await service.close();
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  await cleanup();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}, 60_000);

const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bive-structure-'));
  temps.push(dir);
  return dir;
};

const rpcError = async (promise: Promise<unknown>): Promise<RpcCallError> => {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof RpcCallError)) throw new Error('RPC 오류가 아님');
  return error;
};

/** `rule.list`의 규칙 (판정 요약을 뺀 규칙 행). */
const ruleList = async (h: { client: TestClient; project: { id: string } }): Promise<Rule[]> =>
  (await h.client.call('rule.list', { projectId: h.project.id })).rules.map((item) => item.rule);

const builtinOf = (rules: readonly Rule[], key: BuiltinStructureRuleKey): Rule => {
  const found = rules.find(
    (rule) => rule.builtin && rule.title === BUILTIN_STRUCTURE_RULE_TEXTS[key].title,
  );
  if (found === undefined) throw new Error(`내장 규칙 없음: ${key}`);
  return found;
};

// ── 수용 기준 1: 블록 선언 저장 때 내장 구조 규칙 ─────────────────────

describe('블록 선언 저장 때 내장 구조 규칙이 부모 없이 생기고 rule.list에 나온다 (수용 기준 1)', () => {
  it('blocks.set이 같은 트랜잭션에서 내장 규칙 두 개(부모 없음 · 구조 검사 · 대상 블록 없음 · 위험도 없음 · 효력 · 미확인)와 오케스트레이터의 신규 기록을 남기고, rule.list에 고정 순서로 나온다', async () => {
    const h = await startProjectHarness({ servers, clients });
    expect((await ruleList(h))).toEqual([]);
    await h.client.call('blocks.set', { projectId: h.project.id, author: human, declaration: SAMPLE });
    const listed = (await h.client.call('rule.list', { projectId: h.project.id })).rules;
    const rules = listed.map((item) => item.rule);
    expect(
      listed.map(({ rule, judgment }) => ({
        displayId: rule.displayId,
        title: rule.title,
        statement: rule.statement,
        kind: rule.kind,
        checkKinds: rule.checkKinds,
        parentRequirementId: rule.parentRequirementId,
        parentDetachedAt: rule.parentDetachedAt,
        builtin: rule.builtin,
        targetBlockIds: rule.targetBlockIds,
        risk: rule.risk,
        author: rule.author,
        normState: rule.normState,
        confirmation: rule.confirmation.state,
        judgment: judgment.status,
      })),
    ).toEqual(
      BUILTIN_STRUCTURE_RULES.map((key, index) => ({
        displayId: `RULE-00${String(index + 1)}`,
        title: BUILTIN_STRUCTURE_RULE_TEXTS[key].title,
        statement: BUILTIN_STRUCTURE_RULE_TEXTS[key].statement,
        kind: 'architecture',
        checkKinds: ['structure'],
        parentRequirementId: null,
        parentDetachedAt: null,
        builtin: true,
        targetBlockIds: [],
        risk: null,
        author: { kind: 'human' },
        normState: 'approved',
        confirmation: 'unconfirmed',
        judgment: 'unjudged',
      })),
    );
    expect(rules.map((rule) => rule.title)).toEqual(['공개 API로만 접근', '선언한 방향으로만 의존']);
    // 규범 변경 기록: 규칙마다 신규 1건 (주체 오케스트레이터 · 세션 · 실행 없음 · 고정 사유 · 계기가 된 선언의 판)
    h.read((store) => {
      const changes = store.normChanges.list();
      expect(
        changes.map((entry) => ({
          kind: entry.kind,
          actor: entry.actor,
          target: entry.targetRef,
          sessionId: entry.sessionId,
          runId: entry.runId,
          reason: entry.reason,
          after: entry.detail.after,
        })),
      ).toEqual(
        rules.map((rule, index) => ({
          kind: 'created',
          actor: { kind: 'orchestrator' },
          target: { entity: 'Rule', id: rule.id },
          sessionId: null,
          runId: null,
          reason: BUILTIN_RULE_CREATED_REASON,
          after: {
            title: rule.title,
            statement: rule.statement,
            kind: 'architecture',
            checkKinds: ['structure'],
            parentRequirementId: null,
            builtin: BUILTIN_STRUCTURE_RULES[index],
            targetBlockIds: [],
            risk: null,
            blockDeclarationVersion: 1,
          },
        })),
      );
      expect(store.normChanges.verify().valid).toBe(true);
      // 승인 기록(사람 행동)에는 쓰지 않고, 실행 자동 시작도 없다
      expect(store.approvalLog.list()).toEqual([]);
      expect(store.runs.list()).toEqual([]);
    });
    // 미확인 규칙이라 확인할 것에 뜬다 (사람이 [확인]할 수 있다)
    const todo = await h.client.call('confirmation.list', { projectId: h.project.id });
    expect(
      todo.items
        .filter((item) => item.kind === 'unconfirmed_norm')
        .map((item) => item.target.id)
        .sort(),
    ).toEqual(rules.map((rule) => rule.id).sort());
  });

  it('다시 저장해도(판이 올라가도) 만들지 않고, 선언이 없는 프로젝트에는 없으며, 이 변경 전에 선언만 저장된 프로젝트는 다음 저장 때 메운다', async () => {
    const h = await startProjectHarness({ servers, clients });
    // 이 변경 전처럼 선언만 저장소에 있다 (내장 규칙 없음)
    h.read((store) => store.blockDeclarations.set(SAMPLE, { at: iso(T0), by: human }));
    expect((await ruleList(h))).toEqual([]);
    await h.client.call('blocks.set', { projectId: h.project.id, author: human, declaration: SAMPLE });
    const first = (await ruleList(h));
    expect(first.map((rule) => rule.displayId)).toEqual(['RULE-001', 'RULE-002']);
    const changes = h.read((store) => store.normChanges.list());
    expect(changes.map((entry) => entry.detail.after)).toMatchObject([
      { blockDeclarationVersion: 2 },
      { blockDeclarationVersion: 2 },
    ]);
    // 다시 저장: 판 3, 규칙 · 기록 그대로
    const third = await h.client.call('blocks.set', {
      projectId: h.project.id,
      author: human,
      declaration: { blocks: SAMPLE.blocks.map((item) => ({ ...item, risk: 'high' })) },
    });
    expect(third.current.version).toBe(3);
    expect((await ruleList(h))).toEqual(first);
    expect(h.read((store) => store.normChanges.list())).toEqual(changes);
    // 다른 프로젝트(선언 없음)에는 내장 규칙이 없다
    const other = await startProjectHarness({ servers, clients });
    expect((await ruleList(other))).toEqual(
      [],
    );
  });

  it('내장 규칙을 만들지 못하면 선언도 저장되지 않는다 (한 트랜잭션), 거부된 선언 · 에이전트 주체는 규칙을 만들지 않는다', async () => {
    const h = await startProjectHarness({ servers, clients });
    h.read((store) =>
      store.db.exec(
        "CREATE TRIGGER test_no_builtin BEFORE INSERT ON rules WHEN NEW.builtin = 1 BEGIN SELECT RAISE(ABORT, 'test: 내장 규칙 거부'); END;",
      ),
    );
    await expect(
      h.client.call('blocks.set', { projectId: h.project.id, author: human, declaration: SAMPLE }),
    ).rejects.toBeInstanceOf(RpcCallError);
    expect((await h.client.call('blocks.get', { projectId: h.project.id })).current).toBeNull();
    h.read((store) => {
      expect(store.rules.list()).toEqual([]);
      expect(store.normChanges.list()).toEqual([]);
      store.db.exec('DROP TRIGGER test_no_builtin');
    });
    // 형식 오류 · 에이전트 주체: 선언도 규칙도 없다
    await rpcError(
      h.client.call('blocks.set', {
        projectId: h.project.id,
        author: human,
        declaration: { blocks: [] },
      }),
    );
    await rpcError(
      h.client.call('blocks.set', {
        projectId: h.project.id,
        author: { kind: 'agent', role: 'rule-writer' },
        declaration: SAMPLE,
      }),
    );
    expect(h.read((store) => store.rules.list())).toEqual([]);
    // 대조군: 트리거를 지우면 만들어진다
    await h.client.call('blocks.set', { projectId: h.project.id, author: human, declaration: SAMPLE });
    expect(h.read((store) => store.rules.list()).map((rule) => rule.builtin)).toEqual([true, true]);
  });

  it('사람의 [실행]은 내장 규칙을 대상으로 받지 않고(-32009 성격의 충돌, 아무것도 남지 않음), 사람 편집도 받지 않는다 (builtin_rule)', async () => {
    const h = await startProjectHarness({ servers, clients });
    await h.client.call('blocks.set', { projectId: h.project.id, author: human, declaration: SAMPLE });
    const rules = await ruleList(h);
    h.read((store) => {
      store.settings.update(
        {
          run: { maxBudgetUsd: 5, maxTurns: 200 },
          roles: {
            'rule-writer': { model: 'm', maxBudgetUsd: 1, maxTurns: 20 },
            'test-writer': { model: 'm', maxBudgetUsd: 1, maxTurns: 20 },
            implementer: { model: 'm', maxBudgetUsd: 1, maxTurns: 20 },
          },
        },
        { by: human, at: iso(T0) },
      );
      for (const rule of rules) {
        expect(() =>
          createRun(
            store,
            { ruleIds: [rule.id], author: human },
            { clientId: null },
            { now: () => T0, newId },
          ),
        ).toThrow(ConflictError);
      }
      expect(store.runs.list()).toEqual([]);
      expect(store.approvalLog.list()).toEqual([]);
    });
    const rule = rules[0];
    if (rule === undefined) throw new Error('규칙 없음');
    const edited = await rpcError(
      h.client.call('rule.update', {
        projectId: h.project.id,
        id: rule.id,
        title: '바꾼 제목',
        expectedUpdatedAt: rule.updatedAt,
        author: human,
      }),
    );
    expect(edited.data).toMatchObject({ reason: 'builtin_rule' });
    expect((await ruleList(h))).toEqual(rules);
  });
});

// ── 수용 기준 4: 폐기 · 대체 · 이의 거부 ─────────────────────────────

describe('규칙 작성 역할의 폐기 · 대체 도구와 구현 역할의 이의 도구는 새로 만든 내장 규칙을 거부한다 (수용 기준 4, ADR-100 B⑨)', () => {
  it('retire_rule · supersede_rule은 내장 규칙 두 개 모두 denied(builtin_rule)이고 규칙은 효력 상태로 남는다. 이의 기록도 builtin_rule로 거부한다', async () => {
    const grounds = '진술 "그 블록이 공개한 파일만 가져온다"는 이 요구사항과 맞지 않는다';
    const supersedeArgs = (ruleId: string) => ({
      ruleId,
      grounds,
      title: '아무 가져오기 허용',
      statement: 'WHEN 모듈을 가져오면 THE SYSTEM SHALL 어느 블록의 파일이든 가져온다',
      kind: 'architecture',
      checkKinds: ['test'],
      parentRequirementId: '{{requirementId}}',
      targetBlocks: ['health'],
      risk: 'low',
      rationale: '구조 검사를 없앰',
      contradiction: { verdict: 'none' },
    });
    const scenario = ScenarioSchema.parse({
      name: 'builtin-retire-test',
      description: '내장 규칙 폐기 · 대체 거부 시험',
      roles: {
        'rule-writer': {
          sessions: [
            {
              turns: [
                { tool: 'retire_rule', args: { ruleId: 'RULE-001', grounds } },
                { tool: 'retire_rule', args: { ruleId: 'RULE-002', grounds } },
                { tool: 'supersede_rule', args: supersedeArgs('RULE-001') },
                { tool: 'supersede_rule', args: supersedeArgs('RULE-002') },
                { message: '끝.' },
              ],
              result: {
                subtype: 'success',
                total_cost_usd: 0.01,
                num_turns: 1,
                modelUsage: {
                  m: {
                    inputTokens: 1,
                    outputTokens: 1,
                    cacheReadInputTokens: 0,
                    cacheCreationInputTokens: 0,
                    costUSD: 0.01,
                  },
                },
              },
            },
          ],
        },
      },
    });
    let service: RuleWriterService | null = null;
    const h = await startProjectHarness(
      { servers, clients },
      {
        ruleWriter: ({ biveHome, now }) => {
          const adapter = new ScriptedAdapter({ scenario, biveHome, pollIntervalMs: 10 });
          service = new RuleWriterService({ biveHome, adapter, now });
          services.push(service);
          return service;
        },
      },
    );
    if (service === null) throw new Error('서비스 없음');
    const svc: RuleWriterService = service;
    await h.client.call('blocks.set', { projectId: h.project.id, author: human, declaration: SAMPLE });
    const before = (await ruleList(h));
    await h.client.call('settings.update', {
      projectId: h.project.id,
      patch: {
        run: { maxBudgetUsd: 5, maxTurns: 200 },
        roles: { 'rule-writer': { model: 'test-model', maxBudgetUsd: 1, maxTurns: 20 } },
      },
      author: human,
    });
    const { requirement } = await h.client.call('requirement.create', {
      projectId: h.project.id,
      text: '모듈 경계 검사 없애기',
      author: human,
    });
    await svc.whenSettled(h.project.id, requirement.id);
    const [record] = svc.recordsFor(h.project.id, requirement.id);
    if (record === undefined) throw new Error('기록 없음');
    expect(record.toolCalls.map((call) => [call.name, call.status, call.reason])).toEqual([
      ['retire_rule', 'denied', 'builtin_rule'],
      ['retire_rule', 'denied', 'builtin_rule'],
      ['supersede_rule', 'denied', 'builtin_rule'],
      ['supersede_rule', 'denied', 'builtin_rule'],
    ]);
    // 규칙은 효력 상태로 남는다: 목록 · 폐기 기록 · 규범 변경 기록 그대로
    expect((await ruleList(h))).toEqual(before);
    h.read((store) => {
      for (const rule of before) expect(store.ruleRetirements.get(rule.id)).toBeNull();
      expect(store.ruleRetirements.list()).toEqual([]);
      expect(store.normChanges.list().map((entry) => entry.kind)).toEqual(['created', 'created']);
      // 구현 역할의 이의도 내장 규칙을 겨누지 못한다 (새 규칙 쪽의 폐기는 대상 규칙에 대한 이의로만)
      for (const rule of before) {
        let caught: unknown;
        try {
          recordObjection(
            store,
            {
              ruleIds: [rule.displayId],
              reason: '블록 선언과 맞지 않는다',
              sessionId: newId(),
              runId: newId(),
              stepId: newId(),
            },
            { now: () => T0 },
          );
        } catch (error) {
          caught = error;
        }
        expect(caught).toMatchObject({ name: 'ObjectionInputError', code: 'builtin_rule' });
      }
      expect(store.normChanges.list()).toHaveLength(2);
    });
  });
});

// ── 수용 기준 2 · 3 · 4: 검사 단계 통합 (실제 파서) ─────────────────────

/** `undeclared-import` 변형 (`scripts/make-variant.sh`와 같은 파일): health 블록이 선언하지 않은 auth 블록을 가져온다. */
const VARIANT_FILE = 'src/app/api/health/session-probe.ts';
const VARIANT_SOURCE = `import { GET as getSession } from '@/app/api/auth/session/route';

/** 변형 undeclared-import: health 블록이 선언하지 않은 auth 블록을 가져온다. */
export function probeSession(): Response {
  return getSession();
}
`;
const undeclaredImport = (repo: string): void => {
  fs.writeFileSync(path.join(repo, VARIANT_FILE), VARIANT_SOURCE);
};

/** happy-path에서 구현 세션을 세 번 하는 시나리오 (회귀 상한까지 돈다). */
const retryScenario = (): { scenario: string; scenariosDir: string } => {
  const scenario = structuredClone(loadScenario('happy-path'));
  scenario.name = 'structure-retry';
  const implementer = scenario.roles.implementer;
  const first = implementer?.sessions[0];
  if (implementer === undefined || first === undefined) throw new Error('구현 세션 없음');
  implementer.sessions = [first, structuredClone(first), structuredClone(first)];
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'structure-retry.yaml'), stringify(scenario));
  return { scenario: 'structure-retry', scenariosDir: dir };
};

const setup = (options: Omit<PipelineSetupOptions, 'temps' | 'engines'> = {}): PipelineHarness =>
  setupPipeline({ ...options, temps, engines });

/** 선언 저장 + 내장 규칙 (사람의 `blocks.set` 처리기가 하는 것과 같은 트랜잭션). */
const declare = (
  h: PipelineHarness,
  declaration: unknown = SAMPLE,
): Record<BuiltinStructureRuleKey, Rule> =>
  withProject(h.biveHome, h.project.id, (store) =>
    store.transaction(() => {
      const at = new Date().toISOString();
      const record = store.blockDeclarations.set(declaration, { at, by: human });
      ensureBuiltinStructureRules(store, { declaration: record, at, newId });
      const rules = store.rules.list();
      return Object.fromEntries(
        BUILTIN_STRUCTURE_RULES.map((key) => [key, builtinOf(rules, key)]),
      ) as Record<BuiltinStructureRuleKey, Rule>;
    }),
  );

const judgmentsIn = (h: PipelineHarness, runId: string = h.runId): JudgmentResult[] =>
  withProject(h.biveHome, h.project.id, (store) => store.judgments.listByRun(runId));

const structureJudgments = (h: PipelineHarness, ruleId: string, runId?: string) =>
  judgmentsIn(h, runId).filter((judgment) => judgment.ruleId === ruleId);

describe('검사 단계의 구조 검사: undeclared-import 변형에서 방향 규칙 실패 (수용 기준 2 · 4)', () => {
  it('대상이 아닌 실행에서 내장 규칙이 깨지면 판단 세션 없이 구현으로 회귀하고(위반을 앞 시도의 사유로) 상한 뒤 실패한다. 판정 기록은 실행기 dependency-cruiser · 선언 판 · 위반 파일 쌍', async () => {
    const h = setup({ ...retryScenario(), prepareRepo: undeclaredImport });
    const builtin = declare(h);
    const direction = builtin['structure.declared-direction'];
    const publicApi = builtin['structure.public-api-only'];
    const detail = await runToEnd(h);
    expect(detail.run).toMatchObject({ status: 'failed', failureReason: 'regression_limit' });
    expect(attempts(detail, 'implementation', 'check')).toEqual([
      'implementation#1:passed',
      'implementation#2:passed',
      'implementation#3:passed',
      'check#1:failed',
      'check#2:failed',
      'check#3:failed',
    ]);
    // 방향 규칙: 시도마다 실패 1건 (요약 케이스 + 위반 한 건)
    const failed = structureJudgments(h, direction.id);
    expect(failed.map((judgment) => [judgment.status, judgment.runner])).toEqual([
      ['fail', 'dependency-cruiser'],
      ['fail', 'dependency-cruiser'],
      ['fail', 'dependency-cruiser'],
    ]);
    expect(failed[0]).toMatchObject({
      runId: h.runId,
      stepId: stepOf(detail, 'check', 1).id,
      commit: stepOf(detail, 'implementation', 1).commit,
      exitCode: null,
      reporterPath: null,
      quarantineReason: null,
      cases: [
        {
          name: '구조 검사 · 블록 선언 판 1',
          file: '블록 선언',
          line: null,
          status: 'failed',
          message: '위반 1건',
        },
        {
          name: '선언하지 않은 방향의 가져오기 · health → auth',
          file: VARIANT_FILE,
          line: null,
          status: 'failed',
          message: '가져온 파일: src/app/api/auth/session/route.ts',
        },
      ],
    });
    // 공개 API 규칙: 통과 (요약 케이스만)
    expect(structureJudgments(h, publicApi.id).map((judgment) => judgment.cases)).toEqual(
      Array.from({ length: 3 }, () => [
        {
          name: '구조 검사 · 블록 선언 판 1',
          file: '블록 선언',
          line: null,
          status: 'passed',
          message: '위반 0건',
        },
      ]),
    );
    expect(exitOf(detail, 'check', 1)).toMatchObject({
      reason: 'check_failed',
      ruleIds: ['RULE-001'],
      structure: {
        declarationVersion: 1,
        status: 'checked',
        violations: {
          'structure.declared-direction': 1,
          'structure.public-api-only': 0,
          'structure.no-cycle': 0,
          total: 1,
        },
      },
      judgments: [
        { ruleId: 'RULE-001', status: 'pass' },
        { ruleId: publicApi.displayId, status: 'pass' },
        { ruleId: direction.displayId, status: 'fail' },
      ],
    });
    expect(exitOf(detail, 'check', 1)).not.toHaveProperty('existingRuleJudgment');
    // 인수 테스트 판정에는 내장 규칙을 넘기지 않는다
    expect(
      h.judgeCalls.filter((call) => call.kind === 'check').map((call) => call.input.ruleIds),
    ).toEqual([['RULE-001'], ['RULE-001'], ['RULE-001']]);
    // 판단 세션 없음 (내장 규칙은 폐기 · 대체할 수 없다): 규칙 작성 역할 세션 · 판단 기록 없음
    expect(h.sessions.map((spec) => spec.role)).toEqual([
      'test-writer',
      'implementer',
      'implementer',
      'implementer',
    ]);
    withProject(h.biveHome, h.project.id, (store) => {
      expect(store.normChanges.list().map((entry) => entry.kind)).toEqual(['created', 'created']);
      expect(store.ruleRetirements.list()).toEqual([]);
    });
    // 다음 구현 세션은 위반(내장 규칙 · 파일 쌍)을 앞 시도의 사유로 받는다
    const second = h.sessions.filter((spec) => spec.role === 'implementer')[1];
    expect(second?.prompt).toContain(
      [
        `  - ${direction.displayId}`,
        '    - 블록 선언 구조 검사 · 블록 선언 판 1 (위반 1건)',
        `    - ${VARIANT_FILE} 선언하지 않은 방향의 가져오기 · health → auth (가져온 파일: src/app/api/auth/session/route.ts)`,
      ].join('\n'),
    );
    expect(Number(userGit(h.repo, 'rev-list', '--merges', '--count', 'main'))).toBe(0);
  }, 120_000);

  it('대상이 내장 규칙인 실행(엔진 수준에서 직접 만든 실행)도 검사 → 구현 회귀 → 상한 뒤 실패다 (수용 기준 2 · 3)', async () => {
    const h = setup({
      ...retryScenario(),
      prepareRepo: undeclaredImport,
      // 내장 규칙은 테스트 작성 · Red 확인 · 구현 판정의 대상이 아니다(인수 테스트가 없다): 그 세 단계에서만 대상에서 뺀다
      executors: (defaults) => {
        const tested =
          (inner: StepExecutor): StepExecutor =>
          (context) =>
            inner({
              ...context,
              run: {
                ...context.run,
                targetRuleIds: context.run.targetRuleIds.filter((id) => id === h0().rule.id),
              },
            });
        return {
          ...defaults,
          test_writing: tested(defaults.test_writing),
          red_check: tested(defaults.red_check),
          implementation: tested(defaults.implementation),
        };
      },
    });
    function h0(): PipelineHarness {
      return h;
    }
    const direction = declare(h)['structure.declared-direction'];
    const runId = withProject(h.biveHome, h.project.id, (store) =>
      store.transaction(() => {
        const at = new Date().toISOString();
        const id = harnessId();
        saveNewRun(
          store,
          store.settings.get(),
          { runId: id, ruleIds: [h.rule.id, direction.id], startedBy: { kind: 'human' } },
          at,
          harnessId,
        );
        store.approvalLog.append({
          at,
          action: 'run_start',
          actor: { kind: 'human' },
          targetRef: { entity: 'Run', id },
          clientId: null,
          detail: { ruleIds: [h.rule.id, direction.id] },
        });
        return id;
      }),
    );
    expect(h.engine.evaluateApproval(h.project.id, runId)).toBe(true);
    await h.engine.settled();
    const detail = detailOf({ ...h, runId });
    expect(detail.run).toMatchObject({
      status: 'failed',
      failureReason: 'regression_limit',
      targetRuleIds: [h.rule.id, direction.id],
    });
    expect(attempts(detail, 'check')).toEqual(['check#1:failed', 'check#2:failed', 'check#3:failed']);
    expect(exitOf(detail, 'check', 3)).toMatchObject({
      reason: 'regression_limit',
    });
    expect(
      structureJudgments(h, direction.id, runId).map((judgment) => judgment.status),
    ).toEqual(['fail', 'fail', 'fail']);
    expect(h.sessions.some((spec) => spec.role === 'rule-writer')).toBe(false);
  }, 120_000);

  it('대조군: 변형이 없으면 두 내장 규칙이 통과하고 병합된다. 선언이 없으면 구조 검사를 하지 않는다 (지금과 같다)', async () => {
    const h = setup();
    const builtin = declare(h);
    const detail = await runToEnd(h);
    expect(detail.run.status).toBe('merged');
    expect(
      BUILTIN_STRUCTURE_RULES.map((key) =>
        structureJudgments(h, builtin[key].id).map((judgment) => judgment.status),
      ),
    ).toEqual([['pass'], ['pass']]);
    expect(exitOf(detail, 'check')).toMatchObject({
      structure: { declarationVersion: 1, status: 'checked', violations: { total: 0 } },
    });

    const plain = setup();
    const done = await runToEnd(plain);
    expect(done.run.status).toBe('merged');
    expect(exitOf(done, 'check')).not.toHaveProperty('structure');
    expect(judgmentsIn(plain).map((judgment) => judgment.runner)).toEqual(['vitest', 'vitest']);
  }, 120_000);
});

describe('구조 검사가 돌지 않았는데 통과로 저장되는 길이 없다 (닫힌 쪽)', () => {
  const analyzer =
    (fn: (input: Parameters<StructureAnalyzer>[0]) => Promise<ProjectAnalysis>): StructureAnalyzer =>
    (input) =>
      fn(input);

  it('구현 역할이 고칠 수 없는 파서 오류는 판정하지 않고(설치 · 인수 테스트 판정 없음, 판정 기록 없음) judge_runner_error로 끝나며 메시지 원문을 싣지 않는다', async () => {
    const h = setup({
      structure: {
        analyzeStructure: analyzer(() =>
          Promise.reject(new ParserError('cruise_failed', '/비밀/경로 실행기 출력')),
        ),
      },
    });
    declare(h);
    const detail = await runToEnd(h);
    expect(detail.run).toMatchObject({ status: 'failed', failureReason: 'judge_runner_error' });
    expect(exitOf(detail, 'check').detail).toMatchObject({
      stage: 'structure',
      structure: { declarationVersion: 1, status: 'error', code: 'cruise_failed' },
    });
    expect(JSON.stringify(detail.steps)).not.toContain('비밀');
    expect(h.judgeCalls.filter((call) => call.kind === 'check')).toEqual([]);
    expect(
      judgmentsIn(h).filter((judgment) => judgment.stepId === stepOf(detail, 'check').id),
    ).toEqual([]);
  }, 90_000);

  it('모르는 예외는 단계 오류로 끝나고 판정 기록이 없다', async () => {
    const h = setup({
      structure: { analyzeStructure: analyzer(() => Promise.reject(new Error('폭발'))) },
    });
    declare(h);
    const detail = await runToEnd(h);
    expect(detail.run).toMatchObject({ status: 'failed', failureReason: 'step_error' });
    expect(
      judgmentsIn(h).filter((judgment) => judgment.stepId === stepOf(detail, 'check').id),
    ).toEqual([]);
  }, 90_000);

  it('선언이 겹치면(사람이 고칠 일) 판정하지 않고 block_declaration_overlap으로 끝난다 (실제 파서)', async () => {
    const h = setup();
    declare(h, {
      blocks: [
        ...SAMPLE.blocks,
        {
          name: 'app',
          kind: 'domain',
          include: ['src/app/**'],
          public: [],
          dependsOn: [],
          risk: 'low',
        },
      ],
    });
    const detail = await runToEnd(h);
    expect(detail.run).toMatchObject({
      status: 'failed',
      failureReason: 'block_declaration_overlap',
    });
    expect(exitOf(detail, 'check').detail).toMatchObject({
      stage: 'structure',
      structure: { declarationVersion: 1, status: 'overlap' },
    });
    expect(h.judgeCalls.filter((call) => call.kind === 'check')).toEqual([]);
    expect(
      judgmentsIn(h).filter((judgment) => judgment.stepId === stepOf(detail, 'check').id),
    ).toEqual([]);
  }, 90_000);

  it('지금 선언을 읽지 못하면(깨진 행) judge_runner_error, 선언은 있는데 내장 규칙 행이 없으면 state_inconsistent로 끝나고 둘 다 판정하지 않는다', async () => {
    // 검사 단계를 열기 직전에 가장 큰 판을 깨뜨린다 (그 전 세션들은 선언을 읽어야 시작한다)
    const ref: { h?: PipelineHarness } = {};
    const broken = setup({
      executors: (defaults) => ({
        ...defaults,
        check: before(defaults.check, () => {
          const target = ref.h;
          if (target === undefined) return;
          withProject(target.biveHome, target.project.id, (store) =>
            store.db
              .prepare(
                'INSERT INTO block_declarations (version, set_at, set_by, declaration) VALUES (?, ?, ?, ?)',
              )
              .run(2, new Date().toISOString(), '{"kind":"human"}', '{"blocks":[{"name":"비밀"}]}'),
          );
        }),
      }),
    });
    ref.h = broken;
    declare(broken);
    const first = await runToEnd(broken);
    expect(first.run).toMatchObject({ status: 'failed', failureReason: 'judge_runner_error' });
    expect(exitOf(first, 'check').detail).toMatchObject({
      stage: 'structure',
      code: 'declaration_unreadable',
    });
    expect(JSON.stringify(first.steps)).not.toContain('비밀');
    expect(broken.judgeCalls.filter((call) => call.kind === 'check')).toEqual([]);

    const missing = setup();
    withProject(missing.biveHome, missing.project.id, (store: ProjectStore) =>
      store.blockDeclarations.set(SAMPLE, { at: new Date().toISOString(), by: human }),
    );
    const second = await runToEnd(missing);
    expect(second.run).toMatchObject({ status: 'failed', failureReason: 'state_inconsistent' });
    expect(exitOf(second, 'check').detail).toMatchObject({
      stage: 'structure',
      declarationVersion: 1,
    });
    expect(missing.judgeCalls.filter((call) => call.kind === 'check')).toEqual([]);
  }, 120_000);

  it('중단 신호는 파서 호출에 닿고, 중단된 단계는 판정 기록 없이 중단으로 남는다', async () => {
    let started = false;
    const h = setup({
      structure: {
        analyzeStructure: analyzer(
          ({ signal }) =>
            new Promise((_, reject) => {
              started = true;
              signal.addEventListener('abort', () => reject(signal.reason as Error), {
                once: true,
              });
            }),
        ),
      },
    });
    declare(h);
    expect(h.engine.evaluateApproval(h.project.id, h.runId)).toBe(true);
    await waitFor(() => started, 60_000, '구조 검사 시작');
    await h.engine.stop();
    // 멈춘 단계는 결과 없이 열린 채로 남고(통과로 저장되지 않음), 재기동 복구가 중단으로 바꾼다
    expect(attempts(detailOf(h), 'check')).toEqual(['check#1:running']);
    expect(judgmentsIn(h).filter((judgment) => judgment.runner === 'dependency-cruiser')).toEqual(
      [],
    );
    expect(h.newEngine().recoverInterruptedRuns()).toHaveLength(1);
    const detail = detailOf(h);
    expect(detail.run.status).toBe('interrupted');
    expect(judgmentsIn(h).filter((judgment) => judgment.runner === 'dependency-cruiser')).toEqual(
      [],
    );
  }, 90_000);

  it('판정 도중 사람이 새 판을 저장해도 단계를 열 때 읽은 판으로 판정하고 그 판 번호를 기록한다', async () => {
    const seen: unknown[] = [];
    let h: PipelineHarness | null = null;
    const real = (await import('../src/steps/structure-check.js')).defaultStructureAnalyzer;
    h = setup({
      structure: {
        analyzeStructure: async (input) => {
          seen.push(input.declaration);
          const current = h;
          if (current !== null) {
            withProject(current.biveHome, current.project.id, (store) =>
              store.blockDeclarations.set(
                { blocks: SAMPLE.blocks.map((item) => ({ ...item, risk: 'high' })) },
                { at: new Date().toISOString(), by: human },
              ),
            );
          }
          return real(input);
        },
      },
    });
    declare(h);
    const detail = await runToEnd(h);
    expect(detail.run.status).toBe('merged');
    expect(seen).toEqual([SAMPLE]);
    expect(exitOf(detail, 'check')).toMatchObject({ structure: { declarationVersion: 1 } });
    expect(
      judgmentsIn(h)
        .filter((judgment) => judgment.runner === 'dependency-cruiser')
        .map((judgment) => judgment.cases[0]?.name),
    ).toEqual(['구조 검사 · 블록 선언 판 1', '구조 검사 · 블록 선언 판 1']);
  }, 90_000);
});

describe('병합 재검사의 구조 검사 (검사 단계와 같다)', () => {
  it('기준 브랜치에 들어온 변형이 병합 커밋에서 방향 규칙을 깨면 재검사 실패로 병합하지 않고 병합 커밋의 판정 기록을 남긴다', async () => {
    const h = setup({
      merge: { checkTimeoutMs: 90_000 },
      executors: (defaults) => ({
        ...defaults,
        merge: async (context) => {
          undeclaredImport(context.git.repoPath);
          userGit(context.git.repoPath, 'add', VARIANT_FILE);
          userGit(context.git.repoPath, 'commit', '-q', '-m', '사용자 커밋');
          return defaults.merge(context);
        },
      }),
    });
    const builtin = declare(h);
    const base = userGit(h.repo, 'rev-parse', 'refs/heads/main');
    const detail = await runToEnd(h);
    expect(detail.run).toMatchObject({ status: 'failed', failureReason: 'check_failed' });
    expect(userGit(h.repo, 'rev-parse', 'refs/heads/main')).not.toBe(base);
    expect(Number(userGit(h.repo, 'rev-list', '--merges', '--count', 'main'))).toBe(0);
    const mergeStep = stepOf(detail, 'merge').id;
    const recorded = judgmentsIn(h).filter((judgment) => judgment.stepId === mergeStep);
    expect(
      recorded
        .map((judgment) => [judgment.ruleId, judgment.status, judgment.runner])
        .sort((a, b) => (String(a[2]) + String(a[1])).localeCompare(String(b[2]) + String(b[1]))),
    ).toEqual([
      [builtin['structure.declared-direction'].id, 'fail', 'dependency-cruiser'],
      [builtin['structure.public-api-only'].id, 'pass', 'dependency-cruiser'],
      [h.rule.id, 'pass', 'vitest'],
    ]);
    expect(exitOf(detail, 'merge').detail).toMatchObject({
      recheck: { structure: { declarationVersion: 1, status: 'checked' } },
    });
    expect(h.sessions.some((spec) => spec.role === 'rule-writer')).toBe(false);
  }, 120_000);
});

// ── 판정 규칙 (단위) ─────────────────────────────────────────────

describe('구조 검사 결과 → 내장 규칙 판정 (단위, 파서 출력 모양)', () => {
  const rule = (title: string): Rule => ({
    id: newId(),
    displayId: title === BUILTIN_STRUCTURE_RULE_TEXTS['structure.public-api-only'].title ? 'RULE-001' : 'RULE-002',
    title,
    statement: 'WHILE 블록 선언이 있으면 THE SYSTEM SHALL 가져온다',
    kind: 'architecture',
    checkKinds: ['structure'],
    parentRequirementId: null,
    parentDetachedAt: null,
    builtin: true,
    targetBlockIds: [],
    risk: null,
    contractId: null,
    author: { kind: 'human' },
    normState: 'approved',
    createdAt: iso(T0),
    updatedAt: iso(T0),
    deletedAt: null,
    confirmation: { state: 'unconfirmed' },
  });
  const plan: StructurePlan = {
    version: 4,
    declaration: SAMPLE as unknown as StructurePlan['declaration'],
    rules: {
      'structure.public-api-only': rule(BUILTIN_STRUCTURE_RULE_TEXTS['structure.public-api-only'].title),
      'structure.declared-direction': rule(
        BUILTIN_STRUCTURE_RULE_TEXTS['structure.declared-direction'].title,
      ),
    },
  };
  const capped = <T>(items: T[], total = items.length) => ({ items, total });
  const analysis = (outcome: NonNullable<ProjectAnalysis['structure']>['outcome']): ProjectAnalysis => ({
    graph: {
      modules: [],
      edges: capped([]),
      unresolved: capped([]),
      unanalyzed: capped([]),
      packages: capped([]),
    },
    structure: {
      blocks: [],
      unclassified: capped([]),
      publicOutsideInclude: capped([]),
      outcome,
    },
  });
  const violation = (
    kind: 'structure.declared-direction' | 'structure.public-api-only' | 'structure.no-cycle',
    from: string,
    to: string,
  ) => ({
    kind,
    from: { file: from, block: 'health' },
    to: { file: to, block: 'lib' },
    cycle: kind === 'structure.no-cycle' ? capped([from, to]) : null,
  });
  const run = (result: ProjectAnalysis | Error, dir = tempDir(), signal = new AbortController().signal) =>
    runStructureCheck(dir, plan, {
      signal,
      analyze: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
    });
  const statuses = (outcome: Awaited<ReturnType<typeof run>>) =>
    outcome.kind === 'judged'
      ? outcome.verdicts.map((verdict) => [verdict.key, verdict.status])
      : outcome.reason;

  it('통과는 checked이고 그 종류 위반이 0건일 때뿐: 종류별로 나누고, 순환은 판정하지 않고 센다', async () => {
    expect(statuses(await run(analysis({ status: 'checked', violations: capped([]) })))).toEqual([
      ['structure.public-api-only', 'pass'],
      ['structure.declared-direction', 'pass'],
    ]);
    const mixed = await run(
      analysis({
        status: 'checked',
        violations: capped([
          violation('structure.public-api-only', 'src/app/api/health/a.ts', 'src/lib/x.ts'),
          violation('structure.no-cycle', 'src/lib/a.ts', 'src/lib/b.ts'),
        ]),
      }),
    );
    expect(statuses(mixed)).toEqual([
      ['structure.public-api-only', 'fail'],
      ['structure.declared-direction', 'pass'],
    ]);
    expect(mixed).toMatchObject({
      summary: {
        declarationVersion: 4,
        status: 'checked',
        violations: {
          'structure.public-api-only': 1,
          'structure.declared-direction': 0,
          'structure.no-cycle': 1,
          total: 2,
        },
      },
    });
    const cycleOnly = await run(
      analysis({
        status: 'checked',
        violations: capped([violation('structure.no-cycle', 'src/lib/a.ts', 'src/lib/b.ts')]),
      }),
    );
    expect(statuses(cycleOnly)).toEqual([
      ['structure.public-api-only', 'pass'],
      ['structure.declared-direction', 'pass'],
    ]);
  });

  it('incomplete는 위반 0건이어도 두 규칙의 실패이고 분석하지 않은 가져오기를 케이스로 싣는다. 위반 목록이 잘렸으면 두 규칙 모두 실패다', async () => {
    const incomplete = await run(
      analysis({
        status: 'incomplete',
        violations: capped([]),
        unanalyzed: capped([{ from: 'src/app/api/health/route.ts', to: 'src/app/api/health/q.graphql' }]),
      }),
    );
    expect(statuses(incomplete)).toEqual([
      ['structure.public-api-only', 'fail'],
      ['structure.declared-direction', 'fail'],
    ]);
    expect(incomplete.kind === 'judged' && incomplete.verdicts[0]?.cases).toEqual([
      {
        name: '구조 검사 · 블록 선언 판 4',
        file: '블록 선언',
        line: null,
        status: 'failed',
        message: '분석하지 않은 대상으로 가는 가져오기 1건',
      },
      {
        name: '분석하지 않은 대상으로 가는 가져오기',
        file: 'src/app/api/health/route.ts',
        line: null,
        status: 'failed',
        message: '가져온 대상: src/app/api/health/q.graphql',
      },
    ]);
    const truncated = await run(
      analysis({
        status: 'checked',
        violations: capped(
          [violation('structure.public-api-only', 'src/app/api/health/a.ts', 'src/lib/x.ts')],
          1001,
        ),
      }),
    );
    expect(statuses(truncated)).toEqual([
      ['structure.public-api-only', 'fail'],
      ['structure.declared-direction', 'fail'],
    ]);
  });

  it('위반 경로는 표시 값으로 바꾸고 자르며, 케이스는 상한까지 싣고 위반 수는 요약에 센다', async () => {
    const many = Array.from({ length: MAX_STRUCTURE_CASES + 5 }, (_, i) =>
      violation('structure.declared-direction', `src/app/api/health/f${String(i)}.ts`, 'src/lib/x.ts'),
    );
    many[0] = violation(
      'structure.declared-direction',
      'src/app/api/health/\u202eevil\n.ts',
      `src/lib/${'a'.repeat(400)}.ts`,
    );
    const outcome = await run(analysis({ status: 'checked', violations: capped(many) }));
    if (outcome.kind !== 'judged') throw new Error('판정 없음');
    const cases = outcome.verdicts[1]?.cases ?? [];
    expect(cases).toHaveLength(1 + MAX_STRUCTURE_CASES);
    expect(cases[0]?.message).toBe(`위반 ${String(MAX_STRUCTURE_CASES + 5)}건 · 앞 ${String(MAX_STRUCTURE_CASES)}건만 실음`);
    expect(cases[1]?.file).toBe('src/app/api/health/\\u202eevil\\n.ts');
    expect(cases[1]?.message?.length).toBeLessThanOrEqual('가져온 파일: '.length + 300);
    expect(cases[1]?.message).toContain('…');
  });

  it('파서 오류: 구현 역할이 만들 수 있는 것은 두 규칙의 실패(종류만), 그 밖은 판정하지 않고 끝냄. 메시지 원문은 결과에 없다', async () => {
    for (const code of [
      'cruise_timeout',
      'cruise_output_too_large',
      'too_many_files',
      'path_too_long',
      'path_case_mismatch',
      'file_not_analyzed',
    ] as const) {
      const outcome = await run(new ParserError(code, '/비밀/원문'));
      expect(statuses(outcome), code).toEqual([
        ['structure.public-api-only', 'fail'],
        ['structure.declared-direction', 'fail'],
      ]);
      expect(JSON.stringify(outcome)).not.toContain('비밀');
      expect(JSON.stringify(outcome)).toContain(code);
    }
    for (const code of [
      'project_not_found',
      'invalid_declaration',
      'cruise_failed',
      'cruise_output_invalid',
    ] as const) {
      const outcome = await run(new ParserError(code, '/비밀/원문'));
      expect(statuses(outcome), code).toBe('judge_runner_error');
      expect(JSON.stringify(outcome)).not.toContain('비밀');
    }
    await expect(run(new Error('모름'))).rejects.toThrow('모름');
  });

  it('겹침 · 결과 없음은 판정하지 않고 끝내며, 중단이면 신호의 사유로 던진다', async () => {
    expect(
      statuses(
        await run(
          analysis({ status: 'overlap', overlaps: capped([{ file: 'src/a.ts', blocks: ['a', 'b'] }]) }),
        ),
      ),
    ).toBe('block_declaration_overlap');
    expect(
      statuses(await run({ ...analysis({ status: 'checked', violations: capped([]) }), structure: null })),
    ).toBe('judge_runner_error');
    const controller = new AbortController();
    const reason = new Error('중단');
    controller.abort(reason);
    await expect(
      run(analysis({ status: 'checked', violations: capped([]) }), tempDir(), controller.signal),
    ).rejects.toBe(reason);
    // 파서가 중단으로 거부한 뒤에도 판정하지 않는다
    const late = new AbortController();
    const pending = runStructureCheck(tempDir(), plan, {
      signal: late.signal,
      analyze: ({ signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new ParserError('cruise_timeout', 'x'))),
        ),
    });
    late.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('체크아웃에 추적 중인 node_modules가 있으면 파서를 부르지 않고 두 규칙의 실패다', async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'packages', 'x', 'node_modules', 'evil'), { recursive: true });
    let called = false;
    const outcome = await runStructureCheck(dir, plan, {
      signal: new AbortController().signal,
      analyze: () => {
        called = true;
        return Promise.resolve(analysis({ status: 'checked', violations: capped([]) }));
      },
    });
    expect(called).toBe(false);
    expect(statuses(outcome)).toEqual([
      ['structure.public-api-only', 'fail'],
      ['structure.declared-direction', 'fail'],
    ]);
    expect(outcome).toMatchObject({
      summary: { status: 'tracked_install', trackedInstallDirs: 1 },
    });
    expect(outcome.kind === 'judged' && outcome.verdicts[0]?.cases[1]?.file).toBe(
      'packages/x/node_modules',
    );
  });
});
