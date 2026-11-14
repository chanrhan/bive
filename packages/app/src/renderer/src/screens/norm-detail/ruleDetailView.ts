// 규칙 상세의 표시 규칙 (screens.md SCR-03 상세 · SCR-06 · 1.4 상세 접힘, ADR-073). DOM · React에 의존하지 않는다
// (test/rule-detail-view.test.ts).
// - 값은 rule.list 항목(규칙 · 최신 판정) · rule.judgments(판정 이력) · requirement.get(부모)에서만 만든다(NFR-03)
// - 테스트 출력은 기본 접힘, 최신 판정이 실패면 자동 펼침 (1.4)
// - 실패 원인 = 최신 판정의 통과하지 않은 케이스(실행기 출력: 케이스 이름 · 메시지 · `file:line`)
import type {
  Author,
  CheckKind,
  JudgmentCase,
  JudgmentResult,
  RuleJudgmentEntry,
  RuleKind,
  TestCaseStatus,
} from '@bive/shared';

import { AUTHOR_LABELS } from '../../components/AuthorMark/labels.js';
import { formatCardTime } from '../../components/Card2Line/time.js';
import { AGENT_ROLE_LABELS, CHECK_KIND_LABELS } from '../../proposals/labels.js';
import { RULE_KIND_LABELS } from '../rules/rulesView.js';

export const RULE_DETAIL_TEXT = {
  statement: '진술',
  kind: '종류',
  checks: '검사',
  parent: '부모 요구사항',
  author: '생성 주체',
  result: '테스트 실행 결과',
  noJudgment: '판정 기록 없음',
  status: '판정',
  judgedAt: '판정 시각',
  commit: '커밋',
  run: '실행',
  cases: '케이스',
  output: '테스트 출력',
  failures: '실패 원인',
  allCases: '전체 케이스',
  noCases: '케이스 없음',
  noMessage: '메시지 없음',
  history: '실행 이력',
  noHistory: '실행 이력 없음',
  historyFailed: '실행 이력 불러오기 실패',
  none: '없음',
} as const;

/**
 * 테스트 케이스 상태 표시명 (vitest 리포터 상태, shared TestCaseStatus).
 * 판정에서는 통과 외 상태가 모두 통과 아님이다 (ADR-051).
 */
export const CASE_STATUS_LABELS = {
  passed: '통과',
  failed: '실패',
  skipped: '건너뜀',
  pending: '대기',
  todo: '미작성',
  disabled: '비활성',
} as const satisfies Record<TestCaseStatus, string>;

/** 상세의 생성 주체 이름 (1.4: 상세는 이름, 에이전트는 역할명). */
export const ruleAuthorName = (author: Author): string =>
  author.kind === 'agent'
    ? `${AUTHOR_LABELS.agent} · ${AGENT_ROLE_LABELS[author.role]}`
    : AUTHOR_LABELS.human;

export const ruleKindLabel = (kind: RuleKind): string => RULE_KIND_LABELS[kind];

export const checkKindsText = (kinds: readonly CheckKind[]): string =>
  kinds.map((kind) => CHECK_KIND_LABELS[kind]).join(' · ');

/** 케이스 위치 `file:line` (줄을 모르면 파일만). */
export const caseLocation = ({ file, line }: Pick<JudgmentCase, 'file' | 'line'>): string =>
  line === null ? file : `${file}:${line}`;

/** 실패 원인: 통과하지 않은 케이스 (실패 · 건너뜀 · 미작성 등, ADR-051). 실패 먼저, 나머지는 받은 순서. */
export const failureCases = (cases: readonly JudgmentCase[]): JudgmentCase[] => {
  const notPassed = cases.filter((item) => item.status !== 'passed');
  return [
    ...notPassed.filter((item) => item.status === 'failed'),
    ...notPassed.filter((item) => item.status !== 'failed'),
  ];
};

/** 케이스 상태별 개수 "통과 2 · 실패 1" (0건 상태는 뺀다, 표시명 순서). 케이스가 없으면 null. */
export const caseCountText = (cases: readonly JudgmentCase[]): string | null => {
  if (cases.length === 0) return null;
  const parts: string[] = [];
  for (const status of Object.keys(CASE_STATUS_LABELS) as TestCaseStatus[]) {
    const count = cases.filter((item) => item.status === status).length;
    if (count > 0) parts.push(`${CASE_STATUS_LABELS[status]} ${count}`);
  }
  return parts.join(' · ');
};

/** 커밋 표기: 앞 7자. */
export const shortCommit = (sha: string): string => sha.slice(0, 7);

/** 판정 시각 표기 (카드와 같은 로컬 `YYYY-MM-DD HH:mm`). 해석할 수 없으면 원문. */
export const judgedAtText = (iso: string): string => formatCardTime(iso) ?? iso;

/** 테스트 출력을 처음부터 펼칠지: 최신 판정이 실패면 펼친다 (1.4 상세 접힘). */
export const outputOpenByDefault = (latest: JudgmentResult | null): boolean =>
  latest?.status === 'fail';

/** 최신 판정의 실행 표시 ID: 이력에서 같은 판정 기록을 찾는다. 모르면 null(표시하지 않음). */
export const latestRunDisplayId = (
  latest: JudgmentResult | null,
  history: readonly RuleJudgmentEntry[] | null,
): string | null =>
  latest === null || history === null
    ? null
    : (history.find((entry) => entry.judgment.id === latest.id)?.runDisplayId ?? null);
