// 도메인 엔터티 스키마 검증 (architecture.md 3장). 아래 예시 값은 테스트 안에서만 쓴다.
import { describe, expect, it } from 'vitest';

import {
  AgentRole,
  APPROVAL_LOG_GENESIS_HASH,
  ApprovalAction,
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
  ConfirmationBasis,
  compareSteps,
  Contract,
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
  MUTANT_LIMITS,
  MutantPatch,
  MutationOutcome,
  MutationResult,
  mutationStatusOf,
  NORM_CHANGE_GENESIS_HASH,
  NORM_JUDGMENT_SUBJECT_LABELS,
  NORM_OBJECTION_RULES_MAX,
  NormChangeEntry,
  OBJECTION_VERDICTS,
  Project,
  ProjectFile,
  Proposal,
  PROPOSAL_PAYLOAD_SCHEMAS,
  Requirement,
  RESERVED_ENTITY_NAMES,
  Rule,
  RuleRetirement,
  ruleStatementEditOf,
  Run,
  RUN_STEP_PLANS,
  runTypeRoles,
  ScreenId,
  Session,
  SessionNormInput,
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
/** 사람의 계약 등록이 남기는 계약 편집 diff (M3-04 #49): 이전 없음 */
const CONTRACT_DIFF = {
  before: null,
  after: {
    kind: 'openapi',
    sourceFile: 'openapi.yaml',
    contentHash: 'c'.repeat(64),
    sourceCommit: SHA,
    parentRequirementId: null,
  },
} as const;

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
  normInput: null,
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
    mutator: emptyRole,
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
      // 변이 주입 역할도 실행 전 필수다 (M3-07 #52, ADR-139)
      'roles.mutator.model',
      'roles.mutator.maxBudgetUsd',
      'roles.mutator.maxTurns',
    ]);
    const full = { model: 'model-a', maxBudgetUsd: 1, maxTurns: 10 };
    const ready = {
      run: { maxBudgetUsd: 5, maxTurns: 200 },
      roles: {
        ...settings.roles,
        'rule-writer': full,
        'test-writer': full,
        implementer: full,
        mutator: full,
      },
    };
    expect(findMissingSettings(ready)).toEqual([]);
    // 변이 주입 칸만 비면 그 세 칸만 빈 항목이다
    expect(
      findMissingSettings({ ...ready, roles: { ...ready.roles, mutator: emptyRole } }),
    ).toEqual(['roles.mutator.model', 'roles.mutator.maxBudgetUsd', 'roles.mutator.maxTurns']);
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

  it('반영 규범(appliedRef)은 제안 승인(approve · approve_edited)에만 있고 그 밖의 행동은 모두 거부한다 (M3-36 #264, ADR-120)', () => {
    const appliedRef = { entity: 'Rule', id: ID.rule };
    const base = {
      seq: 1,
      at: AT,
      actor: human,
      targetRef: { entity: 'Proposal', id: ID.proposal },
      clientId: 'pipe-1',
      prevHash: APPROVAL_LOG_GENESIS_HASH,
      hash: 'f'.repeat(64),
    };
    const diff = { before: { text: 'a' }, after: { text: 'b' } };
    const ruleDiff = {
      before: { title: 'a', statement: 'WHEN a THE SYSTEM SHALL b' },
      after: { title: 'b', statement: 'WHEN a THE SYSTEM SHALL b' },
    };
    // 행동마다 그 행동의 필수 칸을 갖춘 상세 (반영 규범만 빼면 통과한다)
    const valid = {
      approve: { action: 'approve', detail: {} },
      approve_edited: { action: 'approve_edited', detail: { diff } },
      reject: { action: 'reject', detail: { reason: '범위 밖' } },
      run_start: { action: 'run_start', detail: { ruleIds: [ID.rule] } },
      provisional_grant: { action: 'provisional_grant', detail: {} },
      confirm: { action: 'confirm', detail: {}, targetRef: { entity: 'Rule', id: ID.rule } },
      rule_edit: {
        action: 'rule_edit',
        detail: { diff: ruleDiff },
        targetRef: { entity: 'Rule', id: ID.rule },
      },
      contract_edit: {
        action: 'contract_edit',
        detail: { diff: CONTRACT_DIFF },
        targetRef: { entity: 'Contract', id: ID.rule },
      },
    } as const;
    expect(Object.keys(valid)).toEqual(ApprovalAction.options);
    for (const [action, row] of Object.entries(valid)) {
      const entry = { ...base, ...row };
      expect(ApprovalLogEntry.safeParse(entry).success, action).toBe(true);
      const withRef = ApprovalLogEntry.safeParse({
        ...entry,
        detail: { ...row.detail, appliedRef },
      });
      const allowed = action === 'approve' || action === 'approve_edited';
      expect(withRef.success, action).toBe(allowed);
      if (!withRef.success) {
        expect(withRef.error.issues.map((issue) => [issue.path, issue.message])).toEqual([
          [['detail', 'appliedRef'], '반영 규범은 제안 승인에만 있습니다'],
        ]);
      }
    }
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
    // 규칙 직접 편집의 diff는 제목 · 진술 전후 (M7-03, 아래 시험), 계약 편집은 계약 대상 · 계약 편집 diff (M3-04, 아래 시험)
    const ruleDiff = {
      before: { title: 'a', statement: 'WHEN a THE SYSTEM SHALL b' },
      after: { title: 'b', statement: 'WHEN a THE SYSTEM SHALL b' },
    };
    for (const [action, edited, targetRef] of [
      ['rule_edit', ruleDiff, confirm.targetRef],
      ['contract_edit', CONTRACT_DIFF, { entity: 'Contract', id: ID.rule }],
    ] as const) {
      expect(ApprovalLogEntry.safeParse({ ...confirm, action, targetRef }).success).toBe(false);
      expect(
        ApprovalLogEntry.safeParse({ ...confirm, action, targetRef, detail: { diff: edited } })
          .success,
      ).toBe(true);
    }
  });

  it('계약 편집(contract_edit): 대상은 계약, diff는 계약 편집 diff(등록은 이전 없음), 반영 규범 없음 (M3-04 #49 · ADR-129)', () => {
    const entry = {
      seq: 1,
      at: AT,
      action: 'contract_edit',
      actor: human,
      targetRef: { entity: 'Contract', id: ID.rule },
      clientId: 'pipe-1',
      detail: { diff: CONTRACT_DIFF },
      prevHash: APPROVAL_LOG_GENESIS_HASH,
      hash: 'f'.repeat(64),
    };
    expect(ApprovalLogEntry.parse(entry)).toEqual(entry);
    // 변경(이전 있음)도 같은 모양이다 (M3-10이 넓힌다)
    expect(
      ApprovalLogEntry.safeParse({
        ...entry,
        detail: { diff: { before: CONTRACT_DIFF.after, after: CONTRACT_DIFF.after } },
      }).success,
    ).toBe(true);
    const rejected: [string, object][] = [
      ['대상이 규칙', { targetRef: { entity: 'Rule', id: ID.rule } }],
      ['diff 없음', { detail: {} }],
      ['다른 모양의 diff', { detail: { diff: { before: { text: 'a' }, after: { text: 'b' } } } }],
      ['이후 없음', { detail: { diff: { before: null, after: null } } }],
      [
        '모르는 칸',
        { detail: { diff: { before: null, after: { ...CONTRACT_DIFF.after, body: 'x' } } } },
      ],
      [
        '해시 형식',
        { detail: { diff: { before: null, after: { ...CONTRACT_DIFF.after, contentHash: 'x' } } } },
      ],
      ['주체가 에이전트', { actor: testWriter }],
    ];
    for (const [label, patch] of rejected) {
      expect(ApprovalLogEntry.safeParse({ ...entry, ...patch }).success, label).toBe(false);
    }
  });

  it('규칙 직접 편집(rule_edit): 대상은 규칙, diff는 제목 · 진술 전후, 반영 규범 없음. 진술이 바뀐 것만 진술 편집 (M7-03 · ADR-109)', () => {
    const before = {
      title: '서버 시각',
      statement: 'WHEN 요청하면 THE SYSTEM SHALL 시각을 담는다',
    };
    const after = {
      title: '서버 시각',
      statement: 'WHEN 요청하면 THE SYSTEM SHALL UTC 시각을 담는다',
    };
    const edit = {
      seq: 4,
      at: AT,
      action: 'rule_edit',
      actor: human,
      targetRef: { entity: 'Rule', id: ID.rule },
      clientId: 'pipe-1',
      detail: { diff: { before, after } },
      prevHash: APPROVAL_LOG_GENESIS_HASH,
      hash: 'f'.repeat(64),
    };
    const parsed = ApprovalLogEntry.parse(edit);
    expect(ruleStatementEditOf(parsed)).toEqual({
      seq: 4,
      ruleId: ID.rule,
      diff: { before, after },
    });
    for (const broken of [
      { ...edit, targetRef: { entity: 'Requirement', id: ID.req } },
      { ...edit, detail: { diff: { before: { title: 'a' }, after } } },
      { ...edit, detail: { diff: { before, after: { ...after, extra: 1 } } } },
      { ...edit, detail: { diff: { before, after }, appliedRef: { entity: 'Rule', id: ID.rule } } },
      { ...edit, actor: testWriter },
    ]) {
      expect(ApprovalLogEntry.safeParse(broken).success, JSON.stringify(broken)).toBe(false);
    }
    // 제목만 바뀐 편집 · 다른 행동은 진술 편집이 아니다
    const titleOnly = ApprovalLogEntry.parse({
      ...edit,
      detail: { diff: { before, after: { ...before, title: '서버 시각 (UTC)' } } },
    });
    expect(ruleStatementEditOf(titleOnly)).toBeNull();
    expect(
      ruleStatementEditOf(ApprovalLogEntry.parse({ ...edit, action: 'confirm', detail: {} })),
    ).toBeNull();
  });

  it('규범 변경 기록 자동 시작의 원인은 신규 기록 순번(causeSeqs) 또는 규칙 편집 순번(ruleEditSeqs) 가운데 하나 (M7-03 · ADR-109)', () => {
    const entry = {
      seq: 2,
      at: AT,
      kind: 'auto_start',
      actor: { kind: 'orchestrator' },
      targetRef: { entity: 'Run', id: ID.run },
      sessionId: null,
      runId: ID.run,
      reason: '자동 시작',
      detail: { ruleEditSeqs: [4], ruleIds: [ID.rule] },
      prevHash: APPROVAL_LOG_GENESIS_HASH,
      hash: 'f'.repeat(64),
    };
    expect(NormChangeEntry.parse(entry)).toEqual(entry);
    expect(
      NormChangeEntry.safeParse({ ...entry, detail: { causeSeqs: [1], ruleIds: [ID.rule] } })
        .success,
    ).toBe(true);
    for (const detail of [
      { ruleEditSeqs: [4], causeSeqs: [1], ruleIds: [ID.rule] },
      { ruleEditSeqs: [4, 5], ruleIds: [ID.rule] },
      { ruleIds: [ID.rule] },
      { ruleEditSeqs: [0], ruleIds: [ID.rule] },
    ]) {
      expect(NormChangeEntry.safeParse({ ...entry, detail }).success, JSON.stringify(detail)).toBe(
        false,
      );
    }
    // 자동 시작이 아닌 기록에는 규칙 편집 순번이 없다
    expect(
      NormChangeEntry.safeParse({
        ...entry,
        kind: 'created',
        actor: { kind: 'agent', role: 'rule-writer' },
        sessionId: ID.run,
        targetRef: { entity: 'Rule', id: ID.rule },
        runId: null,
        detail: { after: {}, ruleEditSeqs: [4] },
      }).success,
    ).toBe(false);
  });

  it('동작 선언(behavior)은 규칙의 신규 기록에만 new · existing 가운데 하나로 있고, 없는 신규 기록(옛 기록)도 읽힌다 (M3-30 #245 · ADR-151)', () => {
    const created = {
      seq: 1,
      at: AT,
      kind: 'created',
      actor: { kind: 'agent', role: 'rule-writer' },
      targetRef: { entity: 'Rule', id: ID.rule },
      sessionId: ID.run,
      runId: null,
      reason: '근거',
      detail: { after: {}, behavior: 'existing' },
      prevHash: APPROVAL_LOG_GENESIS_HASH,
      hash: 'f'.repeat(64),
    };
    expect(NormChangeEntry.parse(created)).toEqual(created);
    expect(
      NormChangeEntry.parse({ ...created, detail: { after: {}, behavior: 'new' } }).detail.behavior,
    ).toBe('new');
    expect(NormChangeEntry.parse({ ...created, detail: { after: {} } }).detail.behavior).toBe(
      undefined,
    );
    for (const broken of [
      { ...created, detail: { after: {}, behavior: 'unknown' } },
      { ...created, detail: { after: {}, behavior: null } },
      // 규칙이 아닌 대상의 신규 기록(요구사항 · 계약)에는 없다
      { ...created, targetRef: { entity: 'Requirement', id: ID.req } },
      // 신규가 아닌 기록에는 없다
      {
        ...created,
        kind: 'auto_start',
        actor: { kind: 'orchestrator' },
        targetRef: { entity: 'Run', id: ID.run },
        sessionId: null,
        runId: ID.run,
        detail: { causeSeqs: [1], ruleIds: [ID.rule], behavior: 'new' },
      },
    ]) {
      expect(NormChangeEntry.safeParse(broken).success, JSON.stringify(broken.detail)).toBe(false);
    }
    // 같은 자동 시작 기록에서 선언만 빼면 통과한다 (거부의 원인이 선언임)
    expect(
      NormChangeEntry.safeParse({
        ...created,
        kind: 'auto_start',
        actor: { kind: 'orchestrator' },
        targetRef: { entity: 'Run', id: ID.run },
        sessionId: null,
        runId: ID.run,
        detail: { causeSeqs: [1], ruleIds: [ID.rule] },
      }).success,
    ).toBe(true);
    expect(
      NormChangeEntry.safeParse({
        ...created,
        targetRef: { entity: 'Requirement', id: ID.req },
        detail: { after: {} },
      }).success,
    ).toBe(true);
  });

  it('자동 시작의 셋째 원인: 변이 기록 ID(mutationResultIds)도 셋 가운데 하나만, 대상 규칙과 같은 수, 자동 시작에만 (M3-54 #311 · ADR-143)', () => {
    const entry = {
      seq: 2,
      at: AT,
      kind: 'auto_start',
      actor: { kind: 'orchestrator' },
      targetRef: { entity: 'Run', id: ID.run },
      sessionId: null,
      runId: ID.run,
      reason: '자동 시작',
      detail: { mutationResultIds: [ID.judgment], ruleIds: [ID.rule] },
      prevHash: APPROVAL_LOG_GENESIS_HASH,
      hash: 'f'.repeat(64),
    };
    expect(NormChangeEntry.parse(entry)).toEqual(entry);
    for (const detail of [
      { mutationResultIds: [ID.judgment], causeSeqs: [1], ruleIds: [ID.rule] },
      { mutationResultIds: [ID.judgment], ruleEditSeqs: [1], ruleIds: [ID.rule] },
      { mutationResultIds: [ID.judgment, ID.step], ruleIds: [ID.rule] },
      { mutationResultIds: [], ruleIds: [ID.rule] },
      { mutationResultIds: ['x'], ruleIds: [ID.rule] },
    ]) {
      expect(NormChangeEntry.safeParse({ ...entry, detail }).success, JSON.stringify(detail)).toBe(
        false,
      );
    }
    expect(
      NormChangeEntry.safeParse({
        ...entry,
        kind: 'created',
        actor: { kind: 'agent', role: 'rule-writer' },
        sessionId: ID.run,
        targetRef: { entity: 'Rule', id: ID.rule },
        runId: null,
        detail: { after: {}, mutationResultIds: [ID.judgment] },
      }).success,
    ).toBe(false);
    // 시작 주체: 변이 보강 연결의 순번 1개
    expect(
      Run.shape.startedBy.safeParse({
        kind: 'orchestrator',
        causeSeqs: [3],
        causeLog: 'mutation_reinforcements',
      }).success,
    ).toBe(true);
    expect(
      Run.shape.startedBy.safeParse({
        kind: 'orchestrator',
        causeSeqs: [3, 4],
        causeLog: 'mutation_reinforcements',
      }).success,
    ).toBe(false);
    expect(
      Run.shape.startedBy.safeParse({ kind: 'orchestrator', causeSeqs: [3], causeLog: 'other' })
        .success,
    ).toBe(false);
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
      // 규칙 편집이 원인인 실행(M7-03): 승인 기록 순번 1개만
      { kind: 'orchestrator', causeSeqs: [1, 2], causeLog: 'approval_log' },
      { kind: 'orchestrator', causeSeqs: [1], causeLog: 'norm_change' },
      { kind: 'human', causeLog: 'approval_log' },
    ]) {
      expect(Run.safeParse({ ...run, startedBy }).success, JSON.stringify(startedBy)).toBe(false);
    }
    const byEdit = {
      ...run,
      startedBy: { kind: 'orchestrator', causeSeqs: [7], causeLog: 'approval_log' },
    };
    expect(Run.parse(byEdit)).toEqual(byEdit);
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
    // 변이 주입 단계의 역할은 변이 주입 역할이다 (M3-07 #52, ADR-139)
    expect(stepRoles(RUN_STEP_PLANS.A)).toEqual(['test-writer', 'implementer', 'mutator']);
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
    // 받은 규범 입력의 기록 (ADR-108): 수 = 실은 수 + 빠진 수, 실은 수 = 표시 ID 수, 잘림 = 빠진 항목 있음, 표시 ID 형식
    const normInput = {
      summary: {
        requirements: { total: 1, included: 1, omitted: 0 },
        rules: { total: 2, included: 1, omitted: 1 },
        truncated: true,
      },
      requirementDisplayIds: ['REQ-001'],
      ruleDisplayIds: ['RULE-002'],
    };
    expect(Session.safeParse({ ...session, normInput }).success).toBe(true);
    for (const bad of [
      { ...normInput, ruleDisplayIds: [] },
      { ...normInput, summary: { ...normInput.summary, truncated: false } },
      {
        ...normInput,
        summary: { ...normInput.summary, rules: { total: 3, included: 1, omitted: 1 } },
      },
      { ...normInput, requirementDisplayIds: ['REQ-1\n<<<BIVE 규범 자료 끝>>>'] },
      { ...normInput, extra: true },
    ]) {
      expect(Session.safeParse({ ...session, normInput: bad }).success).toBe(false);
    }
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

