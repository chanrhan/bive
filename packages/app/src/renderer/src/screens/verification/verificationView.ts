// 검증 화면의 표시 규칙 (screens.md SCR-05 · 1.1, JDG-03 · COST-02, ADR-011 · ADR-029 · ADR-035 · ADR-072).
// DOM · React에 의존하지 않는다 (test/verification-view.test.ts).
// - 값은 `verification.summary` 결과에서만 만든다(NFR-03). 값이 없으면 '없음'(0 표시 금지, COST-02 · ADR-029)
// - renderer는 shared를 import type으로만 가져오므로(architecture.md 2장) 표시명을 다시 적고 단위 테스트가 대조한다
// - 지표 카드는 준수 · 실행당 비용만. 잠정 · 변이 · 규칙화 불가 · 추적성 결함 카드는 기능 이슈 전까지 미노출 (ADR-035)
import type {
  RunStatus,
  StepKind,
  StepStatus,
  VerificationBasis,
  VerificationRunLink,
  VerificationSummaryResult,
} from '@bive/shared';

import type { FilterState } from '../../components/ListView/filter.js';

/** 화면 문구 (screens.md 1.1: 명사형 · 짧은 문구). */
export const TEXT = {
  basisPrefix: '판정 기준',
  none: '없음',
  metrics: '지표',
  compliance: '준수',
  complianceHint: '통과 / 판정 가능',
  costPerRun: '실행당 비용',
  pipeline: '파이프라인',
  noRun: '실행 없음',
  resume: '재개',
  resumeFailed: '재개 실패',
  rules: '규칙별 최신 판정',
  noRules: '규칙 없음',
  turnsSuffix: '턴',
  loadFailed: '검증 불러오기 실패',
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
  return `$${String(Number(usd.toPrecision(2)))}`;
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

/** 준수 카드를 누르면 규칙 목록(`RULES_LIST_ID`)에 거는 필터: `준수 집계: 판정 가능`만 (분모 목록, JDG-03). */
export const COMPLIANCE_FILTER: FilterState = Object.freeze({
  query: '',
  selected: Object.freeze({ compliance: Object.freeze(['judgeable']) }),
  problemOnly: false,
});

/** [재개]를 보일지: 최근 실행이 중단(`interrupted`)일 때만 (ADR-011). */
export const canResume = (status: RunStatus): boolean => status === 'interrupted';
