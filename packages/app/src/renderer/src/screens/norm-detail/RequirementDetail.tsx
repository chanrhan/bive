// 요구사항 상세 (screens.md SCR-02 상세 · SCR-06 규범 상세, 1.4, ADR-035 · ADR-078).
// 요구사항 목록 + 상세 2단의 상세 영역에 들어간다(별도 화면 아님).
// - 순서: 표시 ID · [편집] · [삭제] → 본문 · 생성 주체(이름) → 자식 규칙
// - 자식 규칙을 누르면 그 자리에서 규칙 상세(RuleDetail: 진술 · 속성 · 테스트 출력 · 실행 이력)를 펼친다
// - 직접 편집: [편집] → 본문 입력 → [저장](⌘↵ · Ctrl+Enter) 1회 = requirement.update, [취소](Esc)는 호출 없음.
//   저장 중에는 다시 부르지 않고, 실패하면 입력을 남긴 채 "요구사항 저장 실패"
// - 삭제: 두 번 눌러 확인(SCR-02). 첫 클릭은 [삭제 확인]으로 바뀌기만 하고(호출 없음), 두 번째 클릭에서
//   requirement.delete 1회. 버튼을 벗어나면 확인 대기가 풀린다. 실패하면 "요구사항 삭제 실패"
// - 변경 이력(P1) · 구현 위치(대상 블록, P1) · 자식 계약(P1)은 해당 이슈 전 미노출 (ADR-035)
// - 값은 requirement.list 항목 · rule.list 결과에서만 (NFR-03)
import './RequirementDetail.css';

import type { Requirement } from '@bive/shared';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { AuthorMark } from '../../components/AuthorMark/AuthorMark.js';
import { StatusBadge } from '../../components/StatusBadge/StatusBadge.js';
import { canSaveEdit, REQUIREMENT_DETAIL_TEXT as TEXT } from './requirementDetailView.js';
import { RuleDetail } from './RuleDetail.js';
import { ruleAuthorName } from './ruleDetailView.js';
import { type ChildRulesLoad, useChildRules } from './useChildRules.js';

export interface RequirementDetailProps {
  projectId: string;
  requirement: Requirement;
  /** 직접 편집 저장 (requirement.update). 거부되면 실패 표시 */
  onUpdate: (text: string) => Promise<void>;
  /** 삭제 (requirement.delete). 거부되면 실패 표시 */
  onDelete: () => Promise<void>;
}

type Busy = 'save' | 'delete' | null;

const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.userAgent);

