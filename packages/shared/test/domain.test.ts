// 도메인 엔터티 스키마 검증 (architecture.md 3장). 아래 예시 값은 테스트 안에서만 쓴다.
import { describe, expect, it } from 'vitest';

import {
  AgentRole,
  APPROVAL_LOG_GENESIS_HASH,
  ApprovalLogEntry,
  Author,
  CommitSha,
  defaultSettings,
  EntityName,
  findMissingSettings,
  JudgmentResult,
  MissingSettingPath,
  Project,
  ProjectFile,
  Proposal,
  PROPOSAL_PAYLOAD_SCHEMAS,
  Requirement,
  RESERVED_ENTITY_NAMES,
  Rule,
  Run,
  Session,
  Settings,
  Step,
  SupportedProposalKind,
  Timestamp,
} from '../src/index.js';

const ID = {
  project: '01JA0000000000000000000000',
  req: '01JA0000000000000000000001',
  rule: '01JA0000000000000000000002',
  run: '01JA0000000000000000000003',
  step: '01JA0000000000000000000004',
  session: '01JA0000000000000000000005',
  proposal: '01JA0000000000000000000006',
  judgment: '01JA0000000000000000000007',
} as const;
const AT = '2026-10-15T00:00:00.000Z';
const SHA = 'a'.repeat(40);
const human = { kind: 'human' } as const;
const testWriter = { kind: 'agent', role: 'test-writer' } as const;

const requirement = {
  id: ID.req,
  displayId: 'REQ-001',
  text: '사용자는 이메일로 가입할 수 있다',
  author: human,
  normState: 'approved',
  unrulable: null,
  createdAt: AT,
  updatedAt: AT,
  updatedBy: human,
  deletedAt: null,
};

const rule = {
  id: ID.rule,
  displayId: 'RULE-001',
  title: '중복 이메일 가입 거부',
  statement: '이미 가입된 이메일로 가입을 요청하면, 시스템은 가입을 거부해야 한다',
  kind: 'business',
  checkKinds: ['test'],
  parentRequirementId: ID.req,
  parentDetachedAt: null,
  builtin: false,
  targetBlockIds: [],
  risk: null,
  contractId: null,
  author: { kind: 'agent', role: 'rule-writer' },
  normState: 'approved',
  createdAt: AT,
  updatedAt: AT,
  deletedAt: null,
};

const proposal = {
  id: ID.proposal,
  displayId: 'PRP-001',
  kind: 'rule_new',
  targetRef: { entity: 'Requirement', id: ID.req },
  payload: { title: '중복 이메일 가입 거부' },
  diff: { before: null, after: { title: '중복 이메일 가입 거부' } },
  rationale: '요구사항의 예외 경로',
  author: { kind: 'agent', role: 'rule-writer' },
  source: 'rule_generation',
  risk: null,
  readAt: null,
  state: 'pending',
  decision: null,
  adrId: null,
  runId: null,
  createdAt: AT,
};

const run = {
  id: ID.run,
  displayId: 'EXE-001',
  projectId: ID.project,
  type: 'A',
  targetRuleIds: [ID.rule],
  status: 'running',
  currentStep: 'test_writing',
  lastCompletedStep: 'approval',
  regressionCount: 0,
  failureReason: null,
  branch: 'bive/exe-001',
  worktreePath: '/tmp/bive/work/p/worktrees/r',
  baseBranch: 'main',
  baseCommit: SHA,
  headCommit: null,
  mergeCommit: null,
  budgetSnapshot: { runTotalUsd: 5, perRole: { testWriter: 1, implementer: 3 } },
  modelSnapshot: { 'test-writer': 'model-a', implementer: 'model-b' },
  costUsd: null,
  turns: null,
  toolManifest: [{ role: 'test-writer', tools: ['read_file', 'write_test'], mcpServerCount: 1 }],
  startedBy: human,
  createdAt: AT,
  startedAt: AT,
  endedAt: null,
};

const step = {
  id: ID.step,
  runId: ID.run,
  kind: 'test_writing',
  attempt: 1,
  status: 'running',
  role: 'test-writer',
  exitDetail: null,
  commit: null,
  costUsd: null,
  turns: null,
  startedAt: AT,
  endedAt: null,
};

