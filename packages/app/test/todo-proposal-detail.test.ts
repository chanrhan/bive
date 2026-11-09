// 승인 대기 상세의 순수 함수 (이슈 #40, screens.md SCR-17 상세 · 동작, NRM-04, ADR-050 · ADR-063).
// renderer는 shared를 import type으로만 쓰므로 표시명 · 검증을 다시 적는다. 여기서 shared 원본(스키마 · 표시명 ·
// 오류 사유)과 대조한다. 제안 · 승인 기록 데이터는 이 테스트 안에서만 만들고 shared 스키마로 검증한다 (NFR-03).
import {
  APPROVAL_LOG_GENESIS_HASH,
  ApprovalLogEntry,
  CHECK_KIND_LABELS,
  DomainErrorReason,
  ErrorCode,
  Proposal,
  PROPOSAL_PAYLOAD_SCHEMAS,
  PROPOSAL_SOURCE_LABELS,
  ProposalKind,
  RULE_KIND_LABELS,
  SupportedProposalKind,
} from '@bive/shared';
import { describe, expect, it } from 'vitest';

import * as labels from '../src/renderer/src/proposals/labels.js';
import {
  ACTIONABLE_KINDS,
  actionErrorText,
  authorName,
  availableActions,
  canReject,
  consequences,
  decisionActionLabel,
  decisionEntry,
  diffRows,
  EDIT_FIELDS,
  editedPayload,
  editErrors,
  initialEditValues,
  isStaleError,
  payloadFields,
  shortcutHint,
  sourceRows,
} from '../src/renderer/src/screens/todo/proposalDetailView.js';

const REQ_ID = '01JAAAAAAAAAAAAAAAAAAAAAR1';
const PRP_ID = '01JAAAAAAAAAAAAAAAAAAAAAP1';
const OTHER_ID = '01JAAAAAAAAAAAAAAAAAAAAAP2';

const RULE_PAYLOAD = {
  title: '헬스 응답에 서버 시각 포함',
  statement: '헬스 요청을 받으면 시스템은 서버 시각을 응답에 포함한다',
  kind: 'business',
  checkKinds: ['test', 'pbt'],
  parentRequirementId: REQ_ID,
};

