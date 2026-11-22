// 규칙 상세의 변경 이력 줄 (M7-15 #227, SCR-06 · NRM-07, ADR-100 D5 · C2 · ADR-114).
import {
  NORM_CHANGE_KIND_LABELS,
  type NormChangeView,
  type NormJudgmentDetail,
} from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  NORM_CHANGE_KIND_TEXT,
  normChangeRow,
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
});
