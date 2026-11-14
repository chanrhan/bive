// 설정 IDE 섹션 (MET-01 코드 열기, ADR-018 · ADR-087). 화면 정의서 SCR-21에는 없고 ADR-018이 더한 항목이다.
// VS Code · Cursor · 사용자 지정 URL 틀 중 하나. 미설정이면 VS Code를 미리 고르고 "IDE 미설정"을 보인다.
// [저장] → `settings.update { patch: { ide } }`(사람 주체). 틀의 허용 범위는 오케스트레이터가 검사한다(-32602 → "입력 오류").
// 값은 오케스트레이터 응답에서만 만든다 (NFR-03).
import type { IdeSetting, JsonRpcErrorObject } from '@bive/shared';
import { useEffect, useState } from 'react';

import {
  IDE_TEXT,
  type IdeChoice,
  IdeChoiceFields,
  toIdeChoice,
  toIdeSetting,
} from '../../components/IdeChoice/index.js';
import { SECTION_TEXT } from './BudgetModelSection.js';

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
  | { state: 'ready'; saved: IdeSetting | null; choice: IdeChoice };

const HUMAN = { kind: 'human' } as const;

const isInvalidParams = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as JsonRpcErrorObject).code === -32602;

export const IdeSection = ({ projectId }: { projectId: string }): React.JSX.Element => {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [save, setSave] = useState<SaveState>('idle');

  useEffect(() => {
    let active = true;
    window.bive.invoke('settings.get', { projectId }).then(
      ({ settings }) => {
        if (active)
          setLoad({ state: 'ready', saved: settings.ide, choice: toIdeChoice(settings.ide) });
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
    return <div className="settings-section" data-testid="settings-ide" data-state="loading" />;
  }
  if (load.state === 'error') {
    return (
      <div className="settings-section" data-testid="settings-ide" data-state="error">
        <p className="settings-message" data-testid="settings-load-error">
          {SECTION_TEXT.loadFailed}
        </p>
      </div>
    );
  }

  const change = (choice: IdeChoice): void => {
    setLoad((prev) => (prev.state === 'ready' ? { ...prev, choice } : prev));
    setSave((prev) => (prev === 'saving' ? prev : 'idle'));
  };

  const submit = async (): Promise<void> => {
    const ide = toIdeSetting(load.choice);
    if (ide === null) {
      setSave('invalid');
      return;
    }
    setSave('saving');
    try {
      const { settings } = await window.bive.invoke('settings.update', {
        projectId,
        patch: { ide },
        author: HUMAN,
      });
      setLoad({ state: 'ready', saved: settings.ide, choice: toIdeChoice(settings.ide) });
      setSave('saved');
    } catch (error) {
      setSave(isInvalidParams(error) ? 'invalid' : 'failed');
    }
  };

  return (
    <form
      className="settings-section"
      data-testid="settings-ide"
      data-state="ready"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <IdeChoiceFields
        value={load.choice}
        onChange={change}
        disabled={save === 'saving'}
        invalid={save === 'invalid' && load.choice.kind === 'custom'}
      />
      <footer className="settings-footer">
        <p className="settings-status">
          {load.saved === null && (
            <span
              className="settings-validation"
              data-testid="settings-ide-unset"
              data-state="incomplete"
            >
              {IDE_TEXT.unset}
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
