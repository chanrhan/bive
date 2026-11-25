// 파서 상한 (M3-02 #47, ADR-125). 경로 · 모듈 이름은 구현 역할이 정할 수 있는 글이라 결과 크기를 묶는다.
// - 분석 자체의 상한(파일 수 · 경로 길이 · 시간 · 출력 크기)을 넘으면 오류다(결과를 돌려주지 않는다)
// - 결과 목록의 상한을 넘으면 앞쪽만 담고 `total`에 전체 개수를 남긴다(잘랐다는 사실이 결과에 드러난다)

export const PARSER_LIMITS = {
  /** 분석할 소스 파일 수 (넘으면 오류) */
  maxFiles: 10_000,
  /** 경로 하나의 길이 (넘으면 오류) */
  maxPathLength: 1_024,
  /** 실행기 시간 제한 기본값 (ms) */
  timeoutMs: 120_000,
  /** 실행기 출력 크기 (바이트, 넘으면 오류) */
  maxOutputBytes: 256 * 1024 * 1024,
  /** 결과 목록: 간선 */
  edges: 50_000,
  /** 결과 목록: 풀지 못한 import */
  unresolved: 5_000,
  /** 결과 목록: 블록 하나의 파일 · 공개 파일, 미분류 파일, include 밖 공개 파일 */
  files: 5_000,
  /** 결과 목록: 겹침 */
  overlaps: 500,
  /** 결과 목록: 위반 */
  violations: 1_000,
  /** 순환 하나의 경로 길이 */
  cyclePath: 100,
} as const;

/** 상한으로 자른 목록. `items.length < total`이면 잘린 것이다. */
export interface Capped<T> {
  items: T[];
  total: number;
}

export const capped = <T>(all: readonly T[], max: number): Capped<T> => ({
  items: all.slice(0, max),
  total: all.length,
});
