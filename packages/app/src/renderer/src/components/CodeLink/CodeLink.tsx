// 코드 열기 링크 `file:line` (screens.md 1.4 코드 열기, prototype-map.md `CodeOpenLink`, MET-01 · ADR-084).
// - 누르면 사유 모달(화면 오류 · 정보 부족 · 디버깅)만 연다. 사유 버튼을 눌러야 `app.openInIde`를 1번 부른다
//   (main이 기록 `codeOpen.record` 뒤 IDE를 연다. 기록이 실패하면 열지 않는다)
// - 선택 없이 닫기(취소 · Esc · 바깥 클릭 · ×)는 기록 · 열기가 없다. 사유는 키보드로 고른다(Tab으로 이동 · Enter · Space)
// - 부르는 동안(IDE 호출 중) 사유 버튼과 닫기를 막아 두 번 부르지 않는다. 성공하면 모달을 닫고, 실패하면 모달에 머물러
//   "IDE 열기 실패"를 보인다
// - 값(`file` · `line`)은 판정 결과 등 화면 데이터에서만 받는다(NFR-03). 출발 화면 · 항목은 놓는 화면이 정한다
import './CodeLink.css';

import type { CodeOpenReason, EntityRef, ScreenId } from '@bive/shared';
import { useCallback, useId, useRef, useState } from 'react';

import { Modal } from '../Modal/Modal.js';
import {
  CODE_LINK_TEXT as TEXT,
  CODE_OPEN_REASON_LABELS,
  CODE_OPEN_REASONS,
} from './codeLinkView.js';

type DialogState =
  { open: false } | { open: true; phase: 'idle' | 'pending' } | { open: true; phase: 'error' };

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

export const CodeLink = ({
  projectId,
  file,
  line,
  sourceScreen,
  itemRef,
}: CodeLinkProps): React.JSX.Element => {
  const [dialog, setDialog] = useState<DialogState>({ open: false });
  const titleId = useId();
  // 같은 틱에 두 번 눌러도 요청은 1번 (상태 갱신 전 두 번째 클릭 대비)
  const pending = useRef(false);
  const location = `${file}:${String(line)}`;

  const openDialog = useCallback(() => setDialog({ open: true, phase: 'idle' }), []);
  const close = useCallback(() => {
    // IDE 호출 중에는 닫지 않는다 (결과를 보이지 못한 채 끝나지 않게)
    if (pending.current) return;
    setDialog({ open: false });
  }, []);

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
          <div className="code-open-body" aria-busy={dialog.phase === 'pending'}>
            <h2 id={titleId} className="code-open-title">
              {TEXT.title}
            </h2>
            <dl className="code-open-fields">
              <dt>{TEXT.file}</dt>
              <dd data-testid="code-open-target">{location}</dd>
            </dl>
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
            <div className="code-open-buttons">
              <button
                type="button"
                className="code-open-cancel"
                data-testid="code-open-cancel"
                disabled={dialog.phase === 'pending'}
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
