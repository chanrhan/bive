// 코드 열기 링크 `file:line` (screens.md 1.4 코드 열기, prototype-map.md `CodeOpenLink`, MET-01 · ADR-084 · ADR-018 · ADR-087).
// - 누르면 모달을 열고 그 프로젝트의 IDE 설정(`settings.get`)을 읽는다. 미설정이면 먼저 "IDE 선택" 단계(VS Code를 미리
//   골라 둠)를 보이고, [확인]으로 설정에 저장(`settings.update`, 사람 주체)한 뒤 같은 모달의 사유 단계로 넘어간다 (ADR-018)
// - 사유 단계(화면 오류 · 정보 부족 · 디버깅)에서 사유 버튼을 눌러야 `app.openInIde`를 1번 부른다
//   (main이 설정의 IDE로 URL을 만들고 기록 `codeOpen.record` 뒤 연다. 기록이 실패하면 열지 않는다)
// - 선택 없이 닫기(취소 · Esc · 바깥 클릭 · ×)는 어느 단계에서든 저장 · 기록 · 열기가 없다. 키보드로 고른다(Tab · Enter · Space)
// - 부르는 동안(IDE 저장 · 호출 중) 버튼과 닫기를 막아 두 번 부르지 않는다. 성공하면 다음 단계로 가거나 모달을 닫고,
//   실패하면 모달에 머물러 실패 문구를 보인다
// - 값(`file` · `line`)은 판정 결과 등 화면 데이터에서만 받는다(NFR-03). 출발 화면 · 항목은 놓는 화면이 정한다
import './CodeLink.css';

import type { CodeOpenReason, EntityRef, JsonRpcErrorObject, ScreenId } from '@bive/shared';
import { useCallback, useId, useRef, useState } from 'react';

import {
  IDE_TEXT,
  type IdeChoice,
  IdeChoiceFields,
  toIdeChoice,
  toIdeSetting,
} from '../IdeChoice/index.js';
import { Modal } from '../Modal/Modal.js';
import {
  CODE_LINK_TEXT as TEXT,
  CODE_OPEN_REASON_LABELS,
  CODE_OPEN_REASONS,
} from './codeLinkView.js';

type IdeStatus = 'idle' | 'saving' | 'failed' | 'invalid';

type DialogState =
  | { open: false }
  | { open: true; phase: 'checking' | 'loadError' }
  | { open: true; phase: 'ide'; choice: IdeChoice; status: IdeStatus }
  | { open: true; phase: 'idle' | 'pending' | 'error' };

export interface CodeLinkProps {
  projectId: string;
  /** 프로젝트 루트 기준 상대 경로 */
  file: string;
  /** 1 이상의 줄 번호 */
  line: number;
  /** 출발 화면 (저장 값, 화면에는 보이지 않는다) */
  sourceScreen: ScreenId;
  /** 링크가 달린 항목 */
  itemRef: EntityRef;
}

const HUMAN = { kind: 'human' } as const;

const isInvalidParams = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as JsonRpcErrorObject).code === -32602;

