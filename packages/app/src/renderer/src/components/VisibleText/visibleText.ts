// 에이전트가 쓴 글을 화면에 그릴 때의 표기 (ADR-100 I3 · NFR-03, ADR-089와 같은 글자 범위, M7-15 #227 · ADR-114).
// 규칙의 제목 · 진술은 원문이 저장되고 응답에도 원문이 실린다. 원문을 그대로 그리면 방향 제어 글자(U+202E 등) · 영폭 글자가 든
// 글이 다른 순서 · 다른 글로 보여 사람이 사후에 확인하는 뜻이 없어진다. 그래서 화면에는 숨은 글자를 눈에 보이는 표기로 바꿔 그린다.
// - 바꾸는 글자: 제어(Cc) · 서식(Cf: 양방향 제어 · 영폭 문자 · 태그 문자 등) · 줄 · 문단 구분(Zl · Zp) · 짝 없는 서로게이트(Cs) ·
//   한글 채움 문자 4개 → `\n` · `\r` · `\t` · `\uXXXX`. 역슬래시는 `\\`로 적어 원래 글자 `\n`과 구분한다
//   (오케스트레이터 `displayText`와 같은 표기. 렌더러는 shared를 형식으로만 가져오므로 여기에 다시 적는다, 상한은 두지 않는다)
// - 변형 선택자 · 결합 문자(Mn 등)는 글자를 숨기지 않으므로 그대로 둔다
// - 편집 입력에는 원문을 넣는다(사람이 고칠 수 있어야 한다). 이미 표시 값으로 온 글(`normChange.list`의 사유 · 근거)에는 다시 쓰지
//   않는다(역슬래시가 두 번 바뀐다)
// DOM · React에 의존하지 않는다 (test/visible-text.test.ts).

const NAMED: ReadonlyMap<string, string> = new Map([
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

const escapePiece = (piece: string): string => {
  const named = NAMED.get(piece);
  if (named !== undefined) return named;
  if (!HIDDEN_CATEGORY.test(piece) && !HANGUL_FILLERS.has(piece.codePointAt(0) ?? 0)) return piece;
  let out = '';
  for (let i = 0; i < piece.length; i += 1) out += hex4(piece.charCodeAt(i));
  return out;
};

/** 화면 표기: 숨은 글자를 눈에 보이는 표기로 바꾼 글. 결과에는 숨은 글자가 남지 않는다. */
export const visibleText = (text: string): string => Array.from(text, escapePiece).join('');

/**
 * 여러 줄 글의 화면 표기 (실행기의 실패 메시지 등): 줄바꿈(`\n`)은 줄로 남기고 그 밖의 숨은 글자는 {@link visibleText}와 같은
 * 표기로 바꾼다. 결과에는 줄바꿈 말고 숨은 글자가 남지 않는다.
 */
export const visibleLines = (text: string): string => text.split('\n').map(visibleText).join('\n');
