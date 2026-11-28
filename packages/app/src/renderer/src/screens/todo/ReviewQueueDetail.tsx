// 검토 대기열 상세 (SCR-18, TODO-02 · COST-01, ADR-145 · ADR-149 · ADR-153 · ADR-155 · ADR-157): 확인할 것 상세의 배치를 따른다.
// 머리(종류 · 대상 규칙 제목 · 원인 실행 표시 ID · 처리 상태 · 등록 시각 · 액션 버튼 · 입력 · 거부 한 줄) → 원인 실행(표시 ID ·
// 상태 · 종료 사유 · 멈춘 단계) → 대상 규칙(규칙 화면 링크) → 처리 결과(처리된 항목만).
// - 원인 실행의 멈춘 단계 · 지금 한도는 `run.get`으로 읽는다(항목에는 없다). 못 읽으면 그 칸만 비우고 한도 입력은 만들 수 없다
// - 액션 버튼은 열린 항목에만: 변이 생존 = [테스트 보강] · [판정 격리] · [이의 제기](늘 꺼짐, 까닭은 툴팁), 예산 초과 = [한도 상향
//   재개] · [허용 목록 축소 재개] · [규칙 분할]. 누르면 그 액션의 입력이 머리 아래에 열리고 [확인]이 RPC를 1번 부른다
// - [확인]이 꺼지는 조건은 빈 값뿐이다: 격리 사유(공백뿐 포함) · 한도 칸 · 제외 경로 · 나눌 규칙. 나머지 판정은 서버 거부로 보인다
import type { BudgetSnapshot, ReviewAction, ReviewQueueEntry, RunGetResult } from '@bive/shared';
import { useEffect, useId, useState } from 'react';

import { formatCardTime } from '../../components/Card2Line/time.js';
import { tooltipTrigger } from '../../components/Tooltip/index.js';
import { visibleText } from '../../components/VisibleText/visibleText.js';
import { EmptyState } from '../../layout/EmptyState.js';
import { runFailureReasonText } from '../norm-detail/runHistoryView.js';
import { RUN_STATUS_TEXT, STEP_LABELS } from '../verification/verificationView.js';
import { DetailSection, Field, useOpenLink } from './ConfirmationDetail.js';
import {
  type BudgetField,
  budgetFields,
  budgetFormValues,
  budgetFromForm,
  excludeLines,
  initialSplitRule,
  quarantineReady,
  REVIEW_ACTION_TEXT,
  REVIEW_ACTIONS_BY_KIND_ORDER,
  REVIEW_ITEM_KIND_TEXT,
  REVIEW_ITEM_STATE_TEXT,
  REVIEW_TEXT,
  reviewErrorText,
  reviewResult,
  reviewState,
  reviewTitle,
} from './reviewQueueView.js';

/** 액션 요청 (RPC 인자 가운데 화면이 정하는 값). */
export type ReviewRequest =
  | { action: 'reinforce' }
  | { action: 'quarantine'; reason: string }
  | { action: 'raise_limit_resume'; budget: BudgetSnapshot }
  | { action: 'narrow_allowlist_resume'; budget: BudgetSnapshot; exclude: string[] }
  | { action: 'split_rule'; ruleId: string };

type RunLoad =
  { status: 'loading' } | { status: 'ready'; result: RunGetResult } | { status: 'error' };

/** 실행 1건 (`run.get`). ID가 바뀌면 다시 읽고 늦게 온 응답은 버린다. */
const useRun = (projectId: string, runId: string | null): RunLoad => {
  const [loaded, setLoaded] = useState<{ runId: string; load: RunLoad } | null>(null);
  useEffect(() => {
    if (runId === null) return undefined;
    let live = true;
    window.bive.invoke('run.get', { projectId, id: runId }).then(
      (result) => {
        if (live) setLoaded({ runId, load: { status: 'ready', result } });
      },
      () => {
        if (live) setLoaded({ runId, load: { status: 'error' } });
      },
    );
    return () => {
      live = false;
    };
  }, [projectId, runId]);
  return loaded !== null && loaded.runId === runId ? loaded.load : { status: 'loading' };
};

export interface ReviewQueueDetailProps {
  projectId: string;
  entry: ReviewQueueEntry | null;
  busy: boolean;
  /** 그 항목의 마지막 거부 (없으면 null) */
  failure: { error: unknown } | null;
  onAction: (entry: ReviewQueueEntry, request: ReviewRequest) => Promise<boolean>;
}

export const ReviewQueueDetail = (props: ReviewQueueDetailProps): React.JSX.Element => (
  <section
    className="todo-detail"
    data-testid="todo-detail"
    aria-label={REVIEW_TEXT.detail}
    data-selected-id={props.entry === null ? '' : String(props.entry.item.seq)}
  >
    {props.entry === null ? (
      <EmptyState text={REVIEW_TEXT.noSelection} />
    ) : (
      // 항목이 바뀌면 열린 입력을 닫는다
      <Detail key={props.entry.item.seq} {...props} entry={props.entry} />
    )}
  </section>
);

