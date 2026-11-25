// 규칙 상세 "실행 이력"의 줄 (screens.md SCR-03 상세 "실행 이력", M3-35 #263, ADR-123). DOM · React에 의존하지 않는다
// (test/rule-detail-view.test.ts · test/run-failure-reason.test.ts).
// - 한 줄 = 실행 하나. 그 규칙을 대상으로 한 실행(`run.list`의 `targetRuleIds`)과 그 규칙의 판정 기록을 남긴 실행(`judgment.list`의
//   실행 표시 ID)을 합친다. 한 실행의 판정이 여럿(검사 · 병합 재검사)이면 가장 최근 판정 하나를 그 줄에 싣는다
// - 판정 기록 없이 끝난 실행(예: Red 확인에서 실패)도 줄이 있다. 실행 상태와 종료 사유(표시명)를 함께 보인다
// - 실행을 알 수 없는 판정 기록(실행 표시 ID 없음)은 판정 하나가 한 줄이다
// - 종료 사유는 shared `RUN_FAILURE_REASON_LABELS`를 다시 적은 표로 그리고(시험이 대조), 표에 없는 옛 값은 "알 수 없는 사유"다.
//   사유의 상세(단계 결과 `exitDetail`)는 이 줄에 싣지 않는다(`run.list`에 없고, 에이전트 · 판정 출력에서 온 글이 섞일 수 있다)
// - 값은 `judgment.list` · `run.list` 응답에서만 만든다(NFR-03)
import type {
  JudgmentResult,
  Run,
  RunFailureReason,
  RunStatus,
  RuleJudgmentEntry,
} from '@bive/shared';

import { formatCardTime } from '../../components/Card2Line/time.js';
import { RUN_STATUS_TEXT } from '../verification/verificationView.js';

/** 실행 종료 사유 표시명 (shared `RUN_FAILURE_REASON_LABELS`와 같음, 시험이 대조). */
export const RUN_FAILURE_REASON_TEXT = {
  guard_violation: '가드 위반',
  regression_limit: '회귀 상한 초과',
  test_retry_limit: '테스트 작성 재시도 상한 초과',
  step_unmet: '단계 종료 조건 미충족',
  step_executor_missing: '단계 실행기 없음',
  step_error: '단계 실행 오류',
  worktree_error: '작업 트리 오류',
  run_without_log: '실행 시작 기록 없음',
  settings_missing: '예산 · 모델 기록 없음',
  merge_missing: '병합 커밋 없음',
  state_inconsistent: '실행 상태 불일치',
  budget_exhausted: '실행 예산 소진',
  project_daily_budget_exceeded: '프로젝트 하루 예산 초과',
  error_max_budget_usd: '세션 예산 한도 초과',
  error_max_turns: '세션 턴 한도 초과',
  budget_aggregate_exceeded: '사용량 합계 한도 초과',
  objection_applied: '이의 반영',
  existing_rule_contradiction: '기존 규칙 모순',
  target_rule_retired: '대상 규칙 폐기',
  target_rule_unavailable: '대상 규칙 효력 없음',
  judge_runner_error: '판정 실행기 오류',
  block_declaration_overlap: '블록 선언 겹침',
  dependency_install_failed: '의존성 설치 실패',
  acceptance_ignored: '인수 테스트 무시 규칙 걸림',
  project_daily_budget_unset: '프로젝트 하루 한도 없음',
  settings_incomplete: '예산 · 모델 미설정',
  branch_missing: '실행 브랜치 없음',
  run_worktree_dirty: '실행 작업 트리 미커밋 변경',
  project_dirty: '프로젝트 폴더 미커밋 변경',
  base_branch_missing: '기준 브랜치 없음',
  base_checked_out_elsewhere: '기준 브랜치 다른 작업 트리 사용 중',
  no_changes: '병합할 변경 없음',
  conflict: '병합 충돌',
  ignored_path_tracked: '무시 규칙 경로 추적',
  unchecked_tree_mismatch: '병합 트리 불일치',
  check_failed: '병합 재검사 실패',
  check_error: '병합 재검사 오류',
  check_timeout: '병합 재검사 시간 초과',
  aborted: '병합 중단',
  base_changed: '병합 중 기준 브랜치 변경',
  vetoed: '병합 직전 거부',
  base_update_failed: '기준 브랜치 갱신 실패',
  git_error: 'git 오류',
} as const satisfies Record<RunFailureReason, string>;

