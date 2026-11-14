// 기록 값의 길이 상한 · 표시용 이스케이프 (M2-06, NFR-02 · RUN-08, ADR-089).
// `toolCall.list` 처리기가 도구 이름 · 경로에, 도구 실행기가 저장할 이름 · 경로 요약에 쓰는 함수의 경계 사례.
import { describe, expect, it } from 'vitest';

import { clipText, displayText, ELLIPSIS } from '../src/text-limit.js';

/** 이스케이프 결과에 남으면 안 되는 글자 */
const UNSAFE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;

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
  ])('%j → %s', (raw, shown) => {
    expect(displayText(raw, 100)).toEqual({ text: shown, truncated: false });
  });

  it('보이는 글자 · 서로게이트 쌍 · 한글은 그대로 둔다', () => {
    const raw = 'src/한글/😀/a b~\u00a0\u00e9.ts';
    expect(displayText(raw, 100)).toEqual({ text: raw, truncated: false });
  });

  it('역슬래시를 두 번 적어 원래 글자 `\\n`(두 글자)과 줄바꿈의 표기가 다르다', () => {
    expect(displayText('a\\nb', 100).text).toBe('a\\\\nb');
    expect(displayText('a\nb', 100).text).toBe('a\\nb');
  });

  it('상한 바로 아래 · 정확히 상한은 그대로, 넘으면 결과가 정확히 상한 길이이고 끝이 …', () => {
    expect(displayText('a'.repeat(9), 10)).toEqual({ text: 'a'.repeat(9), truncated: false });
    expect(displayText('a'.repeat(10), 10)).toEqual({ text: 'a'.repeat(10), truncated: false });
    expect(displayText('a'.repeat(11), 10)).toEqual({
      text: `${'a'.repeat(9)}${ELLIPSIS}`,
      truncated: true,
    });
  });

  it('이스케이프 뒤 길이로 상한을 재고, 표기 중간 · 서로게이트 쌍 중간에서 자르지 않는다', () => {
    // 원래 10글자지만 표기는 11글자
    expect(displayText(`${'a'.repeat(9)}\n`, 10)).toEqual({
      text: `${'a'.repeat(9)}${ELLIPSIS}`,
      truncated: true,
    });
    // `\u001b`(6글자)는 들어갈 자리가 모자라면 통째로 뺀다
    expect(displayText(`aaaa\u001bzzzz`, 10)).toEqual({ text: `aaaa${ELLIPSIS}`, truncated: true });
    // 서로게이트 쌍은 통째로 넣거나 뺀다
    expect(displayText(`${'a'.repeat(8)}😀b`, 10)).toEqual({
      text: `${'a'.repeat(8)}${ELLIPSIS}`,
      truncated: true,
    });
    expect(displayText(`${'a'.repeat(7)}😀bb`, 10)).toEqual({
      text: `${'a'.repeat(7)}😀${ELLIPSIS}`,
      truncated: true,
    });
  });

  it('결과에는 제어 · 줄 구분 · 양방향 제어 글자와 짝 없는 서로게이트가 남지 않고 JSON 왕복이 같다', () => {
    let raw = '';
    for (let code = 0; code <= 0xa0; code += 1) raw += String.fromCharCode(code);
    raw += '\u2028\u2029\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069';
    raw += '\ud800x\udc00😀\ud83d';
    for (const max of [5000, 200, 37]) {
      const { text } = displayText(raw, max);
      expect(text.length).toBeLessThanOrEqual(max);
      // u 플래그라 서로게이트 범위는 짝 없는 서로게이트에만 맞는다
      expect(text).not.toMatch(UNSAFE);
      expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
      expect(JSON.parse(JSON.stringify({ text })).text).toBe(text);
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
});
