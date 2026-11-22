// 검증 화면의 표시 규칙 (screens.md SCR-05 · 1.1, JDG-03 · COST-02, ADR-011 · ADR-029 · ADR-035 · ADR-072).
// DOM · React에 의존하지 않는다 (test/verification-view.test.ts).
// - 값은 `verification.summary` 결과에서만 만든다(NFR-03). 값이 없으면 '없음'(0 표시 금지, COST-02 · ADR-029)
// - renderer는 shared를 import type으로만 가져오므로(architecture.md 2장) 표시명을 다시 적고 단위 테스트가 대조한다
// - 지표 카드는 준수(전체 기준 · 사람 확인 기준) · 에이전트 폐기 규칙 · 실행당 비용 (ADR-100 D7 · B⑦, ADR-117).
//   잠정 · 변이 · 규칙화 불가 · 추적성 결함 카드는 기능 이슈 전까지 미노출 (ADR-035, 잠정 카드 자리는 폐기 규칙 카드가 대신한다)
// - 코드 열람 영역 = `codeOpen.summary`의 사유별 건수. 기록이 하나도 없으면 '없음' (MET-01, M2-02 · ADR-088)
import type {
  CodeOpenReason,
  CodeOpenSummaryResult,
  RunStatus,
  StepKind,
  StepStatus,
  VerificationBasis,
  VerificationRunLink,
  VerificationSummaryResult,
} from '@bive/shared';

import { CODE_OPEN_REASON_LABELS } from '../../components/CodeLink/codeLinkView.js';
import type { FilterState } from '../../components/ListView/filter.js';

/** 화면 문구 (screens.md 1.1: 명사형 · 짧은 문구). */
export const TEXT = {
  basisPrefix: '판정 기준',
  none: '없음',
  metrics: '지표',
  compliance: '준수',
  complianceHint: '통과 / 판정 가능',
  /** 준수의 두 기준 (ADR-100 D7 · 명세 변경 목록 SCR-05 "전체 기준과 사람 확인 기준", ADR-117) */
  complianceAll: '전체 기준',
  complianceConfirmed: '사람 확인 기준',
  complianceConfirmedHint: '통과 / 판정 가능 · 확인됨 규칙만',
  /** 에이전트가 폐기한 규칙 수 카드 (ADR-100 B⑦ · 명세 변경 목록 SCR-05, ADR-117) */
  agentRetired: '에이전트 폐기 규칙',
  agentRetiredHint: '폐기 · 대체 누적',
  costPerRun: '실행당 비용',
  pipeline: '파이프라인',
  noRun: '실행 없음',
  resume: '재개',
  resumeFailed: '재개 실패',
  /** 재개할 수 없어 실행이 실패로 끝남 (앞에 표시 ID, ADR-105) */
  resumeUnrecoverable: '재개 불가 · 실패 처리',
  /** 재개할 수 없지만 이미 병합된 실행이라 병합 완료로 끝남 (앞에 표시 ID, ADR-105) */
  resumeUnrecoverableMerged: '재개 불가 · 병합 완료',
  rules: '규칙별 최신 판정',
  noRules: '규칙 없음',
  turnsSuffix: '턴',
  loadFailed: '검증 불러오기 실패',
  codeOpen: '코드 열람',
  codeOpenHint: '링크 경유 열기 시도 수 · 링크 밖 열람 미집계',
  codeOpenLoadFailed: '코드 열람 불러오기 실패',
  noProject: '프로젝트 없음',
} as const;

/** 단계 이름 (shared STEP_KIND_LABELS와 같음). */
export const STEP_LABELS = {
  approval: '승인',
  test_writing: '테스트 작성',
  red_check: 'Red 확인',
  green_check: 'Green 확인',
  implementation: '구현',
  check: '검사',
  mutation: '변이 주입',
  merge: '병합',
  screen_update: '화면 갱신',
} as const satisfies Record<StepKind, string>;

/** 단계 상태 표시명 (shared STEP_STATUS_LABELS와 같음). */
export const STEP_STATUS_TEXT = {
  pending: '대기',
  running: '진행 중',
  passed: '통과',
  failed: '실패',
  skipped: '생략',
} as const satisfies Record<StepStatus, string>;

