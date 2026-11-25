// 블록 이름 목록 (규칙 상세의 대상 블록 · 요구사항 상세의 구현 위치, ADR-126). 줄 · 알림은 blockView.ts가 정한다.
// - 이름이 없으면 "없음"
// - 선언에 없는 이름은 이름 뒤에 글자 "선언 외"(색에만 기대지 않는다). 알림(블록 선언 없음 · 불러오기 실패)은 목록 아래 한 번
// - 이름이 많거나 길어도 줄을 바꿔 감싼다(가로 스크롤 · 넘침 없음)
import { BLOCK_NOTE_TEXT, BLOCK_TEXT, type BlockListView } from '../rules/blockView.js';

export const BlockList = ({
  view,
  testId,
}: {
  view: BlockListView;
  testId: string;
}): React.JSX.Element => {
  if (view.rows.length === 0) {
    return (
      <span className="block-none" data-testid={`${testId}-none`}>
        {BLOCK_TEXT.none}
      </span>
    );
  }
  return (
    <div className="block-list-wrap" data-testid={testId}>
      <ul className="block-list">
        {view.rows.map((row) => (
          <li
            key={row.name}
            className="block-item"
            data-testid="block-item"
            data-undeclared={row.undeclared ? 'true' : 'false'}
          >
            <span className="block-name" data-testid="block-name">
              {row.name}
            </span>
            {row.undeclared && (
              <span className="block-undeclared" data-testid="block-undeclared">
                {BLOCK_TEXT.undeclared}
              </span>
            )}
          </li>
        ))}
      </ul>
      {view.note !== null && (
        <p className="block-note" data-testid="block-note" data-note={view.note}>
          {BLOCK_NOTE_TEXT[view.note]}
        </p>
      )}
    </div>
  );
};
