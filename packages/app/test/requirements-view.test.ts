// 요구사항 화면 표시 규칙 (이슈 #17, screens.md SCR-02 카드 · 필터, ADR-053, M7-15 #227 · ADR-100 I3 · B① · ADR-114).
import { AUTHOR_KIND_LABELS, type Requirement } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  countOptions,
  EMPTY_FILTER,
  type ListEntry,
} from '../src/renderer/src/components/ListView/filter.js';
import {
  EXCEPTION_LABELS,
  REQUIREMENT_CRITERIA,
  requirementCard,
  requirementExceptions,
  visibleRequirements,
} from '../src/renderer/src/screens/requirements/requirementsView.js';

const T0 = '2026-10-16T01:00:00.000Z';
const T1 = '2026-10-16T02:30:00.000Z';

const req = (patch: Partial<Requirement> & Pick<Requirement, 'id' | 'displayId'>): Requirement => ({
  text: '로그인 실패 5회면 잠근다',
  author: { kind: 'human' },
  normState: 'approved',
  unrulable: null,
  createdAt: T0,
  updatedAt: T0,
  updatedBy: { kind: 'human' },
  deletedAt: null,
  // 사람이 쓴 요구사항은 저장 즉시 확인됨 (ADR-100 B①)
  confirmation: {
    state: 'confirmed',
    at: T0,
    by: { kind: 'human' },
    basis: { kind: 'requirement_record', at: T0 },
  },
  ...patch,
});

const NORMAL = req({ id: '01JA0000000000000000000001', displayId: 'REQ-001' });
const UNRULABLE = req({
  id: '01JA0000000000000000000002',
  displayId: 'REQ-002',
  unrulable: { reason: '측정 기준 없음' },
});
/** 사람이 아직 보지 않은 요구사항 (에이전트 작성) */
const UNCONFIRMED = req({
  id: '01JA0000000000000000000003',
  displayId: 'REQ-003',
  author: { kind: 'agent', role: 'rule-writer' },
  updatedAt: T1,
  confirmation: { state: 'unconfirmed' },
});
const DELETED = req({ id: '01JA0000000000000000000004', displayId: 'REQ-004', deletedAt: T1 });

describe('카드', () => {
  it('1줄 문장 · 2줄 표시 ID와 시각(마지막 변경) · 생성 주체, 정상 항목은 예외가 비어 있다', () => {
    expect(requirementCard(NORMAL)).toEqual({
      title: '로그인 실패 5회면 잠근다',
      id: 'REQ-001',
      exceptions: [],
      dateTime: T0,
      author: 'human',
    });
    expect(requirementCard(UNCONFIRMED).dateTime).toBe(T1);
    expect(requirementCard(UNCONFIRMED).author).toBe('agent');
  });

  it('예외는 근거 필드에서만: 규칙화 불가(unrulable) · 미확인(확인 상태). 확인됨은 예외 없음', () => {
    expect(requirementExceptions(NORMAL)).toEqual([]);
    expect(requirementExceptions(UNRULABLE)).toEqual(['unrulable']);
    expect(requirementExceptions(UNCONFIRMED)).toEqual(['unconfirmed']);
    expect(
      requirementExceptions({ ...UNCONFIRMED, unrulable: { reason: '측정 기준 없음' } }),
    ).toEqual(['unrulable', 'unconfirmed']);
    expect(requirementCard(UNRULABLE).exceptions).toEqual([
      { key: 'unrulable', label: '규칙화 불가', tone: 'warning' },
    ]);
    expect(requirementCard(UNCONFIRMED).exceptions).toEqual([
      { key: 'unconfirmed', label: '미확인', tone: 'info' },
    ]);
    // 규범 상태 잠정은 더 예외가 아니다 (ADR-100 명세 변경 목록 SCR-02: 잠정 없음)
    expect(
      requirementExceptions(
        req({ id: '01JA0000000000000000000005', displayId: 'REQ-005', normState: 'provisional' }),
      ),
    ).toEqual([]);
  });

  it('예외 이름은 화면 정의서 카드 그대로 (잠정 자리는 미확인, ADR-100)', () => {
    expect(Object.values(EXCEPTION_LABELS)).toEqual([
      '추적성 결함',
      '규칙화 불가',
      '미확인',
      '실패',
    ]);
  });

  it('삭제된 요구사항은 목록에 보이지 않는다', () => {
    expect(visibleRequirements([NORMAL, DELETED, UNRULABLE]).map((r) => r.displayId)).toEqual([
      'REQ-001',
      'REQ-002',
    ]);
  });
});

describe('필터 기준', () => {
  const items = [NORMAL, UNRULABLE, UNCONFIRMED];
  const entries: ListEntry<Requirement>[] = items.map((item, index) => ({
    item,
    key: item.id,
    searchText: item.text,
    problem: requirementExceptions(item).length > 0,
    time: null,
    index,
  }));
  const counts = countOptions(entries, REQUIREMENT_CRITERIA, EMPTY_FILTER);

  it('4종: 상태 · 작성 · 확인 · 블록 순서 (옛 승인 칩이 확인으로)', () => {
    expect(REQUIREMENT_CRITERIA.map((c) => c.label)).toEqual(['상태', '작성', '확인', '블록']);
  });

  it('상태: 정상 · 추적성 결함 · 규칙화 불가 · 미확인 · 실패 (결함 · 실패는 근거 데이터가 없어 0건)', () => {
    const status = REQUIREMENT_CRITERIA[0];
    expect(status?.options.map((o) => o.label)).toEqual([
      '정상',
      '추적성 결함',
      '규칙화 불가',
      '미확인',
      '실패',
    ]);
    expect(counts['status']).toEqual({
      normal: 1,
      traceability: 0,
      unrulable: 1,
      unconfirmed: 1,
      failed: 0,
    });
  });

  it('작성: 사람 · 에이전트 (생성 주체)', () => {
    const author = REQUIREMENT_CRITERIA[1];
    expect(author?.options.map((o) => o.label)).toEqual([
      AUTHOR_KIND_LABELS.human,
      AUTHOR_KIND_LABELS.agent,
    ]);
    expect(counts['author']).toEqual({ human: 2, agent: 1 });
  });

  it('확인: 미확인 · 확인됨 (확인 상태, 사람이 쓴 요구사항은 확인됨)', () => {
    expect(REQUIREMENT_CRITERIA[2]?.id).toBe('confirmation');
    expect(REQUIREMENT_CRITERIA[2]?.options.map((o) => o.label)).toEqual(['미확인', '확인됨']);
    expect(counts['confirmation']).toEqual({ unconfirmed: 1, confirmed: 2 });
  });

  it('블록: 값 없음 (0건 비활성, ADR-035)', () => {
    expect(REQUIREMENT_CRITERIA[3]?.options).toEqual([]);
    expect(counts['block']).toEqual({});
  });
});