/** 표에 없는 종료 사유(옛 행 · 새 값)의 표시. 저장된 영어 값을 그대로 보이지 않는다. */
export const UNKNOWN_FAILURE_REASON_TEXT = '알 수 없는 사유';

/** 종료 사유 값 → 표시명. 표에 없으면 "알 수 없는 사유". */
export const runFailureReasonText = (reason: string): string =>
  Object.hasOwn(RUN_FAILURE_REASON_TEXT, reason)
    ? RUN_FAILURE_REASON_TEXT[reason as RunFailureReason]
    : UNKNOWN_FAILURE_REASON_TEXT;

/** 실행 상태 + 종료 사유: "실패 · 기존 규칙 모순". 사유는 실패 · 예산 초과로 끝난 실행에만 붙인다. */
export const runStatusText = (run: Pick<Run, 'status' | 'failureReason'>): string => {
  const status = RUN_STATUS_TEXT[run.status];
  const ended: readonly RunStatus[] = ['failed', 'budget_exceeded'];
  return ended.includes(run.status) && run.failureReason !== null
    ? `${status} · ${runFailureReasonText(run.failureReason)}`
    : status;
};

/** 실행 이력 한 줄. */
export interface RunHistoryRow {
  readonly key: string;
  /** 줄 시각 (ISO): 그 실행의 가장 최근 판정 시각, 판정이 없으면 실행의 끝 · 시작 · 생성 시각 */
  readonly at: string;
  readonly time: string;
  readonly runDisplayId: string | null;
  /** 이 규칙의 그 실행 안 가장 최근 판정. 없으면 null */
  readonly judgment: JudgmentResult | null;
  /** 실행 상태 · 종료 사유 글. 실행을 모르면(`run.list`를 못 읽음 · 목록에 없음) null */
  readonly status: string | null;
}

const timeOf = (iso: string): number => {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
};

const runAt = (run: Run): string => run.endedAt ?? run.startedAt ?? run.createdAt;

/**
 * 실행 이력 줄 (최신부터). `runs`가 null이면(`run.list`를 못 읽음) 판정 기록만으로 실행마다 한 줄을 만든다(상태 글 없음).
 * 시각이 같으면 판정 기록 순서(서버의 최신부터) 다음 실행 목록의 나중 것부터다.
 */
export const runHistoryRows = (
  ruleId: string,
  judgments: readonly RuleJudgmentEntry[],
  runs: readonly Run[] | null,
): RunHistoryRow[] => {
  const byDisplayId = new Map((runs ?? []).map((run) => [run.displayId, run]));
  const rows: (RunHistoryRow & { order: number })[] = [];
  const seen = new Map<string, number>();
  let order = 0;
  for (const { judgment, runDisplayId } of judgments) {
    order += 1;
    if (runDisplayId === null) {
      rows.push({
        key: `judgment:${judgment.id}`,
        at: judgment.judgedAt,
        time: formatCardTime(judgment.judgedAt) ?? judgment.judgedAt,
        runDisplayId: null,
        judgment,
        status: null,
        order,
      });
      continue;
    }
    const index = seen.get(runDisplayId);
    const current = index === undefined ? undefined : rows[index];
    if (
      current !== undefined &&
      current.judgment !== null &&
      timeOf(current.judgment.judgedAt) >= timeOf(judgment.judgedAt)
    ) {
      continue;
    }
    const run = byDisplayId.get(runDisplayId);
    const row = {
      key: `run:${runDisplayId}`,
      at: judgment.judgedAt,
      time: formatCardTime(judgment.judgedAt) ?? judgment.judgedAt,
      runDisplayId,
      judgment,
      status: run === undefined ? null : runStatusText(run),
      order: current?.order ?? order,
    };
    if (index === undefined) {
      seen.set(runDisplayId, rows.length);
      rows.push(row);
    } else {
      rows[index] = row;
    }
  }
  for (const run of runs ?? []) {
    order += 1;
    if (seen.has(run.displayId) || !run.targetRuleIds.includes(ruleId)) continue;
    const at = runAt(run);
    seen.set(run.displayId, rows.length);
    rows.push({
      key: `run:${run.displayId}`,
      at,
      time: formatCardTime(at) ?? at,
      runDisplayId: run.displayId,
      judgment: null,
      status: runStatusText(run),
      order: -order,
    });
  }
  return rows
    .sort((a, b) => timeOf(b.at) - timeOf(a.at) || a.order - b.order)
    .map((row) => ({
      key: row.key,
      at: row.at,
      time: row.time,
      runDisplayId: row.runDisplayId,
      judgment: row.judgment,
      status: row.status,
    }));
};
