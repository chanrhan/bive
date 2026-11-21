// 요구사항 상세의 규칙 작성 상태 표시 규칙 (screens.md SCR-02 상세 · 1.1 · 1.4, NRM-02 · NFR-03, ADR-099).
// DOM · React에 의존하지 않는다 (test/rule-writer-status-view.test.ts).
// - 값은 `ruleWriter.status`(저장된 시도 · 세션 기록)에서만 만든다. 알림 값으로 그리지 않는다
// - 가장 최근 시도만 보인다: 대기 = "규칙 작성 대기", 진행 중 = "규칙 작성 중"(흐림), 생략 = "규칙 작성 생략" + 사유(경고),
//   실패(성공 아닌 종료) = "규칙 작성 실패" + 종료 사유(위험). 정상 종료 · 시도 기록 없음은 아무것도 보이지 않는다(1.1 예외만 강조)
// - 정상 종료 뒤 실행 자동 시작을 하지 않았으면(저장된 생략 기록) "실행 자동 시작 생략" + 사유(경고). 자동 시작한 경우는
//   예외가 아니라 보이지 않는다 (M7-05 #217, ADR-100 B⑤, ADR-107)
// - 생략 · 실패의 설명(오류 문장 표시 값)은 사유와 다를 때만 한 줄 더 보인다(같은 말을 두 번 쓰지 않음)
// - renderer는 shared를 import type으로만 가져오므로 표시명은 여기에 다시 적고, 시험이 shared의 *_LABELS와 대조한다
import type {
  AutoStartSkipReason,
  RuleWriterSkipReason,
  RuleWriterStatusEntry,
  SessionEndReason,
} from '@bive/shared';

/** 세션 종료 사유 표시명 (shared `SESSION_END_REASON_LABELS`와 같음). */
export const END_REASON_LABELS = {
  success: '정상 종료',
  error_max_turns: '턴 한도 초과',
  error_max_budget_usd: '예산 한도 초과',
  error_during_execution: '실행 중 오류',
  aborted: '중단',
  guard_violation: '가드 위반',
} as const satisfies Record<SessionEndReason, string>;

/** 생략 사유 표시명 (shared `RULE_WRITER_SKIP_REASON_LABELS`와 같음). */
export const SKIP_REASON_LABELS = {
  settings_incomplete: '예산 · 모델 미설정',
  closed: '오케스트레이터 종료',
  start_failed: '시작 실패',
  requirement_unavailable: '요구사항 없음',
  project_daily_budget_exceeded: '프로젝트 하루 예산 초과',
} as const satisfies Record<RuleWriterSkipReason, string>;

/** 실행 자동 시작 생략 사유 표시명 (shared `AUTO_START_SKIP_REASON_LABELS`와 같음). */
export const AUTO_START_SKIP_REASON_LABELS = {
  project_daily_budget_unset: '프로젝트 하루 한도 없음',
  project_daily_budget_exceeded: '프로젝트 하루 예산 초과',
  settings_incomplete: '예산 · 모델 미설정',
} as const satisfies Record<AutoStartSkipReason, string>;

export const RULE_WRITER_TEXT = {
  queued: '규칙 작성 대기',
  running: '규칙 작성 중',
  skipped: '규칙 작성 생략',
  failed: '규칙 작성 실패',
  autoStartSkipped: '실행 자동 시작 생략',
} as const;

export type RuleWriterTone = 'muted' | 'warning' | 'danger';

/** 상세에 보일 규칙 작성 상태 한 덩어리. */
export interface RuleWriterStatusView {
  /** `queued` · `running` · `skipped` · `failed` · `autoStartSkipped` */
  kind: keyof typeof RULE_WRITER_TEXT;
  label: string;
  /** 사유 (생략 사유 · 종료 사유 표시명). 대기 · 진행 중이면 `null` */
  reason: string | null;
  /** 설명 (오류 문장 표시 값). 없거나 사유와 같으면 `null` */
  detail: string | null;
  tone: RuleWriterTone;
}

/** 가장 최근 시도 → 표시. 시도 없음(`null`) · 정상 종료(자동 시작 생략이 아닌 것)이면 `null`. */
export const ruleWriterStatusView = (
  entry: RuleWriterStatusEntry | null,
): RuleWriterStatusView | null => {
  if (entry === null) return null;
  const detailOf = (reason: string): string | null =>
    entry.error === null || entry.error === reason ? null : entry.error;
  switch (entry.state) {
    case 'queued':
      return {
        kind: 'queued',
        label: RULE_WRITER_TEXT.queued,
        reason: null,
        detail: null,
        tone: 'muted',
      };
    case 'running':
      return {
        kind: 'running',
        label: RULE_WRITER_TEXT.running,
        reason: null,
        detail: null,
        tone: 'muted',
      };
    case 'skipped': {
      const reason = entry.skipReason === null ? null : SKIP_REASON_LABELS[entry.skipReason];
      return {
        kind: 'skipped',
        label: RULE_WRITER_TEXT.skipped,
        reason,
        detail: reason === null ? entry.error : detailOf(reason),
        tone: 'warning',
      };
    }
    case 'ended': {
      if (entry.endReason === 'success') {
        if (entry.autoStart?.state !== 'skipped') return null;
        return {
          kind: 'autoStartSkipped',
          label: RULE_WRITER_TEXT.autoStartSkipped,
          reason: AUTO_START_SKIP_REASON_LABELS[entry.autoStart.reason],
          detail: null,
          tone: 'warning',
        };
      }
      const reason = entry.endReason === null ? null : END_REASON_LABELS[entry.endReason];
      return {
        kind: 'failed',
        label: RULE_WRITER_TEXT.failed,
        reason,
        detail: reason === null ? entry.error : detailOf(reason),
        tone: 'danger',
      };
    }
  }
};
