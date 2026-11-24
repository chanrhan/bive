// 규칙 상세 (screens.md SCR-03 상세 · SCR-06 규범 상세, 1.4 상세 접힘, ADR-035 · ADR-073).
// 규칙 목록 + 상세 2단의 상세 영역에 들어간다(별도 화면 아님). 요구사항 상세(#38)가 자식 규칙을 펼칠 때 다시 쓴다.
// - 순서: 제목 · ID · 판정 → 진술 · 종류 · 검사 · 부모 요구사항 · 생성 주체 → 테스트 실행 결과 → 테스트 출력(접힘) → 실행 이력
// - 실행 이력은 실행 하나가 한 줄이다(판정 · 실행 ID · 실행 상태와 종료 사유 · 커밋, runHistoryView.ts, ADR-123)
// - 테스트 출력은 기본 접힘, 최신 판정이 실패면 자동 펼침. 안에 실패 원인(케이스 이름 · `file:line` · 메시지) · 전체 케이스
// - 실패 원인의 `file:line`(판정 기록의 케이스 위치)에 코드 열기 링크(CodeLink)를 붙인다. 출발 화면은 놓는 화면이 정하고
//   항목은 이 규칙이다 (MET-01, ADR-084). 줄이 없거나 상대 경로가 아니면 글자만 보인다
// - 변경 이력(P1) · 변이 상태 · 대상 블록 · 위험도는 해당 이슈 전 미노출 (ADR-035)
// - 머리 오른쪽 동작(`actions`)은 놓는 화면이 정한다: 규칙 화면은 [실행] (M1-19, ADR-076)
// - 직접 편집 (ADR-100 B②, M7-03 · ADR-109): 놓는 화면이 `onEdited`를 주면 머리에 [편집](효력 있고 내장 구조 규칙이 아닌
//   규칙만). [편집] → 제목 · 진술 입력 → [저장](⌘↵ · Ctrl+Enter) 1회 = rule.update(바뀐 칸만), [취소](Esc)는 호출 없음.
//   저장 중에는 다시 부르지 않고, 실패하면 입력을 남긴 채 사유 한 줄(형식 오류면 서버 사유 한 줄 더). 성공하면 응답의 규칙을
//   놓는 화면에 넘기고(목록의 옛 제목을 남기지 않게) 실행 자동 시작 결과 한 줄을 머리 아래에 보인다
// - 확인 상태(확인됨 · 미확인)를 속성 줄에 보인다. 사람이 고친 규칙은 확인됨이다. 미확인이면 그 줄에 [확인](놓는 화면이
//   `onEdited`를 줄 때, 폐기되지 않은 규칙만): 사람 주체 confirmation.set 1회, 저장 중 다시 부르지 않음, 실패하면 사유 한 줄,
//   성공하면 응답의 확인 상태로 바꾼 항목을 `onEdited`로 넘긴다(목록 카드의 미확인도 사라진다, M7-15 · ADR-114)
// - 폐기된 규칙(응답의 `retirement`): 머리에 "폐기"(판정 배지 자리), 대체한 규칙이 있으면 그 규칙으로 가는 링크(`onOpenRule`),
//   속성 줄에 폐기 시각. [편집] · [확인]은 없고 놓는 화면도 [실행]을 두지 않는다. 변경 이력을 처음부터 펼친다
// - 변경 이력(normChange.list): 시각 · 종류 · 주체 · 판단 대상 · 사유 또는 근거. 기본 접힘(1.4), 폐기된 규칙은 펼침. 판단 · 대체
//   기록의 규칙은 `onOpenRule`이 있으면 링크다(새 규칙에서 대체된 옛 규칙으로, 옛 규칙에서 새 규칙으로)
// - 제목 · 진술 · 테스트 케이스 이름은 숨은 글자를 보이는 표기로 그린다(visibleText). 실패 메시지는 줄을 살리고 숨은 글자만
//   표기한다(visibleLines). 편집 입력에는 원문을 넣는다. 편집 중에는 [확인]이 없다. 변경 기록 검증이 깨졌으면 변경 이력을 펼친다
// - 요구사항 상세가 자식 규칙으로 펼칠 때는 부모(`parent`)를 넘겨 requirement.get을 다시 부르지 않는다 (ADR-078)
// - 값은 rule.list 항목 · judgment.list · requirement.get 결과에서만 (NFR-03)
import './RuleDetail.css';

