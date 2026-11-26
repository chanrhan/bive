// 추적성 결함 · 규칙화 불가 (M3-11 #56, NRM-06 · NRM-08, ADR-100 명세 변경 목록 NRM-06, ADR-112 · ADR-137).
// 실제 Unix 소켓 · 임시 BIVE_HOME · 실제 SQLite 저장소. 값은 `rule.list`의 `traceability`와 `verification.summary`의
// `traceability` · `unrulable`로 읽는다(같은 함수). 규칙화 불가 표시는 `requirement.markUnrulable`(사람 전용).
import { execFileSync } from 'node:child_process';

import {
  type Author,
  createUlidGenerator,
  DomainErrorReason,
  ErrorCode,
  type Requirement,
  type Rule,
  type RuleWithJudgment,
  type Traceability,
  UNRULABLE_REASON_MAX,
} from '@bive/shared';
import { openProjectStore, registerProject, type ProjectStore } from '@bive/store';
import { afterEach, describe, expect, it } from 'vitest';

import { loadScenario } from '../src/agent/scenario.js';
import { ScriptedAdapter } from '../src/agent/scripted-adapter.js';
import type { PipeServer } from '../src/ipc/server.js';
import { retireAgentRule } from '../src/norms/agent-rule.js';
import {
  type RuleWriterLauncher,
  RuleWriterService,
} from '../src/rule-writer/rule-writer-service.js';
import { requirementsWithoutRules, traceabilityOf } from '../src/verification/summary.js';
import type { TestClient } from './helpers/client.js';
import { commitAcceptanceFiles, initAcceptanceRepo } from './helpers/acceptance-commit.js';
import { seedNormRequirement, seedNormRule } from './helpers/engine-harness.js';
import { cleanup, makeBiveHome } from './helpers/process.js';
import { iso, type ProjectHarness, startProjectHarness, T0 } from './helpers/project-harness.js';

const human = { kind: 'human' } as const satisfies Author;
const agent = { kind: 'agent', role: 'rule-writer' } as const satisfies Author;
const newId = createUlidGenerator();

const servers: PipeServer[] = [];
const clients: TestClient[] = [];
const services: RuleWriterService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) await server.close();
  await cleanup();
});

/** 규칙 작성 창구 호출 기록 (규칙화 불가 표시가 세션을 띄우지 않는지 본다). */
const launcherSpy = (): RuleWriterLauncher & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    start: () => {
      calls.push('start');
      return { status: 'skipped', reason: 'closed', record: null };
    },
    retry: () => {
      calls.push('retry');
      return null;
    },
    rejudge: () => {
      calls.push('rejudge');
      return null;
    },
  };
};

const harness = async (): Promise<
  ProjectHarness & { launcher: ReturnType<typeof launcherSpy> }
> => {
  const launcher = launcherSpy();
  const h = await startProjectHarness({ servers, clients }, { ruleWriter: () => launcher });
  return { ...h, launcher };
};

const listed = async (h: ProjectHarness): Promise<Traceability | undefined> =>
  (await h.client.call('rule.list', { projectId: h.project.id, includeRetired: true }))
    .traceability;
const summarized = (h: ProjectHarness) =>
  h.client.call('verification.summary', { projectId: h.project.id });

/** 진술마다 겹치지 않는 낱말을 넣는다 (폐기 근거의 인용 검사가 다른 효력 규칙과 겹치지 않는 조각을 요구한다, ADR-115). */
const rule = (
  store: ProjectStore,
  parent: Requirement | null,
  word: string,
  extra: { builtin?: boolean; normState?: Rule['normState'] } = {},
): Rule =>
  seedNormRule(store, {
    title: `${word} 규칙`,
    statement: `WHEN 사용자가 ${word} 화면을 열면 THE SYSTEM SHALL ${word} 목록을 보인다`,
    parent,
    at: T0,
    ...extra,
  });

const retire = (store: ProjectStore, target: Rule): void => {
  retireAgentRule(
    store,
    {
      ruleId: target.id,
      grounds: `진술 "${target.statement}"이 새 요구사항과 모순`,
      author: agent,
      sessionId: newId(),
    },
    { now: Date.now },
  );
};

const refs = (items: readonly { id: string; displayId: string }[]) =>
  items.map(({ id, displayId }) => ({ id, displayId }));

