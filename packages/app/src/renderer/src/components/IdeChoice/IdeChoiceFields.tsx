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
}

export const IdeChoiceFields = ({
  value,
  onChange,
  disabled = false,
  invalid = false,
}: IdeChoiceFieldsProps): React.JSX.Element => {
  const name = useId();
  const select = (kind: IdeKind): void => onChange({ ...value, kind });
  return (
    <fieldset className="ide-choice" data-testid="ide-choice" disabled={disabled}>
      <legend className="ide-choice-legend">{IDE_TEXT.group}</legend>
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
        disabled={value.kind !== 'custom'}
        value={value.template}
        onChange={(event) => onChange({ kind: 'custom', template: event.target.value })}
      />
    </fieldset>
  );
};
