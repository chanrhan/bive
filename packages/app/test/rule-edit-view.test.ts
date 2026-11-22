// 규칙 직접 편집의 표시 규칙 (M7-03 #215, SCR-06 · 1.1, ADR-109).
// 화면에서 실제로 보이는지 · 1회 호출 · 목록 갱신은 e2e/scr-06-rule.spec.ts · scr-06-requirement.spec.ts.
import { RuleEditConflictReason, type Rule } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  canConfirmRule,
  canEditRule,
  canSaveRuleEdit,
  confirmationText,
  confirmErrorText,
  confirmParams,
  RULE_EDIT_CONFLICT_LABELS,
  ruleEditAutoStartText,
  ruleEditErrorText,
  ruleEditParams,
} from '../src/renderer/src/screens/norm-detail/ruleEditView.js';
import { replaceRuleItem } from '../src/renderer/src/screens/rules/rulesView.js';

const RULE = {
  id: '01JC0000000000000000000002',
  title: '결제 24시간 뒤 주문 취소 거절',
  statement: 'WHEN 결제 후 24시간이 지난 주문의 취소를 요청하면 THE SYSTEM SHALL 요청을 거절한다',
  updatedAt: '2026-10-15T01:00:00.000Z',
  builtin: false,
  deletedAt: null,
  normState: 'approved',
} as const satisfies Partial<Rule>;
const PROJECT_ID = '01JAAAAAAAAAAAAAAAAAAAAAAA';

