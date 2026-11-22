// 요구사항 화면의 표시 규칙 (screens.md SCR-02 카드 · 필터, 1.4, ADR-053, ADR-100 I3 · B①, M7-15 #227 · ADR-114). DOM · React에
// 의존하지 않는다 (test/requirements-view.test.ts).
// - 카드: 1줄 요구사항 문장 · 생성 주체 아이콘, 2줄 표시 ID · 예외 · 시각(마지막 변경 시각)
// - 예외: 추적성 결함 · 규칙화 불가 · 미확인 · 실패. 미확인은 옛 '잠정' 자리다(ADR-100 명세 변경 목록 SCR-02). 사람이 쓴
//   요구사항은 저장 즉시 확인됨이라 예외가 없다(B①). 값은 Requirement 필드에서만 도출한다(NFR-03).
//   추적성 결함(규칙 없는 요구사항)과 실패(자식 규칙 판정)는 규칙 · 판정 데이터가 아직 없어 도출하지 않는다
// - 필터: 상태 · 작성 · 확인 · 블록. 옛 "승인"(승인 · 대기 · 잠정) 칩은 "확인"(미확인 · 확인됨)으로 바뀌었다. 블록은 값이 없어
//   0건 비활성 (ADR-035)
import type { AuthorKind, ConfirmationState, Requirement } from '@bive/shared';

import { AUTHOR_LABELS } from '../../components/AuthorMark/labels.js';
import type { FilterCriterion } from '../../components/ListView/filter.js';
import {
  CONFIRMATION_LABELS,
  type ExceptionMark,
  type ExceptionTone,
} from '../../components/StatusBadge/status.js';

/** 목록 ID = 경로 ID (ADR-048). 필터 상태가 이 ID로 유지된다. */
export const REQUIREMENTS_LIST_ID = 'requirements';

export const TEXT = {
  list: '요구사항 목록',
  empty: '요구사항 없음',
  loadFailed: '요구사항 불러오기 실패',
  noProject: '프로젝트 없음',
  detail: '상세',
  noSelection: '선택 항목 없음',
  newButton: '새 요구사항',
  inputLabel: '새 요구사항 본문',
  inputPlaceholder: '요구사항 문장',
  saveFailed: '요구사항 저장 실패',
} as const;

/** 카드 2줄째 예외 (SCR-02 카드). 순서가 표시 순서다. */
export type RequirementException = 'traceability' | 'unrulable' | 'unconfirmed' | 'failed';

export const EXCEPTION_LABELS = {
  traceability: '추적성 결함',
  unrulable: '규칙화 불가',
  unconfirmed: CONFIRMATION_LABELS.unconfirmed,
  failed: '실패',
} as const satisfies Record<RequirementException, string>;

/** 예외 색 (ADR-053): 결함 · 실패 = danger, 규칙화 불가 = warning(결함과 구분, NRM-08), 미확인 = info(규칙 카드와 같음). */
const EXCEPTION_TONES = {
  traceability: 'danger',
  unrulable: 'warning',
  unconfirmed: 'info',
  failed: 'danger',
} as const satisfies Record<RequirementException, ExceptionTone>;

/** 목록에 보일 요구사항: 삭제된 것은 뺀다 (`get`과 달리 `list`는 삭제되지 않은 것만 주지만 한 번 더 거른다). */
export const visibleRequirements = (requirements: readonly Requirement[]): Requirement[] =>
  requirements.filter((requirement) => requirement.deletedAt === null);

/** 요구사항의 예외. 근거 필드가 있는 것만 (추적성 결함 · 실패는 규칙 · 판정 데이터가 생기면 더한다). */
export const requirementExceptions = (requirement: Requirement): RequirementException[] => {
  const out: RequirementException[] = [];
  if (requirement.unrulable !== null) out.push('unrulable');
  if (requirement.confirmation.state === 'unconfirmed') out.push('unconfirmed');
  return out;
};

const toMark = (exception: RequirementException): ExceptionMark => ({
  key: exception,
  label: EXCEPTION_LABELS[exception],
  tone: EXCEPTION_TONES[exception],
});

/**
 * 카드 값 (Card2Line `CardData`와 같은 모양. 이 파일은 단위 테스트가 JSX 없이 읽도록 .tsx를 가져오지 않는다).
 * 시각은 마지막 변경 시각(`updatedAt`, 생성 직후에는 생성 시각과 같음).
 */
export interface RequirementCardData {
  title: string;
  id: string;
  exceptions: ExceptionMark[];
  dateTime: string;
  author: AuthorKind;
}

export const requirementCard = (requirement: Requirement): RequirementCardData => ({
  title: requirement.text,
  id: requirement.displayId,
  exceptions: requirementExceptions(requirement).map(toMark),
  dateTime: requirement.updatedAt,
  author: requirement.author.kind,
});

export const requirementKey = (requirement: Requirement): string => requirement.id;

/** 필터 기준 4종 (SCR-02 필터: 상태 · 작성 · 확인 · 블록, 확인은 ADR-100 명세 변경 목록 SCR-02). 순서가 칩 순서다. */
export const REQUIREMENT_CRITERIA: readonly FilterCriterion<Requirement>[] = [
  {
    id: 'status',
    label: '상태',
    options: [
      { value: 'normal', label: '정상' },
      ...(['traceability', 'unrulable', 'unconfirmed', 'failed'] as const).map((value) => ({
        value,
        label: EXCEPTION_LABELS[value],
      })),
    ],
    values: (requirement) => {
      const exceptions = requirementExceptions(requirement);
      return exceptions.length === 0 ? ['normal'] : exceptions;
    },
  },
  {
    id: 'author',
    label: '작성',
    options: [
      { value: 'human', label: AUTHOR_LABELS.human },
      { value: 'agent', label: AUTHOR_LABELS.agent },
    ],
    values: (requirement) => [requirement.author.kind],
  },
  {
    id: 'confirmation',
    label: '확인',
    options: (Object.keys(CONFIRMATION_LABELS) as ConfirmationState[]).map((value) => ({
      value,
      label: CONFIRMATION_LABELS[value],
    })),
    values: (requirement) => [requirement.confirmation.state],
  },
  {
    id: 'block',
    label: '블록',
    // 블록(파서, M2)과 자식 규칙의 대상 블록 데이터가 아직 없다 → 값 없음 = 0건 비활성 (ADR-035)
    options: [],
    values: () => [],
  },
];
