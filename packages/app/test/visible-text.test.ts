// 에이전트가 쓴 글의 화면 표기 (M7-15 #227, ADR-100 I3 · ADR-089 · ADR-114). 숨은 글자는 시험 파일에도 이스케이프 표기로만 쓴다.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  visibleDisplayText,
  visibleLines,
  visibleText,
} from '../src/renderer/src/components/VisibleText/visibleText.js';

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

describe('visibleLines (여러 줄 메시지)', () => {
  it('줄바꿈은 줄로 남기고 그 밖의 숨은 글자는 표기로', () => {
    expect(visibleLines('첫 줄\u200b\n둘째 \u202e줄')).toBe('첫 줄\\u200b\n둘째 \\u202e줄');
    expect(visibleLines('a\r\nb\tc')).toBe('a\\r\nb\\tc');
  });

  it('줄 구분(U+2028) · 문단 구분(U+2029)은 줄을 만들지 않고 표기로 (줄은 LF만, M3-35 #263)', () => {
    const shown = visibleLines('첫 줄\u2028둘째\u2029셋째\n넷째');
    expect(shown).toBe('첫 줄\\u2028둘째\\u2029셋째\n넷째');
    // 결과에 남는 줄 나눔 글자는 LF 하나뿐이다 (CR · VT · FF · NEL · U+2028 · U+2029 없음)
    expect(shown.split('\n')).toHaveLength(2);
    expect(shown).not.toMatch(/[\r\v\f\u0085\u2028\u2029]/);
  });
});

/** 오케스트레이터 `displayText`의 모양 (패키지 경계 밖이라 경로로 불러온다, 형식만 적는다). */
interface DisplayTextModule {
  displayText: (text: string, max: number) => { text: string; truncated: boolean };
}

describe('오케스트레이터 displayText와 같은 표기 (검토 1회차 N2: 두 구현이 따로 놀지 않게)', () => {
  // 제어 · 방향 제어 · 폭 없는 글자 · 태그 글자 · BOM · 짝 없는 서로게이트 · 한글 채움 문자 · 줄 나눔 + 이름 표기 · 보통 글
  const INPUTS = [
    'a\u0007b\u001bc\u007f',
    '통과 \u202e패실\u202c \u2066x\u2069 \u200e\u200f',
    'a\u200bb\u200cc\u200dd\u2060e',
    '\u{e0041}\u{e007f}',
    '\ufeff앞',
    'x\ud800y\udfffz',
    '\u3164\u115f\u1160\uffa0',
    'a\u2028b\u2029c\u0085d',
    '줄\n바꿈\r탭\t역슬래시\\끝',
    'WHEN 결제를 요청하면 THE SYSTEM SHALL 거부한다 e\u0301 a\ufe0e',
  ];

  it('같은 입력 표에서 결과가 같다 (상한에 걸리지 않는 길이)', async () => {
    const source = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../orchestrator/src/text-limit.ts',
    );
    const { displayText } = (await import(pathToFileURL(source).href)) as DisplayTextModule;
    for (const input of INPUTS) {
      const expected = displayText(input, 10_000);
      expect(expected.truncated, input).toBe(false);
      expect(visibleText(input), input).toBe(expected.text);
    }
  });

  it('표시 값(displayText 결과)에 visibleDisplayText를 다시 거쳐도 글이 같다 (두 번 바뀌지 않음, M7-14 · ADR-119)', async () => {
    const source = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../orchestrator/src/text-limit.ts',
    );
    const { displayText } = (await import(pathToFileURL(source).href)) as DisplayTextModule;
    for (const input of INPUTS) {
      const shown = displayText(input, 10_000).text;
      expect(visibleDisplayText(shown), input).toBe(shown);
      // 원문을 그대로 받아도 숨은 글자는 남지 않는다 (역슬래시만 그대로)
      expect(visibleDisplayText(input), input).toBe(visibleText(input).replaceAll('\\\\', '\\'));
    }
  });
});

describe('visibleDisplayText (이미 표시 값으로 온 글)', () => {
  it('역슬래시 표기는 그대로, 섞여 온 숨은 글자만 표기로', () => {
    // 이미 표기된 글: 바뀌지 않는다 (역슬래시가 둘이 되지 않음)
    expect(visibleDisplayText('사유 \\u202e 경로 a\\\\n')).toBe('사유 \\u202e 경로 a\\\\n');
    // 원문 글자가 섞여 오면 그 글자만 표기로
    expect(visibleDisplayText('통과 \u202e패실\u202c')).toBe('통과 \\u202e패실\\u202c');
    expect(visibleDisplayText('a\nb\t\u200b')).toBe('a\\nb\\t\\u200b');
    // 두 번 거쳐도 같다
    const once = visibleDisplayText('통과 \u202e패실');
    expect(visibleDisplayText(once)).toBe(once);
  });
});
