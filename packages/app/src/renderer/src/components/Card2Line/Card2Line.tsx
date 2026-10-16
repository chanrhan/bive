// 2줄 카드 (screens.md 1.4 카드): 1줄 = 사람이 읽는 제목, 2줄 = ID · 예외 · 시각.
// 정상 항목은 2줄째 예외가 비어 있다. 긴 텍스트는 말줄임 + 툴팁(title, 전체 문구).
// 상태(판정 · 변이)는 정상이면 1줄 앞 흐린 점, 예외면 2줄째 예외(글자 + 색)로 그린다 (1.4 상태 배지).
// 생성 주체는 아이콘만 (1.4 생성 주체: 목록은 아이콘).
// 선택: 1줄 앞 종류 태그(`tag`), 2줄 끝 안 읽음 점(`unread`) — 승인 대기 카드 (SCR-17, ADR-056).
import './Card2Line.css';

import { AuthorMark } from '../AuthorMark/AuthorMark.js';
import { ExceptionLabel, StatusBadge } from '../StatusBadge/StatusBadge.js';
import { statusTone } from '../StatusBadge/status.js';
import { type CardData, cardExceptions } from './card.js';
import { formatCardTime } from './time.js';

export { type CardData, cardExceptions } from './card.js';

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
  tag,
  unread = false,
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
        {tag !== undefined && (
          <span className="card-tag" data-testid="card-tag">
            {tag}
          </span>
        )}
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
        {unread && (
          <span
            className="card-unread"
            data-testid="card-unread"
            role="img"
            aria-label="안 읽음"
            title="안 읽음"
          />
        )}
      </span>
    </>
  );
  const common = {
    className: 'card',
    'data-testid': 'card',
    'data-id': id,
    'data-problem': marks.length > 0 ? 'true' : 'false',
    'data-unread': unread ? 'true' : 'false',
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
