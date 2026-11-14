// 기록 값의 길이 상한 · 표시용 이스케이프 (NFR-02 · RUN-08, M2-06, ADR-089).
// - `clipText`: 저장할 값의 길이 상한. 글자는 바꾸지 않고 코드 포인트 경계에서 잘라 `…`를 붙인다
// - `displayText`: 응답에 싣는 값. 보이지 않거나 줄 · 표시 방향을 바꾸는 글자를 `\n` · `\uXXXX` 표기로 바꾸고
//   역슬래시를 `\\`로 적어(원래 글자 `\n`과 구분) 이스케이프 결과 기준으로 상한을 건다
// 길이는 모두 UTF-16 코드 단위(`String.length`, 결과 스키마의 `max`와 같은 단위)다.

/** 잘린 값 끝에 붙는 말줄임 표시 (1글자). */
export const ELLIPSIS = '…';

const NAMED_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

const hex4 = (code: number): string => `\\u${code.toString(16).padStart(4, '0')}`;

/**
 * 이스케이프할 코드 포인트인지: C0(0x00 ~ 0x1F) · DEL(0x7F) · C1(0x80 ~ 0x9F), 줄 구분(U+2028 · U+2029),
 * 양방향 제어(U+061C · U+200E · U+200F · U+202A ~ U+202E · U+2066 ~ U+2069), 짝 없는 서로게이트(U+D800 ~ U+DFFF).
 */
const needsEscape = (code: number): boolean =>
  code <= 0x1f ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x061c ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069) ||
  (code >= 0xd800 && code <= 0xdfff);

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

/** 조각을 상한 안에서 앞에서부터 이어 붙인다. 전부 들어가지 않으면 `…`가 들어갈 자리를 남기고 자른다. */
const joinWithin = (pieces: readonly string[], max: number): DisplayText => {
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  if (total <= max) return { text: pieces.join(''), truncated: false };
  let out = '';
  for (const piece of pieces) {
    if (out.length + piece.length > max - ELLIPSIS.length) break;
    out += piece;
  }
  return { text: `${out}${ELLIPSIS}`, truncated: true };
};

/**
 * 저장할 값의 길이 상한: `max`를 넘으면 코드 포인트 경계에서 잘라 `…`를 붙인다(결과는 `max` 이하).
 * 글자는 바꾸지 않는다(감사 기록에는 받은 글자를 그대로 둔다).
 */
export const clipText = (text: string, max: number): string =>
  text.length <= max ? text : joinWithin(codePoints(text), max).text;

/** 한 코드 포인트(조각)의 표시 표기. */
const escapePiece = (piece: string): string => {
  const named = NAMED_ESCAPES[piece];
  if (named !== undefined) return named;
  const code = piece.codePointAt(0) ?? 0;
  return piece.length === 1 && needsEscape(code) ? hex4(code) : piece;
};

/**
 * 표시용 값: 글자마다 표기로 바꾼 결과가 `max`를 넘으면 표기 · 서로게이트 쌍 중간이 아닌 곳에서 잘라 `…`를 붙인다
 * (결과는 `max` 이하). 결과에는 이스케이프할 글자가 남지 않는다.
 */
export const displayText = (text: string, max: number): DisplayText =>
  joinWithin(codePoints(text).map(escapePiece), max);
