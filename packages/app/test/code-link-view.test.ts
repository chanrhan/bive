// 코드 열기 링크의 문구 · 대상 판단 (이슈 #43, screens.md 1.4 코드 열기 · 1.1, MET-01 · ADR-084).
// renderer는 shared를 import type으로만 쓰므로 값을 다시 적는다. 여기서 shared 원본과 대조한다.
import { CODE_OPEN_REASON_LABELS as SHARED_LABELS, isProjectRelativePath } from '@bive/shared';
import { describe, expect, it } from 'vitest';

import {
  CODE_OPEN_REASON_LABELS,
  CODE_OPEN_REASONS,
  isLinkableFile,
  linkableLine,
} from '../src/renderer/src/components/CodeLink/codeLinkView.js';

const PATHS = [
  'a.ts',
  'src/app/page.tsx',
  'bive-acceptance/RULE-002/cancel.acc.ts',
  '.config/x.ts',
  'src/화면 목록/a b.ts',
  '',
  '/etc/passwd',
  'C:\\a.ts',
  'C:a.ts',
  '\\\\server\\a.ts',
  '../a.ts',
  'a/../../b.ts',
  './a.ts',
  'a//b.ts',
  'a/',
  'a\\b.ts',
  'a.ts:18',
  'a\u0000.ts',
  'a\n.ts',
  'a\u007f.ts',
  'a\u0085.ts',
  // 양방향 제어 문자 (#45 코멘트 5): 링크 글자가 뒤집혀 보이지 않게 거부
  'src/a‮sts.ts',
  'a‪.ts',
  'a⁦.ts',
  'a⁩.ts',
  'a‎.ts',
  'a‏.ts',
  'a؜.ts',
  // 퍼센트 (#184 검토 1회차): 중첩 디코딩에서 `%2e%2e`가 `..`가 되지 않게 거부
  'bive-acceptance/%2e%2e/etc/passwd',
  'a%20b.ts',
  // 경계 바로 밖의 글자는 그대로 허용 (U+2029 문단 구분자 · U+206A)
  'a .ts',
  'a⁪.ts',
  'a'.repeat(1024),
  'a'.repeat(1025),
];

describe('코드 열기 링크', () => {
  it('사유 표시명 · 순서가 shared와 같다 (화면 오류 · 정보 부족 · 디버깅)', () => {
    expect(CODE_OPEN_REASON_LABELS).toEqual(SHARED_LABELS);
    expect(CODE_OPEN_REASONS).toEqual(['screen_error', 'info_lacking', 'debugging']);
  });

  it.each(PATHS)('경로 %j의 링크 판단이 shared(main · 오케스트레이터 기준)와 같다', (file) => {
    expect(isLinkableFile(file)).toBe(isProjectRelativePath(file));
  });

  it('줄이 없거나 1 이상 정수가 아니거나 경로가 상대 경로가 아니면 링크 없음', () => {
    expect(linkableLine({ file: 'src/a.ts', line: 18 })).toBe(18);
    expect(linkableLine({ file: 'src/a.ts', line: null })).toBeNull();
    expect(linkableLine({ file: 'src/a.ts', line: 0 })).toBeNull();
    expect(linkableLine({ file: 'src/a.ts', line: 1.5 })).toBeNull();
    expect(linkableLine({ file: '../a.ts', line: 3 })).toBeNull();
    expect(linkableLine({ file: '/abs/a.ts', line: 3 })).toBeNull();
  });
});
