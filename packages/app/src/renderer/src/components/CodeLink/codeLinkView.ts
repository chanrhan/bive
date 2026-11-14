// 코드 열기 링크의 문구 · 대상 판단 (screens.md 1.4 코드 열기 · 1.1 문구, MET-01, ADR-084). DOM · React에 의존하지 않는다
// (test/code-link-view.test.ts). renderer는 shared를 import type으로만 가져오므로 사유 표시명 · 경로 판단을 다시 적고,
// 시험이 shared의 `CODE_OPEN_REASON_LABELS` · `isProjectRelativePath`와 같은지 대조한다.
import type { CodeOpenReason } from '@bive/shared';

/** 사유 표시명 (shared CODE_OPEN_REASON_LABELS와 같음). 순서가 모달의 버튼 순서다. */
export const CODE_OPEN_REASON_LABELS = {
  screen_error: '화면 오류',
  info_lacking: '정보 부족',
  debugging: '디버깅',
} as const satisfies Record<CodeOpenReason, string>;

export const CODE_OPEN_REASONS = Object.keys(CODE_OPEN_REASON_LABELS) as CodeOpenReason[];

export const CODE_LINK_TEXT = {
  /** 링크 툴팁 */
  open: '코드 열기',
  /** 사유 모달 제목 */
  title: '코드 열기 사유',
  file: '파일',
  cancel: '취소',
  /** 기록 · 열기 실패 (prototype-map.md `CodeOpenLink` 에러 상태) */
  failed: 'IDE 열기 실패',
} as const;

/** 경로 최대 길이 (shared `CODE_FILE_PATH_MAX_LENGTH`와 같음). */
const MAX_LENGTH = 1024;

/**
 * 프로젝트 루트 기준 상대 경로인지 (shared `isProjectRelativePath`와 같은 기준). 아니면 링크를 붙이지 않고 글자만 보인다
 * (main · 오케스트레이터도 같은 기준으로 거부한다).
 */
export const isLinkableFile = (value: string): boolean => {
  if (value.length === 0 || value.length > MAX_LENGTH) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  if (value.includes('\\') || value.includes(':')) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
};

/** 링크를 붙일 줄 번호: 줄이 있고(1 이상 정수) 파일이 상대 경로면 그 줄, 아니면 `null`(글자만 보인다). */
export const linkableLine = ({
  file,
  line,
}: {
  file: string;
  line: number | null;
}): number | null =>
  line !== null && Number.isSafeInteger(line) && line >= 1 && isLinkableFile(file) ? line : null;
