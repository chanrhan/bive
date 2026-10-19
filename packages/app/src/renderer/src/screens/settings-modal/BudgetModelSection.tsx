// 설정 예산 · 모델 섹션 (SCR-21, COST-01 · NFR-07 · ADR-024 · ADR-057).
// 실행 전체 한도(USD · 턴) + 역할별 모델 · 한도(USD · 턴). 모델 ID는 사용자가 자유 입력한다(목록 없음).
// [저장] → `settings.update`(사람 주체) → `settings.validateForRun`으로 검증 상태를 다시 읽는다.
// 값은 오케스트레이터 응답에서만 만든다 (NFR-03).
import type { JsonRpcErrorObject, SettingsValidateResult } from '@bive/shared';
import { useEffect, useState } from 'react';

import {
  type FieldKey,
  type FormValues,
  ROLE_ROW_LABELS,
  SETTINGS_ROLE_ROWS,
  toFormValues,
  toPatch,
  visibleMissing,
} from './form.js';

/** 화면 문구 (1.1 명사형). e2e 체크리스트와 같은 값. */
export const SECTION_TEXT = {
  title: '예산 · 모델',
  run: '실행 전체',
  roles: '역할별',
  role: '역할',
  model: '모델',
  usd: '한도 USD',
  turns: '턴',
  save: '저장',
  complete: '설정 완료',
  incomplete: '예산 · 모델 미설정',
  saving: '저장 중',
  saved: '저장됨',
  saveFailed: '저장 실패',
  invalid: '입력 오류',
  loadFailed: '설정 불러오기 실패',
} as const;

type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'invalid';

const SAVE_TEXT: Readonly<Record<Exclude<SaveState, 'idle'>, string>> = {
  saving: SECTION_TEXT.saving,
  saved: SECTION_TEXT.saved,
  failed: SECTION_TEXT.saveFailed,
  invalid: SECTION_TEXT.invalid,
};

type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; values: FormValues; validation: SettingsValidateResult | null };

const HUMAN = { kind: 'human' } as const;

const isInvalidParams = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as JsonRpcErrorObject).code === -32602;

/** 입력 칸 하나. 보이는 레이블은 표 머리 · 칸 옆 글자이고, 접근 가능한 이름은 행 + 열 이름이다. */
const Field = ({
  fieldKey,
  label,
  value,
  inputMode,
  invalid,
  missing,
  onChange,
}: {
  fieldKey: FieldKey;
  label: string;
  value: string;
  inputMode: 'text' | 'decimal' | 'numeric';
  invalid: boolean;
  missing: boolean;
  onChange: (key: FieldKey, value: string) => void;
}): React.JSX.Element => (
  <input
    className="settings-input"
    type="text"
    inputMode={inputMode}
    autoComplete="off"
    spellCheck={false}
    data-testid={`settings-field-${fieldKey}`}
    data-state={invalid ? 'invalid' : missing ? 'missing' : 'filled'}
    aria-label={label}
    aria-invalid={invalid || missing}
    value={value}
    onChange={(event) => onChange(fieldKey, event.target.value)}
  />
);

