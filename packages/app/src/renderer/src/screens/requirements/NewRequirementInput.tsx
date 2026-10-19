// 새 요구사항 입력 줄 (SCR-02 [+ 새 요구사항]): 목록 맨 위 여러 줄 입력. ⌘↵(Ctrl+Enter) 저장 · Esc 취소.
// - 공백만 있는 본문은 보내지 않는다(ADR-047 본문 규칙과 같음). 받은 문구는 그대로 보낸다
// - 저장 중에는 다시 보내지 않는다(1회 호출). 성공하면 화면이 입력 줄을 닫고, 실패하면 문구를 남기고 한 줄로 알린다
// - 한글 조합 중의 Enter · Esc는 조합 확정으로 두고 가로채지 않는다
import { type RefObject, useEffect, useRef, useState } from 'react';

import { TEXT } from './requirementsView.js';

export interface NewRequirementInputProps {
  /** 저장. 거부되면 실패 표시 */
  onSubmit: (text: string) => Promise<void>;
  /** 호출 없이 닫기 */
  onCancel: () => void;
  /** 입력 상자 (화면이 [+ 새 요구사항]을 다시 누르면 초점을 옮긴다) */
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.userAgent);

export const NewRequirementInput = ({
  onSubmit,
  onCancel,
  inputRef,
}: NewRequirementInputProps): React.JSX.Element => {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // 같은 틱에 두 번 눌러도 한 번만 보내도록 상태와 별도로 둔다
  const savingRef = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    inputRef.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, [inputRef]);

  const submit = (): void => {
    if (savingRef.current || text.trim() === '') return;
    savingRef.current = true;
    setSaving(true);
    setFailed(false);
    onSubmit(text).then(
      () => {
        savingRef.current = false;
      },
      () => {
        savingRef.current = false;
        if (!mounted.current) return;
        setSaving(false);
        setFailed(true);
      },
    );
  };

  return (
    <div className="new-requirement" data-testid="new-requirement">
      <textarea
        ref={inputRef}
        className="new-requirement-input"
        data-testid="new-requirement-input"
        aria-label={TEXT.inputLabel}
        placeholder={TEXT.inputPlaceholder}
        rows={3}
        value={text}
        readOnly={saving}
        aria-busy={saving}
        onChange={(event) => {
          setText(event.target.value);
          setFailed(false);
        }}
        onKeyDown={(event) => {
          // 조합 중(isComposing, 일부 환경은 keyCode 229만 준다)의 키는 조합 확정용이다
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <p className="new-requirement-hint" data-testid="new-requirement-hint">
        {isMac() ? '⌘↵ 저장 · Esc 취소' : 'Ctrl+Enter 저장 · Esc 취소'}
      </p>
      {failed && (
        <p className="new-requirement-error" data-testid="new-requirement-error" role="alert">
          {TEXT.saveFailed}
        </p>
      )}
    </div>
  );
};
