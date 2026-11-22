// 규칙 상세의 변경 이력 줄 (M7-15 #227, SCR-06 · NRM-07, ADR-100 D5 · C2 · ADR-114).
import {
  NORM_CHANGE_KIND_LABELS,
  NORM_JUDGMENT_SUBJECT_LABELS,
  NORM_JUDGMENT_VERDICT_LABELS,
  NORM_UNDECIDED_REASON_LABELS,
  type NormChangeView,
  type NormJudgmentDetail,
} from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  JUDGMENT_SUBJECT_TEXT,
  JUDGMENT_VERDICT_TEXT,
  NORM_CHANGE_KIND_TEXT,
  normChangeRow,
  UNDECIDED_REASON_TEXT,
} from '../src/renderer/src/screens/norm-detail/normChangeView.js';

const HASH = 'a'.repeat(64);
const AT = '2026-11-22T03:00:00.000Z';
const OLD = { id: '01JC0000000000000000000001', displayId: 'RULE-001' } as const;
const NEW = { id: '01JC0000000000000000000004', displayId: 'RULE-004' } as const;

const entry = (patch: Partial<NormChangeView> & Pick<NormChangeView, 'kind'>): NormChangeView => ({
  seq: 1,
  at: AT,
  actor: { kind: 'agent', role: 'rule-writer' },
  targetRef: { entity: 'Rule', id: NEW.id },
  sessionId: '01JS0000000000000000000001',
  runId: null,
  reason: '요구사항의 문장을 규칙으로 옮김',
  detail: {},
  textTruncated: false,
  prevHash: HASH,
  hash: HASH,
  ...patch,
});

