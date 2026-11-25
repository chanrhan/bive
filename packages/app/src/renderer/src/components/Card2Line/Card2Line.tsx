// 2줄 카드 (screens.md 1.4 카드): 1줄 = 사람이 읽는 제목, 2줄 = ID · 예외 · 시각.
// 정상 항목은 2줄째 예외가 비어 있다. 긴 텍스트는 말줄임 + 툴팁(공통 툴팁, 전체 문구, 이슈 #201 · ADR-124):
//   제목 · 2줄째가 잘렸을 때만 연다. 마우스는 그 줄에 올리면, 키보드는 카드(선택 버튼)에 초점이 닿으면 잘린 줄 전부를 한 툴팁에.
//   카드에는 React 이벤트 속성만 달고 툴팁 요소는 열린 것 하나만 `TooltipHost`가 그린다(카드 수만큼 늘지 않는다).
//   탭 순서는 카드마다 한 번이다(줄에는 초점을 주지 않는다).
// 상태(판정 · 변이)는 정상이면 1줄 앞 흐린 점, 예외면 2줄째 예외(글자 + 색)로 그린다 (1.4 상태 배지).
// 생성 주체는 아이콘만 (1.4 생성 주체: 목록은 아이콘).
// 선택: 1줄 앞 종류 태그(`tag`) — 확인할 것 카드 (SCR-17 자리, ADR-119). 안 읽음 점은 없다(ADR-119 · ADR-123).
import './Card2Line.css';

import { AuthorMark } from '../AuthorMark/AuthorMark.js';
import { ExceptionLabel, StatusBadge } from '../StatusBadge/StatusBadge.js';
import { statusTone } from '../StatusBadge/status.js';
import {
  hideHover,
  hideTooltip,
  isClipped,
  isKeyboardFocus,
  showTooltip,
} from '../Tooltip/tooltipStore.js';
import { type CardData, cardExceptions } from './card.js';
import { formatCardTime } from './time.js';

export { type CardData, cardExceptions } from './card.js';

export interface Card2LineProps extends CardData {
  /** 있으면 카드 전체가 버튼이 된다 */
  onSelect?: () => void;
  selected?: boolean;
}

/** 2줄째가 잘렸는지: 줄 자체(넘침 숨김) 또는 말줄임 칸(ID · 보조 문구 · 시각) 하나라도. */
const lineClipped = (line: HTMLElement): boolean =>
  isClipped(line) ||
  [...line.querySelectorAll('.card-id, .card-note, .card-time')].some((cell) => isClipped(cell));

/** 카드 초점의 툴팁 줄: 잘린 제목 · 잘린 2줄째만, 화면 순서대로. 둘 다 온전하면 빈 배열(툴팁 없음). */
const clippedLines = (card: HTMLElement, title: string, line2: string): string[] => {
  const titleCell = card.querySelector('.card-title');
  const line = card.querySelector<HTMLElement>('.card-line-2');
  return [
    ...(titleCell !== null && isClipped(titleCell) ? [title] : []),
    ...(line !== null && lineClipped(line) ? [line2] : []),
  ];
};

export const Card2Line = ({
  title,
  id,
  note,
  statuses = [],
  exceptions = [],
  dateTime,
  author,
  tag,
  onSelect,
  selected = false,
}: Card2LineProps): React.JSX.Element => {
  const normals = statuses.filter((status) => statusTone(status) === 'normal');
  const marks = cardExceptions({ statuses, exceptions });
  const time = dateTime === undefined ? null : formatCardTime(dateTime);
  // 2줄째 툴팁: 말줄임으로 가려질 수 있는 문구 전체
  const line2 = [
    id,
    ...(note === undefined ? [] : [note]),
    ...marks.map((e) => e.label),
    ...(time === null ? [] : [time]),
  ].join(' · ');
  const timeCell = time !== null && (
    <time className="card-time" dateTime={dateTime}>
      {time}
    </time>
  );
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
        <span
          className="card-title"
          data-testid="card-title"
          onMouseEnter={(event) => {
            if (isClipped(event.currentTarget)) showTooltip(event.currentTarget, [title], 'hover');
          }}
          onMouseLeave={(event) => hideHover(event.currentTarget)}
        >
          {title}
        </span>
        {author !== undefined && <AuthorMark kind={author} />}
      </span>
      <span
        className="card-line card-line-2"
        data-testid="card-line-2"
        onMouseEnter={(event) => {
          if (lineClipped(event.currentTarget)) showTooltip(event.currentTarget, [line2], 'hover');
        }}
        onMouseLeave={(event) => hideHover(event.currentTarget)}
      >
        <span className="card-id" data-testid="card-id">
          {id}
        </span>
        {note !== undefined && (
          <span className="card-note" data-testid="card-note">
            {note}
          </span>
        )}
        {marks.map((mark) => (
          <ExceptionLabel
            key={mark.key}
            label={mark.label}
            tone={mark.tone}
            testId="card-exception"
          />
        ))}
        {timeCell}
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
      onFocus={(event) => {
        const card = event.currentTarget;
        if (!isKeyboardFocus(card)) return;
        showTooltip(card, clippedLines(card, title, line2), 'focus');
      }}
      onBlur={(event) => hideTooltip(event.currentTarget)}
    >
      {body}
    </button>
  );
};
