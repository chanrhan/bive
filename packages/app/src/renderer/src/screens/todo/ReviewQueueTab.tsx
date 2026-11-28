// [검토 대기열] 탭 (SCR-18, TODO-02 · COST-01, ADR-100 명세 변경 SCR-18 · D8, ADR-145 · ADR-149 · ADR-153 · ADR-155 · ADR-157):
// 왼쪽 목록(ListView) + 오른쪽 상세(ReviewQueueDetail).
// - 목록 = `reviewQueue.list`의 항목(열림 · 처리됨). 열린 항목은 예외(종류)라 앞에 오고, 같은 묶음 안에서는 등록 시각 최신순이다
//   (공용 목록 정렬). 필터 칩 2종(종류 · 처리 상태), [문제만] 토글은 없다(처리 상태 칩과 같은 뜻)
// - 액션: 사람 주체로 1회. 항목별로 요청 중을 기억해 같은 틱의 두 번째 요청도 보내지 않고, 요청이 도는 동안 그 항목의 버튼은
//   모두 꺼진다. 성공하면 목록 · 배지를 다시 읽고(알림도 오지만 누른 쪽은 바로), 다시 읽기가 끝난 뒤 버튼을 다시 켠다. 처리 뒤 다른
//   화면으로 옮기지 않는다(명세에 없음)
// - 거부는 상세에 한 줄(서버의 거부 코드 · 고정 사유를 화면 문구로, reviewQueueView). 이미 처리됨이면 목록도 다시 읽는다
import type { ReviewQueueEntry } from '@bive/shared';
import { useCallback, useMemo, useRef, useState } from 'react';

import { ListView } from '../../components/ListView/index.js';
import { EmptyState } from '../../layout/EmptyState.js';
import { useTodoList } from '../../todo/TodoListContext.js';
import { type ReviewRequest, ReviewQueueDetail } from './ReviewQueueDetail.js';
import {
  isAlreadyResolved,
  REVIEW_CRITERIA,
  REVIEW_TEXT,
  reviewCard,
  reviewKey,
  reviewSearchText,
} from './reviewQueueView.js';

/** 목록 ID (필터 상태 저장소 키, ADR-048). */
export const REVIEW_LIST_ID = 'todo-review-queue';

const HUMAN = { kind: 'human' } as const;

/** 요청 하나 → RPC 호출 (사람 주체). */
const invokeAction = (projectId: string, seq: number, request: ReviewRequest): Promise<unknown> => {
  const base = { projectId, seq, author: HUMAN };
  switch (request.action) {
    case 'reinforce':
      return window.bive.invoke('reviewQueue.reinforce', base);
    case 'quarantine':
      return window.bive.invoke('reviewQueue.quarantine', { ...base, reason: request.reason });
    case 'raise_limit_resume':
      return window.bive.invoke('reviewQueue.resumeWithBudget', {
        ...base,
        budget: request.budget,
      });
    case 'narrow_allowlist_resume':
      return window.bive.invoke('reviewQueue.resumeNarrowed', {
        ...base,
        budget: request.budget,
        exclude: request.exclude,
      });
    case 'split_rule':
      return window.bive.invoke('reviewQueue.splitRule', { ...base, ruleId: request.ruleId });
  }
};

export const ReviewQueueTab = ({ projectId }: { projectId: string }): React.JSX.Element => {
  const { review: load, refreshReview } = useTodoList();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const result = load.status === 'ready' ? load.result : null;
  const entries = useMemo(() => result?.entries ?? [], [result]);
  const selected = useMemo(
    () => entries.find((entry) => reviewKey(entry) === selectedKey) ?? null,
    [entries, selectedKey],
  );
  const onSelect = useCallback((entry: ReviewQueueEntry) => setSelectedKey(reviewKey(entry)), []);

  // 요청 중인 항목. 같은 틱의 두 번째 요청도 막도록 화면 상태와 별도로 참조값에 둔다
  const inFlight = useRef(new Set<number>());
  const [busy, setBusy] = useState<ReadonlySet<number>>(() => new Set());
  // 항목별 마지막 거부 (문구는 상세가 입력 칸 이름과 함께 만든다)
  const [errors, setErrors] = useState<ReadonlyMap<number, { error: unknown }>>(() => new Map());

  const setError = useCallback((seq: number, value: { error: unknown } | null): void => {
    setErrors((prev) => {
      const next = new Map(prev);
      if (value === null) next.delete(seq);
      else next.set(seq, value);
      return next;
    });
  }, []);

  /** 액션 1회. 성공이면 true(상세가 입력을 닫는다), 거부 · 중복이면 false. */
  const onAction = useCallback(
    async (entry: ReviewQueueEntry, request: ReviewRequest): Promise<boolean> => {
      const seq = entry.item.seq;
      if (inFlight.current.has(seq)) return false;
      inFlight.current.add(seq);
      setBusy(new Set(inFlight.current));
      setError(seq, null);
      const settle = (): void => {
        inFlight.current.delete(seq);
        setBusy(new Set(inFlight.current));
      };
      try {
        await invokeAction(projectId, seq, request);
      } catch (error: unknown) {
        setError(seq, { error });
        // 그 사이 다른 곳에서 처리됨: 처리된 모습을 보인다
        if (isAlreadyResolved(error)) await refreshReview();
        settle();
        return false;
      }
      // 다시 읽기가 끝난 뒤(성공 · 실패 모두, 거부하지 않는다)에 버튼을 다시 켠다
      await refreshReview();
      settle();
      return true;
    },
    [projectId, refreshReview, setError],
  );

  return (
    <div className="todo-body" data-testid="todo-review" data-state={load.status}>
      <div className="todo-list-pane" data-testid="todo-list-pane">
        {result !== null && (
          <ListView
            listId={REVIEW_LIST_ID}
            label={REVIEW_TEXT.list}
            items={entries}
            itemKey={reviewKey}
            card={reviewCard}
            searchText={reviewSearchText}
            criteria={REVIEW_CRITERIA}
            emptyText={REVIEW_TEXT.empty}
            selectedKey={selected === null ? null : reviewKey(selected)}
            onSelect={onSelect}
            problemToggle={false}
          />
        )}
        {load.status === 'error' && <EmptyState text={REVIEW_TEXT.loadFailed} />}
      </div>
      <ReviewQueueDetail
        projectId={projectId}
        entry={selected}
        busy={selected !== null && busy.has(selected.item.seq)}
        failure={selected === null ? null : (errors.get(selected.item.seq) ?? null)}
        onAction={onAction}
      />
    </div>
  );
};
