// 도메인 열거형 값과 한국어 표시명 검증 (M0-03, architecture.md 3장 · 4장, 기획서 3.4).
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  AdrStatus,
  AGENT_ROLE_LABELS,
  AgentRole,
  ApprovalAction,
  AUTHOR_KIND_LABELS,
  AuthorKind,
  BlockKind,
  canTransitionRun,
  FINAL_STEP_STATUSES,
  isFinalStepStatus,
  isTerminalRunStatus,
  RUN_STATUS_TRANSITIONS,
  CHECK_KIND_LABELS,
  CheckKind,
  CodeOpenReason,
  ConfirmationState,
  ContractKind,
  JudgeRunner,
  JUDGMENT_STATUS_LABELS,
  JudgmentStatus,
  MUTATION_STATUS_LABELS,
  MutationStatus,
  NORM_STATE_LABELS,
  NormState,
  PROPOSAL_KIND_LABELS,
  PROPOSAL_SOURCE_LABELS,
  PROPOSAL_STATE_LABELS,
  ProposalKind,
  ProposalSource,
  ProposalState,
  PROVISIONAL_POLICY_LABELS,
  ProvisionalPolicy,
  Risk,
  RISK_LABELS,
  RULE_KIND_LABELS,
  RuleKind,
  RUN_FAILURE_REASON_LABELS,
  RUN_STATUS_LABELS,
  RUN_TYPE_LABELS,
  RunFailureReason,
  RunStatus,
  RunType,
  SESSION_END_REASON_LABELS,
  SessionEndReason,
  STEP_KIND_LABELS,
  STEP_STATUS_LABELS,
  StepKind,
  StepStatus,
  TERMINAL_RUN_STATUSES,
  TestCaseStatus,
} from '../src/index.js';

type AnyEnum = z.ZodEnum<Record<string, string>>;