describe('추적성 결함의 개수와 목록 (NRM-06, ADR-137)', () => {
  it('빈 프로젝트: 두 목록 모두 비고 규칙화 불가는 0 / 0이다', async () => {
    const h = await harness();
    expect(await h.client.call('rule.list', { projectId: h.project.id })).toEqual({
      rules: [],
      traceability: { requirementsWithoutRules: [], parentlessRules: [] },
    });
    const summary = await summarized(h);
    expect(summary.traceability).toEqual({ requirementsWithoutRules: [], parentlessRules: [] });
    expect(summary.unrulable).toEqual({ count: 0, total: 0 });
  });

  it('규칙 없는 요구사항과 부모 없는 규칙을 표시 ID 순으로 돌려주고, 내장 규칙 · 규칙화 불가 · 폐기 · 삭제를 빼며 자식 규칙이 모두 폐기된 요구사항은 결함이다', async () => {
    const h = await harness();
    const seeded = h.read((store) => {
      const covered = seedNormRequirement(store, '규칙이 있는 요구사항', T0); // REQ-001
      const bare = seedNormRequirement(store, '규칙이 없는 요구사항', T0); // REQ-002
      const unrulable = seedNormRequirement(store, '규칙화 불가 요구사항', T0); // REQ-003
      const allRetired = seedNormRequirement(store, '자식 규칙이 모두 폐기된 요구사항', T0); // REQ-004
      const provisionalOnly = seedNormRequirement(store, '잠정 규칙만 있는 요구사항', T0); // REQ-005
      const toDelete = seedNormRequirement(store, '지울 요구사항', T0); // REQ-006
      const halfRetired = seedNormRequirement(store, '폐기와 효력 규칙이 섞인 요구사항', T0); // REQ-007
      const coveredRule = rule(store, covered, '주문'); // RULE-001
      const retiredA = rule(store, allRetired, '배송'); // RULE-002
      const retiredB = rule(store, allRetired, '반품'); // RULE-003
      rule(store, provisionalOnly, '쿠폰', { normState: 'provisional' }); // RULE-004
      const orphanByDelete = rule(store, toDelete, '정산'); // RULE-005
      const builtin = rule(store, null, '구조', { builtin: true }); // RULE-006
      retire(store, rule(store, halfRetired, '적립')); // RULE-007 (폐기)
      rule(store, halfRetired, '등급'); // RULE-008
      retire(store, retiredA);
      retire(store, retiredB);
      return {
        covered,
        bare,
        unrulable,
        allRetired,
        provisionalOnly,
        toDelete,
        halfRetired,
        coveredRule,
        orphanByDelete,
        builtin,
      };
    });
    // 규칙화 불가는 사람 RPC로 (요구사항 상세의 [규칙화 불가]와 같은 길)
    await h.client.call('requirement.markUnrulable', {
      projectId: h.project.id,
      id: seeded.unrulable.id,
      reason: '측정 기준 없음',
      author: human,
    });
    // 부모 없는 사람 규칙이 생기는 실제 경로: 요구사항 삭제가 자식 규칙의 부모를 해제한다 (ADR-050)
    await h.client.call('requirement.delete', {
      projectId: h.project.id,
      id: seeded.toDelete.id,
      author: human,
    });

    const expected: Traceability = {
      requirementsWithoutRules: refs([seeded.bare, seeded.allRetired, seeded.provisionalOnly]),
      parentlessRules: refs([seeded.orphanByDelete]),
    };
    expect(expected.requirementsWithoutRules.map((item) => item.displayId)).toEqual([
      'REQ-002',
      'REQ-004',
      'REQ-005',
    ]);
    expect(await listed(h)).toEqual(expected);
    // 폐기 포함 여부와 무관하다 (목록 옵션은 규칙 항목만 바꾼다)
    expect((await h.client.call('rule.list', { projectId: h.project.id })).traceability).toEqual(
      expected,
    );
    const summary = await summarized(h);
    expect(summary.traceability).toEqual(expected);
    // 규칙화 불가 비율: 삭제되지 않은 요구사항 6개 가운데 1개
    expect(summary.unrulable).toEqual({ count: 1, total: 6 });
    // 내장 규칙은 부모가 없어도 결함이 아니다 (대조: 부모가 정말 없다)
    expect(h.read((store) => store.rules.get(seeded.builtin.id)?.parentRequirementId)).toBeNull();
    expect(
      h.read((store) => store.rules.get(seeded.orphanByDelete.id)?.parentRequirementId),
    ).toBeNull();
  });

  it('부모 ID가 남았지만 부모가 삭제된 규칙도 부모 없는 규칙이고, 삭제 · 폐기된 부모 없는 규칙은 빠진다', async () => {
    const h = await harness();
    const seeded = h.read((store) => {
      const parent = seedNormRequirement(store, '부모', T0);
      const dangling = rule(store, parent, '알림'); // RULE-001
      const other = seedNormRequirement(store, '둘째 부모', T0);
      const deletedOrphan = rule(store, other, '메일'); // RULE-002
      const retiredOrphan = rule(store, other, '문자'); // RULE-003
      // 부모 해제 없이 요구사항만 지운 옛 모양 (제품 경로는 같은 트랜잭션에서 해제한다)
      store.requirements.softDelete(parent.id, { by: human, at: iso(T0 + 1) });
      store.requirements.softDelete(other.id, { by: human, at: iso(T0 + 1) });
      store.rules.detachFromParent(other.id, iso(T0 + 1));
      store.db
        .prepare('UPDATE rules SET deleted_at = ? WHERE id = ?')
        .run(iso(T0 + 2), deletedOrphan.id);
      retire(store, retiredOrphan);
      return { dangling };
    });
    expect(
      h.read((store) => store.rules.get(seeded.dangling.id)?.parentRequirementId),
    ).not.toBeNull();
    expect(await listed(h)).toEqual({
      requirementsWithoutRules: [],
      parentlessRules: refs([seeded.dangling]),
    });
  });

  it('다른 프로젝트의 요구사항 · 규칙은 섞이지 않는다', async () => {
    const h = await harness();
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
    const store = openProjectStore(other.id, { home: h.biveHome });
    try {
      seedNormRequirement(store, '다른 프로젝트의 규칙 없는 요구사항', T0);
    } finally {
      store.close();
    }
    const mine = h.read((s) => seedNormRequirement(s, '이 프로젝트의 요구사항', T0));
    expect(await listed(h)).toEqual({
      requirementsWithoutRules: refs([mine]),
      parentlessRules: [],
    });
    expect((await summarized(h)).unrulable).toEqual({ count: 0, total: 1 });
    const theirs = await h.client.call('rule.list', { projectId: other.id });
    expect(theirs.traceability?.requirementsWithoutRules.map((item) => item.displayId)).toEqual([
      'REQ-001',
    ]);
  });

  it('순수 함수: 효력 있는 자식 규칙 하나면 덮이고, 그 규칙이 폐기 목록에 들면 다시 결함이다', () => {
    const requirement: Requirement = {
      id: newId(),
      displayId: 'REQ-001',
      text: '본문',
      author: human,
      normState: 'approved',
      unrulable: null,
      createdAt: iso(T0),
      updatedAt: iso(T0),
      updatedBy: human,
      deletedAt: null,
      confirmation: { state: 'unconfirmed' },
    };
    const child: Rule = {
      id: newId(),
      displayId: 'RULE-001',
      title: '제목',
      statement: 'THE SYSTEM SHALL 동작한다',
      kind: 'business',
      checkKinds: ['test'],
      parentRequirementId: requirement.id,
      parentDetachedAt: null,
      builtin: false,
      targetBlockIds: [],
      risk: null,
      contractId: null,
      author: agent,
      normState: 'approved',
      createdAt: iso(T0),
      updatedAt: iso(T0),
      deletedAt: null,
      confirmation: { state: 'unconfirmed' },
    };
    expect(requirementsWithoutRules([requirement], [child], new Set())).toEqual([]);
    expect(requirementsWithoutRules([requirement], [child], new Set([child.id]))).toEqual([
      requirement,
    ]);
    expect(
      requirementsWithoutRules([{ ...requirement, unrulable: { reason: '사유' } }], [], new Set()),
    ).toEqual([]);
    expect(
      requirementsWithoutRules([{ ...requirement, deletedAt: iso(T0) }], [], new Set()),
    ).toEqual([]);
  });
});

