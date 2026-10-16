// 오른쪽 에이전트 채팅 자리 (screens.md 1.2 · SCR-20 위치): 고정 360px.
// 창 폭이 기준(--bp-chat-collapse, 1100px) 미만이면 44px 띠로 접히고, 띠를 누르면 본문 위에 겹쳐 연다.
// 탭 · 참조 칩 · 입력 등 채팅 내용은 #82 (M5-02).
import { MessageSquare, X } from 'lucide-react';
import { useEffect, useState } from 'react';

export type ChatMode = 'docked' | 'strip' | 'overlay';

export const CHAT_TITLE = '에이전트 채팅';

export const ChatPanel = ({ collapsed }: { collapsed: boolean }): React.JSX.Element => {
  const [open, setOpen] = useState(false);

  // 창이 넓어져 고정 패널로 돌아가면 겹침 상태를 지운다
  useEffect(() => {
    if (!collapsed) setOpen(false);
  }, [collapsed]);

  // 겹쳐 연 상태에서 Esc로 닫는다
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const mode: ChatMode = !collapsed ? 'docked' : open ? 'overlay' : 'strip';

  return (
    <aside className="chat" data-testid="chat-panel" data-mode={mode} aria-label={CHAT_TITLE}>
      {collapsed && (
        <button
          type="button"
          className="chat-strip"
          data-testid="chat-strip"
          aria-label={`${CHAT_TITLE} 열기`}
          title={CHAT_TITLE}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <MessageSquare className="button-icon" aria-hidden="true" />
        </button>
      )}
      {mode !== 'strip' && (
        <section
          className="chat-body"
          data-testid="chat-body"
          aria-labelledby="chat-title"
          {...(mode === 'overlay' && { role: 'dialog', 'aria-modal': false })}
        >
          <header className="chat-header">
            <h2 className="chat-title" id="chat-title">
              {CHAT_TITLE}
            </h2>
            {mode === 'overlay' && (
              <button
                type="button"
                className="icon-button"
                data-testid="chat-close"
                aria-label={`${CHAT_TITLE} 닫기`}
                title="닫기"
                onClick={() => setOpen(false)}
              >
                <X className="button-icon" aria-hidden="true" />
              </button>
            )}
          </header>
        </section>
      )}
    </aside>
  );
};
