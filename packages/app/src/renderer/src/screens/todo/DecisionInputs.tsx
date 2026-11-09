// [수정] · [거절] 입력 카드 (screens.md SCR-17 동작: 대화 끝 카드로 열리고 자동 스크롤 · 포커스, NRM-04).
// - 수정: 제안 문장만 고친다(요구사항 = 문장, 규칙 = 제목 · 진술). 빈 문장 · 고친 진술의 형식 오류(EARS)는 칸 아래
//   문구로 알리고 확인 비활성
// - 거절: 사유 필수. 공백만 있으면 확인 비활성 (서버도 -32001)
// - ⌘↵(Ctrl+Enter) 확인 · Esc 닫기. 한글 등 입력기 조합 중의 Enter · Esc는 조합 확정용이라 가로채지 않는다
// - 처리 중(`busy`)에는 입력을 읽기 전용으로 두고 확인을 막는다 (재전송 없음)
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import {
  type ActionableKind,
  canReject,
  DETAIL_TEXT,
  EDIT_FIELDS,
  type EditValues,
  editErrors,
  initialEditValues,
  shortcutHint,
} from './proposalDetailView.js';

const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.userAgent);

type Field = HTMLInputElement | HTMLTextAreaElement;

/** 확인 · 취소 단축키. 조합 중 키는 넘긴다. */
const keyHandler =
  (confirm: () => void, cancel: () => void) =>
  (event: KeyboardEvent<Field>): void => {
    // 조합 중(isComposing, 일부 환경은 keyCode 229만 준다)의 키는 조합 확정용이다
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      confirm();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };

/** 카드가 열릴 때(그리고 `focusKey`가 바뀔 때) 카드를 보이게 스크롤하고 첫 칸에 초점을 둔다. */
const useRevealAndFocus = (focusKey: number) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<Field>(null);
  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: 'end' });
    firstRef.current?.focus({ preventScroll: true });
  }, [focusKey]);
  return { cardRef, firstRef };
};

export interface EditCardProps {
  kind: ActionableKind;
  /** 제안 본문 (입력 칸의 처음 값) */
  payload: unknown;
  busy: boolean;
  /** 다시 [수정]을 누르면 바뀐다 (다시 스크롤 · 포커스) */
  focusKey: number;
  onConfirm: (values: EditValues) => void;
  onCancel: () => void;
}

export const EditCard = ({
  kind,
  payload,
  busy,
  focusKey,
  onConfirm,
  onCancel,
}: EditCardProps): React.JSX.Element => {
  const [values, setValues] = useState<EditValues>(() => initialEditValues(kind, payload));
  const { cardRef, firstRef } = useRevealAndFocus(focusKey);
  const errors = editErrors(kind, values, payload);
  const valid = Object.keys(errors).length === 0;
  const confirm = (): void => {
    if (busy || !valid) return;
    onConfirm(values);
  };
  const onKeyDown = keyHandler(confirm, onCancel);
  const titleId = 'proposal-edit-title';

  return (
    <div
      ref={cardRef}
      className="decision-card"
      data-testid="edit-card"
      role="group"
      aria-labelledby={titleId}
    >
      <h3 id={titleId} className="detail-heading">
        {DETAIL_TEXT.editCard}
      </h3>
      {EDIT_FIELDS[kind].map((field, index) => {
        const id = `proposal-edit-${field.key}`;
        const error = errors[field.key];
        const common = {
          id,
          className: 'decision-input',
          'data-testid': `edit-${field.key}`,
          value: values[field.key] ?? '',
          readOnly: busy,
          'aria-invalid': error !== undefined,
          'aria-describedby': error === undefined ? undefined : `${id}-error`,
          onChange: (event: { target: { value: string } }) =>
            setValues((prev) => ({ ...prev, [field.key]: event.target.value })),
          onKeyDown,
        };
        return (
          <div key={field.key} className="decision-field">
            <label htmlFor={id} className="decision-label">
              {field.label}
            </label>
            {field.multiline ? (
              <textarea
                {...common}
                ref={index === 0 ? (firstRef as React.Ref<HTMLTextAreaElement>) : undefined}
                rows={3}
              />
            ) : (
              <input
                {...common}
                ref={index === 0 ? (firstRef as React.Ref<HTMLInputElement>) : undefined}
                type="text"
              />
            )}
            {error !== undefined && (
              <p id={`${id}-error`} className="decision-error" data-testid="edit-error">
                {error}
              </p>
            )}
          </div>
        );
      })}
      <div className="decision-buttons">
        <span className="decision-hint">{shortcutHint(isMac())}</span>
        <button
          type="button"
          className="decision-button"
          data-testid="edit-cancel"
          onClick={onCancel}
        >
          {DETAIL_TEXT.cancel}
        </button>
        <button
          type="button"
          className="decision-button"
          data-primary="true"
          data-testid="edit-confirm"
          disabled={busy || !valid}
          onClick={confirm}
        >
          {DETAIL_TEXT.editConfirm}
        </button>
      </div>
    </div>
  );
};

export interface RejectCardProps {
  busy: boolean;
  focusKey: number;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export const RejectCard = ({
  busy,
  focusKey,
  onConfirm,
  onCancel,
}: RejectCardProps): React.JSX.Element => {
  const [reason, setReason] = useState('');
  const { cardRef, firstRef } = useRevealAndFocus(focusKey);
  const ready = canReject(reason);
  const confirm = (): void => {
    if (busy || !ready) return;
    onConfirm(reason);
  };
  const titleId = 'proposal-reject-title';
  const inputId = 'proposal-reject-reason';

  return (
    <div
      ref={cardRef}
      className="decision-card"
      data-testid="reject-card"
      role="group"
      aria-labelledby={titleId}
    >
      <h3 id={titleId} className="detail-heading">
        {DETAIL_TEXT.rejectCard}
      </h3>
      <div className="decision-field">
        <textarea
          ref={firstRef as React.Ref<HTMLTextAreaElement>}
          id={inputId}
          className="decision-input"
          data-testid="reject-reason"
          aria-labelledby={titleId}
          aria-required="true"
          rows={3}
          value={reason}
          readOnly={busy}
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={keyHandler(confirm, onCancel)}
        />
      </div>
      <div className="decision-buttons">
        <span className="decision-hint">{shortcutHint(isMac())}</span>
        <button
          type="button"
          className="decision-button"
          data-testid="reject-cancel"
          onClick={onCancel}
        >
          {DETAIL_TEXT.cancel}
        </button>
        <button
          type="button"
          className="decision-button"
          data-danger="true"
          data-testid="reject-confirm"
          disabled={busy || !ready}
          onClick={confirm}
        >
          {DETAIL_TEXT.rejectConfirm}
        </button>
      </div>
    </div>
  );
};