import type {
  JudgmentCase,
  NormJudgmentRuleRef,
  Requirement,
  RuleEditAutoStart,
  RuleWithJudgment,
  ScreenId,
} from '@bive/shared';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { AuthorMark } from '../../components/AuthorMark/AuthorMark.js';
import { CodeLink } from '../../components/CodeLink/CodeLink.js';
import { linkableLine } from '../../components/CodeLink/codeLinkView.js';
import { CollapsibleDetail } from '../../components/CollapsibleDetail/CollapsibleDetail.js';
import { StatusBadge } from '../../components/StatusBadge/StatusBadge.js';
import { visibleLines, visibleText } from '../../components/VisibleText/visibleText.js';
import { NORM_CHANGE_TEXT, normChangeRow } from './normChangeView.js';
import {
  CASE_STATUS_LABELS,
  caseCountText,
  caseLocation,
  checkKindsText,
  failureCases,
  judgedAtText,
  latestRunDisplayId,
  outputOpenByDefault,
  RULE_DETAIL_TEXT as TEXT,
  ruleAuthorName,
  ruleKindLabel,
  shortCommit,
} from './ruleDetailView.js';
import {
  canConfirmRule,
  canEditRule,
  canSaveRuleEdit,
  confirmationText,
  confirmErrorText,
  confirmParams,
  RULE_EDIT_TEXT as EDIT,
  type RuleEditDraft,
  type RuleEditError,
  ruleEditAutoStartText,
  ruleEditErrorText,
  ruleEditParams,
} from './ruleEditView.js';
import { type RunHistoryRow, runHistoryRows } from './runHistoryView.js';
import {
  type ProjectRunsLoad,
  type RuleHistoryLoad,
  type RuleNormChangesLoad,
  useProjectRuns,
  useRuleHistory,
  useRuleNormChanges,
  useRuleParent,
} from './useRuleDetailData.js';

export interface RuleDetailProps {
  projectId: string;
  item: RuleWithJudgment;
  /** 이 상세를 보이는 화면 (코드 열기 기록의 출발 화면: 규칙 SCR-03 · 요구사항 SCR-02) */
  sourceScreen: ScreenId;
  /** 머리 오른쪽에 둘 동작 (규칙 화면의 [실행]) */
  actions?: ReactNode;
  /** 머리줄 아래 한 줄 (규칙 화면이 만든 실행의 상태, ADR-105). 머리줄의 폭을 먹지 않는다 */
  notice?: ReactNode;
  /** 이미 가진 부모 요구사항 (요구사항 상세에서 펼칠 때). 주면 `requirement.get`을 부르지 않는다 */
  parent?: Requirement;
  /** 직접 편집 · 확인이 저장되면 바뀐 항목을 받는다. 주면 [편집] · [확인]이 생긴다 */
  onEdited?: (item: RuleWithJudgment) => void;
  /** 다른 규칙(대체한 규칙 · 대체된 규칙)의 상세로 간다. 없으면 규칙 표시 ID는 글자만 */
  onOpenRule?: (ruleId: string) => void;
}

const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.userAgent);