const Detail = ({
  projectId,
  entry,
  busy,
  failure,
  onAction,
}: ReviewQueueDetailProps & { entry: ReviewQueueEntry }): React.JSX.Element => {
  const { item, run } = entry;
  const result = reviewResult(entry);
  const cause = useRun(projectId, run.id);
  const created = useRun(projectId, result?.runId ?? null);
  const openLink = useOpenLink();
  const [form, setForm] = useState<ReviewAction | null>(null);
  const snapshot = cause.status === 'ready' ? cause.result.run.budgetSnapshot : null;
  const fields = snapshot === null ? [] : budgetFields(snapshot);
  const time = formatCardTime(item.createdAt);
  const state = reviewState(entry);

  const submit = (request: ReviewRequest): void => {
    void onAction(entry, request).then((ok) => {
      if (ok) setForm(null);
    });
  };

  return (
    <div className="confirmation-detail" data-testid="review-detail">
      <header className="confirmation-head" data-detail-section="head">
        <div className="confirmation-head-title">
          <span className="confirmation-tag" data-testid="detail-kind">
            {REVIEW_ITEM_KIND_TEXT[item.kind]}
          </span>
          <h2 className="confirmation-title" data-testid="detail-title">
            {reviewTitle(entry)}
          </h2>
        </div>
        <div className="confirmation-head-meta">
          <span data-testid="detail-id">{run.displayId}</span>
          <span data-testid="detail-state">{REVIEW_ITEM_STATE_TEXT[state]}</span>
          {time !== null && (
            <time data-testid="detail-time" dateTime={item.createdAt}>
              {time}
            </time>
          )}
        </div>
        {state === 'open' && (
          <div className="confirmation-actions" data-testid="review-actions">
            {REVIEW_ACTIONS_BY_KIND_ORDER[item.kind].map((action) => (
              <button
                key={action}
                type="button"
                className="review-action"
                data-testid={`review-action-${action}`}
                aria-pressed={form === action}
                disabled={busy}
                onClick={() => setForm(action)}
              >
                {REVIEW_ACTION_TEXT[action]}
              </button>
            ))}
            {item.kind === 'mutant_survived' && (
              // 정의 전(PRD 미결 #7): 늘 꺼진 버튼. 까닭은 툴팁으로 (누르거나 초점이 닿으면 연다)
              <button
                type="button"
                className="review-action"
                data-testid="review-action-objection"
                aria-disabled="true"
                {...tooltipTrigger(REVIEW_TEXT.objectionHint, 'press')}
              >
                {REVIEW_TEXT.objection}
              </button>
            )}
          </div>
        )}
        {state === 'open' && form !== null && (
          <ActionForm
            entry={entry}
            action={form}
            snapshot={snapshot}
            fields={fields}
            busy={busy}
            onSubmit={submit}
            onCancel={() => setForm(null)}
          />
        )}
        {failure !== null && (
          <p className="confirmation-error" data-testid="review-error" role="alert">
            {reviewErrorText(failure.error, fields)}
          </p>
        )}
      </header>

      <DetailSection id="run" title={REVIEW_TEXT.run}>
        <dl className="detail-fields">
          <Field id="run-id" name={REVIEW_TEXT.runId} value={run.displayId} />
          <Field id="run-status" name={REVIEW_TEXT.runStatus} value={RUN_STATUS_TEXT[run.status]} />
          {run.failureReason !== null && (
            <Field
              id="run-reason"
              name={REVIEW_TEXT.failureReason}
              value={runFailureReasonText(run.failureReason)}
            />
          )}
          {cause.status === 'ready' && cause.result.run.currentStep !== null && (
            <Field
              id="run-step"
              name={REVIEW_TEXT.stoppedStep}
              value={STEP_LABELS[cause.result.run.currentStep]}
            />
          )}
        </dl>
        {cause.status === 'error' && (
          <p className="confirmation-note" data-testid="run-failed">
            {REVIEW_TEXT.runFailed}
          </p>
        )}
      </DetailSection>

      <DetailSection id="rules" title={REVIEW_TEXT.rules}>
        <div className="detail-links">
          {entry.rules.map((rule) => (
            <button
              key={rule.id}
              type="button"
              className="detail-link"
              data-testid="detail-link"
              data-display-id={rule.displayId}
              onClick={() =>
                openLink({
                  label: REVIEW_TEXT.rules,
                  entity: 'Rule',
                  displayId: rule.displayId,
                  // 나눈 규칙은 대체로 폐기됐다(목록에 [폐기 포함]을 켜야 보인다)
                  retired:
                    item.resolution?.action === 'split_rule' && item.resolution.ruleId === rule.id,
                })
              }
            >
              {`${rule.displayId} · ${visibleText(rule.title)}`}
            </button>
          ))}
        </div>
      </DetailSection>

      {result !== null && (
        <DetailSection id="result" title={REVIEW_TEXT.result}>
          <dl className="detail-fields">
            <Field id="result-action" name={REVIEW_TEXT.action} value={result.action} />
            <Field
              id="result-at"
              name={REVIEW_TEXT.resolvedAt}
              value={formatCardTime(result.at) ?? result.at}
            />
            {result.runId !== null && (
              <Field
                id="result-run"
                name={REVIEW_TEXT.createdRun}
                value={
                  created.status === 'ready' ? created.result.run.displayId : REVIEW_TEXT.unknown
                }
              />
            )}
            {result.rule !== null && (
              <Field
                id="result-rule"
                name={REVIEW_TEXT.splitRule}
                value={`${result.rule.displayId} · ${result.rule.title}`}
              />
            )}
            {result.reason !== null && (
              <Field id="result-reason" name={REVIEW_TEXT.reason} value={result.reason} />
            )}
          </dl>
        </DetailSection>
      )}
    </div>
  );
};

