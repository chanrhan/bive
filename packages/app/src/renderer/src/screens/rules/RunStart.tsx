// 규칙 화면의 [실행] · 실행 시작 확인 대화 (screens.md SCR-03 동작 [실행], RUN-01 · RUN-02 · NFR-07, M1-19 · ADR-076).
// - [실행]은 고른 규칙 1개로 실행을 만든다. 누르면 확인 대화만 열고, 대화의 [시작]을 눌러야 `run.create`를 1번 부른다
//   (취소 · Esc · 바깥 클릭 · ×는 부르지 않는다). 부르는 동안 [시작]을 막아 두 번 만들지 않는다
// - 성공하면 대화를 닫는다. 이후 진행은 실행 알림으로 화면이 다시 조회한다(미승인 규칙이면 승인 단계에서 대기)
// - 실패하면 대화에 머물고 문구를 보인다: 설정 미비(-32010) "예산 · 모델 미설정", 그 밖 "실행 시작 실패".
//   실행은 서버가 만들지 않는다(설정 미비 · 없는 규칙 · 삭제된 규칙이면 아무것도 저장하지 않음, ADR-061)
import './RunStart.css';

import type { Rule } from '@bive/shared';
import { useCallback, useId, useRef, useState } from 'react';

import { Modal } from '../../components/Modal/Modal.js';
import { RUN_START_TEXT as TEXT, runStartErrorText } from './runStartView.js';

type DialogState =
  | { open: false }
  | { open: true; phase: 'idle' | 'pending' }
  | { open: true; phase: 'error'; message: string };

export interface RunStartProps {
  projectId: string;
  rule: Rule;
}

export const RunStart = ({ projectId, rule }: RunStartProps): React.JSX.Element => {
  const [dialog, setDialog] = useState<DialogState>({ open: false });
  const titleId = useId();
  // 같은 틱에 두 번 눌러도 요청은 1번 (상태 갱신 전 두 번째 클릭 대비)
  const pending = useRef(false);

  const openDialog = useCallback(() => setDialog({ open: true, phase: 'idle' }), []);
  const close = useCallback(() => {
    // 부르는 동안은 닫지 않는다 (결과를 보이지 못한 채 실행이 생기지 않게)
    if (pending.current) return;
    setDialog({ open: false });
  }, []);

  const confirm = useCallback(() => {
    if (pending.current) return;
    pending.current = true;
    setDialog({ open: true, phase: 'pending' });
    window.bive
      .invoke('run.create', { projectId, ruleIds: [rule.id], author: { kind: 'human' } })
      .then(
        () => {
          pending.current = false;
          setDialog({ open: false });
        },
        (error: unknown) => {
          pending.current = false;
          setDialog({ open: true, phase: 'error', message: runStartErrorText(error) });
        },
      );
  }, [projectId, rule.id]);

  return (
    <>
      <button
        type="button"
        className="run-start-button"
        data-testid="run-start"
        onClick={openDialog}
      >
        {TEXT.run}
      </button>
      {dialog.open && (
        <Modal
          labelledBy={titleId}
          onClose={close}
          testId="run-start-dialog"
          className="run-start-dialog"
        >
          <div className="run-start-body">
            <h2 id={titleId} className="run-start-title">
              {TEXT.title}
            </h2>
            <dl className="run-start-fields">
              <dt>{TEXT.targets}</dt>
              <dd data-testid="run-start-target">{`${rule.displayId} · ${rule.title}`}</dd>
            </dl>
            {dialog.phase === 'error' && (
              <p className="run-start-error" data-testid="run-start-error" role="alert">
                {dialog.message}
              </p>
            )}
            <div className="run-start-buttons">
              <button
                type="button"
                className="run-start-action"
                data-testid="run-start-cancel"
                disabled={dialog.phase === 'pending'}
                onClick={close}
              >
                {TEXT.cancel}
              </button>
              <button
                type="button"
                className="run-start-action"
                data-primary="true"
                data-testid="run-start-confirm"
                disabled={dialog.phase === 'pending'}
                onClick={confirm}
              >
                {TEXT.confirm}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
};
