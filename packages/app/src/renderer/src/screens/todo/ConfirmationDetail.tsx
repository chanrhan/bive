// 확인할 것 상세 (SCR-17 자리 상세, TODO-01 · NRM-04 · NRM-07, ADR-100 명세 변경 SCR-17 · A9, ADR-119):
// 머리(종류 태그 · 제목 · 표시 ID · 예외 · 시각 · [확인]) → 변경 내용(이전 · 이후) → 사유 · 근거 · 생성 주체 → 변경 파일 · 실행
// (테스트 변경) → 판단(규범 담당 역할의 판단 기록 카드) → 대상 링크.
// - 판단 카드 · 미확인 규칙의 사유와 진술은 그 대상의 `normChange.list {targetRef}`에서 읽는다(대체 항목은 새 규칙도)
// - 글은 모두 응답의 표시 값을 `visibleDisplayText`로 한 번 더 거친 것이다(confirmationView.ts)
// - 대상 링크: 규칙 · 요구사항 화면으로 가서 그 표시 ID로 검색한 목록을 열고 그 카드를 고른다. 폐기된 규칙은 [폐기 포함]을
//   켠다(ADR-114의 이동 방식에 고를 항목 넘기기를 더함, ADR-123)
import type { ConfirmationItem, ConfirmationTarget, NormChangeView } from '@bive/shared';
import { useCallback, useEffect, useState } from 'react';

import { formatCardTime } from '../../components/Card2Line/time.js';
import { EMPTY_FILTER, setListFilter } from '../../components/ListView/index.js';
import { ExceptionLabel } from '../../components/StatusBadge/StatusBadge.js';
import { EmptyState } from '../../layout/EmptyState.js';
import { useNavigation } from '../../navigation/NavigationContext.js';
import { requestSelection } from '../../navigation/pendingSelection.js';
import { NORM_CHANGE_EVENT_NAMES } from '../../runs/refreshCoalescer.js';
import { useEventRefresh } from '../../runs/useEventRefresh.js';
import { REQUIREMENTS_LIST_ID } from '../requirements/requirementsView.js';
import { RULES_LIST_ID } from '../rules/rulesView.js';
import {
  CONFIRMATION_TEXT,
  confirmationDetail,
  confirmationException,
  confirmationKey,
  confirmationTitle,
  displayIdOf,
  type DiffRow,
  judgmentCards,
  judgmentTargets,
  kindTag,
  sameTargetText,
  type TargetLink,
} from './confirmationView.js';

type ChangesLoad =
  | { status: 'loading' }
  | { status: 'ready'; entries: NormChangeView[]; chainValid: boolean }
  | { status: 'error' };

/**
 * 상세가 보이는 항목의 규범 변경 기록 (대상마다 1회). 항목(대상)이 바뀌거나 이 프로젝트의 규범 변경 알림 · 재접속이 오면 다시 읽고
 * (판단 카드가 새 판단을 보이게, ADR-119), 늦게 온 응답은 버린다.
 */
const useItemChanges = (projectId: string, item: ConfirmationItem | null): ChangesLoad => {
  const [loaded, setLoaded] = useState<{ key: string; load: ChangesLoad } | null>(null);
  const [reload, setReload] = useState(0);
  const key = item === null ? null : confirmationKey(item);
  // 대상 목록은 내용으로 비교한다 (목록을 다시 읽어 항목 객체가 바뀌어도 대상이 같으면 다시 부르지 않는다)
  const targetsKey = item === null ? '' : JSON.stringify(judgmentTargets(item));
  const refreshOnNormChange = useCallback((): Promise<void> => {
    setReload((n) => n + 1);
    return Promise.resolve();
  }, []);
  useEventRefresh(item === null ? null : projectId, NORM_CHANGE_EVENT_NAMES, refreshOnNormChange);
  useEffect(() => {
    if (key === null) return undefined;
    let live = true;
    const targets = JSON.parse(targetsKey) as ConfirmationTarget[];
    Promise.all(
      targets.map((targetRef) => window.bive.invoke('normChange.list', { projectId, targetRef })),
    ).then(
      (results) => {
        if (!live) return;
        setLoaded({
          key,
          load: {
            status: 'ready',
            entries: results.flatMap((r) => r.entries),
            chainValid: results.every((r) => r.chain.valid),
          },
        });
      },
      () => {
        if (live) setLoaded({ key, load: { status: 'error' } });
      },
    );
    return () => {
      live = false;
    };
    // 다시 읽기 번호는 다시 읽는 계기로만 쓴다
  }, [projectId, key, targetsKey, reload]);
  return loaded !== null && loaded.key === key ? loaded.load : { status: 'loading' };
};

