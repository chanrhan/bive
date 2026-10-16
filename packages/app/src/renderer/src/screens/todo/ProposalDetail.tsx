// 승인 대기 상세 자리 (SCR-17 오른쪽). 지금은 틀만 둔다: 고른 항목이 없으면 "선택 항목 없음".
// 내용(출처 → 에이전트 제안 diff · 근거 · 생성 주체 → 승인하면 / 거절하면)과 [거절] [수정] [승인]은 #40(M1-27)이
// 이 컴포넌트 안에 채운다. 처리 뒤에는 목록 refresh()와 useProposalCount().refresh()를 부른다.
import type { Proposal } from '@bive/shared';

import { EmptyState } from '../../layout/EmptyState.js';

/** 중앙 영역의 "선택 항목 없음"(layout/MainArea.tsx)과 같은 문구. MainArea는 화면 등록부를 import하므로 다시 적는다 */
const NO_SELECTION_TEXT = '선택 항목 없음';

export interface ProposalDetailProps {
  /** 고른 제안. 없으면 null */
  proposal: Proposal | null;
}

export const ProposalDetail = ({ proposal }: ProposalDetailProps): React.JSX.Element => (
  <section
    className="todo-detail"
    data-testid="todo-detail"
    data-selected-id={proposal?.displayId ?? 'none'}
    aria-label="선택 항목"
  >
    {proposal === null && <EmptyState text={NO_SELECTION_TEXT} />}
  </section>
);