const session = {
  id: ID.session,
  stepId: ID.step,
  role: 'test-writer',
  model: 'model-a',
  sdkSessionId: null,
  workDir: '/tmp/bive/work/p/sessions/s',
  endReason: null,
  totalCostUsd: null,
  numTurns: null,
  modelUsage: {},
  firstTurnCacheWrite: null,
  tools: [],
  mcpServers: [],
};

const judgment = {
  id: ID.judgment,
  ruleId: ID.rule,
  runId: ID.run,
  stepId: ID.step,
  commit: SHA,
  judgedAt: AT,
  status: 'pass',
  runner: 'vitest',
  exitCode: 0,
  reporterPath: '/tmp/bive/projects/p/judge/r/report.json',
  cases: [
    { name: '중복 이메일', file: 'tests/a.test.ts', line: 3, status: 'passed', message: null },
  ],
  quarantineReason: null,
};

const emptyRole = { model: null, maxBudgetUsd: null, maxTurns: null };
const settings = {
  projectId: ID.project,
  run: { maxBudgetUsd: null, maxTurns: null },
  roles: {
    'rule-writer': emptyRole,
    planner: emptyRole,
    'test-writer': emptyRole,
    implementer: emptyRole,
    chat: emptyRole,
  },
  approvalQueueLimit: 40,
  provisionalPolicy: 'off',
  autoMode: false,
  installAllowlist: [],
  updatedAt: null,
  updatedBy: null,
};

describe('공통 값', () => {
  it('엔터티 이름: M0 · M1 스키마 10개 + 예약 12개', () => {
    expect(EntityName.options).toHaveLength(22);
    for (const name of RESERVED_ENTITY_NAMES) expect(EntityName.options).toContain(name);
  });

  it('시각은 UTC ISO 8601만', () => {
    expect(Timestamp.safeParse(AT).success).toBe(true);
    expect(Timestamp.safeParse('2026-10-15T09:00:00+09:00').success).toBe(false);
    expect(Timestamp.safeParse('2026-10-15').success).toBe(false);
  });

  it('커밋 해시는 40자 또는 64자 소문자 16진수', () => {
    expect(CommitSha.safeParse(SHA).success).toBe(true);
    expect(CommitSha.safeParse('b'.repeat(64)).success).toBe(true);
    expect(CommitSha.safeParse('A'.repeat(40)).success).toBe(false);
    expect(CommitSha.safeParse('a'.repeat(41)).success).toBe(false);
  });

  it('생성 주체: 사람 · 역할 있는 에이전트', () => {
    expect(Author.parse(human)).toEqual(human);
    expect(Author.parse(testWriter)).toEqual(testWriter);
    expect(Author.safeParse({ kind: 'agent' }).success).toBe(false);
    expect(Author.safeParse({ kind: 'human', role: 'chat' }).success).toBe(false);
    expect(Author.safeParse({ kind: 'agent', role: 'reviewer' }).success).toBe(false);
  });
});