/** 실행 상태 표시명 (shared RUN_STATUS_LABELS와 같음). */
export const RUN_STATUS_TEXT = {
  waiting_approval: '승인 대기',
  queued: '실행 대기',
  running: '진행 중',
  merged: '병합 완료',
  failed: '실패',
  budget_exceeded: '예산 초과',
  interrupted: '중단',
} as const satisfies Record<RunStatus, string>;

/** 커밋 줄임 길이 (git 기본 짧은 해시). */
const SHORT_SHA = 7;

/** 머리줄: "판정 기준 main@abc1234". 병합된 실행이 없으면 "판정 기준 없음". */
export const basisText = (basis: VerificationBasis | null): string =>
  basis === null
    ? `${TEXT.basisPrefix} ${TEXT.none}`
    : `${TEXT.basisPrefix} ${basis.branch}@${basis.commit.slice(0, SHORT_SHA)}`;

/**
 * USD 표시. 값이 없으면 '없음'. 1센트 이상은 소수 둘째 자리, 그보다 작으면 유효 숫자 2개(0으로 보이지 않게),
 * 0은 "$0".
 */
export const formatUsd = (usd: number | null): string => {
  if (usd === null) return TEXT.none;
  if (usd === 0) return '$0';
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  // 고정 소수 표기(지수 표기 없음), 유효 숫자 2개까지 · 1e-9 USD(합산 단위) 자리까지, 끝의 0은 지운다
  const digits = Math.min(9, 1 - Math.floor(Math.log10(usd)));
  const fixed = usd.toFixed(digits).replace(/0+$/, '');
  return `$${fixed.endsWith('.') ? usd.toFixed(9) : fixed}`;
};

/** 턴 표시. 값이 없으면 '없음'. */
export const formatTurns = (turns: number | null): string =>
  turns === null ? TEXT.none : `${String(turns)}${TEXT.turnsSuffix}`;

/** 준수 카드 값: "통과 / 판정 가능". 판정 가능 규칙이 없으면 '없음'(값 없음, ADR-029). */
export const complianceText = ({
  passed,
  judgeable,
}: VerificationSummaryResult['compliance']): string =>
  judgeable === 0 ? TEXT.none : `${String(passed)} / ${String(judgeable)}`;

/** 실행 링크 문구 조각: 표시 ID · 비용 합계 · 턴. */
export const runLinkParts = (
  link: VerificationRunLink,
): { id: string; cost: string; turns: string } => ({
  id: link.displayId,
  cost: formatUsd(link.costUsd),
  turns: formatTurns(link.turns),
});

/**
 * 사람 확인 기준 값 (ADR-117): 효력 있는 확인됨 규칙이 없으면(`null`) '없음'(0 / 0 표시 금지), 확인됨 규칙은 있는데 판정
 * 가능한 것이 없을 때도 전체 기준과 같이 '없음'(ADR-029), 그 밖에는 "통과 / 판정 가능".
 */
export const confirmedComplianceText = (
  compliance: VerificationSummaryResult['confirmedCompliance'],
): string => (compliance === null ? TEXT.none : complianceText(compliance));

/**
 * 사람 확인 기준 값의 상태 (화면 속성 `data-state`): 확인됨 규칙 없음(`none`) · 확인됨 규칙은 있으나 판정 가능 없음
 * (`unjudgeable`) · 값 있음(`value`). 보이는 글자는 앞의 두 상태가 같은 '없음'이다.
 */
export const confirmedComplianceState = (
  compliance: VerificationSummaryResult['confirmedCompliance'],
): 'none' | 'unjudgeable' | 'value' =>
  compliance === null ? 'none' : compliance.judgeable === 0 ? 'unjudgeable' : 'value';

/** 에이전트 폐기 규칙 수: 센 값이므로 0도 "0"이다(값 없음이 아니다, ADR-117). */
export const agentRetiredText = (count: number): string => String(count);

/** 준수 카드의 전체 기준을 누르면 규칙 목록(`RULES_LIST_ID`)에 거는 필터: `준수 집계: 판정 가능`만 (분모 목록, JDG-03). */
export const COMPLIANCE_FILTER: FilterState = Object.freeze({
  query: '',
  selected: Object.freeze({ compliance: Object.freeze(['judgeable']) }),
  problemOnly: false,
  includeHidden: false,
});