describe('계약 검사 규칙 (ADR-129 ⑤, ADR-137 ①)', () => {
  it('실제 등록(contract.register)으로 생긴 계약 검사 규칙(내장 · 부모 없음 · contractId 있음)은 부모 없는 규칙이 아니고 개수에도 들지 않는다', async () => {
    const repo = initAcceptanceRepo(makeBiveHome());
    const commit = commitAcceptanceFiles(repo, {
      'openapi.yaml': 'openapi: 3.1.0\ninfo:\n  title: 샘플\n  version: 1.0.0\npaths: {}\n',
    });
    execFileSync('git', ['update-ref', 'refs/heads/main', commit], { cwd: repo });
    const h = await startProjectHarness({ servers, clients }, { rootPath: repo });
    const registered = await h.client.call('contract.register', {
      projectId: h.project.id,
      file: 'openapi.yaml',
      kind: 'openapi',
      author: human,
    });
    const checkRule = h.read((store) =>
      store.rules.list().find((item) => item.contractId === registered.contract.id),
    );
    // 대조: 정말 내장 · 부모 없음 · 효력 있는 규칙이다
    expect(checkRule).toMatchObject({
      builtin: true,
      parentRequirementId: null,
      normState: 'approved',
      deletedAt: null,
    });
    const empty = { requirementsWithoutRules: [], parentlessRules: [] };
    expect(await listed(h)).toEqual(empty);
    expect((await summarized(h)).traceability).toEqual(empty);
  });
});