describe('프로젝트 · 설정', () => {
  it('프로젝트', () => {
    const project = {
      id: ID.project,
      name: 'sample',
      rootPath: '/p',
      baseBranch: 'main',
      createdAt: AT,
    };
    expect(Project.parse(project)).toEqual(project);
    expect(Project.safeParse({ ...project, id: 'x' }).success).toBe(false);
  });

  it('식별 파일은 projectId · schemaVersion만 (ADR-025)', () => {
    expect(ProjectFile.safeParse({ projectId: ID.project, schemaVersion: 1 }).success).toBe(true);
    expect(
      ProjectFile.safeParse({ projectId: ID.project, schemaVersion: 1, name: 'x' }).success,
    ).toBe(false);
  });

  it('설정은 예산 · 모델 미설정을 저장할 수 있고 기본값과 같다', () => {
    expect(Settings.parse(settings)).toEqual(settings);
    expect(defaultSettings(ID.project)).toEqual(settings);
    const filled = {
      ...settings,
      run: { maxBudgetUsd: 5, maxTurns: 200 },
      roles: {
        ...settings.roles,
        implementer: { model: 'model-b', maxBudgetUsd: 2, maxTurns: 30 },
      },
      updatedAt: AT,
      updatedBy: human,
    };
    expect(Settings.safeParse(filled).success).toBe(true);
    expect(Settings.safeParse({ ...settings, provisionalPolicy: 'two_axis' }).success).toBe(false);
  });

  it('설정 한도는 0보다 크고 턴은 정수, 모델은 공백만이면 안 되며 역할 키는 전부 있어야 한다', () => {
    const run = (value: object) => Settings.safeParse({ ...settings, run: value }).success;
    expect(run({ maxBudgetUsd: 0, maxTurns: null })).toBe(false);
    expect(run({ maxBudgetUsd: -1, maxTurns: null })).toBe(false);
    expect(run({ maxBudgetUsd: 0.01, maxTurns: 1.5 })).toBe(false);
    expect(run({ maxBudgetUsd: 0.01, maxTurns: 0 })).toBe(false);
    expect(run({ maxBudgetUsd: 0.01, maxTurns: 1 })).toBe(true);
    const role = (value: object) =>
      Settings.safeParse({ ...settings, roles: { ...settings.roles, chat: value } }).success;
    expect(role({ ...emptyRole, model: '  ' })).toBe(false);
    expect(role({ ...emptyRole, model: 'm'.repeat(201) })).toBe(false);
    expect(role({ ...emptyRole, model: 'model-a' })).toBe(true);
    expect(
      Settings.safeParse({ ...settings, roles: { ...settings.roles, reviewer: emptyRole } })
        .success,
    ).toBe(false);
    const withoutChat = Object.fromEntries(
      Object.entries(settings.roles).filter(([role]) => role !== 'chat'),
    );
    expect(Settings.safeParse({ ...settings, roles: withoutChat }).success).toBe(false);
    // 변경 주체는 사람뿐
    expect(
      Settings.safeParse({ ...settings, updatedAt: AT, updatedBy: { kind: 'agent', role: 'chat' } })
        .success,
    ).toBe(false);
  });

  it('실행 전 검사는 실행 전체 한도와 고른 역할의 빈 항목을 순서대로 돌려준다 (NFR-07)', () => {
    expect(findMissingSettings(settings)).toEqual([
      'run.maxBudgetUsd',
      'run.maxTurns',
      'roles.rule-writer.model',
      'roles.rule-writer.maxBudgetUsd',
      'roles.rule-writer.maxTurns',
      'roles.test-writer.model',
      'roles.test-writer.maxBudgetUsd',
      'roles.test-writer.maxTurns',
      'roles.implementer.model',
      'roles.implementer.maxBudgetUsd',
      'roles.implementer.maxTurns',
    ]);
    const full = { model: 'model-a', maxBudgetUsd: 1, maxTurns: 10 };
    const ready = {
      run: { maxBudgetUsd: 5, maxTurns: 200 },
      roles: { ...settings.roles, 'rule-writer': full, 'test-writer': full, implementer: full },
    };
    expect(findMissingSettings(ready)).toEqual([]);
    expect(findMissingSettings(ready, ['chat'])).toEqual([
      'roles.chat.model',
      'roles.chat.maxBudgetUsd',
      'roles.chat.maxTurns',
    ]);
    for (const path of findMissingSettings(settings, AgentRole.options)) {
      expect(MissingSettingPath.safeParse(path).success).toBe(true);
    }
    expect(MissingSettingPath.safeParse('roles.reviewer.model').success).toBe(false);
  });
});