/** 규칙이 바뀌면 접힘 상태 · 불러온 값을 새로 시작하도록 호출하는 쪽이 `key={rule.id}`를 준다. */
export const RuleDetail = ({
  projectId,
  item,
  sourceScreen,
  actions,
  notice,
  parent: knownParent,
  onEdited,
  onOpenRule,
}: RuleDetailProps): React.JSX.Element => {
  const { rule, judgment, retirement } = item;
  const retired = retirement !== undefined;
  const [draft, setDraft] = useState<RuleEditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<RuleEditError | null>(null);
  // 마지막 저장의 실행 자동 시작 결과 (저장한 규칙에서만 보인다)
  const [saved, setSaved] = useState<{ autoStart: RuleEditAutoStart | null } | null>(null);
  // [확인] 저장 중 · 실패 문구
  const [confirming, setConfirming] = useState(false);
  const [confirmFailure, setConfirmFailure] = useState<string | null>(null);
  const confirmingRef = useRef(false);
  // 같은 틱에 두 번 눌러도 한 번만 부르도록 상태와 별도로 둔다
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const titleRef = useRef<HTMLInputElement>(null);
  const editing = draft !== null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (editing) titleRef.current?.focus();
  }, [editing]);

  const startEdit = (): void => {
    if (savingRef.current) return;
    setDraft({ title: rule.title, statement: rule.statement });
    setFailure(null);
    setSaved(null);
  };

  const cancelEdit = (): void => {
    if (savingRef.current) return;
    setDraft(null);
    setFailure(null);
  };

  const save = (): void => {
    if (savingRef.current || draft === null || !canSaveRuleEdit(rule, draft)) return;
    savingRef.current = true;
    setSaving(true);
    setFailure(null);
    window.bive.invoke('rule.update', ruleEditParams(projectId, rule, draft)).then(
      (result) => {
        savingRef.current = false;
        if (!mounted.current) return;
        setSaving(false);
        setDraft(null);
        setSaved({ autoStart: result.autoStart });
        onEdited?.({ rule: result.rule, judgment: result.judgment });
      },
      (error: unknown) => {
        savingRef.current = false;
        if (!mounted.current) return;
        setSaving(false);
        setFailure(ruleEditErrorText(error));
      },
    );
  };

  const confirm = (): void => {
    if (confirmingRef.current || !canConfirmRule(rule, retired)) return;
    confirmingRef.current = true;
    setConfirming(true);
    setConfirmFailure(null);
    window.bive.invoke('confirmation.set', confirmParams(projectId, rule)).then(
      (result) => {
        confirmingRef.current = false;
        if (!mounted.current) return;
        setConfirming(false);
        onEdited?.({ ...item, rule: { ...rule, confirmation: result.confirmation } });
      },
      (error: unknown) => {
        confirmingRef.current = false;
        if (!mounted.current) return;
        setConfirming(false);
        setConfirmFailure(confirmErrorText(error));
      },
    );
  };

  const editKeys = (event: React.KeyboardEvent): void => {
    // 조합 중(isComposing, 일부 환경은 keyCode 229만 준다)의 키는 조합 확정용이다
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    } else if (event.key === 'Enter') {
      // 제목 · 진술은 한 줄이다 (서버도 줄바꿈을 거부)
      event.preventDefault();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
    }
  };
  const autoStartText = saved === null ? null : ruleEditAutoStartText(saved.autoStart);
  const editable = onEdited !== undefined && canEditRule(rule, retired);
  // 편집 중에는 [확인]을 숨긴다 (저장되지 않은 입력을 둔 채 저장된 글을 확인하지 않게)
  const confirmable = onEdited !== undefined && !editing && canConfirmRule(rule, retired);
  const changes = useRuleNormChanges(
    projectId,
    rule.id,
    `${rule.updatedAt}|${String(retirement?.normChangeSeq ?? '')}|${String(retired)}`,
  );
  const latest = judgment.latest;
  const history = useRuleHistory(projectId, rule.id, latest?.id ?? null);
  const runs = useProjectRuns(projectId);
  const knownMatches = knownParent !== undefined && knownParent.id === rule.parentRequirementId;
  const fetchedParent = useRuleParent(projectId, knownMatches ? null : rule.parentRequirementId);
  const parent = knownMatches ? knownParent : fetchedParent;
  const entries = history.state === 'ready' ? history.entries : null;
  const runId = latestRunDisplayId(latest, entries);
  const counts = latest === null ? null : caseCountText(latest.cases);

  return (
    <div className="rule-detail-body" data-testid="rule-detail-body" data-rule-id={rule.id}>
      <header className="rule-detail-head">
        <h2 className="rule-detail-title" data-testid="rule-detail-title">
          {visibleText(rule.title)}
        </h2>
        <span className="rule-detail-id" data-testid="rule-detail-id">
          {rule.displayId}
        </span>
        {retired ? (
          <span className="rule-detail-retired" data-testid="rule-detail-retired">
            {TEXT.retired}
          </span>
        ) : (
          <StatusBadge kind="judgment" status={judgment.status} />
        )}
        {retirement?.supersededBy != null && (
          <span className="rule-detail-successor" data-testid="rule-detail-successor">
            {`${TEXT.successor} `}
            <RuleRefLink rule={retirement.supersededBy} onOpenRule={onOpenRule} />
          </span>
        )}
        {(editable || actions !== undefined) && (
          <div className="rule-detail-actions" data-testid="rule-detail-actions">
            {editable && !editing && (
              <button
                type="button"
                className="rule-action"
                data-testid="rule-edit"
                onClick={startEdit}
              >
                {EDIT.edit}
              </button>
            )}
            {actions}
          </div>
        )}
      </header>
      {notice}
      {autoStartText !== null && (
        <p className="rule-edit-result" data-testid="rule-edit-result" role="status">
          {autoStartText}
        </p>
      )}
      {failure !== null && (
        <div className="rule-detail-error" data-testid="rule-edit-error" role="alert">
          <span data-testid="rule-edit-error-label">{failure.label}</span>
          {failure.detail !== null && (
            <p className="rule-edit-error-detail" data-testid="rule-edit-error-detail">
              {failure.detail}
            </p>
          )}
        </div>
      )}

      <dl className="rule-fields">
        {draft !== null && (
          <Field id="title" label={EDIT.title} stacked>
            <input
              ref={titleRef}
              type="text"
              className="rule-edit-input"
              data-testid="rule-edit-title"
              aria-label={EDIT.titleLabel}
              value={draft.title}
              readOnly={saving}
              aria-busy={saving}
              onChange={(event) => {
                setDraft({ ...draft, title: event.target.value });
                setFailure(null);
              }}
              onKeyDown={editKeys}
            />
          </Field>
        )}
        <Field id="statement" label={TEXT.statement} stacked={draft !== null}>
          {draft === null ? (
            <p className="rule-detail-text" data-testid="rule-detail-statement">
              {visibleText(rule.statement)}
            </p>
          ) : (
            <div className="rule-editor" data-testid="rule-editor">
              <textarea
                className="rule-edit-input rule-edit-statement"
                data-testid="rule-edit-statement"
                aria-label={EDIT.statementLabel}
                rows={3}
                value={draft.statement}
                readOnly={saving}
                aria-busy={saving}
                onChange={(event) => {
                  setDraft({ ...draft, statement: event.target.value });
                  setFailure(null);
                }}
                onKeyDown={editKeys}
              />
              <div className="rule-editor-bar">
                <span className="rule-editor-hint" data-testid="rule-editor-hint">
                  {isMac() ? '⌘↵ 저장 · Esc 취소' : 'Ctrl+Enter 저장 · Esc 취소'}
                </span>
                <span className="rule-editor-buttons">
                  <button
                    type="button"
                    className="rule-action"
                    data-testid="rule-edit-cancel"
                    disabled={saving}
                    onClick={cancelEdit}
                  >
                    {EDIT.cancel}
                  </button>
                  <button
                    type="button"
                    className="rule-action"
                    data-testid="rule-edit-save"
                    data-primary="true"
                    disabled={saving || !canSaveRuleEdit(rule, draft)}
                    aria-busy={saving}
                    onClick={save}
                  >
                    {EDIT.save}
                  </button>
                </span>
              </div>
            </div>
          )}
        </Field>
        <Field id="kind" label={TEXT.kind}>
          {ruleKindLabel(rule.kind)}
        </Field>
        <Field id="checks" label={TEXT.checks}>
          {checkKindsText(rule.checkKinds)}
        </Field>
        {rule.parentRequirementId === null ? (
          <Field id="parent" label={TEXT.parent}>
            {TEXT.none}
          </Field>
        ) : (
          parent !== null && (
            <Field id="parent" label={TEXT.parent}>
              {`${parent.displayId} · ${parent.text}`}
            </Field>
          )
        )}
        <Field id="author" label={TEXT.author}>
          <AuthorMark kind={rule.author.kind} showLabel name={ruleAuthorName(rule.author)} />
        </Field>
        <Field id="confirmation" label={EDIT.confirmationState}>
          <span className="rule-confirmation">
            <span data-testid="rule-confirmation-state" data-state={rule.confirmation.state}>
              {confirmationText(rule)}
            </span>
            {confirmable && (
              <button
                type="button"
                className="rule-action"
                data-testid="rule-confirm"
                disabled={confirming}
                aria-busy={confirming}
                onClick={confirm}
              >
                {EDIT.confirm}
              </button>
            )}
          </span>
          {confirmFailure !== null && (
            <p className="rule-detail-error" data-testid="rule-confirm-error" role="alert">
              {confirmFailure}
            </p>
          )}
        </Field>
        {retirement !== undefined && (
          <Field id="retired-at" label={TEXT.retiredAt}>
            {retirement.retiredAt === null ? (
              TEXT.unknown
            ) : (
              <time dateTime={retirement.retiredAt}>{judgedAtText(retirement.retiredAt)}</time>
            )}
          </Field>
        )}
      </dl>

      <Section id="result" title={TEXT.result}>
        {latest === null ? (
          <p className="rule-detail-muted" data-testid="rule-no-judgment">
            {TEXT.noJudgment}
          </p>
        ) : (
          <dl className="rule-fields">
            <Field id="result-status" label={TEXT.status}>
              <StatusBadge kind="judgment" status={latest.status} />
            </Field>
            <Field id="result-judged-at" label={TEXT.judgedAt}>
              <time dateTime={latest.judgedAt}>{judgedAtText(latest.judgedAt)}</time>
            </Field>
            <Field id="result-commit" label={TEXT.commit}>
              <span className="rule-mono" title={latest.commit}>
                {shortCommit(latest.commit)}
              </span>
            </Field>
            {runId !== null && (
              <Field id="result-run" label={TEXT.run}>
                {runId}
              </Field>
            )}
            <Field id="result-cases" label={TEXT.cases}>
              {counts ?? TEXT.noCases}
            </Field>
          </dl>
        )}
      </Section>

      {latest !== null && (
        <div className="rule-test-output" data-testid="rule-test-output">
          <CollapsibleDetail title={TEXT.output} forceOpen={outputOpenByDefault(latest)}>
            <TestOutput
              cases={latest.cases}
              link={{ projectId, sourceScreen, itemRef: { entity: 'Rule', id: rule.id } }}
            />
          </CollapsibleDetail>
        </div>
      )}

      <Section id="history" title={TEXT.history}>
        <History ruleId={rule.id} load={history} runs={runs} />
      </Section>

      <div className="rule-changes" data-testid="rule-changes">
        <CollapsibleDetail
          title={NORM_CHANGE_TEXT.history}
          forceOpen={retired || (changes.state === 'ready' && !changes.chainValid)}
        >
          <NormChanges load={changes} onOpenRule={onOpenRule} />
        </CollapsibleDetail>
      </div>
    </div>
  );
};

