// 요구사항 상세 (screens.md SCR-02 상세 · SCR-06 규범 상세, 1.4, ADR-035 · ADR-078).
// 요구사항 목록 + 상세 2단의 상세 영역에 들어간다(별도 화면 아님).
// - 순서: 표시 ID · [편집] · [삭제] → 본문 · 생성 주체(이름) → 자식 규칙 → 구현 위치
// - 자식 규칙을 누르면 그 자리에서 규칙 상세(RuleDetail: 진술 · 속성 · 테스트 출력 · 실행 이력)를 펼친다. 펼친 규칙의 [편집]으로
//   저장하면 응답의 규칙으로 자식 규칙 줄을 바꾼다(옛 제목을 남기지 않음, M7-03 · ADR-109)
// - 직접 편집: [편집] → 본문 입력 → [저장](⌘↵ · Ctrl+Enter) 1회 = requirement.update, [취소](Esc)는 호출 없음.
//   저장 중에는 다시 부르지 않고, 실패하면 입력을 남긴 채 "요구사항 저장 실패"
// - 삭제: 두 번 눌러 확인(SCR-02). 첫 클릭은 [삭제 확인]으로 바뀌기만 하고(호출 없음), 두 번째 클릭에서
//   requirement.delete 1회. 버튼을 벗어나면 확인 대기가 풀린다. 실패하면 "요구사항 삭제 실패"
// - 규칙화 불가 (NRM-08, M3-11 #56 · ADR-137): 서버가 규칙 없는 요구사항으로 정한 것에만 [규칙화 불가]. 누르면 본문 편집과 같은
//   틀의 사유 입력 → [확인](⌘↵ · Ctrl+Enter) 1회 = requirement.markUnrulable, [취소](Esc)는 호출 없음. 사유가 공백만이면 [확인]이
//   꺼진다. 실패하면 입력을 남긴 채 "규칙화 불가 표시 실패". 표시된 요구사항은 "규칙화 불가" 줄에 사유를 보인다(숨은 글자는
//   보이는 표기, visibleLines). 되돌리는 동작은 화면 정의서에 없어 두지 않는다
// - 변경 이력(P1) · 자식 계약(P1)은 해당 이슈 전 미노출 (ADR-035)
// - 구현 위치 (SCR-02 상세 "자식 규칙의 대상 블록만", M3-19 #64 · ADR-126): 자식 규칙(rule.list 1회, 위와 같은 결과) 가운데 효력
//   있는 것의 대상 블록을 중복 없이, 지금 블록 선언(blocks.get) 순서로(선언에 없는 이름은 뒤에 이름 순, "선언 외"). 없으면 "없음".
//   자식 규칙 · 선언을 읽는 동안은 비움, 자식 규칙을 못 읽으면 "구현 위치 불러오기 실패". 읽은 선언은 펼친 자식 규칙에 넘긴다.
//   선언은 블록 선언 알림 · 재접속 때 다시 읽는다(M3-42 #283 · ADR-135)
// - 자식 규칙은 열 때 · 편집 뒤 rule.list로 읽고, 규범 변경 알림 · 재접속 뒤에는 화면의 규칙 목록(`rules`)이 다시 읽은 결과에서
//   고른다(알림 하나에 rule.list 한 번, useChildRules.ts · ADR-135)
// - 자식 규칙 위에 가장 최근 규칙 작성 시도의 상태(대기 · 진행 중 · 생략 · 실패)를 한 줄 보인다. 정상 종료면 없음.
//   값은 ruleWriter.status에서만, 알림 event.ruleWriter.changed · 재접속 · 직접 편집 저장 때 다시 읽는다 (M3-26, ADR-099)
// - 값은 requirement.list 항목 · rule.list · ruleWriter.status · blocks.get 결과에서만 (NFR-03)
import './RequirementDetail.css';

import type { Requirement, RuleWithJudgment } from '@bive/shared';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { AuthorMark } from '../../components/AuthorMark/AuthorMark.js';
import { StatusBadge } from '../../components/StatusBadge/StatusBadge.js';
import { visibleLines, visibleText } from '../../components/VisibleText/visibleText.js';
import {
  type BlockDeclarationLoad,
  BLOCK_TEXT,
  blockListView,
  implementationBlocks,
} from '../rules/blockView.js';
import type { RulesLoad } from '../rules/useRules.js';
import { BlockList } from './BlockList.js';
import {
  canSaveEdit,
  canSubmitUnrulable,
  REQUIREMENT_DETAIL_TEXT as TEXT,
} from './requirementDetailView.js';
import { RuleDetail } from './RuleDetail.js';
import { ruleAuthorName } from './ruleDetailView.js';
import { type RuleWriterStatusView, ruleWriterStatusView } from './ruleWriterStatusView.js';
import { useBlockDeclaration } from './useBlockDeclaration.js';
import { type ChildRulesLoad, useChildRules } from './useChildRules.js';
import { useRuleWriterStatus } from './useRuleWriterStatus.js';