export const BudgetModelSection = ({ projectId }: { projectId: string }): React.JSX.Element => {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [save, setSave] = useState<SaveState>('idle');
  const [invalid, setInvalid] = useState<ReadonlySet<FieldKey>>(new Set());

  useEffect(() => {
    let active = true;
    Promise.all([
      window.bive.invoke('settings.get', { projectId }),
      window.bive.invoke('settings.validateForRun', { projectId }),
    ]).then(
      ([{ settings }, validation]) => {
        if (active) setLoad({ state: 'ready', values: toFormValues(settings), validation });
      },
      () => {
        if (active) setLoad({ state: 'error' });
      },
    );
    return () => {
      active = false;
    };
  }, [projectId]);

  if (load.state === 'loading') {
    return (
      <div className="settings-section" data-testid="settings-budget-model" data-state="loading" />
    );
  }
  if (load.state === 'error') {
    return (
      <div className="settings-section" data-testid="settings-budget-model" data-state="error">
        <p className="settings-message" data-testid="settings-load-error">
          {SECTION_TEXT.loadFailed}
        </p>
      </div>
    );
  }

  const { values, validation } = load;
  const missing =
    validation !== null && !validation.ok
      ? visibleMissing(validation.missing)
      : new Set<FieldKey>();

  const change = (key: FieldKey, value: string): void => {
    setLoad((prev) =>
      prev.state === 'ready' ? { ...prev, values: { ...prev.values, [key]: value } } : prev,
    );
    setInvalid((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setSave((prev) => (prev === 'saving' ? prev : 'idle'));
  };

  const submit = async (): Promise<void> => {
    const parsed = toPatch(values);
    if (!parsed.ok) {
      setInvalid(new Set(parsed.invalid));
      setSave('invalid');
      return;
    }
    setInvalid(new Set());
    setSave('saving');
    try {
      const { settings } = await window.bive.invoke('settings.update', {
        projectId,
        patch: parsed.patch,
        author: HUMAN,
      });
      let next: SettingsValidateResult | null = null;
      try {
        next = await window.bive.invoke('settings.validateForRun', { projectId });
      } catch {
        // 검증 상태를 읽지 못하면 표시하지 않는다 (근거 없는 값 미표시, NFR-03)
      }
      setLoad({ state: 'ready', values: toFormValues(settings), validation: next });
      setSave('saved');
    } catch (error) {
      setSave(isInvalidParams(error) ? 'invalid' : 'failed');
    }
  };

  const field = (key: FieldKey, label: string, inputMode: 'text' | 'decimal' | 'numeric') => (
    <Field
      fieldKey={key}
      label={label}
      value={values[key]}
      inputMode={inputMode}
      invalid={invalid.has(key)}
      missing={missing.has(key)}
      onChange={change}
    />
  );

  return (
    <form
      className="settings-section"
      data-testid="settings-budget-model"
      data-state="ready"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset className="settings-group" data-testid="settings-run" disabled={save === 'saving'}>
        <legend className="settings-group-title">{SECTION_TEXT.run}</legend>
        <div className="settings-run-fields">
          <label className="settings-run-field">
            <span className="settings-label">{SECTION_TEXT.usd}</span>
            {field('run.maxBudgetUsd', `${SECTION_TEXT.run} ${SECTION_TEXT.usd}`, 'decimal')}
          </label>
          <label className="settings-run-field">
            <span className="settings-label">{SECTION_TEXT.turns}</span>
            {field('run.maxTurns', `${SECTION_TEXT.run} ${SECTION_TEXT.turns}`, 'numeric')}
          </label>
        </div>
      </fieldset>

      <fieldset
        className="settings-group"
        data-testid="settings-roles"
        disabled={save === 'saving'}
      >
        <legend className="settings-group-title">{SECTION_TEXT.roles}</legend>
        <table className="settings-roles">
          <thead>
            <tr>
              <th scope="col">{SECTION_TEXT.role}</th>
              <th scope="col">{SECTION_TEXT.model}</th>
              <th scope="col">{SECTION_TEXT.usd}</th>
              <th scope="col">{SECTION_TEXT.turns}</th>
            </tr>
          </thead>
          <tbody>
            {SETTINGS_ROLE_ROWS.map((role) => {
              const name = ROLE_ROW_LABELS[role];
              return (
                <tr key={role} data-testid={`settings-role-${role}`}>
                  <th scope="row" className="settings-role-name">
                    {name}
                  </th>
                  <td>{field(`roles.${role}.model`, `${name} ${SECTION_TEXT.model}`, 'text')}</td>
                  <td>
                    {field(`roles.${role}.maxBudgetUsd`, `${name} ${SECTION_TEXT.usd}`, 'decimal')}
                  </td>
                  <td>
                    {field(`roles.${role}.maxTurns`, `${name} ${SECTION_TEXT.turns}`, 'numeric')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </fieldset>

      <footer className="settings-footer">
        <p className="settings-status">
          {validation !== null && (
            <span
              className="settings-validation"
              data-testid="settings-validation"
              data-state={validation.ok ? 'complete' : 'incomplete'}
            >
              {validation.ok ? SECTION_TEXT.complete : SECTION_TEXT.incomplete}
            </span>
          )}
          {save !== 'idle' && (
            <span
              className="settings-save-status"
              data-testid="settings-save-status"
              data-state={save}
              role="status"
            >
              {SAVE_TEXT[save]}
            </span>
          )}
        </p>
        <button
          type="submit"
          className="settings-save"
          data-testid="settings-save"
          disabled={save === 'saving'}
        >
          {SECTION_TEXT.save}
        </button>
      </footer>
    </form>
  );
};
