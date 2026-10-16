// 2줄 카드 (screens.md 1.4 카드): 1줄 = 사람이 읽는 제목, 2줄 = ID · 예외 · 시각.
// 정상 항목은 2줄째 예외가 비어 있다. 긴 텍스트는 말줄임 + 툴팁(title, 전체 문구).
// 상태(판정 · 변이)는 정상이면 1줄 앞 흐린 점, 예외면 2줄째 예외(글자 + 색)로 그린다 (1.4 상태 배지).
// 생성 주체는 아이콘만 (1.4 생성 주체: 목록은 아이콘).
import './Card2Line.css';

import type { AuthorKind } from '@bive/shared';

import { AuthorMark } from '../AuthorMark/AuthorMark.js';
import { ExceptionLabel, StatusBadge } from '../StatusBadge/StatusBadge.js';
import {
  type BadgeStatus,
  type ExceptionMark,
  statusExceptions,
  statusTone,
} from '../StatusBadge/status.js';
import { formatCardTime } from './time.js';

/** 카드에 그릴 값. 화면 데이터(파서 · 실행 결과)에서만 만든다 (NFR-03). */
export interface CardData {
  /** 1줄: 사람이 읽는 제목 */
  title: string;
  /** 2줄: 표시 ID (예: 규칙 표시 ID) */
  id: string;
  /** 판정 · 변이 상태. 정상은 1줄 앞 흐린 점, 예외는 2줄째 예외가 된다 */
  statuses?: readonly BadgeStatus[];
  /** 상태 밖의 예외 (글자 + 색, 화면별 정의). 정상 항목은 비움 */
  exceptions?: readonly ExceptionMark[];
  /** 2줄: 시각 (ISO 8601). 목록 정렬에도 쓴다. 없거나 해석할 수 없으면 미표시 */
  dateTime?: string;
  /** 생성 주체 (요구사항 · 규칙 · 계약). 없으면 미표시 */
  author?: AuthorKind;
}

/** 카드 2줄째 예외 전체 (예외 상태 + 그 밖 예외). 1개 이상이면 문제 항목 (ADR-034). */
export const cardExceptions = (
  card: Pick<CardData, 'statuses' | 'exceptions'>,
): ExceptionMark[] => [
  ...(card.statuses ?? []).flatMap(statusExceptions),
  ...(card.exceptions ?? []),
];

export interface Card2LineProps extends CardData {
  /** 있으면 카드 전체가 버튼이 된다 */
  onSelect?: () => void;
  selected?: boolean;
}

export const Card2Line = ({
  title,
  id,
  statuses = [],
  exceptions = [],
  dateTime,
  author,
  onSelect,
  selected = false,
}: Card2LineProps): React.JSX.Element => {
  const normals = statuses.filter((status) => statusTone(status) === 'normal');
  const marks = cardExceptions({ statuses, exceptions });
  const time = dateTime === undefined ? null : formatCardTime(dateTime);
  // 2줄째 툴팁: 말줄임으로 가려질 수 있는 문구 전체
  const line2 = [id, ...marks.map((e) => e.label), ...(time === null ? [] : [time])].join(' · ');
  const body = (
    <>
      <span className="card-line card-line-1">
        {normals.map((status) => (
          <StatusBadge key={`${status.kind}:${status.status}`} {...status} />
        ))}
        <span className="card-title" data-testid="card-title" title={title}>
          {title}
        </span>
        {author !== undefined && <AuthorMark kind={author} />}
      </span>
      <span className="card-line card-line-2" data-testid="card-line-2" title={line2}>
        <span className="card-id" data-testid="card-id">
          {id}
        </span>
        {marks.map((mark) => (
          <ExceptionLabel
            key={mark.key}
            label={mark.label}
            tone={mark.tone}
            testId="card-exception"
          />
        ))}
        {time !== null && (
          <time className="card-time" dateTime={dateTime}>
            {time}
          </time>
        )}
      </span>
    </>
  );
  const common = {
    className: 'card',
    'data-testid': 'card',
    'data-id': id,
    'data-problem': marks.length > 0 ? 'true' : 'false',
  };
  return onSelect === undefined ? (
    <div {...common}>{body}</div>
  ) : (
    <button
      type="button"
      {...common}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      {body}
    </button>
  );
};
