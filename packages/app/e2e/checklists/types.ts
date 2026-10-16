// 화면 체크리스트 형식 (architecture.md 8장). 화면 이슈마다 `scr-XX-<slug>.ts`를 추가하고 index.ts에 등록한다.
// 내용은 docs/spec/screens.md 해당 절의 구성 요소(문구 · 버튼 · 영역)를 옮긴다. 정의 없는 빈 상태는 ADR-029.
import type { Page } from '@playwright/test';

/** 화면 ID. `SCR-01`~`SCR-21`은 screens.md 1.3, `SCR-00`은 앱 공통 틀(셸)이다 (ADR-043). */
export type ScreenId = `SCR-${number}${number}`;

/** 화면 상태 이름. 스크린샷 파일 이름(`<state>.png`)으로도 쓴다. */
export type ScreenState = '기본' | '빈' | '로딩' | '에러';

/** getByRole의 역할 이름. */
export type AriaRole = Parameters<Page['getByRole']>[0];

/**
 * 화면에 있어야 할(또는 없어야 할) 요소 하나.
 * 선택자(`testId` · `role`)를 주면 둘 다 맞는 요소를 찾고 `text`는 그 요소의 전체 문구로 검사한다.
 * 선택자 없이 `text`만 주면 그 문구와 정확히 같은 요소를 찾는다. 셋 중 하나는 있어야 한다.
 */
export interface ElementCheck {
  /** 실패 메시지에 쓰는 설명 (예: '연결 상태 문구'). */
  label: string;
  /** `data-testid` 값. */
  testId?: string;
  /** 접근성 역할. */
  role?: AriaRole;
  /** 역할의 접근 가능한 이름 (role과 함께, 문자열이면 정확히 일치). */
  name?: string | RegExp;
  /** 문구. 문자열이면 공백 정규화 뒤 정확히 일치, 정규식이면 일치. */
  text?: string | RegExp;
  /** 속성 값 (예: `{ 'data-state': 'connected' }`). */
  attributes?: Record<string, string | RegExp>;
  /** 일치하는 요소 수. 생략하면 1개 이상이고 첫 요소가 보여야 한다. */
  count?: number;
  /** true면 이 요소가 보이지 않아야 한다 (미노출 검사, ADR-035). */
  absent?: true;
}

/** 한 상태의 체크리스트. */
export interface StateChecklist {
  /** 문서 제목 (`<title>`). */
  title?: string;
  elements: readonly ElementCheck[];
}

/** 화면 하나의 체크리스트. 정의하지 않은 상태를 검사하면 expectScreen이 실패한다. */
export interface ScreenChecklist {
  id: ScreenId;
  /** 화면 이름 (screens.md 1.3). */
  name: string;
  states: Partial<Record<ScreenState, StateChecklist>>;
}
