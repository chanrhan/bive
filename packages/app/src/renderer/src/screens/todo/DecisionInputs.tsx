// [수정] · [거절] 입력 카드 (screens.md SCR-17 동작: 대화 끝 카드로 열리고 자동 스크롤 · 포커스, NRM-04).
// - 수정: 제안 문장만 고친다(요구사항 = 문장, 규칙 = 제목 · 진술). 빈 문장 · 고친 진술의 형식 오류(EARS)는 칸 아래
//   문구로 알리고 확인 비활성
// - 거절: 사유 필수. 공백만 있으면 확인 비활성 (서버도 -32001)
// - ⌘↵(Ctrl+Enter) 확인 · Esc 닫기. 한글 등 입력기 조합 중의 Enter · Esc는 조합 확정용이라 가로채지 않는다
// - 수정: 고친 내용이 있으면 Esc · [취소]로 바로 닫지 않고 "수정 내용 있음" + [계속 수정] · [버리기]로 확인한다.
//   고친 내용은 부모가 제안별 초안으로 기억한다(`onChange`, editDraftStore) (#165, ADR-082)
// - 처리 중(`busy`)에는 입력을 읽기 전용으로 두고 확인을 막는다 (재전송 없음)
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import {
  type ActionableKind,
  canReject,
  DETAIL_TEXT,
  EDIT_FIELDS,
  type EditValues,
  editErrors,
  isEditDirty,
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
  /** 제안 본문 (고친 내용이 있는지 비교 · 진술 형식 검사 기준) */
  payload: unknown;
  /** 입력 칸의 처음 값 (제안 문장, 또는 기억해 둔 초안) */
  initialValues: EditValues;
  busy: boolean;
  /** 다시 [수정]을 누르면 바뀐다 (다시 스크롤 · 포커스) */
  focusKey: number;
  /** 고칠 때마다 입력 값 전체 (초안 기억) */
  onChange: (values: EditValues) => void;
  onConfirm: (values: EditValues) => void;
  /** 입력을 닫는다. 고친 내용이 있으면 사람이 [버리기]로 확인한 뒤에만 부른다 */
  onCancel: () => void;
}

export const EditCard = ({
  kind,
  payload,
  initialValues,
  busy,
  focusKey,
  onChange,
  onConfirm,
  onCancel,
}: EditCardProps): React.JSX.Element => {
  const [values, setValues] = useState<EditValues>(initialValues);
  // 고친 내용이 있는데 닫으려 함: 버릴지 확인 중
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const { cardRef, firstRef } = useRevealAndFocus(focusKey);
  const keepRef = useRef<HTMLButtonElement>(null);
  const errors = editErrors(kind, values, payload);
  const valid = Object.keys(errors).length === 0;
  const confirm = (): void => {
    // 버리기 확인 줄이 떠 있는 동안은 [수정 후 승인]이 없다: 입력 칸의 ⌘↵도 처리하지 않는다 (#173, ADR-095)
    if (busy || !valid || confirmingDiscard) return;
    onConfirm(values);
  };
  const requestCancel = (): void => {
    if (isEditDirty(kind, values, payload)) setConfirmingDiscard(true);
    else onCancel();
  };
  const keepEditing = (): void => {
    setConfirmingDiscard(false);
    firstRef.current?.focus();
  };
  useEffect(() => {
    if (confirmingDiscard) keepRef.current?.focus();
  }, [confirmingDiscard]);
  const update = (key: string, value: string): void => {
    const next = { ...values, [key]: value };
    setValues(next);
    onChange(next);
  };
  const onKeyDown = keyHandler(confirm, requestCancel);
  const titleId = 'proposal-edit-title';
  const discardTextId = 'proposal-edit-discard-text';

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
          onChange: (event: { target: { value: string } }) => update(field.key, event.target.value),
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
      {confirmingDiscard ? (
        <div
          className="decision-buttons"
          data-testid="edit-discard"
          role="alertdialog"
          aria-labelledby={discardTextId}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            keepEditing();
          }}
        >
          <span id={discardTextId} className="decision-warning" data-testid="edit-discard-text">
            {DETAIL_TEXT.discardPrompt}
          </span>
          <span className="decision-button-group">
            <button
              ref={keepRef}
              type="button"
              className="decision-button"
              data-testid="edit-keep"
              onClick={keepEditing}
            >
              {DETAIL_TEXT.keepEditing}
            </button>
            <button
              type="button"
              className="decision-button"
              data-danger="true"
              data-testid="edit-discard-confirm"
              onClick={onCancel}
            >
              {DETAIL_TEXT.discard}
            </button>
          </span>
        </div>
      ) : (
        <div className="decision-buttons">
          <span className="decision-hint">{shortcutHint(isMac())}</span>
          <span className="decision-button-group">
            <button
              type="button"
              className="decision-button"
              data-testid="edit-cancel"
              onClick={requestCancel}
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
          </span>
        </div>
      )}
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
        <span className="decision-button-group">
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
        </span>
      </div>
    </div>
  );
};