/** 다른 규칙의 표시 ID: 갈 수 있으면 링크 버튼, 아니면 글자. */
const RuleRefLink = ({
  rule,
  onOpenRule,
}: {
  rule: NormJudgmentRuleRef;
  onOpenRule: ((ruleId: string) => void) | undefined;
}): React.JSX.Element =>
  onOpenRule === undefined ? (
    <span data-testid="rule-ref" data-rule-id={rule.id}>
      {rule.displayId}
    </span>
  ) : (
    <button
      type="button"
      className="rule-ref-link"
      data-testid="rule-ref"
      data-rule-id={rule.id}
      onClick={() => onOpenRule(rule.id)}
    >
      {rule.displayId}
    </button>
  );

/** 변경 이력: 규범 변경 기록을 순번 순으로 (시각 · 종류 · 주체 / 판단 대상 / 사유 · 근거). */
const NormChanges = ({
  load,
  onOpenRule,
}: {
  load: RuleNormChangesLoad;
  onOpenRule: ((ruleId: string) => void) | undefined;
}): React.JSX.Element => {
  if (load.state === 'loading') {
    return (
      <div className="rule-history-loading" data-testid="rule-changes-loading" aria-busy="true" />
    );
  }
  if (load.state === 'error') {
    return (
      <p className="rule-detail-error" data-testid="rule-changes-error" role="alert">
        {NORM_CHANGE_TEXT.loadFailed}
      </p>
    );
  }
  return (
    <div className="rule-change-body">
      {!load.chainValid && (
        <p className="rule-detail-error" data-testid="rule-changes-broken" role="alert">
          {NORM_CHANGE_TEXT.chainBroken}
        </p>
      )}
      {load.entries.length === 0 ? (
        <p className="rule-detail-muted" data-testid="rule-changes-empty">
          {NORM_CHANGE_TEXT.empty}
        </p>
      ) : (
        <ol className="rule-change-list">
          {load.entries.map(normChangeRow).map((row) => (
            <li key={row.seq} className="rule-change-row" data-testid="change-row">
              <div className="rule-change-head">
                <time dateTime={row.at}>{row.time}</time>
                <span className="rule-change-kind" data-testid="change-kind">
                  {row.kind}
                </span>
                <span className="rule-change-actor" data-testid="change-actor">
                  {row.actor}
                </span>
              </div>
              {row.subject !== null && (
                <div className="rule-change-subject" data-testid="change-subject">
                  <span>{row.subject.label}</span>
                  {row.subject.rules.map((ref) => (
                    <RuleRefLink key={ref.id} rule={ref} onOpenRule={onOpenRule} />
                  ))}
                </div>
              )}
              {row.text !== null && (
                <p className="rule-change-text" data-testid="change-text">
                  <span className="rule-change-label" data-testid="change-text-label">
                    {row.text.label}
                  </span>
                  <span data-testid="change-text-value">{row.text.value}</span>
                  {row.truncated && (
                    <span className="rule-change-truncated" data-testid="change-truncated">
                      {NORM_CHANGE_TEXT.truncated}
                    </span>
                  )}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};

const Field = ({
  id,
  label,
  children,
  stacked = false,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
  /** 이름을 위에, 값을 아래 전체 폭에 (편집 입력) */
  stacked?: boolean;
}): React.JSX.Element => (
  <div
    className={stacked ? 'rule-field rule-field-stacked' : 'rule-field'}
    data-testid={`rule-field-${id}`}
  >
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

const Section = ({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element => {
  const headingId = `rule-${id}-heading`;
  return (
    <section className="rule-section" data-testid={`rule-${id}`} aria-labelledby={headingId}>
      <h3 id={headingId} className="rule-section-heading">
        {title}
      </h3>
      {children}
    </section>
  );
};

/** 실패 원인 위치의 코드 열기 링크 값 (위치 `file` · `line` 말고). */
type CaseLinkContext = Omit<React.ComponentProps<typeof CodeLink>, 'file' | 'line'>;

/** 테스트 출력: 실패 원인(통과하지 않은 케이스의 실행기 출력) → 전체 케이스. */
const TestOutput = ({
  cases,
  link,
}: {
  cases: readonly JudgmentCase[];
  link: CaseLinkContext;
}): React.JSX.Element => {
  if (cases.length === 0) {
    return <p className="rule-detail-muted">{TEXT.noCases}</p>;
  }
  const failures = failureCases(cases);
  return (
    <div className="rule-output">
      {failures.length > 0 && (
        <div className="rule-output-group" data-testid="rule-failures">
          <h4 className="rule-output-heading">{TEXT.failures}</h4>
          <ul className="rule-case-list">
            {failures.map((item, index) => (
              <li
                key={`${item.file}:${item.line ?? ''}:${item.name}:${index}`}
                className="rule-failure"
                data-testid="failure-case"
                data-status={item.status}
              >
                <div className="rule-case-line">
                  <span className="rule-case-status" data-status={item.status}>
                    {CASE_STATUS_LABELS[item.status]}
                  </span>
                  <span className="rule-case-name" data-testid="failure-case-name">
                    {visibleText(item.name)}
                  </span>
                </div>
                <span className="rule-mono rule-case-location" data-testid="failure-case-location">
                  <CaseLocation item={item} link={link} />
                </span>
                <pre className="rule-case-message" data-testid="failure-case-message">
                  {item.message === null ? TEXT.noMessage : visibleLines(item.message)}
                </pre>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="rule-output-group" data-testid="rule-cases">
        <h4 className="rule-output-heading">{TEXT.allCases}</h4>
        <ul className="rule-case-list">
          {cases.map((item, index) => (
            <li
              key={`${item.file}:${item.line ?? ''}:${item.name}:${index}`}
              className="rule-case-line"
              data-testid="test-case"
              data-status={item.status}
            >
              <span className="rule-case-status" data-status={item.status}>
                {CASE_STATUS_LABELS[item.status]}
              </span>
              <span className="rule-case-name">{visibleText(item.name)}</span>
              <span className="rule-mono rule-case-location">{caseLocation(item)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

/** 실패 케이스 위치: 링크를 붙일 수 있으면 코드 열기 링크, 아니면 글자. */
const CaseLocation = ({
  item,
  link,
}: {
  item: JudgmentCase;
  link: CaseLinkContext;
}): React.JSX.Element => {
  const line = linkableLine(item);
  return line === null ? (
    <>{caseLocation(item)}</>
  ) : (
    <CodeLink {...link} file={item.file} line={line} />
  );
};

/** 실행 이력: 실행 하나가 한 줄, 최신부터 (시각 · 판정 · 실행 · 실행 상태와 종료 사유 · 커밋, ADR-123). */
const History = ({
  ruleId,
  load,
  runs,
}: {
  ruleId: string;
  load: RuleHistoryLoad;
  runs: ProjectRunsLoad;
}): React.JSX.Element => {
  if (load.state === 'loading' || runs.state === 'loading') {
    return (
      <div className="rule-history-loading" data-testid="rule-history-loading" aria-busy="true" />
    );
  }
  if (load.state === 'error') {
    return (
      <p className="rule-detail-error" data-testid="rule-history-error" role="alert">
        {TEXT.historyFailed}
      </p>
    );
  }
  const rows = runHistoryRows(ruleId, load.entries, runs.runs);
  return (
    <>
      {runs.runs === null && (
        <p className="rule-detail-muted" data-testid="rule-runs-error">
          {TEXT.runsFailed}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="rule-detail-muted" data-testid="rule-history-empty">
          {TEXT.noHistory}
        </p>
      ) : (
        <ol className="rule-history-list">
          {rows.map((row) => (
            <HistoryRow key={row.key} row={row} />
          ))}
        </ol>
      )}
    </>
  );
};

const HistoryRow = ({ row }: { row: RunHistoryRow }): React.JSX.Element => (
  <li
    className="rule-history-row"
    data-testid="history-row"
    data-status={row.judgment?.status ?? ''}
    data-run={row.runDisplayId ?? ''}
  >
    <time dateTime={row.at}>{row.time}</time>
    {/* 칸 자리는 값이 없어도 둔다(판정 없이 끝난 실행의 줄도 같은 칸에 맞춰 보인다) */}
    <span className="rule-history-judgment">
      {row.judgment !== null && <StatusBadge kind="judgment" status={row.judgment.status} />}
    </span>
    <span data-testid="history-run">{row.runDisplayId ?? ''}</span>
    <span className="rule-mono">
      {row.judgment !== null && (
        <span title={row.judgment.commit}>{shortCommit(row.judgment.commit)}</span>
      )}
    </span>
    {row.status !== null && (
      <span className="rule-history-status" data-testid="history-run-status">
        {row.status}
      </span>
    )}
  </li>
);
