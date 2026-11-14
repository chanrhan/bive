// 규칙 상세 (screens.md SCR-03 상세 · SCR-06 규범 상세, 1.4 상세 접힘, ADR-035 · ADR-073).
// 규칙 목록 + 상세 2단의 상세 영역에 들어간다(별도 화면 아님). 요구사항 상세(#38)가 자식 규칙을 펼칠 때 다시 쓴다.
// - 순서: 제목 · ID · 판정 → 진술 · 종류 · 검사 · 부모 요구사항 · 생성 주체 → 테스트 실행 결과 → 테스트 출력(접힘) → 실행 이력
// - 테스트 출력은 기본 접힘, 최신 판정이 실패면 자동 펼침. 안에 실패 원인(케이스 이름 · `file:line` · 메시지) · 전체 케이스
// - 변경 이력(P1) · 변이 상태 · 대상 블록 · 위험도 · 코드 열기 링크는 해당 이슈 전 미노출 (ADR-035)
// - 머리 오른쪽 동작(`actions`)은 놓는 화면이 정한다: 규칙 화면은 [실행] (M1-19, ADR-076)
// - 요구사항 상세가 자식 규칙으로 펼칠 때는 부모(`parent`)를 넘겨 requirement.get을 다시 부르지 않는다 (ADR-078)
// - 값은 rule.list 항목 · judgment.list · requirement.get 결과에서만 (NFR-03)
import './RuleDetail.css';

import type { JudgmentCase, Requirement, RuleWithJudgment } from '@bive/shared';
import type { ReactNode } from 'react';

import { AuthorMark } from '../../components/AuthorMark/AuthorMark.js';
import { CollapsibleDetail } from '../../components/CollapsibleDetail/CollapsibleDetail.js';
import { StatusBadge } from '../../components/StatusBadge/StatusBadge.js';
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
import { type RuleHistoryLoad, useRuleHistory, useRuleParent } from './useRuleDetailData.js';

export interface RuleDetailProps {
  projectId: string;
  item: RuleWithJudgment;
  /** 머리 오른쪽에 둘 동작 (규칙 화면의 [실행]) */
  actions?: ReactNode;
  /** 이미 가진 부모 요구사항 (요구사항 상세에서 펼칠 때). 주면 `requirement.get`을 부르지 않는다 */
  parent?: Requirement;
}

/** 규칙이 바뀌면 접힘 상태 · 불러온 값을 새로 시작하도록 호출하는 쪽이 `key={rule.id}`를 준다. */
export const RuleDetail = ({
  projectId,
  item,
  actions,
  parent: knownParent,
}: RuleDetailProps): React.JSX.Element => {
  const { rule, judgment } = item;
  const latest = judgment.latest;
  const history = useRuleHistory(projectId, rule.id, latest?.id ?? null);
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
          {rule.title}
        </h2>
        <span className="rule-detail-id" data-testid="rule-detail-id">
          {rule.displayId}
        </span>
        <StatusBadge kind="judgment" status={judgment.status} />
        {actions}
      </header>

      <dl className="rule-fields">
        <Field id="statement" label={TEXT.statement}>
          <p className="rule-detail-text">{rule.statement}</p>
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
            <TestOutput cases={latest.cases} />
          </CollapsibleDetail>
        </div>
      )}

      <Section id="history" title={TEXT.history}>
        <History load={history} />
      </Section>
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
  children: React.ReactNode;
}): React.JSX.Element => (
  <div className="rule-field" data-testid={`rule-field-${id}`}>
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

/** 테스트 출력: 실패 원인(통과하지 않은 케이스의 실행기 출력) → 전체 케이스. */
const TestOutput = ({ cases }: { cases: readonly JudgmentCase[] }): React.JSX.Element => {
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
                    {item.name}
                  </span>
                </div>
                <span className="rule-mono rule-case-location" data-testid="failure-case-location">
                  {caseLocation(item)}
                </span>
                <pre className="rule-case-message" data-testid="failure-case-message">
                  {item.message ?? TEXT.noMessage}
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
              <span className="rule-case-name">{item.name}</span>
              <span className="rule-mono rule-case-location">{caseLocation(item)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

/** 실행 이력: 판정 기록 최신부터 (판정 시각 · 판정 · 실행 · 커밋). */
const History = ({ load }: { load: RuleHistoryLoad }): React.JSX.Element => {
  if (load.state === 'loading') {
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
  if (load.entries.length === 0) {
    return (
      <p className="rule-detail-muted" data-testid="rule-history-empty">
        {TEXT.noHistory}
      </p>
    );
  }
  return (
    <ol className="rule-history-list">
      {load.entries.map(({ judgment, runDisplayId }) => (
        <li
          key={judgment.id}
          className="rule-history-row"
          data-testid="history-row"
          data-status={judgment.status}
        >
          <time dateTime={judgment.judgedAt}>{judgedAtText(judgment.judgedAt)}</time>
          <StatusBadge kind="judgment" status={judgment.status} />
          <span data-testid="history-run">{runDisplayId ?? ''}</span>
          <span className="rule-mono" title={judgment.commit}>
            {shortCommit(judgment.commit)}
          </span>
        </li>
      ))}
    </ol>
  );
};