describe('requirement.markUnrulable (NRM-08, ADR-137)', () => {
  const mark = (h: ProjectHarness, id: string, reason: string, author: Author = human) =>
    h.client.call('requirement.markUnrulable', { projectId: h.project.id, id, reason, author });

  it('사람의 표시: 사유 · 수정 주체 · 시각이 남고 확인됨이 되며, 승인 기록 · 규범 변경 기록 · 규칙 작성 세션이 없고 추적성 결함에서 빠진다', async () => {
    const h = await harness();
    const requirement = h.read((store) => seedNormRequirement(store, '화면 전환은 빠를 것', T0));
    expect((await listed(h))?.requirementsWithoutRules.map((item) => item.id)).toEqual([
      requirement.id,
    ]);
    h.clock.now = T0 + 5_000;
    const { requirement: marked } = await mark(h, requirement.id, '측정 기준 없음');
    expect(marked).toEqual({
      ...requirement,
      unrulable: { reason: '측정 기준 없음' },
      updatedAt: iso(T0 + 5_000),
      updatedBy: human,
      confirmation: {
        state: 'confirmed',
        at: iso(T0 + 5_000),
        by: human,
        basis: { kind: 'requirement_record', at: iso(T0 + 5_000) },
      },
    });
    expect(
      (await h.client.call('requirement.get', { projectId: h.project.id, id: requirement.id }))
        .requirement,
    ).toEqual(marked);
    h.read((store) => {
      expect(store.approvalLog.list()).toEqual([]);
      expect(store.normChanges.list()).toEqual([]);
    });
    expect(h.launcher.calls).toEqual([]);
    expect(await listed(h)).toEqual({ requirementsWithoutRules: [], parentlessRules: [] });
    expect((await summarized(h)).unrulable).toEqual({ count: 1, total: 1 });
  });

  it('빈 사유(공백만 포함)는 -32001 UNRULABLE_REASON_REQUIRED, 상한 초과는 UNRULABLE_REASON_INVALID로 거부하고 바꾸지 않는다', async () => {
    const h = await harness();
    const requirement = h.read((store) => seedNormRequirement(store, '본문', T0));
    for (const reason of ['', ' ', '\t\n', '　 ']) {
      await expect(mark(h, requirement.id, reason)).rejects.toMatchObject({
        code: ErrorCode.ValidationFailed,
        data: { reason: DomainErrorReason.UnrulableReasonRequired },
      });
    }
    await expect(
      mark(h, requirement.id, 'a'.repeat(UNRULABLE_REASON_MAX + 1)),
    ).rejects.toMatchObject({
      code: ErrorCode.ValidationFailed,
      data: { reason: DomainErrorReason.UnrulableReasonInvalid },
    });
    expect(h.read((store) => store.requirements.get(requirement.id))).toEqual(requirement);
    // 상한 그대로는 받는다 (사유는 원문 그대로 저장)
    const exact = ` ${'a'.repeat(UNRULABLE_REASON_MAX - 2)}\n`;
    expect((await mark(h, requirement.id, exact)).requirement.unrulable).toEqual({
      reason: exact,
    });
  });

  it('에이전트 주체는 -32020 (없는 프로젝트여도 저장소를 열기 전에)', async () => {
    const h = await harness();
    const requirement = h.read((store) => seedNormRequirement(store, '본문', T0));
    await expect(mark(h, requirement.id, '사유', agent)).rejects.toMatchObject({
      code: ErrorCode.Unauthorized,
    });
    await expect(
      h.client.call('requirement.markUnrulable', {
        projectId: newId(),
        id: requirement.id,
        reason: '사유',
        author: agent,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
    expect(h.read((store) => store.requirements.get(requirement.id))).toEqual(requirement);
  });

  it('없는 요구사항 -32004, 삭제 · 이미 표시 · 효력 있는 자식 규칙은 -32009(사유별), 자식 규칙이 모두 폐기됐으면 받는다', async () => {
    const h = await harness();
    const seeded = h.read((store) => {
      const deleted = seedNormRequirement(store, '지운 요구사항', T0);
      store.requirements.softDelete(deleted.id, { by: human, at: iso(T0) });
      const withRule = seedNormRequirement(store, '규칙 있는 요구사항', T0);
      rule(store, withRule, '결제');
      const retiredOnly = seedNormRequirement(store, '폐기 규칙만 남은 요구사항', T0);
      retire(store, rule(store, retiredOnly, '환불'));
      const already = seedNormRequirement(store, '이미 표시한 요구사항', T0);
      return { deleted, withRule, retiredOnly, already };
    });
    await expect(mark(h, newId(), '사유')).rejects.toMatchObject({ code: ErrorCode.NotFound });
    await expect(mark(h, seeded.deleted.id, '사유')).rejects.toMatchObject({
      code: ErrorCode.StateConflict,
      data: { reason: 'requirement_deleted' },
    });
    await expect(mark(h, seeded.withRule.id, '사유')).rejects.toMatchObject({
      code: ErrorCode.StateConflict,
      data: { reason: 'has_rules' },
    });
    expect(h.read((store) => store.requirements.get(seeded.withRule.id))).toEqual(seeded.withRule);
    await mark(h, seeded.already.id, '첫 사유');
    await expect(mark(h, seeded.already.id, '둘째 사유')).rejects.toMatchObject({
      code: ErrorCode.StateConflict,
      data: { reason: 'already_unrulable' },
    });
    expect(h.read((store) => store.requirements.get(seeded.already.id)?.unrulable)).toEqual({
      reason: '첫 사유',
    });
    expect(
      (await mark(h, seeded.retiredOnly.id, '규칙으로 옮길 수 없음')).requirement.unrulable,
    ).toEqual({ reason: '규칙으로 옮길 수 없음' });
  });
});

describe('no-rules 시나리오 (규칙 작성 제안 0개, ADR-137)', () => {
  it('규칙 작성 세션이 규칙을 만들지 않고 정상 종료하면 그 요구사항이 규칙 없는 요구사항으로 남는다', async () => {
    let service: RuleWriterService | null = null;
    const h = await startProjectHarness(
      { servers, clients },
      {
        ruleWriter: ({ biveHome, now }) => {
          service = new RuleWriterService({
            biveHome,
            now,
            adapter: new ScriptedAdapter({
              scenario: loadScenario('no-rules'),
              biveHome,
              pollIntervalMs: 10,
            }),
          });
          services.push(service);
          return service;
        },
      },
    );
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
      text: '화면은 보기 좋을 것',
      author: human,
    });
    const writer = service as RuleWriterService | null;
    if (writer === null) throw new Error('서비스 없음');
    await writer.whenSettled(h.project.id, requirement.id);

    const status = await h.client.call('ruleWriter.status', {
      projectId: h.project.id,
      requirementId: requirement.id,
    });
    expect(status.entries.map((entry) => [entry.state, entry.endReason])).toEqual([
      ['ended', 'success'],
    ]);
    const list = await h.client.call('rule.list', { projectId: h.project.id });
    expect(list.rules).toEqual([] satisfies RuleWithJudgment[]);
    const expected = {
      requirementsWithoutRules: [{ id: requirement.id, displayId: requirement.displayId }],
      parentlessRules: [],
    };
    expect(list.traceability).toEqual(expected);
    expect((await summarized(h)).traceability).toEqual(expected);
    // 만든 규칙이 없어 규범 변경 기록 · 실행도 없다
    h.read((store) => {
      expect(store.normChanges.list()).toEqual([]);
      expect(store.runs.list()).toEqual([]);
      expect(traceabilityOf(store)).toEqual(expected);
    });
  });
});
