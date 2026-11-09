// 승인 대기 상세 (screens.md SCR-17 상세 · 액션 버튼 · 동작, NRM-04, TODO-01, ADR-050 · ADR-063).
// - 순서: 출처 → 에이전트 제안(변경 내용 · 근거 · 생성 주체) → 승인하면 / 거절하면 카드. 처리된 제안은 승인하면 /
//   거절하면 대신 처리 기록(처리 · 주체 · 시각 · 사유 · 수정 내용). 예상 비용은 보이지 않는다
// - 오른쪽 아래 떠 있는 [거절] [수정] [승인] (대기 제안만). [수정] · [거절] 입력은 상세 끝 카드로 열린다
// - 처리는 사람 주체로만 `proposal.approve` · `proposal.amend` · `proposal.reject`를 부른다 (NFR-01).
//   요청은 목록(ApprovalTab)에 맡긴다: 같은 제안의 재전송 방지 · 처리 중 · 실패 문구를 제안 ID별로 기억한다
import type { Proposal } from '@bive/shared';
import { useState } from 'react';

import { AuthorMark } from '../../components/AuthorMark/AuthorMark.js';
import { formatCardTime } from '../../components/Card2Line/time.js';
import { type FloatingAction, FloatingActions } from '../../components/FloatingActions/index.js';
import { ExceptionLabel } from '../../components/StatusBadge/StatusBadge.js';
import { EmptyState } from '../../layout/EmptyState.js';
import { EditCard, RejectCard } from './DecisionInputs.js';
import { kindTag, proposalTitle } from './proposalCard.js';
import {
  authorName,
  availableActions,
  consequences,
  DETAIL_TEXT,
  type DetailAction,
  type DiffRow,
  diffRows,
  decisionActionLabel,
  editedPayload,
  type EditValues,
  isActionableKind,
  type RequirementLabel,
  sourceRows,
} from './proposalDetailView.js';
import { useDecisionRecord, useParentRequirement } from './useDetailData.js';

/** 처리 요청: 응답의 제안으로 풀리는 RPC 호출. */
export type ProcessCall = () => Promise<{ proposal: Proposal }>;

export interface ProposalDetailProps {
  projectId: string;
  /** 고른 제안. 없으면 null */
  proposal: Proposal | null;
  /** 이 제안의 처리 요청이 진행 중 (목록이 제안 ID별로 기억해 상세를 다시 열어도 유지) */
  busy: boolean;
  /** 이 제안의 마지막 처리 실패 문구 */
  error: string | null;
  /** 처리 요청을 맡긴다. 같은 제안의 요청이 진행 중이거나 이미 성공했으면 목록이 무시한다 */
  onSubmit: (id: string, call: ProcessCall) => void;
}

export const ProposalDetail = ({
  projectId,
  proposal,
  busy,
  error,
  onSubmit,
}: ProposalDetailProps): React.JSX.Element => (
  <section
    className="todo-detail"
    data-testid="todo-detail"
    data-selected-id={proposal?.displayId ?? 'none'}
    aria-label={DETAIL_TEXT.region}
  >
    {proposal === null ? (
      <EmptyState text={DETAIL_TEXT.noSelection} />
    ) : (
      // 제안이 바뀌면 입력 카드를 새로 시작한다 (처리 중 · 실패 상태는 목록이 제안별로 들고 있다)
      <DetailBody
        key={proposal.id}
        projectId={projectId}
        proposal={proposal}
        busy={busy}
        error={error}
        onSubmit={onSubmit}
      />
    )}
  </section>
);

type InputMode = 'none' | 'edit' | 'reject';

const HUMAN = { kind: 'human' } as const;

