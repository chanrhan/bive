// 떠 있는 처리 버튼 (screens.md SCR-17 액션 버튼: 오른쪽 아래 [거절] [수정] [승인], prototype-map 표 2).
// 부모(상세 영역)의 오른쪽 아래에 고정되고 상세 내용이 스크롤돼도 그 자리에 있다. 부모는 `position: relative`.
// 처리 중(`busy`)이면 모든 버튼이 비활성이고 "처리 중"을 보인다 (같은 항목을 두 번 처리하지 않음).
// 버튼별로 막을 수도 있고(`disabled`), 막은 이유는 `note`로 버튼 왼쪽에 글자로 보인다 (#165: 수정 중).
import './FloatingActions.css';

export interface FloatingAction {
  /** `data-testid="action-<id>"` */
  id: string;
  label: string;
  onClick: () => void;
  /** 주 동작(승인)은 강조 색 */
  primary?: boolean;
  /** 지금 열린 입력 카드의 버튼 */
  pressed?: boolean;
  /** 이 버튼만 막는다 (이유는 `note`) */
  disabled?: boolean;
}

export interface FloatingActionsProps {
  /** 도구 모음의 접근 가능한 이름 */
  label: string;
  actions: readonly FloatingAction[];
  busy?: boolean;
  /** 처리 중 문구 */
  busyText?: string;
  /** 처리 중이 아닐 때 보이는 상태 문구 (막은 버튼의 이유) */
  note?: string | null;
}

export const FloatingActions = ({
  label,
  actions,
  busy = false,
  busyText,
  note = null,
}: FloatingActionsProps): React.JSX.Element => (
  <div
    className="floating-actions"
    data-testid="floating-actions"
    role="toolbar"
    aria-label={label}
    aria-busy={busy}
  >
    {busy && busyText !== undefined && (
      <span className="floating-actions-busy" data-testid="floating-actions-busy" role="status">
        {busyText}
      </span>
    )}
    {!busy && note !== null && (
      <span className="floating-actions-busy" data-testid="floating-actions-note" role="status">
        {note}
      </span>
    )}
    {actions.map((action) => (
      <button
        key={action.id}
        type="button"
        className="floating-action"
        data-testid={`action-${action.id}`}
        data-primary={action.primary === true}
        aria-pressed={action.pressed === undefined ? undefined : action.pressed}
        disabled={busy || action.disabled === true}
        onClick={action.onClick}
      >
        {action.label}
      </button>
    ))}
  </div>
);