describe('규범', () => {
  it('요구사항', () => {
    expect(Requirement.parse(requirement)).toEqual(requirement);
    expect(Requirement.safeParse({ ...requirement, displayId: 'RULE-001' }).success).toBe(false);
    expect(Requirement.safeParse({ ...requirement, text: '' }).success).toBe(false);
    expect(
      Requirement.safeParse({ ...requirement, updatedBy: { kind: 'agent', role: 'chat' } }).success,
    ).toBe(true);
    const withoutUpdatedBy: Record<string, unknown> = { ...requirement };
    delete withoutUpdatedBy.updatedBy;
    expect(Requirement.safeParse(withoutUpdatedBy).success).toBe(false);
    expect(
      Requirement.safeParse({ ...requirement, unrulable: { reason: '측정 불가' } }).success,
    ).toBe(true);
  });

  it('규칙: 검사 1개 이상, 내장 규칙만 부모 없음', () => {
    expect(Rule.parse(rule)).toEqual(rule);
    expect(Rule.safeParse({ ...rule, checkKinds: [] }).success).toBe(false);
    expect(Rule.safeParse({ ...rule, parentRequirementId: null }).success).toBe(false);
    expect(
      Rule.safeParse({ ...rule, parentRequirementId: null, builtin: true, kind: 'architecture' })
        .success,
    ).toBe(true);
  });

  it('규칙: 부모 요구사항이 삭제되면 부모 없이 해제 시각만 남는다 (ADR-050)', () => {
    const detached = { ...rule, parentRequirementId: null, parentDetachedAt: AT };
    expect(Rule.parse(detached)).toEqual(detached);
    expect(Rule.safeParse({ ...rule, parentDetachedAt: AT }).success).toBe(false);
  });

  it('제안: 대기 중이면 처리 기록 없음', () => {
    expect(Proposal.parse(proposal)).toEqual(proposal);
    expect(Proposal.safeParse({ ...proposal, decision: { at: AT, by: human } }).success).toBe(
      false,
    );
    expect(Proposal.safeParse({ ...proposal, author: human }).success).toBe(false);
  });

  it('제안: 거절은 사유 필수, 승인은 사유 금지 · 반영 규범 필수, 처리 주체는 사람', () => {
    const by = human;
    const appliedRef = { entity: 'Rule', id: ID.rule };
    const rejected = { ...proposal, state: 'rejected' };
    expect(Proposal.safeParse({ ...rejected, decision: { at: AT, by } }).success).toBe(false);
    expect(
      Proposal.safeParse({ ...rejected, decision: { at: AT, by, rejectReason: '' } }).success,
    ).toBe(false);
    expect(
      Proposal.safeParse({ ...rejected, decision: { at: AT, by, rejectReason: '범위 밖' } })
        .success,
    ).toBe(true);
    expect(
      Proposal.safeParse({
        ...rejected,
        decision: { at: AT, by, rejectReason: '범위 밖', appliedRef },
      }).success,
    ).toBe(false);
    const approved = { ...proposal, state: 'approved' };
    expect(Proposal.safeParse({ ...approved, decision: null }).success).toBe(false);
    expect(
      Proposal.safeParse({
        ...approved,
        decision: { at: AT, by, appliedRef, editedPayload: { title: 'x' } },
      }).success,
    ).toBe(true);
    expect(Proposal.safeParse({ ...approved, decision: { at: AT, by } }).success).toBe(false);
    expect(Proposal.safeParse({ ...approved, decision: { at: AT, appliedRef } }).success).toBe(
      false,
    );
    expect(
      Proposal.safeParse({ ...approved, decision: { at: AT, by: testWriter, appliedRef } }).success,
    ).toBe(false);
    expect(
      Proposal.safeParse({ ...approved, decision: { at: AT, by, appliedRef, rejectReason: 'x' } })
        .success,
    ).toBe(false);
  });

  it('제안 본문: 종류별 스키마 (요구사항 신규 · 규칙 신규)', () => {
    expect(PROPOSAL_PAYLOAD_SCHEMAS.requirement_new.safeParse({ text: '본문' }).success).toBe(true);
    expect(PROPOSAL_PAYLOAD_SCHEMAS.requirement_new.safeParse({ text: '  ' }).success).toBe(false);
    const rulePayload = {
      title: '중복 이메일 가입 거부',
      statement: 'WHEN 이미 가입된 이메일로 가입 요청 THE SYSTEM SHALL 가입 거부',
      kind: 'business',
      checkKinds: ['test'],
      parentRequirementId: ID.req,
    };
    expect(PROPOSAL_PAYLOAD_SCHEMAS.rule_new.parse(rulePayload)).toEqual(rulePayload);
    expect(
      PROPOSAL_PAYLOAD_SCHEMAS.rule_new.safeParse({ ...rulePayload, checkKinds: [] }).success,
    ).toBe(false);
    expect(
      PROPOSAL_PAYLOAD_SCHEMAS.rule_new.safeParse({ ...rulePayload, checkKinds: ['test', 'test'] })
        .success,
    ).toBe(false);
    expect(
      PROPOSAL_PAYLOAD_SCHEMAS.rule_new.safeParse({ ...rulePayload, parentRequirementId: null })
        .success,
    ).toBe(false);
    expect(Object.keys(PROPOSAL_PAYLOAD_SCHEMAS)).toEqual(SupportedProposalKind.options);
  });

  it('승인 기록: 행동별 상세 (수정 diff · 거절 사유), 주체는 사람', () => {
    const entry = {
      seq: 1,
      at: AT,
      action: 'approve',
      actor: human,
      targetRef: { entity: 'Proposal', id: ID.proposal },
      clientId: 'pipe-1',
      detail: { appliedRef: { entity: 'Rule', id: ID.rule } },
      prevHash: APPROVAL_LOG_GENESIS_HASH,
      hash: 'f'.repeat(64),
    };
    expect(ApprovalLogEntry.parse(entry)).toEqual(entry);
    const diff = { before: { text: 'a' }, after: { text: 'b' } };
    expect(ApprovalLogEntry.safeParse({ ...entry, action: 'approve_edited' }).success).toBe(false);
    expect(
      ApprovalLogEntry.safeParse({ ...entry, action: 'approve_edited', detail: { diff } }).success,
    ).toBe(true);
    expect(ApprovalLogEntry.safeParse({ ...entry, detail: { diff } }).success).toBe(false);
    expect(ApprovalLogEntry.safeParse({ ...entry, action: 'reject', detail: {} }).success).toBe(
      false,
    );
    expect(
      ApprovalLogEntry.safeParse({ ...entry, action: 'reject', detail: { reason: '범위 밖' } })
        .success,
    ).toBe(true);
    expect(ApprovalLogEntry.safeParse({ ...entry, actor: testWriter }).success).toBe(false);
    expect(ApprovalLogEntry.safeParse({ ...entry, prevHash: 'x' }).success).toBe(false);
  });
});

