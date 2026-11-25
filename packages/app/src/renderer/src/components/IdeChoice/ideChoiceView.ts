// 코드 열기 IDE 선택의 문구 · 값 변환 (ADR-018 · ADR-087). DOM · React에 의존하지 않는다(test/ide-choice-view.test.ts).
// renderer는 shared를 import type으로만 가져오므로 내장 틀을 다시 적고, 시험이 shared `IDE_URL_TEMPLATES`와 대조한다.
// 사용자 지정 틀의 허용 범위(스킴 · 호스트 · 자리 표시자)는 저장할 때 오케스트레이터가 검사한다(-32602 → "입력 오류").
import type { IdeKind, IdeSetting } from '@bive/shared';

/** 선택지 표시명. 순서가 화면 순서다. */
export const IDE_KIND_LABELS = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  custom: '사용자 지정',
} as const satisfies Record<IdeKind, string>;

export const IDE_KINDS = Object.keys(IDE_KIND_LABELS) as IdeKind[];

/** 내장 선택의 URL 틀 (shared `IDE_URL_TEMPLATES`와 같음). 선택지 옆에 보인다. */
export const BUILTIN_IDE_TEMPLATES = {
  vscode: 'vscode://file/{path}:{line}',
  cursor: 'cursor://file/{path}:{line}',
} as const satisfies Record<Exclude<IdeKind, 'custom'>, string>;

/** 미설정일 때 미리 골라 두는 선택 (ADR-018 기본값). */
export const DEFAULT_IDE_KIND: IdeKind = 'vscode';

export const IDE_TEXT = {
  /** 설정 섹션 · 선택 단계 제목 */
  title: 'IDE',
  stepTitle: 'IDE 선택',
  /** 선택지 묶음 이름 */
  group: 'IDE',
  template: 'URL 틀',
  /**
   * 사용자 지정 틀 입력 아래 안내 (설정 IDE 섹션, #201 · ADR-124). 자리 표시 `{path}` · `{line}`은 사용자가 입력에 그대로 적는 글자라
   * 내장 틀 표기(`vscode://file/{path}:{line}`)와 같은 모양으로 보인다. 값의 형태는 ADR-087(맨 앞 `/` 하나를 뺀 절대 경로)
   */
  pathHint: '{path}: 맨 앞 / 뺀 절대 경로 · {line}: 줄 번호',
  unset: 'IDE 미설정',
  confirm: '확인',
} as const;

/** 입력 상태: 고른 종류 + 사용자 지정 틀 입력 칸의 글자. */
export interface IdeChoice {
  kind: IdeKind;
  template: string;
}

/** 저장된 선택 → 입력 상태. 미설정이면 VS Code를 미리 고른다. */
export const toIdeChoice = (setting: IdeSetting | null): IdeChoice =>
  setting === null
    ? { kind: DEFAULT_IDE_KIND, template: '' }
    : { kind: setting.kind, template: setting.kind === 'custom' ? setting.template : '' };

/** 입력 상태 → 저장 값. 사용자 지정의 틀이 비어 있으면 `null`(입력 오류). 앞뒤 공백은 뗀다. */
export const toIdeSetting = (choice: IdeChoice): IdeSetting | null => {
  if (choice.kind !== 'custom') return { kind: choice.kind };
  const template = choice.template.trim();
  return template === '' ? null : { kind: 'custom', template };
};
