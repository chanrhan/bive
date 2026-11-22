// 요구사항 상세의 규칙 작성 상태 표시 규칙 (M3-26 #206, SCR-02 상세 · 1.1, ADR-099).
// 화면에서 실제로 보이는지 · 알림으로 다시 읽는지는 e2e/rule-writer-status.spec.ts.
import {
  AUTO_START_SKIP_REASON_LABELS as SHARED_AUTO_START_SKIP_REASON_LABELS,
  RULE_WRITER_SKIP_REASON_LABELS,
  type RuleWriterStatusEntry,
  SESSION_END_REASON_LABELS,
} from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  AUTO_START_SKIP_REASON_LABELS,
  END_REASON_LABELS,
  RULE_WRITER_TEXT,
  ruleWriterStatusView,
  SKIP_REASON_LABELS,
} from '../src/renderer/src/screens/norm-detail/ruleWriterStatusView.js';

const entry = (overrides: Partial<RuleWriterStatusEntry> = {}): RuleWriterStatusEntry => ({
  requirementId: '01JB0000000000000000000001',
  attemptId: '01JB0000000000000000000009',
  state: 'ended',
  skipReason: null,
  missing: [],
  endReason: 'success',
  error: null,
  errorTruncated: false,
  requestedAt: '2026-11-21T00:00:00.000Z',
  endedAt: '2026-11-21T00:00:01.000Z',
  autoStart: null,
  ...overrides,
});

describe('ruleWriterStatusView', () => {
  it('표시명이 shared와 같다 (종료 사유 · 생략 사유)', () => {
    expect(END_REASON_LABELS).toEqual(SESSION_END_REASON_LABELS);
    expect(SKIP_REASON_LABELS).toEqual(RULE_WRITER_SKIP_REASON_LABELS);
    expect(AUTO_START_SKIP_REASON_LABELS).toEqual(SHARED_AUTO_START_SKIP_REASON_LABELS);
  });

  it('기록 없음 · 정상 종료는 보이지 않는다', () => {
    expect(ruleWriterStatusView(null)).toBeNull();
    expect(ruleWriterStatusView(entry())).toBeNull();
  });

  it('대기 · 진행 중은 흐린 글자, 사유 · 설명 없음', () => {
    expect(ruleWriterStatusView(entry({ state: 'queued', endReason: null }))).toEqual({
      kind: 'queued',
      label: '규칙 작성 대기',
      reason: null,
      detail: null,
      tone: 'muted',
    });
    expect(ruleWriterStatusView(entry({ state: 'running', endReason: null }))).toMatchObject({
      kind: 'running',
      label: '규칙 작성 중',
      tone: 'muted',
    });
  });

  it('실패는 위험 색과 종료 사유 표시명, 설명은 오류 문장 표시 값', () => {
    expect(
      ruleWriterStatusView(
        entry({
          endReason: 'guard_violation',
          error: '세션 가드: 허용되지 않은 플러그인 cc-plugin-agents-md',
        }),
      ),
    ).toEqual({
      kind: 'failed',
      label: '규칙 작성 실패',
      reason: '가드 위반',
      detail: '세션 가드: 허용되지 않은 플러그인 cc-plugin-agents-md',
      tone: 'danger',
    });
    expect(ruleWriterStatusView(entry({ endReason: 'aborted', error: null }))).toMatchObject({
      reason: '중단',
      detail: null,
    });
  });

  it('생략은 경고 색과 생략 사유 표시명, 설명이 사유와 같으면 한 번만', () => {
    expect(
      ruleWriterStatusView(
        entry({
          state: 'skipped',
          endReason: null,
          skipReason: 'settings_incomplete',
          missing: ['roles.rule-writer.model'],
          error: '예산 · 모델 미설정',
        }),
      ),
    ).toEqual({
      kind: 'skipped',
      label: '규칙 작성 생략',
      reason: '예산 · 모델 미설정',
      detail: null,
      tone: 'warning',
    });
    expect(
      ruleWriterStatusView(
        entry({
          state: 'skipped',
          endReason: null,
          skipReason: 'requirement_unavailable',
          error: '요구사항 삭제됨 (2026-11-21T00:00:00.000Z)',
        }),
      ),
    ).toMatchObject({
      reason: '요구사항 없음',
      detail: '요구사항 삭제됨 (2026-11-21T00:00:00.000Z)',
    });
  });

  it('정상 종료 뒤 실행 자동 시작을 하지 않았으면 경고 색과 생략 사유 표시명, 자동 시작했으면 보이지 않는다 (M7-05, ADR-107)', () => {
    expect(
      ruleWriterStatusView(
        entry({
          autoStart: { state: 'skipped', reason: 'project_daily_budget_unset', missing: [] },
        }),
      ),
    ).toEqual({
      kind: 'autoStartSkipped',
      label: '실행 자동 시작 생략',
      reason: '프로젝트 하루 한도 없음',
      detail: null,
      tone: 'warning',
    });
    expect(
      ruleWriterStatusView(
        entry({
          autoStart: {
            state: 'skipped',
            reason: 'settings_incomplete',
            missing: ['roles.implementer.model'],
          },
        }),
      ),
    ).toMatchObject({ reason: '예산 · 모델 미설정', tone: 'warning' });
    expect(
      ruleWriterStatusView(
        entry({
          autoStart: {
            state: 'started',
            runId: '01JB0000000000000000000010',
            runDisplayId: 'EXE-001',
          },
        }),
      ),
    ).toBeNull();
    // 생략 기록은 정상 종료한 시도에만 뜻이 있다: 실패한 시도는 실패를 보인다
    expect(
      ruleWriterStatusView(
        entry({
          endReason: 'error_max_turns',
          autoStart: { state: 'skipped', reason: 'project_daily_budget_unset', missing: [] },
        }),
      ),
    ).toMatchObject({ kind: 'failed', reason: '턴 한도 초과' });
  });

  it('문구는 명사형 · 코드 표기 없음 (1.1)', () => {
    for (const text of [
      ...Object.values(RULE_WRITER_TEXT),
      ...Object.values(SKIP_REASON_LABELS),
      ...Object.values(AUTO_START_SKIP_REASON_LABELS),
      ...Object.values(END_REASON_LABELS),
    ]) {
      expect(text).not.toMatch(/[A-Z]{2,}-\d|\p{Extended_Pictographic}|[.!?]$|다$/u);
    }
  });
});