const proposal = (overrides: Partial<Proposal> = {}): Proposal =>
  Proposal.parse({
    id: PRP_ID,
    displayId: 'PRP-001',
    kind: 'rule_new',
    targetRef: { entity: 'Requirement', id: REQ_ID },
    payload: RULE_PAYLOAD,
    diff: { before: null, after: RULE_PAYLOAD },
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

const reqLabel = (id: string): string | null => (id === REQ_ID ? 'REQ-001' : null);
const noLabel = (): null => null;

const logEntry = (overrides: Partial<ApprovalLogEntry>): ApprovalLogEntry =>
  ApprovalLogEntry.parse({
    seq: 1,
    at: '2026-10-16T02:00:00.000Z',
    action: 'approve',
    actor: { kind: 'human' },
    targetRef: { entity: 'Proposal', id: PRP_ID },
    clientId: 'pipe-1',
    detail: { appliedRef: { entity: 'Rule', id: OTHER_ID } },
    prevHash: APPROVAL_LOG_GENESIS_HASH,
    hash: 'a'.repeat(64),
    ...overrides,
  });

describe('표시명 · 종류', () => {
  it('출처 · 규칙 종류 · 검사 종류 표시명이 shared와 같다', () => {
    expect(labels.PROPOSAL_SOURCE_LABELS).toEqual(PROPOSAL_SOURCE_LABELS);
    expect(labels.RULE_KIND_LABELS).toEqual(RULE_KIND_LABELS);
    expect(labels.CHECK_KIND_LABELS).toEqual(CHECK_KIND_LABELS);
  });

  it('수정 · 승인할 수 있는 종류 = 본문 스키마가 있는 종류', () => {
    expect([...ACTIONABLE_KINDS].sort()).toEqual([...SupportedProposalKind.options].sort());
    expect(Object.keys(EDIT_FIELDS).sort()).toEqual(Object.keys(PROPOSAL_PAYLOAD_SCHEMAS).sort());
  });
});

describe('처리 버튼', () => {
  it('대기 제안: 스키마가 있는 종류는 거절 · 수정 · 승인, 없는 종류는 거절만', () => {
    expect(availableActions(proposal())).toEqual(['reject', 'edit', 'approve']);
    expect(
      availableActions(
        proposal({ kind: 'requirement_new', targetRef: null, payload: { text: '문장' } }),
      ),
    ).toEqual(['reject', 'edit', 'approve']);
    for (const kind of ProposalKind.options.filter((k) => !ACTIONABLE_KINDS.includes(k as never))) {
      expect(availableActions(proposal({ kind }))).toEqual(['reject']);
    }
  });

  it('처리된 제안에는 처리 버튼이 없다', () => {
    const at = '2026-10-16T02:00:00.000Z';
    expect(
      availableActions(
        proposal({
          state: 'approved',
          decision: { at, by: { kind: 'human' }, appliedRef: { entity: 'Rule', id: OTHER_ID } },
        }),
      ),
    ).toEqual([]);
    expect(
      availableActions(
        proposal({
          state: 'rejected',
          decision: { at, by: { kind: 'human' }, rejectReason: '범위 밖' },
        }),
      ),
    ).toEqual([]);
  });
});

describe('출처 · 제안 본문 · 변경 내용', () => {
  it('출처 = 생성 경로 + (규칙 제안) 부모 요구사항', () => {
    expect(sourceRows(proposal(), 'REQ-001 · 헬스 응답')).toEqual([
      { key: 'path', label: '생성 경로', value: '규칙 자동 생성' },
      { key: 'parent', label: '부모 요구사항', value: 'REQ-001 · 헬스 응답' },
    ]);
    // 부모를 모르면 그 줄을 보이지 않는다 (NFR-03)
    expect(sourceRows(proposal({ source: 'chat' }), null)).toEqual([
      { key: 'path', label: '생성 경로', value: '채팅 지시' },
    ]);
  });

  it('생성 주체는 에이전트 · 역할명', () => {
    expect(authorName(proposal())).toBe('에이전트 · 규칙 작성');
  });

  it('규칙 본문 필드: 사람이 읽는 이름 · 값, 부모는 표시 ID (모르면 뺀다)', () => {
    expect(payloadFields('rule_new', RULE_PAYLOAD, reqLabel)).toEqual([
      { key: 'title', label: '제목', value: RULE_PAYLOAD.title },
      { key: 'statement', label: '진술', value: RULE_PAYLOAD.statement },
      { key: 'kind', label: '규칙 종류', value: '비즈니스' },
      { key: 'checkKinds', label: '검사 종류', value: '인수 테스트 · 속성 기반 테스트' },
      { key: 'parentRequirementId', label: '부모 요구사항', value: 'REQ-001' },
    ]);
    expect(payloadFields('rule_new', RULE_PAYLOAD, noLabel)?.map((f) => f.key)).not.toContain(
      'parentRequirementId',
    );
    expect(payloadFields('requirement_new', { text: '문장' }, noLabel)).toEqual([
      { key: 'text', label: '문장', value: '문장' },
    ]);
    // 스키마가 없는 종류 · 객체가 아닌 본문은 표시하지 않는다
    expect(payloadFields('design_change', { title: '설계' }, noLabel)).toBeNull();
    expect(payloadFields('rule_new', '문자열', noLabel)).toBeNull();
  });

  it('신규 제안의 변경 내용은 이후 필드 전부가 추가', () => {
    const rows = diffRows('rule_new', null, RULE_PAYLOAD, reqLabel);
    expect(rows?.map((r) => r.key)).toEqual([
      'title',
      'statement',
      'kind',
      'checkKinds',
      'parentRequirementId',
    ]);
    expect(rows?.every((r) => r.before === null && r.after !== null)).toBe(true);
  });

  it('수정 diff는 바뀐 필드만 이전 · 이후', () => {
    const after = { ...RULE_PAYLOAD, title: '헬스 응답에 UTC 시각 포함' };
    expect(diffRows('rule_new', RULE_PAYLOAD, after, reqLabel)).toEqual([
      { key: 'title', label: '제목', before: RULE_PAYLOAD.title, after: after.title },
    ]);
    expect(diffRows('design_change', null, { title: 'x' }, reqLabel)).toBeNull();
  });

  it('승인하면 / 거절하면: 승인할 수 없는 종류는 승인하면 카드 없음', () => {
    expect(consequences('rule_new')).toEqual({
      approve: ['규칙 추가', '승인 기록 추가'],
      reject: ['규범 변경 없음', '거절 사유 기록'],
    });
    expect(consequences('requirement_new').approve).toEqual(['요구사항 추가', '승인 기록 추가']);
    expect(consequences('design_change').approve).toBeNull();
  });
});

describe('수정 후 승인 입력', () => {
  it('처음 값은 제안 문장, 규칙은 제목 · 진술만 고친다', () => {
    expect(initialEditValues('rule_new', RULE_PAYLOAD)).toEqual({
      title: RULE_PAYLOAD.title,
      statement: RULE_PAYLOAD.statement,
    });
    expect(initialEditValues('requirement_new', { text: '문장' })).toEqual({ text: '문장' });
  });

  it('검증 문구가 비어 있으면 수정 본문은 shared 종류 스키마를 통과하고, 있으면 통과하지 않는다', () => {
    const cases = [
      {
        kind: 'rule_new',
        payload: RULE_PAYLOAD,
        values: { title: '새 제목', statement: '새 진술' },
      },
      { kind: 'rule_new', payload: RULE_PAYLOAD, values: { title: '  ', statement: '새 진술' } },
      { kind: 'rule_new', payload: RULE_PAYLOAD, values: { title: '새 제목', statement: '\n' } },
      { kind: 'requirement_new', payload: { text: '원문' }, values: { text: '고친 문장' } },
      { kind: 'requirement_new', payload: { text: '원문' }, values: { text: ' \t' } },
    ] as const;
    for (const { kind, payload, values } of cases) {
      const errors = editErrors(kind, values);
      const edited = editedPayload(kind, payload, values);
      const ok = PROPOSAL_PAYLOAD_SCHEMAS[kind].safeParse(edited).success;
      expect(ok, JSON.stringify(values)).toBe(Object.keys(errors).length === 0);
    }
    expect(editErrors('rule_new', { title: '', statement: ' ' })).toEqual({
      title: '제목 비어 있음',
      statement: '진술 비어 있음',
    });
  });

  it('수정 본문 = 원래 본문 + 고친 문장 (종류 · 검사 종류 · 부모는 그대로, 입력 문구 그대로)', () => {
    expect(
      editedPayload('rule_new', RULE_PAYLOAD, { title: ' 새 제목', statement: '새 진술' }),
    ).toEqual({
      ...RULE_PAYLOAD,
      title: ' 새 제목',
      statement: '새 진술',
    });
  });

  it('거절 사유는 공백만이면 보내지 않는다', () => {
    expect(canReject('')).toBe(false);
    expect(canReject('  \n\t')).toBe(false);
    expect(canReject('범위 밖')).toBe(true);
  });

  it('단축키 안내는 운영체제에 맞춘다', () => {
    expect(shortcutHint(true)).toBe('⌘↵ 확인 · Esc 취소');
    expect(shortcutHint(false)).toBe('Ctrl+Enter 확인 · Esc 취소');
  });
});

describe('처리 오류', () => {
  it('오류 코드 · 사유 → 문구 (shared 오류 코드 · 사유 값과 같음)', () => {
    expect(actionErrorText({ code: ErrorCode.StateConflict, message: 'x' })).toBe(
      '처리 불가 (상태 변경)',
    );
    expect(actionErrorText({ code: ErrorCode.NotFound, message: 'x' })).toBe('제안 없음');
    expect(actionErrorText({ code: ErrorCode.Unauthorized, message: 'x' })).toBe('처리 권한 없음');
    expect(
      actionErrorText({
        code: ErrorCode.ValidationFailed,
        message: 'x',
        data: { reason: DomainErrorReason.RejectReasonRequired },
      }),
    ).toBe('거절 사유 필요');
    expect(
      actionErrorText({
        code: ErrorCode.ValidationFailed,
        message: 'x',
        data: { reason: DomainErrorReason.EditedPayloadInvalid },
      }),
    ).toBe('수정 내용 형식 오류');
    expect(actionErrorText({ code: ErrorCode.ValidationFailed, message: 'x' })).toBe('처리 실패');
    expect(actionErrorText(new Error('끊김'))).toBe('처리 실패');
  });

  it('이미 처리됨 · 없음이면 목록을 다시 읽는다', () => {
    expect(isStaleError({ code: ErrorCode.StateConflict, message: 'x' })).toBe(true);
    expect(isStaleError({ code: ErrorCode.NotFound, message: 'x' })).toBe(true);
    expect(isStaleError({ code: ErrorCode.ValidationFailed, message: 'x' })).toBe(false);
    expect(isStaleError(null)).toBe(false);
  });
});

describe('처리 기록', () => {
  it('그 제안의 마지막 승인 · 거절 기록만 고른다', () => {
    const approve = logEntry({});
    const edited = logEntry({
      seq: 2,
      action: 'approve_edited',
      detail: {
        diff: { before: RULE_PAYLOAD, after: { ...RULE_PAYLOAD, title: '고침' } },
        appliedRef: { entity: 'Rule', id: OTHER_ID },
      },
    });
    const other = logEntry({ seq: 3, targetRef: { entity: 'Proposal', id: OTHER_ID } });
    const runStart = logEntry({
      seq: 4,
      action: 'run_start',
      targetRef: { entity: 'Run', id: PRP_ID },
      detail: { ruleIds: [OTHER_ID] },
    });
    expect(decisionEntry([approve, edited, other, runStart], PRP_ID)).toBe(edited);
    expect(decisionEntry([other, runStart], PRP_ID)).toBeNull();
    expect(decisionActionLabel(approve)).toBe('승인');
    expect(decisionActionLabel(edited)).toBe('수정 후 승인');
    expect(decisionActionLabel(logEntry({ action: 'reject', detail: { reason: '범위 밖' } }))).toBe(
      '거절',
    );
  });
});