/** 열거형 값 목록 · 파싱 · 표시명 맵 일치를 한꺼번에 단언한다. */
const expectEnum = (
  schema: AnyEnum,
  values: readonly string[],
  labels?: Record<string, string>,
): void => {
  expect(schema.options).toEqual(values);
  for (const value of values) expect(schema.parse(value)).toBe(value);
  expect(schema.safeParse('unknown-value').success).toBe(false);
  expect(schema.safeParse('').success).toBe(false);
  if (labels !== undefined) {
    // 모든 값에 표시명이 있고, 표시명 맵에 남는 키가 없다
    expect(Object.keys(labels)).toEqual(values);
    for (const label of Object.values(labels)) {
      expect(label.trim().length).toBeGreaterThan(0);
      // 화면 문구 원칙: 코드 표기 금지 (screens.md 1.1)
      expect(label).not.toMatch(/[_`]/);
    }
    expect(new Set(Object.values(labels)).size).toBe(values.length);
  }
};

describe('판정 · 변이 상태 (기획서 3.4)', () => {
  it('판정 상태 5종: 통과 · 실패 · 미판정 · 격리 · 재검증 필요', () => {
    expectEnum(
      JudgmentStatus,
      ['pass', 'fail', 'unjudged', 'quarantined', 'needs_recheck'],
      JUDGMENT_STATUS_LABELS,
    );
    expect(Object.values(JUDGMENT_STATUS_LABELS)).toEqual([
      '통과',
      '실패',
      '미판정',
      '격리',
      '재검증 필요',
    ]);
  });

  it('변이 상태 3종: 검증됨 · 미검증 · 생존', () => {
    expectEnum(MutationStatus, ['verified', 'unverified', 'survived'], MUTATION_STATUS_LABELS);
    expect(Object.values(MUTATION_STATUS_LABELS)).toEqual([
      '변이 검증됨',
      '변이 미검증',
      '변이 생존',
    ]);
  });
});

describe('실행 (architecture.md 4장, RUN-07)', () => {
  it('실행 상태 7종 (실행 대기 포함, ADR-105)', () => {
    expectEnum(
      RunStatus,
      [
        'waiting_approval',
        'queued',
        'running',
        'merged',
        'failed',
        'budget_exceeded',
        'interrupted',
      ],
      RUN_STATUS_LABELS,
    );
    expect(RUN_STATUS_LABELS.queued).toBe('실행 대기');
  });

  it('종료 상태는 병합 완료 · 실패 · 예산 초과뿐이고 중단은 재개 가능', () => {
    expect([...TERMINAL_RUN_STATUSES]).toEqual(['merged', 'failed', 'budget_exceeded']);
    expect(TERMINAL_RUN_STATUSES).not.toContain('interrupted');
  });

  it('상태 전이는 architecture.md 4장 상태 기계 그대로이고 종료 상태에서는 나가지 않는다 (ADR-061)', () => {
    expect(RUN_STATUS_TRANSITIONS).toEqual({
      waiting_approval: ['running', 'queued', 'failed'],
      queued: ['running', 'failed', 'budget_exceeded'],
      running: ['merged', 'failed', 'budget_exceeded', 'interrupted'],
      interrupted: ['running', 'failed', 'merged'],
      merged: [],
      failed: [],
      budget_exceeded: [],
    });
    expect(canTransitionRun('waiting_approval', 'running')).toBe(true);
    expect(canTransitionRun('interrupted', 'running')).toBe(true);
    expect(canTransitionRun('waiting_approval', 'merged')).toBe(false);
    // 실행 대기는 시작(진행 중)이나 시작 때 대상 규칙 재검사 실패(실패)로만 나간다 (ADR-105)
    expect(canTransitionRun('waiting_approval', 'queued')).toBe(true);
    expect(canTransitionRun('queued', 'running')).toBe(true);
    expect(canTransitionRun('queued', 'failed')).toBe(true);
    // 실행 대기의 자동 시작 실행이 시작할 차례에 오늘 지출이 하루 한도에 이르렀으면 예산 초과로 끝난다 (ADR-111)
    expect(canTransitionRun('queued', 'budget_exceeded')).toBe(true);
    expect(canTransitionRun('queued', 'interrupted')).toBe(false);
    expect(canTransitionRun('running', 'queued')).toBe(false);
    expect(canTransitionRun('interrupted', 'queued')).toBe(false);
    // 재개할 수 없는 중단 실행은 사람의 재개 행동 안에서 실패로 끝난다 (ADR-105)
    expect(canTransitionRun('interrupted', 'failed')).toBe(true);
    // 병합 커밋이 기록된 중단 실행은 재개할 수 없으면 병합 완료로 끝난다 (runEnding, ADR-091 · ADR-105)
    expect(canTransitionRun('interrupted', 'merged')).toBe(true);
    expect(canTransitionRun('interrupted', 'budget_exceeded')).toBe(false);
    expect(canTransitionRun('running', 'running')).toBe(false);
    expect(canTransitionRun('merged', 'running')).toBe(false);
    for (const status of RunStatus.options) {
      expect(isTerminalRunStatus(status)).toBe(RUN_STATUS_TRANSITIONS[status].length === 0);
    }
  });

  it('끝난 단계 상태는 통과 · 실패 · 생략', () => {
    expect([...FINAL_STEP_STATUSES]).toEqual(['passed', 'failed', 'skipped']);
    expect(isFinalStepStatus('running')).toBe(false);
    expect(isFinalStepStatus('pending')).toBe(false);
    expect(isFinalStepStatus('skipped')).toBe(true);
  });

  it('실행 유형 A~D', () => {
    expectEnum(RunType, ['A', 'B', 'C', 'D'], RUN_TYPE_LABELS);
    expect(RUN_TYPE_LABELS.A).toBe('신규 동작');
  });

  it('단계 이름 9종', () => {
    expectEnum(
      StepKind,
      [
        'approval',
        'test_writing',
        'red_check',
        'green_check',
        'implementation',
        'check',
        'mutation',
        'merge',
        'screen_update',
      ],
      STEP_KIND_LABELS,
    );
  });

  it('단계 상태 5종', () => {
    expectEnum(
      StepStatus,
      ['pending', 'running', 'passed', 'failed', 'skipped'],
      STEP_STATUS_LABELS,
    );
  });

  it('세션 종료 사유 7종 (M7-11 #223: 이의 제기)', () => {
    expectEnum(
      SessionEndReason,
      [
        'success',
        'error_max_turns',
        'error_max_budget_usd',
        'error_during_execution',
        'aborted',
        'guard_violation',
        'objection_raised',
      ],
      SESSION_END_REASON_LABELS,
    );
  });

  it('실행 종료 사유: 값마다 한국어 표시명, 문서 기호 없음 (M3-35 #263, ADR-123)', () => {
    expectEnum(RunFailureReason, RunFailureReason.options, RUN_FAILURE_REASON_LABELS);
    expect(Object.keys(RUN_FAILURE_REASON_LABELS)).toEqual(RunFailureReason.options);
    for (const label of Object.values(RUN_FAILURE_REASON_LABELS)) {
      expect(label).not.toMatch(/ADR|PRD|SCR|[\u2460-\u24ff]|[A-Z]{2,}-\d/);
    }
    expect(RUN_FAILURE_REASON_LABELS.existing_rule_contradiction).toBe('기존 규칙 모순');
    expect(RUN_FAILURE_REASON_LABELS.objection_applied).toBe('이의 반영');
    expect(RUN_FAILURE_REASON_LABELS.target_rule_retired).toBe('대상 규칙 폐기');
  });
});

describe('생성 주체 (NRM-01, ADR-008, ADR-009)', () => {
  it('생성 주체 2종: 사람 · 에이전트', () => {
    expectEnum(AuthorKind, ['human', 'agent'], AUTHOR_KIND_LABELS);
    expect(AUTHOR_KIND_LABELS).toEqual({ human: '사람', agent: '에이전트' });
  });

  it('에이전트 역할 6종 (변이 주입 역할은 M3-07 #52)', () => {
    expectEnum(
      AgentRole,
      ['rule-writer', 'planner', 'test-writer', 'implementer', 'mutator', 'chat'],
      AGENT_ROLE_LABELS,
    );
    expect(AGENT_ROLE_LABELS.mutator).toBe('변이 주입');
  });
});

describe('규범 · 제안 (NRM-02, NRM-04, TODO-01)', () => {
  it('규범 상태 2종', () => {
    expectEnum(NormState, ['approved', 'provisional'], NORM_STATE_LABELS);
  });

  it('제안 상태 4종', () => {
    expectEnum(
      ProposalState,
      ['pending', 'approved', 'rejected', 'provisional'],
      PROPOSAL_STATE_LABELS,
    );
  });

  it('제안 종류 8종', () => {
    expectEnum(
      ProposalKind,
      [
        'requirement_new',
        'requirement_change',
        'rule_new',
        'rule_change',
        'contract_new',
        'design_change',
        'rule_title_change',
        'contract_change',
      ],
      PROPOSAL_KIND_LABELS,
    );
  });

  it('제안 출처 5종', () => {
    expectEnum(
      ProposalSource,
      ['rule_generation', 'chat', 'reverse_extraction', 'writing_rules', 'implementation'],
      PROPOSAL_SOURCE_LABELS,
    );
  });

  it('규칙 종류 · 검사 종류 · 위험도', () => {
    expectEnum(RuleKind, ['architecture', 'tech-constraint', 'business'], RULE_KIND_LABELS);
    expectEnum(CheckKind, ['test', 'pbt', 'contract', 'static', 'structure'], CHECK_KIND_LABELS);
    expectEnum(Risk, ['low', 'medium', 'high'], RISK_LABELS);
  });

  it('잠정 승인 정책: 사용 안 함 · 위험도 기준 (ADR-012, ADR-031)', () => {
    expectEnum(ProvisionalPolicy, ['off', 'risk_based'], PROVISIONAL_POLICY_LABELS);
  });
});

describe('판정 실행기 · P1 이후 열거형', () => {
  it('판정 실행기 · 테스트 케이스 상태', () => {
    // 내장 구조 규칙(구조 검사)의 판정 실행기 (M3-03 #48)
    // OpenAPI 계약 검사(M3-47 #292) · AsyncAPI 계약 검사(M3-49 #294)
    expectEnum(JudgeRunner, ['vitest', 'dependency-cruiser', 'redocly-prism', 'asyncapi-parser']);
    expectEnum(TestCaseStatus, ['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled']);
  });

  it('계약 · 블록 · ADR · 승인 기록 · 코드 열기', () => {
    expectEnum(ContractKind, [
      'openapi',
      'db-schema',
      'asyncapi',
      'external-api',
      'cache',
      'json-schema',
    ]);
    expectEnum(BlockKind, ['domain', 'shared']);
    expectEnum(AdrStatus, ['proposed', 'accepted']);
    expectEnum(ApprovalAction, [
      'approve',
      'approve_edited',
      'reject',
      'run_start',
      'provisional_grant',
      'confirm',
      'rule_edit',
      'contract_edit',
    ]);
    expectEnum(ConfirmationState, ['unconfirmed', 'confirmed']);
    expectEnum(CodeOpenReason, ['screen_error', 'info_lacking', 'debugging']);
  });
});