describe('normChangeRow', () => {
  it('종류 표시명은 shared와 같다', () => {
    expect(NORM_CHANGE_KIND_TEXT).toEqual(NORM_CHANGE_KIND_LABELS);
  });

  it('신규: 종류 · 주체(에이전트 · 역할명) · 사유, 판단 대상 없음', () => {
    const row = normChangeRow(entry({ kind: 'created' }));
    expect(row).toMatchObject({
      seq: 1,
      kind: '신규',
      actor: '에이전트 · 규칙 작성',
      subject: null,
      text: { label: '사유', value: '요구사항의 문장을 규칙으로 옮김' },
      truncated: false,
    });
    expect(row.time).toMatch(/^2026-11-22 \d\d:00$/);
  });

  it('판단: 모순이면 대상 규칙 목록, 모순 없음이면 대상 없이. 글은 근거', () => {
    const judgment: NormJudgmentDetail = {
      subject: 'supersede',
      verdict: 'contradiction',
      contradicts: [OLD],
      createdSeq: 4,
      input: { requirements: { total: 2, included: 2 }, rules: { total: 3, included: 3 } },
    };
    expect(
      normChangeRow(entry({ kind: 'judgment', reason: '근거 글', detail: { judgment } })),
    ).toMatchObject({
      kind: '판단',
      subject: { label: '모순', rules: [OLD] },
      text: { label: '근거', value: '근거 글' },
    });
    expect(
      normChangeRow(
        entry({
          kind: 'judgment',
          detail: {
            judgment: {
              ...judgment,
              subject: 'new_rule',
              verdict: 'no_contradiction',
              contradicts: [],
            },
          },
        }),
      ).subject,
    ).toEqual({ label: '모순 없음', rules: [] });
  });

  it('대체: 대체 규칙이 대상, 폐기만: 대상 없음. 둘 다 글은 근거, 잘렸으면 표시', () => {
    expect(
      normChangeRow(
        entry({
          kind: 'superseded',
          targetRef: { entity: 'Rule', id: OLD.id },
          detail: { retirement: { supersededBy: NEW, createdSeq: 4, judgmentSeq: 5 } },
          textTruncated: true,
        }),
      ),
    ).toMatchObject({
      kind: '대체',
      subject: { label: '대체 규칙', rules: [NEW] },
      text: { label: '근거' },
      truncated: true,
    });
    expect(
      normChangeRow(entry({ kind: 'retired', detail: { retirement: { supersededBy: null } } })),
    ).toMatchObject({ kind: '폐기', subject: null, text: { label: '근거' } });
  });

  it('오케스트레이터 주체 · 사유 없음', () => {
    expect(
      normChangeRow(
        entry({
          kind: 'auto_start',
          actor: { kind: 'orchestrator' },
          sessionId: null,
          reason: null,
        }),
      ),
    ).toMatchObject({ kind: '자동 시작', actor: '오케스트레이터', text: null });
  });

  it('판단 주제 · 결과 · 판단 없음 사정의 표시명은 shared와 같다 (M7-11, ADR-115)', () => {
    expect(JUDGMENT_SUBJECT_TEXT).toEqual(NORM_JUDGMENT_SUBJECT_LABELS);
    expect(JUDGMENT_VERDICT_TEXT).toEqual(NORM_JUDGMENT_VERDICT_LABELS);
    expect(UNDECIDED_REASON_TEXT).toEqual(NORM_UNDECIDED_REASON_LABELS);
  });

  it('이의 판단: 유지 · 폐기 · 대체는 "이의 판단 · 결과", 판단 없음은 사정의 표시명을 덧붙이고, 모르는 값은 날 값을 내지 않는다', () => {
    const objection = (judgment: Partial<NormJudgmentDetail>, actor = 'agent') =>
      normChangeRow(
        entry({
          kind: 'judgment',
          ...(actor === 'agent' ? {} : { actor: { kind: 'orchestrator' }, sessionId: null }),
          runId: '01JR0000000000000000000001',
          reason: '근거 글',
          detail: {
            judgment: {
              subject: 'objection',
              verdict: 'upheld',
              contradicts: [],
              causeSeq: 3,
              input: { requirements: { total: 1, included: 1 }, rules: { total: 1, included: 1 } },
              ...judgment,
            } as NormJudgmentDetail,
          },
        }),
      );
    expect(objection({}).subject).toEqual({ label: '이의 판단 · 유지', rules: [] });
    expect(objection({ verdict: 'retired' }).subject).toEqual({
      label: '이의 판단 · 폐기',
      rules: [],
    });
    expect(objection({ verdict: 'superseded', createdSeq: 4 }).subject).toEqual({
      label: '이의 판단 · 대체',
      rules: [],
    });
    // 폐기 판단이 "모순 없음"으로 보이지 않는다
    for (const verdict of ['upheld', 'retired', 'superseded'] as const) {
      expect(objection({ verdict }).subject?.label).not.toContain('모순');
    }
    const undecided = objection({ undecided: { endReason: 'error_max_turns' } }, 'orchestrator');
    expect(undecided).toMatchObject({
      kind: '판단',
      actor: '오케스트레이터',
      subject: { label: '이의 판단 · 유지 · 판단 없음 (턴 한도 초과)', rules: [] },
      text: { label: '근거' },
    });
    expect(
      objection({ undecided: { endReason: 'interrupted' } }, 'orchestrator').subject?.label,
    ).toBe('이의 판단 · 유지 · 판단 없음 (오케스트레이터 재기동)');
    // 모르는 사정 · 결과 · 주제는 "알 수 없음"으로 (영문 날 값을 그리지 않는다)
    const unknown = objection({ undecided: { endReason: 'future_reason' } }, 'orchestrator');
    expect(unknown.subject?.label).toBe('이의 판단 · 유지 · 판단 없음 (알 수 없음)');
    expect(unknown.subject?.label).not.toMatch(/[a-z_]{4,}/);
    expect(objection({ verdict: 'future' as NormJudgmentDetail['verdict'] }).subject?.label).toBe(
      '이의 판단 · 알 수 없음',
    );
    expect(objection({ subject: 'future' as NormJudgmentDetail['subject'] }).subject?.label).toBe(
      '알 수 없음',
    );
  });

  it('요구사항 변경 판단 (M7-10, ADR-116): "요구사항 변경 판단 · 결과", 판단 없음은 사정의 표시명을 덧붙인다', () => {
    const change = (judgment: Partial<NormJudgmentDetail>, actor = 'agent') =>
      normChangeRow(
        entry({
          kind: 'judgment',
          ...(actor === 'agent' ? {} : { actor: { kind: 'orchestrator' }, sessionId: null }),
          reason: '근거 글',
          detail: {
            judgment: {
              subject: 'requirement_change',
              verdict: 'upheld',
              contradicts: [],
              requirementChange: {
                requirement: { id: '01JR0000000000000000000002', displayId: 'REQ-001' },
                change: 'deleted',
                at: '2026-11-22T00:00:00.000Z',
                textHash: 'a'.repeat(64),
              },
              input: { requirements: { total: 1, included: 1 }, rules: { total: 1, included: 1 } },
              ...judgment,
            } as NormJudgmentDetail,
          },
        }),
      );
    expect(change({}).subject).toEqual({ label: '요구사항 변경 판단 · 유지', rules: [] });
    expect(change({ verdict: 'retired' }).subject?.label).toBe('요구사항 변경 판단 · 폐기');
    expect(change({ verdict: 'superseded', createdSeq: 2 }).subject?.label).toBe(
      '요구사항 변경 판단 · 대체',
    );
    expect(
      change({ undecided: { endReason: 'project_daily_budget_exceeded' } }, 'orchestrator'),
    ).toMatchObject({
      actor: '오케스트레이터',
      subject: { label: '요구사항 변경 판단 · 유지 · 판단 없음 (프로젝트 하루 예산 초과)' },
    });
    expect(change({ undecided: { endReason: 'aborted' } }, 'orchestrator').subject?.label).toBe(
      '요구사항 변경 판단 · 유지 · 판단 없음 (중단)',
    );
  });
});
