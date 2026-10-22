// 할 일 진입 · 승인 대기 카드의 순수 함수 (이슈 #23, screens.md 6장 할 일 · SCR-17, ADR-056).
// renderer는 shared를 import type으로만 쓰므로 표시명을 다시 적는다. 여기서 shared 원본과 대조한다.
// 제안 데이터는 이 테스트 안에서만 만들고 shared Proposal 스키마로 검증한다 (NFR-03).
import {
  AGENT_ROLE_LABELS,
  Proposal,
  PROPOSAL_KIND_LABELS,
  PROPOSAL_STATE_LABELS,
  type ProposalCountResult,
  ProposalKind,
  RISK_LABELS,
} from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { cardExceptions, type CardData } from '../src/renderer/src/components/Card2Line/card.js';
import {
  countOptions,
  EMPTY_FILTER,
  filterEntries,
  type ListEntry,
} from '../src/renderer/src/components/ListView/filter.js';
import { DECISION_LABELS, statusTone } from '../src/renderer/src/components/StatusBadge/status.js';
import * as labels from '../src/renderer/src/proposals/labels.js';
import {
  APPROVAL_CRITERIA,
  APPROVAL_KINDS,
  isApprovalProposal,
  KIND_TAGS,
  kindTag,
  proposalCard,
  proposalTitle,
} from '../src/renderer/src/screens/todo/proposalCard.js';
import {
  getTodoTab,
  resetTodoTab,
  setTodoTab,
  TODO_TABS,
} from '../src/renderer/src/screens/todo/tabStore.js';

const ULIDS = [
  '01JAAAAAAAAAAAAAAAAAAAAAA1',
  '01JAAAAAAAAAAAAAAAAAAAAAA2',
  '01JAAAAAAAAAAAAAAAAAAAAAA3',
  '01JAAAAAAAAAAAAAAAAAAAAAA4',
  '01JAAAAAAAAAAAAAAAAAAAAAA5',
] as const;

let seq = 0;
const proposal = (overrides: Partial<Proposal> = {}): Proposal => {
  seq += 1;
  return Proposal.parse({
    id: ULIDS[seq % ULIDS.length],
    displayId: `PRP-${String(seq).padStart(3, '0')}`,
    kind: 'rule_new',
    targetRef: null,
    payload: {
      title: '헬스 응답에 서버 시각 포함',
      statement: '헬스 요청을 받으면 시스템은 서버 시각을 응답에 포함한다',
      kind: 'business',
      checkKinds: ['test'],
      parentRequirementId: ULIDS[0],
    },
    diff: { before: null, after: null },
    rationale: '요구사항 문장에서 검사 가능한 규칙을 뽑음',
    author: { kind: 'agent', role: 'rule-writer' },
    source: 'rule_generation',
    risk: null,
    readAt: null,
    state: 'pending',
    decision: null,
    adrId: null,
    runId: null,
    createdAt: '2026-10-16T01:00:00.000Z',
    ...overrides,
  });
};

const approved = { at: '2026-10-16T02:00:00.000Z', by: { kind: 'human' as const } };

const count = (byKind: Partial<Record<ProposalKind, number>>): ProposalCountResult => {
  const pendingByKind = Object.fromEntries(
    ProposalKind.options.map((kind) => [kind, byKind[kind] ?? 0]),
  ) as Record<ProposalKind, number>;
  return {
    pending: Object.values(pendingByKind).reduce((a, b) => a + b, 0),
    pendingByKind,
  };
};

describe('표시명', () => {
  it('제안 종류 · 상태 · 역할 · 위험도 표시명이 shared와 같다', () => {
    expect(labels.PROPOSAL_KIND_LABELS).toEqual(PROPOSAL_KIND_LABELS);
    expect(labels.PROPOSAL_STATE_LABELS).toEqual(PROPOSAL_STATE_LABELS);
    expect(labels.AGENT_ROLE_LABELS).toEqual(AGENT_ROLE_LABELS);
    expect(labels.RISK_LABELS).toEqual(RISK_LABELS);
    // 툴팁 · 필터 순서 = shared enum 순서
    expect(Object.keys(labels.PROPOSAL_KIND_LABELS)).toEqual(ProposalKind.options);
  });

  it('처리 결과 표시명이 shared 제안 상태와 같고 승인은 흐린 점, 거절은 예외', () => {
    expect(DECISION_LABELS.approved).toBe(PROPOSAL_STATE_LABELS.approved);
    expect(DECISION_LABELS.rejected).toBe(PROPOSAL_STATE_LABELS.rejected);
    expect(statusTone({ kind: 'decision', status: 'approved' })).toBe('normal');
    expect(statusTone({ kind: 'decision', status: 'rejected' })).not.toBe('normal');
  });
});

describe('알림 배지 · 툴팁', () => {
  it('배지 숫자 = 대기 건수, 모르면 null', () => {
    expect(labels.todoBadgeTotal(null)).toBeNull();
    expect(labels.todoBadgeTotal(count({}))).toBe(0);
    expect(labels.todoBadgeTotal(count({ rule_new: 2, requirement_new: 1 }))).toBe(3);
  });

  it('툴팁은 종류별 건수, 0건 종류는 빼고 많은 순 · 같으면 종류 순서', () => {
    expect(labels.todoBreakdown(count({ rule_new: 2, requirement_new: 1 }))).toBe(
      '규칙 신규 2 · 요구사항 신규 1',
    );
    expect(labels.todoBreakdown(count({ rule_new: 1, requirement_new: 1 }))).toBe(
      '요구사항 신규 1 · 규칙 신규 1',
    );
    expect(labels.todoBreakdown(count({}))).toBe('');
    expect(labels.todoBreakdown(null)).toBe('');
  });
});

