// 상세 접힘 (screens.md 1.4 상세 접힘): 변경 이력 · 테스트 출력은 기본 접힘.
// `forceOpen`이 true가 되면 펼친다(판정 실패면 테스트 출력 자동 펼침). 펼친 뒤에는 사람이 다시 접을 수 있다.
import './CollapsibleDetail.css';

import { ChevronRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

export interface CollapsibleDetailProps {
  /** 머리 문구 (예: 테스트 출력) */
  title: string;
  /** true가 되는 순간 펼친다 (예: 판정 실패) */
  forceOpen?: boolean;
  children: ReactNode;
}

export const CollapsibleDetail = ({
  title,
  forceOpen = false,
  children,
}: CollapsibleDetailProps): React.JSX.Element => {
  const [open, setOpen] = useState(forceOpen);
  // forceOpen이 false → true로 바뀌면 렌더 중에 펼침 상태를 맞춘다 (effect 없이, React 문서의 '이전 값 저장' 방식)
  const [lastForce, setLastForce] = useState(forceOpen);
  if (forceOpen !== lastForce) {
    setLastForce(forceOpen);
    if (forceOpen) setOpen(true);
  }
  const bodyId = useId();
  return (
    <section className="collapsible" data-testid="collapsible" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="collapsible-header"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className="inline-icon collapsible-chevron" aria-hidden="true" />
        <span>{title}</span>
      </button>
      <div id={bodyId} className="collapsible-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
};
