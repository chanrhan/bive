// 도메인 엔터티 스키마 검증 (architecture.md 3장). 아래 예시 값은 테스트 안에서만 쓴다.
import { describe, expect, it } from 'vitest';

import {
  AgentRole,
  APPROVAL_LOG_GENESIS_HASH,
  ApprovalLogEntry,
  Author,
  CODE_OPEN_REASON_LABELS,
  CodeFilePath,
  CodeOpenListResult,
  CodeOpenReason,
  CodeOpenRecord,
  CodeOpenRecordParams,
  CodeOpenSummaryResult,
  CommitSha,
  Confirmation,
  compareSteps,
  defaultSettings,
  EntityName,
  findMissingSettings,
  IDE_URL_SCHEME_HOSTS,
  IDE_URL_TEMPLATE_MAX_LENGTH,
  IDE_URL_TEMPLATES,
  IdeSetting,
  isAllowedIdeUrl,
  isIdeUrlTemplate,
  JudgmentResult,
  M1_RUN_TYPE,
  MissingSettingPath,
  Project,
  ProjectFile,
  Proposal,
  PROPOSAL_PAYLOAD_SCHEMAS,
  Requirement,
  RESERVED_ENTITY_NAMES,
  Rule,
  Run,
  RUN_STEP_PLANS,
  ScreenId,
  Session,
  Settings,
  Step,
  StoredCodeOpenRecord,
  stepRoles,
  SupportedProposalKind,
  Timestamp,
  isProjectRelativePath,
  METHOD_NAMES,
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
  confirmation: {
    state: 'confirmed',
    at: AT,
    by: human,
    basis: { kind: 'requirement_record', at: AT },
  },
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
  confirmation: { state: 'unconfirmed' },
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
  budgetSnapshot: {
    run: { maxBudgetUsd: 5, maxTurns: 200 },
    roles: {
      'test-writer': { maxBudgetUsd: 1, maxTurns: 50 },
      implementer: { maxBudgetUsd: 3, maxTurns: 100 },
    },
  },
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
  runId: ID.run,
  stepId: ID.step,
  requirementId: null,
  role: 'test-writer',
  model: 'model-a',
  sdkSessionId: null,
  workDir: '/tmp/bive/work/p/sessions/s',
  endReason: null,
  error: null,
  totalCostUsd: null,
  numTurns: null,
  modelUsage: {},
  firstTurnCacheWrite: null,
  budget: { maxBudgetUsd: 2, maxTurns: 100 },
  tools: [],
  mcpServers: [],
  startedAt: AT,
  endedAt: null,
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
  dailyBudgetUsd: null,
  approvalQueueLimit: 40,
  provisionalPolicy: 'off',
  autoMode: false,
  installAllowlist: [],
  ide: null,
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
    // 프로젝트 하루 한도(ADR-104): 비움(null) · 0 이상 수, 음수 · 무한대 · 키 없음은 거부
    const daily = (value: unknown) =>
      Settings.safeParse({ ...settings, dailyBudgetUsd: value }).success;
    expect(daily(null)).toBe(true);
    expect(daily(0)).toBe(true);
    expect(daily(2.5)).toBe(true);
    expect(daily(-0.01)).toBe(false);
    expect(daily(Infinity)).toBe(false);
    const withoutDaily: Record<string, unknown> = { ...settings };
    delete withoutDaily.dailyBudgetUsd;
    expect(Settings.safeParse(withoutDaily).success).toBe(false);
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

  it('확인 기록(confirm)은 요구사항 · 규칙 대상만, 반영 규범 · diff 없음. 직접 편집(rule_edit · contract_edit)은 diff 필수 (ADR-100 A2)', () => {
    const confirm = {
      seq: 1,
      at: AT,
      action: 'confirm',
      actor: human,
      targetRef: { entity: 'Rule', id: ID.rule },
      clientId: 'pipe-1',
      detail: {},
      prevHash: APPROVAL_LOG_GENESIS_HASH,
      hash: 'f'.repeat(64),
    };
    expect(ApprovalLogEntry.parse(confirm)).toEqual(confirm);
    expect(
      ApprovalLogEntry.safeParse({ ...confirm, targetRef: { entity: 'Requirement', id: ID.req } })
        .success,
    ).toBe(true);
    for (const targetRef of [
      { entity: 'Proposal', id: ID.proposal },
      { entity: 'Contract', id: ID.rule },
      { entity: 'Rule', id: 'RULE-001' },
    ]) {
      expect(ApprovalLogEntry.safeParse({ ...confirm, targetRef }).success).toBe(false);
    }
    expect(
      ApprovalLogEntry.safeParse({
        ...confirm,
        detail: { appliedRef: { entity: 'Rule', id: ID.rule } },
      }).success,
    ).toBe(false);
    expect(ApprovalLogEntry.safeParse({ ...confirm, actor: testWriter }).success).toBe(false);
    const diff = { before: { title: 'a' }, after: { title: 'b' } };
    expect(ApprovalLogEntry.safeParse({ ...confirm, detail: { diff } }).success).toBe(false);
    for (const action of ['rule_edit', 'contract_edit']) {
      expect(ApprovalLogEntry.safeParse({ ...confirm, action }).success).toBe(false);
      expect(ApprovalLogEntry.safeParse({ ...confirm, action, detail: { diff } }).success).toBe(
        true,
      );
    }
  });

  it('확인 상태: 두 값, 확인됨은 사람 · 시각 · 근거가 필수 (ADR-100 D2 · C1 · A1)', () => {
    expect(Confirmation.parse({ state: 'unconfirmed' })).toEqual({ state: 'unconfirmed' });
    const confirmed = {
      state: 'confirmed',
      at: AT,
      by: human,
      basis: { kind: 'approval_log', seq: 3 },
    };
    expect(Confirmation.parse(confirmed)).toEqual(confirmed);
    expect(
      Confirmation.safeParse({ ...confirmed, basis: { kind: 'requirement_record', at: AT } })
        .success,
    ).toBe(true);
    expect(Confirmation.safeParse({ ...confirmed, by: testWriter }).success).toBe(false);
    expect(Confirmation.safeParse({ state: 'confirmed', at: AT, by: human }).success).toBe(false);
    expect(Confirmation.safeParse({ state: 'disputed' }).success).toBe(false);
    expect(Confirmation.safeParse({ state: 'unconfirmed', at: AT }).success).toBe(false);
    expect(
      Confirmation.safeParse({ ...confirmed, basis: { kind: 'approval_log', seq: 0 } }).success,
    ).toBe(false);
    // 요구사항 · 규칙은 확인 상태를 가진다 (기본값 없음: 저장소가 항상 채운다)
    expect(Rule.safeParse({ ...rule, confirmation: undefined }).success).toBe(false);
    expect(Requirement.safeParse({ ...requirement, confirmation: undefined }).success).toBe(false);
  });

  it('실행 시작 기록은 대상 규칙(ruleIds)이 필수이고, 다른 행동에는 둘 수 없다 (ADR-061)', () => {
    const start = {
      seq: 1,
      at: AT,
      action: 'run_start',
      actor: human,
      targetRef: { entity: 'Run', id: ID.run },
      clientId: 'pipe-1',
      detail: { ruleIds: [ID.rule] },
      prevHash: APPROVAL_LOG_GENESIS_HASH,
      hash: 'f'.repeat(64),
    };
    expect(ApprovalLogEntry.parse(start)).toEqual(start);
    expect(ApprovalLogEntry.safeParse({ ...start, detail: {} }).success).toBe(false);
    expect(ApprovalLogEntry.safeParse({ ...start, detail: { ruleIds: [] } }).success).toBe(false);
    expect(
      ApprovalLogEntry.safeParse({ ...start, action: 'approve', detail: { ruleIds: [ID.rule] } })
        .success,
    ).toBe(false);
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
    expect(Run.safeParse({ ...run, targetRuleIds: [ID.rule, ID.rule] }).success).toBe(false);
  });

  it('시작 주체: 사람 또는 원인 기록 순번이 있는 오케스트레이터 (자동 시작, M7-05 · ADR-107)', () => {
    const auto = { ...run, startedBy: { kind: 'orchestrator', causeSeqs: [3, 4] } };
    expect(Run.parse(auto)).toEqual(auto);
    for (const startedBy of [
      { kind: 'orchestrator' },
      { kind: 'orchestrator', causeSeqs: [] },
      { kind: 'orchestrator', causeSeqs: [0] },
      { kind: 'orchestrator', causeSeqs: [1, 1] },
      { kind: 'orchestrator', causeSeqs: [1.5] },
      { kind: 'orchestrator', causeSeqs: [1], extra: true },
      { kind: 'human', causeSeqs: [1] },
    ]) {
      expect(Run.safeParse({ ...run, startedBy }).success, JSON.stringify(startedBy)).toBe(false);
    }
  });

  it('워크트리 전(승인 대기)에는 브랜치 · 워크트리 · 기준 커밋 · 시작 시각이 없다 (ADR-061)', () => {
    const waiting = {
      ...run,
      status: 'waiting_approval',
      currentStep: 'approval',
      lastCompletedStep: null,
      branch: null,
      worktreePath: null,
      baseCommit: null,
      toolManifest: [],
      startedAt: null,
    };
    expect(Run.parse(waiting)).toEqual(waiting);
  });

  it('예산 스냅샷은 실행 전체 · 역할 한도가 모두 있어야 한다 (NFR-07)', () => {
    const roleless = { ...run.budgetSnapshot, roles: {} };
    expect(Run.safeParse({ ...run, budgetSnapshot: roleless }).success).toBe(true);
    for (const bad of [
      { ...run.budgetSnapshot, run: { maxBudgetUsd: null, maxTurns: 200 } },
      { ...run.budgetSnapshot, run: { maxBudgetUsd: 0, maxTurns: 200 } },
      { ...run.budgetSnapshot, roles: { implementer: { maxBudgetUsd: 1, maxTurns: 0.5 } } },
      { runTotalUsd: 5, perRole: { testWriter: 1, implementer: 3 } },
    ]) {
      expect(Run.safeParse({ ...run, budgetSnapshot: bad }).success).toBe(false);
    }
    expect(Run.safeParse({ ...run, modelSnapshot: { implementer: '  ' } }).success).toBe(false);
  });

  it('유형 A 단계 순서 · 역할 · 정렬 (RUN-02)', () => {
    expect(RUN_STEP_PLANS.A).toEqual([
      'approval',
      'test_writing',
      'red_check',
      'implementation',
      'check',
      'mutation',
      'merge',
      'screen_update',
    ]);
    expect(M1_RUN_TYPE).toBe('A');
    expect(stepRoles(RUN_STEP_PLANS.A)).toEqual(['test-writer', 'implementer']);
    const steps = [
      { kind: 'check', attempt: 2 },
      { kind: 'implementation', attempt: 2 },
      { kind: 'approval', attempt: 1 },
      { kind: 'check', attempt: 1 },
      { kind: 'implementation', attempt: 1 },
    ] as const;
    expect([...steps].sort(compareSteps)).toEqual([
      { kind: 'approval', attempt: 1 },
      { kind: 'implementation', attempt: 1 },
      { kind: 'implementation', attempt: 2 },
      { kind: 'check', attempt: 1 },
      { kind: 'check', attempt: 2 },
    ]);
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
    // 실행 밖 세션(규칙 작성)은 실행 · 단계가 둘 다 없다
    expect(Session.safeParse({ ...session, runId: null, stepId: null }).success).toBe(true);
    expect(Session.safeParse({ ...session, stepId: null }).success).toBe(false);
    // 세션에 넘긴 한도 (ADR-067): 한도 없이 연 세션은 null, 있으면 양수 · 양의 정수
    expect(Session.safeParse({ ...session, budget: null }).success).toBe(true);
    expect(
      Session.safeParse({ ...session, budget: { maxBudgetUsd: 0, maxTurns: 1 } }).success,
    ).toBe(false);
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

describe('코드 열람 기록 (MET-01, ADR-084)', () => {
  const record = {
    id: ID.project,
    at: '2026-11-14T09:00:00.000Z',
    reason: 'debugging',
    sourceScreen: 'SCR-03',
    itemRef: { entity: 'Rule', id: ID.rule },
    file: 'bive-acceptance/RULE-001/health.acc.ts',
    line: 18,
  };

  it('CodeOpenRecord는 스키마가 생겨 예약 이름에서 빠졌다', () => {
    expect(CodeOpenRecord.safeParse(record).success).toBe(true);
    expect(EntityName.options).toContain('CodeOpenRecord');
    expect(RESERVED_ENTITY_NAMES).not.toContain('CodeOpenRecord');
  });

  it('읽기 형식(StoredCodeOpenRecord)은 경로 세부 규칙을 다시 적용하지 않지만 빈 경로 · 문자열 아닌 경로는 거부한다 (ADR-094)', () => {
    expect(StoredCodeOpenRecord.safeParse({ ...record, file: 'src/a%20b.ts' }).success).toBe(true);
    expect(CodeOpenRecord.safeParse({ ...record, file: 'src/a%20b.ts' }).success).toBe(false);
    expect(StoredCodeOpenRecord.safeParse({ ...record, file: '' }).success).toBe(false);
    expect(StoredCodeOpenRecord.safeParse({ ...record, file: 7 }).success).toBe(false);
    expect(StoredCodeOpenRecord.safeParse({ ...record, reason: 'curiosity' }).success).toBe(false);
  });

  it('사유 표시명은 화면 정의서 1.4의 세 가지(화면 오류 · 정보 부족 · 디버깅)이고 순서도 같다', () => {
    expect(Object.keys(CODE_OPEN_REASON_LABELS)).toEqual(CodeOpenReason.options);
    expect(Object.values(CODE_OPEN_REASON_LABELS)).toEqual(['화면 오류', '정보 부족', '디버깅']);
  });

  it('codeOpen.summary 결과: 사유 3종 고정 순서 · 0건 포함 · 합계 = 건수 합만 받는다 (ADR-088)', () => {
    const ok = {
      reasons: [
        { reason: 'screen_error', count: 1 },
        { reason: 'info_lacking', count: 0 },
        { reason: 'debugging', count: 2 },
      ],
      total: 3,
    };
    expect(CodeOpenSummaryResult.safeParse(ok).success).toBe(true);
    for (const [label, bad] of [
      ['사유 빠짐', { reasons: ok.reasons.slice(0, 2), total: 1 }],
      ['순서 다름', { ...ok, reasons: [...ok.reasons].reverse() }],
      ['합계 틀림', { ...ok, total: 4 }],
      [
        '음수 건수',
        { reasons: [{ reason: 'screen_error', count: -1 }, ...ok.reasons.slice(1)], total: 1 },
      ],
      ['다른 키', { ...ok, truncated: false }],
    ] as const) {
      expect(CodeOpenSummaryResult.safeParse(bad).success, label).toBe(false);
    }
  });

  it('화면 ID는 SCR-01 ~ SCR-21만', () => {
    for (const id of ['SCR-01', 'SCR-03', 'SCR-10', 'SCR-19', 'SCR-21']) {
      expect(ScreenId.safeParse(id).success, id).toBe(true);
    }
    for (const id of ['SCR-00', 'SCR-22', 'SCR-3', 'scr-03', 'SCR-03 ', 'P-02']) {
      expect(ScreenId.safeParse(id).success, id).toBe(false);
    }
  });

  it.each([
    ['', '빈 값'],
    ['/etc/passwd', '절대 경로'],
    ['//server/share/a.ts', '이중 슬래시 절대 경로'],
    ['C:\\a.ts', 'Windows 절대 경로'],
    ['C:/a.ts', '드라이브 + 슬래시'],
    ['C:a.ts', '드라이브 상대 경로'],
    ['\\\\server\\a.ts', 'UNC'],
    ['../a.ts', '상위 폴더'],
    ['a/../../b.ts', '중간 상위 폴더'],
    ['a/..', '끝 상위 폴더'],
    ['./a.ts', '현재 폴더'],
    ['a//b.ts', '빈 조각'],
    ['a/', '끝 슬래시'],
    ['a\\b.ts', '역슬래시'],
    ['a.ts:18', '콜론'],
    ['a\u0000.ts', 'NUL'],
    ['a\t.ts', '탭'],
    ['a\r\n.ts', '줄바꿈'],
    ['a\u007f.ts', 'DEL'],
    ['a\u009b.ts', 'C1 제어 문자'],
    ['bive-acceptance/%2e%2e/%2e%2e/etc/passwd', '퍼센트(중첩 디코딩에서 상위 폴더)'],
    ['a%20b.ts', '퍼센트'],
    ['src/a\u202Ests.ts', '양방향 제어 문자 RLO'],
    ['a\u2066.ts', '양방향 제어 문자 LRI'],
    ['a\u200F.ts', '양방향 제어 문자 RLM'],
    ['a\u061C.ts', '양방향 제어 문자 ALM'],
    ['a'.repeat(1025), '1024자 초과'],
  ])('프로젝트 루트 밖이나 형식이 틀린 경로 %j(%s)는 거부한다', (value) => {
    expect(isProjectRelativePath(value)).toBe(false);
    expect(CodeFilePath.safeParse(value).success).toBe(false);
    expect(CodeOpenRecord.safeParse({ ...record, file: value }).success).toBe(false);
  });

  it.each([
    'a.ts',
    'src/app/page.tsx',
    '.config/x.ts',
    'src/화면 목록/a b.ts',
    'a...b',
    'a'.repeat(1024),
  ])('대조군: 상대 경로 %j는 받는다', (value) => {
    expect(isProjectRelativePath(value)).toBe(true);
    expect(CodeOpenRecord.safeParse({ ...record, file: value }).success).toBe(true);
  });

  it('줄은 1 이상의 정수, 사유는 세 가지뿐', () => {
    for (const line of [0, -1, 1.5, Number.NaN]) {
      expect(CodeOpenRecord.safeParse({ ...record, line }).success, String(line)).toBe(false);
    }
    expect(CodeOpenRecord.safeParse({ ...record, reason: 'curiosity' }).success).toBe(false);
  });

  it('codeOpen.record 파라미터는 시각 · ID · URL을 받지 않고(엄격 객체) 주체가 필수다', () => {
    const params = {
      projectId: ID.project,
      author: { kind: 'human' },
      reason: 'debugging',
      sourceScreen: 'SCR-03',
      itemRef: { entity: 'Rule', id: ID.rule },
      file: 'a.ts',
      line: 1,
    };
    expect(CodeOpenRecordParams.safeParse(params).success).toBe(true);
    expect(CodeOpenRecordParams.safeParse({ ...params, author: undefined }).success).toBe(false);
    for (const extra of [{ at: record.at }, { id: ID.req }, { url: 'vscode://file/a.ts:1' }]) {
      expect(CodeOpenRecordParams.safeParse({ ...params, ...extra }).success).toBe(false);
    }
    expect(METHOD_NAMES).toContain('codeOpen.record');
    expect(METHOD_NAMES).toContain('codeOpen.list');
    expect(CodeOpenListResult.safeParse({ records: [record], truncated: false }).success).toBe(
      true,
    );
  });
});

describe('코드 열기 IDE 선택 (ADR-018 · ADR-087)', () => {
  it('내장 틀은 VS Code · Cursor 두 개이고 허용 목록의 스킴 · 호스트로 시작한다', () => {
    expect(IDE_URL_TEMPLATES).toEqual({
      vscode: 'vscode://file/{path}:{line}',
      cursor: 'cursor://file/{path}:{line}',
    });
    for (const template of Object.values(IDE_URL_TEMPLATES)) {
      expect(isIdeUrlTemplate(template), template).toBe(true);
    }
    // 웹 · 파일 · 스크립트 계열은 목록에 없다
    for (const scheme of [
      'http',
      'https',
      'file',
      'ftp',
      'javascript',
      'data',
      'vbscript',
      'blob',
      'about',
      'mailto',
      'smb',
    ]) {
      expect(Object.hasOwn(IDE_URL_SCHEME_HOSTS, scheme), scheme).toBe(false);
    }
  });

  it.each([
    'vscode://file/{path}:{line}',
    'vscode-insiders://file/{path}:{line}',
    'vscodium://file/{path}:{line}',
    'windsurf://file/{path}:{line}',
    'idea://open?file=/{path}&line={line}',
    'idea://open?line={line}&file=/{path}',
  ])('사용자 지정 틀 %j는 받는다', (template) => {
    expect(isIdeUrlTemplate(template)).toBe(true);
    expect(IdeSetting.safeParse({ kind: 'custom', template }).success).toBe(true);
  });

  it.each([
    ['subl://open?url=file:///{path}&line={line}', '중첩 file URL(Sublime, 목록에서 뺌)'],
    ['txmt://open?url=file:///{path}&line={line}', '중첩 file URL(TextMate, 목록에서 뺌)'],
    ['mvim://open?url=file:///{path}&line={line}', '중첩 file URL(MacVim, 목록에서 뺌)'],
    ['zed://file/{path}:{line}', '근거 없는 스킴(목록에서 뺌)'],
    ['vscode://file/x?u=http://e/{path}:{line}', '허용 스킴 안의 중첩 http URL'],
    ['idea://open?file=file:///{path}&line={line}', '허용 스킴 안의 중첩 file URL'],
    ['idea://open?file=file%3A%2F%2F{path}&line={line}', '퍼센트 인코딩한 중첩 URL'],
    ['idea://open?file=//{path}&line={line}', '값 안의 권한 모양'],
    ['vscode://file/C:/{path}:{line}', '값 안의 스킴 모양(드라이브)'],
    ['https://example.com/{path}?l={line}', '웹'],
    ['http://localhost/{path}:{line}', '웹(로컬)'],
    ['file:///{path}#{line}', '파일'],
    ['javascript://file/{path}:{line}', '스크립트'],
    ['data://file/{path}:{line}', '데이터'],
    ['vbscript://file/{path}:{line}', 'VBScript'],
    ['ms-msdt://file/{path}:{line}', '목록에 없는 OS 처리기'],
    ['jetbrains://idea/{path}:{line}', '목록에 없는 에디터'],
    ['VSCODE://file/{path}:{line}', '대문자 스킴'],
    ['vscode:file/{path}:{line}', '권한 없음'],
    ['vscode://evil.ext/{path}:{line}', '다른 호스트'],
    ['vscode://file@evil/{path}:{line}', '사용자 정보'],
    ['vscode://file:1/{path}:{line}', '포트'],
    ['idea://file/{path}:{line}', '스킴과 맞지 않는 호스트'],
    ['vscode://{path}:{line}', '권한에 자리 표시자'],
    ['vscode://file{path}:{line}', '호스트에 붙은 자리 표시자'],
    ['vscode://file/a.ts:{line}', '{path} 없음'],
    ['vscode://file/{path}', '{line} 없음'],
    ['vscode://file/{path}/{path}:{line}', '{path} 두 번'],
    ['vscode://file/{path}:{line}{line}', '{line} 두 번'],
    ['vscode://file/{path}:{line}{x}', '그 밖의 중괄호'],
    ['vscode://file/{PATH}:{line}', '대문자 자리 표시자'],
    [' vscode://file/{path}:{line}', '앞 공백'],
    ['vscode://file/{path}:{line} ', '뒤 공백'],
    ['vscode://file/{path}\n:{line}', '줄바꿈'],
    ['vscode://file/{path}\t:{line}', '탭'],
    ['vscode://file/{path}\u0000:{line}', 'NUL'],
    ['vscode://file/\u202E{path}:{line}', '양방향 제어 문자'],
    ['vscode://file/화면/{path}:{line}', '비ASCII'],
    ['', '빈 값'],
    [`vscode://file/{path}:{line}#${'a'.repeat(IDE_URL_TEMPLATE_MAX_LENGTH)}`, '길이 초과'],
  ])('사용자 지정 틀 %j(%s)는 거부한다', (template) => {
    expect(isIdeUrlTemplate(template)).toBe(false);
    expect(IdeSetting.safeParse({ kind: 'custom', template }).success).toBe(false);
  });

  it('선택 값은 종류 3개의 엄격 객체이고 설정의 기본값은 미설정(null)이다', () => {
    expect(IdeSetting.safeParse({ kind: 'vscode' }).success).toBe(true);
    expect(IdeSetting.safeParse({ kind: 'cursor' }).success).toBe(true);
    for (const value of [
      null,
      { kind: 'idea' },
      { kind: 'vscode', template: 'vscode://file/{path}:{line}' },
      { kind: 'custom' },
    ]) {
      expect(IdeSetting.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
    expect(defaultSettings(ID.project).ide).toBeNull();
    expect(
      Settings.safeParse({ ...defaultSettings(ID.project), ide: { kind: 'cursor' } }).success,
    ).toBe(true);
  });

  it('완성된 URL 확인: 허용 스킴 · 고정 호스트만, 다시 읽어도 같은 스킴 · 호스트 (#45 코멘트 1)', () => {
    expect(isAllowedIdeUrl('vscode://file/w/a.ts:1')).toBe(true);
    expect(isAllowedIdeUrl('idea://open?file=/w/a.ts&line=1')).toBe(true);
    for (const url of [
      'vscode://evil.ext/x',
      'vscode://file@evil/x',
      'VSCODE://file/x',
      ' vscode://file/x',
      'vscode://FILE/x',
      'vscode://file/x\n',
      'https://example.com',
      'javascript:alert(1)',
    ]) {
      expect(isAllowedIdeUrl(url), url).toBe(false);
    }
  });
});
