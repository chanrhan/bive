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
  CHECK_KIND_LABELS,
  CheckKind,
  CodeOpenReason,
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
  RUN_STATUS_LABELS,
  RUN_TYPE_LABELS,
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
  it('실행 상태 6종', () => {
    expectEnum(
      RunStatus,
      ['waiting_approval', 'running', 'merged', 'failed', 'budget_exceeded', 'interrupted'],
      RUN_STATUS_LABELS,
    );
  });

  it('종료 상태는 병합 완료 · 실패 · 예산 초과뿐이고 중단은 재개 가능', () => {
    expect([...TERMINAL_RUN_STATUSES]).toEqual(['merged', 'failed', 'budget_exceeded']);
    expect(TERMINAL_RUN_STATUSES).not.toContain('interrupted');
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

  it('세션 종료 사유 6종', () => {
    expectEnum(
      SessionEndReason,
      [
        'success',
        'error_max_turns',
        'error_max_budget_usd',
        'error_during_execution',
        'aborted',
        'guard_violation',
      ],
      SESSION_END_REASON_LABELS,
    );
  });
});

describe('생성 주체 (NRM-01, ADR-008, ADR-009)', () => {
  it('생성 주체 2종: 사람 · 에이전트', () => {
    expectEnum(AuthorKind, ['human', 'agent'], AUTHOR_KIND_LABELS);
    expect(AUTHOR_KIND_LABELS).toEqual({ human: '사람', agent: '에이전트' });
  });

  it('에이전트 역할 5종', () => {
    expectEnum(
      AgentRole,
      ['rule-writer', 'planner', 'test-writer', 'implementer', 'chat'],
      AGENT_ROLE_LABELS,
    );
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
    expectEnum(JudgeRunner, ['vitest']);
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
    ]);
    expectEnum(CodeOpenReason, ['screen_error', 'info_lacking', 'debugging']);
  });
});