/** 요구사항이 바뀌면 편집 · 확인 대기 · 펼침 상태를 새로 시작하도록 호출하는 쪽이 `key={requirement.id}`를 준다. */
export const RequirementDetail = ({
  projectId,
  requirement,
  onUpdate,
  onDelete,
}: RequirementDetailProps): React.JSX.Element => {
  const children = useChildRules(projectId, requirement.id, requirement.updatedAt);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [failed, setFailed] = useState<Busy>(null);
  // 같은 틱에 두 번 눌러도 한 번만 부르도록 상태와 별도로 둔다
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const run = (kind: 'save' | 'delete', call: () => Promise<void>, onDone: () => void): void => {
    busyRef.current = true;
    setBusy(kind);
    setFailed(null);
    call().then(
      () => {
        busyRef.current = false;
        if (!mounted.current) return;
        setBusy(null);
        onDone();
      },
      () => {
        busyRef.current = false;
        if (!mounted.current) return;
        setBusy(null);
        setArmed(false);
        setFailed(kind);
      },
    );
  };

  const startEdit = (): void => {
    if (busyRef.current) return;
    setDraft(requirement.text);
    setArmed(false);
    setFailed(null);
    setEditing(true);
  };

  const cancelEdit = (): void => {
    if (busyRef.current) return;
    setEditing(false);
    setFailed(null);
  };

  const save = (): void => {
    if (busyRef.current || !canSaveEdit(requirement, draft)) return;
    const text = draft;
    run(
      'save',
      () => onUpdate(text),
      () => setEditing(false),
    );
  };

  const remove = (): void => {
    if (busyRef.current) return;
    if (!armed) {
      // 첫 클릭: 확인 대기로만 바꾼다 (호출 없음, SCR-02 "두 번 눌러 확인")
      setArmed(true);
      setFailed(null);
      return;
    }
    run('delete', onDelete, () => setArmed(false));
  };

  return (
    <div
      className="rule-detail-body requirement-detail-body"
      data-testid="requirement-detail-body"
      data-requirement-id={requirement.id}
    >
      <header className="rule-detail-head">
        <h2 className="rule-detail-title" data-testid="requirement-detail-id">
          {requirement.displayId}
        </h2>
        {!editing && (
          <div className="requirement-actions">
            <button
              type="button"
              className="requirement-action"
              data-testid="requirement-edit"
              disabled={busy !== null}
              onClick={startEdit}
            >
              {TEXT.edit}
            </button>
            <button
              type="button"
              className="requirement-action"
              data-testid="requirement-delete"
              data-armed={armed ? 'true' : 'false'}
              disabled={busy !== null}
              aria-busy={busy === 'delete'}
              onClick={remove}
              onBlur={() => setArmed(false)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && armed) {
                  event.stopPropagation();
                  setArmed(false);
                }
              }}
            >
              {armed ? TEXT.confirmRemove : TEXT.remove}
            </button>
          </div>
        )}
      </header>

      {failed !== null && (
        <p className="rule-detail-error" data-testid="requirement-action-error" role="alert">
          {failed === 'save' ? TEXT.saveFailed : TEXT.removeFailed}
        </p>
      )}

      <dl className="rule-fields">
        <Field id="text" label={TEXT.text}>
          {editing ? (
            <div className="requirement-editor" data-testid="requirement-editor">
              <textarea
                ref={inputRef}
                className="requirement-edit-input"
                data-testid="requirement-edit-input"
                aria-label={TEXT.editLabel}
                rows={3}
                value={draft}
                readOnly={busy === 'save'}
                aria-busy={busy === 'save'}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setFailed(null);
                }}
                onKeyDown={(event) => {
                  // 조합 중(isComposing, 일부 환경은 keyCode 229만 준다)의 키는 조합 확정용이다
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    save();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelEdit();
                  }
                }}
              />
              <div className="requirement-editor-bar">
                <span className="requirement-editor-hint">
                  {isMac() ? '⌘↵ 저장 · Esc 취소' : 'Ctrl+Enter 저장 · Esc 취소'}
                </span>
                <button
                  type="button"
                  className="requirement-action"
                  data-testid="requirement-cancel"
                  disabled={busy !== null}
                  onClick={cancelEdit}
                >
                  {TEXT.cancel}
                </button>
                <button
                  type="button"
                  className="requirement-action"
                  data-testid="requirement-save"
                  data-primary="true"
                  disabled={busy !== null || !canSaveEdit(requirement, draft)}
                  aria-busy={busy === 'save'}
                  onClick={save}
                >
                  {TEXT.save}
                </button>
              </div>
            </div>
          ) : (
            <p className="rule-detail-text" data-testid="requirement-text">
              {requirement.text}
            </p>
          )}
        </Field>
        <Field id="author" label={TEXT.author}>
          <AuthorMark
            kind={requirement.author.kind}
            showLabel
            name={ruleAuthorName(requirement.author)}
          />
        </Field>
      </dl>

      <section
        className="rule-section"
        data-testid="requirement-rules"
        aria-labelledby="requirement-rules-heading"
      >
        <h3 id="requirement-rules-heading" className="rule-section-heading">
          {TEXT.rules}
        </h3>
        <ChildRules projectId={projectId} requirement={requirement} load={children} />
      </section>
    </div>
  );
};

const Field = ({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}): React.JSX.Element => (
  <div className="rule-field" data-testid={`requirement-field-${id}`}>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

/** 자식 규칙 목록. 줄을 누르면 그 자리에서 규칙 상세를 펼친다(여러 줄을 함께 펼칠 수 있음). */
const ChildRules = ({
  projectId,
  requirement,
  load,
}: {
  projectId: string;
  requirement: Requirement;
  load: ChildRulesLoad;
}): React.JSX.Element => {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  if (load.state === 'loading') {
    return (
      <div
        className="rule-history-loading"
        data-testid="requirement-rules-loading"
        aria-busy="true"
      />
    );
  }
  if (load.state === 'error') {
    return (
      <p className="rule-detail-error" data-testid="requirement-rules-error" role="alert">
        {TEXT.rulesFailed}
      </p>
    );
  }
  if (load.items.length === 0) {
    return (
      <p className="rule-detail-muted" data-testid="requirement-rules-empty">
        {TEXT.none}
      </p>
    );
  }
  const toggle = (id: string): void =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ul className="child-rule-list">
      {load.items.map((item) => {
        const { rule, judgment } = item;
        const expanded = open.has(rule.id);
        const bodyId = `child-rule-${rule.id}`;
        return (
          <li
            key={rule.id}
            className="child-rule"
            data-testid="child-rule"
            data-rule-id={rule.id}
            data-open={expanded ? 'true' : 'false'}
          >
            <button
              type="button"
              className="child-rule-toggle"
              data-testid="child-rule-toggle"
              aria-expanded={expanded}
              aria-controls={expanded ? bodyId : undefined}
              onClick={() => toggle(rule.id)}
            >
              <ChevronRight className="inline-icon child-rule-chevron" aria-hidden="true" />
              <span className="child-rule-id">{rule.displayId}</span>
              <span className="child-rule-title">{rule.title}</span>
              <StatusBadge kind="judgment" status={judgment.status} />
            </button>
            {expanded && (
              <div id={bodyId} className="child-rule-detail" data-testid="child-rule-detail">
                <RuleDetail projectId={projectId} item={item} parent={requirement} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
};