describe('실행', () => {
  it('실행', () => {
    expect(Run.parse(run)).toEqual(run);
    expect(Run.safeParse({ ...run, targetRuleIds: [] }).success).toBe(false);
    expect(Run.safeParse({ ...run, displayId: 'RUN-001' }).success).toBe(false);
    expect(Run.safeParse({ ...run, startedBy: testWriter }).success).toBe(false);
    expect(Run.safeParse({ ...run, type: 'E' }).success).toBe(false);
    expect(Run.safeParse({ ...run, regressionCount: -1 }).success).toBe(false);
  });

  it('단계', () => {
    expect(Step.parse(step)).toEqual(step);
    expect(Step.safeParse({ ...step, attempt: 0 }).success).toBe(false);
    expect(Step.safeParse({ ...step, kind: 'deploy' }).success).toBe(false);
  });

  it('세션: 진행 중이면 종료 사유 · 비용 없음', () => {
    expect(Session.parse(session)).toEqual(session);
    const ended = {
      ...session,
      endReason: 'error_max_budget_usd',
      totalCostUsd: 1.25,
      numTurns: 12,
      modelUsage: {
        'model-a': {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 100,
          costUsd: 1.25,
        },
      },
      firstTurnCacheWrite: 100,
    };
    expect(Session.safeParse(ended).success).toBe(true);
    expect(Session.safeParse({ ...session, endReason: 'timeout' }).success).toBe(false);
  });
});

describe('판정', () => {
  it('판정 결과', () => {
    expect(JudgmentResult.parse(judgment)).toEqual(judgment);
    expect(JudgmentResult.safeParse({ ...judgment, runner: 'jest' }).success).toBe(false);
  });

  it('격리는 사유 필수, 그 외는 사유 금지', () => {
    expect(JudgmentResult.safeParse({ ...judgment, status: 'quarantined' }).success).toBe(false);
    expect(
      JudgmentResult.safeParse({
        ...judgment,
        status: 'quarantined',
        quarantineReason: '불안정한 검사',
      }).success,
    ).toBe(true);
    expect(JudgmentResult.safeParse({ ...judgment, quarantineReason: 'x' }).success).toBe(false);
  });
});
