// 에이전트가 쓴 글의 화면 표기 (M7-15 #227, ADR-100 I3 · ADR-089 · ADR-114). 숨은 글자는 시험 파일에도 이스케이프 표기로만 쓴다.
import { describe, expect, it } from 'vitest';

import { visibleText } from '../src/renderer/src/components/VisibleText/visibleText.js';

describe('visibleText', () => {
  it('보통 글 · 한글 · 결합 문자 · 변형 선택자는 그대로', () => {
    expect(visibleText('WHEN 결제를 요청하면 THE SYSTEM SHALL 거부한다')).toBe(
      'WHEN 결제를 요청하면 THE SYSTEM SHALL 거부한다',
    );
    // 결합 문자(Mn) · 변형 선택자는 글자를 숨기지 않는다
    expect(visibleText('e\u0301 a\ufe0e')).toBe('e\u0301 a\ufe0e');
  });

  it('방향 제어 글자(Cf)는 \\uXXXX 표기로: 글 순서가 바뀌어 보이지 않는다', () => {
    expect(visibleText('통과 \u202e패실\u202c')).toBe('통과 \\u202e패실\\u202c');
    expect(visibleText('\u2066a\u2069\u200f')).toBe('\\u2066a\\u2069\\u200f');
  });

  it('영폭 · 태그 · 한글 채움 · 줄 구분 · 짝 없는 서로게이트도 표기로', () => {
    expect(visibleText('a\u200bb\u2060c\ufeff')).toBe('a\\u200bb\\u2060c\\ufeff');
    expect(visibleText('\u{e0041}')).toBe('\\udb40\\udc41');
    expect(visibleText('\u3164\u115f\u1160\uffa0')).toBe('\\u3164\\u115f\\u1160\\uffa0');
    expect(visibleText('a\u2028b\u2029c')).toBe('a\\u2028b\\u2029c');
    expect(visibleText('x\ud800y')).toBe('x\\ud800y');
  });

  it('줄바꿈 · 탭은 \\n · \\t, 역슬래시는 \\\\ (원래 글자 \\n과 구분)', () => {
    expect(visibleText('한 줄\n두 줄\r\t끝')).toBe('한 줄\\n두 줄\\r\\t끝');
    expect(visibleText('경로 a\\n')).toBe('경로 a\\\\n');
    expect(visibleText('\u0007')).toBe('\\u0007');
  });
});