const DetailBody = ({
  projectId,
  proposal,
  busy,
  error,
  onSubmit,
}: ProposalDetailProps & { proposal: Proposal }): React.JSX.Element => {
  const parent = useParentRequirement(projectId, proposal);
  const record = useDecisionRecord(projectId, proposal);
  const [input, setInput] = useState<InputMode>('none');
  // [수정] · [거절]을 다시 누르면 카드로 다시 스크롤 · 포커스한다
  const [focusKey, setFocusKey] = useState(0);

  const requirementLabel: RequirementLabel = (id) =>
    parent !== null && parent.id === id ? parent.displayId : null;
  const parentText = parent === null ? null : `${parent.displayId} · ${parent.text}`;

  const submit = (call: ProcessCall): void => onSubmit(proposal.id, call);

  const approve = (): void =>
    submit(() =>
      window.bive.invoke('proposal.approve', { projectId, id: proposal.id, author: HUMAN }),
    );

  const amend = (values: EditValues): void => {
    if (!isActionableKind(proposal.kind)) return;
    const edited = editedPayload(proposal.kind, proposal.payload, values);
    submit(() =>
      window.bive.invoke('proposal.amend', { projectId, id: proposal.id, author: HUMAN, edited }),
    );
  };

  const reject = (reason: string): void =>
    submit(() =>
      window.bive.invoke('proposal.reject', { projectId, id: proposal.id, author: HUMAN, reason }),
    );

  const open = (mode: Exclude<InputMode, 'none'>): void => {
    setInput(mode);
    setFocusKey((n) => n + 1);
  };
  const close = (): void => setInput('none');

  const actionDefs: Record<DetailAction, FloatingAction> = {
    reject: {
      id: 'reject',
      label: DETAIL_TEXT.reject,
      onClick: () => open('reject'),
      pressed: input === 'reject',
    },
    edit: {
      id: 'edit',
      label: DETAIL_TEXT.edit,
      onClick: () => open('edit'),
      pressed: input === 'edit',
    },
    approve: { id: 'approve', label: DETAIL_TEXT.approve, onClick: approve, primary: true },
  };
  const actions = availableActions(proposal).map((action) => actionDefs[action]);
  const pending = proposal.state === 'pending';
  const diff = diffRows(proposal.kind, proposal.diff.before, proposal.diff.after, requirementLabel);
  const outcome = consequences(proposal.kind);

  return (
    <>
      <div className="proposal-detail" data-testid="proposal-detail" data-state={proposal.state}>
        <header className="proposal-detail-head">
          <span className="proposal-detail-tag" data-testid="detail-tag">
            {kindTag(proposal.kind)}
          </span>
          <h2 className="proposal-detail-title" data-testid="detail-title">
            {proposalTitle(proposal)}
          </h2>
          <span className="proposal-detail-id" data-testid="detail-id">
            {proposal.displayId}
          </span>
        </header>

        <DetailSection id="source" title={DETAIL_TEXT.source}>
          <dl className="detail-fields">
            {sourceRows(proposal, parentText).map((row) => (
              <div key={row.key} className="detail-field" data-testid={`source-${row.key}`}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </DetailSection>

        <DetailSection id="proposal" title={DETAIL_TEXT.proposal}>
          <dl className="detail-fields">
            {diff !== null && diff.length > 0 && (
              <div className="detail-field detail-field-block" data-testid="proposal-diff">
                <dt>{DETAIL_TEXT.diff}</dt>
                <dd>
                  <DiffList rows={diff} />
                </dd>
              </div>
            )}
            <div className="detail-field" data-testid="proposal-rationale">
              <dt>{DETAIL_TEXT.rationale}</dt>
              <dd className="detail-text">{proposal.rationale}</dd>
            </div>
            <div className="detail-field" data-testid="proposal-author">
              <dt>{DETAIL_TEXT.author}</dt>
              <dd>
                <AuthorMark kind="agent" showLabel name={authorName(proposal)} />
              </dd>
            </div>
          </dl>
        </DetailSection>

        {pending && outcome.approve !== null && (
          <DetailSection id="if-approve" title={DETAIL_TEXT.ifApprove} card>
            <OutcomeList items={outcome.approve} />
          </DetailSection>
        )}
        {pending && (
          <DetailSection id="if-reject" title={DETAIL_TEXT.ifReject} card>
            <OutcomeList items={outcome.reject} />
          </DetailSection>
        )}

        {!pending && (
          <DetailSection id="record" title={DETAIL_TEXT.record}>
            <DecisionRecord
              proposal={proposal}
              record={record}
              requirementLabel={requirementLabel}
            />
          </DetailSection>
        )}

        {pending && input === 'edit' && isActionableKind(proposal.kind) && (
          <EditCard
            kind={proposal.kind}
            payload={proposal.payload}
            busy={busy}
            focusKey={focusKey}
            onConfirm={amend}
            onCancel={close}
          />
        )}
        {pending && input === 'reject' && (
          <RejectCard busy={busy} focusKey={focusKey} onConfirm={reject} onCancel={close} />
        )}
        {error !== null && (
          <p className="proposal-detail-error" data-testid="detail-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {actions.length > 0 && (
        <FloatingActions
          label={DETAIL_TEXT.actions}
          actions={actions}
          busy={busy}
          busyText={DETAIL_TEXT.busy}
        />
      )}
    </>
  );
};

const DetailSection = ({
  id,
  title,
  card = false,
  children,
}: {
  id: string;
  title: string;
  /** 승인하면 · 거절하면 카드 모양 */
  card?: boolean;
  children: React.ReactNode;
}): React.JSX.Element => {
  const headingId = `detail-${id}-heading`;
  return (
    <section
      className={card ? 'detail-section detail-card' : 'detail-section'}
      data-testid={`detail-${id}`}
      data-detail-section={id}
      aria-labelledby={headingId}
    >
      <h3 id={headingId} className="detail-heading">
        {title}
      </h3>
      {children}
    </section>
  );
};

const OutcomeList = ({ items }: { items: readonly string[] }): React.JSX.Element => (
  <ul className="detail-outcome">
    {items.map((item) => (
      <li key={item}>{item}</li>
    ))}
  </ul>
);

/** 변경 내용: 필드마다 이전(삭제) · 이후(추가). 신규 제안은 이후만 있다. */
const DiffList = ({ rows }: { rows: readonly DiffRow[] }): React.JSX.Element => (
  <dl className="detail-diff">
    {rows.map((row) => (
      <div key={row.key} className="detail-diff-row" data-testid="diff-row" data-key={row.key}>
        <dt>{row.label}</dt>
        <dd>
          {row.before !== null && (
            <del className="detail-diff-before" data-testid="diff-before">
              {row.after !== null && <span className="detail-diff-mark">{DETAIL_TEXT.before}</span>}
              {row.before}
            </del>
          )}
          {row.after !== null && (
            <ins className="detail-diff-after" data-testid="diff-after">
              {row.before !== null && <span className="detail-diff-mark">{DETAIL_TEXT.after}</span>}
              {row.after}
            </ins>
          )}
        </dd>
      </div>
    ))}
  </dl>
);

/** 처리 기록 (승인 기록 1건). 체인 검증이 깨졌으면 예외 글자를 함께 보인다 (NFR-01 증거). */
const DecisionRecord = ({
  proposal,
  record,
  requirementLabel,
}: {
  proposal: Proposal;
  record: ReturnType<typeof useDecisionRecord>;
  requirementLabel: RequirementLabel;
}): React.JSX.Element | null => {
  if (record.status === 'none' || record.status === 'loading') {
    return <div className="detail-record-loading" aria-busy="true" />;
  }
  if (record.status === 'error') {
    return <p className="detail-text">{DETAIL_TEXT.recordLoadFailed}</p>;
  }
  const { entry, chainValid } = record;
  const broken = chainValid ? null : (
    <ExceptionLabel label={DETAIL_TEXT.chainBroken} tone="danger" testId="record-chain-broken" />
  );
  if (entry === null) {
    return (
      <>
        <p className="detail-text">{DETAIL_TEXT.recordMissing}</p>
        {broken}
      </>
    );
  }
  const time = formatCardTime(entry.at);
  const editedDiff =
    entry.detail.diff === undefined
      ? null
      : diffRows(
          proposal.kind,
          entry.detail.diff.before,
          entry.detail.diff.after,
          requirementLabel,
        );
  return (
    <>
      <dl className="detail-fields" data-testid="decision-record" data-action={entry.action}>
        <div className="detail-field" data-testid="record-action">
          <dt>{DETAIL_TEXT.recordAction}</dt>
          <dd>{decisionActionLabel(entry)}</dd>
        </div>
        <div className="detail-field" data-testid="record-actor">
          <dt>{DETAIL_TEXT.recordActor}</dt>
          <dd>
            <AuthorMark kind={entry.actor.kind} showLabel />
          </dd>
        </div>
        {time !== null && (
          <div className="detail-field" data-testid="record-time">
            <dt>{DETAIL_TEXT.recordTime}</dt>
            <dd>
              <time dateTime={entry.at}>{time}</time>
            </dd>
          </div>
        )}
        {entry.detail.reason !== undefined && (
          <div className="detail-field" data-testid="record-reason">
            <dt>{DETAIL_TEXT.recordReason}</dt>
            <dd className="detail-text">{entry.detail.reason}</dd>
          </div>
        )}
        {editedDiff !== null && editedDiff.length > 0 && (
          <div className="detail-field detail-field-block" data-testid="record-diff">
            <dt>{DETAIL_TEXT.recordDiff}</dt>
            <dd>
              <DiffList rows={editedDiff} />
            </dd>
          </div>
        )}
      </dl>
      {broken}
    </>
  );
};
