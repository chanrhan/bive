// 시험 전용 주입 지점 (#146). 패키지 색인(`index.ts`)에서 다시 내보내지 않는다: `@bive/store` 공개 API가 아니다.
// `ProjectStore.close`가 `data_version`을 비교한 뒤 · 믿을 행 해시를 읽기 전에 부른다(다른 연결의 커밋을 그 순간에 끼워
// 넣는 시험용). 제품 코드는 설정하지 않는다.

let probe: (() => void) | null = null;

/** 시험 전용: 닫기 주입 함수를 정한다. `null`이면 아무것도 하지 않는다. */
export const setCloseProbeForTests = (next: (() => void) | null): void => {
  probe = next;
};

/** 정해진 주입 함수를 부른다 (없으면 아무것도 하지 않음). */
export const runCloseProbe = (): void => {
  probe?.();
};
