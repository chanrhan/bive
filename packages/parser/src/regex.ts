// 파일 경로 목록 → dependency-cruiser 규칙의 `path` 정규식 (M3-02 #47, ADR-122 ② · ADR-125 ③).
// - 블록 패턴을 정규식으로 옮기지 않는다. 파일 → 블록은 `matchesBlockPattern`으로 먼저 정하고, 여기서는 그 파일 경로들을 글자
//   그대로 이스케이프해 `^(?:a|b|…)$`로 잇는다. 대안마다 반복 기호가 없는 글자열이라 되돌아감이 대안 수 × 글자 수를 넘지 않는다
// - 정규식 특수 글자는 모두 이스케이프한다. 공백 · 유니코드 · 역슬래시도 글자 그대로 맞는다

const SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** 글자 그대로 맞는 정규식 조각. */
export const escapeRegExpLiteral = (text: string): string => text.replace(SPECIAL, '\\$&');

/** 목록의 경로 가운데 하나와 정확히 같은 글에만 맞는 정규식 (빈 목록은 받지 않는다: 아무것에도 맞지 않는 규칙은 만들지 않는다). */
export const exactPathsRegExp = (paths: readonly string[]): string => {
  if (paths.length === 0) throw new Error('빈 경로 목록으로 정규식을 만들 수 없습니다');
  return `^(?:${paths.map(escapeRegExpLiteral).join('|')})$`;
};

/** 목록의 경로 자체이거나 그 아래에 있는 글에 맞는 정규식 (제외 목록용). */
export const pathsOrBelowRegExp = (paths: readonly string[]): string => {
  if (paths.length === 0) throw new Error('빈 경로 목록으로 정규식을 만들 수 없습니다');
  return `^(?:${paths.map(escapeRegExpLiteral).join('|')})(?:/|$)`;
};
