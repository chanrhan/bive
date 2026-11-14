// 기록 값의 길이 상한 · 표시용 이스케이프 (M2-06, NFR-02 · RUN-08, ADR-089).
// `toolCall.list` 처리기가 도구 이름 · 경로에, 도구 실행기가 저장할 이름 · 경로 요약에, 규칙 작성 서비스가 로그의
// 도구 이름에 쓰는 함수의 경계 사례.
import { describe, expect, it } from 'vitest';

import { clipText, displayText, ELLIPSIS } from '../src/text-limit.js';

/** 이스케이프 결과에 남으면 안 되는 글자: Cc · Cf · Zl · Zp · 짝 없는 서로게이트 · 한글 채움 문자 4개 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\u115f\u1160\u3164\uffa0]/u;

/** 표시 값을 원래 문자열로 되돌린다 (표기가 되돌릴 수 있는지 확인용). */
const decode = (shown: string): string => {
  let out = '';
  for (let i = 0; i < shown.length; i += 1) {
    const char = shown[i] ?? '';
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = shown[i + 1] ?? '';
    if (next === 'u') {
      out += String.fromCharCode(Number.parseInt(shown.slice(i + 2, i + 6), 16));
      i += 5;
    } else {
      out += { '\\': '\\', n: '\n', r: '\r', t: '\t' }[next] ?? `?${next}`;
      i += 1;
    }
  }
  return out;
};