export interface RequirementDetailProps {
  projectId: string;
  requirement: Requirement;
  /** 요구사항 화면의 규칙 목록(폐기 포함). 알림 · 재접속 뒤 다시 읽힌 값에서 자식 규칙을 고른다 */
  rules: RulesLoad;
  /** 직접 편집 저장 (requirement.update). 거부되면 실패 표시 */
  onUpdate: (text: string) => Promise<void>;
  /** 삭제 (requirement.delete). 거부되면 실패 표시 */
  onDelete: () => Promise<void>;
  /** [규칙화 불가]를 보일지: 서버가 정한 규칙 없는 요구사항이고 아직 규칙화 불가가 아닐 때 (기본 거짓) */
  canMarkUnrulable?: boolean;
  /** 규칙화 불가 표시 (requirement.markUnrulable). 거부되면 실패 표시 */
  onMarkUnrulable?: (reason: string) => Promise<void>;
}

type Busy = 'save' | 'delete' | 'unrulable' | null;

const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.userAgent);

/** 요구사항이 바뀌면 편집 · 확인 대기 · 펼침 상태를 새로 시작하도록 호출하는 쪽이 `key={requirement.id}`를 준다. */
export const RequirementDetail = ({
  projectId,
  requirement,
  rules,
  onUpdate,
  onDelete,
  canMarkUnrulable = false,
  onMarkUnrulable,
}: RequirementDetailProps): React.JSX.Element => {
  const children = useChildRules(projectId, requirement.id, requirement.updatedAt, rules);
  const writer = useRuleWriterStatus(projectId, requirement.id, requirement.updatedAt);
  const declaration = useBlockDeclaration(projectId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [marking, setMarking] = useState(false);
  const [reason, setReason] = useState('');
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [failed, setFailed] = useState<Busy>(null);
  // 같은 틱에 두 번 눌러도 한 번만 부르도록 상태와 별도로 둔다
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (marking) reasonRef.current?.focus();
  }, [marking]);

  const run = (kind: Exclude<Busy, null>, call: () => Promise<void>, onDone: () => void): void => {
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

  const startMark = (): void => {
    if (busyRef.current) return;
    setReason('');
    setArmed(false);
    setFailed(null);
    setMarking(true);
  };

  const cancelMark = (): void => {
    if (busyRef.current) return;
    setMarking(false);
    setFailed(null);
  };

  const submitMark = (): void => {
    if (busyRef.current || onMarkUnrulable === undefined || !canSubmitUnrulable(reason)) return;
    const text = reason;
    run(
      'unrulable',
      () => onMarkUnrulable(text),
      () => setMarking(false),
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
        {!editing && !marking && (
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
            {canMarkUnrulable && onMarkUnrulable !== undefined && (
              <button
                type="button"
                className="requirement-action"
                data-testid="requirement-unrulable"
                disabled={busy !== null}
                onClick={startMark}
              >
                {TEXT.unrulable}
              </button>
            )}
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
          {failed === 'save'
            ? TEXT.saveFailed
            : failed === 'unrulable'
              ? TEXT.unrulableFailed
              : TEXT.removeFailed}
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
                <span className="requirement-editor-hint" data-testid="requirement-editor-hint">
                  {isMac() ? '⌘↵ 저장 · Esc 취소' : 'Ctrl+Enter 저장 · Esc 취소'}
                </span>
                <span className="requirement-editor-buttons">
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
                </span>
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
        {requirement.unrulable !== null ? (
          <Field id="unrulable" label={TEXT.unrulable}>
            <p className="rule-detail-text" data-testid="requirement-unrulable-reason">
              {visibleLines(requirement.unrulable.reason)}
            </p>
          </Field>
        ) : (
          marking && (
            <Field id="unrulable" label={TEXT.unrulable}>
              <div className="requirement-editor" data-testid="requirement-unrulable-editor">
                <textarea
                  ref={reasonRef}
                  className="requirement-edit-input"
                  data-testid="requirement-unrulable-input"
                  aria-label={TEXT.unrulableLabel}
                  placeholder={TEXT.unrulablePlaceholder}
                  rows={2}
                  value={reason}
                  readOnly={busy === 'unrulable'}
                  aria-busy={busy === 'unrulable'}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setFailed(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      submitMark();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      cancelMark();
                    }
                  }}
                />
                <div className="requirement-editor-bar">
                  <span className="requirement-editor-hint">
                    {isMac() ? '⌘↵ 확인 · Esc 취소' : 'Ctrl+Enter 확인 · Esc 취소'}
                  </span>
                  <span className="requirement-editor-buttons">
                    <button
                      type="button"
                      className="requirement-action"
                      data-testid="requirement-unrulable-cancel"
                      disabled={busy !== null}
                      onClick={cancelMark}
                    >
                      {TEXT.cancel}
                    </button>
                    <button
                      type="button"
                      className="requirement-action"
                      data-testid="requirement-unrulable-confirm"
                      data-primary="true"
                      disabled={busy !== null || !canSubmitUnrulable(reason)}
                      aria-busy={busy === 'unrulable'}
                      onClick={submitMark}
                    >
                      {TEXT.unrulableConfirm}
                    </button>
                  </span>
                </div>
              </div>
            </Field>
          )
        )}
      </dl>

      <section
        className="rule-section"
        data-testid="requirement-rules"
        aria-labelledby="requirement-rules-heading"
      >
        <h3 id="requirement-rules-heading" className="rule-section-heading">
          {TEXT.rules}
        </h3>
        <RuleWriterStatusLine view={ruleWriterStatusView(writer)} />
        <ChildRules
          projectId={projectId}
          requirement={requirement}
          load={children.load}
          onEdited={children.replace}
          blocks={declaration}
        />
      </section>

      <section
        className="rule-section"
        data-testid="requirement-implementation"
        aria-labelledby="requirement-implementation-heading"
      >
        <h3 id="requirement-implementation-heading" className="rule-section-heading">
          {BLOCK_TEXT.implementation}
        </h3>
        <Implementation load={children.load} declaration={declaration} />
      </section>
    </div>
  );
};

/** 구현 위치: 효력 있는 자식 규칙의 대상 블록 (선언 순서, 중복 없음). */
const Implementation = ({
  load,
  declaration,
}: {
  load: ChildRulesLoad;
  declaration: BlockDeclarationLoad;
}): React.JSX.Element => {
  if (load.state === 'error') {
    return (
      <p className="rule-detail-muted" data-testid="requirement-implementation-error">
        {BLOCK_TEXT.implementationFailed}
      </p>
    );
  }
  if (load.state === 'loading' || declaration.state === 'loading') {
    return (
      <div
        className="rule-history-loading"
        data-testid="requirement-implementation-loading"
        aria-busy="true"
      />
    );
  }
  const names = implementationBlocks(
    load.items,
    declaration.state === 'ready' ? declaration.names : null,
  );
  return <BlockList view={blockListView(names, declaration)} testId="requirement-blocks" />;
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

/** 가장 최근 규칙 작성 시도의 상태 한 줄 (+ 설명 한 줄). 정상 종료 · 기록 없음이면 그리지 않는다 (ADR-099). */
const RuleWriterStatusLine = ({
  view,
}: {
  view: RuleWriterStatusView | null;
}): React.JSX.Element | null => {
  if (view === null) return null;
  return (
    <div
      className="rule-writer-status"
      data-testid="requirement-rule-writer"
      data-state={view.kind}
      data-tone={view.tone}
      role="status"
    >
      <span data-testid="requirement-rule-writer-label">
        {view.reason === null ? view.label : `${view.label} · ${view.reason}`}
      </span>
      {view.detail !== null && (
        <p
          className="rule-writer-detail"
          data-testid="requirement-rule-writer-detail"
          title={view.detail}
        >
          {view.detail}
        </p>
      )}
    </div>
  );
};

/** 자식 규칙 목록. 줄을 누르면 그 자리에서 규칙 상세를 펼친다(여러 줄을 함께 펼칠 수 있음). */
const ChildRules = ({
  projectId,
  requirement,
  load,
  onEdited,
  blocks,
}: {
  projectId: string;
  requirement: Requirement;
  load: ChildRulesLoad;
  onEdited: (item: RuleWithJudgment) => void;
  blocks: BlockDeclarationLoad;
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
              <span className="child-rule-title">{visibleText(rule.title)}</span>
              <StatusBadge kind="judgment" status={judgment.status} />
            </button>
            {expanded && (
              <div id={bodyId} className="child-rule-detail" data-testid="child-rule-detail">
                <RuleDetail
                  projectId={projectId}
                  item={item}
                  sourceScreen="SCR-02"
                  parent={requirement}
                  onEdited={onEdited}
                  blocks={blocks}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
};
