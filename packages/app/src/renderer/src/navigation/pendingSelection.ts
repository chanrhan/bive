// 다른 화면에서 고를 항목을 넘기는 자리 (M3-35 #263, ADR-123): 확인할 것 상세의 대상 링크가 규칙 · 요구사항 화면을 열 때
// 그 카드를 고른 상태로 열리게 한다.
// - 목록 ID(필터 저장소와 같은 키)마다 표시 ID 하나를 렌더러 모듈 메모리에 둔다(디스크 · 저장소에 두지 않는다)
// - 수명은 그 이동 한 번이다: 받는 화면은 마운트할 때 읽어 자기 상태에 두고(`peekPendingSelection`) 마운트 효과에서 지운다
//   (`clearPendingSelection`). 그 화면이 목록을 다 읽으면 그 카드를 고르고(목록에 없으면 고르지 않음), 읽기가 실패하거나 화면을
//   떠나거나 프로젝트가 바뀌어 화면이 새로 그려지면 버린다. 그래서 다음 진입(사이드바 · 검증 화면 카드 등)에는 쓰이지 않는다
// - 읽기와 지우기를 나눈 것은 개발 모드의 두 번 그리기 · 두 번 마운트에도 같은 값을 읽게 하려는 것이다
const pending = new Map<string, string>();

/** 목록 `listId`의 화면이 다음에 열릴 때 고를 항목의 표시 ID를 둔다. */
export const requestSelection = (listId: string, displayId: string): void => {
  pending.set(listId, displayId);
};

/** 목록 `listId`에 둔 고를 항목의 표시 ID (지우지 않는다). 없으면 null. */
export const peekPendingSelection = (listId: string): string | null => pending.get(listId) ?? null;

/** 목록 `listId`의 고를 항목을 지운다 (받는 화면의 마운트 효과). */
export const clearPendingSelection = (listId: string): void => {
  pending.delete(listId);
};