describe('승인 대기 카드', () => {
  it('종류 태그는 화면 정의서 6종 중 하나, 기존 계약 변경은 승인 대기 탭 밖', () => {
    expect(new Set(Object.values(KIND_TAGS))).toEqual(
      new Set(['신규', '변경', '요구사항', '요구사항 변경', '설계', '제목']),
    );
    expect(APPROVAL_KINDS).toEqual(ProposalKind.options.filter((k) => k !== 'contract_change'));
    expect(isApprovalProposal(proposal({ kind: 'contract_change', payload: {} }))).toBe(false);
    expect(isApprovalProposal(proposal())).toBe(true);
    expect(kindTag('rule_new')).toBe('신규');
    expect(kindTag('requirement_new')).toBe('요구사항');
    expect(kindTag('rule_title_change')).toBe('제목');
  });

  it('제목: 규칙은 제목, 요구사항은 문장, 본문에 없으면 근거', () => {
    expect(proposalTitle(proposal())).toBe('헬스 응답에 서버 시각 포함');
    expect(
      proposalTitle(proposal({ kind: 'requirement_new', payload: { text: '헬스 응답 확장' } })),
    ).toBe('헬스 응답 확장');
    expect(proposalTitle(proposal({ kind: 'design_change', payload: { blocks: [] } }))).toBe(
      '요구사항 문장에서 검사 가능한 규칙을 뽑음',
    );
  });

  it('정상 대기 제안: 2줄째 예외 없음, 안 읽음 점, 시각 = 생성 시각', () => {
    const card = proposalCard(proposal());
    expect(card).toMatchObject({
      tag: '신규',
      unread: true,
      dateTime: '2026-10-16T01:00:00.000Z',
    });
    expect(card.id).toMatch(/^PRP-\d{3}$/);
    expect(cardExceptions(card)).toEqual([]);
    expect(proposalCard(proposal({ readAt: '2026-10-16T03:00:00.000Z' })).unread).toBe(false);
  });

  it('예외: 위험 높음 · 구현 중 제안 · 거절 (승인은 흐린 점이라 예외 아님)', () => {
    const labelsOf = (card: CardData): string[] => cardExceptions(card).map((e) => e.label);
    expect(labelsOf(proposalCard(proposal({ risk: 'high' })))).toEqual(['위험 높음']);
    expect(labelsOf(proposalCard(proposal({ source: 'implementation' })))).toEqual([
      '구현 중 제안',
    ]);
    const rejected = proposal({
      state: 'rejected',
      decision: { ...approved, rejectReason: '범위 밖' },
    });
    expect(labelsOf(proposalCard(rejected))).toEqual(['거절']);
    const accepted = proposal({
      state: 'approved',
      decision: { ...approved, appliedRef: { entity: 'Rule', id: ULIDS[1] } },
    });
    expect(labelsOf(proposalCard(accepted))).toEqual([]);
    expect(proposalCard(accepted).statuses).toEqual([{ kind: 'decision', status: 'approved' }]);
  });
});

describe('필터 기준', () => {
  const items = [
    proposal(),
    proposal({ kind: 'requirement_new', payload: { text: '헬스 응답 확장' } }),
    proposal({
      state: 'rejected',
      decision: { ...approved, rejectReason: '범위 밖' },
      author: { kind: 'agent', role: 'chat' },
    }),
  ];
  const entries: ListEntry<Proposal>[] = items.map((item, index) => ({
    item,
    key: item.id,
    searchText: item.displayId,
    problem: false,
    time: null,
    index,
  }));

  it('처리 상태 · 종류 · 위험도 · 제안자 4종, 기본 처리 상태 대기로 대기만 보인다', () => {
    expect(APPROVAL_CRITERIA.map((c) => c.label)).toEqual([
      '처리 상태',
      '종류',
      '위험도',
      '제안자',
    ]);
    const state = { ...EMPTY_FILTER, selected: { state: ['pending'] } };
    expect(filterEntries(entries, APPROVAL_CRITERIA, state).map((e) => e.item.state)).toEqual([
      'pending',
      'pending',
    ]);
  });

  it('위험도 값이 없으면 전부 0건 (칩 비활성), 처리 상태 개수는 상태별', () => {
    const counts = countOptions(entries, APPROVAL_CRITERIA, EMPTY_FILTER);
    expect(counts['risk']).toEqual({ low: 0, medium: 0, high: 0 });
    expect(counts['state']).toEqual({ pending: 2, approved: 0, rejected: 1 });
    expect(counts['author']).toMatchObject({ 'rule-writer': 2, chat: 1 });
  });
});

describe('마지막 탭 기억', () => {
  it('M1 탭은 승인 대기 하나, 없는 탭은 무시', () => {
    expect(TODO_TABS.map((t) => t.label)).toEqual(['승인 대기']);
    resetTodoTab();
    expect(getTodoTab()).toBe('approval');
    setTodoTab('review' as never);
    expect(getTodoTab()).toBe('approval');
  });
});
