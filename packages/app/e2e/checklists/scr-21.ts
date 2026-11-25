// SCR-21 설정 (screens.md 7장 X-02, ADR-010 · ADR-035 · ADR-057): 사이드바 하단 톱니 → 모달(820 × 600).
// 예산 · 모델 섹션: 실행 전체 한도(USD · 턴) + 프로젝트 하루 한도(USD, 비움 허용, M7-04 · ADR-104)
// + 역할별(rule-writer · test-writer · implementer) 모델 · 한도.
// 섹션 목록에는 IDE(코드 열기, ADR-018 · ADR-087)가 하나 더 있다. 기본 상태는 예산 · 모델이 골라져 있다.
// 나머지 섹션(잠정 승인 · 자동 모드 · 대기열 · 작성 규칙)과 planner · 채팅 역할 행은 DOM에 없다.
// 상태: 기본 = 모달 열림 · 저장된 설정(검증 통과), 빈 = 미설정(한 번도 저장하지 않음, 화면 정의서에 정의 없음 · ADR-029).
import type { ElementCheck, ScreenChecklist, StateChecklist } from './types.js';

export const SETTINGS_TEXT = {
  title: '설정',
  section: '예산 · 모델',
  run: '실행 전체',
  daily: '프로젝트 하루',
  dailyNote: '비움: 한도 없음 · 자동 시작 없음',
  roles: '역할별',
  save: '저장',
  close: '닫기',
  complete: '설정 완료',
  incomplete: '예산 · 모델 미설정',
  saved: '저장됨',
  noProject: '프로젝트 없음',
} as const;

/** IDE 섹션 문구 (ADR-018 · ADR-087). */
export const IDE_TEXT = {
  section: 'IDE',
  unset: 'IDE 미설정',
  customField: '사용자 지정 URL 틀',
  /** 사용자 지정 틀 입력 아래 자리 표시 안내 (#201 · ADR-124, ADR-087의 `{path}` 값 형태) */
  pathHint: '{path}: 맨 앞 / 뺀 절대 경로 · {line}: 줄 번호',
} as const;

/** 보이는 역할 행 (화면 정의서 명칭). */
export const ROLE_ROWS = ['rule-writer', 'test-writer', 'implementer'] as const;

/** 입력 칸의 접근 가능한 이름 (행 + 열). */
export const FIELD_NAMES = [
  '실행 전체 한도 USD',
  '실행 전체 턴',
  ...ROLE_ROWS.flatMap((role) => [`${role} 모델`, `${role} 한도 USD`, `${role} 턴`]),
] as const;

/** 프로젝트 하루 한도 입력 칸의 접근 가능한 이름 (필수 칸이 아니라 `FIELD_NAMES`와 따로 둔다, ADR-104). */
export const DAILY_FIELD_NAME = '프로젝트 하루 한도 USD';

/** 미노출 섹션 (ADR-035). 기능을 여는 이슈가 이 목록에서 빼고 체크리스트를 고친다. */
export const HIDDEN_SECTIONS = ['잠정 승인', '자동 모드', '대기열', '작성 규칙'] as const;

const modal = (validation: string): StateChecklist => {
  const elements: ElementCheck[] = [
    { label: '설정 모달', testId: 'settings-modal', role: 'dialog', name: SETTINGS_TEXT.title },
    { label: '모달 바깥', testId: 'settings-modal-backdrop' },
    { label: '섹션 목록', role: 'navigation', name: '설정 섹션' },
    {
      label: '섹션 목록 예산 · 모델 (선택됨)',
      testId: 'settings-nav-budget-model',
      text: SETTINGS_TEXT.section,
      attributes: { 'aria-current': 'page' },
    },
    {
      label: '섹션 목록 IDE',
      testId: 'settings-nav-ide',
      role: 'button',
      name: IDE_TEXT.section,
    },
    { label: '섹션 제목', role: 'heading', name: SETTINGS_TEXT.section },
    { label: '실행 전체 묶음', role: 'group', name: SETTINGS_TEXT.run },
    { label: '프로젝트 하루 묶음', role: 'group', name: SETTINGS_TEXT.daily },
    { label: '입력 칸 프로젝트 하루 한도', role: 'textbox', name: DAILY_FIELD_NAME },
    { label: '하루 한도 안내', testId: 'settings-daily-note', text: SETTINGS_TEXT.dailyNote },
    { label: '역할별 묶음', role: 'group', name: SETTINGS_TEXT.roles },
    ...ROLE_ROWS.map((role): ElementCheck => ({
      label: `역할 행 ${role}`,
      testId: `settings-role-${role}`,
      role: 'row',
    })),
    ...FIELD_NAMES.map((name): ElementCheck => ({
      label: `입력 칸 ${name}`,
      role: 'textbox',
      name,
    })),
    { label: '저장 버튼', testId: 'settings-save', role: 'button', name: SETTINGS_TEXT.save },
    {
      label: '닫기 버튼',
      testId: 'settings-modal-close',
      role: 'button',
      name: SETTINGS_TEXT.close,
    },
    { label: '검증 상태', testId: 'settings-validation', text: validation },
    // 미노출: 다음 마일스톤 섹션 · 역할 행 (ADR-035)
    ...HIDDEN_SECTIONS.map((text): ElementCheck => ({
      label: `미노출 섹션 ${text}`,
      text,
      absent: true,
    })),
    { label: '미노출 역할 행 planner', testId: 'settings-role-planner', absent: true },
    { label: '미노출 역할 행 chat', testId: 'settings-role-chat', absent: true },
  ];
  return { title: 'BIVE', elements };
};

export const settingsChecklist = {
  id: 'SCR-21',
  name: '설정',
  states: {
    기본: modal(SETTINGS_TEXT.complete),
    빈: modal(SETTINGS_TEXT.incomplete),
  },
} satisfies ScreenChecklist;
