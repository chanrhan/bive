// 검증 화면 표시 규칙 (이슈 #31, screens.md SCR-05 · 1.1, COST-02 · ADR-029 · ADR-072).
// renderer는 shared를 import type으로만 쓰므로 표시명을 다시 적는다. 여기서 shared 원본과 대조한다.
import { RUN_STATUS_LABELS, STEP_KIND_LABELS, STEP_STATUS_LABELS } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { complianceGroup } from '../src/renderer/src/screens/rules/rulesView.js';
import {
  basisText,
  canResume,
  COMPLIANCE_FILTER,
  complianceText,
  formatTurns,
  formatUsd,
  RUN_STATUS_TEXT,
  runLinkParts,
  STEP_LABELS,
  STEP_STATUS_TEXT,
} from '../src/renderer/src/screens/verification/verificationView.js';

describe('표시명', () => {
  it('단계 · 단계 상태 · 실행 상태 표시명이 shared와 같다', () => {
    expect(STEP_LABELS).toEqual(STEP_KIND_LABELS);
    expect(STEP_STATUS_TEXT).toEqual(STEP_STATUS_LABELS);
    expect(RUN_STATUS_TEXT).toEqual(RUN_STATUS_LABELS);
  });
});

describe('값 표시', () => {
  it('머리줄은 "판정 기준 <브랜치>@<커밋 7자>", 없으면 "판정 기준 없음"', () => {
    expect(
      basisText({
        branch: 'main',
        commit: `a1f26b1${'0'.repeat(33)}`,
        runId: '01JE0000000000000000000001',
      }),
    ).toBe('판정 기준 main@a1f26b1');
    expect(basisText(null)).toBe('판정 기준 없음');
  });

  it('비용 · 턴은 값이 없으면 "없음"이고 0은 0으로 보인다', () => {
    expect(formatUsd(null)).toBe('없음');
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.2)).toBe('$0.20');
    expect(formatUsd(12.345)).toBe('$12.35');
    expect(formatUsd(0.0012345)).toBe('$0.0012');
    // 아주 작은 값도 지수 표기가 아니라 고정 소수
    expect(formatUsd(5e-7)).toBe('$0.0000005');
    expect(formatUsd(1.234e-8)).toBe('$0.000000012');
    expect(formatUsd(0.001)).toBe('$0.001');
    expect(formatTurns(null)).toBe('없음');
    expect(formatTurns(0)).toBe('0턴');
    expect(formatTurns(14)).toBe('14턴');
    expect(
      runLinkParts({
        id: '01JE0000000000000000000001',
        displayId: 'EXE-001',
        costUsd: null,
        turns: null,
      }),
    ).toEqual({ id: 'EXE-001', cost: '없음', turns: '없음' });
  });

  it('준수는 "통과 / 판정 가능", 판정 가능이 0이면 "없음"', () => {
    expect(complianceText({ passed: 3, judgeable: 4 })).toBe('3 / 4');
    expect(complianceText({ passed: 0, judgeable: 4 })).toBe('0 / 4');
    expect(complianceText({ passed: 0, judgeable: 0 })).toBe('없음');
  });

  it('[재개]는 중단된 실행만', () => {
    expect(canResume('interrupted')).toBe(true);
    for (const status of [
      'waiting_approval',
      'running',
      'merged',
      'failed',
      'budget_exceeded',
    ] as const) {
      expect(canResume(status), status).toBe(false);
    }
  });

  it('준수 카드의 필터는 규칙 목록 준수 집계 기준의 "판정 가능" 값 하나만 고른다', () => {
    expect(COMPLIANCE_FILTER).toEqual({
      query: '',
      selected: { compliance: ['judgeable'] },
      problemOnly: false,
    });
    // 규칙 목록 필터의 값 이름과 같다 (rulesView.ts complianceGroup)
    const value = complianceGroup({
      rule: { normState: 'approved' },
      judgment: { status: 'pass' },
    } as Parameters<typeof complianceGroup>[0]);
    expect(COMPLIANCE_FILTER.selected['compliance']).toEqual([value]);
  });
});
