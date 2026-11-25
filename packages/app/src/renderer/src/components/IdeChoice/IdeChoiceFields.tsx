// 코드 열기 IDE 선택 칸 (ADR-018 · ADR-087): VS Code · Cursor · 사용자 지정 URL 틀 중 하나를 고르는 라디오 묶음.
// 설정 모달의 IDE 섹션과 코드 열기 링크의 첫 선택 단계가 같이 쓴다. 값은 부모가 들고 저장도 부모가 한다.
import './IdeChoice.css';

import type { IdeKind } from '@bive/shared';
import { useId } from 'react';

import {
  BUILTIN_IDE_TEMPLATES,
  IDE_KIND_LABELS,
  IDE_KINDS,
  IDE_TEXT,
  type IdeChoice,
} from './ideChoiceView.js';

export interface IdeChoiceFieldsProps {
  value: IdeChoice;
  onChange: (next: IdeChoice) => void;
  disabled?: boolean;
  /** 사용자 지정 틀이 틀렸음(저장 거부) */
  invalid?: boolean;
  /**
   * 참이면 묶음 이름(legend "IDE")을 화면에서만 숨긴다. 같은 글자의 제목이 바로 위에 있는 설정 IDE 섹션용. 접근 가능한 이름은
   * 그대로 legend에서 온다 (#201 · ADR-124)
   */
  legendHidden?: boolean;
  /** 참이면 사용자 지정 틀 입력 아래에 자리 표시 안내(`IDE_TEXT.pathHint`)를 두고 입력의 설명으로 잇는다 (#201 · ADR-124) */
  pathHint?: boolean;
}

export const IdeChoiceFields = ({
  value,
  onChange,
  disabled = false,
  invalid = false,
  legendHidden = false,
  pathHint = false,
}: IdeChoiceFieldsProps): React.JSX.Element => {
  const name = useId();
  const hintId = useId();
  const select = (kind: IdeKind): void => onChange({ ...value, kind });
  return (
    <fieldset className="ide-choice" data-testid="ide-choice" disabled={disabled}>
      <legend
        className={legendHidden ? 'ide-choice-legend visually-hidden' : 'ide-choice-legend'}
        data-testid="ide-choice-legend"
      >
        {IDE_TEXT.group}
      </legend>
      {IDE_KINDS.map((kind) => (
        <label key={kind} className="ide-choice-option" data-testid={`ide-option-${kind}`}>
          <input
            type="radio"
            name={name}
            value={kind}
            checked={value.kind === kind}
            onChange={() => select(kind)}
          />
          <span className="ide-choice-label" data-testid={`ide-label-${kind}`}>
            {IDE_KIND_LABELS[kind]}
          </span>
          {kind !== 'custom' && (
            <span className="ide-choice-template" data-testid={`ide-template-${kind}`}>
              {BUILTIN_IDE_TEMPLATES[kind]}
            </span>
          )}
        </label>
      ))}
      <input
        className="ide-choice-input"
        type="text"
        autoComplete="off"
        spellCheck={false}
        data-testid="ide-custom-template"
        data-state={invalid ? 'invalid' : 'filled'}
        aria-label={`${IDE_KIND_LABELS.custom} ${IDE_TEXT.template}`}
        aria-invalid={invalid}
        aria-describedby={pathHint ? hintId : undefined}
        disabled={value.kind !== 'custom'}
        value={value.template}
        onChange={(event) => onChange({ kind: 'custom', template: event.target.value })}
      />
      {pathHint && (
        <span className="ide-choice-hint" id={hintId} data-testid="ide-path-hint">
          {IDE_TEXT.pathHint}
        </span>
      )}
    </fieldset>
  );
};
