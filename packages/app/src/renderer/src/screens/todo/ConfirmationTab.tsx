// [확인할 것] 탭 (SCR-17 자리, TODO-01 · NRM-04, ADR-100 D2 · D3 · B⑦ · D8 · 명세 변경 SCR-17, ADR-113 · ADR-119):
// 왼쪽 목록(ListView) + 오른쪽 상세(ConfirmationDetail).
// - 목록 = `confirmation.list`의 항목을 서버가 준 순서 그대로(폐기 · 대체가 맨 위인 것은 서버 순서가 보장한다). 잘렸으면 머리줄
// - [확인]: 사람 주체 `confirmation.set` 1회. 대상(규칙 · 요구사항)별로 요청 중을 기억해 같은 틱의 두 번째 요청도 보내지 않는다.
//   성공하면 목록 · 배지를 다시 읽는다(그 대상에 쌓인 폐기 · 대체 · 테스트 변경 항목이 함께 내려간다, 서버 동작).
//   이미 확인됨 · 삭제된 대상(-32009)이면 오류를 남기지 않고 다시 읽는다. 그 밖의 실패는 상세에 한 줄
// - 확인 상태는 아무것도 막지 않는다(ADR-100 D2 · D8): 이 화면에 [승인] · [수정] · [거절] · 상한 머리줄이 없다
import type { ConfirmationItem } from '@bive/shared';
import { useCallback, useMemo, useRef, useState } from 'react';

import { ListView } from '../../components/ListView/index.js';
import { EmptyState } from '../../layout/EmptyState.js';
import { useTodoList } from '../../todo/TodoListContext.js';
import { ConfirmationDetail } from './ConfirmationDetail.js';
import {
  CONFIRMATION_CRITERIA,
  CONFIRMATION_TEXT,
  confirmationCard,
  confirmationKey,
  confirmationSearchText,
  confirmErrorText,
  confirmTarget,
  isStaleConfirm,
  sameTargetCount,
  targetKey,
  truncatedText,
} from './confirmationView.js';

/** 목록 ID (필터 상태 저장소 키, ADR-048). */
export const CONFIRMATION_LIST_ID = 'todo-confirmation';

export const ConfirmationTab = ({ projectId }: { projectId: string }): React.JSX.Element => {
  const { load, refresh } = useTodoList();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const result = load.status === 'ready' ? load.result : null;
  const items = useMemo(() => result?.items ?? [], [result]);
  // 목록에서 사라진 항목(확인으로 내려감)은 고른 것으로 보지 않는다
  const selected = useMemo(
    () => items.find((item) => confirmationKey(item) === selectedKey) ?? null,
    [items, selectedKey],
  );
  const onSelect = useCallback((item: ConfirmationItem) => {
    setSelectedKey(confirmationKey(item));
  }, []);

  // [확인] 요청 중인 대상. 같은 틱의 두 번째 요청도 막도록 화면 상태와 별도로 참조값에 둔다
  const inFlight = useRef(new Set<string>());
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());

  const setError = useCallback((key: string, value: string | null): void => {
    setErrors((prev) => {
      const next = new Map(prev);
      if (value === null) next.delete(key);
      else next.set(key, value);
      return next;
    });
  }, []);

  const onConfirm = useCallback(
    (item: ConfirmationItem): void => {
      const target = confirmTarget(item);
      const key = targetKey(target);
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      setBusyKeys(new Set(inFlight.current));
      setError(key, null);
      const settle = (): void => {
        inFlight.current.delete(key);
        setBusyKeys(new Set(inFlight.current));
      };
      window.bive.invoke('confirmation.set', { projectId, target, author: { kind: 'human' } }).then(
        () => {
          // 다시 읽기가 끝난 뒤(성공 · 실패 모두, refresh는 거부하지 않는다)에 버튼을 다시 켠다: 그 사이 새로 생긴 항목을
          // 화면에 보이기 전에 다시 [확인]하지 않게 (사람이 본 것만 확인한다, ADR-119)
          void refresh().then(settle);
        },
        (reason: unknown) => {
          // 이미 확인됨 · 삭제된 대상: 그 사이 다른 곳에서 확인했다. 오류 없이 지금 목록을 보인다
          if (isStaleConfirm(reason)) {
            void refresh().then(settle);
          } else {
            settle();
            setError(key, confirmErrorText(reason));
          }
        },
      );
    },
    [projectId, refresh, setError],
  );

  const selectedTarget = selected === null ? null : targetKey(confirmTarget(selected));

  return (
    <div className="todo-body" data-testid="todo-confirmation" data-state={load.status}>
      <div className="todo-list-pane" data-testid="todo-list-pane">
        {result !== null && (
          <ListView
            listId={CONFIRMATION_LIST_ID}
            label={CONFIRMATION_TEXT.list}
            items={items}
            itemKey={confirmationKey}
            card={confirmationCard}
            searchText={confirmationSearchText}
            criteria={CONFIRMATION_CRITERIA}
            emptyText={CONFIRMATION_TEXT.empty}
            selectedKey={selected === null ? null : confirmationKey(selected)}
            onSelect={onSelect}
            keepOrder
            {...(result.truncated && {
              leading: (
                <p className="confirmation-truncated" data-testid="confirmation-truncated">
                  {truncatedText(result.total, result.items.length)}
                </p>
              ),
            })}
          />
        )}
        {load.status === 'error' && <EmptyState text={CONFIRMATION_TEXT.loadFailed} />}
      </div>
      <ConfirmationDetail
        projectId={projectId}
        item={selected}
        sameTarget={selected === null ? 0 : sameTargetCount(items, selected)}
        busy={selectedTarget !== null && busyKeys.has(selectedTarget)}
        error={selectedTarget === null ? null : (errors.get(selectedTarget) ?? null)}
        onConfirm={onConfirm}
      />
    </div>
  );
};
