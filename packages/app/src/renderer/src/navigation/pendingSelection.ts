// 다른 화면에서 고를 항목을 넘기는 자리 (M3-35 #263, ADR-123): 확인할 것 상세의 대상 링크가 규칙 · 요구사항 화면을 열 때
// 그 카드를 고른 상태로 열리게 한다.
// - 목록 ID(필터 저장소와 같은 키)마다 표시 ID 하나를 렌더러 모듈 메모리에 둔다(디스크 · 저장소에 두지 않는다)
// - 받는 화면은 목록을 다 읽은 뒤 한 번 꺼내 쓰고 지운다(`takePendingSelection`). 목록에 그 표시 ID가 없으면(지워진 대상)
//   아무것도 고르지 않는다
// - 프로젝트가 바뀌면 비운다(`clearPendingSelections`, 목록 필터와 같은 때)
const pending = new Map<string, string>();

/** 목록 `listId`의 화면이 다음에 열릴 때 고를 항목의 표시 ID를 둔다. */
export const requestSelection = (listId: string, displayId: string): void => {
  pending.set(listId, displayId);
};

/** 목록 `listId`의 고를 항목을 꺼내고 지운다. 없으면 null. */
export const takePendingSelection = (listId: string): string | null => {
  const value = pending.get(listId) ?? null;
  pending.delete(listId);
  return value;
};

/** 모든 목록의 고를 항목을 비운다 (프로젝트 전환). */
export const clearPendingSelections = (): void => {
  pending.clear();
};
