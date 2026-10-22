// 2줄 카드의 값 · 예외 계산 (screens.md 1.4 카드). JSX가 없어 순수 함수 테스트(node)에서도 가져올 수 있다.
import type { AuthorKind } from '@bive/shared';

import { type BadgeStatus, type ExceptionMark, statusExceptions } from '../StatusBadge/status.js';

/** 카드에 그릴 값. 화면 데이터(파서 · 실행 결과)에서만 만든다 (NFR-03). */
export interface CardData {
  /** 1줄: 사람이 읽는 제목 */
  title: string;
  /** 2줄: 표시 ID (예: 규칙 표시 ID) */
  id: string;
  /** 판정 · 변이 · 처리 결과 상태. 정상은 1줄 앞 흐린 점, 예외는 2줄째 예외가 된다 */
  statuses?: readonly BadgeStatus[];
  /** 상태 밖의 예외 (글자 + 색, 화면별 정의). 정상 항목은 비움 */
  exceptions?: readonly ExceptionMark[];
  /** 2줄: 시각 (ISO 8601). 목록 정렬에도 쓴다. 없거나 해석할 수 없으면 미표시 */
  dateTime?: string;
  /** 생성 주체 (요구사항 · 규칙 · 계약). 없으면 미표시 */
  author?: AuthorKind;
  /** 1줄 제목 앞 종류 태그 (예: 승인 대기의 '신규'). 없으면 미표시 */
  tag?: string;
  /** 참이면 2줄 끝에 안 읽음 점 */
  unread?: boolean;
}

/** 카드 2줄째 예외 전체 (예외 상태 + 그 밖 예외). 1개 이상이면 문제 항목 (ADR-034). */
export const cardExceptions = (
  card: Pick<CardData, 'statuses' | 'exceptions'>,
): ExceptionMark[] => [
  ...(card.statuses ?? []).flatMap(statusExceptions),
  ...(card.exceptions ?? []),
];
