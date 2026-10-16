// 빈 상태: 영역 가운데 한 줄 문구만 (ADR-029). 안내 문장 · 그림 · 새 버튼은 넣지 않는다.
export const EmptyState = ({ text }: { text: string }): React.JSX.Element => (
  <p className="empty-state" data-testid="empty-state">
    {text}
  </p>
);