describe('ruleEditView', () => {
  it('[편집]은 효력 있고 삭제 · 폐기되지 않은 규칙에만, 내장 구조 규칙에는 없다', () => {
    expect(canEditRule(RULE, false)).toBe(true);
    expect(canEditRule({ ...RULE, builtin: true }, false)).toBe(false);
    expect(canEditRule({ ...RULE, deletedAt: '2026-10-16T00:00:00.000Z' }, false)).toBe(false);
    expect(canEditRule({ ...RULE, normState: 'provisional' }, false)).toBe(false);
    // 폐기 여부는 응답의 폐기 사실로 본다 (M7-15, ADR-114)
    expect(canEditRule(RULE, true)).toBe(false);
  });

  it('[확인]은 미확인이고 삭제 · 폐기되지 않은 규칙에만, 요청은 사람 주체 · 이 규칙', () => {
    const unconfirmed = { ...RULE, confirmation: { state: 'unconfirmed' } } as const;
    const confirmed = {
      ...RULE,
      confirmation: {
        state: 'confirmed',
        at: '2026-10-16T00:00:00.000Z',
        by: { kind: 'human' },
        basis: { kind: 'approval_log', seq: 3 },
      },
    } as const;
    expect(canConfirmRule(unconfirmed, false)).toBe(true);
    expect(canConfirmRule(confirmed, false)).toBe(false);
    expect(canConfirmRule(unconfirmed, true)).toBe(false);
    expect(canConfirmRule({ ...unconfirmed, deletedAt: '2026-10-16T00:00:00.000Z' }, false)).toBe(
      false,
    );
    expect(confirmParams(PROJECT_ID, RULE)).toEqual({
      projectId: PROJECT_ID,
      target: { entity: 'Rule', id: RULE.id },
      author: { kind: 'human' },
    });
  });

  it('[확인] 실패 문구: 오류 코드별 사유 한 줄, 모르는 오류는 사유 없이', () => {
    expect(confirmErrorText({ code: -32009, message: '이미 확인됨입니다' })).toBe(
      '확인 실패 · 이미 확인됨 또는 삭제된 규칙',
    );
    expect(confirmErrorText({ code: -32004, message: 'x' })).toBe('확인 실패 · 규칙 없음');
    expect(confirmErrorText({ code: -32020, message: 'x' })).toBe('확인 실패 · 확인 권한 없음');
    expect(confirmErrorText({ code: -32603, message: 'x' })).toBe('확인 실패');
    expect(confirmErrorText(new Error('끊김'))).toBe('확인 실패');
  });

  it('저장은 제목 · 진술이 공백만이 아니고 하나라도 바뀌었을 때만', () => {
    const draft = { title: RULE.title, statement: RULE.statement };
    expect(canSaveRuleEdit(RULE, draft)).toBe(false);
    expect(canSaveRuleEdit(RULE, { ...draft, title: '새 제목' })).toBe(true);
    expect(canSaveRuleEdit(RULE, { ...draft, statement: `${RULE.statement}.` })).toBe(true);
    expect(canSaveRuleEdit(RULE, { ...draft, title: '  ' })).toBe(false);
    expect(canSaveRuleEdit(RULE, { title: '새 제목', statement: '' })).toBe(false);
  });

  it('요청은 바뀐 칸만, 본 수정 시각 · 사람 주체와 함께', () => {
    expect(
      ruleEditParams(PROJECT_ID, RULE, { title: '새 제목', statement: RULE.statement }),
    ).toEqual({
      projectId: PROJECT_ID,
      id: RULE.id,
      author: { kind: 'human' },
      title: '새 제목',
      expectedUpdatedAt: RULE.updatedAt,
    });
    expect(
      ruleEditParams(PROJECT_ID, RULE, {
        title: RULE.title,
        statement: 'WHEN a THE SYSTEM SHALL b',
      }),
    ).toEqual({
      projectId: PROJECT_ID,
      id: RULE.id,
      author: { kind: 'human' },
      statement: 'WHEN a THE SYSTEM SHALL b',
      expectedUpdatedAt: RULE.updatedAt,
    });
  });

  it('충돌 사유 표시명은 shared의 사유와 키가 같다', () => {
    expect(Object.keys(RULE_EDIT_CONFLICT_LABELS).sort()).toEqual(
      [...RuleEditConflictReason.options].sort(),
    );
  });

  it('오류 문구: 형식(제목 · 진술, 서버 사유 함께) · 변경 없음 · 충돌 사유 · 없음 · 권한 · 그 밖', () => {
    expect(
      ruleEditErrorText({
        code: -32001,
        message: 'x',
        data: { reason: 'RULE_EDIT_INVALID', issues: [{ path: 'statement', message: '사유 A' }] },
      }),
    ).toEqual({ label: '진술 형식 오류', detail: '사유 A' });
    expect(
      ruleEditErrorText({
        code: -32001,
        message: 'x',
        data: {
          reason: 'RULE_EDIT_INVALID',
          issues: [
            { path: 'title', message: '사유 B' },
            { path: 'statement', message: '사유 C' },
          ],
        },
      }),
    ).toEqual({ label: '제목 형식 오류', detail: '사유 B · 사유 C' });
    // 제목 앞뒤 공백 거부도 제목 형식 오류다 (서버 사유 그대로)
    expect(
      ruleEditErrorText({
        code: -32001,
        message: 'x',
        data: {
          reason: 'RULE_EDIT_INVALID',
          issues: [{ path: 'title', message: '제목 앞뒤에 공백을 둘 수 없음' }],
        },
      }),
    ).toEqual({ label: '제목 형식 오류', detail: '제목 앞뒤에 공백을 둘 수 없음' });
    expect(
      ruleEditErrorText({ code: -32001, message: 'x', data: { reason: 'RULE_EDIT_NO_CHANGE' } }),
    ).toEqual({ label: '변경 없음', detail: null });
    for (const reason of RuleEditConflictReason.options) {
      expect(ruleEditErrorText({ code: -32009, message: 'x', data: { reason } })).toEqual({
        label: `규칙 저장 실패 · ${RULE_EDIT_CONFLICT_LABELS[reason]}`,
        detail: null,
      });
    }
    expect(ruleEditErrorText({ code: -32009, message: 'x', data: { reason: '모름' } })).toEqual({
      label: '규칙 저장 실패',
      detail: null,
    });
    expect(ruleEditErrorText({ code: -32004, message: 'x' }).label).toBe(
      '규칙 저장 실패 · 규칙 없음',
    );
    expect(ruleEditErrorText({ code: -32020, message: 'x' }).label).toBe(
      '규칙 저장 실패 · 편집 권한 없음',
    );
    expect(ruleEditErrorText(new Error('x'))).toEqual({ label: '규칙 저장 실패', detail: null });
  });

  it('자동 시작 결과 한 줄: 시작 · 대기 실행 · 생략, 없으면 null. 확인 상태 표시명', () => {
    const runId = '01JE0000000000000000000003';
    expect(ruleEditAutoStartText(null)).toBeNull();
    expect(ruleEditAutoStartText({ state: 'started', runId, runDisplayId: 'EXE-003' })).toBe(
      '실행 자동 시작 · EXE-003',
    );
    expect(ruleEditAutoStartText({ state: 'pending', runId, runDisplayId: 'EXE-002' })).toBe(
      '대기 실행에 반영 · EXE-002',
    );
    expect(
      ruleEditAutoStartText({
        state: 'skipped',
        reason: 'settings_incomplete',
        missing: ['run.maxBudgetUsd'],
      }),
    ).toBe('실행 자동 시작 생략 · 예산 · 모델 미설정');
    expect(confirmationText({ confirmation: { state: 'unconfirmed' } })).toBe('미확인');
    expect(
      confirmationText({
        confirmation: {
          state: 'confirmed',
          at: RULE.updatedAt,
          by: { kind: 'human' },
          basis: { kind: 'approval_log', seq: 1 },
        },
      }),
    ).toBe('확인됨');
  });

  it('목록 항목 바꾸기: 같은 ID만 바꾸고 순서 · 다른 항목은 그대로', () => {
    const judgment = { status: 'unjudged', latest: null } as const;
    const a = { rule: { ...RULE, id: 'a' }, judgment } as never;
    const b = { rule: { ...RULE, id: 'b', title: '옛 제목' }, judgment } as never;
    const edited = { rule: { ...RULE, id: 'b', title: '새 제목' }, judgment } as never;
    expect(replaceRuleItem([a, b], edited)).toEqual([a, edited]);
    expect(replaceRuleItem([a], edited)).toEqual([a]);
  });
});