/** 액션 하나의 입력과 [확인] · [취소]. */
const ActionForm = ({
  entry,
  action,
  snapshot,
  fields,
  busy,
  onSubmit,
  onCancel,
}: {
  entry: ReviewQueueEntry;
  action: ReviewAction;
  snapshot: BudgetSnapshot | null;
  fields: readonly BudgetField[];
  busy: boolean;
  onSubmit: (request: ReviewRequest) => void;
  onCancel: () => void;
}): React.JSX.Element => {
  const id = useId();
  const [reason, setReason] = useState('');
  const [exclude, setExclude] = useState('');
  const [ruleId, setRuleId] = useState<string | null>(() => initialSplitRule(entry));
  const [values, setValues] = useState<Record<string, string> | null>(null);
  // 지금 한도는 `run.get` 뒤에 온다: 처음 값은 그때의 한도
  const budgetValues = values ?? (snapshot === null ? {} : budgetFormValues(snapshot));
  const budget = snapshot === null ? null : budgetFromForm(snapshot, budgetValues);
  const lines = excludeLines(exclude);

  let request: ReviewRequest | null;
  switch (action) {
    case 'reinforce':
      request = { action };
      break;
    case 'quarantine':
      request = quarantineReady(reason) ? { action, reason } : null;
      break;
    case 'raise_limit_resume':
      request = budget === null ? null : { action, budget };
      break;
    case 'narrow_allowlist_resume':
      request = budget === null || lines.length === 0 ? null : { action, budget, exclude: lines };
      break;
    case 'split_rule':
      request = ruleId === null ? null : { action, ruleId };
      break;
  }

  const budgetInputs = (action === 'raise_limit_resume' ||
    action === 'narrow_allowlist_resume') && (
    <fieldset className="review-budget" data-testid="review-budget">
      <legend>{REVIEW_TEXT.limits}</legend>
      {snapshot === null && <p className="confirmation-note">{REVIEW_TEXT.limitsUnavailable}</p>}
      {fields.map((field) => (
        <label key={field.key} className="review-budget-field">
          <span>{field.label}</span>
          <input
            type="text"
            inputMode={field.kind === 'usd' ? 'decimal' : 'numeric'}
            data-testid={`review-budget-${field.key}`}
            value={budgetValues[field.key] ?? ''}
            onChange={(event) =>
              setValues({ ...budgetValues, [field.key]: event.currentTarget.value })
            }
          />
        </label>
      ))}
    </fieldset>
  );

  return (
    <div className="review-form" data-testid="review-form" data-action={action}>
      {action === 'quarantine' && (
        <label className="review-form-field" htmlFor={`${id}-reason`}>
          <span>{REVIEW_TEXT.reason}</span>
          <textarea
            id={`${id}-reason`}
            data-testid="review-quarantine-reason"
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
        </label>
      )}
      {budgetInputs}
      {action === 'narrow_allowlist_resume' && (
        <label className="review-form-field" htmlFor={`${id}-exclude`}>
          <span>{REVIEW_TEXT.exclude}</span>
          <textarea
            id={`${id}-exclude`}
            data-testid="review-exclude"
            placeholder={REVIEW_TEXT.excludePlaceholder}
            value={exclude}
            onChange={(event) => setExclude(event.currentTarget.value)}
          />
          <span className="confirmation-note" data-testid="review-exclude-hint">
            {REVIEW_TEXT.excludeHint}
          </span>
        </label>
      )}
      {action === 'split_rule' && (
        <fieldset className="review-split" data-testid="review-split">
          <legend>{REVIEW_TEXT.splitTarget}</legend>
          {entry.rules.map((rule) => (
            <label key={rule.id} className="review-split-rule">
              <input
                type="radio"
                name={`${id}-split`}
                data-testid="review-split-rule"
                value={rule.id}
                checked={ruleId === rule.id}
                onChange={() => setRuleId(rule.id)}
              />
              <span>{`${rule.displayId} · ${visibleText(rule.title)}`}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="confirmation-actions">
        <button
          type="button"
          className="confirm-button"
          data-testid="review-form-confirm"
          disabled={busy || request === null}
          onClick={() => {
            if (request !== null) onSubmit(request);
          }}
        >
          {busy ? REVIEW_TEXT.saving : REVIEW_TEXT.confirm}
        </button>
        <button
          type="button"
          className="review-action"
          data-testid="review-form-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          {REVIEW_TEXT.cancel}
        </button>
      </div>
    </div>
  );
};
