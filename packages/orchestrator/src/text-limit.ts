// 기록 값의 길이 상한 · 표시용 이스케이프 (NFR-02 · RUN-08, M2-06, ADR-089).
// - `clipText`: 저장할 값의 길이 상한. 글자는 바꾸지 않고 코드 포인트 경계에서 잘라 `…`를 붙인다
// - `displayText`: 응답 · 로그에 싣는 값. 제어 문자(Cc) · 서식 문자(Cf: 양방향 제어 · 영폭 문자 · 태그 문자 등) ·
//   줄 · 문단 구분(Zl · Zp) · 짝 없는 서로게이트(Cs) · 한글 채움 문자 4개를 `\n` · `\uXXXX` 표기로 바꾸고
//   역슬래시를 `\\`로 적어(원래 글자 `\n`과 구분) 이스케이프 결과 기준으로 상한을 건다.
//   변형 선택자 · 결합 문자(Mn 등)는 글자를 숨기지 않으므로 그대로 둔다
// 길이는 모두 UTF-16 코드 단위(`String.length`, 결과 스키마의 `max`와 같은 단위)다.

/** 잘린 자리에 들어가는 말줄임 표시 (1글자). */
export const ELLIPSIS = '…';

/**
 * 잘라서 남기는 쪽. `head`는 앞부분 + `…`(도구 이름: 앞이 식별에 쓰인다), `ends`는 앞 1/3 + `…` + 뒤 2/3
 * (경로: 뒤쪽에 실제 대상 파일 이름이 온다).
 */
export type KeepSide = 'head' | 'ends';

const NAMED_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['\\', '\\\\'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
]);

/** 제어(Cc) · 서식(Cf) · 줄 구분(Zl) · 문단 구분(Zp) · 서로게이트(Cs) 범주 */
const HIDDEN_CATEGORY = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]$/u;

/** 범주는 Lo지만 빈칸으로 보이는 한글 채움 문자 (U+115F · U+1160 · U+3164 · U+FFA0) */
const HANGUL_FILLERS: ReadonlySet<number> = new Set([0x115f, 0x1160, 0x3164, 0xffa0]);

const hex4 = (unit: number): string => `\\u${unit.toString(16).padStart(4, '0')}`;

/** 이스케이프할 코드 포인트(조각)인지. */
const needsEscape = (piece: string): boolean =>
  HIDDEN_CATEGORY.test(piece) || HANGUL_FILLERS.has(piece.codePointAt(0) ?? 0);

/**
 * 코드 포인트 단위 조각. 서로게이트 쌍은 한 조각이고 짝 없는 서로게이트는 그 코드 단위 하나가 한 조각이다
 * (`for...of`가 문자열을 이렇게 나눈다).
 */
const codePoints = (text: string): string[] => Array.from(text);

/** 상한을 건 값과 잘렸는지. */
export interface DisplayText {
  text: string;
  /** 상한 때문에 잘렸는지 */
  truncated: boolean;
}

const assertMax = (max: number): void => {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`길이 상한은 1 이상의 정수여야 합니다: ${String(max)}`);
  }
};

/** 앞에서부터 `budget` 안에 들어가는 조각 수와 길이 (`limit` 개까지). */
const takeFront = (pieces: readonly string[], budget: number, limit: number) => {
  let count = 0;
  let used = 0;
  while (count < limit) {
    const piece = pieces[count] ?? '';
    if (used + piece.length > budget) break;
    used += piece.length;
    count += 1;
  }
  return { count, used };
};

/**
 * 조각을 상한 안에서 이어 붙인다. 전부 들어가지 않으면 `…`가 들어갈 자리를 남기고, 조각(표기 · 서로게이트 쌍)
 * 중간이 아닌 곳에서 자른다. 결과는 언제나 `max` 이하다.
 */
const fitPieces = (pieces: readonly string[], max: number, keep: KeepSide): DisplayText => {
  assertMax(max);
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  if (total <= max) return { text: pieces.join(''), truncated: false };
  const budget = max - ELLIPSIS.length;
  const headBudget = keep === 'head' ? budget : Math.floor(budget / 3);
  const head = takeFront(pieces, headBudget, pieces.length);
  if (keep === 'head') {
    return { text: `${pieces.slice(0, head.count).join('')}${ELLIPSIS}`, truncated: true };
  }
  // 뒤에서부터 남은 분량만큼 (앞에서 가져간 조각과 겹치지 않게)
  const reversed = [...pieces].reverse();
  const tail = takeFront(reversed, budget - head.used, pieces.length - head.count);
  const tailText = pieces.slice(pieces.length - tail.count).join('');
  return {
    text: `${pieces.slice(0, head.count).join('')}${ELLIPSIS}${tailText}`,
    truncated: true,
  };
};

/**
 * 저장할 값의 길이 상한: `max`를 넘으면 코드 포인트 경계에서 잘라 `…`를 붙인다(결과는 `max` 이하).
 * 글자는 바꾸지 않는다(감사 기록에는 받은 글자를 그대로 둔다).
 */
export const clipText = (text: string, max: number, keep: KeepSide = 'head'): string => {
  assertMax(max);
  return text.length <= max ? text : fitPieces(codePoints(text), max, keep).text;
};

/** 한 코드 포인트(조각)의 표시 표기. BMP 밖 글자는 서로게이트 쌍의 두 코드 단위를 각각 `\uXXXX`로 적는다. */
const escapePiece = (piece: string): string => {
  const named = NAMED_ESCAPES.get(piece);
  if (named !== undefined) return named;
  if (!needsEscape(piece)) return piece;
  let out = '';
  for (let i = 0; i < piece.length; i += 1) out += hex4(piece.charCodeAt(i));
  return out;
};

/**
 * 표시용 값: 글자마다 표기로 바꾼 결과가 `max`를 넘으면 표기 · 서로게이트 쌍 중간이 아닌 곳에서 잘라 `…`를 넣는다
 * (결과는 `max` 이하). 결과에는 이스케이프할 글자가 남지 않는다. `max`는 1 이상의 정수(아니면 `RangeError`).
 */
export const displayText = (text: string, max: number, keep: KeepSide = 'head'): DisplayText =>
  fitPieces(codePoints(text).map(escapePiece), max, keep);