/**
 * 준수 카드의 사람 확인 기준을 누르면 거는 필터: `준수 집계: 판정 가능` + `확인: 확인됨` (기준끼리 AND = 사람 확인 기준 분모,
 * 규칙 화면의 "사람 확인" 값과 같은 목록, ADR-114 · ADR-117).
 */
export const CONFIRMED_COMPLIANCE_FILTER: FilterState = Object.freeze({
  query: '',
  selected: Object.freeze({
    compliance: Object.freeze(['judgeable']),
    confirmation: Object.freeze(['confirmed']),
  }),
  problemOnly: false,
  includeHidden: false,
});

/** 에이전트 폐기 규칙 카드를 누르면 거는 필터: [폐기 포함]만 켠다(폐기된 규칙이 목록에 함께 보인다, ADR-114 · ADR-117). */
export const AGENT_RETIRED_FILTER: FilterState = Object.freeze({
  query: '',
  selected: Object.freeze({}),
  problemOnly: false,
  includeHidden: true,
});

/**
 * 파이프라인 머리줄의 현재 단계. 실행 대기(`queued`)는 아직 시작하지 않았으므로 현재 단계가 없다(다음에 시작할 단계를
 * 현재 단계로 보이지 않는다, ADR-105). 그 밖에는 실행의 `currentStep` 그대로.
 */
export const currentStepOf = (run: {
  status: RunStatus;
  currentStep: StepKind | null;
}): StepKind | null => (run.status === 'queued' ? null : run.currentStep);

/**
 * 파이프라인 머리줄의 실행 대기 건수 구절: "실행 대기 N" (보이는 실행 밖의 실행 대기, ADR-105). 0이면 `null`(보이지 않음).
 */
export const queuedText = (queued: number): string | null =>
  queued > 0 ? `${RUN_STATUS_TEXT.queued} ${String(queued)}` : null;

/** `run.resume` 거부가 "재개할 수 없어 실패로 끝냄"(`data.reason = resume_unrecoverable`)인지 (ADR-105). */
export const isResumeUnrecoverable = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const data = (error as { data?: unknown }).data;
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { reason?: unknown }).reason === 'resume_unrecoverable'
  );
};

/** 재개 불가 거부의 `data.runStatus` (끝난 상태). 없으면 `null`. */
export const resumeEndedStatus = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const status = (data as { runStatus?: unknown }).runStatus;
  return typeof status === 'string' ? status : null;
};

/** "EXE-001 재개 불가 · 실패 처리", 병합 완료로 끝났으면 "EXE-001 재개 불가 · 병합 완료". */
export const resumeUnrecoverableText = (
  displayId: string,
  endedStatus: string | null = null,
): string =>
  `${displayId} ${endedStatus === 'merged' ? TEXT.resumeUnrecoverableMerged : TEXT.resumeUnrecoverable}`;

/** [재개]를 보일지: 최근 실행이 중단(`interrupted`)일 때만 (ADR-011). */
export const canResume = (status: RunStatus): boolean => status === 'interrupted';

/** 코드 열람 영역의 사유 한 칸: 표시명 · 건수. */
export interface CodeOpenReasonRow {
  reason: CodeOpenReason;
  label: string;
  count: number;
}

/**
 * 코드 열람 영역 값 (ADR-088). 기록이 하나도 없으면 `null`(영역 값 '없음'). 있으면 사유 3종을 응답 순서
 * (화면 오류 · 정보 부족 · 디버깅) 그대로 싣고 0건인 사유도 0으로 보인다(세어 본 값이므로 '없음'이 아니다).
 * 화면에서 다시 세지 않고 응답의 건수만 쓴다.
 */
export const codeOpenRows = (summary: CodeOpenSummaryResult): CodeOpenReasonRow[] | null =>
  summary.total === 0
    ? null
    : summary.reasons.map(({ reason, count }) => ({
        reason,
        label: CODE_OPEN_REASON_LABELS[reason],
        count,
      }));