describe('displayText', () => {
  it.each([
    ['\n', '\\n'],
    ['\r', '\\r'],
    ['\t', '\\t'],
    ['\\', '\\\\'],
    ['\u0000', '\\u0000'],
    ['\u001b', '\\u001b'],
    ['\u001f', '\\u001f'],
    ['\u007f', '\\u007f'],
    ['\u0080', '\\u0080'],
    ['\u009f', '\\u009f'],
    ['\u2028', '\\u2028'],
    ['\u2029', '\\u2029'],
    ['\u061c', '\\u061c'],
    ['\u200e', '\\u200e'],
    ['\u200f', '\\u200f'],
    ['\u202a', '\\u202a'],
    ['\u202e', '\\u202e'],
    ['\u2066', '\\u2066'],
    ['\u2069', '\\u2069'],
    ['\ud800', '\\ud800'],
    ['\udfff', '\\udfff'],
    // 서식 문자(Cf): 영폭 문자 · BOM · 단어 결합 · 보이지 않는 연산자 · 소프트 하이픈 · 행간 주석 · 전치 부호
    ['\u200b', '\\u200b'],
    ['\u200c', '\\u200c'],
    ['\u200d', '\\u200d'],
    ['\ufeff', '\\ufeff'],
    ['\u2060', '\\u2060'],
    ['\u2064', '\\u2064'],
    ['\u206a', '\\u206a'],
    ['\u206f', '\\u206f'],
    ['\u00ad', '\\u00ad'],
    ['\u180e', '\\u180e'],
    ['\ufff9', '\\ufff9'],
    ['\ufffb', '\\ufffb'],
    ['\u0600', '\\u0600'],
    // BMP 밖 서식 문자(태그 문자)는 서로게이트 쌍의 두 표기
    ['\u{e0001}', '\\udb40\\udc01'],
    ['\u{e0041}', '\\udb40\\udc41'],
    ['\u{e007f}', '\\udb40\\udc7f'],
    // 한글 채움 문자 (Lo지만 빈칸으로 보인다)
    ['\u115f', '\\u115f'],
    ['\u1160', '\\u1160'],
    ['\u3164', '\\u3164'],
    ['\uffa0', '\\uffa0'],
  ])('%j → %s', (raw, shown) => {
    expect(displayText(raw, 100)).toEqual({ text: shown, truncated: false });
  });

  it('보이는 글자 · 서로게이트 쌍 · 한글 · 변형 선택자 · 결합 문자는 그대로 둔다', () => {
    const raw = 'src/한글/😀/a b~\u00a0\u00e9e\u0301❤\ufe0f.ts';
    expect(displayText(raw, 100)).toEqual({ text: raw, truncated: false });
  });

  it('태그 문자를 붙인 경로는 원래 경로와 다르게 보인다', () => {
    const plain = displayText('src/a.ts', 100).text;
    const tagged = displayText('src/a.ts\u{e0061}\u{e0062}', 100).text;
    expect(plain).toBe('src/a.ts');
    expect(tagged).toBe('src/a.ts\\udb40\\udc61\\udb40\\udc62');
  });

  it('전 범위(0 ~ 0x10FFFF) 어느 코드 포인트도 결과에 숨은 글자로 남지 않고 표기는 원래 글자로 되돌아간다', () => {
    let leftovers = 0;
    let mismatches = 0;
    for (let start = 0; start <= 0x10ffff; start += 0x8000) {
      // 서로게이트끼리 붙어 쌍이 되지 않게 글자 사이에 `a`를 둔다
      const chars: string[] = [];
      for (let code = start; code < Math.min(start + 0x8000, 0x110000); code += 1) {
        chars.push(String.fromCodePoint(code));
      }
      const raw = chars.join('a');
      const { text, truncated } = displayText(raw, raw.length * 12);
      expect(truncated).toBe(false);
      if (HIDDEN.test(text)) leftovers += 1;
      if (decode(text) !== raw) mismatches += 1;
    }
    expect({ leftovers, mismatches }).toEqual({ leftovers: 0, mismatches: 0 });
  });

  it('무작위 입력의 표시 값은 언제나 원래 문자열로 되돌아간다 (일대일)', () => {
    const alphabet = [
      '\\',
      'n',
      'u',
      'd',
      '0',
      '1',
      'b',
      '/',
      '.',
      '\n',
      '\t',
      '\u001b',
      '\u202e',
      '\u200d',
      '\u{e0041}',
      '\ud800',
      '\udc00',
      '😀',
      '한',
    ];
    let seed = 172;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const seen = new Map<string, string>();
    for (let round = 0; round < 3000; round += 1) {
      let raw = '';
      const length = Math.floor(random() * 12);
      for (let i = 0; i < length; i += 1) raw += alphabet[Math.floor(random() * alphabet.length)];
      const { text } = displayText(raw, 10_000);
      expect(text).not.toMatch(HIDDEN);
      expect(decode(text)).toBe(raw);
      const before = seen.get(text);
      if (before !== undefined) expect(before).toBe(raw);
      seen.set(text, raw);
    }
  });

  it('역슬래시를 두 번 적어 원래 글자 `\\n`(두 글자)과 줄바꿈의 표기가 다르다', () => {
    expect(displayText('a\\nb', 100).text).toBe('a\\\\nb');
    expect(displayText('a\nb', 100).text).toBe('a\\nb');
    expect(displayText('a\\u200bb', 100).text).toBe('a\\\\u200bb');
    expect(displayText('a\u200bb', 100).text).toBe('a\\u200bb');
  });

  it('앞을 남기기: 상한 바로 아래 · 정확히 상한은 그대로, 넘으면 결과가 정확히 상한 길이이고 끝이 …', () => {
    expect(displayText('a'.repeat(9), 10)).toEqual({ text: 'a'.repeat(9), truncated: false });
    expect(displayText('a'.repeat(10), 10)).toEqual({ text: 'a'.repeat(10), truncated: false });
    expect(displayText('a'.repeat(11), 10)).toEqual({
      text: `${'a'.repeat(9)}${ELLIPSIS}`,
      truncated: true,
    });
  });

  it('앞을 남기기: 이스케이프 뒤 길이로 상한을 재고, 표기 중간 · 서로게이트 쌍 중간에서 자르지 않는다', () => {
    expect(displayText(`${'a'.repeat(9)}\n`, 10)).toEqual({
      text: `${'a'.repeat(9)}${ELLIPSIS}`,
      truncated: true,
    });
    expect(displayText(`aaaa\u001bzzzz`, 10)).toEqual({ text: `aaaa${ELLIPSIS}`, truncated: true });
    expect(displayText(`${'a'.repeat(8)}😀b`, 10)).toEqual({
      text: `${'a'.repeat(8)}${ELLIPSIS}`,
      truncated: true,
    });
    expect(displayText(`${'a'.repeat(7)}😀bb`, 10)).toEqual({
      text: `${'a'.repeat(7)}😀${ELLIPSIS}`,
      truncated: true,
    });
  });

  it('양 끝 남기기: 앞 1/3 · 뒤 2/3를 남기고 가운데에 …, 정확히 상한이면 그대로', () => {
    expect(displayText('abcdefghij', 10, 'ends')).toEqual({ text: 'abcdefghij', truncated: false });
    // 상한 10 → 남길 몫 9 = 앞 3 + 뒤 6
    expect(displayText('abcdefghijk', 10, 'ends')).toEqual({
      text: `abc${ELLIPSIS}fghijk`,
      truncated: true,
    });
    const path = `${'./'.repeat(2030)}src/ok.ts`;
    const shown = displayText(path, 1024, 'ends');
    expect(shown.truncated).toBe(true);
    expect(shown.text).toHaveLength(1024);
    expect(shown.text.endsWith('/./src/ok.ts')).toBe(true);
  });

  it('양 끝 남기기: 앞 경계 · 뒤 경계 모두 표기 · 서로게이트 쌍 중간에서 자르지 않는다', () => {
    // 상한 10 → 앞 몫 3, 뒤 몫 9 - (앞에서 쓴 길이)
    // 앞 경계에 `\u001b`(6글자)가 걸치면 통째로 빼고, 남는 몫은 뒤가 쓴다
    expect(displayText(`ab\u001bcdefghijklmnop`, 10, 'ends')).toEqual({
      text: `ab${ELLIPSIS}jklmnop`,
      truncated: true,
    });
    // 뒤 경계에 `\n`(2글자)이 걸치면 통째로 뺀다
    expect(displayText(`abcdefghij\nklmno`, 10, 'ends')).toEqual({
      text: `abc${ELLIPSIS}klmno`,
      truncated: true,
    });
    // 앞 경계 · 뒤 경계의 서로게이트 쌍
    expect(displayText(`ab😀cdefghijk`, 10, 'ends')).toEqual({
      text: `ab${ELLIPSIS}efghijk`,
      truncated: true,
    });
    expect(displayText(`abcdefgh😀ijklm`, 10, 'ends')).toEqual({
      text: `abc${ELLIPSIS}ijklm`,
      truncated: true,
    });
    for (const max of [1, 2, 3, 7, 10, 64]) {
      const { text } = displayText(`\u001b😀${'x'.repeat(50)}\n😀\u202e`, max, 'ends');
      expect(text.length).toBeLessThanOrEqual(max);
      expect(text).not.toMatch(HIDDEN);
    }
  });

  it('상한은 1 이상의 정수: 1이면 …만, 0 · 음수 · 소수는 RangeError', () => {
    expect(displayText('abc', 1)).toEqual({ text: ELLIPSIS, truncated: true });
    expect(displayText('abc', 1, 'ends')).toEqual({ text: ELLIPSIS, truncated: true });
    expect(displayText('a', 1)).toEqual({ text: 'a', truncated: false });
    for (const max of [0, -1, 1.5, Number.NaN]) {
      expect(() => displayText('abc', max)).toThrow(RangeError);
      expect(() => clipText('abc', max)).toThrow(RangeError);
    }
  });
});

describe('clipText', () => {
  it('상한 이하면 그대로, 넘으면 코드 포인트 경계에서 잘라 …를 붙인다(글자는 바꾸지 않는다)', () => {
    expect(clipText('a\nb', 3)).toBe('a\nb');
    expect(clipText('a\nbc', 3)).toBe(`a\n${ELLIPSIS}`);
    expect(clipText(`${'a'.repeat(8)}😀b`, 10)).toBe(`${'a'.repeat(8)}${ELLIPSIS}`);
    expect(clipText('a'.repeat(5000), 4096)).toHaveLength(4096);
  });

  it('양 끝 남기기: 뒤쪽 대상 파일 이름이 남는다', () => {
    const path = `${'./'.repeat(3000)}src/ok.ts`;
    const clipped = clipText(path, 4096, 'ends');
    expect(clipped).toHaveLength(4096);
    expect(clipped.endsWith('src/ok.ts')).toBe(true);
    expect(clipped).toContain(ELLIPSIS);
  });
});