export const CodeLink = ({
  projectId,
  file,
  line,
  sourceScreen,
  itemRef,
}: CodeLinkProps): React.JSX.Element => {
  const [dialog, setDialog] = useState<DialogState>({ open: false });
  const titleId = useId();
  const formId = useId();
  // 같은 틱에 두 번 눌러도 요청은 1번 (상태 갱신 전 두 번째 클릭 대비)
  const pending = useRef(false);
  // 닫은 뒤 늦게 온 설정 응답이 모달을 다시 열지 않게 여는 차례를 센다
  const session = useRef(0);
  const location = `${file}:${String(line)}`;

  const openDialog = useCallback(() => {
    session.current += 1;
    const current = session.current;
    setDialog({ open: true, phase: 'checking' });
    window.bive.invoke('settings.get', { projectId }).then(
      ({ settings }) => {
        if (session.current !== current) return;
        setDialog(
          settings.ide === null
            ? { open: true, phase: 'ide', choice: toIdeChoice(null), status: 'idle' }
            : { open: true, phase: 'idle' },
        );
      },
      () => {
        if (session.current === current) setDialog({ open: true, phase: 'loadError' });
      },
    );
  }, [projectId]);

  const close = useCallback(() => {
    // 저장 · IDE 호출 중에는 닫지 않는다 (결과를 보이지 못한 채 끝나지 않게)
    if (pending.current) return;
    session.current += 1;
    setDialog({ open: false });
  }, []);

  const changeIde = useCallback((choice: IdeChoice) => {
    setDialog((prev) =>
      prev.open && prev.phase === 'ide' && prev.status !== 'saving'
        ? { ...prev, choice, status: 'idle' }
        : prev,
    );
  }, []);

  const confirmIde = useCallback(
    (choice: IdeChoice) => {
      if (pending.current) return;
      const ide = toIdeSetting(choice);
      if (ide === null) {
        setDialog({ open: true, phase: 'ide', choice, status: 'invalid' });
        return;
      }
      pending.current = true;
      setDialog({ open: true, phase: 'ide', choice, status: 'saving' });
      window.bive.invoke('settings.update', { projectId, patch: { ide }, author: HUMAN }).then(
        () => {
          pending.current = false;
          setDialog({ open: true, phase: 'idle' });
        },
        (error: unknown) => {
          pending.current = false;
          setDialog({
            open: true,
            phase: 'ide',
            choice,
            status: isInvalidParams(error) ? 'invalid' : 'failed',
          });
        },
      );
    },
    [projectId],
  );

  const choose = useCallback(
    (reason: CodeOpenReason) => {
      if (pending.current) return;
      pending.current = true;
      setDialog({ open: true, phase: 'pending' });
      window.bive
        .invoke('app.openInIde', { projectId, reason, sourceScreen, itemRef, file, line })
        .then(
          () => {
            pending.current = false;
            setDialog({ open: false });
          },
          () => {
            pending.current = false;
            setDialog({ open: true, phase: 'error' });
          },
        );
    },
    [projectId, sourceScreen, itemRef, file, line],
  );

  const busy =
    dialog.open &&
    (dialog.phase === 'pending' || (dialog.phase === 'ide' && dialog.status === 'saving'));

  const body = (): React.JSX.Element | null => {
    if (!dialog.open) return null;
    if (dialog.phase === 'checking') return null;
    if (dialog.phase === 'loadError') {
      return (
        <p className="code-open-error" data-testid="code-open-error" role="alert">
          {TEXT.loadFailed}
        </p>
      );
    }
    if (dialog.phase === 'ide') {
      const { choice, status } = dialog;
      return (
        <form
          id={formId}
          className="code-open-ide"
          data-testid="code-open-ide"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            confirmIde(choice);
          }}
        >
          <IdeChoiceFields
            value={choice}
            onChange={changeIde}
            disabled={status === 'saving'}
            invalid={status === 'invalid' && choice.kind === 'custom'}
          />
          {(status === 'failed' || status === 'invalid') && (
            <p className="code-open-error" data-testid="code-open-error" role="alert">
              {status === 'failed' ? TEXT.saveFailed : TEXT.invalid}
            </p>
          )}
        </form>
      );
    }
    return (
      <>
        <div className="code-open-reasons" role="group" aria-labelledby={titleId}>
          {CODE_OPEN_REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              className="code-open-reason"
              data-testid={`code-open-reason-${reason}`}
              disabled={dialog.phase === 'pending'}
              onClick={() => choose(reason)}
            >
              {CODE_OPEN_REASON_LABELS[reason]}
            </button>
          ))}
        </div>
        {dialog.phase === 'error' && (
          <p className="code-open-error" data-testid="code-open-error" role="alert">
            {TEXT.failed}
          </p>
        )}
      </>
    );
  };

  return (
    <>
      <button
        type="button"
        className="code-link"
        data-testid="code-link"
        title={TEXT.open}
        onClick={openDialog}
      >
        {location}
      </button>
      {dialog.open && (
        <Modal
          labelledBy={titleId}
          onClose={close}
          testId="code-open-dialog"
          className="code-open-dialog"
        >
          <div
            className="code-open-body"
            data-phase={dialog.phase}
            aria-busy={busy || dialog.phase === 'checking'}
          >
            <h2 id={titleId} className="code-open-title">
              {dialog.phase === 'ide' ? IDE_TEXT.stepTitle : TEXT.title}
            </h2>
            <dl className="code-open-fields">
              <dt>{TEXT.file}</dt>
              <dd data-testid="code-open-target">{location}</dd>
            </dl>
            {body()}
            <div className="code-open-buttons">
              {dialog.phase === 'ide' && (
                <button
                  type="submit"
                  form={formId}
                  className="code-open-confirm"
                  data-testid="code-open-ide-confirm"
                  disabled={busy}
                >
                  {IDE_TEXT.confirm}
                </button>
              )}
              <button
                type="button"
                className="code-open-cancel"
                data-testid="code-open-cancel"
                disabled={busy}
                onClick={close}
              >
                {TEXT.cancel}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
};
