// SCR-01 프로젝트 시작 (screens.md SCR-01, PRJ-01, M1-01).
// 구성 요소 중 P0 [폴더 열기]만 둔다. [BIVE 동기화](P1, M4) · [요구사항 자동 생성](P2, M6)은
// DOM에 없어야 한다 (ADR-035 · ADR-036). 화면 정의서에 없는 상태 중 에러는 "폴더 열기 실패" 한 줄(ADR-055).
import type { ElementCheck, ScreenChecklist, StateChecklist } from './types.js';

export const PROJECT_START_TEXT = {
  title: '프로젝트 시작',
  openFolder: '폴더 열기',
  sync: 'BIVE 동기화',
  generate: '요구사항 자동 생성',
  openFailed: '폴더 열기 실패',
} as const;

/** 이 단계에서 노출하지 않는 버튼 (어느 상태 · 어느 화면에서도 DOM에 없어야 한다). */
export const HIDDEN_BUTTONS = [PROJECT_START_TEXT.sync, PROJECT_START_TEXT.generate] as const;

const base: ElementCheck[] = [
  { label: '시작 화면', testId: 'project-start', role: 'region', name: PROJECT_START_TEXT.title },
  { label: '제목', role: 'heading', name: PROJECT_START_TEXT.title },
  {
    label: '[폴더 열기]',
    testId: 'open-folder',
    role: 'button',
    name: PROJECT_START_TEXT.openFolder,
  },
  { label: '사이드바 프로젝트명 자리', testId: 'sidebar-project', text: '프로젝트 없음' },
  ...HIDDEN_BUTTONS.map((name): ElementCheck => ({
    label: `[${name}] 미노출`,
    role: 'button',
    name,
    absent: true,
  })),
];

const state = (extra: ElementCheck[]): StateChecklist => ({
  title: 'BIVE',
  elements: [...base, ...extra],
});

export const projectStartChecklist = {
  id: 'SCR-01',
  name: '프로젝트 시작',
  states: {
    기본: state([{ label: '오류 문구 없음', testId: 'project-start-error', absent: true }]),
    에러: state([
      {
        label: '오류 문구',
        testId: 'project-start-error',
        role: 'alert',
        text: PROJECT_START_TEXT.openFailed,
      },
    ]),
  },
} satisfies ScreenChecklist;
