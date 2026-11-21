// 검증 화면 표시 규칙 (이슈 #31, screens.md SCR-05 · 1.1, COST-02 · ADR-029 · ADR-072).
// renderer는 shared를 import type으로만 쓰므로 표시명을 다시 적는다. 여기서 shared 원본과 대조한다.
import {
  CODE_OPEN_REASON_LABELS,
  CodeOpenReason,
  CodeOpenSummaryResult,
  RUN_STATUS_LABELS,
  STEP_KIND_LABELS,
  STEP_STATUS_LABELS,
} from '@bive/shared';
import { describe, expect, it } from 'vitest';

import { complianceGroup } from '../src/renderer/src/screens/rules/rulesView.js';
import {
  basisText,
  canResume,
  codeOpenRows,
  COMPLIANCE_FILTER,
  complianceText,
  currentStepOf,
  isResumeUnrecoverable,
  queuedText,
  resumeUnrecoverableText,
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
      'queued',
      'running',
      'merged',
      'failed',
      'budget_exceeded',
    ] as const) {
      expect(canResume(status), status).toBe(false);
    }
  });

  it('실행 대기는 "실행 대기"이고 현재 단계가 없다(다음에 시작할 단계를 현재 단계로 보이지 않음), 그 밖은 저장된 현재 단계 (ADR-105)', () => {
    expect(RUN_STATUS_TEXT.queued).toBe('실행 대기');
    expect(currentStepOf({ status: 'queued', currentStep: 'test_writing' })).toBeNull();
    expect(currentStepOf({ status: 'running', currentStep: 'test_writing' })).toBe('test_writing');
    expect(currentStepOf({ status: 'waiting_approval', currentStep: 'approval' })).toBe('approval');
    expect(currentStepOf({ status: 'merged', currentStep: null })).toBeNull();
    // 보이는 실행 밖의 실행 대기 건수: 0이면 보이지 않음
    expect(queuedText(0)).toBeNull();
    expect(queuedText(2)).toBe('실행 대기 2');
    // 재개할 수 없어 실패로 끝난 거부만 따로 (그 밖의 거부는 "재개 실패")
    expect(
      isResumeUnrecoverable({
        code: -32009,
        message: 'x',
        data: { reason: 'resume_unrecoverable' },
      }),
    ).toBe(true);
    expect(isResumeUnrecoverable({ code: -32009, message: 'x' })).toBe(false);
    expect(isResumeUnrecoverable({ code: -32009, data: { reason: 'other' } })).toBe(false);
    expect(isResumeUnrecoverable(null)).toBe(false);
    expect(resumeUnrecoverableText('EXE-001')).toBe('EXE-001 재개 불가 · 실패 처리');
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

describe('코드 열람 영역 (M2-02, ADR-088)', () => {
  const summary = (screenError: number, infoLacking: number, debugging: number) =>
    CodeOpenSummaryResult.parse({
      reasons: [
        { reason: 'screen_error', count: screenError },
        { reason: 'info_lacking', count: infoLacking },
        { reason: 'debugging', count: debugging },
      ],
      total: screenError + infoLacking + debugging,
    });

  it('기록이 하나도 없으면 null (영역 값 "없음")', () => {
    expect(codeOpenRows(summary(0, 0, 0))).toBeNull();
  });

  it('기록이 있으면 사유 3종을 화면 오류 · 정보 부족 · 디버깅 순서로, 0건도 0으로', () => {
    expect(codeOpenRows(summary(0, 0, 1))).toEqual([
      { reason: 'screen_error', label: '화면 오류', count: 0 },
      { reason: 'info_lacking', label: '정보 부족', count: 0 },
      { reason: 'debugging', label: '디버깅', count: 1 },
    ]);
  });

  it('표시명 · 순서가 shared의 사유 열거형 · 표시명과 같다', () => {
    const rows = codeOpenRows(summary(2, 3, 4)) ?? [];
    expect(rows.map((r) => r.reason)).toEqual(CodeOpenReason.options);
    expect(rows.map((r) => r.label)).toEqual(
      CodeOpenReason.options.map((reason) => CODE_OPEN_REASON_LABELS[reason]),
    );
    expect(rows.map((r) => r.count)).toEqual([2, 3, 4]);
  });
});
