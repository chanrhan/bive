// 실행 시작 확인의 문구 · 오류 해석 (이슈 #32 수용 기준 2, screens.md SCR-03 · 1.1, NFR-07, ADR-076).
// renderer는 shared를 import type으로만 쓰므로 값을 다시 적는다. 여기서 shared 원본과 대조한다.
import { ErrorCode, SETTINGS_INCOMPLETE_MESSAGE } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  RUN_START_TEXT,
  runStartErrorText,
  SETTINGS_INCOMPLETE_CODE,
} from '../src/renderer/src/screens/rules/runStartView.js';

describe('실행 시작 확인 문구', () => {
  it('설정 미비 코드 · 문구가 shared와 같다', () => {
    expect(SETTINGS_INCOMPLETE_CODE).toBe(ErrorCode.SettingsIncomplete);
    expect(RUN_START_TEXT.settingsIncomplete).toBe(SETTINGS_INCOMPLETE_MESSAGE);
  });

  it('-32010은 "예산 · 모델 미설정", 그 밖 오류는 "실행 시작 실패"', () => {
    expect(
      runStartErrorText({
        code: -32010,
        message: '예산 · 모델 미설정',
        data: { reason: 'SETTINGS_INCOMPLETE', missing: ['budget.run.maxBudgetUsd'] },
      }),
    ).toBe('예산 · 모델 미설정');
    expect(runStartErrorText({ code: -32009, message: '삭제된 규칙' })).toBe('실행 시작 실패');
    expect(runStartErrorText({ code: -32603, message: '연결 끊김' })).toBe('실행 시작 실패');
    expect(runStartErrorText(new Error('x'))).toBe('실행 시작 실패');
    expect(runStartErrorText(undefined)).toBe('실행 시작 실패');
  });

  it('문구는 명사형 · 이모지 · 코드 표기 없음 (screens.md 1.1)', () => {
    for (const text of Object.values(RUN_START_TEXT)) {
      expect(text).not.toMatch(/[.!?]$/);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/\b(SCR|RUN|NFR|ADR)-\d+/);
    }
  });
});