export interface ConfirmationDetailProps {
  projectId: string;
  item: ConfirmationItem | null;
  /** 같은 대상의 다른 항목 수 (한 번의 [확인]이 함께 내린다) */
  sameTarget: number;
  busy: boolean;
  error: string | null;
  onConfirm: (item: ConfirmationItem) => void;
}

export const ConfirmationDetail = ({
  projectId,
  item,
  sameTarget,
  busy,
  error,
  onConfirm,
}: ConfirmationDetailProps): React.JSX.Element => {
  const changes = useItemChanges(projectId, item);
  return (
    <section
      className="todo-detail"
      data-testid="todo-detail"
      aria-label={CONFIRMATION_TEXT.detail}
      data-selected-id={item === null ? '' : displayIdOf(item)}
    >
      {item === null ? (
        <EmptyState text={CONFIRMATION_TEXT.noSelection} />
      ) : (
        <Detail
          item={item}
          changes={changes}
          sameTarget={sameTarget}
          busy={busy}
          error={error}
          onConfirm={onConfirm}
        />
      )}
    </section>
  );
};

const Detail = ({
  item,
  changes,
  sameTarget,
  busy,
  error,
  onConfirm,
}: Omit<ConfirmationDetailProps, 'projectId' | 'item'> & {
  item: ConfirmationItem;
  changes: ChangesLoad;
}): React.JSX.Element => {
  const entries = changes.status === 'ready' ? changes.entries : [];
  const model = confirmationDetail(item, entries);
  const exception = confirmationException(item);
  const time = formatCardTime(item.at);
  const cards = judgmentCards(entries, judgmentTargets(item));
  const openLink = useOpenLink();

  return (
    <div className="confirmation-detail" data-testid="confirmation-detail">
      <header className="confirmation-head" data-detail-section="head">
        <div className="confirmation-head-title">
          <span className="confirmation-tag" data-testid="detail-tag">
            {kindTag(item)}
          </span>
          <h2 className="confirmation-title" data-testid="detail-title">
            {confirmationTitle(item)}
          </h2>
        </div>
        <div className="confirmation-head-meta">
          <span data-testid="detail-id">{displayIdOf(item)}</span>
          <span data-testid="detail-exception">
            <ExceptionLabel label={exception.label} tone={exception.tone} />
          </span>
          {time !== null && (
            <time data-testid="detail-time" dateTime={item.at}>
              {time}
            </time>
          )}
        </div>
        <div className="confirmation-actions">
          <button
            type="button"
            className="confirm-button"
            data-testid="confirm-button"
            disabled={busy}
            onClick={() => onConfirm(item)}
          >
            {busy ? CONFIRMATION_TEXT.confirming : CONFIRMATION_TEXT.confirm}
          </button>
          {sameTarget > 0 && (
            <span className="confirmation-note" data-testid="confirm-same-target">
              {sameTargetText(sameTarget)}
            </span>
          )}
        </div>
        {error !== null && (
          <p className="confirmation-error" data-testid="confirm-error" role="alert">
            {error}
          </p>
        )}
      </header>

      {model.diff.length > 0 && (
        <DetailSection id="diff" title={CONFIRMATION_TEXT.diff}>
          <DiffList rows={model.diff} />
        </DetailSection>
      )}

      <DetailSection id="facts" title={CONFIRMATION_TEXT.facts}>
        <dl className="detail-fields">
          {model.rationale !== null && (
            <Field id="rationale" name={CONFIRMATION_TEXT.rationale} value={model.rationale} />
          )}
          {model.grounds !== null && (
            <Field id="grounds" name={CONFIRMATION_TEXT.grounds} value={model.grounds} />
          )}
          <Field id="author" name={CONFIRMATION_TEXT.author} value={model.author} />
          {model.run !== null && <Field id="run" name={CONFIRMATION_TEXT.run} value={model.run} />}
        </dl>
        {model.truncated && (
          <p className="confirmation-note" data-testid="detail-truncated">
            {CONFIRMATION_TEXT.textTruncated}
          </p>
        )}
      </DetailSection>

      {model.files !== null && (
        <DetailSection id="files" title={CONFIRMATION_TEXT.files}>
          <ul className="detail-files" data-testid="detail-files">
            {model.files.map((file, index) => (
              <li
                key={`${String(index)}:${file.path}`}
                className="detail-file"
                data-testid="detail-file"
              >
                <span className="detail-file-path" data-testid="detail-file-path">
                  {file.path}
                </span>
                <span className="detail-file-change" data-testid="detail-file-change">
                  {file.change}
                </span>
              </li>
            ))}
          </ul>
          {model.fileCount !== null && (
            <p className="confirmation-note" data-testid="detail-file-count">
              {model.fileCount}
            </p>
          )}
        </DetailSection>
      )}

      <DetailSection id="judgments" title={CONFIRMATION_TEXT.judgments}>
        {changes.status === 'error' && (
          <p className="confirmation-note" data-testid="judgments-failed">
            {CONFIRMATION_TEXT.judgmentsFailed}
          </p>
        )}
        {changes.status === 'ready' && !changes.chainValid && (
          <ExceptionLabel
            label={CONFIRMATION_TEXT.chainBroken}
            tone="danger"
            testId="chain-broken"
          />
        )}
        {changes.status === 'ready' && cards.length === 0 && (
          <p className="confirmation-note" data-testid="judgments-empty">
            {CONFIRMATION_TEXT.judgmentsEmpty}
          </p>
        )}
        {cards.length > 0 && (
          <ul className="judgment-cards" data-testid="judgment-cards">
            {cards.map((card) => (
              <li
                key={card.seq}
                className="judgment-card"
                data-testid="judgment-card"
                data-seq={card.seq}
              >
                <div className="judgment-card-head">
                  <span data-testid="judgment-subject">{card.subject}</span>
                  <span aria-hidden="true">·</span>
                  <span data-testid="judgment-verdict">{card.verdict}</span>
                  {card.undecided !== null && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span data-testid="judgment-undecided">
                        {CONFIRMATION_TEXT.undecided} ({card.undecided})
                      </span>
                    </>
                  )}
                </div>
                {card.contradicts.length > 0 && (
                  <p className="judgment-card-meta" data-testid="judgment-contradicts">
                    {CONFIRMATION_TEXT.contradicts} · {card.contradicts.join(' · ')}
                  </p>
                )}
                {card.grounds !== null && (
                  <p className="detail-text" data-testid="judgment-grounds">
                    {card.grounds}
                  </p>
                )}
                <p className="judgment-card-meta">
                  <span data-testid="judgment-actor">{card.actor}</span>
                  <time>{card.time}</time>
                  {card.truncated && <span>{CONFIRMATION_TEXT.textTruncated}</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      <DetailSection id="links" title={CONFIRMATION_TEXT.target}>
        <div className="detail-links">
          {model.links.map((link) => (
            <button
              key={`${link.label}:${link.displayId}`}
              type="button"
              className="detail-link"
              data-testid="detail-link"
              data-entity={link.entity}
              data-display-id={link.displayId}
              onClick={() => openLink(link)}
            >
              {link.label} · {link.displayId}
            </button>
          ))}
        </div>
      </DetailSection>
    </div>
  );
};

/**
 * 대상 링크: 그 화면의 목록을 표시 ID로 검색한 상태로 열고 그 카드를 고른다(상세가 열린다). 폐기된 규칙은 [폐기 포함]을 켠다.
 * 목록에 없는 대상(지워진 요구사항 · 규칙)이면 검색 결과가 0개이고 아무것도 고르지 않는다(ADR-123). 검토 대기열 상세도 쓴다.
 */
export const useOpenLink = (): ((link: TargetLink) => void) => {
  const { navigate } = useNavigation();
  return useCallback(
    (link: TargetLink) => {
      if (link.entity === 'Rule') {
        requestSelection(RULES_LIST_ID, link.displayId);
        setListFilter(RULES_LIST_ID, {
          ...EMPTY_FILTER,
          query: link.displayId,
          includeHidden: link.retired,
        });
        navigate('rules');
      } else {
        requestSelection(REQUIREMENTS_LIST_ID, link.displayId);
        setListFilter(REQUIREMENTS_LIST_ID, { ...EMPTY_FILTER, query: link.displayId });
        navigate('requirements');
      }
    },
    [navigate],
  );
};

export const Field = ({
  id,
  name,
  value,
}: {
  id: string;
  name: string;
  value: string;
}): React.JSX.Element => (
  <div className="detail-field" data-testid={`detail-${id}`}>
    <dt>{name}</dt>
    <dd className="detail-text">{value}</dd>
  </div>
);

const DiffList = ({ rows }: { rows: readonly DiffRow[] }): React.JSX.Element => (
  <dl className="detail-diff" data-testid="detail-diff">
    {rows.map((row) => (
      <div key={row.field} className="detail-diff-row" data-testid="detail-diff-row">
        <dt>{row.field}</dt>
        <dd>
          {row.before !== null && (
            <span className="detail-diff-before" data-testid="diff-before">
              <span className="detail-diff-mark">{CONFIRMATION_TEXT.before}</span>
              {row.before}
            </span>
          )}
          {row.after !== null && (
            <span className="detail-diff-after" data-testid="diff-after">
              <span className="detail-diff-mark">{CONFIRMATION_TEXT.after}</span>
              {row.after}
            </span>
          )}
        </dd>
      </div>
    ))}
  </dl>
);

export const DetailSection = ({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element => {
  const headingId = `detail-${id}-heading`;
  return (
    <section
      className="detail-section"
      data-testid={`detail-section-${id}`}
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
