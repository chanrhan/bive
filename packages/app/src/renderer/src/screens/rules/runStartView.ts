// 실행 시작 확인의 문구 · 오류 해석 (screens.md SCR-03 [실행] "선택 규칙으로 실행 생성 (= 실행 시작 확인)", 1.1 문구,
// NFR-07, M1-19 · ADR-076). DOM · React에 의존하지 않는다 (test/run-start-view.test.ts).
// 화면 정의서에 대화 문구가 없어 1.1(명사형 · 짧은 문구)로 정했다. 설정 미비 문구는 설정 화면(SCR-21)과 같다.

export const RUN_START_TEXT = {
  /** 규칙 상세의 버튼 (screens.md SCR-03 [실행]) */
  run: '실행',
  title: '실행 시작 확인',
  targets: '대상 규칙',
  confirm: '시작',
  cancel: '취소',
  /** -32010 `SETTINGS_INCOMPLETE` (shared `SETTINGS_INCOMPLETE_MESSAGE`와 같음, 시험이 대조한다) */
  settingsIncomplete: '예산 · 모델 미설정',
  failed: '실행 시작 실패',
} as const;

/** 설정 미비 오류 코드 (shared `ErrorCode.SettingsIncomplete`, 시험이 대조한다). */
export const SETTINGS_INCOMPLETE_CODE = -32010;

/** `run.create` 거부 → 대화에 보일 문구. 설정 미비(-32010)만 따로, 나머지는 "실행 시작 실패". */
export const runStartErrorText = (error: unknown): string =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === SETTINGS_INCOMPLETE_CODE
    ? RUN_START_TEXT.settingsIncomplete
    : RUN_START_TEXT.failed;
