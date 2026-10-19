// 모달 (prototype-map.md 표 2 `Modal`, screens.md 1.2 · SCR-21 위치): 820 × 600(`--modal-width` · `--modal-height`),
// 바깥 클릭 · Esc · ×로 닫는다. 열려 있는 동안 키보드 초점은 모달 안에서만 돈다(Tab · Shift+Tab), 닫으면 열기 전
// 초점으로 돌아간다. 문서 끝(`document.body`)에 그려 현재 화면 위에 겹친다.
import './Modal.css';

import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export const CLOSE_LABEL = '닫기';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const focusables = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.getClientRects().length > 0,
  );

export interface ModalProps {
  /** 제목 요소의 id (`aria-labelledby`). 제목은 children 안에 둔다 */
  labelledBy: string;
  onClose: () => void;
  /** `data-testid` 접두. 모달 `<접두>`, 바깥 `<접두>-backdrop`, × `<접두>-close` */
  testId: string;
  className?: string;
  children: ReactNode;
}

export const Modal = ({
  labelledBy,
  onClose,
  testId,
  className,
  children,
}: ModalProps): React.JSX.Element => {
  const dialogRef = useRef<HTMLDivElement>(null);
  // 효과를 다시 걸지 않고 최신 닫기 함수를 부른다 (초점 복원이 한 번만 일어나게)
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // 한글 등 입력기 조합 중의 Esc는 조합 취소이므로 모달을 닫지 않는다
        if (event.isComposing) return;
        // 모달 아래 화면(채팅 겹침 등)의 Esc 처리로 번지지 않게 여기서 멈춘다
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables(dialog);
      const first = items[0];
      const last = items.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      const inside = active instanceof Node && dialog.contains(active);
      if (event.shiftKey && (!inside || active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    // 초점이 모달 밖으로 나가면 다시 모달로 가져온다
    const onFocusIn = (event: FocusEvent): void => {
      if (event.target instanceof Node && !dialog.contains(event.target)) dialog.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return createPortal(
    <div
      className="modal-backdrop"
      data-testid={`${testId}-backdrop`}
      onMouseDown={(event) => {
        // 모달 안에서 눌러 바깥에서 뗀 경우는 닫지 않는다 (누른 곳 기준)
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={className === undefined ? 'modal' : `modal ${className}`}
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        {children}
        <button
          type="button"
          className="icon-button modal-close"
          data-testid={`${testId}-close`}
          aria-label={CLOSE_LABEL}
          title={CLOSE_LABEL}
          onClick={onClose}
        >
          <X className="button-icon" aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body,
  );
};