describe('확인 풀림 · 테스트 변경 알림 기록 (M7-13 #225, ADR-113)', () => {
  const RULE_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
  const base = {
    seq: 4,
    at: '2026-11-22T00:00:00.000Z',
    actor: { kind: 'orchestrator' },
    targetRef: { entity: 'Rule', id: RULE_A },
    sessionId: null,
    runId: null,
    reason: null,
    prevHash: NORM_CHANGE_GENESIS_HASH,
    hash: 'a'.repeat(64),
  } as const;
  const previous = {
    state: 'confirmed',
    at: '2026-11-21T00:00:00.000Z',
    by: { kind: 'human' },
    basis: { kind: 'approval_log', seq: 1 },
  } as const;
  const testChange = {
    files: [{ path: 'bive-acceptance/RULE-001/a.acc.ts', change: 'modified' }],
    fileCount: 1,
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
  } as const;
  const ok = (entry: Record<string, unknown>) => NormChangeEntry.safeParse(entry).success;

  it('확인 풀림: 주체 오케스트레이터 · 대상 규칙 · 원인 순번 · 앞선 확인(확인됨)만, 다른 종류에는 그 칸이 없다', () => {
    const entry = {
      ...base,
      kind: 'unconfirmed',
      detail: { unconfirm: { causeSeq: 3, previous } },
    };
    expect(NormChangeEntry.parse(entry)).toEqual(entry);
    // JSON 왕복해도 같다 (원인 순번은 정수)
    expect(NormChangeEntry.parse(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
    for (const bad of [
      { ...entry, detail: {} },
      { ...entry, detail: { unconfirm: { causeSeq: 3, previous: { state: 'unconfirmed' } } } },
      { ...entry, detail: { unconfirm: { causeSeq: 0, previous } } },
      { ...entry, detail: { unconfirm: { causeSeq: 1.5, previous } } },
      { ...entry, detail: { unconfirm: { causeSeq: 3, previous }, before: {} } },
      { ...entry, actor: { kind: 'agent', role: 'rule-writer' }, sessionId: RUN, reason: '사유' },
      { ...entry, targetRef: { entity: 'Requirement', id: RULE_A } },
      { ...entry, kind: 'created', detail: { after: {}, unconfirm: { causeSeq: 3, previous } } },
    ]) {
      expect(ok(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('테스트 변경 알림: 주체 오케스트레이터 · 대상 규칙 · 연결 실행 · 파일 1~100개(전체 수 ≥ 실은 수)', () => {
    const entry = { ...base, kind: 'test_changed', runId: RUN, detail: { testChange } };
    expect(NormChangeEntry.parse(entry)).toEqual(entry);
    const many = Array.from({ length: 100 }, (_, i) => ({
      path: `bive-acceptance/RULE-001/f${String(i)}.acc.ts`,
      change: 'removed',
    }));
    expect(
      ok({ ...entry, detail: { testChange: { ...testChange, files: many, fileCount: 150 } } }),
    ).toBe(true);
    for (const bad of [
      { ...entry, runId: null },
      { ...entry, detail: {} },
      { ...entry, detail: { testChange: { ...testChange, files: [] } } },
      {
        ...entry,
        detail: { testChange: { ...testChange, files: [...many, many[0]], fileCount: 101 } },
      },
      { ...entry, detail: { testChange: { ...testChange, files: many, fileCount: 99 } } },
      { ...entry, detail: { testChange: { ...testChange, baseCommit: 'main' } } },
      {
        ...entry,
        detail: { testChange: { ...testChange, files: [{ path: 'a', change: 'added' }] } },
      },
      { ...entry, actor: { kind: 'agent', role: 'test-writer' }, sessionId: RUN, reason: '사유' },
      { ...entry, targetRef: { entity: 'Run', id: RUN } },
      { ...entry, kind: 'auto_start', detail: { testChange } },
    ]) {
      expect(ok(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('규칙 폐기 · 대체 기록 (M7-09 #221, ADR-112)', () => {
  const RULE_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const RULE_B = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
  const base = {
    seq: 3,
    at: '2026-11-22T00:00:00.000Z',
    actor: { kind: 'agent', role: 'rule-writer' },
    targetRef: { entity: 'Rule', id: RULE_A },
    sessionId: RULE_B,
    runId: null,
    reason: '근거',
    prevHash: NORM_CHANGE_GENESIS_HASH,
    hash: 'a'.repeat(64),
  } as const;
  const supersededBy = { id: RULE_B, displayId: 'RULE-002' };
  const ok = (entry: Record<string, unknown>) => NormChangeEntry.safeParse(entry).success;

  it('폐기: before · retirement(supersededBy null)만, 대체: 새 규칙과 신규 · 판단 순번이 모두 필요하다', () => {
    expect(
      ok({ ...base, kind: 'retired', detail: { before: {}, retirement: { supersededBy: null } } }),
    ).toBe(true);
    expect(
      ok({
        ...base,
        kind: 'superseded',
        detail: { before: {}, retirement: { supersededBy, createdSeq: 1, judgmentSeq: 2 } },
      }),
    ).toBe(true);
    for (const detail of [
      // 상세 없음 · before 없음 · after 있음
      { before: {} },
      { retirement: { supersededBy: null } },
      { before: {}, after: {}, retirement: { supersededBy: null } },
      // 폐기인데 대체 칸
      { before: {}, retirement: { supersededBy, createdSeq: 1, judgmentSeq: 2 } },
      { before: {}, retirement: { supersededBy: null, createdSeq: 1 } },
    ]) {
      expect(ok({ ...base, kind: 'retired', detail }), JSON.stringify(detail)).toBe(false);
    }
    for (const retirement of [
      { supersededBy: null },
      { supersededBy, createdSeq: 1 },
      { supersededBy, judgmentSeq: 2 },
      { supersededBy: null, createdSeq: 1, judgmentSeq: 2 },
    ]) {
      expect(ok({ ...base, kind: 'superseded', detail: { before: {}, retirement } })).toBe(false);
    }
    // 대상은 규칙만, 다른 종류에는 retirement가 없다
    expect(
      ok({
        ...base,
        kind: 'retired',
        targetRef: { entity: 'Requirement', id: RULE_A },
        detail: { before: {}, retirement: { supersededBy: null } },
      }),
    ).toBe(false);
    expect(
      ok({ ...base, kind: 'created', detail: { after: {}, retirement: { supersededBy: null } } }),
    ).toBe(false);
  });

  it('규칙 분할(M3-57, ADR-153): 대체 기록의 분할 상세는 새 규칙 2 ~ 5개(중복 없음)와 각 신규 순번이고, 첫 새 규칙이 supersededBy이며 신규 · 판단 순번 칸은 없다. 폐기 기록에는 분할 상세가 없다', () => {
    const RULE_C = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
    const third = { id: RULE_C, displayId: 'RULE-003' };
    const split = [
      { rule: supersededBy, createdSeq: 1 },
      { rule: third, createdSeq: 3 },
    ];
    const superseded = (retirement: Record<string, unknown>) =>
      ok({ ...base, kind: 'superseded', detail: { before: {}, retirement } });
    expect(superseded({ supersededBy, split })).toBe(true);
    const sixth = Array.from({ length: 6 }, (_, index) => ({
      rule: {
        id: `01ARZ3NDEKTSV4RRFFQ69G5FB${String(index)}`,
        displayId: `RULE-01${String(index)}`,
      },
      createdSeq: index + 1,
    }));
    for (const retirement of [
      // 새 규칙 1개 · 6개 · 같은 규칙 둘
      { supersededBy, split: split.slice(0, 1) },
      { supersededBy: sixth[0]!.rule, split: sixth },
      { supersededBy, split: [split[0], split[0]] },
      // supersededBy가 첫 새 규칙이 아님 · 없음
      { supersededBy: third, split },
      { supersededBy: null, split },
      // 대체의 신규 · 판단 순번 칸과 섞음
      { supersededBy, split, createdSeq: 1 },
      { supersededBy, split, judgmentSeq: 2 },
    ]) {
      expect(superseded(retirement), JSON.stringify(retirement)).toBe(false);
    }
    expect(
      ok({
        ...base,
        kind: 'retired',
        detail: { before: {}, retirement: { supersededBy: null, split } },
      }),
    ).toBe(false);
  });

  it('판단 주제 supersede는 결과가 모순이고 새 규칙의 신규 기록 순번이 필요하다', () => {
    const judgment = {
      subject: 'supersede',
      verdict: 'contradiction',
      contradicts: [{ id: RULE_A, displayId: 'RULE-001' }],
      createdSeq: 1,
      input: { requirements: { total: 1, included: 1 }, rules: { total: 1, included: 1 } },
    };
    expect(ok({ ...base, kind: 'judgment', detail: { judgment } })).toBe(true);
    expect(
      ok({
        ...base,
        kind: 'judgment',
        detail: { judgment: { ...judgment, verdict: 'no_contradiction', contradicts: [] } },
      }),
    ).toBe(false);
    expect(
      ok({
        ...base,
        kind: 'judgment',
        detail: { judgment: { ...judgment, createdSeq: undefined } },
      }),
    ).toBe(false);
  });

  it('폐기 기록 행: 대체한 규칙은 ULID 또는 null, 순번은 양의 정수', () => {
    const row = { ruleId: RULE_A, retiredAt: base.at, supersededBy: null, normChangeSeq: 1 };
    expect(RuleRetirement.parse(row)).toEqual(row);
    expect(RuleRetirement.safeParse({ ...row, supersededBy: RULE_B }).success).toBe(true);
    expect(RuleRetirement.safeParse({ ...row, normChangeSeq: 0 }).success).toBe(false);
    expect(RuleRetirement.safeParse({ ...row, supersededBy: 'x' }).success).toBe(false);
    expect(RuleRetirement.safeParse({ ...row, extra: 1 }).success).toBe(false);
  });
});

describe('이의 · 이의 판단 기록 (M7-11 #223, ADR-100 D4 · A4, ADR-115)', () => {
  const RULE_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const RULE_B = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
  const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
  const SESSION = '01ARZ3NDEKTSV4RRFFQ69G5FAY';
  const rules = [{ id: RULE_A, displayId: 'RULE-001' }];
  const objection = {
    seq: 1,
    at: '2026-11-22T00:00:00.000Z',
    kind: 'objection',
    actor: { kind: 'agent', role: 'implementer' },
    targetRef: { entity: 'Run', id: RUN },
    sessionId: SESSION,
    runId: RUN,
    reason: '규칙이 틀렸다',
    detail: { objection: { rules, stepId: RULE_B } },
    prevHash: NORM_CHANGE_GENESIS_HASH,
    hash: 'a'.repeat(64),
  } as const;
  const judgment = {
    subject: 'objection',
    verdict: 'upheld',
    contradicts: [],
    causeSeq: 1,
    input: { requirements: { total: 1, included: 1 }, rules: { total: 1, included: 1 } },
  };
  const judged = {
    ...objection,
    seq: 2,
    kind: 'judgment',
    actor: { kind: 'agent', role: 'rule-writer' },
    targetRef: { entity: 'Rule', id: RULE_A },
    detail: { judgment },
  } as const;
  const ok = (entry: Record<string, unknown>) => NormChangeEntry.safeParse(entry).success;

  it('이의: 주체 구현 역할 · 대상 그 실행(연결 실행과 같음) · 대상 규칙 1 ~ 5개 중복 없음 · 단계 시도, 다른 종류에는 이의 상세가 없다', () => {
    expect(ok(objection)).toBe(true);
    expect(ok({ ...objection, actor: { kind: 'agent', role: 'rule-writer' } })).toBe(false);
    expect(ok({ ...objection, actor: { kind: 'orchestrator' } })).toBe(false);
    expect(ok({ ...objection, targetRef: { entity: 'Rule', id: RULE_A } })).toBe(false);
    expect(ok({ ...objection, runId: RULE_B })).toBe(false);
    expect(ok({ ...objection, reason: null })).toBe(false);
    expect(ok({ ...objection, detail: {} })).toBe(false);
    expect(ok({ ...objection, detail: { objection: { rules: [], stepId: RULE_B } } })).toBe(false);
    expect(
      ok({ ...objection, detail: { objection: { rules: [...rules, ...rules], stepId: RULE_B } } }),
    ).toBe(false);
    const six = Array.from({ length: NORM_OBJECTION_RULES_MAX + 1 }, (_, i) => ({
      id: `01ARZ3NDEKTSV4RRFFQ69G5F${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`,
      displayId: `RULE-00${String(i + 1)}`,
    }));
    expect(
      ok({ ...objection, detail: { objection: { rules: six.slice(0, 5), stepId: RULE_B } } }),
    ).toBe(true);
    expect(ok({ ...objection, detail: { objection: { rules: six, stepId: RULE_B } } })).toBe(false);
    expect(ok({ ...objection, detail: { objection: { rules, stepId: RULE_B }, before: {} } })).toBe(
      false,
    );
    expect(ok({ ...judged, detail: { judgment, objection: { rules, stepId: RULE_B } } })).toBe(
      false,
    );
  });

  it('이의 판단: 결과는 유지 · 폐기 · 대체만이고 원인 순번 · 연결 실행이 필요하며, 판단 없음은 유지 · 오케스트레이터만', () => {
    expect(ok(judged)).toBe(true);
    for (const verdict of OBJECTION_VERDICTS) {
      expect(ok({ ...judged, detail: { judgment: { ...judgment, verdict } } }), verdict).toBe(true);
    }
    for (const verdict of ['no_contradiction', 'contradiction']) {
      expect(ok({ ...judged, detail: { judgment: { ...judgment, verdict } } }), verdict).toBe(
        false,
      );
    }
    // 이의 결과 값은 다른 주제에 쓸 수 없다
    expect(
      ok({
        ...judged,
        detail: {
          judgment: { ...judgment, subject: 'new_rule', createdSeq: 1, causeSeq: undefined },
        },
      }),
    ).toBe(false);
    expect(ok({ ...judged, detail: { judgment: { ...judgment, causeSeq: undefined } } })).toBe(
      false,
    );
    expect(ok({ ...judged, runId: null })).toBe(false);
    expect(ok({ ...judged, targetRef: { entity: 'Run', id: RUN } })).toBe(false);
    expect(ok({ ...judged, actor: { kind: 'agent', role: 'implementer' } })).toBe(false);
    const undecided = {
      ...judged,
      actor: { kind: 'orchestrator' },
      sessionId: null,
      detail: { judgment: { ...judgment, undecided: { endReason: 'guard_violation' } } },
    };
    expect(ok(undecided)).toBe(true);
    expect(
      ok({ ...undecided, actor: { kind: 'agent', role: 'rule-writer' }, sessionId: SESSION }),
    ).toBe(false);
    expect(
      ok({
        ...undecided,
        detail: { judgment: { ...judgment, verdict: 'retired', undecided: { endReason: 'x' } } },
      }),
    ).toBe(false);
    // 원인 순번은 이의 판단에만
    expect(
      ok({
        ...judged,
        detail: {
          judgment: {
            subject: 'new_rule',
            verdict: 'no_contradiction',
            contradicts: [],
            createdSeq: 1,
            causeSeq: 1,
            input: judgment.input,
          },
        },
      }),
    ).toBe(false);
  });

  it('요구사항 변경 판단 (M7-10 #222, ADR-116): 결과는 유지 · 폐기 · 대체, 원인 요구사항 변경 필수 · 연결 실행 없음, 삭제에는 대체가 없고 대체에는 신규 기록 순번, 판단 없음은 유지 · 오케스트레이터만', () => {
    const requirementChange = {
      requirement: { id: RULE_B, displayId: 'REQ-001' },
      change: 'updated',
      at: '2026-11-22T00:00:01.000Z',
      textHash: 'b'.repeat(64),
    };
    const change = {
      subject: 'requirement_change',
      verdict: 'upheld',
      contradicts: [],
      requirementChange,
      input: judgment.input,
    };
    const rejudged = { ...judged, runId: null, detail: { judgment: change } };
    expect(ok(rejudged)).toBe(true);
    expect(ok({ ...rejudged, detail: { judgment: { ...change, verdict: 'retired' } } })).toBe(true);
    expect(
      ok({
        ...rejudged,
        detail: { judgment: { ...change, verdict: 'superseded', createdSeq: 3 } },
      }),
    ).toBe(true);
    // 대체에는 새 규칙의 신규 기록 순번이 필요하고, 유지 · 폐기에는 없다
    expect(ok({ ...rejudged, detail: { judgment: { ...change, verdict: 'superseded' } } })).toBe(
      false,
    );
    expect(ok({ ...rejudged, detail: { judgment: { ...change, createdSeq: 3 } } })).toBe(false);
    // 지운 요구사항의 자식 규칙은 대체할 수 없다
    const deleted = { ...requirementChange, change: 'deleted' };
    expect(
      ok({ ...rejudged, detail: { judgment: { ...change, requirementChange: deleted } } }),
    ).toBe(true);
    expect(
      ok({
        ...rejudged,
        detail: {
          judgment: {
            ...change,
            verdict: 'superseded',
            createdSeq: 3,
            requirementChange: deleted,
          },
        },
      }),
    ).toBe(false);
    for (const verdict of ['no_contradiction', 'contradiction']) {
      expect(ok({ ...rejudged, detail: { judgment: { ...change, verdict } } }), verdict).toBe(
        false,
      );
    }
    // 원인은 요구사항 변경 하나: 없거나 · 이의 순번을 섞거나 · 다른 주제에 실으면 거부. 모양도 본다
    expect(
      ok({ ...rejudged, detail: { judgment: { ...change, requirementChange: undefined } } }),
    ).toBe(false);
    expect(ok({ ...rejudged, detail: { judgment: { ...change, causeSeq: 1 } } })).toBe(false);
    expect(ok({ ...judged, detail: { judgment: { ...judgment, requirementChange } } })).toBe(false);
    expect(
      ok({
        ...rejudged,
        detail: {
          judgment: { ...change, requirementChange: { ...requirementChange, textHash: 'x' } },
        },
      }),
    ).toBe(false);
    expect(
      ok({
        ...rejudged,
        detail: {
          judgment: { ...change, requirementChange: { ...requirementChange, change: 'renamed' } },
        },
      }),
    ).toBe(false);
    // 대상은 규칙, 연결 실행 없음, 주체는 규칙 작성 역할
    expect(ok({ ...rejudged, runId: RUN })).toBe(false);
    expect(ok({ ...rejudged, targetRef: { entity: 'Run', id: RUN } })).toBe(false);
    expect(ok({ ...rejudged, actor: { kind: 'agent', role: 'implementer' } })).toBe(false);
    expect(ok({ ...rejudged, actor: { kind: 'orchestrator' } })).toBe(false);
    // 판단 없음: 유지 · 오케스트레이터만 (판단 없음을 폐기로 보지 않는다)
    const undecided = {
      ...rejudged,
      actor: { kind: 'orchestrator' },
      sessionId: null,
      detail: {
        judgment: { ...change, undecided: { endReason: 'project_daily_budget_exceeded' } },
      },
    };
    expect(ok(undecided)).toBe(true);
    expect(
      ok({ ...undecided, actor: { kind: 'agent', role: 'rule-writer' }, sessionId: SESSION }),
    ).toBe(false);
    expect(
      ok({
        ...undecided,
        detail: {
          judgment: { ...change, verdict: 'retired', undecided: { endReason: 'aborted' } },
        },
      }),
    ).toBe(false);
    // 판단 없음은 이의 · 요구사항 변경 판단에만
    expect(
      ok({
        ...undecided,
        detail: {
          judgment: {
            subject: 'new_rule',
            verdict: 'no_contradiction',
            contradicts: [],
            createdSeq: 1,
            undecided: { endReason: 'aborted' },
            input: judgment.input,
          },
        },
      }),
    ).toBe(false);
    expect(NORM_JUDGMENT_SUBJECT_LABELS.requirement_change).toBe('요구사항 변경 판단');
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

describe('계약 (M3-04 #49, NRM-03 · ADR-019, ADR-129)', () => {
  const contract = {
    id: ID.rule,
    displayId: 'CON-001',
    kind: 'openapi',
    sourceFile: 'docs/openapi.yaml',
    contentHash: 'c'.repeat(64),
    sourceCommit: SHA,
    parentRequirementId: ID.req,
    author: human,
    createdAt: AT,
    confirmation: {
      state: 'confirmed',
      at: AT,
      by: human,
      basis: { kind: 'contract_record', at: AT },
    },
  } as const;

  it('계약 = 원본 파일 1개(내용 해시 · 기준 커밋) · 부모 요구사항 0~1개 · 작성 주체 · 확인 상태. 모르는 칸 · 다른 접두 · 해시 형식은 거부한다', () => {
    expect(Contract.parse(contract)).toEqual(contract);
    expect(Contract.safeParse({ ...contract, parentRequirementId: null }).success).toBe(true);
    expect(
      Contract.safeParse({
        ...contract,
        author: testWriter,
        confirmation: { state: 'unconfirmed' },
      }).success,
    ).toBe(true);
    for (const [label, patch] of [
      ['표시 ID 접두', { displayId: 'RULE-001' }],
      ['종류', { kind: 'graphql' }],
      ['빈 파일', { sourceFile: '' }],
      ['긴 파일', { sourceFile: 'a'.repeat(1025) }],
      ['해시', { contentHash: 'x' }],
      ['커밋', { sourceCommit: 'main' }],
      ['엔드포인트 단위 칸', { endpoint: 'GET /api/health' }],
    ] as const) {
      expect(Contract.safeParse({ ...contract, ...patch }).success, label).toBe(false);
    }
    expect(EntityName.options).toContain('Contract');
    expect(RESERVED_ENTITY_NAMES).not.toContain('Contract');
  });

  it('확인 근거에 계약의 작성 기록(contract_record)이 더해졌고, 옛 근거 두 종류는 그대로다', () => {
    expect(ConfirmationBasis.parse({ kind: 'contract_record', at: AT })).toEqual({
      kind: 'contract_record',
      at: AT,
    });
    expect(ConfirmationBasis.safeParse({ kind: 'contract_record' }).success).toBe(false);
    expect(ConfirmationBasis.safeParse({ kind: 'requirement_record', at: AT }).success).toBe(true);
    expect(ConfirmationBasis.safeParse({ kind: 'approval_log', seq: 1 }).success).toBe(true);
  });

  it('세션의 규범 입력 기록: 계약의 수 · 표시 ID는 두 칸이 함께 있거나 함께 없고(옛 모양 그대로 받음), 실은 수 · 잘림이 맞아야 한다', () => {
    const count = (total: number, included: number) => ({
      total,
      included,
      omitted: total - included,
    });
    const old = {
      summary: { requirements: count(1, 1), rules: count(0, 0), truncated: false },
      requirementDisplayIds: ['REQ-001'],
      ruleDisplayIds: [],
    };
    expect(SessionNormInput.parse(old)).toEqual(old);
    const withContracts = {
      ...old,
      summary: { ...old.summary, contracts: count(2, 2) },
      contractDisplayIds: ['CON-001', 'CON-002'],
    };
    expect(SessionNormInput.parse(withContracts)).toEqual(withContracts);
    const truncated = {
      ...withContracts,
      summary: { ...withContracts.summary, contracts: count(3, 2), truncated: true },
    };
    expect(SessionNormInput.safeParse(truncated).success).toBe(true);
    for (const [label, value] of [
      ['표시 ID만', { ...old, contractDisplayIds: [] }],
      ['수만', { ...old, summary: { ...old.summary, contracts: count(0, 0) } }],
      ['수가 다름', { ...withContracts, contractDisplayIds: ['CON-001'] }],
      ['잘림 표시 없음', { ...truncated, summary: { ...truncated.summary, truncated: false } }],
      ['접두', { ...withContracts, contractDisplayIds: ['RULE-001', 'CON-002'] }],
    ] as const) {
      expect(SessionNormInput.safeParse(value).success, label).toBe(false);
    }
  });
});

describe('변이 결과 (JDG-04, M3-07 #52, ADR-139)', () => {
  const mutant = { path: 'src/app/api/auth/session/route.ts', search: '401', replace: '200' };
  const result = {
    id: ID.judgment,
    ruleId: ID.rule,
    runId: ID.run,
    stepId: ID.step,
    sessionId: ID.session,
    commit: SHA,
    status: 'verified',
    outcome: 'killed',
    mutant,
    recordedAt: AT,
  } as const;

  it('판정 결과 → 변이 상태: 검출만 검증됨, 생존만 생존, 나머지(판정 불가 · 변이 없음)는 미검증', () => {
    expect(
      Object.fromEntries(
        MutationOutcome.options.map((outcome) => [outcome, mutationStatusOf(outcome)]),
      ),
    ).toEqual({
      killed: 'verified',
      survived: 'survived',
      no_mutant: 'unverified',
      no_cases: 'unverified',
      checkout_error: 'unverified',
      install_error: 'unverified',
      collect_error: 'unverified',
      runner_error: 'unverified',
    });
  });

  it('기록의 상태는 판정 결과와 맞아야 하고, 변이가 비는 것은 변이를 내지 않은 기록뿐이다', () => {
    expect(MutationResult.parse(result)).toEqual(result);
    expect(MutationResult.safeParse({ ...result, status: 'survived' }).success).toBe(false);
    expect(
      MutationResult.safeParse({ ...result, outcome: 'runner_error', status: 'verified' }).success,
    ).toBe(false);
    expect(
      MutationResult.safeParse({ ...result, outcome: 'runner_error', status: 'unverified' })
        .success,
    ).toBe(true);
    expect(MutationResult.safeParse({ ...result, mutant: null }).success).toBe(false);
    expect(
      MutationResult.safeParse({
        ...result,
        outcome: 'no_mutant',
        status: 'unverified',
        mutant: null,
        sessionId: null,
      }).success,
    ).toBe(true);
    expect(
      MutationResult.safeParse({ ...result, outcome: 'no_mutant', status: 'unverified' }).success,
    ).toBe(false);
  });

  it('변이 패치: 바꿀 글은 1자 이상, 두 글이 같으면 거부, 상한', () => {
    expect(MutantPatch.safeParse(mutant).success).toBe(true);
    expect(MutantPatch.safeParse({ ...mutant, replace: '' }).success).toBe(true);
    expect(MutantPatch.safeParse({ ...mutant, search: '' }).success).toBe(false);
    expect(MutantPatch.safeParse({ ...mutant, replace: '401' }).success).toBe(false);
    expect(
      MutantPatch.safeParse({ ...mutant, search: 'x'.repeat(MUTANT_LIMITS.search + 1) }).success,
    ).toBe(false);
    expect(
      MutantPatch.safeParse({ ...mutant, replace: 'x'.repeat(MUTANT_LIMITS.replace + 1) }).success,
    ).toBe(false);
    expect(MutantPatch.safeParse({ ...mutant, extra: 1 }).success).toBe(false);
  });

  it('유형별 역할: 변이 주입 역할은 유형 A · C에만 든다 (B · D는 변이 주입 단계를 하지 않는다, ADR-020)', () => {
    expect(runTypeRoles('A')).toEqual(['test-writer', 'implementer', 'mutator']);
    expect(runTypeRoles('B')).toEqual(['implementer']);
    expect(runTypeRoles('C')).toEqual(['test-writer', 'mutator']);
    expect(runTypeRoles('D')).toEqual(['implementer']);
  });

  it('MutationResult는 예약 이름이 아니다 (스키마가 생겼다)', () => {
    expect(RESERVED_ENTITY_NAMES).not.toContain('MutationResult');
    expect(EntityName.options).toContain('MutationResult');
  });
});
